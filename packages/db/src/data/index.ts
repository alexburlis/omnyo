export {
  createProject,
  ensurePersonalProject,
  findOrCreateProjectByLocalPathSource,
  getPersonalProject,
  getProject,
  getPublicProjectByLocalPathSource,
  listActiveProjects,
  listPublicProjects,
  markProjectDeleted,
  reorderProject,
  setProjectGitRemoteUrl,
  setProjectGitRemoteUrlIfMissing,
  listDefaultLocalProjectSourcesOnHost,
  updateProject,
  deleteProject,
} from "./projects.js";

export type { ReorderProjectResult } from "./projects.js";

export {
  getThreadConversationOutlineRecord,
  upsertThreadConversationOutlineRecord,
} from "./thread-conversation-outlines.js";

export {
  createThreadSection,
  deleteThreadSection,
  getThreadSectionById,
  listThreadSections,
  normalizeThreadSectionName,
  renameThreadSection,
} from "./thread-sections.js";

export {
  createThreadGroup,
  deleteThreadGroup,
  getThreadGroupById,
  listThreadGroups,
  normalizeThreadGroupName,
  renameThreadGroup,
  type ThreadGroupMutationResult,
  type ThreadGroupRow,
} from "./thread-groups.js";

export {
  createPromptHistoryEntry,
  listPromptHistoryPage,
  listStoredProjectPromptHistoryRows,
  listStoredThreadPromptHistoryRows,
  PROMPT_HISTORY_ENTRY_MAX_BYTES,
} from "./prompt-history.js";

export type {
  ListPromptHistoryPageArgs,
  PromptHistoryPosition,
  StoredPromptHistoryEntryRow,
} from "./prompt-history.js";

export {
  getProjectExecutionDefaults,
  listProjectExecutionDefaultsByProjectIds,
  upsertProjectExecutionDefaults,
} from "./project-execution-defaults.js";

export {
  createProjectSource,
  countProjectSources,
  getProjectSourceForProject,
  listProjectSourcesByProjectIds,
  listProjectSourcesByHost,
  getProjectSourceByHost,
  projectSourceOwnsPath,
  updateProjectSource,
  deleteProjectSource,
} from "./project-sources.js";

export {
  getThreadPluginMetadata,
  insertThreadPluginMetadata,
  listPluginThreadMetadata,
  listThreadPluginMetadataRows,
  patchThreadPluginMetadata,
} from "./thread-plugin-metadata.js";

export {
  createThread,
  type CreateThreadInput,
  InvalidLifecycleOwnerError,
  countLiveThreadsInEnvironment,
  countThreads,
  countNonDeletedAssignedChildThreads,
  getThread,
  getThreadExecutionOverride,
  hasActiveThreadAttention,
  setThreadExecutionOverride,
  getThreadStartupContext,
  setThreadStartupContext,
  listExistingThreadIds,
  listHostThreadIds,
  listActiveHostThreads,
  listActiveVisiblePinnedThreadRootsWithPendingInteractionState,
  listShelvedThreadRootsWithPendingInteractionState,
  listLiveThreadsInEnvironment,
  listThreadMentionRowsByIds,
  listNonDeletedChildThreads,
  listThreadEnvironmentAssignmentsOnHost,
  listUnarchivedAssignedChildThreads,
  listNonDeletedHiddenSourceThreads,
  lifecycleThreadTreeIdsForProject,
  listLifecycleThreadTree,
  listLifecycleThreadDependents,
  listArchivedThreadsPendingTeardown,
  listRunningThreads,
  countThreadsWithUpdateActivity,
  primeThreadUpdateActivity,
  hasThreadUpdateBackgroundWork,
  listThreadsWithUpdateActivity,
  listOpenThreadUpdateWorkRows,
  listErroredThreadsForContinuation,
  listThreadsWithPendingInteractionState,
  listThreadsWithPendingInteractionStateForProjects,
  pinThread,
  reorderPinnedThread,
  reorderShelvedThread,
  shelveThreadFamily,
  updateThread,
  clearPluginHomeThreads,
  deleteThread,
  purgeThreadHistoryChunk,
  archiveThread,
  markThreadDeleted,
  markThreadStorageDeleted,
  unpinThread,
  unshelveThreadFamily,
  unarchiveThread,
  applyThreadLifecycleEvent,
  applyThreadLifecycleEventInTransaction,
  requireThreadLifecycleEventApplied,
  listThreadAncestors,
  listThreadDescendants,
  findThreadSearchMatches,
  hydrateThreadSearchMatches,
  searchThreadsWithPendingInteractionState,
  THREAD_SEARCH_LIMIT_PER_GROUP_DEFAULT,
  THREAD_SEARCH_LIMIT_PER_GROUP_MAX,
} from "./threads.js";

