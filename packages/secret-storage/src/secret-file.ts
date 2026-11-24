import { randomBytes } from "node:crypto";
import { mkdir, readFile, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { isSealed } from "./envelope.js";
import { SecretVaultError } from "./errors.js";
import {
  createFileExclusive,
  ensurePrivateDirectory,
  errorCode,
  replaceFileAtomic,
  writePrivateTemp,
} from "./files.js";
import type { SecretVault } from "./vault.js";

export interface GeneratedFileArgs {
  bytes: number;
  encoding: BufferEncoding;
  fileName: string;
}

async function readIfPresent(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if (errorCode(error) === "ENOENT") return undefined;
    throw error;
  }
}

async function sealInPlace(
  vault: SecretVault,
  path: string,
  plaintext: string,
): Promise<void> {
  const tempPath = await writePrivateTemp(path, vault.seal(plaintext));

  try {
    if (vault.open(await readFile(tempPath, "utf8")) !== plaintext)
      throw new SecretVaultError(
        "corrupt",
        `Sealing ${path} did not reproduce its value`,
      );

    await rename(tempPath, path);
  } catch (error) {
    await rm(tempPath, { force: true });
    throw error;
  }
}

export async function readSecretFile(
  vault: SecretVault,
  path: string,
): Promise<string | undefined> {
  const content = await readIfPresent(path);

  if (content === undefined) return undefined;

  if (isSealed(content)) return vault.open(content);

  await sealInPlace(vault, path, content);

  return content;
}

export async function writeSecretFile(
  vault: SecretVault,
  path: string,
  value: string,
): Promise<void> {
  await replaceFileAtomic(path, vault.seal(value));
}

export async function deleteSecretFile(path: string): Promise<void> {
  await rm(path, { force: true });
}

export async function sealLegacySecretFile(
  vault: SecretVault,
  path: string,
): Promise<"sealed" | "already-sealed" | "absent"> {
  const content = await readIfPresent(path);

  if (content === undefined) return "absent";

  if (isSealed(content)) {
    vault.open(content);

    return "already-sealed";
  }

  await sealInPlace(vault, path, content);

  return "sealed";
}

function initializationFailure(path: string): Error {
  return new Error(`Failed to initialize secret at ${path}`);
}

export async function readOrCreateSecretFile(
  vault: SecretVault,
  args: GeneratedFileArgs,
): Promise<string> {
  await ensurePrivateDirectory(vault.dataDir);
  const path = join(vault.dataDir, args.fileName);
  const existing = (await readSecretFile(vault, path))?.trim();

  if (existing !== undefined) {
    if (existing.length === 0) throw initializationFailure(path);

    return existing;
  }

  const generated = randomBytes(args.bytes).toString(args.encoding);

  if (await createFileExclusive(path, vault.seal(generated))) return generated;

  const raced = (await readSecretFile(vault, path))?.trim();

  if (raced === undefined || raced.length === 0)
    throw initializationFailure(path);

  return raced;
}

export async function readOrCreateIdentifierFile(
  args: GeneratedFileArgs & { dataDir: string },
): Promise<string> {
  await mkdir(args.dataDir, { recursive: true });
  const path = join(args.dataDir, args.fileName);
  const existing = (await readIfPresent(path))?.trim();

  if (existing !== undefined && existing.length > 0) return existing;

  const generated = randomBytes(args.bytes).toString(args.encoding);

  if (
    existing === undefined &&
    (await createFileExclusive(path, `${generated}\n`))
  )
    return generated;

  const raced = (await readIfPresent(path))?.trim();

  if (raced === undefined || raced.length === 0)
    throw initializationFailure(path);

  return raced;
}
