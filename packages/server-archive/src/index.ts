export {
  adoptLegacyAppUpdateFilesV1,
  assertLegacyAppUpdateOwnerStoppedV1,
  projectLegacyAppUpdateInventoryPathV1,
} from "./legacy-app-update-files-v1.js";

export {
  createOriginAdoptionMetadataV1,
  originAdoptionRecordSchemaV1,
} from "./origin-adoption-metadata-v1.js";

export {
  inspectMacStateAclV1,
  copyMacStateAclV1,
} from "../mac-state-acl-v1.mjs";

export { legacyInstalledRuntimeVersionV1Schema } from "./legacy-runtime-identity-v1.js";

export { deleteOldServerCopy } from "./delete-old-copy.js";

export { assertServerArchiveFormat } from "./archive-format.js";

export {
  legacyRuntimeArchiveV1Schema,
  readLegacyRuntimeArchiveFilesV1,
} from "./legacy-runtime-archive-v1.js";

export {
  runWindowsStateOwnerProcess,
  moveWindowsStateDirectoryNoReplace,
} from "./windows-state-process.js";

export {
  writeJsonFileAtomically,
  readPrivateJsonFileText,
  writeTextFileAtomically,
} from "./json-file.js";

export {
  hasErrorCode,
  ServerArchiveError,
  type ServerArchiveErrorCode,
} from "./errors.js";

export { extractServerArchive } from "./extract-archive.js";

export {
  archiveExistingServerData,
  discardImportBackups,
  installImportedServerFiles,
  mergeImportedManagedConfig,
  removeImportedServerFiles,
  rollBackServerImport,
  SERVER_IMPORT_BACKUP_DIR_NAME,
} from "./import.js";

export {
  listServerOwnedEntries,
  type ServerOwnedInventory,
} from "./inventory.js";

export {
  SERVER_ARCHIVE_FORMAT,
  SERVER_ARCHIVE_VERSION,
  type ServerArchiveManifest,
  type ServerArchiveManifestInput,
  serverArchiveManifestSchema,
} from "./manifest.js";

export {
  LAST_SERVER_MOVE_FILE_NAME,
  readLastServerMoveFile,
  readServerConnectHoldFile,
  readServerImportFile,
  readServerImportJournalFile,
  readServerImportJournalStatus,
  readServerMovedFile,
  removeServerConnectHoldFile,
  removeServerImportJournalFile,
  SERVER_CONNECT_HOLD_FILE_NAME,
  SERVER_IMPORT_FILE_NAME,
  SERVER_IMPORT_JOURNAL_FILE_NAME,
  SERVER_MOVED_FILE_NAME,
  type ServerConnectHoldFile,
  type ServerImportFile,
  type ServerMovedFile,
  serverMovedFileSchema,
  writeLastServerMoveFile,
  writeServerConnectHoldFile,
  writeServerImportFile,
  writeServerMovedFile,
} from "./markers.js";

export {
  pipeServerArchive,
  planServerArchive,
  type ServerArchiveDigest,
  type ServerArchivePlan,
  type ServerArchiveSourceFile,
  streamServerArchive,
  writeServerArchive,
} from "./write-archive.js";

export * from "./runtime-identity.js";

export * from "./maintenance-hold.js";

export * from "./held-runtime-repair.js";

export {
  inspectOmnyoStateRootForAdoptionV2,
  readOmnyoStateRootJobBindingV2,
  restoreUnstagedOmnyoSourceFenceV1,
  stageOmnyoStateRootFromOwnerV2,
  verifyOmnyoStateRootDatabaseV2,
  verifyOmnyoSourceDatabaseCapacityV2,
  inspectOmnyoStateRoot,
  OmnyoStateWorkPendingError,
  preflightOmnyoStateRootKindsV1,
  stageOmnyoStateRoot,
  rollBackOmnyoStateRoot,
  type OmnyoStateRootInput,
  type OmnyoStagedStateRoot,
  assertOmnyoStagedStateRoot,
  prepareHeldIdentitySourceFenceV1,
  assertHeldIdentitySourceFenceV1,
  assertOmnyoStateRootRollbackSelected,
} from "./omnyo-state-root.js";
