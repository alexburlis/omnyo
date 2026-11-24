import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  isSealed,
  openSecretVault,
  SecretVaultError,
  type VaultKeyStore,
} from "../src/index.js";
import { createKeyFileKeyStore } from "../src/key-stores/key-file.js";
import {
  memoryKeyStore,
  modeOf,
  posixModes,
  snapshotTree,
  trackTempDirs,
} from "./helpers.js";

const makeTempDir = trackTempDirs();

const keyFileEnv = { OMNYO_VAULT_KEY_STORE: "key-file" };

async function expectVaultError(
  promise: Promise<unknown>,
  code: SecretVaultError["code"],
) {
  const error = await promise.then(
    () => undefined,
    (reason: unknown) => reason,
  );

  expect(error).toBeInstanceOf(SecretVaultError);
  expect(error).toMatchObject({ code });
}

function expectThrowsCode(
  action: () => unknown,
  code: SecretVaultError["code"],
) {
  let caught: unknown;

  try {
    action();
  } catch (error) {
    caught = error;
  }

  expect(caught).toBeInstanceOf(SecretVaultError);
  expect(caught).toMatchObject({ code });
}

async function writeRecord(dataDir: string, record: unknown) {
  await mkdir(path.join(dataDir, "vault"), { recursive: true });
  await writeFile(
    path.join(dataDir, "vault", "vault.json"),
    JSON.stringify(record),
  );
}

