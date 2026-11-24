import {
  supersedeQueuedRetriesInTransaction,
  appendStoredThreadEventsInTransaction,
  createEventId,
  getActiveStoredTurnId,
  isStoredTurnMainRunIdle,
  getLastStoredProviderThreadId,
  getLastStoredTurnRequestEvent,
  getStoredProviderSession,
  getStoredTurnRequestEventForTurn,
  getThread,
  listStoredTurnStartedKeys,
  listStoredClientTurnRequestRowsByKeys,
  noopNotifier,
  updateThread,
  type StoredTurnRequestEventRow,
} from "@omnyo/db";
import {
  CLIENT_TURN_REQUEST_ID_ALPHABET,
  CLIENT_TURN_REQUEST_ID_SUFFIX_LENGTH,
  encodeClientTurnRequestIdAlphabetIndexes,
  getThreadEventScopeTurnId,
  isStandaloneBuiltinCompactCommand,
  parseStoredThreadEvent,
  systemErrorEventDataSchema,
  threadScope,
  turnRequestEventDataSchema,
  WORKSPACE_PROVISIONING_STEP_KEYS,
} from "@omnyo/domain";
import { randomBytes } from "node:crypto";
import type {
  ClientTurnRequestId,
  ClientTurnLifecycleEventData,
  PromptInput,
  ProvisioningTranscriptEntry,
  RecordedThreadExecutionOptions,
  SystemThreadProvisioningStatus,
  TurnRequestEventData,
  TurnRequestTarget,
  ThreadEventType,
  ResolvedThreadExecutionOptions,
  SystemErrorEventData,
  SystemThreadInterruptedReason,
  SystemMessageKind,
  SystemMessageSubject,
  ThreadEventScope,
  ThreadMaintenanceKind,
  ThreadTurnInitiator,
  ThreadChangeKind,
  ThreadChangeMetadata,
  Thread,
} from "@omnyo/domain";
import { ApiError, TurnStartGuardError } from "../../errors.js";
import type { AppDeps } from "../../types.js";
import {
  NotificationBuffer,
  type BufferedTransaction,
} from "../lib/notification-buffer.js";
import { parseStoredEventPayload } from "./thread-data.js";
import { isOwnerTurnRequest, recordOwnerTurnRequest } from "../inbox/engine.js";
import type { DbNotifier, DbQueryConnection, DbTransaction } from "@omnyo/db";
import type { AppendStoredThreadEventArgs as AppendThreadEventArgs } from "@omnyo/db";

interface ThreadEventReadDeps {
  db: DbQueryConnection;
}

interface ThreadEventTransactionDeps {
  db: DbTransaction;
  hub: DbNotifier;
}

type NonTurnRequestThreadEventType = Exclude<
  ThreadEventType,
  "client/turn/requested"
>;

export interface TurnRequestRetryMarker {
  requestId: ClientTurnRequestId;
  attempt: number;
}

interface ClientTurnRequestedEventArgs {
  requestId?: ClientTurnRequestId;
  retryOf?: TurnRequestRetryMarker;
  environmentId: string | null;
  execution: ResolvedThreadExecutionOptions;
  initiator: ThreadTurnInitiator;
  input: PromptInput[];
  inputGroups?: PromptInput[][];
  requestMethod: "thread/start" | "turn/start";
  senderThreadId: string | null;
  source: "spawn" | "tell";
  systemMessageKind?: SystemMessageKind;
  systemMessageSubject?: SystemMessageSubject | null;
  maintenance?: ThreadMaintenanceKind;
  target: TurnRequestTarget;
  threadId: string;
  type: "client/turn/requested";
}

interface PreparedClientTurnRequestedEventArgs extends ClientTurnRequestedEventArgs {
  requestId: ClientTurnRequestId;
}

interface ClientTurnLifecycleEventArgs {
  environmentId: string | null;
  initiator: ThreadTurnInitiator;
  requestMethod: "thread/start" | "turn/start";
  source: "spawn" | "tell";
  threadId: string;
  type: "client/thread/start";
}

