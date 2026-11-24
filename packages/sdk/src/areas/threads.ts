import {
  publishThreadWorkSchema,
  type PublishThreadWork,
  type ThreadWorkSummary,
} from "@omnyo/domain";
import {
  parseThreadEventRow,
  type PromptInput,
  type PendingInteraction,
  type PendingInteractionResolution,
  type JsonValue,
  type JsonObject,
  type ResolvedThreadExecutionOptions,
  type ThreadEventRow,
  type ThreadEventType,
  type QueuedMessageWaitHolder,
  type ThreadQueuedMessage,
  type ThreadStatus,
  validatePluginMetadata,
} from "@omnyo/domain";
import {
  DEFAULT_TURN_RETRY_REASON,
  SUBMISSION_CONTRACT_VERSION,
  threadTabsResponseSchema,
} from "@omnyo/server-contract";
import type {
  ImportNativeThreadRequest,
  ImportNativeThreadResponse,
  NativeSessionClaimsQuery,
  NativeSessionClaimsResponse,
  CommandProofLookupRequest,
  CommandProofLookupResponse,
  CreateQueuedMessageRequest,
  SubmissionAttachment,
  SubmissionContract,
  SubmissionReceipt,
  SubmitRequest,
  CreateThreadRequest,
  QueuedMessageListQuery,
  EditMessageRequest,
  EditMessageResponse,
  ForkThreadRequest,
  DeleteThreadRequest,
  PromptHistoryResponse,
  QueuedMessageEditHoldResponse,
  SendQueuedMessageResponse,
  ThreadArchiveAllResponse,
  ThreadChildSummaryResponse,
  ThreadConversationResponse,
  ThreadConversationOutlineResponse,
  ThreadCountGroupBy,
  ThreadCountQuery,
  ThreadCountResponse,
  ThreadListResponse,
  ThreadMessageResponse,
  ThreadRunningResponse,
  ThreadOpenResponse,
  ThreadPaneAction,
  ThreadPaneActionResponse,
  ThreadPendingInteractionsResponse,
  ThreadQueuedMessageListResponse,
  ThreadResponse,
  PluginThreadMetadataListResponse,
  ThreadAncestorsListResponse,
  ThreadDescendantsListResponse,
  ThreadPluginMetadataResponse,
  ThreadSearchResponse,
  ThreadStorageFileListResponse,
  ThreadStorageLocationResponse,
  ThreadStoragePathListResponse,
  ThreadTabsResponse,
  ThreadTimelineResponse,
  ThreadContextResponse,
  ThreadAutoCompactionSettingResponse,
  ThreadWithIncludesResponse,
  TimelineTurnSummaryDetailsResponse,
  ThreadOpenFile,
  ThreadOpenSplit,
  PromptHistoryQuery,
  ReorderPinnedThreadRequest,
  ReorderQueuedMessageRequest,
  ReorderShelvedThreadRequest,
  ResolveThreadMentionsRequest,
  ResolveThreadMentionsResponse,
  RetryTurnRequest,
  RetryTurnResponse,
  ThreadStartMachineRequestInput,
  ThreadStartMachineResponse,
  ThreadStartMachinesResponse,
  ThreadContinueState,
  ThreadContinueResponse,
  ThreadContinuationsResponse,
  ThreadContinueAllResponse,
  SendMessageRequest,
  SendMessageResponse,
  SendQueuedMessageRequest,
  SetQueuedMessageGroupBoundaryRequest,
  ThreadEventsQuery,
  ThreadEventWaitQuery,
  ThreadGetQuery,
  ThreadListQuery,
  ThreadSearchQuery,
  ThreadStorageFilesQuery,
  ThreadStoragePathsQuery,
  ThreadTimelineQuery,
  ThreadConversationQuery,
  ThreadConversationOutlineQuery,
  TimelineTurnSummaryDetailsQuery,
  UpdateThreadTabsRequest,
  UpdateThreadRequest,
  UpdateThreadResponse,
  UpdateQueuedMessageRequest,
} from "@omnyo/server-contract";
import { signalRequestArgs, type CreateSdkAreaArgs } from "./common.js";

export const DEFAULT_THREAD_WAIT_TIMEOUT_MS = 20 * 60 * 1000;

export const DEFAULT_THREAD_WAIT_POLL_INTERVAL_MS = 250;

export interface ThreadListArgs {
  archived?: boolean;
  environmentId?: string;
  hostId?: string;
  sectionId?: string;
  groupId?: string;
  hasParent?: boolean;
  includeHidden?: boolean;
  experimental_includePluginHome?: boolean;
  limit?: number;
  offset?: number;
  originKind?: ThreadListQuery["originKind"];
  originPluginId?: string;
  parentThreadId?: string;
  projectId?: string;
  shelved?: boolean;
  signal?: AbortSignal;
  sourceThreadId?: string;
  threadIds?: readonly string[];
  unsectioned?: boolean;
}

export interface ThreadSearchArgs extends ThreadSearchQuery {
  signal?: AbortSignal;
}

export interface ThreadCountArgs {
  groupBy?: ThreadCountGroupBy;
  hostId?: string;
  parentThreadId?: string;
  projectId?: string;
  providerId?: string;
  signal?: AbortSignal;
  status?: ThreadStatus;
}

export interface ThreadResolveMentionsArgs extends ResolveThreadMentionsRequest {
  signal?: AbortSignal;
}

export interface ThreadGetArgs {
  include?: ThreadGetQuery["include"];
  signal?: AbortSignal;
  threadId: string;
}

export type ThreadGetResult = ThreadResponse | ThreadWithIncludesResponse;

export type ThreadCountResult = ThreadCountResponse;

export type ThreadRunningResult = ThreadRunningResponse;

export type ThreadListResult = ThreadListResponse;

export type ThreadSearchResult = ThreadSearchResponse;

export type ThreadMessageResult = ThreadMessageResponse;

export type ThreadResolveMentionsResult = ResolveThreadMentionsResponse;

export interface ThreadOutputResponse {
  output: string | null;
}

export type ThreadMutationResult = ThreadResponse;

export type ThreadUpdateResult = UpdateThreadResponse;

export type ThreadPluginMetadataResult = ThreadPluginMetadataResponse;

export type PluginThreadMetadataListResult = PluginThreadMetadataListResponse;

export type ThreadAncestorsListResult = ThreadAncestorsListResponse;

export type ThreadDescendantsListResult = ThreadDescendantsListResponse;

export type ThreadSpawnResult = ThreadResponse;

export type ThreadForkResult = ThreadResponse;

export type ThreadInteractionGetResult = PendingInteraction;

export type ThreadInteractionListResult = ThreadPendingInteractionsResponse;

export type ThreadInteractionResolveResult = PendingInteraction;

export type ThreadInteractionRespondResult = PendingInteraction;

export type ThreadInteractionCancelResult = PendingInteraction;

export type ThreadEventsListResult = ThreadEventRow[];

export type ThreadEventWaitResult = ThreadEventRow | null;

export type ThreadContextResult = ThreadContextResponse;

export type ThreadAutoCompactionSettingResult =
  ThreadAutoCompactionSettingResponse;

export type ThreadTimelineResult = ThreadTimelineResponse;

export type ThreadArchiveResult = ThreadArchiveAllResponse;

export type ThreadOpenResult = ThreadOpenResponse;

export type ThreadPaneActionResult = ThreadPaneActionResponse;

export type ThreadDeleteResult = { ok: true };

export type ThreadSendResult = SendMessageResponse;

export type ThreadRetryResult = RetryTurnResponse;

export type ThreadContinueResult = ThreadContinueResponse;

export type ThreadContinueAllResult = ThreadContinueAllResponse;

export type ThreadContinuationStateResult = ThreadContinueState;

export type ThreadContinuationsResult = ThreadContinuationsResponse;

export type ThreadEditMessageResult = EditMessageResponse;

export type ThreadStopResult = { ok: true };

export type ThreadCompactResult = { ok: true };

export type ThreadBannerActionResult = { ok: true };

export type ThreadUnarchiveResult = { ok: true };

export type ThreadArchiveAllResult = ThreadArchiveAllResponse;

export type ThreadReadStateResult = ThreadResponse;

export type ThreadRestoreEnvironmentResult = ThreadResponse;

export type ThreadPinOrderResult = ThreadListResponse;

