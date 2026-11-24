import {
  projectThreadWork,
  queuedMessageWork,
  threadLifecycleWork,
  type QueuedMessageWork,
  type ThreadQueuedMessage,
  type ThreadRuntimeState,
  type ThreadStatus,
  type ThreadWorkSummary,
} from "@omnyo/domain";

interface LocalWorkThread {
  id: string;
  status: ThreadStatus;
  runtime: ThreadRuntimeState;
  work?: ThreadWorkSummary | null;
}

function uniqueById<T extends { id: string }>(items: readonly T[]): T[] {
  const seen = new Set<string>();

  return items.filter((item) => {
    if (seen.has(item.id)) return false;
    seen.add(item.id);

    return true;
  });
}

export function projectLocalThreadWork(
  thread: LocalWorkThread,
  queued: readonly QueuedMessageWork[] = [],
): ThreadWorkSummary {
  const previous = thread.work ?? null;
  const lifecycle = threadLifecycleWork(thread);

  const derivedIds = new Set([
    `turn:${thread.id}`,
    `provision:${thread.id}`,
    `host:${thread.id}`,
  ]);

  const revision = `local:${thread.id}:${thread.status}:${thread.runtime.displayStatus}`;

  return projectThreadWork({
    revision,
    basis: revision,
    activity: uniqueById([
      ...(lifecycle.turn === null ? [] : [lifecycle.turn]),
      ...queued.flatMap((fact) =>
        fact.kind === "activity" ? [fact.activity] : [],
      ),
      ...(previous?.activity ?? []).filter(
        (activity) => !derivedIds.has(activity.id),
      ),
      ...(lifecycle.provisioning === null ? [] : [lifecycle.provisioning]),
    ]),
    requiredInput: previous?.requiredInput ?? [],
    optionalInput: previous?.optionalInput ?? [],
    failures: [],
    waits: uniqueById([
      ...queued.flatMap((fact) => (fact.kind === "wait" ? [fact.wait] : [])),
      ...(previous?.waits ?? []).filter((wait) => !derivedIds.has(wait.id)),
      ...(lifecycle.hostWait === null ? [] : [lifecycle.hostWait]),
    ]),
    coverageComplete: true,
    unknownReason: null,
    assessment: null,
    postponement: null,
    closed: false,
  });
}

export function withLocalThreadWork<T extends LocalWorkThread>(
  thread: T,
  queued: readonly QueuedMessageWork[] = [],
): T {
  return { ...thread, work: projectLocalThreadWork(thread, queued) };
}

export type LocalQueuedMessage = Pick<
  ThreadQueuedMessage,
  "id" | "sendAt" | "waitingOn"
>;

export function localQueuedMessageWork(
  thread: LocalWorkThread,
  message: LocalQueuedMessage,
): QueuedMessageWork {
  return queuedMessageWork(message, {
    threadId: thread.id,
    threadStatus: thread.status,
    waitingForHost: thread.runtime.displayStatus === "waiting-for-host",
    hasRequiredInput: (thread.work?.requiredInput.length ?? 0) > 0,
    pluginAvailable: () => true,
    now: Date.now(),
  });
}
