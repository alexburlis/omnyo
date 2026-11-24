import type { QueryClient } from "@tanstack/react-query";
import { z } from "zod";
import {
  threadTimelineResponseSchema,
  threadWithIncludesResponseSchema,
  type ThreadTimelineResponse,
  type ThreadWithIncludesResponse,
} from "@omnyo/server-contract";
import {
  threadDetailBootstrapQueryKey,
  threadOpenRuntimeIdentityQueryKey,
  threadTimelineQueryKey,
} from "@/hooks/queries/query-keys";
import { ingestThreadDetailBootstrap } from "./thread-detail-cache-owner";
import {
  admitThreadTimelineHistory,
  getThreadOpenRuntimeId,
  getThreadTimelineRuntimeId,
  rememberThreadOpenRuntimeId,
  rememberThreadTimelineRuntimeId,
} from "./thread-open-cache-owner";

import {
  THREAD_OPEN_SNAPSHOT_DATABASE,
  THREAD_OPEN_SNAPSHOT_STORE,
  THREAD_OPEN_SNAPSHOT_DATABASE_VERSION,
} from "./thread-open-snapshot-storage-contract";

export {
  THREAD_OPEN_SNAPSHOT_DATABASE,
  THREAD_OPEN_SNAPSHOT_STORE,
} from "./thread-open-snapshot-storage-contract";

export const THREAD_OPEN_SNAPSHOT_MAX_RECORD_BYTES = 2 * 1024 * 1024;

export const THREAD_OPEN_SNAPSHOT_WRITE_DELAY_MS = 2_000;

export const THREAD_OPEN_SNAPSHOT_WRITE_IDLE_TIMEOUT_MS = 5_000;

const SNAPSHOT_SCHEMA_VERSION = 2;

const snapshotRecordSchema = z.object({
  schema: z.literal(SNAPSHOT_SCHEMA_VERSION),
  key: z.string().min(1),
  origin: z.string().min(1),
  threadId: z.string().min(1),
  runtimeId: z.string().min(1),
  savedAt: z.number().int().nonnegative(),
  bootstrap: z.unknown(),
  timeline: z.unknown(),
});

type SnapshotRecord = z.infer<typeof snapshotRecordSchema>;

interface ThreadOpenSnapshot {
  bootstrap: ThreadWithIncludesResponse;
  runtimeId: string;
  savedAt: number;
  timeline: ThreadTimelineResponse;
}

function snapshotKey(origin: string, threadId: string): string {
  return `${origin}\u0000${threadId}`;
}

function currentOrigin(): string | null {
  return typeof window === "undefined" ? null : window.location.origin;
}

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

let databasePromise: Promise<IDBDatabase | null> | null = null;

function openDatabase(): Promise<IDBDatabase | null> {
  if (databasePromise !== null) return databasePromise;

  databasePromise =
    typeof indexedDB === "undefined"
      ? Promise.resolve(null)
      : new Promise<IDBDatabase | null>((resolve) => {
          const request = indexedDB.open(
            THREAD_OPEN_SNAPSHOT_DATABASE,
            THREAD_OPEN_SNAPSHOT_DATABASE_VERSION,
          );

          request.onupgradeneeded = () => {
            if (
              !request.result.objectStoreNames.contains(
                THREAD_OPEN_SNAPSHOT_STORE,
              )
            )
              request.result.createObjectStore(THREAD_OPEN_SNAPSHOT_STORE, {
                keyPath: "key",
              });
          };

          request.onsuccess = () => resolve(request.result);
          request.onerror = () => resolve(null);
          request.onblocked = () => resolve(null);
        });

  return databasePromise;
}

let snapshotsPromise: Promise<Map<string, SnapshotRecord>> | null = null;

export function loadThreadOpenSnapshots(): Promise<
  Map<string, SnapshotRecord>