export type ThreadShelfOrderResult = ThreadListResponse;

export type ThreadPromptHistoryResult = PromptHistoryResponse;

export type ThreadQueuedMessagesResult = ThreadQueuedMessageListResponse;

export type ThreadQueuedMessageCreateResult = ThreadQueuedMessage;

export type ThreadQueuedMessageUpdateResult = ThreadQueuedMessage;

export type ThreadQueuedMessageDeleteResult = { ok: true };

export type ThreadQueuedMessageRestoreResult = ThreadQueuedMessage;

export type ThreadQueuedMessageEditHoldResult = QueuedMessageEditHoldResponse;

export type ThreadQueuedMessageEditHoldReleaseResult = { ok: true };

export type ThreadQueuedMessageReorderResult = ThreadQueuedMessageListResponse;

export type ThreadQueuedMessageSendResult = SendQueuedMessageResponse;

export type ThreadQueuedMessageGroupBoundaryResult =
  ThreadQueuedMessageListResponse;

export type ThreadQueueListResult = ThreadQueuedMessageListResponse;

export type ThreadTabsResult = ThreadTabsResponse;

export type ThreadTabsUpdateResult = ThreadTabsResponse;

export type ThreadStorageFilesResult = ThreadStorageFileListResponse;

export type ThreadStorageLocationResult = ThreadStorageLocationResponse;

export type ThreadStoragePathsResult = ThreadStoragePathListResponse;

export type ThreadChildSummaryResult = ThreadChildSummaryResponse;

export type ThreadDefaultExecutionOptionsResult = ResolvedThreadExecutionOptions | null;

export type ThreadConversationResult = ThreadConversationResponse;

export type ThreadConversationOutlineResult = ThreadConversationOutlineResponse;

export type ThreadTimelineTurnSummaryDetailsResult =
  TimelineTurnSummaryDetailsResponse;

export interface ThreadSpawnBaseArgs extends Omit<
  CreateThreadRequest,
  | "input"
  | "origin"
  | "originKind"
  | "startedOnBehalfOf"
  | "idle"
  | "pluginHome"
  | "quiet"
> {
  origin?: CreateThreadRequest["origin"];
  experimental_quiet?: boolean;
  originKind?: CreateThreadRequest["originKind"];
  startedOnBehalfOf?: CreateThreadRequest["startedOnBehalfOf"];
}

export type ThreadSpawnArgs = ThreadSpawnBaseArgs &
  (
    | {
        input: CreateThreadRequest["input"];
        prompt?: never;
      }
    | {
        input?: never;
        prompt: string;
      }
    | {
        input?: never;
        prompt?: never;
        experimental_idle: true;
        experimental_pluginHome?: boolean;
      }
  );

export interface ThreadForkArgs extends Omit<
  ForkThreadRequest,
  "origin" | "visibility"
> {
  origin?: ForkThreadRequest["origin"];
  visibility?: ForkThreadRequest["visibility"];
}

export interface ThreadImportNativeArgs extends Omit<
  ImportNativeThreadRequest,
  "origin"
> {
  origin?: ImportNativeThreadRequest["origin"];
  signal?: AbortSignal;
}

export type ThreadImportNativeResult = ImportNativeThreadResponse;

export interface ThreadNativeSessionClaimsArgs extends NativeSessionClaimsQuery {
  signal?: AbortSignal;
}

export type ThreadNativeSessionClaimsResult = NativeSessionClaimsResponse;

export interface ThreadUpdateArgs extends UpdateThreadRequest {
  threadId: string;
  signal?: AbortSignal;
}

export interface ThreadPluginMetadataArgs {
  pluginId: string;
  signal?: AbortSignal;
  threadId: string;
}

export interface PluginThreadMetadataListArgs {
  pluginId: string;
  threadIds: readonly string[];
  signal?: AbortSignal;
}

export interface ThreadAncestorsListArgs {
  threadIds: readonly string[];
  signal?: AbortSignal;
}

export interface ThreadDescendantsListArgs {
  threadIds: readonly string[];
  includeArchived?: boolean;
  includeHidden?: boolean;
  signal?: AbortSignal;
}

export interface ThreadPluginMetadataUpdateArgs {
  threadId: string;
  pluginId: string;
  set?: JsonObject;
  remove?: string[];
  signal?: AbortSignal;
}

export interface ThreadDeleteArgs extends DeleteThreadRequest {
  threadId: string;
}

export interface ThreadSendArgs extends SendMessageRequest {
  threadId: string;
}

export interface ThreadEditMessageArgs extends EditMessageRequest {
  threadId: string;
}

export interface ThreadRetryArgs {
  threadId: string;

  turnRequestId?: string;

  sendAt?: number;

  reason?: string;
  model?: string;
}

export interface ThreadActionArgs {
  signal?: AbortSignal;
  threadId: string;
}

export interface ThreadContinueArgs extends ThreadActionArgs {
  now?: boolean;
  model?: string;
}

export interface ThreadStatusArgs extends ThreadActionArgs {
  signal?: AbortSignal;
}

export interface ThreadPromptHistoryArgs extends PromptHistoryQuery {
  signal?: AbortSignal;
  threadId: string;
}

export interface ThreadPinOrderArgs extends ReorderPinnedThreadRequest {
  threadId: string;
}

export interface ThreadShelfOrderArgs extends ReorderShelvedThreadRequest {
  threadId: string;
}

export interface ThreadQueuedMessageArgs {
  signal?: AbortSignal;
  threadId: string;
}

export interface ThreadQueuedMessageCreateArgs extends CreateQueuedMessageRequest {
  threadId: string;
}

export interface ThreadQueuedMessageUpdateArgs
  extends ThreadQueuedMessageTargetArgs, UpdateQueuedMessageRequest {}

export interface ThreadQueuedMessageTargetArgs {
  queuedMessageId: string;
  threadId: string;
}

export interface ThreadQueuedMessageSendArgs
  extends ThreadQueuedMessageTargetArgs, SendQueuedMessageRequest {}

export interface ThreadQueuedMessageReorderArgs
  extends ThreadQueuedMessageTargetArgs, ReorderQueuedMessageRequest {}

export interface ThreadQueuedMessageGroupBoundaryArgs extends SetQueuedMessageGroupBoundaryRequest {
  threadId: string;
}

export interface ThreadQueueListArgs {
  waitHolder?: QueuedMessageWaitHolder;
  signal?: AbortSignal;
  threadId?: string;
}

export interface ThreadStorageFilesArgs extends ThreadStorageFilesQuery {
  signal?: AbortSignal;
  threadId: string;
}

export interface ThreadStoragePathsArgs extends ThreadStoragePathsQuery {
  signal?: AbortSignal;
  threadId: string;
}

export interface ThreadConversationArgs extends ThreadConversationQuery {
  signal?: AbortSignal;
  threadId: string;
}

export interface ThreadConversationOutlineArgs extends ThreadConversationOutlineQuery {
  signal?: AbortSignal;
  threadId: string;
}

export interface ThreadTimelineTurnSummaryDetailsArgs extends TimelineTurnSummaryDetailsQuery {
  signal?: AbortSignal;
  threadId: string;
}

export interface ThreadTabsUpdateArgs extends UpdateThreadTabsRequest {
  threadId: string;
}

export interface ThreadOpenArgs {
  threadId: string;
  split?: ThreadOpenSplit;
  file: ThreadOpenFile | null;
}

export interface ThreadPaneActionArgs {
  action: ThreadPaneAction;
  threadId: string;
}

export interface ThreadCommandProofLookupArgs extends CommandProofLookupRequest {
  threadId: string;
  signal?: AbortSignal;
}

export interface ThreadEventsListArgs {
  afterSeq?: string;
  beforeSeq?: string;
  limit?: string;
  order?: "asc" | "desc";
  signal?: AbortSignal;
  threadId: string;
  types?: readonly [ThreadEventType, ...ThreadEventType[]];
}

export interface ThreadEventWaitArgs {
  afterSeq?: string;
  signal?: AbortSignal;
  threadId: string;
  type: string;
  waitMs: string;
}

export interface ThreadTimelineArgs extends ThreadTimelineQuery {
  signal?: AbortSignal;
  threadId: string;
}

export interface ThreadOutputArgs {
  signal?: AbortSignal;
  threadId: string;
}

