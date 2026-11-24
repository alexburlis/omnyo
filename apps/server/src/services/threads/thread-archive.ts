import {
  cancelProviderEnvironmentCreation,
  refreshProviderRetirement,
  sweepProviderEnvironment,
} from "../environments/environment-engine.js";
import {
  removeCreatingMachine,
  sweepProviderMachine,
} from "../machines/provider-orchestration.js";
import {
  listLiveThreadsInEnvironment,
  listLifecycleThreadDependents,
  archiveThread,
  getEnvironment,
  getThread,
  unarchiveThread,
  listNonDeletedChildThreads,
  listNonDeletedHiddenSourceThreads,
} from "@omnyo/db";
import type { EnvironmentRow } from "@omnyo/db";
import type { Thread } from "@omnyo/domain";
import { ApiError } from "../../errors.js";
import type { AppDeps } from "../../types.js";
import {
  pruneThreadEventHistoryBestEffort,
  resetActiveThreadEventPruningState,
} from "../system/event-pruning.js";
import {
  emitPluginThreadArchived,
  emitPluginThreadUnarchived,
} from "../plugins/plugin-thread-events.js";
import { dispatchThreadUnarchiveCommand } from "./thread-commands.js";
import { getLastProviderThreadId } from "./thread-events.js";
import {
  dispatchSettledArchivedThreadProviderArchiveCommand,
  requestThreadStopForCurrentState,
} from "./thread-lifecycle.js";
import {
  archiveUndoGraceKeepsTerminals,
  archiveUndoGraceKeepsTurnRunning,
} from "./archive-undo-grace.js";
import { archiveThreadAndReleaseChildren } from "./thread-ownership.js";
import { resolveThreadHostCommandEnvironment } from "./thread-command-environment.js";

interface ArchiveThreadEnvironment {
  hostId: string;
  id: string;
}

interface ArchiveThreadWithLifecycleEffectsArgs {
  environment: ArchiveThreadEnvironment | null;
  stopRunning: boolean;
  thread: Pick<Thread, "environmentId" | "id" | "status">;
}

interface ArchiveEnvironmentThreadsArgs {
  environment: EnvironmentRow;
}

interface ArchiveThreadAndChildrenArgs {
  parentThread: Thread;
  stopRunning?: boolean;
}

function archiveThreadWithLifecycleEffects(
  deps: AppDeps,
  args: ArchiveThreadWithLifecycleEffectsArgs,
): Thread | null {
  const archivedThread = archiveThreadAndReleaseChildren(deps, {
    threadId: args.thread.id,
  });

  if (!archivedThread) {
    return null;
  }

  const now = Date.now();

  if (!archiveUndoGraceKeepsTerminals(archivedThread, now)) {
    deps.terminalSessions.closeArchivedThreadTerminals({
      threadId: archivedThread.id,
    });
  }

  if (
    args.stopRunning &&
    !archiveUndoGraceKeepsTurnRunning(archivedThread, now)
  ) {
    requestThreadStopForCurrentState(deps, archivedThread, args.environment);
  }

  dispatchSettledArchivedThreadProviderArchiveCommand(deps, {
    threadId: archivedThread.id,
  });
  resetActiveThreadEventPruningState(archivedThread.id);
  pruneThreadEventHistoryBestEffort(deps, {
    mode: "archived",
    threadId: archivedThread.id,
  });
  void cancelProviderEnvironmentCreation(deps, archivedThread.id).catch(
    (error) =>
      deps.logger.warn({ error }, "Environment launch cancellation failed"),
  );
  void removeCreatingMachine(deps, archivedThread.id).catch((error) =>
    deps.logger.warn({ error }, "Machine launch cancellation failed"),
  );

  if (archivedThread.environmentId !== null)
    void sweepProviderEnvironment(deps, archivedThread.environmentId).catch(
      (error) => deps.logger.warn({ error }, "Environment retirement failed"),
    );

  if (args.environment !== null) {
    void sweepProviderMachine(deps, args.environment.hostId).catch((error) =>
      deps.logger.warn({ error }, "Machine retirement failed"),
    );
  }

  emitPluginThreadArchived(archivedThread);

  return archivedThread;
}

export function archiveEnvironmentThreads(
  deps: AppDeps,
  args: ArchiveEnvironmentThreadsArgs,
): string[] {
  const roots = listLiveThreadsInEnvironment(deps.db, {
    environmentId: args.environment.id,
  });

  return archiveThreadTrees(deps, roots, (thread) =>
    thread.environmentId === null
      ? null
      : getEnvironment(deps.db, thread.environmentId),
  );
}

