import type { QueryClient } from "@tanstack/react-query";
import type { ThreadTimelineResponse } from "@omnyo/server-contract";
import { threadTimelineQueryKey } from "../queries/query-keys";

const unseenTimelineSequencesByClient = new WeakMap<
  QueryClient,
  Map<string, number>
>();

type UnseenTimelineEventsListener = (
  threadId: string,
  sequence: number | undefined,
  turnMayHaveCompleted: boolean,
) => void;

const listenersByClient = new WeakMap<
  QueryClient,
  Set<UnseenTimelineEventsListener>
>();

export function subscribeThreadTimelineUnseenEvents(
  queryClient: QueryClient,
  listener: UnseenTimelineEventsListener,
): () => void {
  let listeners = listenersByClient.get(queryClient);

  if (!listeners) {
    listeners = new Set();
    listenersByClient.set(queryClient, listeners);
  }

  listeners.add(listener);

  return () => {
    listeners.delete(listener);
  };
}

export function markThreadTimelineUnseenEvents(
  queryClient: QueryClient,
  threadId: string,
  sequence: number | undefined,
  turnMayHaveCompleted: boolean,
): void {
  if (sequence !== undefined) {
    let sequences = unseenTimelineSequencesByClient.get(queryClient);

    if (!sequences) {
      sequences = new Map();
      unseenTimelineSequencesByClient.set(queryClient, sequences);
    }

    const previous = sequences.get(threadId) ?? 0;
    sequences.set(threadId, Math.max(previous, sequence));
  }

  for (const listener of listenersByClient.get(queryClient) ?? [])
    listener(threadId, sequence, turnMayHaveCompleted);
}

export function clearThreadTimelineUnseenEvents(
  queryClient: QueryClient,
  threadId: string,
  loadedSequence: number,
): void {
  const sequences = unseenTimelineSequencesByClient.get(queryClient);

  if (loadedSequence >= (sequences?.get(threadId) ?? 0)) {
    sequences?.delete(threadId);
  }
}

export function hasThreadTimelineUnseenEvents(
  queryClient: QueryClient,
  threadId: string,
): boolean {
  const sequence = getThreadTimelineUnseenSequence(queryClient, threadId);

  if (sequence === undefined) return false;

  const timeline = queryClient.getQueryData<ThreadTimelineResponse>(
    threadTimelineQueryKey(threadId),
  );

  return sequence > (timeline?.maxSeq ?? 0);
}

export function getThreadTimelineUnseenSequence(
  queryClient: QueryClient,
  threadId: string,
): number | undefined {
  return unseenTimelineSequencesByClient.get(queryClient)?.get(threadId);
}