type ClientTurnEventArgs =
  | ClientTurnLifecycleEventArgs
  | ClientTurnRequestedEventArgs;

interface AppendedClientTurnRequest {
  requestId: ClientTurnRequestId;
  sequence: number;
}

export interface AppendedClientTurnRequestWithNotification extends AppendedClientTurnRequest {
  notificationChanges: ThreadChangeKind[];
  notificationMetadata: ThreadChangeMetadata;
}

type ThreadOwnershipChangeAction = "assign" | "release" | "transfer";

interface AppendThreadOwnershipChangeEventArgs {
  environmentId?: string | null;
  nextParentThreadId: string | null;
  previousParentThreadId: string | null;
  threadId: string;
}

interface AppendSystemErrorEventArgs extends Pick<
  SystemErrorEventData,
  "errorInfo" | "rateLimits" | "expectedFailure"
> {
  code: string;
  commandErrorCode?: string;
  detail?: string;
  environmentId?: string | null;
  message: string;
  scope: ThreadEventScope;
  threadId: string;
}

interface AppendThreadProvisioningEventArgs {
  entries: ProvisioningTranscriptEntry[];
  environmentId: string | null;
  provisioningId: string;
  status: SystemThreadProvisioningStatus;
  threadId: string;
}

interface BuildCwdBranchEntriesArgs {
  branchName: string | null;
  headSha: string | null;
  path: string;
}

interface AppendThreadInterruptedEventArgs {
  reason: SystemThreadInterruptedReason;
  threadId: string;
}

const LEGACY_THREAD_START_TARGET = {
  kind: "thread-start",
} satisfies TurnRequestTarget;

const LEGACY_NEW_TURN_TARGET = { kind: "new-turn" } satisfies TurnRequestTarget;

type LegacyTurnRequestEventType = "client/thread/start" | "client/turn/start";

const LEGACY_TURN_REQUEST_TARGET_BY_TYPE = {
  "client/thread/start": LEGACY_THREAD_START_TARGET,
  "client/turn/start": LEGACY_NEW_TURN_TARGET,
} satisfies Record<LegacyTurnRequestEventType, TurnRequestTarget>;

interface TurnStartKey {
  threadId: string;
  turnId: string;
}

function legacyTurnRequestTargetForType(
  type: LegacyTurnRequestEventType,
): TurnRequestTarget {
  return LEGACY_TURN_REQUEST_TARGET_BY_TYPE[type];
}

function buildClientTurnBaseEventData(
  args: ClientTurnEventArgs,
): ClientTurnLifecycleEventData {
  return {
    direction: "outbound",
    source: args.source,
    initiator: args.initiator,
    request: {
      method: args.requestMethod,
      params: {},
    },
  };
}

function buildClientTurnRequestedEventData(
  args: ClientTurnRequestedEventArgs,
  requestId: ClientTurnRequestId,
): TurnRequestEventData {
  return {
    ...buildClientTurnBaseEventData(args),
    requestId,
    ...(args.retryOf !== undefined
      ? {
          retryOfRequestId: args.retryOf.requestId,
          retryAttempt: args.retryOf.attempt,
        }
      : {}),
    senderThreadId: args.senderThreadId,
    ...(args.systemMessageKind !== undefined
      ? { systemMessageKind: args.systemMessageKind }
      : {}),
    ...(args.systemMessageSubject !== undefined
      ? { systemMessageSubject: args.systemMessageSubject }
      : {}),
    ...(args.maintenance !== undefined
      ? { maintenance: args.maintenance }
      : {}),
    input: args.input,
    ...(args.inputGroups !== undefined
      ? { inputGroups: args.inputGroups }
      : {}),
    target: args.target,
    execution: args.execution,
  };
}

type AppendClientTurnEvent = (args: AppendThreadEventArgs) => number;

interface ThreadReadStateUpdate {
  changed: boolean;
  projectId: string;
  threadId: string;
}

