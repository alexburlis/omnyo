import { mkdtemp, readdir, readFile, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach } from "vitest";
import { SecretVaultError } from "../src/errors.js";
import type { VaultKeyStore } from "../src/key-stores/key-store.js";

export function trackTempDirs(): () => Promise<string> {
  const tempDirs: string[] = [];

  afterEach(async () => {
    await Promise.all(
      tempDirs
        .splice(0)
        .map((tempDir) => rm(tempDir, { force: true, recursive: true })),
    );
  });

  return async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "omnyo-vault-test-"));
    tempDirs.push(tempDir);

    return tempDir;
  };
}

export async function modeOf(filePath: string): Promise<number> {
  return (await stat(filePath)).mode & 0o777;
}

export const posixModes = process.platform !== "win32";

export async function snapshotTree(
  root: string,
): Promise<Record<string, string>> {
  const entries = await readdir(root, { recursive: true, withFileTypes: true });
  const files = entries.filter((entry) => entry.isFile());

  const contents = await Promise.all(
    files.map(async (entry) => {
      const filePath = path.join(entry.parentPath, entry.name);

      return [
        path.relative(root, filePath),
        await readFile(filePath, "utf8"),
      ] as const;
    }),
  );

  return Object.fromEntries(contents);
}

export function memoryKeyStore(
  keys: Map<string, Buffer> = new Map(),
  failure?: { on: "store" | "load"; code: "key_unavailable" },
): VaultKeyStore {
  return {
    protection: { kind: "key-file" },

    async store(vaultId, key) {
      if (failure?.on === "store")
        throw new SecretVaultError(failure.code, "store refused");

      if (keys.has(vaultId))
        throw new SecretVaultError("key_unavailable", "already stored");
      keys.set(vaultId, Buffer.from(key));
    },

    async load(vaultId) {
      if (failure?.on === "load")
        throw new SecretVaultError(failure.code, "load refused");
      const key = keys.get(vaultId);

      if (key === undefined)
        throw new SecretVaultError("key_missing", "no such key");

      return Buffer.from(key);
    },

    async remove(vaultId) {
      keys.delete(vaultId);
    },
  };
}