describe("openSecretVault", () => {
  it("creates a private record and seals values it can open again", async () => {
    const dataDir = await makeTempDir();
    const vault = await openSecretVault(dataDir, { env: keyFileEnv });
    const sealed = vault.seal("sk-live-plaintext-value");

    expect(isSealed(sealed)).toBe(true);
    expect(sealed).not.toContain("sk-live-plaintext-value");
    expect(vault.open(sealed)).toBe("sk-live-plaintext-value");
    expect(vault.open(`\n  ${sealed}\n`)).toBe("sk-live-plaintext-value");

    const record = JSON.parse(
      await readFile(path.join(dataDir, "vault", "vault.json"), "utf8"),
    );

    expect(record).toMatchObject({
      schema: 1,
      id: vault.id,
      protection: { kind: "key-file" },
    });
    expect(vault.id).toMatch(/^[0-9a-f]{32}$/u);

    if (posixModes) {
      expect(await modeOf(path.join(dataDir, "vault"))).toBe(0o700);
      expect(await modeOf(path.join(dataDir, "vault", "vault.json"))).toBe(
        0o600,
      );
    }
  });

  it("reopens the existing vault in a fresh open and reads earlier envelopes", async () => {
    const dataDir = await makeTempDir();

    const first = await openSecretVault(dataDir, {
      keyStore: createKeyFileKeyStore(dataDir),
    });

    const sealed = first.seal("value");

    const second = await openSecretVault(dataDir, {
      keyStore: createKeyFileKeyStore(dataDir),
    });

    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.id).toBe(first.id);
    expect(second.open(sealed)).toBe("value");
  });

  it("opens past a temp record left by a crashed creator", async () => {
    const dataDir = await makeTempDir();
    await mkdir(path.join(dataDir, "vault"));
    await writeFile(
      path.join(dataDir, "vault", ".vault.json.0badc0ffee00.tmp"),
      '{"schema":1,"id":',
    );

    const vault = await openSecretVault(dataDir, {
      keyStore: createKeyFileKeyStore(dataDir),
    });

    expect(vault.created).toBe(true);
    expect(
      JSON.parse(
        await readFile(path.join(dataDir, "vault", "vault.json"), "utf8"),
      ),
    ).toMatchObject({ id: vault.id });
  });

  it("converges six concurrent openers on one complete record that readers can always parse", async () => {
    const dataDir = await makeTempDir();
    const recordFile = path.join(dataDir, "vault", "vault.json");
    let opening = true;
    const observed: string[] = [];

    const reader = (async () => {
      while (opening) {
        const text = await readFile(recordFile, "utf8").catch(() => undefined);

        if (text !== undefined) observed.push(text);
        await new Promise((resolve) => setImmediate(resolve));
      }
    })();

    const vaults = await Promise.all(
      Array.from({ length: 6 }, () =>
        openSecretVault(dataDir, { keyStore: createKeyFileKeyStore(dataDir) }),
      ),
    );

    opening = false;
    await reader;

    expect(new Set(vaults.map((vault) => vault.id)).size).toBe(1);
    expect(vaults.filter((vault) => vault.created)).toHaveLength(1);
    expect(
      observed.every((text) => JSON.parse(text).id === vaults[0]?.id),
    ).toBe(true);
    expect((await readdir(path.join(dataDir, "vault"))).sort()).toEqual([
      `key-${vaults[0]?.id}`,
      "vault.json",
    ]);
  });

  it("returns one cached vault per data directory and does not cache failures", async () => {
    const dataDir = await makeTempDir();

    await expectVaultError(
      openSecretVault(dataDir, { env: { OMNYO_VAULT_KEY_STORE: "vault-box" } }),
      "record_invalid",
    );

    const first = await openSecretVault(dataDir, { env: keyFileEnv });

    const second = await openSecretVault(path.join(dataDir, "."), {
      env: keyFileEnv,
    });

    expect(second).toBe(first);
  });

  it("refuses envelopes from another vault and tampered envelopes", async () => {
    const vault = await openSecretVault(await makeTempDir(), {
      env: keyFileEnv,
    });

    const other = await openSecretVault(await makeTempDir(), {
      env: keyFileEnv,
    });

    const sealed = vault.seal("secret");
    const payload = sealed.slice(sealed.lastIndexOf(":") + 1);
    const bytes = Buffer.from(payload, "base64");
    bytes[bytes.length - 1] = (bytes[bytes.length - 1] ?? 0) ^ 1;
    const tampered = `${sealed.slice(0, sealed.lastIndexOf(":") + 1)}${bytes.toString("base64")}`;

    expectThrowsCode(() => other.open(sealed), "wrong_vault");
    expectThrowsCode(() => vault.open(tampered), "corrupt");
    expectThrowsCode(
      () => vault.open(`omnyo-vault:1:${vault.id}:AAAA`),
      "corrupt",
    );
    expectThrowsCode(
      () => vault.open(`omnyo-vault:2:${vault.id}:${payload}`),
      "corrupt",
    );
    expectThrowsCode(
      () => vault.open(`omnyo-vault:1:${vault.id}:not base64!`),
      "corrupt",
    );
    expect(isSealed("plain-token")).toBe(false);
  });

  it("uses the key file store on other platforms when no store is named", async () => {
    const vault = await openSecretVault(await makeTempDir(), {
      env: {},
      platform: "linux",
    });

    expect(vault.protection).toEqual({ kind: "key-file" });
  });

  it("refuses a requested key store that cannot run on this platform", async () => {
    const dataDir = await makeTempDir();

    await expectVaultError(
      openSecretVault(dataDir, {
        env: { OMNYO_VAULT_KEY_STORE: "keychain" },
        platform: "linux",
      }),
      "record_invalid",
    );
    expect(await readdir(dataDir)).toEqual([]);
  });

  it("refuses a record whose key store cannot run here and writes nothing", async () => {
    const dataDir = await makeTempDir();
    await writeRecord(dataDir, {
      schema: 1,
      id: "a".repeat(32),
      protection: { kind: "windows-dpapi", scope: "machine" },
      createdAt: 1,
    });
    const before = await snapshotTree(dataDir);

    await expectVaultError(
      openSecretVault(dataDir, { platform: "darwin", env: {} }),
      "record_invalid",
    );
    expect(await snapshotTree(dataDir)).toEqual(before);
  });

  it("refuses a malformed record", async () => {
    const dataDir = await makeTempDir();
    await mkdir(path.join(dataDir, "vault"));
    await writeFile(path.join(dataDir, "vault", "vault.json"), "{");

    await expectVaultError(
      openSecretVault(dataDir, { env: keyFileEnv }),
      "record_invalid",
    );
  });

  it("throws key_unavailable for an existing record and changes nothing", async () => {
    const dataDir = await makeTempDir();
    const keys = new Map<string, Buffer>();
    await openSecretVault(dataDir, { keyStore: memoryKeyStore(keys) });
    const before = await snapshotTree(dataDir);

    await expectVaultError(
      openSecretVault(dataDir, {
        keyStore: memoryKeyStore(keys, { on: "load", code: "key_unavailable" }),
      }),
      "key_unavailable",
    );
    expect(await snapshotTree(dataDir)).toEqual(before);
    expect(keys.size).toBe(1);
  });

  it("throws key_missing for an existing record without creating a key", async () => {
    const dataDir = await makeTempDir();
    await openSecretVault(dataDir, { keyStore: memoryKeyStore() });
    const emptyStore = new Map<string, Buffer>();
    const before = await snapshotTree(dataDir);

    await expectVaultError(
      openSecretVault(dataDir, { keyStore: memoryKeyStore(emptyStore) }),
      "key_missing",
    );
    expect(emptyStore.size).toBe(0);
    expect(await snapshotTree(dataDir)).toEqual(before);
  });

  it("writes no record when the key store refuses to store a new key", async () => {
    const dataDir = await makeTempDir();

    await expectVaultError(
      openSecretVault(dataDir, {
        keyStore: memoryKeyStore(new Map(), {
          on: "store",
          code: "key_unavailable",
        }),
      }),
      "key_unavailable",
    );
    expect(await readdir(dataDir)).toEqual([]);
  });

  it("converges two concurrent first opens on one record and removes the loser's key", async () => {
    const dataDir = await makeTempDir();
    let arrived = 0;
    let release: () => void = () => {};

    const bothStoring = new Promise<void>((resolve) => {
      release = resolve;
    });

    const racingStore = (): VaultKeyStore => {
      const inner = createKeyFileKeyStore(dataDir);

      return {
        protection: inner.protection,
        load: (vaultId) => inner.load(vaultId),
        remove: (vaultId) => inner.remove(vaultId),
        async store(vaultId, key) {
          await inner.store(vaultId, key);
          arrived += 1;

          if (arrived === 2) release();
          await bothStoring;
        },
      };
    };

    const [left, right] = await Promise.all([
      openSecretVault(dataDir, { keyStore: racingStore() }),
      openSecretVault(dataDir, { keyStore: racingStore() }),
    ]);

    expect(left.id).toBe(right.id);
    expect([left.created, right.created].sort()).toEqual([false, true]);
    expect(right.open(left.seal("shared"))).toBe("shared");
    expect((await readdir(path.join(dataDir, "vault"))).sort()).toEqual([
      `key-${left.id}`,
      "vault.json",
    ]);
  });
});