interface AppendThreadEventTransactionResult {
  readStateUpdate: ThreadReadStateUpdate | null;
  sequence: number;
}

interface AppendThreadEventsTransactionResult {
  readStateUpdates: readonly ThreadReadStateUpdate[];
  sequences: number[];
}

interface BuildAppendThreadEventNotificationMetadataArgs {
  sequence: number;
  readStateUpdate: ThreadReadStateUpdate | null;
  eventType: ThreadEventType;
}

export function createClientTurnRequestId(): ClientTurnRequestId {
  const bytes = randomBytes(CLIENT_TURN_REQUEST_ID_SUFFIX_LENGTH);

  return encodeClientTurnRequestIdAlphabetIndexes({
    indexes: [...bytes].map(
      (byte) => byte % CLIENT_TURN_REQUEST_ID_ALPHABET.length,
    ),
  });
}

function buildClientTurnRequestedEventArgs(
  args: PreparedClientTurnRequestedEventArgs,
): AppendThreadEventArgs<"client/turn/requested"> {
  return {
    threadId: args.threadId,
    environmentId: args.environmentId,
    type: args.type,
    scope: threadScope(),
    data: buildClientTurnRequestedEventData(args, args.requestId),
  };
}

function appendBuiltClientTurnRequestedEvent(
  append: AppendClientTurnEvent,
  args: PreparedClientTurnRequestedEventArgs,
): AppendedClientTurnRequest {
  const sequence = append(buildClientTurnRequestedEventArgs(args));

  return { requestId: args.requestId, sequence };
}

function appendBuiltClientTurnEvent(
  append: AppendClientTurnEvent,
  args: ClientTurnEventArgs,
): number | AppendedClientTurnRequest {
  switch (args.type) {
    case "client/thread/start":
      return append({
        threadId: args.threadId,
        environmentId: args.environmentId,
        type: args.type,
        scope: threadScope(),
        data: buildClientTurnBaseEventData(args),
      });
    case "client/turn/requested": {
      return appendBuiltClientTurnRequestedEvent(append, {
        ...args,
        requestId: args.requestId ?? createClientTurnRequestId(),
      });
    }
  }
}

function isThreadReadStateUpdate(
  result: ThreadReadStateUpdate | null,
): result is ThreadReadStateUpdate {
  return result !== null;
}

function applyUserTurnReadForEvent(
  db: DbTransaction,
  args: AppendThreadEventArgs,
): ThreadReadStateUpdate | null {
  if (args.type !== "client/turn/requested") {
    return null;
  }

  if (
    args.data.initiator !== "user" ||
    args.data.systemMessageKind === "external-message"
  ) {
    return null;
  }

  const previousThread = getThread(db, args.threadId);

  const updatedThread = updateThread(db, noopNotifier, args.threadId, {
    lastReadAt: Date.now(),
  });

  if (!previousThread || !updatedThread) {
    return null;
  }

  return {
    changed: updatedThread.lastReadAt !== previousThread.lastReadAt,
    projectId: updatedThread.projectId,
    threadId: updatedThread.id,
  };
}

function appendThreadEventsInTransactionWithAttention(
  deps: ThreadEventTransactionDeps,
  args: readonly AppendThreadEventArgs[],
): AppendThreadEventsTransactionResult {
  assertStoredTurnStartedForEvents(deps.db, args);
  const sequences = appendStoredThreadEventsInTransaction(deps.db, args);

  const readStateUpdates = args
    .map((eventArgs) => applyUserTurnReadForEvent(deps.db, eventArgs))
    .filter(isThreadReadStateUpdate);

  for (const eventArgs of args) {
    if (
      eventArgs.type === "client/turn/requested" &&
      isOwnerTurnRequest(eventArgs.data)
    ) {
      recordOwnerTurnRequest(deps.db, {
        threadId: eventArgs.threadId,
        requestId: eventArgs.data.requestId,
        now: Date.now(),
      });
    }
  }

  return { readStateUpdates, sequences };
}

