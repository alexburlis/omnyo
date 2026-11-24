import { join } from "node:path";

export type DpapiScope = "user" | "machine";

export type VaultProtection =
  | { kind: "macos-keychain" }
  | { kind: "windows-dpapi"; scope: DpapiScope }
  | { kind: "key-file" };

export interface VaultKeyStore {
  readonly protection: VaultProtection;
  store(vaultId: string, key: Buffer): Promise<void>;
  load(vaultId: string): Promise<Buffer>;
  remove(vaultId: string): Promise<void>;
}

export const VAULT_KEY_BYTES = 32;

export const HEX_KEY_PATTERN = /^[0-9a-f]{64}$/u;

export function vaultDirectory(dataDir: string): string {
  return join(dataDir, "vault");
}
