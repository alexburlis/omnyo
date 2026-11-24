import {
  getLatestThreadSequence,
  getNativeThreadImport,
  getNonDestroyedHostByLaunchKey,
  hasThreadNativeSessionHistory,
} from "@omnyo/db";
import { sweepProviderMachine } from "../machines/provider-orchestration.js";
import { cancelProviderEnvironmentCreation } from "../environments/environment-engine.js";
import { getPreparingEnvironment } from "@omnyo/db";
import { getThread, type EnvironmentRow } from "@omnyo/db";
import {
  type ClientTurnRequestId,
  type EnvironmentProviderSelection,
  type PromptInput,
  type ResolvedThreadExecutionOptions,
  type SystemMessageKind,
  type SystemMessageSubject,
  type Thread,
  type ThreadTurnInitiator,
  type TurnRequestTarget,
} from "@omnyo/domain";
import type { StartedOnBehalfOf } from "@omnyo/domain";
import type { AppDeps } from "../../types.js";
import { ApiError } from "../../errors.js";
import { resolveNativeImportFork } from "./native-import-fork.js";
import { requestQueuedMessageDispatch } from "./queued-message-dispatch.js";
import {
  appendClientTurnEvent,
  appendPreparedClientTurnRequestedEventWithNotificationInTransaction,
  appendThreadProvisioningEvent,
  appendThreadProvisioningEventInTransaction,
  buildCwdBranchEntries,
  createClientTurnRequestId,
  type TurnRequestRetryMarker,
} from "./thread-events.js";
import {
  hasLiveThreadStartInFlight,
  requestThreadStart,
} from "./thread-lifecycle.js";
import type { DispatchAuthor } from "./dispatch-author.js";
import { resolvePermissionEscalation } from "./thread-runtime-config.js";
import {
  createThreadStartup,
  type ThreadForkDescriptor,
  type ThreadProvisionEnvironmentIntent,
  type ThreadProvisionContext,
} from "./thread-startup-store.js";
import {
  ensureThreadProvisionEnvironmentReady,
  ensureWorkspaceReadyEvent,
  failThreadProvisioning,
  type ThreadProvisioningDeps,
} from "./thread-provisioning-environment.js";
import {
  clearThreadProvisionSchedule,
  getThreadProvisionContext,
  saveThreadProvisionContext,
  readThreadProvisionContext,
} from "./thread-startup-store.js";
import { applyLoggedThreadLifecycleEventInTransaction } from "./lifecycle-outcome.js";
import { buildThreadStatusChangeMetadata } from "./thread-runtime-display.js";
import { runtimeErrorLogFields } from "../lib/error-log-fields.js";
import {
  NotificationBuffer,
  type BufferedTransaction,
} from "../lib/notification-buffer.js";
import { recordAcceptedPromptHistoryEntry } from "../prompt-history.js";

interface RequestThreadProvisionArgs {
  systemMessageKind?: SystemMessageKind;
  systemMessageSubject?: SystemMessageSubject | null;
  author: DispatchAuthor;
  environmentIntent: ThreadProvisionEnvironmentIntent;
  execution: ResolvedThreadExecutionOptions;
  fork: ThreadForkDescriptor | null;
  input: PromptInput[];
  providerInput?: PromptInput[];
  retryOf?: TurnRequestRetryMarker;
  startedOnBehalfOf: StartedOnBehalfOf | null;
  thread: Thread;
  titleProvided: boolean;
}

interface RequestThreadTargetReprovisionArgs {
  requestId?: ClientTurnRequestId;
  beforeRequestAppendInTransaction?: (args: BufferedTransaction) => void;
  environment: EnvironmentRow;
  execution: ResolvedThreadExecutionOptions;
  input: PromptInput[];
  inputGroups?: PromptInput[][];
  initiator: ThreadTurnInitiator;
  retryOf?: TurnRequestRetryMarker;
  senderThreadId: string | null;
  systemMessageKind?: SystemMessageKind;
  systemMessageSubject?: SystemMessageSubject | null;
  provider: {
    environmentProviderId: string;
    selection: EnvironmentProviderSelection;
  };
  thread: Thread;
}

interface RequestThreadEnvironmentRestoreArgs {
  environment: EnvironmentRow;
  provider: {
    environmentProviderId: string;
    selection: EnvironmentProviderSelection;
  };
  thread: Thread;
}

interface AdvanceThreadProvisioningArgs {
  threadId: string;
}

interface CurrentProvisioningFailureThreadArgs {
  context: ThreadProvisionContext;
  threadId: string;
}

