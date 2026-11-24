import { getThread, listNonDeletedChildThreads } from "@omnyo/db";
import type { Thread } from "@omnyo/domain";
import type { AppDeps } from "../../types.js";
import { throwParentThreadInvalid } from "../lib/lifecycle-api-errors.js";

const MAX_THREAD_HIERARCHY_DEPTH = 4;

export function isParentNotifiableChildThread<
  T extends Pick<Thread, "parentThreadId" | "originKind">,
>(thread: T): thread is T & { parentThreadId: string } {
  return thread.parentThreadId !== null && thread.originKind === null;
}

export type ParentThread = Pick<
  Thread,
  | "archivedAt"
  | "deletedAt"
  | "environmentId"
  | "id"
  | "parentThreadId"
  | "projectId"
> &
  Partial<Pick<Thread, "originKind">>;

interface IsLiveParentThreadArgs {
  parentThread: ParentThread | null;
}

interface AssertValidParentThreadArgs {
  childThreadId?: string;
  parentThreadId: string;
}

interface ResolveParentDepthArgs {
  childThreadId?: string;
  parentThread: ParentThread;
}

interface ResolveThreadSubtreeDepthArgs {
  threadId: string;
  visitedThreadIds: Set<string>;
}

export function isLiveParentThread(args: IsLiveParentThreadArgs): boolean {
  return (
    args.parentThread !== null &&
    args.parentThread.archivedAt === null &&
    args.parentThread.deletedAt === null
  );
}

export function resolveQuestionOwnerThread(
  deps: Pick<AppDeps, "db">,
  thread: Pick<Thread, "id" | "parentThreadId" | "originKind">,
): Thread | null {
  const ownerThreadId = isParentNotifiableChildThread(thread)
    ? thread.parentThreadId
    : (getThread(deps.db, thread.id)?.launchedByThreadId ?? null);

  if (ownerThreadId === null || ownerThreadId === thread.id) return null;
  const ownerThread = getThread(deps.db, ownerThreadId);

  return ownerThread !== null &&
    !ownerThread.quiet &&
    isLiveParentThread({ parentThread: ownerThread })
    ? ownerThread
    : null;
}

export function resolveChildOutcomeOwner(
  deps: Pick<AppDeps, "db">,
  childThreadId: string,
  recordedParentId: string,
) {
  const parent = getThread(deps.db, recordedParentId);

  if (parent === null || parent.id === childThreadId) return null;

  if (isLiveParentThread({ parentThread: parent })) return parent;

  const child = getThread(deps.db, childThreadId);

  if (
    child === null ||
    (child.parentThreadId ?? child.lifecycleOwnerThreadId) !== recordedParentId
  )
    return null;

  const visited = new Set([childThreadId, recordedParentId]);
  let ownerId = parent.parentThreadId ?? parent.lifecycleOwnerThreadId;

  for (
    let depth = 1;
    ownerId !== null && depth < MAX_THREAD_HIERARCHY_DEPTH;
    depth += 1
  ) {
    if (visited.has(ownerId)) return null;
    visited.add(ownerId);

    const owner = getThread(deps.db, ownerId);

    if (owner === null) return null;

    if (isLiveParentThread({ parentThread: owner })) return owner;

    ownerId = owner.parentThreadId ?? owner.lifecycleOwnerThreadId;
  }

  return null;
}

export function routedQuestionDeliveredReason(ownerThreadId: string): string {
  return `This chat reports to ${ownerThreadId}. The question went to that chat, not the owner, and its answer arrives as a message in this chat. Do not ask it again; continue independent work, or end the turn when nothing else can proceed.`;
}

function resolveParentDepth(
  deps: Pick<AppDeps, "db">,
  args: ResolveParentDepthArgs,
): number {
  let depth = 0;
  let parentThread: ParentThread | null = args.parentThread;
  const visitedThreadIds = new Set<string>();

  while (parentThread !== null) {
    if (args.childThreadId && parentThread.id === args.childThreadId) {
      throwParentThreadInvalid(
        parentThread.id === args.parentThread.id ? "self" : "cycle",
      );
    }

    if (visitedThreadIds.has(parentThread.id)) {
      throwParentThreadInvalid("cycle");
    }

    visitedThreadIds.add(parentThread.id);
    depth += 1;

    if (parentThread.parentThreadId === null) {
      return depth;
    }

    parentThread = getThread(deps.db, parentThread.parentThreadId);
  }

  return depth;
}

function resolveThreadSubtreeDepth(
  deps: Pick<AppDeps, "db">,
  args: ResolveThreadSubtreeDepthArgs,
): number {
  if (args.visitedThreadIds.has(args.threadId)) {
    throwParentThreadInvalid("cycle");
  }

  args.visitedThreadIds.add(args.threadId);

  const childThreads = listNonDeletedChildThreads(deps.db, {
    parentThreadId: args.threadId,
  });

  let maxChildDepth = 0;

  for (const childThread of childThreads) {
    const childDepth = resolveThreadSubtreeDepth(deps, {
      threadId: childThread.id,
      visitedThreadIds: args.visitedThreadIds,
    });

    maxChildDepth = Math.max(maxChildDepth, childDepth);
  }

  args.visitedThreadIds.delete(args.threadId);

  return maxChildDepth + 1;
}

interface CanThreadSpawnChildArgs {
  thread: ParentThread;
}

export function canThreadSpawnChild(
  deps: Pick<AppDeps, "db">,
  args: CanThreadSpawnChildArgs,
): boolean {
  const depth = resolveParentDepth(deps, {
    parentThread: args.thread,
  });

  return depth < MAX_THREAD_HIERARCHY_DEPTH;
}

export function assertValidParentThread(
  deps: Pick<AppDeps, "db">,
  args: AssertValidParentThreadArgs,
): Thread {
  const parentThread = getThread(deps.db, args.parentThreadId);

  if (parentThread === null) {
    throwParentThreadInvalid("not_found");
  }

  const liveParentThread: Thread = parentThread;

  if (liveParentThread.archivedAt !== null) {
    throwParentThreadInvalid("archived");
  }

  if (liveParentThread.deletedAt !== null) {
    throwParentThreadInvalid("deleted");
  }

  const parentDepth = resolveParentDepth(deps, {
    childThreadId: args.childThreadId,
    parentThread: liveParentThread,
  });

  const childSubtreeDepth = args.childThreadId
    ? resolveThreadSubtreeDepth(deps, {
        threadId: args.childThreadId,
        visitedThreadIds: new Set<string>(),
      })
    : 1;

  if (parentDepth + childSubtreeDepth > MAX_THREAD_HIERARCHY_DEPTH) {
    throwParentThreadInvalid("too_deep");
  }

  return liveParentThread;
}