export function archiveThreadAndChildren(
  deps: AppDeps,
  args: ArchiveThreadAndChildrenArgs,
): string[] {
  const environment = resolveThreadHostCommandEnvironment({
    db: deps.db,
    thread: args.parentThread,
  });

  return archiveThreadTrees(
    deps,
    [args.parentThread],
    (thread) =>
      thread.id === args.parentThread.id
        ? environment
        : thread.environmentId === null
          ? null
          : getEnvironment(deps.db, thread.environmentId),
    args.stopRunning,
  );
}

function archiveThreadTrees(
  deps: AppDeps,
  roots: Thread[],
  resolveEnvironment: (
    thread: ArchiveThreadWithLifecycleEffectsArgs["thread"],
  ) => ArchiveThreadEnvironment | null,
  stopRunning = true,
): string[] {
  const threads = listArchiveCandidates(deps.db, roots);

  if (
    !stopRunning &&
    threads.some(
      (thread) =>
        thread.deletedAt === null &&
        thread.archivedAt === null &&
        (thread.status === "active" ||
          thread.status === "starting" ||
          thread.status === "stopping"),
    )
  )
    throw new ApiError(
      409,
      "invalid_request",
      "This chat or one of its child chats is still running",
    );

  for (const root of roots) archiveThread(deps.db, deps.hub, root.id);
  const archivedThreadIds: string[] = [];

  for (const thread of threads) {
    if (thread.deletedAt !== null) continue;

    if (thread.archivedAt !== null) {
      if (stopRunning && !archiveUndoGraceKeepsTurnRunning(thread, Date.now()))
        requestThreadStopForCurrentState(
          deps,
          thread,
          thread.environmentId === null ? null : resolveEnvironment(thread),
        );
      continue;
    }

    const environment = resolveEnvironment(thread);

    const result = archiveThreadWithLifecycleEffects(deps, {
      environment,
      stopRunning,
      thread,
    });

    if (!result) {
      continue;
    }

    archivedThreadIds.push(result.id);
  }

  return archivedThreadIds;
}

export function countUnarchivedThreadDescendants(
  db: AppDeps["db"],
  thread: Thread,
): number {
  return listArchiveCandidates(db, [thread]).filter(
    (candidate) =>
      candidate.id !== thread.id &&
      candidate.visibility === "visible" &&
      candidate.deletedAt === null &&
      candidate.archivedAt === null,
  ).length;
}

function listArchiveCandidates(db: AppDeps["db"], roots: Thread[]) {
  type ArchiveCandidate = Pick<
    Thread,
    | "id"
    | "environmentId"
    | "status"
    | "archivedAt"
    | "deletedAt"
    | "visibility"
  >;

  const pending: { thread: ArchiveCandidate; expanded: boolean }[] = [...roots]
    .reverse()
    .map((thread) => ({ thread, expanded: false }));

  const visited = new Set<string>();
  const threads: ArchiveCandidate[] = [];

  while (pending.length > 0) {
    const entry = pending.pop();

    if (!entry) {
      break;
    }

    const { thread, expanded } = entry;

    if (expanded) {
      threads.push(thread);
      continue;
    }

    if (visited.has(thread.id)) {
      continue;
    }

    visited.add(thread.id);
    pending.push({ thread, expanded: true });

    const descendants = [
      ...listLifecycleThreadDependents(db, thread.id),
      ...listNonDeletedChildThreads(db, {
        parentThreadId: thread.id,
      }),
      ...listNonDeletedHiddenSourceThreads(db, {
        sourceThreadId: thread.id,
      }),
    ];

    for (const descendant of descendants.reverse()) {
      pending.push({ thread: descendant, expanded: false });
    }
  }

  return threads;
}

export type UnarchiveThreadOutcome =
  | "unarchived"
  | "already-active"
  | "owner-archived";

export function unarchiveThreadWithLifecycleEffects(
  deps: AppDeps,
  thread: Thread,
): UnarchiveThreadOutcome {
  if (thread.archivedAt === null) return "already-active";

  const providerThreadId = getLastProviderThreadId(deps, thread.id);

  if (!unarchiveThread(deps.db, deps.hub, thread.id))
    return getThread(deps.db, thread.id)?.archivedAt === null
      ? "already-active"
      : "owner-archived";

  const unarchivedThread = getThread(deps.db, thread.id);

  if (unarchivedThread !== null) {
    if (unarchivedThread.environmentId !== null)
      refreshProviderRetirement(deps, unarchivedThread.environmentId);
    emitPluginThreadUnarchived(unarchivedThread);
  }

  const environment = thread.environmentId
    ? getEnvironment(deps.db, thread.environmentId)
    : null;

  if (providerThreadId && environment)
    dispatchThreadUnarchiveCommand(deps, {
      environment,
      providerThreadId,
      thread,
    });

  return "unarchived";
}