export interface ThreadMessageArgs {
  signal?: AbortSignal;
  threadId: string;
  seq: number;
  before?: number;
  after?: number;
}

export interface ThreadInteractionListArgs {
  signal?: AbortSignal;
  threadId: string;
}

export interface ThreadInteractionTargetArgs {
  interactionId: string;
  threadId: string;
}

export interface ThreadInteractionGetArgs extends ThreadInteractionTargetArgs {
  signal?: AbortSignal;
}

export interface ThreadInteractionResolveArgs extends ThreadInteractionTargetArgs {
  resolution: PendingInteractionResolution;
}

export interface ThreadInteractionRespondArgs extends ThreadInteractionTargetArgs {
  value: JsonValue;
}

export type ThreadWaitTarget =
  | { kind: "status"; status: ThreadStatus }
  | { kind: "event"; eventType: string };

export interface ThreadWaitArgs {
  event?: string;
  pollIntervalMs?: number;
  signal?: AbortSignal;
  status?: ThreadStatus;
  threadId: string;
  timeoutMs?: number;
}

export type ThreadWaitResult =
  | {
      event: NonNullable<ThreadEventWaitResult>;
      matched: true;
      target: Extract<ThreadWaitTarget, { kind: "event" }>;
      threadId: string;
    }
  | {
      matched: true;
      target: Extract<ThreadWaitTarget, { kind: "status" }>;
      thread: ThreadGetResult;
      threadId: string;
    };

export class ThreadWaitTimeoutError extends Error {
  readonly target: ThreadWaitTarget;
  readonly threadId: string;

  constructor(args: {
    target: ThreadWaitTarget;
    threadId: string;
    pendingRetry?: ThreadQueuedMessage | null;
  }) {
    super(formatThreadWaitTimeoutMessage(args));
    this.name = "ThreadWaitTimeoutError";
    this.target = args.target;
    this.threadId = args.threadId;
  }
}

export class ThreadWaitUnreachableError extends Error {
  readonly currentStatus: ThreadStatus;
  readonly target: Extract<ThreadWaitTarget, { kind: "status" }>;
  readonly threadId: string;

  constructor(args: {
    currentStatus: ThreadStatus;
    target: Extract<ThreadWaitTarget, { kind: "status" }>;
    threadId: string;
  }) {
    super(
      `Thread ${args.threadId} is in status ${args.currentStatus} and will not reach idle by waiting alone. ` +
        `Inspect it with 'omnyo thread show ${args.threadId}' and recover by sending a follow-up.`,
    );
    this.name = "ThreadWaitUnreachableError";
    this.currentStatus = args.currentStatus;
    this.target = args.target;
    this.threadId = args.threadId;
  }
}

export interface ThreadInteractionsArea {
  cancel(
    args: ThreadInteractionTargetArgs,
  ): Promise<ThreadInteractionCancelResult>;
  get(args: ThreadInteractionGetArgs): Promise<ThreadInteractionGetResult>;
  list(args: ThreadInteractionListArgs): Promise<ThreadInteractionListResult>;
  resolve(
    args: ThreadInteractionResolveArgs,
  ): Promise<ThreadInteractionResolveResult>;
  respond(
    args: ThreadInteractionRespondArgs,
  ): Promise<ThreadInteractionRespondResult>;
}

export interface ThreadEventsArea {
  list(args: ThreadEventsListArgs): Promise<ThreadEventsListResult>;
  wait(args: ThreadEventWaitArgs): Promise<ThreadEventWaitResult>;
}

export interface ThreadSubmissionSendArgs extends CreateQueuedMessageRequest {
  attachments?: SubmissionAttachment[];
  storeId?: string;
  submissionId: string;
  threadId: string;
}

export type ThreadSubmissionSpawnArgs = ThreadSpawnArgs & {
  attachments?: SubmissionAttachment[];
  storeId?: string;
  submissionId: string;
};

export interface ThreadSubmissionsArea {
  contract(): Promise<SubmissionContract>;
  send(args: ThreadSubmissionSendArgs): Promise<SubmissionReceipt>;
  spawn(args: ThreadSubmissionSpawnArgs): Promise<SubmissionReceipt>;
  submit(request: SubmitRequest): Promise<SubmissionReceipt>;
}

export interface ThreadQueuedMessagesArea {
  create(
    args: ThreadQueuedMessageCreateArgs,
  ): Promise<ThreadQueuedMessageCreateResult>;
  delete(
    args: ThreadQueuedMessageTargetArgs,
  ): Promise<ThreadQueuedMessageDeleteResult>;
  experimental_holdForEdit(
    args: ThreadQueuedMessageTargetArgs,
  ): Promise<ThreadQueuedMessageEditHoldResult>;
  experimental_releaseEditHold(
    args: ThreadQueuedMessageTargetArgs,
  ): Promise<ThreadQueuedMessageEditHoldReleaseResult>;
  experimental_restore(
    args: ThreadQueuedMessageTargetArgs,
  ): Promise<ThreadQueuedMessageRestoreResult>;
  list(args: ThreadQueuedMessageArgs): Promise<ThreadQueuedMessagesResult>;
  reorder(
    args: ThreadQueuedMessageReorderArgs,
  ): Promise<ThreadQueuedMessageReorderResult>;
  send(
    args: ThreadQueuedMessageSendArgs,
  ): Promise<ThreadQueuedMessageSendResult>;
  setGroupBoundary(
    args: ThreadQueuedMessageGroupBoundaryArgs,
  ): Promise<ThreadQueuedMessageGroupBoundaryResult>;
  update(
    args: ThreadQueuedMessageUpdateArgs,
  ): Promise<ThreadQueuedMessageUpdateResult>;
}

export interface ThreadTabsArea {
  get(args: ThreadStatusArgs): Promise<ThreadTabsResult>;
  update(args: ThreadTabsUpdateArgs): Promise<ThreadTabsUpdateResult>;
}

export interface ThreadQueueArea {
  list(args?: ThreadQueueListArgs): Promise<ThreadQueueListResult>;
}

export interface ThreadsArea {
  archive(args: ThreadActionArgs): Promise<ThreadArchiveResult>;
  archiveAll(args: ThreadActionArgs): Promise<ThreadArchiveAllResult>;
  childSummary(args: ThreadStatusArgs): Promise<ThreadChildSummaryResult>;
  compact(args: ThreadActionArgs): Promise<ThreadCompactResult>;
  cancelPlan(args: ThreadActionArgs): Promise<ThreadBannerActionResult>;
  clearContext(args: ThreadActionArgs): Promise<ThreadBannerActionResult>;
  clearGoal(args: ThreadActionArgs): Promise<ThreadBannerActionResult>;
  conversation(args: ThreadConversationArgs): Promise<ThreadConversationResult>;
  conversationOutline(
    args: ThreadConversationOutlineArgs,
  ): Promise<ThreadConversationOutlineResult>;
  count(args?: ThreadCountArgs): Promise<ThreadCountResult>;
  defaultExecutionOptions(
    args: ThreadStatusArgs,
  ): Promise<ThreadDefaultExecutionOptionsResult>;
  delete(args: ThreadDeleteArgs): Promise<ThreadDeleteResult>;
  editMessage(args: ThreadEditMessageArgs): Promise<ThreadEditMessageResult>;
  experimental_lookupCommandProofs(
    args: ThreadCommandProofLookupArgs,
  ): Promise<CommandProofLookupResponse>;
  events: ThreadEventsArea;
  fork(args: ThreadForkArgs): Promise<ThreadForkResult>;
  experimental_importNative(
    args: ThreadImportNativeArgs,
  ): Promise<ThreadImportNativeResult>;
  experimental_nativeSessionClaims(
    args: ThreadNativeSessionClaimsArgs,
  ): Promise<ThreadNativeSessionClaimsResult>;
  get(args: ThreadGetArgs): Promise<ThreadGetResult>;
  getPluginMetadata(
    args: ThreadPluginMetadataArgs,
  ): Promise<ThreadPluginMetadataResult>;

  experimental_work(args: ThreadActionArgs): Promise<ThreadWorkSummary>;
  experimental_publishWork(
    args: ThreadActionArgs & PublishThreadWork,
  ): Promise<ThreadWorkSummary>;
  experimental_archiveReady(
    args: ThreadActionArgs & { basis: string },
  ): Promise<ThreadArchiveAllResponse>;

