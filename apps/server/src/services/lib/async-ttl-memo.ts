export interface AsyncTtlMemo<TKey, TValue> {
  clear(): void;
  invalidateWhere(predicate: (key: TKey) => boolean): void;
  run(
    key: TKey,
    task: () => Promise<TValue>,
    refresh?: boolean,
  ): Promise<TValue>;
}

interface CreateAsyncTtlMemoOptions<TValue> {
  ttlMs: number | ((value: TValue) => number);
  now?: () => number;
  maxEntries?: number;
  staleWhileRevalidate?: boolean;
  expireWhileIdle?: boolean;
}

interface MemoEntry<TValue> {
  expiresAt: number;
  value: TValue;
  expiry?: ReturnType<typeof setTimeout>;
}

export function createAsyncTtlMemo<TKey, TValue>({
  ttlMs,
  now = () => Date.now(),
  maxEntries = Number.POSITIVE_INFINITY,
  staleWhileRevalidate = false,
  expireWhileIdle = false,
}: CreateAsyncTtlMemoOptions<TValue>): AsyncTtlMemo<TKey, TValue> {
  const settledByKey = new Map<TKey, MemoEntry<TValue>>();
  const pendingByKey = new Map<TKey, Promise<TValue>>();
  const entryLimit = Math.max(1, maxEntries);

  function deleteSettled(key: TKey): void {
    const expiry = settledByKey.get(key)?.expiry;

    if (expiry !== undefined) clearTimeout(expiry);
    settledByKey.delete(key);
  }

  function pruneExpired(currentTime: number): void {
    for (const [key, entry] of settledByKey) {
      if (entry.expiresAt <= currentTime) {
        deleteSettled(key);
      }
    }
  }

  function start(key: TKey, task: () => Promise<TValue>): Promise<TValue> {
    const started = new Promise<TValue>((resolve) => resolve(task()))
      .then((value) => {
        if (pendingByKey.get(key) !== started) return value;
        const ttl = typeof ttlMs === "function" ? ttlMs(value) : ttlMs;

        if (ttl <= 0) {
          deleteSettled(key);

          return value;
        }

        const settledAt = now();

        if (!staleWhileRevalidate) pruneExpired(settledAt);
        deleteSettled(key);

        while (settledByKey.size >= entryLimit) {
          const oldest = settledByKey.keys().next();

          if (oldest.done) break;
          deleteSettled(oldest.value);
        }

        const entry: MemoEntry<TValue> = { value, expiresAt: settledAt + ttl };

        if (expireWhileIdle) {
          entry.expiry = setTimeout(() => deleteSettled(key), ttl).unref();
        }

        settledByKey.set(key, entry);

        return value;
      })
      .finally(() => {
        if (pendingByKey.get(key) === started) {
          pendingByKey.delete(key);
        }
      });

    pendingByKey.set(key, started);

    return started;
  }

  return {
    clear() {
      for (const key of settledByKey.keys()) deleteSettled(key);
      pendingByKey.clear();
    },
    invalidateWhere(predicate) {
      for (const key of settledByKey.keys()) {
        if (predicate(key)) deleteSettled(key);
      }

      for (const key of pendingByKey.keys()) {
        if (predicate(key)) pendingByKey.delete(key);
      }
    },
    run(key, task, refresh = false) {
      const settled = settledByKey.get(key);

      if (!refresh && settled !== undefined) {
        if (settled.expiresAt > now()) return Promise.resolve(settled.value);

        if (staleWhileRevalidate) {
          if (!pendingByKey.has(key)) start(key, task).catch(() => undefined);

          return Promise.resolve(settled.value);
        }
      }

      const pending = pendingByKey.get(key);

      if (pending !== undefined) return pending;
      settledByKey.delete(key);

      return start(key, task);
    },
  };
}
