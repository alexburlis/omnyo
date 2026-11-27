import { useRealtime, useRealtimeConnectionState } from "@omnyo/plugin-sdk/app";
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";

import { errorFromCatch, type SmError } from "./client.js";
import { REALTIME_CHANNEL } from "./contract.js";

export interface QuerySnapshot<Value> {
  data: Value | undefined;
  error: SmError | null;
  isLoading: boolean;
  updatedAt: number | null;
}

interface Entry {
  snapshot: QuerySnapshot<QueryValue>;
  fetcher: () => Promise<QueryValue>;
  listeners: Set<() => void>;
  inflight: Promise<void> | null;
  generation: number;
  dirty: boolean;
}

type QueryValue = NonNullable<object> | string | number | boolean | null;

const EMPTY: QuerySnapshot<QueryValue> = {
  data: undefined,
  error: null,
  isLoading: true,
  updatedAt: null,
};

export class QueryStore {
  private readonly entries = new Map<string, Entry>();

  private readonly globalListeners = new Set<() => void>();

  snapshot(key: string): QuerySnapshot<QueryValue> {
    return this.entries.get(key)?.snapshot ?? EMPTY;
  }

  subscribe(key: string, fetcher: () => Promise<QueryValue>, listener: () => void): () => void {
    let entry = this.entries.get(key);

    if (entry === undefined) {
      entry = {
        snapshot: EMPTY,
        fetcher,
        listeners: new Set(),
        inflight: null,
        generation: 0,
        dirty: false,
      };
      this.entries.set(key, entry);
    }

    entry.fetcher = fetcher;
    entry.listeners.add(listener);

    if (entry.snapshot.updatedAt === null && entry.inflight === null) void this.fetch(key);

    return () => {
      entry.listeners.delete(listener);
    };
  }

  setFetcher(key: string, fetcher: () => Promise<QueryValue>): void {
    const entry = this.entries.get(key);

    if (entry !== undefined) entry.fetcher = fetcher;
  }

  async fetch(key: string): Promise<void> {
    const entry = this.entries.get(key);

    if (entry === undefined) return;

    if (entry.inflight !== null) {
      entry.dirty = true;

      return entry.inflight;
    }

    const generation = ++entry.generation;

    this.update(entry, { ...entry.snapshot, isLoading: true });

    const run = (async () => {
      try {
        const data = await entry.fetcher();

        if (generation === entry.generation)
          this.update(entry, { data, error: null, isLoading: false, updatedAt: Date.now() });
      } catch (caught) {
        if (generation === entry.generation)
          this.update(entry, {
            ...entry.snapshot,
            error: errorFromCatch(caught instanceof Error ? caught : null),
            isLoading: false,
          });
      } finally {
        entry.inflight = null;

        if (entry.dirty) {
          entry.dirty = false;
          void this.fetch(key);
        }
      }
    })();

    entry.inflight = run;

    return run;
  }

  set(key: string, data: QueryValue): void {
    const entry = this.entries.get(key);

    if (entry === undefined) return;

    entry.generation += 1;
    this.update(entry, { data, error: null, isLoading: false, updatedAt: Date.now() });
  }

  refetchAll(): void {
    for (const [key, entry] of this.entries) if (entry.listeners.size > 0) void this.fetch(key);
  }

  refetchMatching(fragment: string): void {
    for (const [key, entry] of this.entries)
      if (entry.listeners.size > 0 && key.includes(fragment)) void this.fetch(key);
  }

  onAnyChange(listener: () => void): () => void {
    this.globalListeners.add(listener);

    return () => {
      this.globalListeners.delete(listener);
    };
  }

  private update(entry: Entry, snapshot: QuerySnapshot<QueryValue>): void {
    entry.snapshot = snapshot;

    for (const listener of entry.listeners) listener();

    for (const listener of this.globalListeners) listener();
  }
}

const StoreContext = createContext<QueryStore | null>(null);

export function QueryProvider({ children }: { children: ReactNode }) {
  const [store] = useState(() => new QueryStore());

  return (
    <StoreContext.Provider value={store}>
      <LiveRefresh store={store} />
      {children}
    </StoreContext.Provider>
  );
}

function LiveRefresh({ store }: { store: QueryStore }) {
  const connection = useRealtimeConnectionState();
  const previous = useRef(connection);

  useRealtime(REALTIME_CHANNEL, () => {
    store.refetchAll();
  });

  useEffect(() => {
    const wasReconnecting = previous.current === "reconnecting";

    previous.current = connection;

    if (wasReconnecting && connection === "connected") store.refetchAll();
  }, [connection, store]);

  return null;
}

export function useQueryStore(): QueryStore {
  const store = useContext(StoreContext);

  if (store === null) throw new Error("State machines views must render inside QueryProvider");

  return store;
}

export function useSmQuery<Value extends QueryValue>(
  key: string | null,
  fetcher: () => Promise<Value>,
): QuerySnapshot<Value> & { refetch: () => void } {
  const store = useQueryStore();
  const fetcherRef = useRef(fetcher);

  fetcherRef.current = fetcher;

  const stableFetcher = useCallback(() => fetcherRef.current(), []);

  const subscribe = useCallback(
    (listener: () => void) =>
      key === null ? () => undefined : store.subscribe(key, stableFetcher, listener),
    [key, stableFetcher, store],
  );

  const snapshot = useSyncExternalStore(subscribe, () =>
    key === null ? EMPTY : store.snapshot(key),
  );

  const refetch = useCallback(() => {
    if (key !== null) void store.fetch(key);
  }, [key, store]);

  return { ...narrowSnapshot<Value>(snapshot), refetch };
}

function narrowSnapshot<Value extends QueryValue>(
  snapshot: QuerySnapshot<QueryValue>,
): QuerySnapshot<Value> {
  // oxlint-disable-next-line anti-slop/require-safety-comment-for-type-assertion -- one key is only subscribed with fetchers of one Value type
  return snapshot as QuerySnapshot<Value>;
}