function appendThreadEventInTransactionWithAttention(
  deps: ThreadEventTransactionDeps,
  args: AppendThreadEventArgs,
): AppendThreadEventTransactionResult {
  const result = appendThreadEventsInTransactionWithAttention(deps, [args]);
  const sequence = result.sequences[0];

  if (sequence === undefined) {
    throw new Error("Expected one appended thread event sequence");
  }

  return {
    readStateUpdate: result.readStateUpdates[0] ?? null,
    sequence,
  };
}

function buildAppendThreadEventNotificationChanges(
  readStateUpdate: ThreadReadStateUpdate | null,
): ThreadChangeKind[] {
  const changes: ThreadChangeKind[] = ["events-appended"];

  if (readStateUpdate?.changed === true) {
    changes.push("read-state-changed");
  }

  return changes;
}

function buildAppendThreadEventNotificationMetadata({
  sequence,
  readStateUpdate,
  eventType,
}: BuildAppendThreadEventNotificationMetadataArgs): ThreadChangeMetadata {
  const metadata: ThreadChangeMetadata = {
    eventTypes: [eventType],
    timelineSequence: sequence,
    eventSequenceRange: { from: sequence, to: sequence },
  };

  if (readStateUpdate?.changed === true) {
    metadata.projectId = readStateUpdate.projectId;
  }

  return metadata;
}

function getTurnStartKey(args: TurnStartKey): string {
  return `${args.threadId}\0${args.turnId}`;
}

function collectTurnStartRequirements(
  eventArgs: readonly AppendThreadEventArgs[],
): TurnStartKey[] {
  return eventArgs.flatMap((args) => {
    if (args.type === "turn/started") {
      return [];
    }

    const turnId = getThreadEventScopeTurnId(args.scope);

    if (turnId === undefined) {
      return [];
    }

    return [
      {
        threadId: args.threadId,
        turnId,
      },
    ];
  });
}

function listExistingTurnStartKeys(
  db: DbQueryConnection,
  requirements: readonly TurnStartKey[],
): Set<string> {
  return new Set(
    listStoredTurnStartedKeys(db, { keys: requirements }).map((key) =>
      getTurnStartKey(key),
    ),
  );
}

function assertStoredTurnStartedForEvents(
  db: DbQueryConnection,
  eventArgs: readonly AppendThreadEventArgs[],
): void {
  const existingTurnKeys = listExistingTurnStartKeys(
    db,
    collectTurnStartRequirements(eventArgs),
  );

  const startedTurnKeys = new Set<string>();

  for (const args of eventArgs) {
    if (args.type === "turn/started") {
      const turnId = getThreadEventScopeTurnId(args.scope);

      if (turnId !== undefined) {
        startedTurnKeys.add(
          getTurnStartKey({ threadId: args.threadId, turnId }),
        );
      }

      continue;
    }

    const turnId = getThreadEventScopeTurnId(args.scope);

    if (turnId === undefined) {
      continue;
    }

    const key = getTurnStartKey({ threadId: args.threadId, turnId });

    if (startedTurnKeys.has(key) || existingTurnKeys.has(key)) {
      continue;
    }

    throw new TurnStartGuardError({
      eventType: args.type,
      scopeKind: args.scope.kind,
      threadId: args.threadId,
      turnId,
    });
  }
}

export function appendThreadEvent<TType extends ThreadEventType>(
  deps: Pick<AppDeps, "db" | "hub">,
  args: AppendThreadEventArgs<TType>,
  beforeAppendInTransaction?: (args: BufferedTransaction) => void,
): number;
export function appendThreadEvent(
  deps: Pick<AppDeps, "db" | "hub">,
  args: AppendThreadEventArgs,
  beforeAppendInTransaction?: (args: BufferedTransaction) => void,
): number {
  const notifications = new NotificationBuffer();

  const result = deps.db.transaction(
    (tx) => {
      beforeAppendInTransaction?.({ tx, notifications });

      return appendThreadEventInTransactionWithAttention(
        { db: tx, hub: notifications },
        args,
      );
    },
    { behavior: "immediate" },
  );

  deps.hub.notifyThread(
    args.threadId,
    buildAppendThreadEventNotificationChanges(result.readStateUpdate),
    buildAppendThreadEventNotificationMetadata({
      sequence: result.sequence,
      readStateUpdate: result.readStateUpdate,
      eventType: args.type,
    }),
  );
  notifications.flushInto(deps.hub);

  return result.sequence;
}

