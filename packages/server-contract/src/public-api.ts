import {
  usageConsentRequestSchema,
  productUsageErasureSchema,
  type UsageStatus,
  type UsageConsentRequest,
  type UsageConsentResponse,
  type UsagePreview,
} from "@omnyo/domain/usage-telemetry";
import type { HostHousekeepingResponse } from "./api/hosts.js";
import {
  previewRegisterRequestSchema,
  previewListQuerySchema,
  previewRestartRequestSchema,
  type PreviewRegisterRequest,
  type PreviewBinding,
  type PreviewListQuery,
  type PreviewListResponse,
  type PreviewRestartRequest,
  type PreviewStatus,
} from "./api/previews.js";
import {
  inboxActRequestSchema,
  inboxFailureAcknowledgeRequestSchema,
  inboxEventCheckRequestSchema,
  inboxEventReportRequestSchema,
  inboxPendingEventsQuerySchema,
  inboxProducerSettleRequestSchema,
  inboxProducerStartRequestSchema,
  inboxRetryDeclineRequestSchema,
  inboxUndoRequestSchema,
  inboxWaitMetRequestSchema,
  inboxWaitRegisterRequestSchema,
  publishThreadWorkSchema,
  type InboxActRequest,
  type InboxFailureListResponse,
  type InboxFailureAcknowledgeRequest,
  type InboxFailureAcknowledgeResponse,
  type InboxActResult,
  type InboxEventCheckRequest,
  type InboxEventCheckResponse,
  type InboxEventReportRequest,
  type InboxEventReportResponse,
  type InboxEventSourcesResponse,
  type InboxPendingEventsQuery,
  type InboxPendingEventsResponse,
  type InboxProducerResponse,
  type InboxProducerSettleRequest,
  type InboxProducerStartRequest,
  type InboxRetryDeclineRequest,
  type InboxRetryDeclineResponse,
  type InboxSnapshot,
  type InboxUndoRequest,
  type InboxWaitActionResponse,
  type InboxWaitDetailResponse,
  type InboxWaitListResponse,
  type InboxWaitMetRequest,
  type InboxWaitRegisterRequest,
  type InboxWaitRegisterResponse,
  type PublishThreadWork,
  type ThreadWorkSummary,
} from "@omnyo/domain";
import {
  archiveReadyThreadRequestSchema,
  threadContinueQuerySchema,
  type ThreadContinueQuery,
  importNativeThreadRequestSchema,
  nativeSessionClaimsQuerySchema,
  type ArchiveReadyThreadRequest,
  type ImportNativeThreadAlreadyClaimedResponse,
  type ImportNativeThreadImportedResponse,
  type ImportNativeThreadRequest,
  type NativeSessionClaimsQuery,
  type NativeSessionClaimsResponse,
} from "./api/threads.js";
import {
  attachmentDiagnosticSchema,
  type AttachmentDiagnostic,
} from "./api/attachment-diagnostics.js";
import {
  voiceDiagnosticSchema,
  type VoiceDiagnostic,
} from "./api/voice-diagnostics.js";
import {
  webUpdateBeginSchema,
  webUpdateUploadSchema,
  webUpdateApplySchema,
  webUpdateAbortSchema,
  webUpdateRollbackSchema,
  type WebUpdateBegin,
  type WebUpdateUpload,
  type WebUpdateApply,
  type WebUpdateAbort,
  type WebUpdateRollback,
  type WebUpdateStatus,
} from "./api/web-update.js";
import {
  acquireUpdateHoldSchema,
  releaseHoldSchema,
  prepareMaintenanceSchema,
  type PrepareMaintenance,
  type MaintenancePrepareResult,
  type MaintenanceStatus,
  type ServerRuntimeIdentity,
  type AcquireUpdateHold,
  type MaintenanceAcquireResult,
  type ReleaseHold,
  type MaintenanceReleaseResult,
} from "./api/server-maintenance.js";
import {
  machineEnvironmentSetSchema,
  machineEnvironmentDeleteSchema,
  type MachineEnvironmentSet,
  type MachineEnvironmentDelete,
  type ProjectMachineEnvironmentList,
  type MachineEnvironmentList,
} from "./api/machine-environment.js";
import {
  bugReportRequestSchema,
  machineEnvironmentReplaceSchema,
  recordTelemetryEventRequestSchema,
  setAiServiceSelectionRequestSchema,
  systemProviderEnabledRequestSchema,
  testAiServiceRequestSchema,
  type BugReportRequest,
  type BugReportResponse,
  type MachineEnvironmentReplace,
  type RecordTelemetryEventRequest,
  type SetAiServiceSelectionRequest,
  type SystemAiServicesResponse,
  type SystemProviderCatalogEntry,
  type SystemProviderEnabledRequest,
  type TestAiServiceRequest,
  type TestAiServiceResponse,
} from "./api/system.js";
import {
  bootQuerySchema,
  type BootQuery,
  type BootResponse,
} from "./api/boot.js";
import type { WebAssetManifest } from "./api/web-assets.js";
import {
  desktopBrowserHostRequestSchema,
  desktopRendererProfileRequestSchema,
  type ExperimentalDesktopRendererProfileInput,
  type ExperimentalDesktopRendererProfile,
  desktopBrowserScopeSchema,
  desktopBrowserCreateRequestSchema,
  desktopBrowserAcquireRequestSchema,
  desktopBrowserLeaseRequestSchema,
  desktopBrowserTabRequestSchema,
  type ExperimentalDesktopBrowserHostRequest,
  type ExperimentalDesktopBrowserScope,
  type ExperimentalDesktopBrowserCreateInput,
  type ExperimentalDesktopBrowserAcquireInput,
  type ExperimentalDesktopBrowserLeaseRequest,
  type ExperimentalDesktopBrowserTabRequest,
  type ExperimentalDesktopBrowserInstances,
  type ExperimentalDesktopBrowserTabs,
  type ExperimentalDesktopBrowserCreated,
  type ExperimentalDesktopBrowserLease,
  type ExperimentalDesktopBrowserConnection,
  type ExperimentalDesktopBrowserCapture,
  desktopBrowserInstanceRequestSchema,
  desktopBrowserImportCookiesRequestSchema,
  desktopBrowserCookieSyncConfigureRequestSchema,
  type ExperimentalDesktopBrowserCookieSyncConfigureRequest,
  type ExperimentalDesktopBrowserCookieSyncStatus,
  type ExperimentalDesktopBrowserInstanceRequest,
  type ExperimentalDesktopBrowserImportCookiesInput,
  type ExperimentalDesktopBrowserImportSources,
  type ExperimentalDesktopBrowserImportOutcome,
} from "./api/desktop-browsers.js";
import type { Hono } from "hono";
import type {
  AppTheme,
  AppThemeSelection,
  AppSettings,
  AppSettingsUpdate,
  AppKeybindingOverrides,
  Environment,
  ExperimentUpdates,
  Experiments,
  Host,
  PendingInteraction,
  ProjectExecutionDefaults,
  ProjectSource,
  ResolvedThreadExecutionOptions,
  ThreadEventRow,
  ThreadQueuedMessage,
} from "@omnyo/domain";
import {
  appSettingsUpdateSchema,
  appKeybindingOverridesSchema,
  appThemeSelectionSchema,
  experimentUpdatesSchema,
} from "@omnyo/domain";
import type { ProviderUsageResponse } from "@omnyo/host-daemon-contract";
import {
  binaryResponse,
  defineRoute,
  formRequest,
  jsonRequest,
  jsonResponse,
  noRequest,
  optionalQueryRequest,
  queryRequest,
  textResponse,
  type ApiSchemaFromRouteDescriptors,
  type EmptyInput,
} from "@omnyo/hono-typed-routes";
import type {
  PathId,
  PathProjectId,
  PathIdAndFilePath,
  PathIdHostAndFilePath,
  PathIdRefAndFilePath,
  PathThreadAndQueuedMessage,
  PathThreadAndProducer,
  PathThreadAndWait,
  PathTerminal,
} from "./common.js";
import type {
  CloseTerminalRequest,
  CommandListResponse,
  CommandCatalogResponse,
  CopyProjectAttachmentsRequest,
  RetainProjectAttachmentsRequest,
  CreateHostJoinCodeRequest,
  CreateHostJoinCodeResponse,
  CreateMachineRequest,
  CreateTerminalRequest,
  CreateProjectRequest,
  CreateProjectSourceRequest,
  CreateQueuedMessageRequest,
  SubmissionContract,
  SubmissionReceipt,
  SubmitRequest,
  CreateThreadSectionRequest,
  CreateThreadRequest,
  EditMessageRequest,
  EditMessageResponse,
  ForkThreadRequest,
  RestartTerminalRequest,
  DeleteThreadSectionRequest,
  DeleteThreadRequest,
  EnvironmentActionApiError,
  EnvironmentActionRequest,
  EnvironmentActionResponse,
  EnvironmentArchiveThreadsResponse,
  EnvironmentDiffBranchesQuery,
  EnvironmentDiffBranchesResponse,
  EnvironmentDiffFileQuery,
  EnvironmentDiffFileResponse,
  EnvironmentDiffFilesResponse,
  EnvironmentDiffPatchRequest,
  EnvironmentDiffPatchResponse,
  EnvironmentDiffQuery,
  EnvironmentDiffResponse,
  EnvironmentPathsQuery,
  EnvironmentPullRequestResponse,
  EnvironmentStatusQuery,
  EnvironmentStatusResponse,
  HostDirectoryListing,
  HostGetResponse,
  HostDirectoryQuery,
  HostDiscoveredReposResponse,
  HostEnrollmentCommandResponse,
  HostReconnectResponse,
  HostListQuery,
  HostActionResponse,
  HostCloneDefaultPathQuery,
  HostCloneDefaultPathResponse,
  HostFileListRequest,
  HostFileListResponse,
  HostFileReadRequest,
  HostFileReadResponse,
  HostFileWriteRequest,
  HostFileWriteResponse,
  HostMkdirRequest,
  HostMkdirResponse,
  HostMovePathRequest,
  HostMovePathResponse,
  HostPathListRequest,
  HostPathListResponse,
  HostRemovePathRequest,
  HostRemovePathResponse,
  CreateFilePreviewRequest,
  CreateFilePreviewResponse,
  HostPickFolderRequest,
  HostPickFolderResponse,
  HostPathsExistRequest,
  HostPathsExistResponse,
  HostProviderCliInstallEvent,
  HostProviderCliInstallRequest,
  HostProviderCliStatusResponse,
  HostRetryUpdateResponse,
  ProjectAttachmentContentQuery,
  ProjectAttachmentUploadForm,
  ProjectBranchesQuery,
  ProjectBranchesResponse,
  ProjectCommandsQuery,
  ProjectDefaultExecutionOptionsQuery,
  ProjectFilesQuery,
  ProjectListQuery,
  ProjectPathsQuery,
  ProjectResponse,
  ProjectSkillsQuery,
  DeleteSkillRequest,
  SkillListResponse,
  ProjectSkillContentQuery,
  ProjectSkillFilesQuery,
  SkillContentResponse,
  SkillFilesResponse,
  UpdateSkillRequest,
  ProjectWithThreadsResponse,
  PromptHistoryQuery,
  PromptHistoryResponse,
  PromptHistoryListQuery,
  PromptHistoryListResponse,
  ReorderPinnedThreadRequest,
  ReorderShelvedThreadRequest,
  ReorderProjectRequest,
  ReorderQueuedMessageRequest,
  QueuedMessageEditHoldResponse,
  ResolvePendingInteractionRequest,
  ResolveThreadMentionsRequest,
  ResolveThreadMentionsResponse,
  RespondPluginInteractionRequest,
  SendMessageRequest,
  RetryTurnRequest,
  ThreadStartMachineRequest,
  ThreadStartMachineResponse,
  ThreadStartMachinesQuery,
  ThreadStartMachinesResponse,
  ThreadContinueState,
  ThreadContinueResponse,
  ThreadContinuationsResponse,
  ThreadContinueAllResponse,
  RetryTurnResponse,
  SendMessageResponse,
  SetQueuedMessageGroupBoundaryRequest,
  SendQueuedMessageRequest,
  SendQueuedMessageResponse,
  SidebarBootstrapResponse,
  SystemAttentionResponse,
  SystemConfigReloadResponse,
  SystemConfigResponse,
  SystemCliSkillsStatusQuery,
  SystemCliSkillsStatusResponse,
  SystemInstallCliSkillsRequest,
  SystemInstallCliSkillsResponse,
  SystemExecutionOptionsQuery,
  SystemExecutionOptionsResponse,
  SystemEnvironmentProvidersQuery,
  SystemEnvironmentProvidersResponse,
  SystemMachineProvidersResponse,
  SystemProviderInfo,
  SystemProvidersQuery,
  SystemProviderStatesResponse,
  SystemUsageLimitsQuery,
  SystemAppUpdateAcknowledgeRequest,
  SystemAppUpdateApplyRequest,
  SystemAppUpdateQuery,
  SystemAppUpdateStatus,
  SystemVersionQuery,
  SystemVersionResponse,
  SystemVoiceTranscriptionForm,
  SystemVoiceTranscriptionResponse,
  TerminalListResponse,
  ThemeCatalogResponse,
  TerminalSession,
  TerminalInputRequest,
  TerminalListQuery,
  TerminalOutputQuery,
  TerminalOutputResponse,
  TerminalForegroundResponse,
  TerminalResizeRequest,
  ThreadArchiveAllResponse,
  ThreadChildSummaryResponse,
  ThreadEventWaitQuery,
  ThreadEventsQuery,
  CommandProofLookupRequest,
  CommandProofLookupResponse,
  ThreadMessageQuery,
  ThreadMessageResponse,
  ThreadSectionMutationResponse,
  ThreadSectionResponse,
  ThreadGetQuery,
  ThreadCountQuery,
  ThreadCountResponse,
  ThreadListQuery,
  ThreadListResponse,
  ThreadConversationQuery,
  ThreadConversationResponse,
  ThreadConversationOutlineQuery,
  ThreadConversationOutlineResponse,
  ThreadOpenRequest,
  ThreadOpenResponse,
  ThreadPaneActionRequest,
  ThreadPaneActionResponse,
  ThreadPendingInteractionsResponse,
  ThreadRunningResponse,
  QueuedMessageListQuery,
  ThreadQueuedMessageListResponse,
  ThreadResponse,
  PluginThreadMetadataListRequest,
  PluginThreadMetadataListResponse,
  ThreadAncestorsListRequest,
  ThreadAncestorsListResponse,
  ThreadDescendantsListRequest,
  ThreadDescendantsListResponse,
  ThreadPluginMetadataQuery,
  ThreadPluginMetadataResponse,
  ThreadSearchQuery,
  ThreadSearchResponse,
  ThreadHostFileQuery,
  ThreadStorageFileListResponse,
  ThreadStorageFilesQuery,
  ThreadStorageLocationResponse,
  ThreadStoragePathListResponse,
  ThreadStoragePathsQuery,
  ThreadTimelineQuery,
  ThreadTimelineResponse,
  ThreadContextResponse,
  ThreadAutoCompactionSettingResponse,
  UpdateThreadAutoCompactionRequest,
  ThreadWithIncludesResponse,
  TimelineTurnSummaryDetailsQuery,
  TimelineTurnSummaryDetailsResponse,
  CleanupEnvironmentQuery,
  ListEnvironmentsQuery,
  UpdateEnvironmentRequest,
  UpdateThreadSectionRequest,
  UpdateTerminalRequest,
  UpdateHostRequest,
  UpdateHostPermissionCeilingRequest,
  UpdateHostAvailabilityRequest,
  UpdateProjectRequest,
  UpdateProjectSourceRequest,
  UpdateThreadPluginMetadataRequest,
  UpdateThreadRequest,
  UpdateQueuedMessageRequest,
  UploadedPromptAttachment,
  WorkspaceFileListResponse,
  WorkspacePathListResponse,
} from "./api-types.js";
import type {
  ThreadTabsWireResponse,
  UpdateThreadTabsRequest,
} from "./api/thread-tabs.js";
import { updateThreadTabsRequestSchema } from "./api/thread-tabs.js";
import {
  createThreadGroupRequestSchema,
  deleteThreadGroupRequestSchema,
  threadGroupListQuerySchema,
  updateThreadGroupRequestSchema,
  type CreateThreadGroupRequest,
  type CreateThreadGroupResponse,
  type DeleteThreadGroupRequest,
  type ThreadGroupListQuery,
  type ThreadGroupMutationResponse,
  type ThreadGroupResponse,
  type UpdateThreadGroupRequest,
} from "./api/thread-groups.js";
import type {
  PathUiPreferenceKey,
  UiPreferenceResponse,
  UiPreferencesResponse,
  UpdateUiPreferenceRequest,
} from "./api/ui-preferences.js";
import { updateUiPreferenceRequestSchema } from "./api/ui-preferences.js";
import {
  closeTerminalRequestSchema,
  copyProjectAttachmentsRequestSchema,
  retainProjectAttachmentsRequestSchema,
  createFilePreviewRequestSchema,
  createThreadSectionRequestSchema,
  deleteThreadSectionRequestSchema,
  createTerminalRequestSchema,
  restartTerminalRequestSchema,
  createProjectRequestSchema,
  createHostJoinCodeRequestSchema,
  createMachineRequestSchema,
  createProjectSourceRequestSchema,
  createQueuedMessageRequestSchema,
  submitRequestSchema,
  queuedMessageListQuerySchema,
  updateQueuedMessageRequestSchema,
  createThreadRequestSchema,
  forkThreadRequestSchema,
  updateThreadPluginMetadataRequestSchema,
  pluginThreadMetadataListRequestSchema,
  threadAncestorsListRequestSchema,
  threadDescendantsListRequestSchema,
  threadPluginMetadataQuerySchema,
  deleteThreadRequestSchema,
  environmentActionRequestSchema,
  environmentDiffBranchesQuerySchema,
  environmentDiffFileQuerySchema,
  environmentDiffPatchRequestSchema,
  environmentDiffQuerySchema,
  environmentPathsQuerySchema,
  environmentStatusQuerySchema,
  hostDirectoryQuerySchema,
  hostListQuerySchema,
  hostCloneDefaultPathQuerySchema,
  hostFileListRequestSchema,
  hostFileReadRequestSchema,
  hostFileWriteRequestSchema,
  hostMkdirRequestSchema,
  hostMovePathRequestSchema,
  hostPathListRequestSchema,
  hostRemovePathRequestSchema,
  hostPickFolderRequestSchema,
  hostPathsExistRequestSchema,
  hostProviderCliInstallRequestSchema,
  projectAttachmentContentQuerySchema,
  projectBranchesQuerySchema,
  projectCommandsQuerySchema,
  projectDefaultExecutionOptionsQuerySchema,
  projectFilesQuerySchema,
  projectListQuerySchema,
  projectPathsQuerySchema,
  projectSkillsQuerySchema,
  deleteSkillRequestSchema,
  projectSkillContentQuerySchema,
  projectSkillFilesQuerySchema,
  updateSkillRequestSchema,
  promptHistoryQuerySchema,
  promptHistoryListQuerySchema,
  reorderPinnedThreadRequestSchema,
  reorderShelvedThreadRequestSchema,
  reorderProjectRequestSchema,
  reorderQueuedMessageRequestSchema,
  resolvePendingInteractionRequestSchema,
  resolveThreadMentionsRequestSchema,
  respondPluginInteractionRequestSchema,
  retryTurnRequestSchema,
  threadStartMachineRequestSchema,
  threadStartMachinesQuerySchema,
  sendMessageRequestSchema,
  editMessageRequestSchema,
  setQueuedMessageGroupBoundaryRequestSchema,
  sendQueuedMessageRequestSchema,
  systemExecutionOptionsQuerySchema,
  systemEnvironmentProvidersQuerySchema,
  systemProvidersQuerySchema,
  systemUsageLimitsQuerySchema,
  systemVersionQuerySchema,
  systemAppUpdateAcknowledgeRequestSchema,
  systemAppUpdateApplyRequestSchema,
  systemAppUpdateQuerySchema,
  threadEventWaitQuerySchema,
  threadEventsQuerySchema,
  commandProofLookupRequestSchema,
  threadMessageQuerySchema,
  threadGetQuerySchema,
  threadCountQuerySchema,
  threadListQuerySchema,
  threadOpenRequestSchema,
  threadPaneActionRequestSchema,
  threadSearchQuerySchema,
  threadHostFileQuerySchema,
  threadStorageFilesQuerySchema,
  threadStoragePathsQuerySchema,
  terminalInputRequestSchema,
  terminalListQuerySchema,
  terminalOutputQuerySchema,
  terminalResizeRequestSchema,
  threadTimelineQuerySchema,
  updateThreadAutoCompactionRequestSchema,
  systemCliSkillsStatusQuerySchema,
  systemInstallCliSkillsRequestSchema,
  threadConversationQuerySchema,
  threadConversationOutlineQuerySchema,
  timelineTurnSummaryDetailsQuerySchema,
  cleanupEnvironmentQuerySchema,
  listEnvironmentsQuerySchema,
  updateEnvironmentRequestSchema,
  updateHostRequestSchema,
  updateHostPermissionCeilingRequestSchema,
  updateHostAvailabilityRequestSchema,
  updateThreadSectionRequestSchema,
  updateTerminalRequestSchema,
  updateProjectRequestSchema,
  updateProjectSourceRequestSchema,
  updateThreadRequestSchema,
  type UpdateThreadResponse,
} from "./api-types.js";
import {
  serverMoveCheckRequestSchema,
  serverMoveStartRequestSchema,
  type DeleteOldServerCopyResponse,
  type ServerMoveCheckRequest,
  type ServerMoveCheckResponse,
  type ServerMoveStartRequest,
  type ServerMoveStatus,
  type ServerMoveStatusResponse,
} from "./api/server-move.js";
import type { ApiError } from "./errors.js";

