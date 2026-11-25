import type { QueryClient } from "@tanstack/react-query";
import type {
  ThreadQueuedMessage,
  QueuedMessageWork,
  ThreadStatusChangeMetadata,
  ThreadWorkSummary,
} from "@omnyo/domain";
import {
  localQueuedMessageWork,
  projectLocalThreadWork,
  type LocalQueuedMessage,
} from "./local-thread-work";

const removedQueuedMessagesByClient = new WeakMap<
  QueryClient,
  Map<string, Map<string, "pending" | "confirmed">>
>();

const pendingQueuedMessagesByClient = new WeakMap<
  QueryClient,
  Map<string, Map<string, ThreadQueuedMessage>>
>();

type ThreadStatusFields = Omit<ThreadStatusChangeMetadata, "activity">;

function threadStatusSnapshot({
  status,
  runtime,
  latestAttentionAt,
  lastMessageAt,
  updatedAt,
}: ThreadStatusFields): ThreadStatusFields {
  return { status, runtime, latestAttentionAt, lastMessageAt, updatedAt };
}

interface ComposerInput {
  kind: "active" | "queued";
  accepted: boolean;
  acceptedAfter: number | null;
  queuedMessage: LocalQueuedMessage | null;
  localWork: QueuedMessageWork | null;
}

interface ComposerThreadState {
  generation: number;
  authoritative: ThreadStatusFields | null;
  inputs: Map<string, ComposerInput>;
}

const threadStateByClient = new WeakMap<
  QueryClient,
  Map<string, ComposerThreadState>
>();

const generationByClient = new WeakMap<QueryClient, number>();

function advanceComposerGeneration(
  queryClient: QueryClient,
  state: ComposerThreadState,
): void {
  const generation = (generationByClient.get(queryClient) ?? 0) + 1;
  generationByClient.set(queryClient, generation);
  state.generation = generation;
}

export function getComposerStateGeneration(queryClient: QueryClient): number {
  return generationByClient.get(queryClient) ?? 0;
}

function composerThreadState(
  queryClient: QueryClient,
  threadId: string,
): ComposerThreadState {
  let threads = threadStateByClient.get(queryClient);

  if (threads === undefined) {
    threads = new Map();
    threadStateByClient.set(queryClient, threads);
  }

  let state = threads.get(threadId);

  if (state === undefined) {
    state = { generation: 0, authoritative: null, inputs: new Map() };
    threads.set(threadId, state);
  }

  return state;
}

export function retainPendingComposerThreadState(
  queryClient: QueryClient,
  threadId: string,
  token: string,
  kind: "active" | "queued",
  previous: ThreadStatusFields | undefined,
  queuedMessage: LocalQueuedMessage | null = null,
  localWork: QueuedMessageWork | null = null,
): void {
  const state = composerThreadState(queryClient, threadId);
  state.authoritative ??= previous ? threadStatusSnapshot(previous) : null;
  state.inputs.set(token, {
    kind,
    accepted: false,
    acceptedAfter: null,
    queuedMessage,
    localWork,
  });
  advanceComposerGeneration(queryClient, state);
}

export function settlePendingComposerThreadState(
  queryClient: QueryClient,
  threadId: string,
  token: string,
  outcome: "sent" | "queued" | "failed",
): ThreadStatusFields | null {
  const state = composerThreadState(queryClient, threadId);
  const input = state.inputs.get(token);

  if (input === undefined) return null;

  if (outcome === "failed") state.inputs.delete(token);
  else {
    input.accepted = true;
    input.acceptedAfter = state.authoritative?.updatedAt ?? null;
    input.kind = outcome === "sent" ? "active" : "queued";
  }

  advanceComposerGeneration(queryClient, state);

  return [...state.inputs.values()].some((pending) => pending.kind === "active")
    ? null
    : state.authoritative;
}

export function getComposerThreadStateGeneration(
  queryClient: QueryClient,
  threadId: string,
): number {
  return threadStateByClient.get(queryClient)?.get(threadId)?.generation ?? 0;
}

export function hasPendingComposerThreadState(
  queryClient: QueryClient,
  threadId: string,
): boolean {
  return [
    ...(threadStateByClient.get(queryClient)?.get(threadId)?.inputs.values() ??
      []),
  ].some((input) => !input.accepted);
}

