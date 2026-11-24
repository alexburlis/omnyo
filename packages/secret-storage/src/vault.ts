import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { z } from "zod";
import { openEnvelope, sealEnvelope } from "./envelope.js";
import { SecretVaultError } from "./errors.js";
import {
  createFileExclusive,
  ensurePrivateDirectory,
  errorCode,
} from "./files.js";
import { keyStoreForProtection, protectionRunsOn } from "./key-stores/index.js";
import {
  VAULT_KEY_BYTES,
  vaultDirectory,
  type VaultKeyStore,
  type VaultProtection,
} from "./key-stores/key-store.js";
import { detectWindowsDpapiScope } from "./key-stores/windows-dpapi.js";

export interface SecretVault {
  readonly id: string;
  readonly dataDir: string;
  readonly protection: VaultProtection;
  readonly created: boolean;
  seal(plaintext: string): string;
  open(sealed: string): string;
}

export interface OpenSecretVaultOptions {
  keyStore?: VaultKeyStore;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
}

const protectionSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("macos-keychain") }),
  z.object({
    kind: z.literal("windows-dpapi"),
    scope: z.enum(["user", "machine"]),
  }),
  z.object({ kind: z.literal("key-file") }),
]);

const vaultRecordSchema = z.object({
  schema: z.literal(1),
  id: z.string().regex(/^[0-9a-f]{32}$/u),
  protection: protectionSchema,
  createdAt: z.number().int().nonnegative(),
});

type VaultRecord = z.infer<typeof vaultRecordSchema>;

type ProtectionKind = VaultProtection["kind"];

const KEY_STORE_CHOICES = new Map<string, ProtectionKind>([
  ["keychain", "macos-keychain"],
  ["dpapi", "windows-dpapi"],
  ["key-file", "key-file"],
]);

const PLATFORM_DEFAULT_KIND: Partial<Record<NodeJS.Platform, ProtectionKind>> =
  {
    darwin: "macos-keychain",
    win32: "windows-dpapi",
  };

const openVaults = new Map<string, Promise<SecretVault>>();

function recordPath(dataDir: string): string {
  return join(vaultDirectory(dataDir), "vault.json");
}

function sameProtection(
  left: VaultProtection,
  right: VaultProtection,
): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

async function readRecord(dataDir: string): Promise<VaultRecord | undefined> {
  const path = recordPath(dataDir);
  let text: string;

  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if (errorCode(error) === "ENOENT") return undefined;
    throw new SecretVaultError(
      "record_invalid",
      `Vault record ${path} cannot be read (${String(errorCode(error))})`,
    );
  }

  let json: unknown;

  try {
    json = JSON.parse(text);
  } catch {
    throw new SecretVaultError(
      "record_invalid",
      `Vault record ${path} is not valid JSON`,
    );
  }

  const parsed = vaultRecordSchema.safeParse(json);

  if (!parsed.success)
    throw new SecretVaultError(
      "record_invalid",
      `Vault record ${path} does not match the vault record schema`,
    );

  return parsed.data;
}

async function chooseProtection(
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
): Promise<VaultProtection> {
  const requested = env.OMNYO_VAULT_KEY_STORE?.trim();

  const kind =
    requested === undefined || requested === ""
      ? (PLATFORM_DEFAULT_KIND[platform] ?? "key-file")
      : KEY_STORE_CHOICES.get(requested);

  if (kind === undefined)
    throw new SecretVaultError(
      "record_invalid",
      "OMNYO_VAULT_KEY_STORE must be keychain, dpapi or key-file",
    );

  assertRunsHere(kind, platform);

  switch (kind) {
    case "macos-keychain":
      return { kind };
    case "windows-dpapi":
      return { kind, scope: await detectWindowsDpapiScope({ env }) };
    case "key-file":
      return { kind };
  }
}

function assertRunsHere(kind: ProtectionKind, platform: NodeJS.Platform) {
  if (!protectionRunsOn(kind, platform))
    throw new SecretVaultError(
      "record_invalid",
      `Vault key store ${kind} cannot run on ${platform}`,
    );
}

