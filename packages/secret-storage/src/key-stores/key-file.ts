import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { SecretVaultError } from "../errors.js";
import {
  createFileExclusive,
  ensurePrivateDirectory,
  errorCode,
} from "../files.js";
import {
  HEX_KEY_PATTERN,
  vaultDirectory,
  type VaultKeyStore,
} from "./key-store.js";

export function createKeyFileKeyStore(dataDir: string): VaultKeyStore {
  const keyPath = (vaultId: string) =>
    join(vaultDirectory(dataDir), `key-${vaultId}`);

  return {
    protection: { kind: "key-file" },

    async store(vaultId, key) {
      await ensurePrivateDirectory(vaultDirectory(dataDir));

      if (!(await createFileExclusive(keyPath(vaultId), key.toString("hex"))))
        throw new SecretVaultError(
          "key_unavailable",
          `Vault key file for ${vaultId} already exists`,
        );
    },

    async load(vaultId) {
      let content: string;

      try {
        content = await readFile(keyPath(vaultId), "utf8");
      } catch (error) {
        if (errorCode(error) === "ENOENT")
          throw new SecretVaultError(
            "key_missing",
            `Vault key file ${keyPath(vaultId)} is missing`,
          );
        throw new SecretVaultError(
          "key_unavailable",
          `Vault key file ${keyPath(vaultId)} cannot be read (${String(errorCode(error))})`,
        );
      }

      const hex = content.trim();

      if (!HEX_KEY_PATTERN.test(hex))
        throw new SecretVaultError(
          "key_unavailable",
          `Vault key file ${keyPath(vaultId)} does not hold a valid key`,
        );

      return Buffer.from(hex, "hex");
    },

    async remove(vaultId) {
      await rm(keyPath(vaultId), { force: true });
    },
  };
}
