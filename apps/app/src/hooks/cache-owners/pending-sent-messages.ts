import type { QueryClient } from "@tanstack/react-query";
import type { ClientTurnRequestId } from "@omnyo/domain";
import type {
  TimelineRow,
  TimelineUserConversationRow,
} from "@omnyo/server-contract";

export interface PendingSentMessage {
  row: TimelineUserConversationRow;
  accepted: boolean;
  supersededAtSeq: number | null;
}

interface ThreadPendingSentMessages {
  entries: Map<string, PendingSentMessage>;
  snapshot: readonly PendingSentMessage[];
}

interface PendingSentMessageStore {
  threads: Map<string, ThreadPendingSentMessages>;
  listeners: Set<() => void>;
}

const NO_PENDING_SENT_MESSAGES: readonly PendingSentMessage[] = [];

const storeByClient = new WeakMap<QueryClient, PendingSentMessageStore>();

function pendingSentMessageStore(
  queryClient: QueryClient,
): PendingSentMessageStore {
  let store = storeByClient.get(queryClient);

  if (store === undefined) {
    store = { threads: new Map(), listeners: new Set() };
    storeByClient.set(queryClient, store);
  }

  return store;
}

function publish(
  store: PendingSentMessageStore,
  threadId: string,
  entries: Map<string, PendingSentMessage>,
): void {
  if (entries.size === 0) store.threads.delete(threadId);
  else
    store.threads.set(threadId, { entries, snapshot: [...entries.values()] });

  for (const listener of store.listeners) listener();
}

function updateEntries(
  queryClient: QueryClient,
  threadId: string,
  update: (
    entries: ReadonlyMap<string, PendingSentMessage>,
  ) => Map<string, PendingSentMessage> | null,
): boolean {
  const store = storeByClient.get(queryClient);
  const current = store?.threads.get(threadId);

  if (store === undefined || current === undefined) return false;
  const next = update(current.entries);

  if (next === null) return false;
  publish(store, threadId, next);

  return true;
}

export function addPendingSentMessage(
  queryClient: QueryClient,
  threadId: string,
  row: TimelineUserConversationRow,
): void {
  const store = pendingSentMessageStore(queryClient);
  const entries = new Map(store.threads.get(threadId)?.entries);
  entries.set(row.id, { row, accepted: false, supersededAtSeq: null });
  publish(store, threadId, entries);
}

export function acceptPendingSentMessage(
  queryClient: QueryClient,
  threadId: string,
  rowId: string,
): void {
  updateEntries(queryClient, threadId, (entries) => {
    const entry = entries.get(rowId);

    if (entry === undefined || entry.accepted) return null;

    return new Map(entries).set(rowId, { ...entry, accepted: true });
  });
}

export function removePendingSentMessage(
  queryClient: QueryClient,
  threadId: string,
  rowId: string,
): boolean {
  return updateEntries(queryClient, threadId, (entries) => {
    if (!entries.has(rowId)) return null;
    const next = new Map(entries);
    next.delete(rowId);

    return next;
  });
}

export function getPendingSentMessages(
  queryClient: QueryClient,
  threadId: string,
): readonly PendingSentMessage[] {
  return (
    storeByClient.get(queryClient)?.threads.get(threadId)?.snapshot ??
    NO_PENDING_SENT_MESSAGES
  );
}

export function subscribePendingSentMessages(
  queryClient: QueryClient,
  listener: () => void,
): () => void {
  const store = pendingSentMessageStore(queryClient);
  store.listeners.add(listener);

  return () => {
    store.listeners.delete(listener);
  };
}

function collectSentRequestIds(
  rows: readonly TimelineRow[],
  threadId: string,
  sent: Set<ClientTurnRequestId>,
): void {
  for (const row of rows) {
    if (
      row.threadId === threadId &&
      row.kind === "conversation" &&
      row.role === "user" &&
      row.turnRequest.clientRequestId !== null
    )
      sent.add(row.turnRequest.clientRequestId);

    if (row.kind === "turn" && row.children !== null)
      collectSentRequestIds(row.children, threadId, sent);

    if (
      row.kind === "work" &&
      row.workKind === "delegation" &&
      row.childRows !== null
    )
      collectSentRequestIds(row.childRows, threadId, sent);
  }
}

function isSent(
  entry: PendingSentMessage,
  sent: ReadonlySet<ClientTurnRequestId>,
): boolean {
  const requestId = entry.row.turnRequest.clientRequestId;

  return requestId !== null && sent.has(requestId);
}

interface PendingSentMessageRead {
  threadId: string;
  queryClient: QueryClient;
  displayedMaxSeq: number | undefined;
}

export function beginPendingSentMessageRead({
  displayedMaxSeq,
  queryClient,
  threadId,
}: PendingSentMessageRead): (timeline: {
  maxSeq: number;
  rows: readonly TimelineRow[];
}) => void {
  if (displayedMaxSeq !== undefined)
    updateEntries(queryClient, threadId, (entries) => {
      const retained = new Map(
        [...entries].filter(
          ([, entry]) =>
            entry.supersededAtSeq === null ||
            entry.supersededAtSeq > displayedMaxSeq,
        ),
      );

      return retained.size === entries.size ? null : retained;
    });

  const acceptedBeforeRead = new Set(
    getPendingSentMessages(queryClient, threadId)
      .filter((entry) => entry.accepted)
      .map((entry) => entry.row.id),
  );

  return (timeline) => {
    updateEntries(queryClient, threadId, (entries) => {
      const sent = new Set<ClientTurnRequestId>();
      collectSentRequestIds(timeline.rows, threadId, sent);
      let changed = false;
      const next = new Map<string, PendingSentMessage>();

      for (const [rowId, entry] of entries) {
        const superseded =
          entry.supersededAtSeq === null &&
          (acceptedBeforeRead.has(rowId) || isSent(entry, sent));

        changed ||= superseded;
        next.set(
          rowId,
          superseded ? { ...entry, supersededAtSeq: timeline.maxSeq } : entry,
        );
      }

      return changed ? next : null;
    });
  };
}

interface WithPendingSentMessagesArgs {
  maxSeq: number;
  pending: readonly PendingSentMessage[];
  rows: TimelineRow[];
  threadId: string;
}

export function withPendingSentMessages({
  maxSeq,
  pending,
  rows,
  threadId,
}: WithPendingSentMessagesArgs): TimelineRow[] {
  if (pending.length === 0) return rows;
  const sent = new Set<ClientTurnRequestId>();
  collectSentRequestIds(rows, threadId, sent);

  const unsent = pending.filter(
    (entry) =>
      !isSent(entry, sent) &&
      (entry.supersededAtSeq === null || entry.supersededAtSeq > maxSeq),
  );

  return unsent.length === 0
    ? rows
    : [...rows, ...unsent.map((entry) => entry.row)];
}