> {
  if (snapshotsPromise !== null) return snapshotsPromise;
  const origin = currentOrigin();

  snapshotsPromise = openDatabase().then(async (database) => {
    const snapshots = new Map<string, SnapshotRecord>();

    if (database === null || origin === null) return snapshots;

    try {
      const records = await requestResult(
        database
          .transaction(THREAD_OPEN_SNAPSHOT_STORE, "readonly")
          .objectStore(THREAD_OPEN_SNAPSHOT_STORE)
          .getAll(),
      );

      for (const value of records) {
        const parsed = snapshotRecordSchema.safeParse(value);

        if (parsed.success && parsed.data.origin === origin)
          snapshots.set(parsed.data.threadId, parsed.data);
      }
    } catch {
      return snapshots;
    }

    return snapshots;
  });

  return snapshotsPromise;
}

function parseSnapshot(record: SnapshotRecord): ThreadOpenSnapshot | null {
  const bootstrap = threadWithIncludesResponseSchema.safeParse(
    record.bootstrap,
  );

  const timeline = threadTimelineResponseSchema.safeParse(record.timeline);

  if (
    !bootstrap.success ||
    !timeline.success ||
    bootstrap.data.id !== record.threadId ||
    bootstrap.data.archivedAt !== null ||
    timeline.data.runtimeId !== record.runtimeId ||
    timeline.data.delta !== undefined
  )
    return null;

  return {
    bootstrap: bootstrap.data,
    runtimeId: record.runtimeId,
    savedAt: record.savedAt,
    timeline: timeline.data,
  };
}

export function seedThreadOpenSnapshot(
  queryClient: QueryClient,
  threadId: string,
  record: SnapshotRecord,
): boolean {
  const knownRuntimeId = getThreadOpenRuntimeId(queryClient);

  if (knownRuntimeId !== undefined && knownRuntimeId !== record.runtimeId)
    return false;

  if (
    queryClient.getQueryData(threadDetailBootstrapQueryKey(threadId)) !==
      undefined ||
    queryClient.getQueryData(threadTimelineQueryKey(threadId)) !== undefined
  )
    return false;

  const snapshot = parseSnapshot(record);

  if (snapshot === null) return false;
  rememberThreadOpenRuntimeId(queryClient, snapshot.runtimeId);

  if (
    queryClient.getQueryData(threadOpenRuntimeIdentityQueryKey()) === undefined
  )
    queryClient.setQueryData(
      threadOpenRuntimeIdentityQueryKey(),
      snapshot.runtimeId,
      { updatedAt: snapshot.savedAt },
    );

  rememberThreadTimelineRuntimeId(queryClient, threadId, snapshot.runtimeId);
  admitThreadTimelineHistory(queryClient, threadId, snapshot.timeline);
  ingestThreadDetailBootstrap({ queryClient, thread: snapshot.bootstrap });
  queryClient.setQueryData(
    threadDetailBootstrapQueryKey(threadId),
    snapshot.bootstrap,
    { updatedAt: snapshot.savedAt },
  );
  queryClient.setQueryData(
    threadTimelineQueryKey(threadId),
    snapshot.timeline,
    {
      updatedAt: snapshot.savedAt,
    },
  );
  void queryClient.invalidateQueries(
    { queryKey: threadDetailBootstrapQueryKey(threadId), exact: true },
    { cancelRefetch: false },
  );
  void queryClient.invalidateQueries(
    { queryKey: threadTimelineQueryKey(threadId), exact: true },
    { cancelRefetch: false },
  );

  return true;
}

function measureBytes(value: unknown): number {
  try {
    return JSON.stringify(value).length * 2;
  } catch {
    return Infinity;
  }
}

async function writeRecords(
  records: readonly SnapshotRecord[],
  deletedKeys: readonly string[],
): Promise<void> {
  const database = await openDatabase();

  if (database === null) return;

  try {
    const transaction = database.transaction(
      THREAD_OPEN_SNAPSHOT_STORE,
      "readwrite",
    );

    const store = transaction.objectStore(THREAD_OPEN_SNAPSHOT_STORE);

    for (const record of records) store.put(record);

    for (const key of deletedKeys) store.delete(key);

    await new Promise<void>((resolve) => {
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => resolve();
      transaction.onabort = () => resolve();
    });
  } catch {
    return;
  }
}

function whenIdle(callback: () => void): void {
  if (typeof requestIdleCallback === "function") {
    requestIdleCallback(callback, {
      timeout: THREAD_OPEN_SNAPSHOT_WRITE_IDLE_TIMEOUT_MS,
    });

    return;
  }

  setTimeout(callback, 0);
}

