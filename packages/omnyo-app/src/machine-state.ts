export { HOST_DAEMON_PROTOCOL_VERSION } from "@omnyo/host-daemon-contract";

export {
  admitOmnyoStateWrites,
  assertOmnyoStateAdmissionPrepared,
  assertOmnyoStateWriteAdmission,
  prepareOmnyoStateAdmission,
  readOmnyoStateAdmission,
  selectOmnyoPreWriteRollback,
} from "@omnyo/config/omnyo-state-admission";

export {
  admitConfiguredOmnyoStateWrites,
  readConfiguredOmnyoStateAdmission,
} from "@omnyo/config/omnyo-state-startup";

export { withFileLock } from "@omnyo/config/file-lock";

export { parseAppManagedConfig } from "@omnyo/config/managed-app-config";

export {
  readMaintenanceHold,
  writeTextFileAtomically,
  readRuntimeIdentity,
  verifyRuntimeIdentity,
  createRuntimeIdentity,
  createWorkerRuntimeIdentity,
  verifyWorkerRuntimeIdentity,
  moveWindowsStateDirectoryNoReplace,
  promoteDesktopUpdateHoldForIdentityV1,
} from "@omnyo/server-archive";
