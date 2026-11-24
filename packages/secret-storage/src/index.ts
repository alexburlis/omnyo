export { isSealed } from "./envelope.js";

export { SecretVaultError, type SecretVaultErrorCode } from "./errors.js";

export { keyStoreForProtection } from "./key-stores/index.js";

export type {
  DpapiScope,
  VaultKeyStore,
  VaultProtection,
} from "./key-stores/key-store.js";

export {
  deleteSecretFile,
  readOrCreateIdentifierFile,
  readOrCreateSecretFile,
  readSecretFile,
  sealLegacySecretFile,
  writeSecretFile,
} from "./secret-file.js";

export {
  openSecretVault,
  readVaultProtection,
  type OpenSecretVaultOptions,
  type SecretVault,
} from "./vault.js";