export type {
  ApplyThreadLifecycleEventArgs,
  ApplyThreadLifecycleEventOutcome,
  ReorderPinnedThreadResult,
  ReorderShelvedThreadResult,
  RunningThreadRow,
  ShelveThreadFamilyResult,
  ThreadSearchMatches,
  ThreadSearchResultGroup,
  ThreadShelfArgs,
  ThreadWithPendingInteractionState,
  ThreadExecutionOverride,
  UpdateThreadInput,
} from "./threads.js";

export {
  clearNativeClaudeProfileDefaults,
  forgetPluginProviders,
  getAiServiceSelections,
  getAppKeybindingOverrides,
  getAppSettings,
  getNativeClaudeProfilesOwnerPilot,
  setNativeClaudeProfilesOwnerPilot,
  getNativeClaudeProfileDefault,
  setNativeClaudeProfileDefault,
  migrateUsageConsent,
  getDisabledPluginProviderCatalog,
  getDisabledProviderIds,
  getPluginSafeMode,
  setAiServiceSelection,
  setAppKeybindingOverrides,
  setAppSettings,
  setDisabledPluginProviderCatalog,
  setDisabledProviderIds,
  setPluginSafeMode,
} from "./app-settings.js";

export { getStoredThreadTabs, replaceStoredThreadTabs } from "./thread-tabs.js";

export {
  getStoredUiPreferenceDefault,
  listStoredUiPreferenceDefaults,
  listStoredUiPreferences,
  overwriteStoredUiPreference,
  replaceStoredUiPreference,
  type StoredUiPreference,
} from "./ui-preferences.js";

export { getExperiments, setExperiments } from "./experiments.js";

export {
  deleteInstalledPlugin,
  getInstalledPlugin,
  getInstalledPluginRegistration,
  listInstalledPlugins,
  listInstalledPluginsFromMarketplace,
  listUnnormalizedPluginRegistrations,
  markInstalledPluginRemoved,
  normalizeInstalledPluginRegistration,
  setInstalledPluginDirectProvenance,
  setInstalledPluginEnabled,
  setInstalledPluginUpdateState,
  setInstalledPluginSourceClassification,
  setInstalledPluginLastFailure,
  upsertInstalledPlugin,
  type InstalledPluginRow,
  type LegacyPluginExactResolution,
  type NormalizeLegacyInstalledPluginInput,
  type PluginExactResolution,
  type PluginGitSelector,
  type PluginProvenance,
  type PluginSourceIntent,
} from "./plugins.js";

export {
  createPluginArtifact,
  deletePluginArtifact,
  getPluginArtifactByResolution,
  getPluginArtifact,
  listPluginArtifacts,
  listInstalledPluginIdsOverlappingPath,
  listPluginArtifactsAtOrUnderPath,
  listPluginArtifactsInGitCheckout,
  listPluginArtifactsUnderPath,
  listPendingGitPluginArtifacts,
  listRecentPluginArtifacts,
  setPluginArtifactGitCheckoutRoot,
  setPluginArtifactValidation,
  type PluginArtifactRow,
} from "./plugin-artifacts.js";