interface EnvironmentPayloadThreadArgs {
  context: ThreadProvisionContext;
  environment: EnvironmentRow;
  thread: Thread;
}

function getCurrentProvisioningFailureThread(
  deps: Pick<AppDeps, "db">,
  args: CurrentProvisioningFailureThreadArgs,
): Thread | null {
  const currentThread = getThread(deps.db, args.threadId);

  if (!currentThread || currentThread.deletedAt !== null) {
    clearThreadProvisionSchedule(args.threadId);

    return null;
  }

  if (
    currentThread.status !== "starting" ||
    currentThread.archivedAt !== null
  ) {
    clearThreadProvisionSchedule(args.threadId);

    return null;
  }

  const activeContext = getThreadProvisionContext(deps.db, args.threadId);

  if (
    activeContext === null ||
    activeContext.state.provisioningId !== args.context.state.provisioningId
  ) {
    return null;
  }

  return currentThread;
}

interface SettleSeededThreadProvisioningArgs {
  context: ThreadProvisionContext;
  environmentId: string;
  threadId: string;
}

function settleSeededThreadProvisioning(
  deps: ThreadProvisioningDeps,
  args: SettleSeededThreadProvisioningArgs,
): void {
  const shelfChanges = new NotificationBuffer();

  const settled = deps.db.transaction(
    (tx) => {
      const current = getThreadProvisionContext(tx, args.threadId);

      const silentImport =
        args.context.request.silentSettle ||
        (getNativeThreadImport(tx, args.threadId) !== null &&
          !hasThreadNativeSessionHistory(tx, args.threadId));

      const outcome = applyLoggedThreadLifecycleEventInTransaction(
        { db: tx, hub: shelfChanges, logger: deps.logger },
        { threadId: args.threadId, event: { type: "run.succeeded" } },
        undefined,
        { inbox: silentImport ? "silent" : "record" },
      );

      const completedProvisioning =
        outcome.applied &&
        current !== null &&
        current.state.provisioningId === args.context.state.provisioningId &&
        current.state.provisionEventSequence !== null;

      if (completedProvisioning) {
        appendThreadProvisioningEventInTransaction(tx, {
          threadId: args.threadId,
          environmentId: args.environmentId,
          provisioningId: current.state.provisioningId,
          status: "completed",
          entries: [],
        });
      }

      return { completedProvisioning, outcome };
    },
    { behavior: "immediate" },
  );

  shelfChanges.flushInto(deps.hub);

  if (!settled.outcome.applied) {
    deps.logger.warn(
      { threadId: args.threadId },
      "Seed-without-run thread was no longer starting; idle settle skipped",
    );

    return;
  }

  deps.hub.notifyThread(
    args.threadId,
    ["status-changed"],
    buildThreadStatusChangeMetadata(deps, settled.outcome.thread),
  );

  if (settled.completedProvisioning) {
    deps.hub.notifyThread(args.threadId, ["events-appended"], {
      timelineSequence: getLatestThreadSequence(deps.db, {
        threadId: args.threadId,
      }),
      eventTypes: ["system/thread-provisioning"],
    });
  }
}

async function startThreadIfEnvironmentReady(
  deps: ThreadProvisioningDeps,
  args: EnvironmentPayloadThreadArgs,
): Promise<void> {
  if (args.environment.status === "error") {
    failThreadProvisioning(deps, {
      thread: args.thread,
      environmentId: args.environment.id,
      detail: "Environment provisioning failed",
    });

    return;
  }

  if (args.environment.status === "provisioning") {
    return;
  }

  if (args.environment.status !== "ready") {
    failThreadProvisioning(deps, {
      thread: args.thread,
      environmentId: args.environment.id,
      detail: `Environment is ${args.environment.status}`,
    });

    return;
  }

  if (!args.environment.path) {
    failThreadProvisioning(deps, {
      thread: args.thread,
      environmentId: args.environment.id,
      detail: "Environment is ready without a workspace path",
    });

    return;
  }

  const workspaceReady = ensureWorkspaceReadyEvent(deps, {
    threadId: args.thread.id,
    environmentId: args.environment.id,
    entries: buildCwdBranchEntries({
      path: args.environment.path,
      branchName: args.environment.branchName,
      headSha: null,
    }),
  });

  if (!workspaceReady) {
    throw new Error("Thread did not reach workspace-ready provisioning state");
  }

  requestQueuedMessageDispatch(deps, {
    kind: "workspace-ready",
    threadId: args.thread.id,
  });

  if (
    args.context.request.seedWithoutRun &&
    args.context.request.fork === null
  ) {
    settleSeededThreadProvisioning(deps, {
      context: args.context,
      environmentId: args.environment.id,
      threadId: args.thread.id,
    });

    return;
  }

  const execution = args.context.request.execution;

  if (execution === null) {
    throw new Error("Thread provisioning that starts a run has no execution");
  }

  const fork =
    args.context.request.fork ??
    (args.context.request.seedWithoutRun
      ? null
      : resolveNativeImportFork(deps.db, {
          hostId: args.environment.hostId,
          providerId: args.thread.providerId,
          threadId: args.thread.id,
        }));

  await requestThreadStart(deps, {
    thread: args.thread,
    environment: {
      id: args.environment.id,
      hostId: args.environment.hostId,
      path: args.environment.path,
      status: args.environment.status,
    },
    fork,
    input: args.context.request.input,
    ...(args.context.request.inputGroups !== undefined
      ? { inputGroups: args.context.request.inputGroups }
      : {}),
    requestId: args.context.request.clientRequestId,
    execution,
    permissionEscalation: resolvePermissionEscalation({
      initiator: args.context.request.initiator,
    }),
    projectId: args.thread.projectId,
    providerId: args.thread.providerId,
    syncGeneratedTitle: !args.context.request.titleProvided,
  });
}

