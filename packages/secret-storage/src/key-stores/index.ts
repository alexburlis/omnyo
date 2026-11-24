import { createKeyFileKeyStore } from "./key-file.js";
import type { VaultKeyStore, VaultProtection } from "./key-store.js";
import { createMacosKeychainKeyStore } from "./macos-keychain.js";
import type { ChildProcessOptions } from "./process-runner.js";
import { createWindowsDpapiKeyStore } from "./windows-dpapi.js";

export interface KeyStoreOptions extends ChildProcessOptions {
  env?: NodeJS.ProcessEnv;
}

export const PROTECTION_PLATFORM: Record<
  VaultProtection["kind"],
  NodeJS.Platform | "any"
> = {
  "macos-keychain": "darwin",
  "windows-dpapi": "win32",
  "key-file": "any",
};

export function protectionRunsOn(
  kind: VaultProtection["kind"],
  platform: NodeJS.Platform,
): boolean {
  const required = PROTECTION_PLATFORM[kind];

  return required === "any" || required === platform;
}

export function keyStoreForProtection(
  dataDir: string,
  protection: VaultProtection,
  options: KeyStoreOptions = {},
): VaultKeyStore {
  switch (protection.kind) {
    case "macos-keychain":
      return createMacosKeychainKeyStore(options);
    case "windows-dpapi":
      return createWindowsDpapiKeyStore(dataDir, protection.scope, options);
    case "key-file":
      return createKeyFileKeyStore(dataDir);
  }
}
