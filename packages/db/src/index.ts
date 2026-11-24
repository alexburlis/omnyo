export {
  createConnection,
  PrimaryWriteBusyError,
  runImmediateTransactionWithBusyWait,
} from "./connection.js";

export { historyCachePath, openHistoryCache } from "./history-cache.js";

export type {
  HistoryCache,
  HistoryCacheKind,
  HistoryCacheMetadata,
  HistoryCachePutResult,
  HistoryCacheReconcileOptions,
  HistoryCacheReconcileResult,
  HistoryCacheRecord,
  HistoryCacheStorageUsage,
} from "./history-cache.js";

export type {
  DbConnection,
  DbQueryConnection,
  DbTransaction,
  SlowDbQueryLogger,
  SlowDbQueryLogFields,
} from "./connection.js";

export * from "./schema.js";

export {
  createQueuedThreadMessageId,
  createEventId,
  createHostId,
  createThreadProvisioningId,
} from "./ids.js";

export { countAppliedMigrations, migrate } from "./migrate.js";

export {
  isSqliteForeignKeyConstraint,
  isSqliteUniqueConstraintOnColumns,
} from "./sqlite-errors.js";

export type { MigrationWarningLogger } from "./migrate.js";

export { deriveStoredEventItemFields } from "./stored-event-item-fields.js";

export { noopNotifier } from "./notifier.js";

export type { DbNotifier } from "./notifier.js";

export * from "./data/index.js";

export { historySourceIdentity } from "./history-cache.js";

export { adoptLegacyThreadAttention } from "./thread-attention-adoption.js";
