import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  isSealed,
  keyStoreForProtection,
  openSecretVault,
} from "@omnyo/secret-storage";
import { afterEach, expect, it, vi } from "vitest";
import { openServerVault } from "../../src/services/system/server-vault.js";

const KEY_FILE_ENV = { OMNYO_VAULT_KEY_STORE: "key-file" };

const tempDirs: string[] = [];

async function makeDataDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "omnyo-server-vault-"));
  tempDirs.push(dir);

  return dir;
}

function testLogger() {
  return { error: vi.fn(), info: vi.fn() };
}

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((dir) => rm(dir, { force: true, recursive: true })),
  );
});

it("creates the vault once, logs its protection, and seals legacy core secrets", async () => {
  const dataDir = await makeDataDir();
  await writeFile(join(dataDir, "auth-secret"), `${"a".repeat(64)}\n`);
  await writeFile(join(dataDir, "machine-environment-key"), "b".repeat(64));
  const logger = testLogger();

  const vault = await openServerVault({ dataDir, env: KEY_FILE_ENV, logger });

  expect(logger.info).toHaveBeenCalledWith(
    { dataDir, protection: { kind: "key-file" } },
    "Created this data directory's secret vault",
  );

  for (const [file, value] of [
    ["auth-secret", `${"a".repeat(64)}\n`],
    ["machine-environment-key", "b".repeat(64)],
  ] as const) {
    const stored = await readFile(join(dataDir, file), "utf8");
    expect(isSealed(stored)).toBe(true);
    expect(vault.open(stored)).toBe(value);
  }
});

it("opens an existing vault without logging a creation", async () => {
  const dataDir = await makeDataDir();

  const existing = await openSecretVault(dataDir, {
    keyStore: keyStoreForProtection(dataDir, { kind: "key-file" }),
  });

  const logger = testLogger();
  const vault = await openServerVault({ dataDir, env: KEY_FILE_ENV, logger });

  expect(vault.id).toBe(existing.id);
  expect(vault.created).toBe(false);
  expect(logger.info).not.toHaveBeenCalled();
});

it("stops with the data directory, key store and code when the vault key is gone, and creates nothing", async () => {
  const dataDir = await makeDataDir();

  const vault = await openSecretVault(dataDir, {
    keyStore: keyStoreForProtection(dataDir, { kind: "key-file" }),
  });

  await writeFile(join(dataDir, "auth-secret"), vault.seal("c".repeat(64)));
  await rm(join(dataDir, "vault", `key-${vault.id}`));
  const before = await readdir(join(dataDir, "vault"));
  const logger = testLogger();

  const failure = openServerVault({ dataDir, env: KEY_FILE_ENV, logger });

  await expect(failure).rejects.toThrow(dataDir);
  await expect(failure).rejects.toThrow("key-file");
  await expect(failure).rejects.toThrow("key_missing");
  expect(logger.error).toHaveBeenCalledOnce();
  expect(await readdir(join(dataDir, "vault"))).toEqual(before);
  expect(vault.open(await readFile(join(dataDir, "auth-secret"), "utf8"))).toBe(
    "c".repeat(64),
  );
});

it("stops on an unreadable vault record instead of creating a new vault", async () => {
  const dataDir = await makeDataDir();
  await mkdir(join(dataDir, "vault"));
  await writeFile(join(dataDir, "vault", "vault.json"), "{not json");
  await writeFile(join(dataDir, "auth-secret"), "d".repeat(64));

  await expect(
    openServerVault({ dataDir, env: KEY_FILE_ENV, logger: testLogger() }),
  ).rejects.toThrow("record_invalid");
  expect(await readdir(join(dataDir, "vault"))).toEqual(["vault.json"]);
  expect(await readFile(join(dataDir, "auth-secret"), "utf8")).toBe(
    "d".repeat(64),
  );
});