  experimental_listPluginMetadata(
    args: PluginThreadMetadataListArgs,
  ): Promise<PluginThreadMetadataListResult>;

  experimental_listAncestors(
    args: ThreadAncestorsListArgs,
  ): Promise<ThreadAncestorsListResult>;

  experimental_listDescendants(
    args: ThreadDescendantsListArgs,
  ): Promise<ThreadDescendantsListResult>;
  updatePluginMetadata(
    args: ThreadPluginMetadataUpdateArgs,
  ): Promise<ThreadPluginMetadataResult>;
  queue: ThreadQueueArea;
  interactions: ThreadInteractionsArea;
  list(args?: ThreadListArgs): Promise<ThreadListResult>;
  listRunning(args?: { signal?: AbortSignal }): Promise<ThreadRunningResult>;
  markRead(args: ThreadActionArgs): Promise<ThreadReadStateResult>;
  markUnread(args: ThreadActionArgs): Promise<ThreadReadStateResult>;
  open(args: ThreadOpenArgs): Promise<ThreadOpenResult>;
  paneAction(args: ThreadPaneActionArgs): Promise<ThreadPaneActionResult>;
  message(args: ThreadMessageArgs): Promise<ThreadMessageResult>;
  output(args: ThreadOutputArgs): Promise<ThreadOutputResponse>;
  pin(args: ThreadActionArgs): Promise<ThreadMutationResult>;
  promptHistory(
    args: ThreadPromptHistoryArgs,
  ): Promise<ThreadPromptHistoryResult>;
  queuedMessages: ThreadQueuedMessagesArea;
  submissions: ThreadSubmissionsArea;
  reorderPinned(args: ThreadPinOrderArgs): Promise<ThreadPinOrderResult>;
  experimental_reorderShelved(
    args: ThreadShelfOrderArgs,
  ): Promise<ThreadShelfOrderResult>;
  resolveMentions(
    args: ThreadResolveMentionsArgs,
  ): Promise<ThreadResolveMentionsResult>;

  restoreEnvironment(
    args: ThreadActionArgs,
  ): Promise<ThreadRestoreEnvironmentResult>;
  experimental_listStartMachines(
    args: ThreadActionArgs & { pluginId?: string },
  ): Promise<ThreadStartMachinesResponse>;
  experimental_moveStart(
    args: ThreadActionArgs & ThreadStartMachineRequestInput,
  ): Promise<ThreadStartMachineResponse>;
  retry(args: ThreadRetryArgs): Promise<ThreadRetryResult>;
  experimental_continue(
    args: ThreadContinueArgs,
  ): Promise<ThreadContinueResult>;
  experimental_continueAll(): Promise<ThreadContinueAllResult>;
  experimental_continuationState(
    args: ThreadActionArgs,
  ): Promise<ThreadContinuationStateResult>;
  experimental_continuations(args?: {
    signal?: AbortSignal;
  }): Promise<ThreadContinuationsResult>;
  search(args: ThreadSearchArgs): Promise<ThreadSearchResult>;
  send(args: ThreadSendArgs): Promise<ThreadSendResult>;
  shelve(
    args: ThreadActionArgs & {
      experimental_onServerTiming?: (header: string | null) => void;
    },
  ): Promise<ThreadMutationResult>;
  spawn(args: ThreadSpawnArgs): Promise<ThreadSpawnResult>;

  stop(args: ThreadActionArgs): Promise<ThreadStopResult>;
  tabs: ThreadTabsArea;
  context(args: ThreadStatusArgs): Promise<ThreadContextResult>;
  experimental_setAutoCompaction(
    args: ThreadActionArgs & { enabled: boolean },
  ): Promise<ThreadAutoCompactionSettingResult>;
  timeline(args: ThreadTimelineArgs): Promise<ThreadTimelineResult>;
  timelineTurnSummaryDetails(
    args: ThreadTimelineTurnSummaryDetailsArgs,
  ): Promise<ThreadTimelineTurnSummaryDetailsResult>;
  storageFiles(args: ThreadStorageFilesArgs): Promise<ThreadStorageFilesResult>;
  storageLocation(args: ThreadStatusArgs): Promise<ThreadStorageLocationResult>;
  storagePaths(args: ThreadStoragePathsArgs): Promise<ThreadStoragePathsResult>;
  unarchive(args: ThreadActionArgs): Promise<ThreadUnarchiveResult>;
  unpin(args: ThreadActionArgs): Promise<ThreadMutationResult>;
  unshelve(args: ThreadActionArgs): Promise<ThreadMutationResult>;
  update(args: ThreadUpdateArgs): Promise<ThreadUpdateResult>;
  wait(args: ThreadWaitArgs): Promise<ThreadWaitResult>;
}

function listQuery(args: ThreadListArgs | undefined): ThreadListQuery {
  const query: ThreadListQuery = {
    ...(args?.projectId ? { projectId: args.projectId } : {}),
    ...(args?.environmentId ? { environmentId: args.environmentId } : {}),
    ...(args?.hostId ? { hostId: args.hostId } : {}),
    ...(args?.parentThreadId ? { parentThreadId: args.parentThreadId } : {}),
    ...(args?.sourceThreadId ? { sourceThreadId: args.sourceThreadId } : {}),
    ...(args?.sectionId ? { sectionId: args.sectionId } : {}),
    ...(args?.groupId ? { groupId: args.groupId } : {}),
    ...(args?.originKind ? { originKind: args.originKind } : {}),
    ...(args?.originPluginId ? { originPluginId: args.originPluginId } : {}),
    ...(args?.archived === undefined
      ? {}
      : { archived: args.archived ? "true" : "false" }),
    ...(args?.shelved === undefined
      ? {}
      : { shelved: args.shelved ? "true" : "false" }),
    ...(args?.unsectioned === undefined
      ? {}
      : { unsectioned: args.unsectioned ? "true" : "false" }),
    ...(args?.includeHidden === undefined
      ? {}
      : { includeHidden: args.includeHidden ? "true" : "false" }),
    ...(args?.experimental_includePluginHome === undefined
      ? {}
      : {
          includePluginHome: args.experimental_includePluginHome
            ? "true"
            : "false",
        }),
    ...(args?.limit === undefined ? {} : { limit: String(args.limit) }),
    ...(args?.offset === undefined ? {} : { offset: String(args.offset) }),
    ...(args?.hasParent === undefined
      ? {}
      : { hasParent: args.hasParent ? "true" : "false" }),
  };

  if (args?.threadIds !== undefined) {
    query.threadIds = args.threadIds.join(",");
  }

  return query;
}

function countQuery(args: ThreadCountArgs | undefined): ThreadCountQuery {
  return {
    ...(args?.status === undefined ? {} : { status: args.status }),
    ...(args?.hostId === undefined ? {} : { hostId: args.hostId }),
    ...(args?.providerId === undefined ? {} : { providerId: args.providerId }),
    ...(args?.projectId === undefined ? {} : { projectId: args.projectId }),
    ...(args?.parentThreadId === undefined
      ? {}
      : { parentThreadId: args.parentThreadId }),
    ...(args?.groupBy === undefined ? {} : { groupBy: args.groupBy }),
  };
}

function updateJson(args: ThreadUpdateArgs): UpdateThreadRequest {
  const payload: UpdateThreadRequest = {
    title: args.title,
    sectionId: args.sectionId,
    groupId: args.groupId,
    parentThreadId: args.parentThreadId,
    model: args.model,
    reasoningLevel: args.reasoningLevel,
    serviceTier: args.serviceTier,
    sessionOptions: args.sessionOptions,
    visibility: args.visibility,
  };

  if (args.experimental_titleIfUntitled) {
    payload.experimental_titleIfUntitled = true;
  }

  if (args.experimental_pluginHome !== undefined) {
    payload.experimental_pluginHome = args.experimental_pluginHome;
  }

  return payload;
}

function sendJson(args: ThreadSendArgs): SendMessageRequest {
  return {
    requestId: args.requestId,
    input: args.input,
    mode: args.mode,
    model: args.model,
    permissionMode: args.permissionMode,
    reasoningLevel: args.reasoningLevel,
    senderThreadId: args.senderThreadId,
    messageSource: args.messageSource ?? { kind: "script", label: "SDK" },
    serviceTier: args.serviceTier,
    pluginSubmission: args.pluginSubmission,
    executionInputSources: args.executionInputSources,

    sendAt: args.sendAt,
    compactFirst: args.compactFirst,
    sendNow: args.sendNow,
  };
}

