import { createSnapshotInvalidator } from "./snapshot-invalidation";
import { hashKey, type QueryClient } from "@tanstack/react-query";
import type { InboxSnapshot } from "@omnyo/domain";
import type { InboxPredict } from "@/lib/inbox-predictions";

export const INBOX_SNAPSHOT_QUERY_KEY = ["inbox", "snapshot"] as const;

export const INBOX_SNAPSHOT_QUERY_POLICY = {
  staleTime: 250,
  refetchOnMount: true,
  refetchOnWindowFocus: true,
  refetchOnReconnect: true,
  retry: 3,
  retryDelay: (attempt: number) => Math.min(1_000 * 2 ** attempt, 4_000),
} as const;

export const { invalidate: markInboxSnapshotDirty } = createSnapshotInvalidator(
  INBOX_SNAPSHOT_QUERY_KEY,
);

export function inboxSnapshotState<Snapshot>(query: {
  data: Snapshot | undefined;
  isError: boolean;
  isRefetchError: boolean;
  failureCount: number;
}): {
  snapshot: Snapshot | null;
  status: "loading" | "ready" | "error";
  stale: boolean;
} {
  return {
    snapshot: query.data ?? null,
    status: query.isError
      ? "error"
      : query.data === undefined
        ? "loading"
        : "ready",
    stale:
      query.data !== undefined &&
      (query.isRefetchError || query.failureCount > 0),
  };
}

interface PendingInboxPrediction {
  predict: InboxPredict;
  settledAfter: number | null;
}

interface InboxPredictionRegistry {
  predictions: Map<number, PendingInboxPrediction>;
  nextId: number;
  generation: number;
  startedFetches: number;
  completedFetch: number;
  listeners: Set<() => void>;
  derived: {
    data: InboxSnapshot | undefined;
    generation: number;
    snapshot: InboxSnapshot | undefined;
  } | null;
}

export interface InboxPrediction {
  replace: (predict: InboxPredict) => void;
  settle: () => void;
  discard: () => void;
}

const INBOX_SNAPSHOT_QUERY_HASH = hashKey(INBOX_SNAPSHOT_QUERY_KEY);

const PREDICTED_REVISION_MARK = "~p";

export function inboxServerRevision(revision: string): string {
  const at = revision.indexOf(PREDICTED_REVISION_MARK);

  return at < 0 ? revision : revision.slice(0, at);
}

const predictionRegistries = new WeakMap<
  QueryClient,
  InboxPredictionRegistry
>();

function readServerInboxSnapshot(
  queryClient: QueryClient,
): InboxSnapshot | undefined {
  return queryClient.getQueryData<InboxSnapshot>(INBOX_SNAPSHOT_QUERY_KEY);
}

function notifyInboxPredictionListeners(
  registry: InboxPredictionRegistry,
): void {
  for (const listener of [...registry.listeners]) listener();
}

function changeInboxPredictions(registry: InboxPredictionRegistry): void {
  registry.generation += 1;
  notifyInboxPredictionListeners(registry);
}

function retireFetchedInboxPredictions(
  registry: InboxPredictionRegistry,
): void {
  let retired = false;

  for (const [id, prediction] of registry.predictions) {
    if (
      prediction.settledAfter !== null &&
      registry.completedFetch > prediction.settledAfter
    ) {
      registry.predictions.delete(id);
      retired = true;
    }
  }

  if (retired) registry.generation += 1;
}

function inboxPredictionRegistry(
  queryClient: QueryClient,
): InboxPredictionRegistry {
  const existing = predictionRegistries.get(queryClient);

  if (existing) return existing;

  const registry: InboxPredictionRegistry = {
    predictions: new Map(),
    nextId: 0,
    generation: 0,
    startedFetches: 0,
    completedFetch: 0,
    listeners: new Set(),
    derived: null,
  };

  predictionRegistries.set(queryClient, registry);
  queryClient.getQueryCache().subscribe((event) => {
    if (
      event.type !== "updated" ||
      event.query.queryHash !== INBOX_SNAPSHOT_QUERY_HASH
    )
      return;

    if (event.action.type === "success" && event.action.manual !== true)
      retireFetchedInboxPredictions(registry);

    if (event.action.type === "success" || event.action.type === "error")
      notifyInboxPredictionListeners(registry);
  });

  return registry;
}

export async function fetchInboxSnapshot(
  queryClient: QueryClient,
  fetch: () => Promise<InboxSnapshot>,
): Promise<InboxSnapshot> {
  const registry = inboxPredictionRegistry(queryClient);
  registry.startedFetches += 1;
  const fetchNumber = registry.startedFetches;
  const snapshot = await fetch();
  registry.completedFetch = Math.max(registry.completedFetch, fetchNumber);

  return snapshot;
}

export function predictInboxSnapshot(
  queryClient: QueryClient,
  predict: InboxPredict,
): InboxPrediction {
  const registry = inboxPredictionRegistry(queryClient);
  const id = registry.nextId;
  registry.nextId += 1;
  registry.predictions.set(id, { predict, settledAfter: null });
  changeInboxPredictions(registry);

  return {
    replace(next) {
      const prediction = registry.predictions.get(id);

      if (!prediction) return;
      prediction.predict = next;
      changeInboxPredictions(registry);
    },
    settle() {
      const prediction = registry.predictions.get(id);

      if (!prediction || prediction.settledAfter !== null) return;

      if (readServerInboxSnapshot(queryClient) === undefined) {
        registry.predictions.delete(id);
        changeInboxPredictions(registry);

        return;
      }

      prediction.settledAfter = registry.startedFetches;
      markInboxSnapshotDirty(queryClient);
    },
    discard() {
      if (registry.predictions.delete(id)) changeInboxPredictions(registry);
    },
  };
}

export function readPredictedInboxSnapshot(
  queryClient: QueryClient,
): InboxSnapshot | undefined {
  const registry = inboxPredictionRegistry(queryClient);
  const data = readServerInboxSnapshot(queryClient);
  const derived = registry.derived;

  if (
    derived !== null &&
    derived.data === data &&
    derived.generation === registry.generation
  )
    return derived.snapshot;

  const snapshot =
    data === undefined || registry.predictions.size === 0
      ? data
      : {
          ...[...registry.predictions.values()].reduce(
            (current, prediction) => prediction.predict(current),
            data,
          ),
          revision: `${data.revision}${PREDICTED_REVISION_MARK}${registry.generation}`,
        };

  registry.derived = { data, generation: registry.generation, snapshot };

  return snapshot;
}

export function subscribeInboxSnapshot(
  queryClient: QueryClient,
  listener: () => void,
): () => void {
  const registry = inboxPredictionRegistry(queryClient);
  registry.listeners.add(listener);

  return () => {
    registry.listeners.delete(listener);
  };
}