export function appendThreadEventInTransaction<
  TType extends NonTurnRequestThreadEventType,
>(db: DbTransaction, args: AppendThreadEventArgs<TType>): number;
export function appendThreadEventInTransaction(
  db: DbTransaction,
  args: AppendThreadEventArgs<NonTurnRequestThreadEventType>,
): number {
  return appendThreadEventInTransactionWithAttention(
    { db, hub: noopNotifier },
    args,
  ).sequence;
}

export function appendThreadEventsInTransaction(
  db: DbTransaction,
  args: readonly AppendThreadEventArgs<NonTurnRequestThreadEventType>[],
): number[] {
  return appendThreadEventsInTransactionWithAttention(
    { db, hub: noopNotifier },
    args,
  ).sequences;
}

export function appendClientTurnEvent(
  deps: Pick<AppDeps, "db" | "hub">,
  args: ClientTurnRequestedEventArgs,
): AppendedClientTurnRequest;
export function appendClientTurnEvent(
  deps: Pick<AppDeps, "db" | "hub">,
  args: ClientTurnLifecycleEventArgs,
): number;
export function appendClientTurnEvent(
  deps: Pick<AppDeps, "db" | "hub">,
  args: ClientTurnEventArgs,
): number | AppendedClientTurnRequest {
  return appendBuiltClientTurnEvent(
    (eventArgs) => appendThreadEvent(deps, eventArgs),
    args,
  );
}

export function appendClientTurnEventInTransaction(
  deps: ThreadEventTransactionDeps,
  args: ClientTurnRequestedEventArgs,
): AppendedClientTurnRequest;
export function appendClientTurnEventInTransaction(
  deps: ThreadEventTransactionDeps,
  args: ClientTurnEventArgs,
): number | AppendedClientTurnRequest {
  if (args.type === "client/turn/requested")
    assertClientTurnRequestIdAvailable(deps.db, args);

  return appendBuiltClientTurnEvent(
    (eventArgs) =>
      appendThreadEventInTransactionWithAttention(deps, eventArgs).sequence,
    args,
  );
}

export function appendPreparedClientTurnRequestedEventWithNotificationInTransaction(
  deps: ThreadEventTransactionDeps,
  args: PreparedClientTurnRequestedEventArgs,
): AppendedClientTurnRequestWithNotification {
  assertClientTurnRequestIdAvailable(deps.db, args);

  const result = appendThreadEventInTransactionWithAttention(
    deps,
    buildClientTurnRequestedEventArgs(args),
  );

  const supersededRetries =
    args.initiator !== "system" || args.retryOf !== undefined
      ? supersedeQueuedRetriesInTransaction(deps.db, {
          threadId: args.threadId,
          retryOfTurnRequestId: args.retryOf?.requestId ?? null,
        })
      : 0;

  const notificationChanges = buildAppendThreadEventNotificationChanges(
    result.readStateUpdate,
  );

  return {
    requestId: args.requestId,
    sequence: result.sequence,
    notificationChanges:
      supersededRetries > 0
        ? [...notificationChanges, "queue-changed"]
        : notificationChanges,
    notificationMetadata: buildAppendThreadEventNotificationMetadata({
      sequence: result.sequence,
      readStateUpdate: result.readStateUpdate,
      eventType: args.type,
    }),
  };
}