function retryJson(args: ThreadRetryArgs): RetryTurnRequest {
  return {
    turnRequestId: args.turnRequestId ?? null,
    sendAt: args.sendAt ?? null,
    reason: args.reason ?? DEFAULT_TURN_RETRY_REASON,
    ...(args.model === undefined ? {} : { model: args.model }),
  };
}

function queueListQuery(
  args: ThreadQueueListArgs | undefined,
): QueuedMessageListQuery {
  return {
    ...(args?.threadId === undefined ? {} : { threadId: args.threadId }),
    ...(args?.waitHolder === undefined ? {} : { waitHolder: args.waitHolder }),
  };
}

function spawnInput(input: ThreadSpawnArgs): PromptInput[] {
  if ("experimental_idle" in input && input.experimental_idle === true) {
    if (input.input !== undefined || input.prompt !== undefined) {
      throw new Error("An idle chat takes no input or prompt.");
    }

    return [];
  }

  if (input.input !== undefined && input.prompt !== undefined) {
    throw new Error("Provide only one of input or prompt.");
  }

  if (input.input !== undefined) {
    return input.input;
  }

  if (input.prompt === undefined) {
    throw new Error("Provide input or prompt.");
  }

  return [{ type: "text", text: input.prompt, mentions: [] }];
}

function spawnJson(args: ThreadSpawnArgs): CreateThreadRequest {
  const {
    input: _input,
    origin,
    originKind,
    prompt: _prompt,
    startedOnBehalfOf,
    ...rest
  } = args;

  const {
    experimental_idle: idle,
    experimental_pluginHome: pluginHome,
    experimental_quiet: quiet,
    ...request
  } = {
    experimental_idle: undefined,
    experimental_pluginHome: undefined,
    experimental_quiet: undefined,
    ...rest,
  };

  return {
    ...request,
    ...(idle === true ? { idle } : {}),
    ...(pluginHome === true ? { pluginHome } : {}),
    ...(quiet === true ? { quiet } : {}),
    ...(args.pluginMetadata === undefined
      ? {}
      : { pluginMetadata: validatePluginMetadata(args.pluginMetadata) }),
    input: spawnInput(args),
    origin: origin ?? "sdk",
    startedOnBehalfOf: startedOnBehalfOf ?? null,
    originKind: originKind ?? null,
  };
}

function forkJson(args: ThreadForkArgs): ForkThreadRequest {
  return {
    ...args,
    ...(args.pluginMetadata === undefined
      ? {}
      : { pluginMetadata: validatePluginMetadata(args.pluginMetadata) }),
    origin: args.origin ?? "sdk",
    visibility: args.visibility ?? "visible",
  };
}

function eventsListQuery(args: ThreadEventsListArgs): ThreadEventsQuery {
  return {
    ...(args.afterSeq !== undefined ? { afterSeq: args.afterSeq } : {}),
    ...(args.beforeSeq !== undefined ? { beforeSeq: args.beforeSeq } : {}),
    ...(args.limit !== undefined ? { limit: args.limit } : {}),
    ...(args.order !== undefined ? { order: args.order } : {}),
    ...(args.types !== undefined ? { types: args.types.join(",") } : {}),
  };
}

function eventWaitQuery(args: ThreadEventWaitArgs): ThreadEventWaitQuery {
  return {
    ...(args.afterSeq !== undefined ? { afterSeq: args.afterSeq } : {}),
    type: args.type,
    waitMs: args.waitMs,
  };
}

function searchQuery(args: ThreadSearchArgs): ThreadSearchQuery {
  return {
    limitPerGroup: args.limitPerGroup,
    query: args.query,
  };
}