type PathThreadAndFailure = { param: { id: string; failureId: string } };

type PathProjectSourceId = { param: { id: string; sourceId: string } };

type PathThreadMessage = { param: { id: string; seq: string } };

type PathThreadInteractionId = {
  param: { id: string; interactionId: string };
};

export const publicApiRoutes = {
  attention: {
    thread: defineRoute({
      path: "/threads/:id/attention",
      method: "get",
      request: noRequest<PathId>(),
      response: jsonResponse<ThreadAttentionSnapshot>(),
    }),
    snapshot: defineRoute({
      path: "/thread-attention",
      method: "get",
      request: noRequest(),
      response: jsonResponse<ThreadAttentionSnapshot>(),
    }),
    command: defineRoute({
      path: "/threads/:id/attention",
      method: "post",
      request: jsonRequest<PathId, AttentionCommand>(attentionCommandSchema),
      response: jsonResponse<ThreadAttentionResult>(),
    }),
    adopt: defineRoute({
      path: "/thread-attention/adopt",
      method: "post",
      request: jsonRequest<EmptyInput, { pluginId: "decisions" | "needs-you" }>(
        z.object({ pluginId: z.enum(["decisions", "needs-you"]) }),
      ),
      response: jsonResponse<{ imported: boolean }>(),
    }),
  },
  promptHistory: {
    list: defineRoute({
      path: "/prompt-history",
      method: "get",
      request: queryRequest<EmptyInput, PromptHistoryListQuery>(
        promptHistoryListQuerySchema,
      ),
      response: jsonResponse<PromptHistoryListResponse>(),
    }),
  },
  projects: {
    machineEnvironment: defineRoute({
      path: "/projects/:id/machine-environment",
      method: "get",
      request: noRequest<PathProjectId>(),
      response: jsonResponse<ProjectMachineEnvironmentList>(),
    }),
    replaceMachineEnvironment: defineRoute({
      path: "/projects/:id/machine-environment",
      method: "put",
      request: jsonRequest<PathProjectId, MachineEnvironmentReplace>(
        machineEnvironmentReplaceSchema,
      ),
      response: jsonResponse<ProjectMachineEnvironmentList>(),
    }),
    setMachineEnvironmentVariable: defineRoute({
      path: "/projects/:id/machine-environment",
      method: "post",
      request: jsonRequest<PathProjectId, MachineEnvironmentSet>(
        machineEnvironmentSetSchema,
      ),
      response: jsonResponse<ProjectMachineEnvironmentList>(),
    }),
    deleteMachineEnvironmentVariable: defineRoute({
      path: "/projects/:id/machine-environment",
      method: "delete",
      request: jsonRequest<PathProjectId, MachineEnvironmentDelete>(
        machineEnvironmentDeleteSchema,
      ),
      response: jsonResponse<ProjectMachineEnvironmentList>(),
    }),

    list: defineRoute({
      path: "/projects",
      method: "get",
      request: optionalQueryRequest<EmptyInput, ProjectListQuery>(
        projectListQuerySchema,
      ),
      response: jsonResponse<
        ProjectResponse[] | ProjectWithThreadsResponse[]
      >(),
    }),
    create: defineRoute({
      path: "/projects",
      method: "post",
      request: jsonRequest<EmptyInput, CreateProjectRequest>(
        createProjectRequestSchema,
      ),
      response: jsonResponse<ProjectResponse>({ status: 201 }),
    }),
    sidebarBootstrap: defineRoute({
      path: "/sidebar-bootstrap",
      method: "get",
      request: noRequest(),
      response: jsonResponse<SidebarBootstrapResponse>(),
    }),
    get: defineRoute({
      path: "/projects/:id",
      method: "get",
      request: noRequest<PathProjectId>(),
      response: jsonResponse<ProjectResponse>(),
    }),
    update: defineRoute({
      path: "/projects/:id",
      method: "patch",
      request: jsonRequest<PathProjectId, UpdateProjectRequest>(
        updateProjectRequestSchema,
      ),
      response: jsonResponse<ProjectResponse>(),
    }),
    delete: defineRoute({
      path: "/projects/:id",
      method: "delete",
      request: noRequest<PathProjectId>(),
      response: jsonResponse<{ ok: true }>(),
    }),
    reorder: defineRoute({
      path: "/projects/:id/order",
      method: "patch",
      request: jsonRequest<PathProjectId, ReorderProjectRequest>(
        reorderProjectRequestSchema,
      ),
      response: jsonResponse<ProjectResponse[]>(),
    }),
    defaultExecutionOptions: defineRoute({
      path: "/projects/:id/default-execution-options",
      method: "get",
      request: queryRequest<PathProjectId, ProjectDefaultExecutionOptionsQuery>(
        projectDefaultExecutionOptionsQuerySchema,
      ),
      response: jsonResponse<ProjectExecutionDefaults | null>(),
    }),
    promptHistory: defineRoute({
      path: "/projects/:id/prompt-history",
      method: "get",
      request: optionalQueryRequest<PathProjectId, PromptHistoryQuery>(
        promptHistoryQuerySchema,
      ),
      response: jsonResponse<PromptHistoryResponse>(),
    }),
    createSource: defineRoute({
      path: "/projects/:id/sources",
      method: "post",
      request: jsonRequest<PathProjectId, CreateProjectSourceRequest>(
        createProjectSourceRequestSchema,
      ),
      response: jsonResponse<ProjectSource>({ status: 201 }),
    }),
    updateSource: defineRoute({
      path: "/projects/:id/sources/:sourceId",
      method: "patch",
      request: jsonRequest<PathProjectSourceId, UpdateProjectSourceRequest>(
        updateProjectSourceRequestSchema,
      ),
      response: jsonResponse<ProjectSource>(),
    }),
    deleteSource: defineRoute({
      path: "/projects/:id/sources/:sourceId",
      method: "delete",
      request: noRequest<PathProjectSourceId>(),
      response: jsonResponse<{ ok: true }>(),
    }),
    files: defineRoute({
      path: "/projects/:id/files",
      method: "get",
      request: queryRequest<PathProjectId, ProjectFilesQuery>(
        projectFilesQuerySchema,
      ),
      response: jsonResponse<WorkspaceFileListResponse>(),
    }),
    file: defineRoute({
      path: "/projects/:id/files/:filePath{.+}",
      method: "get",
      request: noRequest<PathIdAndFilePath>(),
      response: binaryResponse<Uint8Array>(),
    }),
    hostFile: defineRoute({
      path: "/projects/:id/hosts/:hostId/files/:filePath{.+}",
      method: "get",
      request: noRequest<PathIdHostAndFilePath>(),
      response: binaryResponse<Uint8Array>(),
    }),
    paths: defineRoute({
      path: "/projects/:id/paths",
      method: "get",
      request: queryRequest<PathProjectId, ProjectPathsQuery>(
        projectPathsQuerySchema,
      ),
      response: jsonResponse<WorkspacePathListResponse>(),
    }),
    commands: defineRoute({
      path: "/projects/:id/commands",
      method: "get",
      request: queryRequest<PathProjectId, ProjectCommandsQuery>(
        projectCommandsQuerySchema,
      ),
      response: jsonResponse<CommandListResponse>(),
    }),
    commandCatalog: defineRoute({
      path: "/projects/:id/command-catalog",
      method: "get",
      request: queryRequest<PathProjectId, ProjectCommandsQuery>(
        projectCommandsQuerySchema,
      ),
      response: jsonResponse<CommandCatalogResponse>(),
    }),
    skills: defineRoute({
      path: "/projects/:id/skills",
      method: "get",
      request: queryRequest<PathProjectId, ProjectSkillsQuery>(
        projectSkillsQuerySchema,
      ),
      response: jsonResponse<SkillListResponse>(),
    }),
    deleteSkill: defineRoute({
      path: "/projects/:id/skills",
      method: "delete",
      request: jsonRequest<PathProjectId, DeleteSkillRequest>(
        deleteSkillRequestSchema,
      ),
      response: jsonResponse<{ deletedPath: string }>(),
    }),
    skillContent: defineRoute({
      path: "/projects/:id/skills/content",
      method: "get",
      request: queryRequest<PathProjectId, ProjectSkillContentQuery>(
        projectSkillContentQuerySchema,
      ),
      response: jsonResponse<SkillContentResponse>(),
    }),
    skillFiles: defineRoute({
      path: "/projects/:id/skills/files",
      method: "get",
      request: queryRequest<PathProjectId, ProjectSkillFilesQuery>(
        projectSkillFilesQuerySchema,
      ),
      response: jsonResponse<SkillFilesResponse>(),
    }),
    updateSkill: defineRoute({
      path: "/projects/:id/skills/content",
      method: "patch",
      request: jsonRequest<PathProjectId, UpdateSkillRequest>(
        updateSkillRequestSchema,
      ),
      response: jsonResponse<{ filePath: string; revision: string }>(),
    }),
    branches: defineRoute({
      path: "/projects/:id/branches",
      method: "get",
      request: queryRequest<PathProjectId, ProjectBranchesQuery>(
        projectBranchesQuerySchema,
      ),
      response: jsonResponse<ProjectBranchesResponse>(),
    }),
    branchOptions: defineRoute({
      path: "/projects/:id/branch-options",
      method: "get",
      request: queryRequest<PathProjectId, ProjectBranchesQuery>(
        projectBranchesQuerySchema,
      ),
      response: jsonResponse<ProjectBranchesResponse>(),
    }),
    uploadAttachment: defineRoute({
      path: "/projects/:id/attachments",
      method: "post",
      request: formRequest<PathProjectId, ProjectAttachmentUploadForm>(),
      response: jsonResponse<UploadedPromptAttachment>({ status: 201 }),
    }),
    copyAttachments: defineRoute({
      path: "/projects/:id/attachments/copy",
      method: "post",
      request: jsonRequest<PathProjectId, CopyProjectAttachmentsRequest>(
        copyProjectAttachmentsRequestSchema,
      ),
      response: jsonResponse<{ ok: true }>(),
    }),
    retainAttachments: defineRoute({
      path: "/projects/:id/attachments/retain",
      method: "post",
      request: jsonRequest<PathProjectId, RetainProjectAttachmentsRequest>(
        retainProjectAttachmentsRequestSchema,
      ),
      response: jsonResponse<{ ok: true }>(),
    }),
    attachmentContent: defineRoute({
      path: "/projects/:id/attachments/content",
      method: "get",
      request: queryRequest<PathProjectId, ProjectAttachmentContentQuery>(
        projectAttachmentContentQuerySchema,
      ),
      response: binaryResponse<Uint8Array>(),
    }),
  },

  files: {
    read: defineRoute({
      path: "/files/read",
      method: "post",
      request: jsonRequest<EmptyInput, HostFileReadRequest>(
        hostFileReadRequestSchema,
      ),
      response: jsonResponse<HostFileReadResponse>(),
    }),
    write: defineRoute({
      path: "/files/write",
      method: "post",
      request: jsonRequest<EmptyInput, HostFileWriteRequest>(
        hostFileWriteRequestSchema,
      ),
      response: jsonResponse<HostFileWriteResponse>(),
    }),
    list: defineRoute({
      path: "/files/list",
      method: "post",
      request: jsonRequest<EmptyInput, HostFileListRequest>(
        hostFileListRequestSchema,
      ),
      response: jsonResponse<HostFileListResponse>(),
    }),
    listPaths: defineRoute({
      path: "/files/paths",
      method: "post",
      request: jsonRequest<EmptyInput, HostPathListRequest>(
        hostPathListRequestSchema,
      ),
      response: jsonResponse<HostPathListResponse>(),
    }),
    mkdir: defineRoute({
      path: "/files/mkdir",
      method: "post",
      request: jsonRequest<EmptyInput, HostMkdirRequest>(
        hostMkdirRequestSchema,
      ),
      response: jsonResponse<HostMkdirResponse>(),
    }),
    move: defineRoute({
      path: "/files/move",
      method: "post",
      request: jsonRequest<EmptyInput, HostMovePathRequest>(
        hostMovePathRequestSchema,
      ),
      response: jsonResponse<HostMovePathResponse>(),
    }),
    remove: defineRoute({
      path: "/files/remove",
      method: "post",
      request: jsonRequest<EmptyInput, HostRemovePathRequest>(
        hostRemovePathRequestSchema,
      ),
      response: jsonResponse<HostRemovePathResponse>(),
    }),
    createPreview: defineRoute({
      path: "/files/previews",
      method: "post",
      request: jsonRequest<EmptyInput, CreateFilePreviewRequest>(
        createFilePreviewRequestSchema,
      ),
      response: jsonResponse<CreateFilePreviewResponse>(),
    }),
  },

  filePreviews: {
    content: defineRoute({
      path: "/file-previews/:id/:filePath{.+}",
      method: "get",
      request: noRequest<PathIdAndFilePath>(),
      response: binaryResponse<Uint8Array>(),
    }),
  },

  desktopBrowsers: {
    profileRenderer: defineRoute({
      path: "/desktop-browsers/profile-renderer",
      method: "post",
      request: jsonRequest<EmptyInput, ExperimentalDesktopRendererProfileInput>(
        desktopRendererProfileRequestSchema,
      ),
      response: jsonResponse<ExperimentalDesktopRendererProfile>(),
    }),
    listInstances: defineRoute({
      path: "/desktop-browsers/instances",
      method: "post",
      request: jsonRequest<EmptyInput, ExperimentalDesktopBrowserHostRequest>(
        desktopBrowserHostRequestSchema,
      ),
      response: jsonResponse<ExperimentalDesktopBrowserInstances>(),
    }),
    listTabs: defineRoute({
      path: "/desktop-browsers/tabs",
      method: "post",
      request: jsonRequest<EmptyInput, ExperimentalDesktopBrowserScope>(
        desktopBrowserScopeSchema,
      ),
      response: jsonResponse<ExperimentalDesktopBrowserTabs>(),
    }),
    createTab: defineRoute({
      path: "/desktop-browsers/create",
      method: "post",
      request: jsonRequest<EmptyInput, ExperimentalDesktopBrowserCreateInput>(
        desktopBrowserCreateRequestSchema,
      ),
      response: jsonResponse<ExperimentalDesktopBrowserCreated>(),
    }),
    acquireControl: defineRoute({
      path: "/desktop-browsers/acquire",
      method: "post",
      request: jsonRequest<EmptyInput, ExperimentalDesktopBrowserAcquireInput>(
        desktopBrowserAcquireRequestSchema,
      ),
      response: jsonResponse<ExperimentalDesktopBrowserLease>(),
    }),
    openConnection: defineRoute({
      path: "/desktop-browsers/connection",
      method: "post",
      request: jsonRequest<EmptyInput, ExperimentalDesktopBrowserLeaseRequest>(
        desktopBrowserLeaseRequestSchema,
      ),
      response: jsonResponse<ExperimentalDesktopBrowserConnection>(),
    }),
    releaseControl: defineRoute({
      path: "/desktop-browsers/release",
      method: "post",
      request: jsonRequest<EmptyInput, ExperimentalDesktopBrowserLeaseRequest>(
        desktopBrowserLeaseRequestSchema,
      ),
      response: jsonResponse<{ ok: true }>(),
    }),
    closeTab: defineRoute({
      path: "/desktop-browsers/close",
      method: "post",
      request: jsonRequest<EmptyInput, ExperimentalDesktopBrowserTabRequest>(
        desktopBrowserTabRequestSchema,
      ),
      response: jsonResponse<{ ok: true }>(),
    }),
    revealTab: defineRoute({
      path: "/desktop-browsers/reveal",
      method: "post",
      request: jsonRequest<EmptyInput, ExperimentalDesktopBrowserTabRequest>(
        desktopBrowserTabRequestSchema,
      ),
      response: jsonResponse<{ ok: true }>(),
    }),
    captureTab: defineRoute({
      path: "/desktop-browsers/capture",
      method: "post",
      request: jsonRequest<EmptyInput, ExperimentalDesktopBrowserTabRequest>(
        desktopBrowserTabRequestSchema,
      ),
      response: jsonResponse<ExperimentalDesktopBrowserCapture>(),
    }),
    listImportSources: defineRoute({
      path: "/desktop-browsers/import-sources",
      method: "post",
      request: jsonRequest<
        EmptyInput,
        ExperimentalDesktopBrowserInstanceRequest
      >(desktopBrowserInstanceRequestSchema),
      response: jsonResponse<ExperimentalDesktopBrowserImportSources>(),
    }),
    importCookies: defineRoute({
      path: "/desktop-browsers/import-cookies",
      method: "post",
      request: jsonRequest<
        EmptyInput,
        ExperimentalDesktopBrowserImportCookiesInput
      >(desktopBrowserImportCookiesRequestSchema),
      response: jsonResponse<ExperimentalDesktopBrowserImportOutcome>(),
    }),
    cookieSyncStatus: defineRoute({
      path: "/desktop-browsers/cookie-sync-status",
      method: "post",
      request: jsonRequest<
        EmptyInput,
        ExperimentalDesktopBrowserInstanceRequest
      >(desktopBrowserInstanceRequestSchema),
      response: jsonResponse<ExperimentalDesktopBrowserCookieSyncStatus>(),
    }),
    configureCookieSync: defineRoute({
      path: "/desktop-browsers/cookie-sync-configure",
      method: "post",
      request: jsonRequest<
        EmptyInput,
        ExperimentalDesktopBrowserCookieSyncConfigureRequest
      >(desktopBrowserCookieSyncConfigureRequestSchema),
      response: jsonResponse<ExperimentalDesktopBrowserCookieSyncStatus>(),
    }),
    runCookieSync: defineRoute({
      path: "/desktop-browsers/cookie-sync-run",
      method: "post",
      request: jsonRequest<
        EmptyInput,
        ExperimentalDesktopBrowserInstanceRequest
      >(desktopBrowserInstanceRequestSchema),
      response: jsonResponse<ExperimentalDesktopBrowserCookieSyncStatus>(),
    }),
  },

  hosts: {
    convertToDirect: defineRoute({
      path: "/hosts/:id/direct-access",
      method: "post",
      request: noRequest<PathId>(),
      response: jsonResponse<{
        hostId: string;
        providerId: "direct";
        retirementPending: boolean;
      }>(),
    }),
    create: defineRoute({
      path: "/hosts",
      method: "post",
      request: jsonRequest<EmptyInput, CreateMachineRequest>(
        createMachineRequestSchema,
      ),
      response: jsonResponse<Host>({ status: 201 }),
    }),
    createJoinCode: defineRoute({
      path: "/hosts/join-codes",
      method: "post",
      request: jsonRequest<EmptyInput, CreateHostJoinCodeRequest>(
        createHostJoinCodeRequestSchema,
      ),
      response: jsonResponse<CreateHostJoinCodeResponse>({ status: 201 }),
    }),
    list: defineRoute({
      path: "/hosts",
      method: "get",
      request: optionalQueryRequest<EmptyInput, HostListQuery>(
        hostListQuerySchema,
      ),
      response: jsonResponse<Host[]>(),
    }),
    get: defineRoute({
      path: "/hosts/:id",
      method: "get",
      request: noRequest<PathId>(),
      response: jsonResponse<HostGetResponse>(),
    }),
    enrollmentCommand: defineRoute({
      path: "/hosts/:id/enrollment-command",
      method: "get",
      request: noRequest<PathId>(),
      response: jsonResponse<HostEnrollmentCommandResponse>(),
    }),
    reconnect: defineRoute({
      path: "/hosts/:id/reconnect-commands",
      method: "post",
      request: noRequest<PathId>(),
      response: jsonResponse<HostReconnectResponse>({ status: 201 }),
    }),
    update: defineRoute({
      path: "/hosts/:id",
      method: "patch",
      request: jsonRequest<PathId, UpdateHostRequest>(updateHostRequestSchema),
      response: jsonResponse<Host>(),
    }),
    updatePermissionCeiling: defineRoute({
      path: "/hosts/:id/permission-ceiling",
      method: "patch",
      request: jsonRequest<PathId, UpdateHostPermissionCeilingRequest>(
        updateHostPermissionCeilingRequestSchema,
      ),
      response: jsonResponse<Host>(),
    }),
    updateAvailability: defineRoute({
      path: "/hosts/:id/availability",
      method: "patch",
      request: jsonRequest<PathId, UpdateHostAvailabilityRequest>(
        updateHostAvailabilityRequestSchema,
      ),
      response: jsonResponse<Host>(),
    }),
    retryUpdate: defineRoute({
      path: "/hosts/:id/retry-update",
      method: "post",
      request: noRequest<PathId>(),
      response: jsonResponse<HostRetryUpdateResponse>(),
    }),
    reconcile: defineRoute({
      path: "/hosts/:id/reconcile",
      method: "post",
      request: noRequest<PathId>(),
      response: jsonResponse<Host, 202>({ status: 202 }),
    }),
    suspend: defineRoute({
      path: "/hosts/:id/suspend",
      method: "post",
      request: noRequest<PathId>(),
      response: jsonResponse<Host, 202>({ status: 202 }),
    }),
    resume: defineRoute({
      path: "/hosts/:id/resume",
      method: "post",
      request: noRequest<PathId>(),
      response: jsonResponse<Host, 202>({ status: 202 }),
    }),
    retryCleanup: defineRoute({
      path: "/hosts/:id/retry-cleanup",
      method: "post",
      request: noRequest<PathId>(),
      response: jsonResponse<HostActionResponse>(),
    }),
    delete: defineRoute({
      path: "/hosts/:id",
      method: "delete",
      request: noRequest<PathId>(),
      response: jsonResponse<{ ok: true }>(),
    }),
    directory: defineRoute({
      path: "/hosts/:id/directory",
      method: "get",
      request: queryRequest<PathId, HostDirectoryQuery>(
        hostDirectoryQuerySchema,
      ),
      response: jsonResponse<HostDirectoryListing>(),
    }),
    housekeeping: defineRoute({
      path: "/hosts/:id/housekeeping",
      method: "get",
      request: noRequest<PathId>(),
      response: jsonResponse<HostHousekeepingResponse>(),
    }),
    discoveredRepos: defineRoute({
      path: "/hosts/:id/discovered-repos",
      method: "get",
      request: noRequest<PathId>(),
      response: jsonResponse<HostDiscoveredReposResponse>(),
    }),
    file: defineRoute({
      path: "/hosts/:id/files/:filePath{.+}",
      method: "get",
      request: noRequest<PathIdAndFilePath>(),
      response: binaryResponse<Uint8Array>(),
    }),
    cloneDefaultPath: defineRoute({
      path: "/hosts/:id/clone-default-path",
      method: "get",
      request: queryRequest<PathId, HostCloneDefaultPathQuery>(
        hostCloneDefaultPathQuerySchema,
      ),
      response: jsonResponse<HostCloneDefaultPathResponse>(),
    }),
    pathsExist: defineRoute({
      path: "/hosts/:id/paths/exist",
      method: "post",
      request: jsonRequest<PathId, HostPathsExistRequest>(
        hostPathsExistRequestSchema,
      ),
      response: jsonResponse<HostPathsExistResponse>(),
    }),
    pickFolder: defineRoute({
      path: "/hosts/:id/pick-folder",
      method: "post",
      request: jsonRequest<PathId, HostPickFolderRequest>(
        hostPickFolderRequestSchema,
      ),
      response: jsonResponse<HostPickFolderResponse>(),
    }),
    providerCliStatus: defineRoute({
      path: "/hosts/:id/provider-clis/status",
      method: "get",
      request: noRequest<PathId>(),
      response: jsonResponse<HostProviderCliStatusResponse>(),
    }),
    providerCliInstall: defineRoute({
      path: "/hosts/:id/provider-clis/install",
      method: "post",
      request: jsonRequest<PathId, HostProviderCliInstallRequest>(
        hostProviderCliInstallRequestSchema,
      ),
      response: textResponse<HostProviderCliInstallEvent>(),
    }),
    deleteOldServerCopy: defineRoute({
      path: "/hosts/:id/old-server-copy",
      method: "delete",
      request: noRequest<PathId>(),
      response: jsonResponse<DeleteOldServerCopyResponse>(),
    }),
  },
  server: {
    maintenancePrepare: defineRoute({
      path: "/server/maintenance/prepare",
      method: "post",
      request: jsonRequest<EmptyInput, PrepareMaintenance>(
        prepareMaintenanceSchema,
      ),
      response: jsonResponse<MaintenancePrepareResult>(),
    }),
    maintenanceStatus: defineRoute({
      path: "/server/maintenance",
      method: "get",
      request: noRequest(),
      response: jsonResponse<MaintenanceStatus>(),
    }),
    runtimeIdentity: defineRoute({
      path: "/server/runtime",
      method: "get",
      request: noRequest(),
      response: jsonResponse<ServerRuntimeIdentity>(),
    }),
    maintenanceAcquire: defineRoute({
      path: "/server/maintenance/acquire",
      method: "post",
      request: jsonRequest<EmptyInput, AcquireUpdateHold>(
        acquireUpdateHoldSchema,
      ),
      response: jsonResponse<MaintenanceAcquireResult>(),
    }),
    maintenanceRelease: defineRoute({
      path: "/server/maintenance/release",
      method: "post",
      request: jsonRequest<EmptyInput, ReleaseHold>(releaseHoldSchema),
      response: jsonResponse<MaintenanceReleaseResult>(),
    }),
    checkMove: defineRoute({
      path: "/server/move/check",
      method: "post",
      request: jsonRequest<EmptyInput, ServerMoveCheckRequest>(
        serverMoveCheckRequestSchema,
      ),
      response: jsonResponse<ServerMoveCheckResponse>(),
    }),
    startMove: defineRoute({
      path: "/server/move",
      method: "post",
      request: jsonRequest<EmptyInput, ServerMoveStartRequest>(
        serverMoveStartRequestSchema,
      ),
      response: jsonResponse<ServerMoveStatus>(),
    }),
    moveStatus: defineRoute({
      path: "/server/move",
      method: "get",
      request: noRequest(),
      response: jsonResponse<ServerMoveStatusResponse>(),
    }),
    cancelMove: defineRoute({
      path: "/server/move/cancel",
      method: "post",
      request: noRequest(),
      response: jsonResponse<ServerMoveStatus>(),
    }),
    export: defineRoute({
      path: "/server/export",
      method: "post",
      request: noRequest(),
      response: binaryResponse<Uint8Array>(),
    }),
  },

  previews: {
    register: defineRoute({
      path: "/previews",
      method: "post",
      request: jsonRequest<EmptyInput, PreviewRegisterRequest>(
        previewRegisterRequestSchema,
      ),
      response: jsonResponse<PreviewBinding>({ status: 201 }),
    }),
    list: defineRoute({
      path: "/previews",
      method: "get",
      request: queryRequest<EmptyInput, PreviewListQuery>(
        previewListQuerySchema,
      ),
      response: jsonResponse<PreviewListResponse>(),
    }),
    get: defineRoute({
      path: "/previews/:previewId",
      method: "get",
      request: noRequest<{ param: { previewId: string } }>(),
      response: jsonResponse<PreviewBinding>(),
    }),
    status: defineRoute({
      path: "/previews/:previewId/status",
      method: "get",
      request: noRequest<{ param: { previewId: string } }>(),
      response: jsonResponse<PreviewStatus>(),
    }),
    restart: defineRoute({
      path: "/previews/:previewId/restart",
      method: "post",
      request: jsonRequest<
        { param: { previewId: string } },
        PreviewRestartRequest
      >(previewRestartRequestSchema),
      response: jsonResponse<PreviewStatus>(),
    }),
    remove: defineRoute({
      path: "/previews/:previewId",
      method: "delete",
      request: noRequest<{ param: { previewId: string } }>(),
      response: jsonResponse<{ ok: true }>(),
    }),
  },

  terminals: {
    list: defineRoute({
      path: "/terminals",
      method: "get",
      request: queryRequest<EmptyInput, TerminalListQuery>(
        terminalListQuerySchema,
      ),
      response: jsonResponse<TerminalListResponse>(),
    }),
    create: defineRoute({
      path: "/terminals",
      method: "post",
      request: jsonRequest<EmptyInput, CreateTerminalRequest>(
        createTerminalRequestSchema,
      ),
      response: jsonResponse<TerminalSession>({ status: 201 }),
    }),
    get: defineRoute({
      path: "/terminals/:terminalId",
      method: "get",
      request: noRequest<PathTerminal>(),
      response: jsonResponse<TerminalSession>(),
    }),
    update: defineRoute({
      path: "/terminals/:terminalId",
      method: "patch",
      request: jsonRequest<PathTerminal, UpdateTerminalRequest>(
        updateTerminalRequestSchema,
      ),
      response: jsonResponse<TerminalSession>(),
    }),
    restart: defineRoute({
      path: "/terminals/:terminalId/restart",
      method: "post",
      request: jsonRequest<PathTerminal, RestartTerminalRequest>(
        restartTerminalRequestSchema,
      ),
      response: jsonResponse<TerminalSession>({ status: 201 }),
    }),
    close: defineRoute({
      path: "/terminals/:terminalId/close",
      method: "post",
      request: jsonRequest<PathTerminal, CloseTerminalRequest>(
        closeTerminalRequestSchema,
      ),
      response: jsonResponse<TerminalSession>(),
    }),
    input: defineRoute({
      path: "/terminals/:terminalId/input",
      method: "post",
      request: jsonRequest<PathTerminal, TerminalInputRequest>(
        terminalInputRequestSchema,
      ),
      response: jsonResponse<TerminalSession>(),
    }),
    resize: defineRoute({
      path: "/terminals/:terminalId/resize",
      method: "post",
      request: jsonRequest<PathTerminal, TerminalResizeRequest>(
        terminalResizeRequestSchema,
      ),
      response: jsonResponse<TerminalSession>(),
    }),
    foreground: defineRoute({
      path: "/terminals/:terminalId/foreground",
      method: "get",
      request: noRequest<PathTerminal>(),
      response: jsonResponse<TerminalForegroundResponse>(),
    }),
    output: defineRoute({
      path: "/terminals/:terminalId/output",
      method: "get",
      request: optionalQueryRequest<PathTerminal, TerminalOutputQuery>(
        terminalOutputQuerySchema,
      ),
      response: jsonResponse<TerminalOutputResponse>(),
    }),
  },

  environments: {
    cleanup: defineRoute({
      path: "/environments/:id/cleanup",
      method: "post",
      request: optionalQueryRequest<
        PathId,
        CleanupEnvironmentQuery,
        typeof cleanupEnvironmentQuerySchema
      >(cleanupEnvironmentQuerySchema),
      response: jsonResponse<{ ok: true }>(),
    }),
    list: defineRoute({
      path: "/environments",
      method: "get",
      request: optionalQueryRequest<EmptyInput, ListEnvironmentsQuery>(
        listEnvironmentsQuerySchema,
      ),
      response: jsonResponse<Environment[]>(),
    }),
    delete: defineRoute({
      path: "/environments/:id",
      method: "delete",
      request: noRequest<PathId>(),
      response: [
        jsonResponse<{ ok: true }>(),
        jsonResponse<ApiError>({ status: 404 }),
        jsonResponse<ApiError>({ status: 409 }),
      ],
    }),
    get: defineRoute({
      path: "/environments/:id",
      method: "get",
      request: noRequest<PathId>(),
      response: [
        jsonResponse<Environment>(),
        jsonResponse<ApiError>({ status: 404 }),
      ],
    }),
    update: defineRoute({
      path: "/environments/:id",
      method: "patch",
      request: jsonRequest<PathId, UpdateEnvironmentRequest>(
        updateEnvironmentRequestSchema,
      ),
      response: jsonResponse<Environment>(),
    }),
    status: defineRoute({
      path: "/environments/:id/status",
      method: "get",
      request: queryRequest<PathId, EnvironmentStatusQuery>(
        environmentStatusQuerySchema,
      ),
      response: jsonResponse<EnvironmentStatusResponse>(),
    }),
    pullRequest: defineRoute({
      path: "/environments/:id/pull-request",
      method: "get",
      request: noRequest<PathId>(),
      response: jsonResponse<EnvironmentPullRequestResponse>(),
    }),
    diff: defineRoute({
      path: "/environments/:id/diff",
      method: "get",
      request: queryRequest<PathId, EnvironmentDiffQuery>(
        environmentDiffQuerySchema,
      ),
      response: jsonResponse<EnvironmentDiffResponse>(),
    }),
    diffFiles: defineRoute({
      path: "/environments/:id/diff/files",
      method: "get",
      request: queryRequest<PathId, EnvironmentDiffQuery>(
        environmentDiffQuerySchema,
      ),
      response: jsonResponse<EnvironmentDiffFilesResponse>(),
    }),
    diffPatch: defineRoute({
      path: "/environments/:id/diff/patch",
      method: "post",
      request: jsonRequest<PathId, EnvironmentDiffPatchRequest>(
        environmentDiffPatchRequestSchema,
      ),
      response: jsonResponse<EnvironmentDiffPatchResponse>(),
    }),
    diffFile: defineRoute({
      path: "/environments/:id/diff/file",
      method: "get",
      request: queryRequest<PathId, EnvironmentDiffFileQuery>(
        environmentDiffFileQuerySchema,
      ),
      response: jsonResponse<EnvironmentDiffFileResponse>(),
    }),
    diffBranches: defineRoute({
      path: "/environments/:id/diff/branches",
      method: "get",
      request: queryRequest<PathId, EnvironmentDiffBranchesQuery>(
        environmentDiffBranchesQuerySchema,
      ),
      response: jsonResponse<EnvironmentDiffBranchesResponse>(),
    }),
    paths: defineRoute({
      path: "/environments/:id/paths",
      method: "get",
      request: queryRequest<PathId, EnvironmentPathsQuery>(
        environmentPathsQuerySchema,
      ),
      response: jsonResponse<WorkspacePathListResponse>(),
    }),
    file: defineRoute({
      path: "/environments/:id/files/:filePath{.+}",
      method: "get",
      request: noRequest<PathIdAndFilePath>(),
      response: binaryResponse<Uint8Array>(),
    }),
    revisionFile: defineRoute({
      path: "/environments/:id/revisions/:ref/files/:filePath{.+}",
      method: "get",
      request: noRequest<PathIdRefAndFilePath>(),
      response: binaryResponse<Uint8Array>(),
    }),
    actions: defineRoute({
      path: "/environments/:id/actions",
      method: "post",
      request: jsonRequest<PathId, EnvironmentActionRequest>(
        environmentActionRequestSchema,
      ),
      response: [
        jsonResponse<EnvironmentActionResponse>(),
        jsonResponse<EnvironmentActionApiError>({ status: 409 }),
        jsonResponse<ApiError>({ status: 404 }),
      ],
    }),
    archiveThreads: defineRoute({
      path: "/environments/:id/archive-threads",
      method: "post",
      request: noRequest<PathId>(),
      response: jsonResponse<EnvironmentArchiveThreadsResponse>(),
    }),
  },

  threadSections: {
    list: defineRoute({
      path: "/thread-sections",
      method: "get",
      request: noRequest<EmptyInput>(),
      response: jsonResponse<ThreadSectionResponse[]>(),
    }),
    create: defineRoute({
      path: "/thread-sections",
      method: "post",
      request: jsonRequest<EmptyInput, CreateThreadSectionRequest>(
        createThreadSectionRequestSchema,
      ),
      response: [
        jsonResponse<ThreadSectionResponse>({ status: 201 }),
        jsonResponse<ApiError>({ status: 409 }),
      ],
    }),
    update: defineRoute({
      path: "/thread-sections",
      method: "patch",
      request: jsonRequest<EmptyInput, UpdateThreadSectionRequest>(
        updateThreadSectionRequestSchema,
      ),
      response: [
        jsonResponse<ThreadSectionMutationResponse>(),
        jsonResponse<ApiError>({ status: 404 }),
        jsonResponse<ApiError>({ status: 409 }),
      ],
    }),
    delete: defineRoute({
      path: "/thread-sections",
      method: "delete",
      request: jsonRequest<EmptyInput, DeleteThreadSectionRequest>(
        deleteThreadSectionRequestSchema,
      ),
      response: [
        jsonResponse<ThreadSectionMutationResponse>(),
        jsonResponse<ApiError>({ status: 404 }),
      ],
    }),
  },

  threadGroups: {
    list: defineRoute({
      path: "/thread-groups",
      method: "get",
      request: queryRequest<EmptyInput, ThreadGroupListQuery>(
        threadGroupListQuerySchema,
      ),
      response: jsonResponse<ThreadGroupResponse[]>(),
    }),
    create: defineRoute({
      path: "/thread-groups",
      method: "post",
      request: jsonRequest<EmptyInput, CreateThreadGroupRequest>(
        createThreadGroupRequestSchema,
      ),
      response: [
        jsonResponse<CreateThreadGroupResponse>({ status: 201 }),
        jsonResponse<ApiError>({ status: 404 }),
      ],
    }),
    update: defineRoute({
      path: "/thread-groups",
      method: "patch",
      request: jsonRequest<EmptyInput, UpdateThreadGroupRequest>(
        updateThreadGroupRequestSchema,
      ),
      response: [
        jsonResponse<ThreadGroupMutationResponse>(),
        jsonResponse<ApiError>({ status: 404 }),
      ],
    }),
    delete: defineRoute({
      path: "/thread-groups",
      method: "delete",
      request: jsonRequest<EmptyInput, DeleteThreadGroupRequest>(
        deleteThreadGroupRequestSchema,
      ),
      response: [
        jsonResponse<ThreadGroupMutationResponse>(),
        jsonResponse<ApiError>({ status: 404 }),
      ],
    }),
  },

  threads: {
    list: defineRoute({
      path: "/threads",
      method: "get",
      request: optionalQueryRequest<EmptyInput, ThreadListQuery>(
        threadListQuerySchema,
      ),
      response: jsonResponse<ThreadListResponse>(),
    }),

    count: defineRoute({
      path: "/threads/count",
      method: "get",
      request: optionalQueryRequest<EmptyInput, ThreadCountQuery>(
        threadCountQuerySchema,
      ),
      response: jsonResponse<ThreadCountResponse>(),
    }),

    running: defineRoute({
      path: "/threads/running",
      method: "get",
      request: noRequest(),
      response: jsonResponse<ThreadRunningResponse>(),
    }),
    search: defineRoute({
      path: "/threads/search",
      method: "get",
      request: queryRequest<EmptyInput, ThreadSearchQuery>(
        threadSearchQuerySchema,
      ),
      response: jsonResponse<ThreadSearchResponse>(),
    }),
    resolveMentions: defineRoute({
      path: "/threads/resolve-mentions",
      method: "post",
      request: jsonRequest<EmptyInput, ResolveThreadMentionsRequest>(
        resolveThreadMentionsRequestSchema,
      ),
      response: jsonResponse<ResolveThreadMentionsResponse>(),
    }),
    create: defineRoute({
      path: "/threads",
      method: "post",
      request: jsonRequest<EmptyInput, CreateThreadRequest>(
        createThreadRequestSchema,
      ),
      response: jsonResponse<ThreadResponse>({ status: 201 }),
    }),
    fork: defineRoute({
      path: "/threads/fork",
      method: "post",
      request: jsonRequest<EmptyInput, ForkThreadRequest>(
        forkThreadRequestSchema,
      ),
      response: jsonResponse<ThreadResponse>({ status: 201 }),
    }),
    importNative: defineRoute({
      path: "/threads/import",
      method: "post",
      request: jsonRequest<EmptyInput, ImportNativeThreadRequest>(
        importNativeThreadRequestSchema,
      ),
      response: [
        jsonResponse<ImportNativeThreadImportedResponse>({ status: 201 }),
        jsonResponse<ImportNativeThreadAlreadyClaimedResponse>(),
      ],
    }),
    nativeSessions: defineRoute({
      path: "/threads/native-sessions",
      method: "get",
      request: queryRequest<EmptyInput, NativeSessionClaimsQuery>(
        nativeSessionClaimsQuerySchema,
      ),
      response: jsonResponse<NativeSessionClaimsResponse>(),
    }),
    get: defineRoute({
      path: "/threads/:id",
      method: "get",
      request: optionalQueryRequest<PathId, ThreadGetQuery>(
        threadGetQuerySchema,
      ),
      response: jsonResponse<ThreadResponse | ThreadWithIncludesResponse>(),
    }),
    update: defineRoute({
      path: "/threads/:id",
      method: "patch",
      request: jsonRequest<PathId, UpdateThreadRequest>(
        updateThreadRequestSchema,
      ),
      response: jsonResponse<UpdateThreadResponse>(),
    }),

    ancestors: defineRoute({
      path: "/threads/ancestors",
      method: "post",
      request: jsonRequest<EmptyInput, ThreadAncestorsListRequest>(
        threadAncestorsListRequestSchema,
      ),
      response: jsonResponse<ThreadAncestorsListResponse>(),
    }),

    descendants: defineRoute({
      path: "/threads/descendants",
      method: "post",
      request: jsonRequest<EmptyInput, ThreadDescendantsListRequest>(
        threadDescendantsListRequestSchema,
      ),
      response: jsonResponse<ThreadDescendantsListResponse>(),
    }),
    work: defineRoute({
      path: "/threads/:id/work",
      method: "get",
      request: noRequest<PathId>(),
      response: jsonResponse<ThreadWorkSummary>(),
    }),
    publishWork: defineRoute({
      path: "/threads/:id/work",
      method: "post",
      request: jsonRequest<PathId, PublishThreadWork>(publishThreadWorkSchema),
      response: jsonResponse<ThreadWorkSummary>(),
    }),
    archiveReady: defineRoute({
      path: "/threads/:id/archive-ready",
      method: "post",
      request: jsonRequest<PathId, ArchiveReadyThreadRequest>(
        archiveReadyThreadRequestSchema,
      ),
      response: jsonResponse<ThreadArchiveAllResponse>(),
    }),
    pluginMetadata: {
      list: defineRoute({
        path: "/threads/plugin-metadata",
        method: "post",
        request: jsonRequest<EmptyInput, PluginThreadMetadataListRequest>(
          pluginThreadMetadataListRequestSchema,
        ),
        response: jsonResponse<PluginThreadMetadataListResponse>(),
      }),
      get: defineRoute({
        path: "/threads/:id/plugin-metadata",
        method: "get",
        request: queryRequest<PathId, ThreadPluginMetadataQuery>(
          threadPluginMetadataQuerySchema,
        ),
        response: jsonResponse<ThreadPluginMetadataResponse>(),
      }),
      update: defineRoute({
        path: "/threads/:id/plugin-metadata",
        method: "patch",
        request: jsonRequest<PathId, UpdateThreadPluginMetadataRequest>(
          updateThreadPluginMetadataRequestSchema,
        ),
        response: jsonResponse<ThreadPluginMetadataResponse>(),
      }),
    },
    delete: defineRoute({
      path: "/threads/:id",
      method: "delete",
      request: jsonRequest<PathId, DeleteThreadRequest>(
        deleteThreadRequestSchema,
      ),
      response: jsonResponse<{ ok: true }>(),
    }),
    childSummary: defineRoute({
      path: "/threads/:id/child-summary",
      method: "get",
      request: noRequest<PathId>(),
      response: jsonResponse<ThreadChildSummaryResponse>(),
    }),
    send: defineRoute({
      path: "/threads/:id/send",
      method: "post",
      request: jsonRequest<PathId, SendMessageRequest>(
        sendMessageRequestSchema,
      ),
      response: jsonResponse<SendMessageResponse>(),
    }),
    editMessage: defineRoute({
      path: "/threads/:id/edit-message",
      method: "post",
      request: jsonRequest<PathId, EditMessageRequest>(
        editMessageRequestSchema,
      ),
      response: jsonResponse<EditMessageResponse>(),
    }),

    retry: defineRoute({
      path: "/threads/:id/retry",
      method: "post",
      request: jsonRequest<PathId, RetryTurnRequest>(retryTurnRequestSchema),
      response: jsonResponse<RetryTurnResponse>(),
    }),
    continuationState: defineRoute({
      path: "/threads/:id/continue",
      method: "get",
      request: noRequest<PathId>(),
      response: jsonResponse<ThreadContinueState>(),
    }),
    continue: defineRoute({
      path: "/threads/:id/continue",
      method: "post",
      request: optionalQueryRequest<PathId, ThreadContinueQuery>(
        threadContinueQuerySchema,
      ),
      response: jsonResponse<ThreadContinueResponse>(),
    }),
    continuations: defineRoute({
      path: "/threads/continuations/eligible",
      method: "get",
      request: noRequest(),
      response: jsonResponse<ThreadContinuationsResponse>(),
    }),
    continueAll: defineRoute({
      path: "/threads/continue-all",
      method: "post",
      request: noRequest(),
      response: jsonResponse<ThreadContinueAllResponse>(),
    }),
    queuedMessages: defineRoute({
      path: "/threads/:id/queued-messages",
      method: "get",
      request: noRequest<PathId>(),
      response: jsonResponse<ThreadQueuedMessageListResponse>(),
    }),

    submissionContract: defineRoute({
      path: "/submissions/contract",
      method: "get",
      request: noRequest(),
      response: jsonResponse<SubmissionContract>(),
    }),
    submit: defineRoute({
      path: "/submissions",
      method: "post",
      request: jsonRequest<EmptyInput, SubmitRequest>(submitRequestSchema),
      response: jsonResponse<SubmissionReceipt>(),
    }),
    createQueuedMessage: defineRoute({
      path: "/threads/:id/queued-messages",
      method: "post",
      request: jsonRequest<PathId, CreateQueuedMessageRequest>(
        createQueuedMessageRequestSchema,
      ),
      response: jsonResponse<ThreadQueuedMessage>({ status: 201 }),
    }),
    updateQueuedMessage: defineRoute({
      path: "/threads/:id/queued-messages/:queuedMessageId",
      method: "patch",
      request: jsonRequest<
        PathThreadAndQueuedMessage,
        UpdateQueuedMessageRequest
      >(updateQueuedMessageRequestSchema),
      response: jsonResponse<ThreadQueuedMessage>(),
    }),
    sendQueuedMessage: defineRoute({
      path: "/threads/:id/queued-messages/:queuedMessageId/send",
      method: "post",
      request: jsonRequest<
        PathThreadAndQueuedMessage,
        SendQueuedMessageRequest
      >(sendQueuedMessageRequestSchema),
      response: jsonResponse<SendQueuedMessageResponse>(),
    }),

    holdQueuedMessageForEdit: defineRoute({
      path: "/threads/:id/queued-messages/:queuedMessageId/edit-hold",
      method: "post",
      request: noRequest<PathThreadAndQueuedMessage>(),
      response: jsonResponse<QueuedMessageEditHoldResponse>(),
    }),

    releaseQueuedMessageEditHold: defineRoute({
      path: "/threads/:id/queued-messages/:queuedMessageId/edit-hold",
      method: "delete",
      request: noRequest<PathThreadAndQueuedMessage>(),
      response: jsonResponse<{ ok: true }>(),
    }),
    reorderQueuedMessage: defineRoute({
      path: "/threads/:id/queued-messages/:queuedMessageId/order",
      method: "patch",
      request: jsonRequest<
        PathThreadAndQueuedMessage,
        ReorderQueuedMessageRequest
      >(reorderQueuedMessageRequestSchema),
      response: jsonResponse<ThreadQueuedMessageListResponse>(),
    }),
    setQueuedMessageGroupBoundary: defineRoute({
      path: "/threads/:id/queued-messages/group-boundary",
      method: "patch",
      request: jsonRequest<PathId, SetQueuedMessageGroupBoundaryRequest>(
        setQueuedMessageGroupBoundaryRequestSchema,
      ),
      response: jsonResponse<ThreadQueuedMessageListResponse>(),
    }),
    promptHistory: defineRoute({
      path: "/threads/:id/prompt-history",
      method: "get",
      request: optionalQueryRequest<PathId, PromptHistoryQuery>(
        promptHistoryQuerySchema,
      ),
      response: jsonResponse<PromptHistoryResponse>(),
    }),
    deleteQueuedMessage: defineRoute({
      path: "/threads/:id/queued-messages/:queuedMessageId",
      method: "delete",
      request: noRequest<PathThreadAndQueuedMessage>(),
      response: jsonResponse<{ ok: true }>(),
    }),
    restoreQueuedMessage: defineRoute({
      path: "/threads/:id/queued-messages/:queuedMessageId/restore",
      method: "post",
      request: noRequest<PathThreadAndQueuedMessage>(),
      response: jsonResponse<ThreadQueuedMessage>(),
    }),
    stop: defineRoute({
      path: "/threads/:id/stop",
      method: "post",
      request: noRequest<PathId>(),
      response: jsonResponse<{ ok: true }>(),
    }),
    compact: defineRoute({
      path: "/threads/:id/compact",
      method: "post",
      request: noRequest<PathId>(),
      response: jsonResponse<{ ok: true }>(),
    }),
    clearContext: defineRoute({
      path: "/threads/:id/context/clear",
      method: "post",
      request: noRequest<PathId>(),
      response: jsonResponse<{ ok: true }>(),
    }),
    updateAutoCompaction: defineRoute({
      path: "/threads/:id/auto-compaction",
      method: "put",
      request: jsonRequest<PathId, UpdateThreadAutoCompactionRequest>(
        updateThreadAutoCompactionRequestSchema,
      ),
      response: jsonResponse<ThreadAutoCompactionSettingResponse>(),
    }),
    cancelPlan: defineRoute({
      path: "/threads/:id/plan/cancel",
      method: "post",
      request: noRequest<PathId>(),
      response: jsonResponse<{ ok: true }>(),
    }),
    clearGoal: defineRoute({
      path: "/threads/:id/goal/clear",
      method: "post",
      request: noRequest<PathId>(),
      response: jsonResponse<{ ok: true }>(),
    }),
    open: defineRoute({
      path: "/threads/:id/open",
      method: "post",
      request: jsonRequest<PathId, ThreadOpenRequest>(threadOpenRequestSchema),
      response: jsonResponse<ThreadOpenResponse>(),
    }),
    paneAction: defineRoute({
      path: "/threads/:id/pane-action",
      method: "post",
      request: jsonRequest<PathId, ThreadPaneActionRequest>(
        threadPaneActionRequestSchema,
      ),
      response: jsonResponse<ThreadPaneActionResponse>(),
    }),
    tabs: defineRoute({
      path: "/threads/:id/tabs",
      method: "get",
      request: noRequest<PathId>(),
      response: jsonResponse<ThreadTabsWireResponse>(),
    }),
    updateTabs: defineRoute({
      path: "/threads/:id/tabs",
      method: "put",
      request: jsonRequest<PathId, UpdateThreadTabsRequest>(
        updateThreadTabsRequestSchema,
      ),
      response: [
        jsonResponse<ThreadTabsWireResponse>(),
        jsonResponse<ApiError>({ status: 409 }),
      ],
    }),
    pin: defineRoute({
      path: "/threads/:id/pin",
      method: "post",
      request: noRequest<PathId>(),
      response: jsonResponse<ThreadResponse>(),
    }),
    unpin: defineRoute({
      path: "/threads/:id/unpin",
      method: "post",
      request: noRequest<PathId>(),
      response: jsonResponse<ThreadResponse>(),
    }),
    pinOrder: defineRoute({
      path: "/threads/:id/pin-order",
      method: "patch",
      request: jsonRequest<PathId, ReorderPinnedThreadRequest>(
        reorderPinnedThreadRequestSchema,
      ),
      response: jsonResponse<ThreadListResponse>(),
    }),
    shelve: defineRoute({
      path: "/threads/:id/shelve",
      method: "post",
      request: noRequest<PathId>(),
      response: jsonResponse<ThreadResponse>(),
    }),
    shelfOrder: defineRoute({
      path: "/threads/:id/shelf-order",
      method: "patch",
      request: jsonRequest<PathId, ReorderShelvedThreadRequest>(
        reorderShelvedThreadRequestSchema,
      ),
      response: jsonResponse<ThreadListResponse>(),
    }),
    unshelve: defineRoute({
      path: "/threads/:id/unshelve",
      method: "post",
      request: noRequest<PathId>(),
      response: jsonResponse<ThreadResponse>(),
    }),
    interactions: defineRoute({
      path: "/threads/:id/interactions",
      method: "get",
      request: noRequest<PathId>(),
      response: jsonResponse<ThreadPendingInteractionsResponse>(),
    }),
    interaction: defineRoute({
      path: "/threads/:id/interactions/:interactionId",
      method: "get",
      request: noRequest<PathThreadInteractionId>(),
      response: jsonResponse<PendingInteraction>(),
    }),
    resolveInteraction: defineRoute({
      path: "/threads/:id/interactions/:interactionId/resolve",
      method: "post",
      request: jsonRequest<
        PathThreadInteractionId,
        ResolvePendingInteractionRequest
      >(resolvePendingInteractionRequestSchema),
      response: jsonResponse<PendingInteraction>(),
    }),
    respondToInteraction: defineRoute({
      path: "/threads/:id/interactions/:interactionId/respond",
      method: "post",
      request: jsonRequest<
        PathThreadInteractionId,
        RespondPluginInteractionRequest
      >(respondPluginInteractionRequestSchema),
      response: jsonResponse<PendingInteraction>(),
    }),
    cancelInteraction: defineRoute({
      path: "/threads/:id/interactions/:interactionId/cancel",
      method: "post",
      request: noRequest<PathThreadInteractionId>(),
      response: jsonResponse<PendingInteraction>(),
    }),
    archiveAll: defineRoute({
      path: "/threads/:id/archive-all",
      method: "post",
      request: noRequest<PathId>(),
      response: jsonResponse<ThreadArchiveAllResponse>(),
    }),
    unarchive: defineRoute({
      path: "/threads/:id/unarchive",
      method: "post",
      request: noRequest<PathId>(),
      response: jsonResponse<{ ok: true }>(),
    }),

    restoreEnvironment: defineRoute({
      path: "/threads/:id/restore-environment",
      method: "post",
      request: noRequest<PathId>(),
      response: jsonResponse<ThreadResponse>(),
    }),
    startMachines: defineRoute({
      path: "/threads/:id/start-machines",
      method: "get",
      request: queryRequest<PathId, ThreadStartMachinesQuery>(
        threadStartMachinesQuerySchema,
      ),
      response: jsonResponse<ThreadStartMachinesResponse>(),
    }),
    startMachine: defineRoute({
      path: "/threads/:id/start-machine",
      method: "post",
      request: jsonRequest<PathId, ThreadStartMachineRequest>(
        threadStartMachineRequestSchema,
      ),
      response: jsonResponse<ThreadStartMachineResponse>(),
    }),
    read: defineRoute({
      path: "/threads/:id/read",
      method: "post",
      request: noRequest<PathId>(),
      response: jsonResponse<ThreadResponse>(),
    }),
    unread: defineRoute({
      path: "/threads/:id/unread",
      method: "post",
      request: noRequest<PathId>(),
      response: jsonResponse<ThreadResponse>(),
    }),
    timeline: defineRoute({
      path: "/threads/:id/timeline",
      method: "get",
      request: optionalQueryRequest<PathId, ThreadTimelineQuery>(
        threadTimelineQuerySchema,
      ),
      response: jsonResponse<ThreadTimelineResponse>(),
    }),
    context: defineRoute({
      path: "/threads/:id/context",
      method: "get",
      request: noRequest<PathId>(),
      response: jsonResponse<ThreadContextResponse>(),
    }),
    conversation: defineRoute({
      path: "/threads/:id/conversation",
      method: "get",
      request: optionalQueryRequest<PathId, ThreadConversationQuery>(
        threadConversationQuerySchema,
      ),
      response: jsonResponse<ThreadConversationResponse>(),
    }),
    conversationOutline: defineRoute({
      path: "/threads/:id/conversation-outline",
      method: "get",
      request: queryRequest<PathId, ThreadConversationOutlineQuery>(
        threadConversationOutlineQuerySchema,
      ),
      response: jsonResponse<ThreadConversationOutlineResponse>(),
    }),
    timelineTurnSummaryDetails: defineRoute({
      path: "/threads/:id/timeline/turn-summary-details",
      method: "get",
      request: queryRequest<PathId, TimelineTurnSummaryDetailsQuery>(
        timelineTurnSummaryDetailsQuerySchema,
      ),
      response: jsonResponse<TimelineTurnSummaryDetailsResponse>(),
    }),
    output: defineRoute({
      path: "/threads/:id/output",
      method: "get",
      request: noRequest<PathId>(),
      response: jsonResponse<{ output: string | null }>(),
    }),
    commandProofs: defineRoute({
      path: "/threads/:id/command-proofs",
      method: "post",
      request: jsonRequest<PathId, CommandProofLookupRequest>(
        commandProofLookupRequestSchema,
      ),
      response: jsonResponse<CommandProofLookupResponse>(),
    }),
    events: defineRoute({
      path: "/threads/:id/events",
      method: "get",
      request: optionalQueryRequest<PathId, ThreadEventsQuery>(
        threadEventsQuerySchema,
      ),
      response: jsonResponse<ThreadEventRow[]>(),
    }),
    message: defineRoute({
      path: "/threads/:id/messages/:seq",
      method: "get",
      request: optionalQueryRequest<PathThreadMessage, ThreadMessageQuery>(
        threadMessageQuerySchema,
      ),
      response: jsonResponse<ThreadMessageResponse>(),
    }),
    eventWait: defineRoute({
      path: "/threads/:id/events/wait",
      method: "get",
      request: queryRequest<PathId, ThreadEventWaitQuery>(
        threadEventWaitQuerySchema,
      ),
      response: jsonResponse<ThreadEventRow | null>(),
    }),
    defaultExecutionOptions: defineRoute({
      path: "/threads/:id/default-execution-options",
      method: "get",
      request: noRequest<PathId>(),
      response: jsonResponse<ResolvedThreadExecutionOptions | null>(),
    }),
    storageFiles: defineRoute({
      path: "/threads/:id/thread-storage/files",
      method: "get",
      request: optionalQueryRequest<PathId, ThreadStorageFilesQuery>(
        threadStorageFilesQuerySchema,
      ),
      response: jsonResponse<ThreadStorageFileListResponse>(),
    }),
    storageLocation: defineRoute({
      path: "/threads/:id/thread-storage/location",
      method: "get",
      request: noRequest<PathId>(),
      response: jsonResponse<ThreadStorageLocationResponse>(),
    }),
    storageFile: defineRoute({
      path: "/threads/:id/thread-storage/files/:filePath{.+}",
      method: "get",
      request: noRequest<PathIdAndFilePath>(),
      response: binaryResponse<Uint8Array>(),
    }),
    hostFile: defineRoute({
      path: "/threads/:id/host-files/:filePath{.+}",
      method: "get",
      request: optionalQueryRequest<PathIdAndFilePath, ThreadHostFileQuery>(
        threadHostFileQuerySchema,
      ),
      response: binaryResponse<Uint8Array>(),
    }),
    storagePaths: defineRoute({
      path: "/threads/:id/thread-storage/paths",
      method: "get",
      request: queryRequest<PathId, ThreadStoragePathsQuery>(
        threadStoragePathsQuerySchema,
      ),
      response: jsonResponse<ThreadStoragePathListResponse>(),
    }),
  },

  inbox: {
    snapshot: defineRoute({
      path: "/inbox",
      method: "get",
      request: noRequest<EmptyInput>(),
      response: jsonResponse<InboxSnapshot>(),
    }),
    act: defineRoute({
      path: "/inbox/act",
      method: "post",
      request: jsonRequest<EmptyInput, InboxActRequest>(inboxActRequestSchema),
      response: jsonResponse<InboxActResult>(),
    }),
    pendingEvents: defineRoute({
      path: "/inbox/events",
      method: "get",
      request: queryRequest<EmptyInput, InboxPendingEventsQuery>(
        inboxPendingEventsQuerySchema,
      ),
      response: jsonResponse<InboxPendingEventsResponse>(),
    }),
    reportEvent: defineRoute({
      path: "/inbox/events",
      method: "post",
      request: jsonRequest<EmptyInput, InboxEventReportRequest>(
        inboxEventReportRequestSchema,
      ),
      response: jsonResponse<InboxEventReportResponse>(),
    }),
    eventSources: defineRoute({
      path: "/inbox/events/sources",
      method: "get",
      request: noRequest<EmptyInput>(),
      response: jsonResponse<InboxEventSourcesResponse>(),
    }),
    checkEvent: defineRoute({
      path: "/inbox/events/check",
      method: "post",
      request: jsonRequest<EmptyInput, InboxEventCheckRequest>(
        inboxEventCheckRequestSchema,
      ),
      response: jsonResponse<InboxEventCheckResponse>(),
    }),
    undo: defineRoute({
      path: "/inbox/undo",
      method: "post",
      request: jsonRequest<EmptyInput, InboxUndoRequest>(
        inboxUndoRequestSchema,
      ),
      response: jsonResponse<InboxActResult>(),
    }),
    failures: defineRoute({
      path: "/threads/:id/failures",
      method: "get",
      request: noRequest<PathId>(),
      response: jsonResponse<InboxFailureListResponse>(),
    }),
    acknowledgeFailure: defineRoute({
      path: "/threads/:id/failures/:failureId/acknowledge",
      method: "post",
      request: jsonRequest<
        PathThreadAndFailure,
        InboxFailureAcknowledgeRequest
      >(inboxFailureAcknowledgeRequestSchema),
      response: jsonResponse<InboxFailureAcknowledgeResponse>(),
    }),
    waits: defineRoute({
      path: "/threads/:id/waits",
      method: "get",
      request: noRequest<PathId>(),
      response: jsonResponse<InboxWaitListResponse>(),
    }),
    registerWait: defineRoute({
      path: "/threads/:id/waits",
      method: "post",
      request: jsonRequest<PathId, InboxWaitRegisterRequest>(
        inboxWaitRegisterRequestSchema,
      ),
      response: jsonResponse<InboxWaitRegisterResponse>(),
    }),
    rearmWait: defineRoute({
      path: "/threads/:id/waits/:waitId/rearm",
      method: "post",
      request: noRequest<PathThreadAndWait>(),
      response: jsonResponse<InboxWaitActionResponse>(),
    }),
    metWait: defineRoute({
      path: "/threads/:id/waits/:waitId/met",
      method: "post",
      request: jsonRequest<PathThreadAndWait, InboxWaitMetRequest>(
        inboxWaitMetRequestSchema,
      ),
      response: jsonResponse<InboxWaitActionResponse>(),
    }),
    doneWait: defineRoute({
      path: "/threads/:id/waits/:waitId/done",
      method: "post",
      request: noRequest<PathThreadAndWait>(),
      response: jsonResponse<InboxWaitActionResponse>(),
    }),
    cancelWait: defineRoute({
      path: "/threads/:id/waits/:waitId/cancel",
      method: "post",
      request: noRequest<PathThreadAndWait>(),
      response: jsonResponse<InboxWaitActionResponse>(),
    }),
    wait: defineRoute({
      path: "/threads/:id/waits/:waitId",
      method: "get",
      request: noRequest<PathThreadAndWait>(),
      response: jsonResponse<InboxWaitDetailResponse>(),
    }),
    startProducer: defineRoute({
      path: "/threads/:id/producers",
      method: "post",
      request: jsonRequest<PathId, InboxProducerStartRequest>(
        inboxProducerStartRequestSchema,
      ),
      response: jsonResponse<InboxProducerResponse>(),
    }),
    declineRetry: defineRoute({
      path: "/threads/:id/retry/decline",
      method: "post",
      request: jsonRequest<PathId, InboxRetryDeclineRequest>(
        inboxRetryDeclineRequestSchema,
      ),
      response: jsonResponse<InboxRetryDeclineResponse>(),
    }),
    settleProducer: defineRoute({
      path: "/threads/:id/producers/:producerId/settle",
      method: "post",
      request: jsonRequest<PathThreadAndProducer, InboxProducerSettleRequest>(
        inboxProducerSettleRequestSchema,
      ),
      response: jsonResponse<InboxProducerResponse>(),
    }),
  },

  queue: {
    list: defineRoute({
      path: "/queued-messages",
      method: "get",
      request: optionalQueryRequest<EmptyInput, QueuedMessageListQuery>(
        queuedMessageListQuerySchema,
      ),
      response: jsonResponse<ThreadQueuedMessageListResponse>(),
    }),
  },

  system: {
    setMachineEnvironmentVariable: defineRoute({
      path: "/settings/machine-environment",
      method: "post",
      request: jsonRequest<EmptyInput, MachineEnvironmentSet>(
        machineEnvironmentSetSchema,
      ),
      response: jsonResponse<MachineEnvironmentList>(),
    }),
    deleteMachineEnvironmentVariable: defineRoute({
      path: "/settings/machine-environment",
      method: "delete",
      request: jsonRequest<EmptyInput, MachineEnvironmentDelete>(
        machineEnvironmentDeleteSchema,
      ),
      response: jsonResponse<MachineEnvironmentList>(),
    }),

    machineEnvironment: defineRoute({
      path: "/settings/machine-environment",
      method: "get",
      request: noRequest(),
      response: jsonResponse<MachineEnvironmentList>(),
    }),
    replaceMachineEnvironment: defineRoute({
      path: "/settings/machine-environment",
      method: "put",
      request: jsonRequest<EmptyInput, MachineEnvironmentReplace>(
        machineEnvironmentReplaceSchema,
      ),
      response: jsonResponse<MachineEnvironmentList>(),
    }),
    attention: defineRoute({
      path: "/system/attention",
      method: "get",
      request: noRequest(),
      response: jsonResponse<SystemAttentionResponse>(),
    }),
    boot: defineRoute({
      path: "/boot",
      method: "get",
      request: optionalQueryRequest<EmptyInput, BootQuery>(bootQuerySchema),
      response: jsonResponse<BootResponse>(),
    }),
    webAssets: defineRoute({
      path: "/system/web-assets",
      method: "get",
      request: noRequest(),
      response: jsonResponse<WebAssetManifest>(),
    }),
    config: defineRoute({
      path: "/system/config",
      method: "get",
      request: noRequest(),
      response: jsonResponse<SystemConfigResponse>(),
    }),
    aiServices: defineRoute({
      path: "/system/ai-services",
      method: "get",
      request: noRequest(),
      response: jsonResponse<SystemAiServicesResponse>(),
    }),
    setAiServiceSelection: defineRoute({
      path: "/system/ai-services/selection",
      method: "put",
      request: jsonRequest<EmptyInput, SetAiServiceSelectionRequest>(
        setAiServiceSelectionRequestSchema,
      ),
      response: jsonResponse<SystemAiServicesResponse>(),
    }),
    testAiService: defineRoute({
      path: "/system/ai-services/test",
      method: "post",
      request: jsonRequest<EmptyInput, TestAiServiceRequest>(
        testAiServiceRequestSchema,
      ),
      response: jsonResponse<TestAiServiceResponse>(),
    }),
    usageStatus: defineRoute({
      path: "/system/usage",
      method: "get",
      request: noRequest(),
      response: jsonResponse<UsageStatus>(),
    }),
    usageConsent: defineRoute({
      path: "/system/usage/consent",
      method: "post",
      request: jsonRequest<EmptyInput, UsageConsentRequest>(
        usageConsentRequestSchema,
      ),
      response: jsonResponse<UsageConsentResponse>(),
    }),
    usageErase: defineRoute({
      path: "/system/usage/erase",
      method: "post",
      request: jsonRequest<EmptyInput, { proof: string }>(
        productUsageErasureSchema,
      ),
      response: jsonResponse<UsageStatus>(),
    }),
    usagePreview: defineRoute({
      path: "/system/usage/preview",
      method: "get",
      request: noRequest(),
      response: jsonResponse<UsagePreview>(),
    }),
    recordTelemetryEvent: defineRoute({
      path: "/system/telemetry/events",
      method: "post",
      request: jsonRequest<EmptyInput, RecordTelemetryEventRequest>(
        recordTelemetryEventRequestSchema,
      ),
      response: jsonResponse<{ ok: true }>(),
    }),
    reportBug: defineRoute({
      path: "/system/bug-reports",
      method: "post",
      request: jsonRequest<EmptyInput, BugReportRequest>(
        bugReportRequestSchema,
      ),
      response: jsonResponse<BugReportResponse>(),
    }),
    generalSettings: defineRoute({
      path: "/settings/general",
      method: "put",
      request: jsonRequest<EmptyInput, AppSettingsUpdate>(
        appSettingsUpdateSchema,
      ),
      response: jsonResponse<
        AppSettings & { showUnhandledProviderEvents?: boolean }
      >(),
    }),
    keyboardSettings: defineRoute({
      path: "/settings/keyboard",
      method: "put",
      request: jsonRequest<EmptyInput, AppKeybindingOverrides>(
        appKeybindingOverridesSchema,
      ),
      response: jsonResponse<AppKeybindingOverrides>(),
    }),
    experiments: defineRoute({
      path: "/settings/experiments",
      method: "put",
      request: jsonRequest<EmptyInput, ExperimentUpdates>(
        experimentUpdatesSchema,
      ),
      response: jsonResponse<Experiments>(),
    }),
    appearance: defineRoute({
      path: "/settings/appearance",
      method: "put",
      request: jsonRequest<EmptyInput, AppThemeSelection>(
        appThemeSelectionSchema,
      ),
      response: jsonResponse<AppTheme>(),
    }),
    uiPreferences: defineRoute({
      path: "/preferences/ui",
      method: "get",
      request: noRequest(),
      response: jsonResponse<UiPreferencesResponse>(),
    }),
    updateUiPreference: defineRoute({
      path: "/preferences/ui/:key",
      method: "put",
      request: jsonRequest<PathUiPreferenceKey, UpdateUiPreferenceRequest>(
        updateUiPreferenceRequestSchema,
      ),
      response: [
        jsonResponse<UiPreferenceResponse>(),
        jsonResponse<ApiError>({ status: 404 }),
        jsonResponse<ApiError>({ status: 409 }),
      ],
    }),
    resetUiPreference: defineRoute({
      path: "/preferences/ui/:key",
      method: "delete",
      request: noRequest<PathUiPreferenceKey>(),
      response: [
        jsonResponse<UiPreferenceResponse>(),
        jsonResponse<ApiError>({ status: 404 }),
      ],
    }),
    themes: defineRoute({
      path: "/settings/themes",
      method: "get",
      request: noRequest(),
      response: jsonResponse<ThemeCatalogResponse>(),
    }),

    resolveTheme: defineRoute({
      path: "/settings/themes/:id",
      method: "get",
      request: noRequest<PathId>(),
      response: jsonResponse<AppTheme>(),
    }),
    reloadConfig: defineRoute({
      path: "/system/config/reload",
      method: "post",
      request: noRequest(),
      response: jsonResponse<SystemConfigReloadResponse>(),
    }),
    cliSkillsStatus: defineRoute({
      path: "/system/cli-skills",
      method: "get",
      request: optionalQueryRequest<EmptyInput, SystemCliSkillsStatusQuery>(
        systemCliSkillsStatusQuerySchema,
      ),
      response: jsonResponse<SystemCliSkillsStatusResponse>(),
    }),
    installCliSkills: defineRoute({
      path: "/system/cli-skills/install",
      method: "post",
      request: jsonRequest<EmptyInput, SystemInstallCliSkillsRequest>(
        systemInstallCliSkillsRequestSchema,
      ),
      response: jsonResponse<SystemInstallCliSkillsResponse>(),
    }),
    executionOptions: defineRoute({
      path: "/system/execution-options",
      method: "get",
      request: optionalQueryRequest<EmptyInput, SystemExecutionOptionsQuery>(
        systemExecutionOptionsQuerySchema,
      ),
      response: jsonResponse<SystemExecutionOptionsResponse>(),
    }),
    environmentProviders: defineRoute({
      path: "/system/environment-providers",
      method: "get",
      request: optionalQueryRequest<
        EmptyInput,
        SystemEnvironmentProvidersQuery
      >(systemEnvironmentProvidersQuerySchema),
      response: jsonResponse<SystemEnvironmentProvidersResponse>(),
    }),
    machineProviders: defineRoute({
      path: "/system/machine-providers",
      method: "get",
      request: noRequest(),
      response: jsonResponse<SystemMachineProvidersResponse>(),
    }),
    providers: defineRoute({
      path: "/system/providers",
      method: "get",
      request: optionalQueryRequest<EmptyInput, SystemProvidersQuery>(
        systemProvidersQuerySchema,
      ),
      response: jsonResponse<SystemProviderInfo[]>(),
    }),
    providerCatalog: defineRoute({
      path: "/system/providers/catalog",
      method: "get",
      request: noRequest(),
      response: jsonResponse<SystemProviderCatalogEntry[]>(),
    }),
    providerEnabled: defineRoute({
      path: "/system/providers/:id/enabled",
      method: "put",
      request: jsonRequest<PathId, SystemProviderEnabledRequest>(
        systemProviderEnabledRequestSchema,
      ),
      response: jsonResponse<SystemProviderCatalogEntry[]>(),
    }),
    providerLogo: defineRoute({
      path: "/system/providers/:id/logo",
      method: "get",
      request: noRequest<PathId>(),
      response: binaryResponse<Uint8Array>(),
    }),
    providerStates: defineRoute({
      path: "/system/providers/state",
      method: "get",
      request: optionalQueryRequest<EmptyInput, SystemProvidersQuery>(
        systemProvidersQuerySchema,
      ),
      response: jsonResponse<SystemProviderStatesResponse>(),
    }),
    usageLimits: defineRoute({
      path: "/system/usage-limits",
      method: "get",
      request: optionalQueryRequest<EmptyInput, SystemUsageLimitsQuery>(
        systemUsageLimitsQuerySchema,
      ),
      response: jsonResponse<ProviderUsageResponse>(),
    }),
    attachmentDiagnostic: defineRoute({
      path: "/system/attachment-diagnostic",
      method: "post",
      request: jsonRequest<EmptyInput, AttachmentDiagnostic>(
        attachmentDiagnosticSchema,
      ),
      response: jsonResponse<{ ok: true }>(),
    }),
    voiceDiagnostic: defineRoute({
      path: "/system/voice-diagnostic",
      method: "post",
      request: jsonRequest<EmptyInput, VoiceDiagnostic>(voiceDiagnosticSchema),
      response: jsonResponse<{ ok: true }>(),
    }),
    voiceTranscription: defineRoute({
      path: "/system/voice-transcription",
      method: "post",
      request: formRequest<EmptyInput, SystemVoiceTranscriptionForm>(),
      response: jsonResponse<SystemVoiceTranscriptionResponse>(),
    }),
    voicePrepare: defineRoute({
      path: "/system/voice-transcription/prepare",
      method: "post",
      request: noRequest(),
      response: jsonResponse<{ ok: true }>(),
    }),
    version: defineRoute({
      path: "/system/version",
      method: "get",
      request: optionalQueryRequest<EmptyInput, SystemVersionQuery>(
        systemVersionQuerySchema,
      ),
      response: jsonResponse<SystemVersionResponse>(),
    }),
    webUpdateStatus: defineRoute({
      path: "/system/web-update",
      method: "get",
      request: noRequest(),
      response: jsonResponse<WebUpdateStatus>(),
    }),
    webUpdateBegin: defineRoute({
      path: "/system/web-update/begin",
      method: "post",
      request: jsonRequest<EmptyInput, WebUpdateBegin>(webUpdateBeginSchema),
      response: jsonResponse<{ uploadId: string }>(),
    }),
    webUpdateUpload: defineRoute({
      path: "/system/web-update/upload",
      method: "post",
      request: jsonRequest<EmptyInput, WebUpdateUpload>(webUpdateUploadSchema),
      response: jsonResponse<{ ok: true }>(),
    }),
    webUpdateApply: defineRoute({
      path: "/system/web-update/apply",
      method: "post",
      request: jsonRequest<EmptyInput, WebUpdateApply>(webUpdateApplySchema),
      response: jsonResponse<WebUpdateStatus>(),
    }),
    webUpdateAbort: defineRoute({
      path: "/system/web-update/abort",
      method: "post",
      request: jsonRequest<EmptyInput, WebUpdateAbort>(webUpdateAbortSchema),
      response: jsonResponse<{ ok: true }>(),
    }),
    webUpdateRollback: defineRoute({
      path: "/system/web-update/rollback",
      method: "post",
      request: jsonRequest<EmptyInput, WebUpdateRollback>(
        webUpdateRollbackSchema,
      ),
      response: jsonResponse<WebUpdateStatus>(),
    }),
    appUpdate: defineRoute({
      path: "/system/app-update",
      method: "get",
      request: optionalQueryRequest<EmptyInput, SystemAppUpdateQuery>(
        systemAppUpdateQuerySchema,
      ),
      response: jsonResponse<SystemAppUpdateStatus>(),
    }),
    applyAppUpdate: defineRoute({
      path: "/system/app-update/apply",
      method: "post",
      request: jsonRequest<EmptyInput, SystemAppUpdateApplyRequest>(
        systemAppUpdateApplyRequestSchema,
      ),
      response: jsonResponse<SystemAppUpdateStatus>(),
    }),
    acknowledgeAppUpdate: defineRoute({
      path: "/system/app-update/acknowledge",
      method: "post",
      request: jsonRequest<EmptyInput, SystemAppUpdateAcknowledgeRequest>(
        systemAppUpdateAcknowledgeRequestSchema,
      ),
      response: jsonResponse<SystemAppUpdateStatus>(),
    }),
    cancelAppUpdate: defineRoute({
      path: "/system/app-update/cancel",
      method: "post",
      request: noRequest(),
      response: jsonResponse<SystemAppUpdateStatus>(),
    }),
  },
};

export type PublicApiSchema = ApiSchemaFromRouteDescriptors<
  typeof publicApiRoutes
>;

export type PublicApiRoutes = Hono<{}, PublicApiSchema, "/">;

import {
  attentionCommandSchema,
  type AttentionCommand,
} from "./api/thread-attention.js";
import type {
  ThreadAttentionSnapshot,
  ThreadAttentionResult,
} from "@omnyo/domain";
import { z } from "zod";