function assertClientTurnRequestIdAvailable(
  db: DbQueryConnection,
  args: Pick<ClientTurnRequestedEventArgs, "requestId" | "threadId">,
): void {
  if (args.requestId === undefined) return;

  if (
    listStoredClientTurnRequestRowsByKeys(db, {
      keys: [
        {
          beforeSequence: null,
          threadId: args.threadId,
          requestId: args.requestId,
        },
      ],
    }).length > 0
  )
    throw new ApiError(
      409,
      "turn_request_id_conflict",
      "This message request has already been submitted.",
    );
}

export function parseStoredTurnRequestEvent(
  row: StoredTurnRequestEventRow,
): TurnRequestEventData {
  const payload = parseStoredEventPayload(row);

  let event;

  try {
    event = parseStoredThreadEvent({
      data: payload,
      threadId: row.threadId,
      type: row.type,
      scope: threadScope(),
    });
  } catch {
    throw new ApiError(
      500,
      "internal_error",
      `Stored ${row.type} event #${row.sequence} for thread ${row.threadId} is malformed`,
    );
  }

  if (event.type === "client/turn/requested") {
    const { type: _type, threadId: _threadId, scope: _scope, ...data } = event;

    return data;
  }

  if (row.type === "client/thread/start" || row.type === "client/turn/start") {
    const legacyTurnRequest = turnRequestEventDataSchema.safeParse({
      ...payload,
      target: legacyTurnRequestTargetForType(row.type),
    });

    if (legacyTurnRequest.success) {
      return legacyTurnRequest.data;
    }
  }

  throw new ApiError(
    500,
    "internal_error",
    `Stored ${row.type} event #${row.sequence} for thread ${row.threadId} is malformed`,
  );
}

function buildThreadProvisioningEventArgs(
  args: AppendThreadProvisioningEventArgs,
): AppendThreadEventArgs<"system/thread-provisioning"> {
  return {
    threadId: args.threadId,
    environmentId: args.environmentId,
    type: "system/thread-provisioning",
    scope: threadScope(),
    data: {
      provisioningId: args.provisioningId,
      status: args.status,
      environmentId: args.environmentId,
      entries: args.entries,
    },
  };
}

export function appendThreadProvisioningEvent(
  deps: Pick<AppDeps, "db" | "hub">,
  args: AppendThreadProvisioningEventArgs,
): number {
  return appendThreadEvent(deps, buildThreadProvisioningEventArgs(args));
}

export function appendThreadProvisioningEventInTransaction(
  db: DbTransaction,
  args: AppendThreadProvisioningEventArgs,
): number {
  return appendThreadEventInTransaction(
    db,
    buildThreadProvisioningEventArgs(args),
  );
}

export function buildCwdBranchEntries(
  args: BuildCwdBranchEntriesArgs,
): ProvisioningTranscriptEntry[] {
  const now = Date.now();

  const entries: ProvisioningTranscriptEntry[] = [
    {
      type: "step",
      key: WORKSPACE_PROVISIONING_STEP_KEYS.workspacePath,
      text: `Using workspace: ${args.path}`,
      status: "completed",
      startedAt: now,
    },
  ];

  if (args.branchName) {
    const sha = args.headSha;
    entries.push({
      type: "step",
      key: WORKSPACE_PROVISIONING_STEP_KEYS.workspaceBranch,
      text:
        sha === null
          ? `Using branch: ${args.branchName}`
          : `Using branch: ${args.branchName} (${sha.slice(0, 7)})`,
      status: "completed",
      startedAt: now,
      metadata:
        sha === null
          ? { branchName: args.branchName }
          : { branchName: args.branchName, sha },
    });
  }

  return entries;
}

function buildSystemErrorEventArgs(
  args: AppendSystemErrorEventArgs,
): AppendThreadEventArgs<"system/error"> {
  return {
    threadId: args.threadId,
    environmentId: args.environmentId ?? null,
    type: "system/error",
    scope: args.scope,
    data: buildSystemErrorEventData(args),
  };
}