export function createThreadOpenSnapshotWriter(queryClient: QueryClient) {
  const pending = new Set<string>();
  const deleted = new Set<string>();
  let targets: ReadonlySet<string> = new Set();
  let timer: ReturnType<typeof setTimeout> | null = null;
  let disposed = false;

  const flush = () => {
    timer = null;

    if (disposed) return;
    whenIdle(() => {
      const origin = currentOrigin();

      if (disposed || origin === null) return;
      const records: SnapshotRecord[] = [];

      for (const threadId of pending) {
        if (!targets.has(threadId)) continue;

        const bootstrap = queryClient.getQueryData<ThreadWithIncludesResponse>(
          threadDetailBootstrapQueryKey(threadId),
        );

        const timeline = queryClient.getQueryData<ThreadTimelineResponse>(
          threadTimelineQueryKey(threadId),
        );

        const runtimeId = timeline?.runtimeId;

        if (
          bootstrap?.id !== threadId ||
          bootstrap.archivedAt !== null ||
          timeline === undefined ||
          timeline.delta !== undefined ||
          runtimeId === undefined ||
          getThreadTimelineRuntimeId(queryClient, threadId) !== runtimeId ||
          measureBytes(timeline) > THREAD_OPEN_SNAPSHOT_MAX_RECORD_BYTES
        )
          continue;

        records.push({
          schema: SNAPSHOT_SCHEMA_VERSION,
          key: snapshotKey(origin, threadId),
          origin,
          threadId,
          runtimeId,
          savedAt: Date.now(),
          bootstrap,
          timeline,
        });
      }

      pending.clear();

      const deletedKeys = [...deleted].map((threadId) =>
        snapshotKey(origin, threadId),
      );

      deleted.clear();

      if (records.length > 0 || deletedKeys.length > 0)
        void writeRecords(records, deletedKeys);
    });
  };

  const schedule = (threadId: string) => {
    pending.add(threadId);

    if (timer === null)
      timer = setTimeout(flush, THREAD_OPEN_SNAPSHOT_WRITE_DELAY_MS);
  };

  const unsubscribe = queryClient.getQueryCache().subscribe((event) => {
    if (
      event.type !== "updated" ||
      event.action.type !== "success" ||
      event.action.manual === true
    )
      return;
    const [kind, threadId] = event.query.queryKey;

    if (typeof threadId !== "string" || !targets.has(threadId)) return;

    if (
      kind === threadTimelineQueryKey(threadId)[0] ||
      kind === threadDetailBootstrapQueryKey(threadId)[0]
    )
      schedule(threadId);
  });

  return {
    setTargets(next: ReadonlySet<string>) {
      for (const threadId of targets)
        if (!next.has(threadId)) deleted.add(threadId);

      targets = next;

      if (deleted.size > 0 && timer === null)
        timer = setTimeout(flush, THREAD_OPEN_SNAPSHOT_WRITE_DELAY_MS);
    },
    dispose() {
      disposed = true;
      unsubscribe();

      if (timer !== null) clearTimeout(timer);
    },
  };
}

export const THREAD_OPEN_SNAPSHOT_SEED_BATCH = 8;

export const THREAD_OPEN_SNAPSHOT_SEED_STEP_MS = 16;

export async function seedThreadOpenSnapshots(
  queryClient: QueryClient,
  threadIds: readonly string[],
  isCurrent: () => boolean,
): Promise<void> {
  const snapshots = await loadThreadOpenSnapshots();
  const queue = threadIds.filter((threadId) => snapshots.has(threadId));

  while (queue.length > 0 && isCurrent()) {
    await new Promise<void>((resolve) =>
      setTimeout(resolve, THREAD_OPEN_SNAPSHOT_SEED_STEP_MS),
    );

    for (const threadId of queue.splice(0, THREAD_OPEN_SNAPSHOT_SEED_BATCH)) {
      const record = snapshots.get(threadId);

      if (record !== undefined && isCurrent())
        seedThreadOpenSnapshot(queryClient, threadId, record);
    }
  }
}