export function requestThreadProvision(
  deps: Pick<AppDeps, "db" | "hub">,
  args: RequestThreadProvisionArgs,
): ThreadProvisionContext {
  return deps.db.transaction(() => {
    const { initiator, senderThreadId } = args.author;
    const target: TurnRequestTarget = { kind: "thread-start" };

    const request = appendClientTurnEvent(deps, {
      threadId: args.thread.id,
      environmentId: args.thread.environmentId,
      type: "client/turn/requested",
      ...(args.retryOf !== undefined ? { retryOf: args.retryOf } : {}),
      input: args.input,
      execution: args.execution,
      initiator,
      systemMessageKind: args.systemMessageKind,
      systemMessageSubject: args.systemMessageSubject,
      senderThreadId,
      requestMethod: "thread/start",
      source: "spawn",
      target,
    });

    recordAcceptedPromptHistoryEntry(deps, {
      thread: args.thread,
      input: args.input,
      initiator,
      target,
      requestSequence: request.sequence,
    });
    appendClientTurnEvent(deps, {
      threadId: args.thread.id,
      environmentId: args.thread.environmentId,
      type: "client/thread/start",
      initiator,
      requestMethod: "thread/start",
      source: "spawn",
    });

    const context = createThreadStartup({
      clientRequestId: request.requestId,
      environmentIntent: args.environmentIntent,
      execution: args.execution,
      fork: args.fork,
      input: args.providerInput ?? args.input,
      initiator,
      seedWithoutRun: args.startedOnBehalfOf !== null,
      titleProvided: args.titleProvided,
    });

    saveThreadProvisionContext({
      replace: true,
      db: deps.db,
      threadId: args.thread.id,
      context,
    });

    return context;
  });
}

export function requestThreadEnvironmentRestore(
  deps: Pick<AppDeps, "db" | "hub" | "logger">,
  args: RequestThreadEnvironmentRestoreArgs,
): ThreadProvisionContext | null {
  return deps.db.transaction(
    (tx) => {
      const prepared = applyLoggedThreadLifecycleEventInTransaction(
        { db: tx, hub: deps.hub, logger: deps.logger },
        { event: { type: "run.preparing" }, threadId: args.thread.id },
      );

      if (!prepared.applied) {
        return null;
      }

      const context = createThreadStartup({
        clientRequestId: createClientTurnRequestId(),
        environmentIntent: {
          type: "provider",
          environmentProviderId: args.provider.environmentProviderId,
          machine: { type: "existing", hostId: args.environment.hostId },
          inputs: args.provider.selection.inputs,
          selectionResolved: true,
        },
        execution: null,
        fork: null,
        input: [],
        initiator: "user",
        seedWithoutRun: true,
        titleProvided: true,
      });

      saveThreadProvisionContext({
        replace: true,
        db: tx,
        threadId: args.thread.id,
        context,
      });

      return context;
    },
    { behavior: "immediate" },
  );
}