export {
  deletePluginMarketplace,
  getPluginMarketplace,
  getPluginMarketplaceIcon,
  listPluginMarketplaceIcons,
  listPluginMarketplaces,
  replacePluginMarketplaceIcons,
  recordPluginMarketplaceRefreshFailure,
  upsertPluginMarketplace,
  type PluginMarketplaceIconRow,
  type PluginMarketplaceRow,
  type PluginMarketplaceSourceKind,
  type UpsertPluginMarketplaceIconInput,
} from "./plugin-marketplaces.js";

export {
  deleteAllPluginSettings,
  deletePluginKvValue,
  getPluginKvValue,
  getPluginSettingsValues,
  listPluginKvKeys,
  setPluginKvValue,
  setPluginSettingsValues,
  listPluginKvRows,
  listPluginSettingRows,
} from "./plugin-storage.js";

export {
  deletePluginHostGeneration,
  getPluginHostGeneration,
  listPluginHostGenerationIds,
  setPluginHostGeneration,
  type PluginHostGeneration,
} from "./plugin-host-generations.js";

export {
  claimPluginScheduledRun,
  deletePluginSchedules,
  listDuePluginSchedules,
  listPluginSchedules,
  prunePluginSchedules,
  recordPluginScheduleResult,
  upsertPluginSchedule,
} from "./plugin-schedules.js";

export {
  createPluginStateSnapshot,
  deletePluginStateSnapshot,
  getPluginStateSnapshot,
  listExpiredPluginStateSnapshots,
  listGarbageCollectablePluginArtifacts,
  listIncompletePluginRollbackSnapshots,
  listPluginStateSnapshots,
  replacePluginSnapshotState,
  setPluginStateSnapshotStatus,
  setPluginStateSnapshotRollbackPending,
  type PluginStateSnapshotRow,
} from "./plugin-state-snapshots.js";

export {
  getStoredThemeId,
  getStoredFaviconColor,
  setStoredAppearance,
} from "./app-theme.js";

export {
  getPreparingEnvironment,
  reserveEnvironment,
  updatePreparingEnvironment,
  listProviderLifecycleEnvironments,
  environmentHasLiveThreads,
  releaseFinishedEnvironmentPreparationOwners,
  claimEnvironmentPath,
  findEnvironmentPathClaim,
  bindEnvironmentPath,
  createEnvironment,
  getEnvironment,
  findProjectEnvironmentByHostPath,
  listEnvironments,
  findForeignManagedEnvironmentAtHostPath,
  findProviderEnvironmentContainingPath,
  listRetiredLoadedEnvironmentIdsOnHost,
  markHostEnvironmentsDestroyed,
  markHostEnvironmentsLeftOnMachine,
  recordEnvironmentCurrentBranch,
  updateEnvironmentMetadata,
} from "./environments.js";

export type { EnvironmentRow } from "./environments.js";

export {
  upsertHost,
  getHost,
  getNonDestroyedHost,
  getNonDestroyedHostByLaunchKey,
  listHosts,
  listHostsByIds,
  listNonDestroyedHostsByIds,
  listPublicHosts,
  updateHost,
} from "./hosts.js";

export type { HostRow } from "./hosts.js";

export {
  deleteStoredProviderModelCatalogsForHost,
  getStoredProviderModelCatalog,
  replaceStoredProviderModelCatalog,
} from "./provider-model-catalogs.js";

export type {
  ProviderModelCatalogRowKey,
  StoredProviderModelCatalog,
} from "./provider-model-catalogs.js";

