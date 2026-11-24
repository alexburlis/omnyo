import { SecretVaultError, clipDiagnostic } from "../errors.js";
import { HEX_KEY_PATTERN, type VaultKeyStore } from "./key-store.js";
import {
  DEFAULT_CHILD_TIMEOUT_MS,
  runProcess,
  type ChildProcessOptions,
  type ProcessResult,
} from "./process-runner.js";

export const SECURITY_EXECUTABLE = "/usr/bin/security";

export const KEYCHAIN_SERVICE = "app.omnyo.vault";

const ITEM_NOT_FOUND_EXIT = 44;

function unavailable(action: string, result: ProcessResult): SecretVaultError {
  const detail = clipDiagnostic(result.stderr);

  return new SecretVaultError(
    "key_unavailable",
    `macOS Keychain refused to ${action} the vault key (exit ${String(result.exitCode)})${detail ? `: ${detail}` : ""}`,
  );
}

export function createMacosKeychainKeyStore(
  options: ChildProcessOptions = {},
): VaultKeyStore {
  const run = options.run ?? runProcess;
  const timeoutMs = options.timeoutMs ?? DEFAULT_CHILD_TIMEOUT_MS;

  const security = (args: readonly string[], stdin = "") =>
    run({
      executable: SECURITY_EXECUTABLE,
      args,
      stdin,
      timeoutMs,
    });

  return {
    protection: { kind: "macos-keychain" },

    async store(vaultId, key) {
      const result = await security(
        ["-i"],
        `add-generic-password -s ${KEYCHAIN_SERVICE} -a ${vaultId} -l "Omnyo secret vault" -w ${key.toString("hex")}\n`,
      );

      if (result.exitCode !== 0) throw unavailable("store", result);
    },

    async load(vaultId) {
      const result = await security([
        "find-generic-password",
        "-s",
        KEYCHAIN_SERVICE,
        "-a",
        vaultId,
        "-w",
      ]);

      if (result.exitCode === ITEM_NOT_FOUND_EXIT)
        throw new SecretVaultError(
          "key_missing",
          `macOS Keychain has no vault key for vault ${vaultId} (service ${KEYCHAIN_SERVICE})`,
        );

      if (result.exitCode !== 0) throw unavailable("read", result);

      const hex = result.stdout.trim();

      if (!HEX_KEY_PATTERN.test(hex))
        throw new SecretVaultError(
          "key_unavailable",
          `macOS Keychain returned an invalid vault key for vault ${vaultId}`,
        );

      return Buffer.from(hex, "hex");
    },

    async remove(vaultId) {
      const result = await security([
        "delete-generic-password",
        "-s",
        KEYCHAIN_SERVICE,
        "-a",
        vaultId,
      ]);

      if (result.exitCode !== 0 && result.exitCode !== ITEM_NOT_FOUND_EXIT)
        throw unavailable("remove", result);
    },
  };
}