export function requestThreadTargetReprovision(
  deps: Pick<AppDeps, "db" | "hub">,
  args: RequestThreadTargetReprovisionArgs,
): ThreadProvisionContext {
  const notifications = new NotificationBuffer();

  const { request, context } = deps.db.transaction(
    (tx) => {
      const request = appendReprovisionTurnRequest({ tx, notifications }, args);

      const context = createThreadStartup({
        clientRequestId: request.requestId,
        environmentIntent:
          args.environment.status === "error" &&
          args.environment.path !== null &&
          args.environment.teardownStatus === null
            ? { type: "reuse", environmentId: args.environment.id }
            : {
                type: "provider",
                environmentProviderId: args.provider.environmentProviderId,
                machine: {
                  type: "existing",
                  hostId: args.environment.hostId,
                },
                inputs: args.provider.selection.inputs,
                selectionResolved: true,
              },
        execution: args.execution,
        fork: null,
        input: args.input,
        ...(args.inputGroups !== undefined
          ? { inputGroups: args.inputGroups }
          : {}),
        initiator: args.initiator,
        seedWithoutRun: false,
        titleProvided: true,
      });

      saveThreadProvisionContext({
        replace: true,
        db: tx,
        threadId: args.thread.id,
        context,
      });

      return { request, context };
    },
    { behavior: "immediate" },
  );

  deps.hub.notifyThread(
    args.thread.id,
    request.notificationChanges,
    request.notificationMetadata,
  );
  notifications.flushInto(deps.hub);

  return context;
}

function appendReprovisionTurnRequest(
  transaction: BufferedTransaction,
  args: Omit<RequestThreadTargetReprovisionArgs, "provider">,
) {
  const { tx, notifications } = transaction;
  const requestId = args.requestId ?? createClientTurnRequestId();

  args.beforeRequestAppendInTransaction?.(transaction);

  const request =
    appendPreparedClientTurnRequestedEventWithNotificationInTransaction(
      { db: tx, hub: notifications },
      {
        threadId: args.thread.id,
        environmentId: args.environment.id,
        type: "client/turn/requested",
        ...(args.retryOf !== undefined ? { retryOf: args.retryOf } : {}),
        input: args.input,
        ...(args.inputGroups !== undefined
          ? { inputGroups: args.inputGroups }
          : {}),
        execution: args.execution,
        initiator: args.initiator,
        senderThreadId: args.senderThreadId,
        systemMessageKind: args.systemMessageKind,
        systemMessageSubject: args.systemMessageSubject,
        requestMethod: "turn/start",
        source: "tell",
        target: { kind: "new-turn" },
        requestId,
      },
    );

  recordAcceptedPromptHistoryEntry(
    { db: tx },
    {
      thread: args.thread,
      input: args.input,
      initiator: args.initiator,
      target: { kind: "new-turn" },
      requestSequence: request.sequence,
    },
  );

  return request;
}

const WORKSPACE_BUSY_RETRY_WINDOW_MS = 10 * 60_000;

const WORKSPACE_BUSY_RETRY_MAX_DELAY_MS = 15_000;

const WORKSPACE_BUSY_STEP_KEY = "workspace-busy";

const workspaceBusyRetries = new Map<
  string,
  {
    attempt: number;
    provisioningId: string;
    since: number;
    timer: NodeJS.Timeout;
  }
>();

function clearWorkspaceBusyRetry(threadId: string): void {
  const retry = workspaceBusyRetries.get(threadId);

  if (retry !== undefined) clearTimeout(retry.timer);
  workspaceBusyRetries.delete(threadId);
}

function scheduleWorkspaceBusyRetry(
  deps: ThreadProvisioningDeps,
  args: { context: ThreadProvisionContext; threadId: string },
): boolean {
  const { provisioningId } = args.context.state;
  const existing = workspaceBusyRetries.get(args.threadId);

  const previous =
    existing?.provisioningId === provisioningId ? existing : undefined;

  const since = previous?.since ?? Date.now();

  if (Date.now() - since >= WORKSPACE_BUSY_RETRY_WINDOW_MS) return false;
  const attempt = previous?.attempt ?? 0;

  if (previous === undefined)
    appendThreadProvisioningEvent(deps, {
      threadId: args.threadId,
      environmentId: args.context.state.environmentId,
      provisioningId,
      status: "active",
      entries: [
        {
          type: "step",
          key: WORKSPACE_BUSY_STEP_KEY,
          text: "Waiting for another chat to finish setting up this workspace",
          status: "started",
        },
      ],
    });
  clearWorkspaceBusyRetry(args.threadId);

  const timer = setTimeout(
    () =>
      void advanceThreadProvisioning(deps, { threadId: args.threadId }).catch(
        (error) =>
          deps.logger.warn(
            { threadId: args.threadId, error },
            "Workspace busy retry failed",
          ),
      ),
    Math.min(1_000 * 2 ** attempt, WORKSPACE_BUSY_RETRY_MAX_DELAY_MS),
  );

  timer.unref?.();
  workspaceBusyRetries.set(args.threadId, {
    attempt: attempt + 1,
    provisioningId,
    since,
    timer,
  });

  return true;
}