function timelineQuery(args: ThreadTimelineArgs): ThreadTimelineQuery {
  const query: ThreadTimelineQuery = {};

  if (args.priority !== undefined) query.priority = args.priority;

  if (args.deltaFormat !== undefined) query.deltaFormat = args.deltaFormat;

  if (args.runtimeIdentity !== undefined)
    query.runtimeIdentity = args.runtimeIdentity;

  if (args.afterRuntimeId !== undefined)
    query.afterRuntimeId = args.afterRuntimeId;

  if (args.afterRevision !== undefined)
    query.afterRevision = args.afterRevision;

  if (args.deferContent !== undefined) query.deferContent = args.deferContent;

  if (args.includeNestedRows !== undefined)
    query.includeNestedRows = args.includeNestedRows;

  if (args.summaryOnly !== undefined) query.summaryOnly = args.summaryOnly;

  if (args.segmentLimit !== undefined) query.segmentLimit = args.segmentLimit;

  if (args.beforeAnchorSeq !== undefined)
    query.beforeAnchorSeq = args.beforeAnchorSeq;

  if (args.beforeAnchorId !== undefined)
    query.beforeAnchorId = args.beforeAnchorId;

  if (args.afterSequence !== undefined)
    query.afterSequence = args.afterSequence;

  return query;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function resolveThreadWaitTarget(args: ThreadWaitArgs): ThreadWaitTarget {
  const hasStatus = args.status !== undefined;
  const hasEvent = args.event !== undefined;

  if (hasStatus && hasEvent) {
    throw new Error("Provide only one of status or event.");
  }

  if (hasEvent) {
    return { kind: "event", eventType: args.event ?? "" };
  }

  return { kind: "status", status: args.status ?? "idle" };
}

function validateThreadWaitArgs(args: ThreadWaitArgs): {
  pollIntervalMs: number;
  target: ThreadWaitTarget;
  timeoutMs: number;
} {
  const timeoutMs = args.timeoutMs ?? DEFAULT_THREAD_WAIT_TIMEOUT_MS;

  if (!Number.isFinite(timeoutMs) || timeoutMs < 0) {
    throw new RangeError(
      "Timeout must be a non-negative number of milliseconds.",
    );
  }

  const pollIntervalMs =
    args.pollIntervalMs ?? DEFAULT_THREAD_WAIT_POLL_INTERVAL_MS;

  if (!Number.isInteger(pollIntervalMs) || pollIntervalMs < 1) {
    throw new RangeError(
      "Poll interval must be a positive integer number of milliseconds.",
    );
  }

  return {
    pollIntervalMs,
    target: resolveThreadWaitTarget(args),
    timeoutMs,
  };
}

function formatThreadWaitTimeoutMessage(args: {
  target: ThreadWaitTarget;
  threadId: string;
  pendingRetry?: ThreadQueuedMessage | null;
}): string {
  if (args.target.kind === "status") {
    const timedOut = `Timed out waiting for thread ${args.threadId} to reach status ${args.target.status}.`;

    if (args.pendingRetry == null) return timedOut;

    const retryAt =
      args.pendingRetry.sendAt === null
        ? "a retry is waiting to send"
        : `a retry is scheduled for ${new Date(args.pendingRetry.sendAt).toISOString()}`;

    return `${timedOut} It failed and ${retryAt}; wait again to follow it.`;
  }

  return `Timed out waiting for thread ${args.threadId} event ${args.target.eventType}.`;
}

function isThreadWaitTargetUnreachable(
  currentStatus: ThreadStatus,
  target: ThreadWaitTarget,
): target is Extract<ThreadWaitTarget, { kind: "status" }> {
  return (
    target.kind === "status" &&
    target.status === "idle" &&
    currentStatus === "error"
  );
}

export function createThreadsArea(args: CreateSdkAreaArgs): ThreadsArea {
  const { transport } = args;

  const getThread = (input: ThreadGetArgs) =>
    transport.readJson(
      transport.api.v1.threads[":id"].$get(
        {
          param: { id: input.threadId },
          ...(input.include === undefined
            ? {}
            : { query: { include: input.include } }),
        },
        ...signalRequestArgs(input.signal),
      ),
    );

  const archiveAll = async (
    input: ThreadActionArgs,
  ): Promise<ThreadArchiveAllResult> =>
    transport.readJson(
      transport.api.v1.threads[":id"]["archive-all"].$post({
        param: { id: input.threadId },
      }),
    );

  const events: ThreadEventsArea = {
    async list(input) {
      return transport.readJson(
        transport.api.v1.threads[":id"].events.$get(
          {
            param: { id: input.threadId },
            query: eventsListQuery(input),
          },
          ...signalRequestArgs(input.signal),
        ),
      );
    },
    async wait(input) {
      const response = await transport.resolve(
        transport.api.v1.threads[":id"].events.wait.$get(
          {
            param: { id: input.threadId },
            query: eventWaitQuery(input),
          },
          ...signalRequestArgs(input.signal),
        ),
      );

      const statusCode: number = response.status;

      if (statusCode === 204) {
        return null;
      }

      return parseThreadEventRow(await response.json());
    },
  };

  const interactions: ThreadInteractionsArea = {
    async cancel(input) {
      return transport.readJson(
        transport.api.v1.threads[":id"].interactions[
          ":interactionId"
        ].cancel.$post({
          param: { id: input.threadId, interactionId: input.interactionId },
        }),
      );
    },
    async get(input) {
      return transport.readJson(
        transport.api.v1.threads[":id"].interactions[":interactionId"].$get(
          {
            param: {
              id: input.threadId,
              interactionId: input.interactionId,
            },
          },
          ...signalRequestArgs(input.signal),
        ),
      );
    },
    async list(input) {
      return transport.readJson(
        transport.api.v1.threads[":id"].interactions.$get(
          { param: { id: input.threadId } },
          ...signalRequestArgs(input.signal),
        ),
      );
    },
    async resolve(input) {
      return transport.readJson(
        transport.api.v1.threads[":id"].interactions[
          ":interactionId"
        ].resolve.$post({
          param: {
            id: input.threadId,
            interactionId: input.interactionId,
          },
          json: input.resolution,
        }),
      );
    },
    async respond(input) {
      return transport.readJson(
        transport.api.v1.threads[":id"].interactions[
          ":interactionId"
        ].respond.$post({
          param: { id: input.threadId, interactionId: input.interactionId },
          json: { value: input.value },
        }),
      );
    },
  };

  const submissions: ThreadSubmissionsArea = {
    async contract() {
      return transport.readJson(transport.api.v1.submissions.contract.$get());
    },
    async send(args) {
      const { attachments, storeId, submissionId, threadId, ...message } = args;

      return submissions.submit({
        version: SUBMISSION_CONTRACT_VERSION,
        submissionId,
        storeId: storeId ?? (await submissions.contract()).storeId,
        action: {
          kind: "thread-message",
          threadId,
          message: {
            ...message,
            messageSource: message.messageSource ?? {
              kind: "script",
              label: "SDK",
            },
          },
        },
        attachments: attachments ?? [],
      });
    },
    async spawn(args) {
      const { attachments, storeId, submissionId, ...thread } = args;

      return submissions.submit({
        version: SUBMISSION_CONTRACT_VERSION,
        submissionId,
        storeId: storeId ?? (await submissions.contract()).storeId,
        action: { kind: "new-thread", thread: spawnJson(thread) },
        attachments: attachments ?? [],
      });
    },
    async submit(request) {
      return transport.readJson(
        transport.api.v1.submissions.$post({ json: request }),
      );
    },
  };

  const queuedMessages: ThreadQueuedMessagesArea = {
    async create(input) {
      const { threadId, ...json } = input;

      return transport.readJson(
        transport.api.v1.threads[":id"]["queued-messages"].$post({
          param: { id: threadId },
          json: {
            ...json,
            messageSource: input.messageSource ?? {
              kind: "script",
              label: "SDK",
            },
          },
        }),
      );
    },
    async delete(input) {
      await transport.readVoid(
        transport.api.v1.threads[":id"]["queued-messages"][
          ":queuedMessageId"
        ].$delete({
          param: {
            id: input.threadId,
            queuedMessageId: input.queuedMessageId,
          },
        }),
      );

      return { ok: true };
    },
    async experimental_holdForEdit(input) {
      return transport.readJson(
        transport.api.v1.threads[":id"]["queued-messages"][":queuedMessageId"][
          "edit-hold"
        ].$post({
          param: {
            id: input.threadId,
            queuedMessageId: input.queuedMessageId,
          },
        }),
      );
    },
    async experimental_releaseEditHold(input) {
      await transport.readVoid(
        transport.api.v1.threads[":id"]["queued-messages"][":queuedMessageId"][
          "edit-hold"
        ].$delete({
          param: {
            id: input.threadId,
            queuedMessageId: input.queuedMessageId,
          },
        }),
      );

      return { ok: true };
    },
    async experimental_restore(input) {
      return transport.readJson(
        transport.api.v1.threads[":id"]["queued-messages"][
          ":queuedMessageId"
        ].restore.$post({
          param: {
            id: input.threadId,
            queuedMessageId: input.queuedMessageId,
          },
        }),
      );
    },
    async list(input) {
      return transport.readJson(
        transport.api.v1.threads[":id"]["queued-messages"].$get(
          { param: { id: input.threadId } },
          ...signalRequestArgs(input.signal),
        ),
      );
    },
    async reorder(input) {
      return transport.readJson(
        transport.api.v1.threads[":id"]["queued-messages"][
          ":queuedMessageId"
        ].order.$patch({
          param: {
            id: input.threadId,
            queuedMessageId: input.queuedMessageId,
          },
          json: {
            previousQueuedMessageId: input.previousQueuedMessageId,
            nextQueuedMessageId: input.nextQueuedMessageId,
            groupBoundaryQueuedMessageId: input.groupBoundaryQueuedMessageId,
          },
        }),
      );
    },
    async send(input) {
      return transport.readJson(
        transport.api.v1.threads[":id"]["queued-messages"][
          ":queuedMessageId"
        ].send.$post({
          param: {
            id: input.threadId,
            queuedMessageId: input.queuedMessageId,
          },
          json: { mode: input.mode, requestId: input.requestId },
        }),
      );
    },
    async setGroupBoundary(input) {
      return transport.readJson(
        transport.api.v1.threads[":id"]["queued-messages"][
          "group-boundary"
        ].$patch({
          param: { id: input.threadId },
          json: {
            expectedGroupedPrefixQueuedMessageIds:
              input.expectedGroupedPrefixQueuedMessageIds,
            groupBoundaryQueuedMessageId: input.groupBoundaryQueuedMessageId,
          },
        }),
      );
    },
    async update(input) {
      const { queuedMessageId, threadId, ...json } = input;

      return transport.readJson(
        transport.api.v1.threads[":id"]["queued-messages"][
          ":queuedMessageId"
        ].$patch({
          param: { id: threadId, queuedMessageId },
          json,
        }),
      );
    },
  };

  const queue: ThreadQueueArea = {
    async list(input) {
      return transport.readJson(
        transport.api.v1["queued-messages"].$get(
          { query: queueListQuery(input) },
          ...signalRequestArgs(input?.signal),
        ),
      );
    },
  };

  const tabs: ThreadTabsArea = {
    async get(input) {
      const body = await transport.readJson(
        transport.api.v1.threads[":id"].tabs.$get(
          { param: { id: input.threadId } },
          ...signalRequestArgs(input.signal),
        ),
      );

      return threadTabsResponseSchema.parse(body);
    },
    async update(input) {
      const body = await transport.readJson(
        transport.api.v1.threads[":id"].tabs.$put({
          param: { id: input.threadId },
          json: {
            expectedRevision: input.expectedRevision,
            tabs: input.tabs,
          },
        }),
      );

      return threadTabsResponseSchema.parse(body);
    },
  };

  return {
    archive: archiveAll,
    archiveAll,
    async childSummary(input) {
      return transport.readJson(
        transport.api.v1.threads[":id"]["child-summary"].$get(
          { param: { id: input.threadId } },
          ...signalRequestArgs(input.signal),
        ),
      );
    },
    async conversation(input) {
      return transport.readJson(
        transport.api.v1.threads[":id"].conversation.$get(
          {
            param: { id: input.threadId },
            query: {
              ...(input.afterSeq === undefined
                ? {}
                : { afterSeq: input.afterSeq }),
              ...(input.throughSeq === undefined
                ? {}
                : { throughSeq: input.throughSeq }),
              ...(input.limit === undefined ? {} : { limit: input.limit }),
            },
          },
          ...signalRequestArgs(input.signal),
        ),
      );
    },
    async conversationOutline(input) {
      return transport.readJson(
        transport.api.v1.threads[":id"]["conversation-outline"].$get(
          {
            param: { id: input.threadId },
            query: input.role === undefined ? {} : { role: input.role },
          },
          ...signalRequestArgs(input.signal),
        ),
      );
    },
    async count(input) {
      return transport.readJson(
        transport.api.v1.threads.count.$get(
          { query: countQuery(input) },
          ...signalRequestArgs(input?.signal),
        ),
      );
    },
    async listRunning(input) {
      return transport.readJson(
        transport.api.v1.threads.running.$get(
          {},
          ...signalRequestArgs(input?.signal),
        ),
      );
    },
    async defaultExecutionOptions(input) {
      return transport.readJson(
        transport.api.v1.threads[":id"]["default-execution-options"].$get(
          { param: { id: input.threadId } },
          ...signalRequestArgs(input.signal),
        ),
      );
    },
    async delete(input) {
      await transport.readVoid(
        transport.api.v1.threads[":id"].$delete({
          param: { id: input.threadId },
          json: {
            childThreadsConfirmed: input.childThreadsConfirmed,
          },
        }),
      );

      return { ok: true };
    },
    async editMessage(input) {
      const { threadId, ...json } = input;

      return transport.readJson(
        transport.api.v1.threads[":id"]["edit-message"].$post({
          param: { id: threadId },
          json,
        }),
      );
    },
    async experimental_lookupCommandProofs(input) {
      return transport.readJson(
        transport.api.v1.threads[":id"]["command-proofs"].$post(
          {
            param: { id: input.threadId },
            json: { selectors: input.selectors },
          },
          ...signalRequestArgs(input.signal),
        ),
      );
    },
    events,
    async fork(input) {
      return transport.readJson(
        transport.api.v1.threads.fork.$post({
          json: forkJson(input),
        }),
      );
    },
    get: getThread,
    async experimental_work(input) {
      return transport.readJson(
        transport.api.v1.threads[":id"].work.$get(
          { param: { id: input.threadId } },
          ...signalRequestArgs(input.signal),
        ),
      );
    },
    async experimental_publishWork(input) {
      return transport.readJson(
        transport.api.v1.threads[":id"].work.$post(
          {
            param: { id: input.threadId },
            json: publishThreadWorkSchema.parse({
              pluginId: input.pluginId,
              contribution: input.contribution,
            }),
          },
          ...signalRequestArgs(input.signal),
        ),
      );
    },
    async experimental_archiveReady(input) {
      return transport.readJson(
        transport.api.v1.threads[":id"]["archive-ready"].$post(
          { param: { id: input.threadId }, json: { basis: input.basis } },
          ...signalRequestArgs(input.signal),
        ),
      );
    },
    async experimental_listAncestors(input) {
      return transport.readJson(
        transport.api.v1.threads.ancestors.$post(
          { json: { threadIds: [...input.threadIds] } },
          ...signalRequestArgs(input.signal),
        ),
      );
    },
    async experimental_listDescendants(input) {
      return transport.readJson(
        transport.api.v1.threads.descendants.$post(
          {
            json: {
              threadIds: [...input.threadIds],
              ...(input.includeArchived === undefined
                ? {}
                : { includeArchived: input.includeArchived }),
              ...(input.includeHidden === undefined
                ? {}
                : { includeHidden: input.includeHidden }),
            },
          },
          ...signalRequestArgs(input.signal),
        ),
      );
    },
    async experimental_listPluginMetadata(input) {
      return transport.readJson(
        transport.api.v1.threads["plugin-metadata"].$post(
          {
            json: { pluginId: input.pluginId, threadIds: [...input.threadIds] },
          },
          ...signalRequestArgs(input.signal),
        ),
      );
    },
    async getPluginMetadata(input) {
      return transport.readJson(
        transport.api.v1.threads[":id"]["plugin-metadata"].$get(
          {
            param: { id: input.threadId },
            query: { pluginId: input.pluginId },
          },
          ...signalRequestArgs(input.signal),
        ),
      );
    },
    async updatePluginMetadata(input) {
      return transport.readJson(
        transport.api.v1.threads[":id"]["plugin-metadata"].$patch(
          {
            param: { id: input.threadId },
            json: {
              pluginId: input.pluginId,
              ...(input.set === undefined
                ? {}
                : { set: validatePluginMetadata(input.set) }),
              ...(input.remove === undefined ? {} : { remove: input.remove }),
            },
          },
          ...signalRequestArgs(input.signal),
        ),
      );
    },
    queue,
    interactions,
    async list(input) {
      return transport.readJson(
        transport.api.v1.threads.$get(
          { query: listQuery(input) },
          ...signalRequestArgs(input?.signal),
        ),
      );
    },
    async markRead(input) {
      return transport.readJson(
        transport.api.v1.threads[":id"].read.$post(
          {
            param: { id: input.threadId },
          },
          ...signalRequestArgs(input.signal),
        ),
      );
    },
    async markUnread(input) {
      return transport.readJson(
        transport.api.v1.threads[":id"].unread.$post(
          {
            param: { id: input.threadId },
          },
          ...signalRequestArgs(input.signal),
        ),
      );
    },
    async message(input) {
      return transport.readJson(
        transport.api.v1.threads[":id"].messages[":seq"].$get(
          {
            param: { id: input.threadId, seq: String(input.seq) },
            query: {
              ...(input.before === undefined
                ? {}
                : { before: String(input.before) }),
              ...(input.after === undefined
                ? {}
                : { after: String(input.after) }),
            },
          },
          ...signalRequestArgs(input.signal),
        ),
      );
    },
    async output(input) {
      return transport.readJson(
        transport.api.v1.threads[":id"].output.$get(
          { param: { id: input.threadId } },
          ...signalRequestArgs(input.signal),
        ),
      );
    },
    async open(input) {
      return transport.readJson(
        transport.api.v1.threads[":id"].open.$post({
          param: { id: input.threadId },
          json: {
            ...(input.split === undefined ? {} : { split: input.split }),
            file: input.file,
          },
        }),
      );
    },
    async paneAction(input) {
      return transport.readJson(
        transport.api.v1.threads[":id"]["pane-action"].$post({
          param: { id: input.threadId },
          json: { action: input.action },
        }),
      );
    },
    async pin(input) {
      return transport.readJson(
        transport.api.v1.threads[":id"].pin.$post({
          param: { id: input.threadId },
        }),
      );
    },
    async promptHistory(input) {
      return transport.readJson(
        transport.api.v1.threads[":id"]["prompt-history"].$get(
          {
            param: { id: input.threadId },
            query: { limit: input.limit },
          },
          ...signalRequestArgs(input.signal),
        ),
      );
    },
    queuedMessages,
    submissions,
    async reorderPinned(input) {
      return transport.readJson(
        transport.api.v1.threads[":id"]["pin-order"].$patch({
          param: { id: input.threadId },
          json: {
            previousThreadId: input.previousThreadId,
            nextThreadId: input.nextThreadId,
          },
        }),
      );
    },
    async experimental_reorderShelved(input) {
      return transport.readJson(
        transport.api.v1.threads[":id"]["shelf-order"].$patch({
          param: { id: input.threadId },
          json: {
            previousThreadId: input.previousThreadId,
            nextThreadId: input.nextThreadId,
          },
        }),
      );
    },
    async resolveMentions(input) {
      return transport.readJson(
        transport.api.v1.threads["resolve-mentions"].$post(
          { json: { threadIds: input.threadIds } },
          ...signalRequestArgs(input.signal),
        ),
      );
    },
    async search(input) {
      return transport.readJson(
        transport.api.v1.threads.search.$get(
          { query: searchQuery(input) },
          ...signalRequestArgs(input.signal),
        ),
      );
    },
    async send(input) {
      return transport.readJson(
        transport.api.v1.threads[":id"].send.$post({
          param: { id: input.threadId },
          json: sendJson(input),
        }),
      );
    },
    async shelve(input) {
      const response = await transport.resolve(
        transport.api.v1.threads[":id"].shelve.$post({
          param: { id: input.threadId },
        }),
      );

      input.experimental_onServerTiming?.(
        response.headers.get("server-timing"),
      );

      return response.json();
    },
    async restoreEnvironment(input) {
      return transport.readJson(
        transport.api.v1.threads[":id"]["restore-environment"].$post({
          param: { id: input.threadId },
        }),
      );
    },
    async experimental_importNative(input) {
      const { signal, origin, ...json } = input;

      return transport.readJson(
        transport.api.v1.threads.import.$post(
          { json: { ...json, origin: origin ?? "sdk" } },
          ...signalRequestArgs(signal),
        ),
      );
    },
    async experimental_nativeSessionClaims(input) {
      const { signal, ...query } = input;

      return transport.readJson(
        transport.api.v1.threads["native-sessions"].$get(
          { query },
          ...signalRequestArgs(signal),
        ),
      );
    },
    async experimental_listStartMachines(input) {
      return transport.readJson(
        transport.api.v1.threads[":id"]["start-machines"].$get({
          param: { id: input.threadId },
          query:
            input.pluginId === undefined ? {} : { pluginId: input.pluginId },
        }),
      );
    },
    async experimental_moveStart(input) {
      const { signal: _signal, threadId, initiator, ...json } = input;

      return transport.readJson(
        transport.api.v1.threads[":id"]["start-machine"].$post({
          param: { id: threadId },
          json: { ...json, initiator: initiator ?? { kind: "person" } },
        }),
      );
    },
    async retry(input) {
      return transport.readJson(
        transport.api.v1.threads[":id"].retry.$post({
          param: { id: input.threadId },
          json: retryJson(input),
        }),
      );
    },
    async experimental_continue(input) {
      return transport.readJson(
        transport.api.v1.threads[":id"].continue.$post({
          param: { id: input.threadId },
          query: { now: input.now ? "true" : undefined, model: input.model },
        }),
      );
    },
    async experimental_continueAll() {
      return transport.readJson(
        transport.api.v1.threads["continue-all"].$post(),
      );
    },
    async experimental_continuationState(input) {
      return transport.readJson(
        transport.api.v1.threads[":id"].continue.$get(
          { param: { id: input.threadId } },
          ...signalRequestArgs(input.signal),
        ),
      );
    },
    async experimental_continuations(input) {
      return transport.readJson(
        transport.api.v1.threads.continuations.eligible.$get(
          undefined,
          ...signalRequestArgs(input?.signal),
        ),
      );
    },
    async spawn(input) {
      return transport.readJson(
        transport.api.v1.threads.$post({
          json: spawnJson(input),
        }),
      );
    },
    async stop(input) {
      await transport.readVoid(
        transport.api.v1.threads[":id"].stop.$post({
          param: { id: input.threadId },
        }),
      );

      return { ok: true };
    },
    async compact(input) {
      await transport.readVoid(
        transport.api.v1.threads[":id"].compact.$post({
          param: { id: input.threadId },
        }),
      );

      return { ok: true };
    },
    async clearContext(input) {
      await transport.readVoid(
        transport.api.v1.threads[":id"].context.clear.$post({
          param: { id: input.threadId },
        }),
      );

      return { ok: true };
    },
    async cancelPlan(input) {
      await transport.readVoid(
        transport.api.v1.threads[":id"].plan.cancel.$post({
          param: { id: input.threadId },
        }),
      );

      return { ok: true };
    },
    async clearGoal(input) {
      await transport.readVoid(
        transport.api.v1.threads[":id"].goal.clear.$post({
          param: { id: input.threadId },
        }),
      );

      return { ok: true };
    },
    tabs,
    async context(input) {
      return transport.readJson(
        transport.api.v1.threads[":id"].context.$get(
          { param: { id: input.threadId } },
          ...signalRequestArgs(input.signal),
        ),
      );
    },
    async experimental_setAutoCompaction(input) {
      return transport.readJson(
        transport.api.v1.threads[":id"]["auto-compaction"].$put({
          param: { id: input.threadId },
          json: { enabled: input.enabled },
        }),
      );
    },
    async timeline(input) {
      return transport.readJson(
        transport.api.v1.threads[":id"].timeline.$get(
          {
            param: { id: input.threadId },
            query: timelineQuery(input),
          },
          ...signalRequestArgs(input.signal),
        ),
      );
    },
    async timelineTurnSummaryDetails(input) {
      return transport.readJson(
        transport.api.v1.threads[":id"].timeline["turn-summary-details"].$get(
          {
            param: { id: input.threadId },
            query: {
              turnId: input.turnId,
              sourceSeqStart: input.sourceSeqStart,
              sourceSeqEnd: input.sourceSeqEnd,
              ...(input.beforeCursor === undefined
                ? {}
                : { beforeCursor: input.beforeCursor }),
              ...(input.deferContent === undefined
                ? {}
                : { deferContent: input.deferContent }),
              ...(input.itemId === undefined ? {} : { itemId: input.itemId }),
            },
          },
          ...signalRequestArgs(input.signal),
        ),
      );
    },
    async storageFiles(input) {
      return transport.readJson(
        transport.api.v1.threads[":id"]["thread-storage"].files.$get(
          {
            param: { id: input.threadId },
            query: { query: input.query, limit: input.limit },
          },
          ...signalRequestArgs(input.signal),
        ),
      );
    },
    async storageLocation(input) {
      return transport.readJson(
        transport.api.v1.threads[":id"]["thread-storage"].location.$get(
          {
            param: { id: input.threadId },
          },
          ...signalRequestArgs(input.signal),
        ),
      );
    },
    async storagePaths(input) {
      return transport.readJson(
        transport.api.v1.threads[":id"]["thread-storage"].paths.$get(
          {
            param: { id: input.threadId },
            query: {
              query: input.query,
              limit: input.limit,
              includeFiles: input.includeFiles,
              includeDirectories: input.includeDirectories,
            },
          },
          ...signalRequestArgs(input.signal),
        ),
      );
    },
    async unarchive(input) {
      await transport.readVoid(
        transport.api.v1.threads[":id"].unarchive.$post({
          param: { id: input.threadId },
        }),
      );

      return { ok: true };
    },
    async unpin(input) {
      return transport.readJson(
        transport.api.v1.threads[":id"].unpin.$post({
          param: { id: input.threadId },
        }),
      );
    },
    async unshelve(input) {
      return transport.readJson(
        transport.api.v1.threads[":id"].unshelve.$post({
          param: { id: input.threadId },
        }),
      );
    },
    async update(input) {
      return transport.readJson(
        transport.api.v1.threads[":id"].$patch(
          {
            param: { id: input.threadId },
            json: updateJson(input),
          },
          ...signalRequestArgs(input.signal),
        ),
      );
    },
    async wait(input) {
      const { pollIntervalMs, target, timeoutMs } =
        validateThreadWaitArgs(input);

      const deadline = Date.now() + timeoutMs;

      while (true) {
        if (target.kind === "status") {
          const thread = await getThread({
            signal: input.signal,
            threadId: input.threadId,
          });

          if (thread.status === target.status) {
            return {
              matched: true,
              target,
              thread,
              threadId: input.threadId,
            };
          }

          const unreachable = isThreadWaitTargetUnreachable(
            thread.status,
            target,
          );

          const pendingRetry = unreachable
            ? ((
                await queuedMessages.list({
                  signal: input.signal,
                  threadId: input.threadId,
                })
              ).find(
                (row) =>
                  row.payload.kind === "retry" &&
                  row.failureReason === null &&
                  row.waitingOn?.kind !== "superseded",
              ) ?? null)
            : null;

          if (unreachable && pendingRetry === null) {
            throw new ThreadWaitUnreachableError({
              currentStatus: thread.status,
              target,
              threadId: input.threadId,
            });
          }

          if (Date.now() >= deadline) {
            throw new ThreadWaitTimeoutError({
              pendingRetry,
              target,
              threadId: input.threadId,
            });
          }

          await sleep(pollIntervalMs);
          continue;
        }

        const remainingMs = Math.max(0, deadline - Date.now());
        const waitMs = Math.floor(Math.min(remainingMs, 30_000));

        const event = await events.wait({
          signal: input.signal,
          threadId: input.threadId,
          type: target.eventType,
          waitMs: String(waitMs),
        });

        if (event !== null) {
          return {
            event,
            matched: true,
            target,
            threadId: input.threadId,
          };
        }

        if (Date.now() >= deadline) {
          throw new ThreadWaitTimeoutError({
            target,
            threadId: input.threadId,
          });
        }

        await sleep(pollIntervalMs);
      }
    },
  };
}