export function appendSystemErrorEvent(
  deps: Pick<AppDeps, "db" | "hub">,
  args: AppendSystemErrorEventArgs,
): number {
  return appendThreadEvent(deps, buildSystemErrorEventArgs(args));
}

export function appendSystemErrorEventInTransaction(
  deps: ThreadEventTransactionDeps,
  args: AppendSystemErrorEventArgs,
): number {
  const sequence = appendThreadEventInTransaction(
    deps.db,
    buildSystemErrorEventArgs(args),
  );

  deps.hub.notifyThread(args.threadId, ["events-appended"], {
    timelineSequence: sequence,
    eventTypes: ["system/error"],
  });

  return sequence;
}

export function buildSystemErrorEventData(
  args: Pick<
    AppendSystemErrorEventArgs,
    | "code"
    | "commandErrorCode"
    | "expectedFailure"
    | "detail"
    | "message"
    | "errorInfo"
    | "rateLimits"
  >,
): SystemErrorEventData {
  return systemErrorEventDataSchema.parse({
    code: args.code,
    message: args.message,
    expectedFailure: args.expectedFailure,
    commandErrorCode: args.commandErrorCode,
    errorInfo: args.errorInfo,
    rateLimits: args.rateLimits,
    ...(args.detail ? { detail: args.detail } : {}),
  });
}

export function appendThreadInterruptedEventInTransaction(
  db: DbTransaction,
  args: AppendThreadInterruptedEventArgs,
): number {
  return appendThreadEventInTransaction(db, {
    threadId: args.threadId,
    type: "system/thread/interrupted",
    scope: threadScope(),
    data: {
      reason: args.reason,
    },
  });
}

function resolveThreadOwnershipChangeAction(
  args: AppendThreadOwnershipChangeEventArgs,
): ThreadOwnershipChangeAction | null {
  const { previousParentThreadId, nextParentThreadId } = args;

  if (previousParentThreadId === nextParentThreadId) {
    return null;
  }

  if (previousParentThreadId === null && nextParentThreadId !== null) {
    return "assign";
  }

  if (previousParentThreadId !== null && nextParentThreadId === null) {
    return "release";
  }

  if (previousParentThreadId !== null && nextParentThreadId !== null) {
    return "transfer";
  }

  return null;
}

function threadOwnershipChangeMessage(
  action: ThreadOwnershipChangeAction,
): string {
  switch (action) {
    case "assign":
      return "Thread assigned to parent";
    case "release":
      return "Thread released from parent";
    case "transfer":
      return "Thread transferred to new parent";
  }
}

function resolveParentThreadTitle(
  db: DbQueryConnection,
  parentThreadId: string | null,
): string | null {
  if (parentThreadId === null) {
    return null;
  }

  const thread = getThread(db, parentThreadId);

  if (!thread) {
    return null;
  }

  return thread.title ?? thread.titleFallback ?? null;
}

function buildThreadOwnershipChangeEventArgs(
  db: DbQueryConnection,
  args: AppendThreadOwnershipChangeEventArgs,
): AppendThreadEventArgs<"system/operation"> | null {
  const action = resolveThreadOwnershipChangeAction(args);

  if (!action) {
    return null;
  }

  const previousParentThreadTitle = resolveParentThreadTitle(
    db,
    args.previousParentThreadId,
  );

  const nextParentThreadTitle = resolveParentThreadTitle(
    db,
    args.nextParentThreadId,
  );

  return {
    threadId: args.threadId,
    environmentId: args.environmentId ?? null,
    type: "system/operation",
    scope: threadScope(),
    data: {
      operation: "ownership_change",
      operationId: createEventId(),
      status: "completed",
      message: threadOwnershipChangeMessage(action),
      metadata: {
        action,
        previousParentThreadId: args.previousParentThreadId,
        previousParentThreadTitle,
        nextParentThreadId: args.nextParentThreadId,
        nextParentThreadTitle,
      },
    },
  };
}

