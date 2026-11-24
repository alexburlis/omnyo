export const DEVELOPER_STORAGE_DIRECTORY = ".omnyo-dev";

export const DEVELOPER_LAUNCH_RECORD = "dev-instance.json";

export const APP_RUNTIME_RECORD = "app-runtime.json";

export const SOURCE_LAUNCHER = "start-omnyo.mjs";

export const RETENTION_TRASH_PREFIX = ".omnyo-trash-";

export function developerStorageRoot(homeDirectory: string) {
  return `${homeDirectory.replace(/[\\/]$/, "")}/${DEVELOPER_STORAGE_DIRECTORY}`;
}

export function isRetentionTrashName(name: string) {
  return name.startsWith(RETENTION_TRASH_PREFIX);
}

export function isStorageEntryName(name: string) {
  return /^(thr_[a-zA-Z0-9]+|\.omnyo-trash-[a-zA-Z0-9_-]+)$/.test(name);
}