function vaultFrom(
  dataDir: string,
  record: VaultRecord,
  key: Buffer,
  created: boolean,
): SecretVault {
  if (key.length !== VAULT_KEY_BYTES)
    throw new SecretVaultError(
      "key_unavailable",
      "Vault key has the wrong length",
    );

  return Object.freeze({
    id: record.id,
    dataDir,
    protection: record.protection,
    created,
    seal: (plaintext: string) => sealEnvelope(key, record.id, plaintext),
    open: (sealed: string) => openEnvelope(key, record.id, sealed),
  });
}

async function openRecord(
  dataDir: string,
  record: VaultRecord,
  options: OpenSecretVaultOptions,
  platform: NodeJS.Platform,
): Promise<SecretVault> {
  assertRunsHere(record.protection.kind, platform);

  const keyStore =
    options.keyStore ??
    keyStoreForProtection(dataDir, record.protection, { env: options.env });

  if (!sameProtection(keyStore.protection, record.protection))
    throw new SecretVaultError(
      "record_invalid",
      `Vault record ${recordPath(dataDir)} names key store ${record.protection.kind}, not ${keyStore.protection.kind}`,
    );

  return vaultFrom(dataDir, record, await keyStore.load(record.id), false);
}

async function discardKey(
  keyStore: VaultKeyStore,
  vaultId: string,
  reason: unknown,
): Promise<never> {
  try {
    await keyStore.remove(vaultId);
  } catch (removeError) {
    const reasonMessage =
      reason instanceof Error ? reason.message : String(reason);

    const removeMessage =
      removeError instanceof Error ? removeError.message : String(removeError);

    throw new SecretVaultError(
      "key_unavailable",
      `${reasonMessage}; the unused key for vault ${vaultId} could not be removed: ${removeMessage}`,
      { cause: reason },
    );
  }

  throw reason;
}

async function createVault(
  dataDir: string,
  options: OpenSecretVaultOptions,
  platform: NodeJS.Platform,
): Promise<SecretVault> {
  const protection =
    options.keyStore?.protection ??
    (await chooseProtection(platform, options.env ?? process.env));

  assertRunsHere(protection.kind, platform);

  const keyStore =
    options.keyStore ??
    keyStoreForProtection(dataDir, protection, { env: options.env });

  const record: VaultRecord = {
    schema: 1,
    id: randomBytes(16).toString("hex"),
    protection,
    createdAt: Date.now(),
  };

  const key = randomBytes(VAULT_KEY_BYTES);
  await keyStore.store(record.id, key);
  let created: boolean;

  try {
    const stored = await keyStore.load(record.id);

    if (!stored.equals(key))
      throw new SecretVaultError(
        "key_unavailable",
        `Key store ${protection.kind} returned a different key than it stored`,
      );

    await ensurePrivateDirectory(vaultDirectory(dataDir));
    created = await createFileExclusive(
      recordPath(dataDir),
      `${JSON.stringify(record, null, 2)}\n`,
    );
  } catch (error) {
    return discardKey(keyStore, record.id, error);
  }

  if (created) return vaultFrom(dataDir, record, key, true);

  await keyStore.remove(record.id);
  const winner = await readRecord(dataDir);

  if (winner === undefined)
    throw new SecretVaultError(
      "record_invalid",
      `Vault record ${recordPath(dataDir)} disappeared while it was being created`,
    );

  return openRecord(dataDir, winner, options, platform);
}

async function openUncached(
  dataDir: string,
  options: OpenSecretVaultOptions,
): Promise<SecretVault> {
  const platform = options.platform ?? process.platform;
  const record = await readRecord(dataDir);

  return record === undefined
    ? createVault(dataDir, options, platform)
    : openRecord(dataDir, record, options, platform);
}

export async function readVaultProtection(
  dataDir: string,
): Promise<VaultProtection | undefined> {
  return (await readRecord(resolve(dataDir)))?.protection;
}

export function openSecretVault(
  dataDir: string,
  options: OpenSecretVaultOptions = {},
): Promise<SecretVault> {
  const resolved = resolve(dataDir);

  if (options.keyStore !== undefined) return openUncached(resolved, options);

  const existing = openVaults.get(resolved);

  if (existing !== undefined) return existing;

  const opening = openUncached(resolved, options);
  openVaults.set(resolved, opening);

  opening.catch(() => {
    if (openVaults.get(resolved) === opening) openVaults.delete(resolved);
  });

  return opening;
}