export {
  appendDaemonEventsInTransaction,
  appendRetainedDaemonEventsInTransaction,
  appendStoredThreadEvent,
  copyStoredThreadEventsInTransaction,
  CONSTRUCTED_THREAD_HISTORY_EVENT_TYPES,
  insertConstructedThreadEventsInTransaction,
  type ConstructedThreadEventInput,
  type ConstructedThreadHistoryEventType,
  type InsertConstructedThreadEventsArgs,
  findLastCompletedRootStoredTurn,
  findLastRootStoredTurnStarted,
  appendStoredThreadEventsInTransaction,
  deleteThreadEventSuffixInTransaction,
  getHighWaterMarks,
  findStoredEventRow,
  getActiveStoredTurnId,
  isStoredTurnMainRunIdle,
  hasRootStoredTurnStarted,
  hasStoredSpawnAgentToolCall,
  hasStoredTerminalClientTurnRequestEvent,
  findLatestUnresolvedClientTurnRequestIdAfterSequence,
  hasStoredTurnCompleted,
  hasStoredTurnStarted,
  classifyStoredProviderThreadClaim,
  wouldRemoveSharedProviderSessionClaim,
  getLastStoredProviderThreadId,
  getStoredProviderSession,
  getLastStoredTurnRequestEvent,
  hasStoredTurnRequestEventSince,
  getStoredTurnRequestEventForTurn,
  getThreadConversationSequences,
  getLatestRequestTokenUsageRow,
  getLatestThreadOutputEventRow,
  getLatestStoredConversationOutlineSequence,
  getLatestCompletedThreadContextClearSequence,
  getLatestThreadSystemErrorEventRow,
  getLatestThreadSequence,
  insertEvents,
  listActiveBackgroundTaskCountsByThreadIds,
  listContextWindowUsageRows,
  getLatestTokenUsageRow,
  listEvents,
  listStoredConversationOutlineEventRows,
  listStoredRootConversationOutlineEventRows,
  getStoredConversationOutlineProjectionState,
  listTimelineWindowHintsDescending,
  getFirstParentedTimelineBoundarySequence,
  getTimelineGroupingContextChangesInRange,
  listStoredEventRowsInSequenceRange,
  listTimelineOrderingContext,
  listTimelineInterruptionRows,
  getLatestThreadInterruptionSequence,
  getThreadEventTypeWatermark,
  findTimelineWindowBudgetFloorSequence,
  findStoredTimelineWindowByteBudgetFloor,
  isTimelineCursorSequencePresent,
  listStoredClientTurnRequestIdsInRange,
  listStoredClientTurnRequestRowsByKeys,
  listStoredEventRowsByParentToolCallIds,
  listStoredEventRows,
  listItemEventSpansByItems,
  hasOtherStoredTimelineItemsInRange,
  listStoredBufferedTextDeltaRowsByItems,
  findStoredItemTurnIdInRange,
  getStoredItemTreeSequenceRange,
  listStoredItemLifecycleRowsByItems,
  scopedItemRefKey,
  listStoredTimelineWindowEventRows,
  listStoredTimelineTurnEventRows,
  listStoredTimelineThreadWindowEventRows,
  listTimelineRootWindowTurnIds,
  listStoredDelegatingItemRowsByItemIds,
  listStoredTurnInputAcceptedRowsByClientRequestIds,
  listStoredTurnRejectedRowsByClientRequestIds,
  listStoredTurnCompletedRowsByTurnIds,
  listStoredTurnCompletedKeys,
  listStoredTurnStartedKeys,
  listStoredTurnStartedRowsByTurnIdsUpToSequence,
  getLatestThreadInterruptedReason,
  getLatestStoredRateLimitsEvent,
  getLatestStoredThreadEventOfTypes,
  listLatestThreadStateEventRowsByThreadIds,
  listLatestBackgroundTaskStateRowsByItemIds,
  listLatestOpenBackgroundTaskStateRowsForThread,
  listTodoSnapshotEventRowsForThread,
  listOpenTurnInputAcceptedRowsByThreadIds,
  listOpenBackgroundTaskItemRowsForHost,
  listOpenBackgroundTaskItemRowsForThread,
  listThreadEventSuffixBackgroundSettlementRows,
  listThreadIdsStoppedSinceLastTurnStart,
  listThreadIdsWithLatestHostDaemonRestartInterruption,
  listThreadTurnInterruptionEventStates,
  MissingStoredTurnStartedError,
} from "./events.js";