function settleWorkspaceBusyRetry(
  deps: ThreadProvisioningDeps,
  args: { context: ThreadProvisionContext; threadId: string },
): void {
  if (!workspaceBusyRetries.has(args.threadId)) return;
  clearWorkspaceBusyRetry(args.threadId);
  appendThreadProvisioningEvent(deps, {
    threadId: args.threadId,
    environmentId: args.context.state.environmentId,
    provisioningId: args.context.state.provisioningId,
    status: "active",
    entries: [
      {
        type: "step",
        key: WORKSPACE_BUSY_STEP_KEY,
        text: "Waiting for another chat to finish setting up this workspace",
        status: "completed",
      },
    ],
  });
}

async function advanceThreadProvisioningOnce(
  deps: ThreadProvisioningDeps,
  args: AdvanceThreadProvisioningArgs,
): Promise<void> {
  const thread = getThread(deps.db, args.threadId);

  if (
    !thread ||
    thread.deletedAt !== null ||
    hasLiveThreadStartInFlight(thread.id)
  ) {
    return;
  }

  if (thread.status !== "starting") {
    clearThreadProvisionSchedule(thread.id);
    clearWorkspaceBusyRetry(thread.id);

    return;
  }

  let context = getThreadProvisionContext(deps.db, thread.id);

  if (!context) {
    failThreadProvisioning(deps, {
      thread,
      environmentId: thread.environmentId,
      detail: "Thread setup did not finish. Retry the thread to continue.",
    });

    return;
  }

  if (thread.archivedAt !== null) {
    return;
  }

  try {
    const ready = await ensureThreadProvisionEnvironmentReady(deps, {
      context,
      thread,
    });

    if (ready === null) {
      return;
    }

    settleWorkspaceBusyRetry(deps, {
      context: ready.context,
      threadId: thread.id,
    });
    context = ready.context;
    await startThreadIfEnvironmentReady(deps, {
      context: ready.context,
      environment: ready.environment,
      thread: ready.thread,
    });
  } catch (error) {
    const failureThread = getCurrentProvisioningFailureThread(deps, {
      context,
      threadId: thread.id,
    });

    if (!failureThread) {
      return;
    }

    if (
      error instanceof ApiError &&
      error.body.code === "workspace_busy" &&
      scheduleWorkspaceBusyRetry(deps, { context, threadId: failureThread.id })
    ) {
      return;
    }

    clearWorkspaceBusyRetry(failureThread.id);
    const detail = error instanceof Error ? error.message : String(error);
    failThreadProvisioning(deps, {
      thread: failureThread,
      environmentId: context.state.environmentId ?? failureThread.environmentId,
      detail,
    });
  }
}

export async function advanceThreadProvisioning(
  deps: ThreadProvisioningDeps,
  args: AdvanceThreadProvisioningArgs,
): Promise<void> {
  await deps.lifecycleDedupers.threadProvisionAdvance.run(args.threadId, () =>
    advanceThreadProvisioningOnce(deps, args),
  );
}

export function scheduleThreadProvisioningAdvance(
  deps: ThreadProvisioningDeps & Pick<AppDeps, "config" | "logger">,
  threadId: string,
): void {
  void advanceThreadProvisioning(deps, {
    threadId,
  }).catch((error) => {
    deps.logger.warn(
      {
        threadId,
        ...runtimeErrorLogFields(deps.config, error),
      },
      "Failed to advance thread provisioning",
    );
  });
}

export async function restoreInterruptedThreadStartupRequest(
  deps: ThreadProvisioningDeps,
  threadId: string,
): Promise<ThreadProvisionContext["request"] | null> {
  const context = readThreadProvisionContext(deps.db, threadId);

  if (context === null) return null;
  const provisioning = getPreparingEnvironment(deps.db, threadId);

  if (provisioning !== null) {
    await cancelProviderEnvironmentCreation(deps, threadId);
  }

  const machine = getNonDestroyedHostByLaunchKey(deps.db, threadId);

  if (machine?.phase === "removing") {
    await sweepProviderMachine(deps, machine.id);
  }

  return context.request;
}