export function reconcileComposerThreadState<T extends ThreadStatusFields>(
  queryClient: QueryClient,
  threadId: string,
  current: T | undefined,
  incoming: T,
  source: "realtime" | "fresh-read" | "stale-read" = "realtime",
): T {
  const state = composerThreadState(queryClient, threadId);
  state.authoritative ??= current ? threadStatusSnapshot(current) : null;
  const previous = state.authoritative;

  if (
    previous !== null &&
    incoming.updatedAt < previous.updatedAt &&
    current !== undefined
  )
    return current;

  if (
    source !== "stale-read" &&
    (previous === null || incoming.updatedAt >= previous.updatedAt)
  )
    state.authoritative = threadStatusSnapshot(incoming);

  const stoppedAfterAcceptance =
    source === "realtime" &&
    current?.status === "stopping" &&
    (incoming.status === "idle" || incoming.status === "error");

  for (const [token, input] of state.inputs) {
    if (!input.accepted) continue;

    if (
      source === "fresh-read" ||
      (stoppedAfterAcceptance &&
        input.kind === "active" &&
        input.acceptedAfter !== null &&
        incoming.updatedAt > input.acceptedAfter)
    )
      state.inputs.delete(token);
  }

  let projected =
    previous !== null && incoming.updatedAt < previous.updatedAt
      ? { ...incoming, ...previous }
      : incoming;

  for (const input of state.inputs.values()) {
    if (
      input.kind === "active" &&
      incoming.status !== "active" &&
      incoming.status !== "starting" &&
      incoming.status !== "stopping"
    )
      projected = {
        ...projected,
        status: current?.status === "stopping" ? "stopping" : "active",
        runtime: {
          ...projected.runtime,
          displayStatus:
            current?.runtime.displayStatus === "waiting-for-host"
              ? "waiting-for-host"
              : current?.status === "stopping"
                ? "stopping"
                : "active",
        },
      };

    if (input.kind === "queued" && "queuedWork" in incoming)
      projected = { ...projected, queuedWork: "waiting" };
  }

  const unaccepted = [...state.inputs.values()].filter(
    (input) => !input.accepted,
  );

  if (unaccepted.length === 0 || !carriesWork(projected)) return projected;

  const thread = {
    id: threadId,
    status: projected.status,
    runtime: projected.runtime,
    work: projected.work,
  };

  return {
    ...projected,
    work: projectLocalThreadWork(
      thread,
      unaccepted.flatMap((input) =>
        input.localWork !== null
          ? [input.localWork]
          : input.queuedMessage === null
            ? []
            : [localQueuedMessageWork(thread, input.queuedMessage)],
      ),
      {
        preserveFailures: unaccepted.some((input) => input.localWork !== null),
      },
    ),
  };
}

function carriesWork<T extends object>(
  value: T,
): value is T & { work: ThreadWorkSummary | null } {
  return "work" in value;
}

export function retainPendingComposerQueuedMessage(
  queryClient: QueryClient,
  threadId: string,
  row: ThreadQueuedMessage,
): void {
  let threads = pendingQueuedMessagesByClient.get(queryClient);

  if (threads === undefined) {
    threads = new Map();
    pendingQueuedMessagesByClient.set(queryClient, threads);
  }

  let rows = threads.get(threadId);

  if (rows === undefined) {
    rows = new Map();
    threads.set(threadId, rows);
  }

  rows.set(row.id, row);
}

export function releasePendingComposerQueuedMessage(
  queryClient: QueryClient,
  threadId: string,
  rowId: string,
): void {
  const threads = pendingQueuedMessagesByClient.get(queryClient);
  const rows = threads?.get(threadId);

  if (rows === undefined) return;
  rows.delete(rowId);

  if (rows.size === 0) threads?.delete(threadId);
}

function removedQueuedMessages(
  queryClient: QueryClient,
  threadId: string,
): Map<string, "pending" | "confirmed"> {
  let threads = removedQueuedMessagesByClient.get(queryClient);

  if (threads === undefined) {
    threads = new Map();
    removedQueuedMessagesByClient.set(queryClient, threads);
  }

  let removed = threads.get(threadId);

  if (removed === undefined) {
    removed = new Map();
    threads.set(threadId, removed);
  }

  return removed;
}

export function retainPendingQueuedMessageRemoval(
  queryClient: QueryClient,
  threadId: string,
  queuedMessageIds: Iterable<string>,
): void {
  const removed = removedQueuedMessages(queryClient, threadId);

  for (const id of queuedMessageIds) removed.set(id, "pending");
}

export function confirmPendingQueuedMessageRemoval(
  queryClient: QueryClient,
  threadId: string,
  queuedMessageIds: Iterable<string>,
): void {
  const removed = removedQueuedMessages(queryClient, threadId);

  for (const id of queuedMessageIds) removed.set(id, "confirmed");
}

export function releasePendingQueuedMessageRemoval(
  queryClient: QueryClient,
  threadId: string,
  queuedMessageIds: Iterable<string>,
): void {
  const threads = removedQueuedMessagesByClient.get(queryClient);
  const removed = threads?.get(threadId);

  if (removed === undefined) return;

  for (const id of queuedMessageIds) removed.delete(id);

  if (removed.size === 0) threads?.delete(threadId);
}

export function mergePendingComposerQueuedMessages(
  queryClient: QueryClient,
  threadId: string,
  fetched: ThreadQueuedMessage[],
): ThreadQueuedMessage[] {
  const removed = removedQueuedMessagesByClient.get(queryClient)?.get(threadId);

  if (removed !== undefined) {
    const fetchedIds = new Set(fetched.map((row) => row.id));

    for (const [id, state] of removed)
      if (state === "confirmed" && !fetchedIds.has(id)) removed.delete(id);

    if (removed.size === 0)
      removedQueuedMessagesByClient.get(queryClient)?.delete(threadId);
  }

  const messages =
    removed === undefined || removed.size === 0
      ? fetched
      : fetched.filter((row) => !removed.has(row.id));

  const pending = pendingQueuedMessagesByClient.get(queryClient)?.get(threadId);

  if (pending === undefined || pending.size === 0) return messages;
  const existing = new Set(messages.map((row) => row.id));
  const missing = [...pending.values()].filter((row) => !existing.has(row.id));

  return missing.length === 0 ? messages : [...messages, ...missing];
}