export {
  getDatabaseDataVersion,
  getThreadEventRewriteGeneration,
} from "./event-rewrite-generation.js";

export {
  getThreadHistoryEpoch,
  getThreadHistoryState,
} from "./timeline-history-epoch.js";

export {
  getThreadTimelineRecord,
  putThreadTimelineRecord,
  type ThreadTimelineRecordInput,
  type ThreadTimelineRecordLimits,
} from "./timeline-derived-cache.js";

export {
  canHydrateRetainedEventOutputRowsWithinDataByteLimit,
  deleteExpiredRetainedEventOutputs,
  hydrateRetainedEventOutputRows,
  hydrateRetainedEventOutputRowsWithinDataByteLimit,
  prepareCompletedEventOutputData,
  insertPreparedRetainedEventOutput,
} from "./retained-event-outputs.js";

export {
  COMPLETED_EVENT_OUTPUT_RETENTION_MS,
  RETAINED_EVENT_OUTPUT_TARGETS,
} from "../retained-event-output.js";

export type {
  AcceptedDaemonEvent,
  AppendDaemonEventInput,
  AppendDaemonEventsResult,
  AppendStoredThreadEventArgs,
  OpenBackgroundTaskItemRow,
  InlineOutputCharLimit,
  ScopedItemRef,
  StoredEventRow,
  StoredThreadEventDataRow,
  TimelineWindowHint,
  ThreadClientTurnRequestKey,
  StoredTurnRequestEventRow,
  ThreadConversationSequences,
} from "./events.js";

export {
  countTerminalSessions,
  createTerminalSession,
  getTerminalSession,
  listTerminalSessions,
  updateTerminalSession,
  updateTerminalSessions,
} from "./terminal-sessions.js";

export type {
  TerminalSessionMutation,
  TerminalSessionRow,
} from "./terminal-sessions.js";

export {
  createPendingInteraction,
  getActivePendingInteractionForThread,
  hasTurnBoundActivePendingInteractionForThread,
  getPendingInteraction,
  getPendingInteractionByProviderRequest,
  interruptPendingInteractionsForThreadIds,
  interruptPendingInteractionsForThreads,
  interruptPendingInteractionsForPlugin,
  listActivePluginPendingInteractions,
  listActiveProviderPendingInteractionsForHost,
  listPendingInteractionsByThread,
  setPendingInteractionInterrupted,
  setPendingInteractionResolving,
  setPendingInteractionResolved,
} from "./pending-interactions.js";

export type { PendingInteractionRow } from "./pending-interactions.js";

export {
  openSession,
  closeSession,
  getLatestSessionForHost,
  getSessionById,
  heartbeatSession,
  listLatestClosedSessionsForHosts,
} from "./sessions.js";

export type { HostDaemonSessionRow } from "./sessions.js";