export function appendThreadOwnershipChangeEvent(
  deps: Pick<AppDeps, "db" | "hub">,
  args: AppendThreadOwnershipChangeEventArgs,
): number | null {
  const eventArgs = buildThreadOwnershipChangeEventArgs(deps.db, args);

  return eventArgs === null ? null : appendThreadEvent(deps, eventArgs);
}

export function appendThreadOwnershipChangeEventInTransaction(
  deps: ThreadEventTransactionDeps,
  args: AppendThreadOwnershipChangeEventArgs,
): number | null {
  const eventArgs = buildThreadOwnershipChangeEventArgs(deps.db, args);

  if (eventArgs === null) {
    return null;
  }

  const sequence = appendThreadEventInTransaction(deps.db, eventArgs);
  deps.hub.notifyThread(args.threadId, ["events-appended"], {
    timelineSequence: sequence,
  });

  return sequence;
}

export function getActiveTurnId(
  deps: ThreadEventReadDeps,
  threadId: string,
): string | null {
  return getActiveStoredTurnId(deps.db, threadId);
}

export function isActiveTurnMainRunIdle(
  deps: ThreadEventReadDeps,
  thread: Pick<Thread, "id" | "status">,
): boolean {
  if (thread.status !== "active") {
    return false;
  }

  const activeTurnId = getActiveStoredTurnId(deps.db, thread.id);

  return (
    activeTurnId !== null &&
    isStoredTurnMainRunIdle(deps.db, {
      threadId: thread.id,
      turnId: activeTurnId,
    })
  );
}

export function isManualCompactionActive(
  deps: ThreadEventReadDeps,
  thread: Pick<Thread, "id" | "status">,
): boolean {
  if (thread.status !== "active") {
    return false;
  }

  const activeTurnId = getActiveStoredTurnId(deps.db, thread.id);

  const requestRow = activeTurnId
    ? (getStoredTurnRequestEventForTurn(deps.db, {
        threadId: thread.id,
        turnId: activeTurnId,
      }) ?? getLastStoredTurnRequestEvent(deps.db, thread.id))
    : getLastStoredTurnRequestEvent(deps.db, thread.id);

  if (!requestRow) {
    return false;
  }

  const request = parseStoredTurnRequestEvent(requestRow);

  return (
    request.target.kind === "new-turn" &&
    isStandaloneBuiltinCompactCommand(request.input)
  );
}

export function getLastProviderThreadId(
  deps: ThreadEventReadDeps,
  threadId: string,
): string | null {
  return getLastStoredProviderThreadId(deps.db, threadId);
}

export function requireDispatchableProviderThreadId(
  deps: ThreadEventReadDeps,
  threadId: string,
): string | null {
  const session = getStoredProviderSession(deps.db, threadId);

  switch (session.kind) {
    case "none":
      return null;
    case "owned":
      return session.providerThreadId;
    case "invalid":
    case "ambiguous":
    case "foreign":
      throw new ApiError(
        409,
        "provider_session_unavailable",
        session.kind === "invalid"
          ? "This thread has a stored identity without a valid provider session, so Omnyo will not replace it silently. Clear context (/clear or omnyo thread clear) for a new session; history is kept."
          : session.kind === "ambiguous"
            ? "Another thread claimed this thread's provider session in the same millisecond, so Omnyo will not guess whose it is. Clear context (/clear or omnyo thread clear) for a new session; history is kept."
            : "This thread's only provider session belongs to another thread, so Omnyo will not resume it. Clear context (/clear or omnyo thread clear) for a new session; history is kept.",
        {
          details: {
            reason: session.kind,
            providerThreadId: session.providerThreadId,
            claimantThreadIds: session.claimantThreadIds,
          },
        },
      );
  }
}

export function getLastExecutionOptions(
  deps: Pick<AppDeps, "db">,
  threadId: string,
): RecordedThreadExecutionOptions | null {
  const row = getLastStoredTurnRequestEvent(deps.db, threadId);

  return row ? parseStoredTurnRequestEvent(row).execution : null;
}