export {
  claimQueuedThreadMessageGroup,
  claimNextQueuedThreadMessageGroup,
  clearQueuedThreadMessageWaitingOn,
  createQueuedThreadMessage,
  createQueuedThreadMessageInTransaction,
  QueuedMessageThreadUnavailableError,
  getPendingCoalescedQueuedThreadMessage,
  updateCoalescedQueuedThreadMessageInTransaction,
  listReadySystemNoticesOnBusyThreads,
  createUniqueQueuedThreadMessageInTransaction,
  deleteQueuedRetriesForThreadEventSuffixInTransaction,
  deleteClaimedQueuedThreadMessageBatchInTransaction,
  deleteQueuedThreadMessage,
  wasQueuedThreadMessageDispatched,
  getQueuedThreadMessage,
  getQueuedThreadStartMessage,
  hasQueuedRetryOfTurnRequest,
  getQueuedThreadContinuation,
  hasClaimedQueuedThreadMessages,
  holdQueuedThreadMessageForEdit,
  isIdleDrainableQueuedMessage,
  isOrdinaryTurnEndQueuedMessage,
  isThreadQueueAutoSendPaused,
  listDueScheduledQueuedThreadMessages,
  listIdleThreadsWithQueuedMessages,
  listQueuedThreadMessageCountsByThreadIds,
  listQueuedThreadMessagePluginWaitRefs,
  listQueuedThreadMessages,
  listQueuedThreadMessagesForApi,
  listQueuedThreadMessagesByWaitHolder,
  listQueuedThreadMessagesWaitingOnKind,
  listRetryableFailedQueuedThreadMessages,
  listThreadIdsWithHostAwayQueueWaits,
  listThreadIdsWithHostOfflineQueueWaits,
  listThreadIdsWithServerUpdateQueueWaits,
  releaseQueuedMessageClaim,
  releaseQueuedThreadMessageEditHold,
  requeueClaimedQueuedThreadMessages,
  setQueuedThreadMessageFailureReason,
  setQueuedThreadMessageWaitingOn,
  releaseStaleQueuedMessageClaims,
  reorderQueuedThreadMessage,
  restoreDeletedQueuedThreadMessage,
  setQueuedThreadMessageGroupBoundary,
  supersedeQueuedRetriesInTransaction,
  updateQueuedThreadMessage,
} from "./queued-thread-messages.js";

export type {
  ClaimedQueuedThreadMessageRow,
  CreateQueuedThreadMessageInput,
  DeletedQueuedThreadMessage,
  QueuedThreadMessageGroupClaimPolicy,
  QueuedThreadMessageGroupEligibility,
  QueuedThreadMessageRow,
  QueuedMessageThreadUnavailableReason,
  ReorderQueuedThreadMessageResult,
  SetQueuedThreadMessageGroupBoundaryResult,
} from "./queued-thread-messages.js";

export {
  CLOSED_SESSION_ROW_RETENTION_MS,
  DEFAULT_CLOSED_SESSION_PRUNE_BATCH_SIZE,
  DEFAULT_COMPLETED_EVENT_OUTPUT_MIGRATION_SCAN_LIMIT,
  DEFAULT_LEGACY_IMAGE_GENERATION_MIGRATION_SCAN_LIMIT,
  migrateNextCompletedEventItemOutput,
  migrateNextLegacyImageGenerationOutput,
  pruneClosedSessions,
} from "./sweeps.js";

export {
  dropDeferredLegacyTables,
  runIncrementalVacuum,
  getDatabaseAutoVacuumMode,
  DATABASE_INCREMENTAL_VACUUM_MIN_FREELIST_PAGES,
  DATABASE_INCREMENTAL_VACUUM_MAX_PAGES,
  DATABASE_MAINTENANCE_BUSY_TIMEOUT_MS,
  getDatabaseFreelistStats,
  getDatabaseMaintenanceActivity,
  isDatabaseMaintenanceIdle,
  listDeferredLegacyTables,
  shouldRunIncrementalVacuum,
} from "./maintenance.js";

export * from "./machines.js";

export {
  advanceThreadPruning,
  getNextThreadPruningPolicy,
  THREAD_PRUNING_MAX_BATCH_SIZE,
  THREAD_PRUNING_POLICIES,
} from "./thread-pruning.js";

export {
  listPathInstalledPluginSources,
  rerootServerOwnedPluginPaths,
  swapServerHostRoles,
  type RerootServerOwnedPathsResult,
  type SwapServerHostRolesResult,
} from "./server-move.js";

export * from "./project-attachments.js";

export * from "./project-attachment-backfill.js";

export * from "./thread-attention.js";

export * from "./daemon-event-receipts.js";

export * from "./submission-receipts.js";

export * from "./native-thread-imports.js";

export * from "./thread-work.js";

export { listRecentCompletedCommandHeaders } from "./command-proofs.js";

export * from "./previews.js";

export * from "./usage-telemetry.js";
