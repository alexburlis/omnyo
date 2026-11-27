export const BACKGROUND_REFRESH_MS = 60_000;

export interface Snapshot<T> {
  value: T | null;
  error: string | null;
  loadedAt: number | null;
  loading: boolean;
}

export type Load<T> = () => Promise<T>;

export interface LoadCache<T> {
  get: () => Snapshot<T>;
  subscribe: (listener: () => void) => () => void;
  refresh: (load: Load<T>) => void;
  changed: (load: Load<T>) => void;
  watch: () => () => void;
}

export function createLoadCache<T>(
  now: () => number = Date.now,
  backgroundMs: number = BACKGROUND_REFRESH_MS,
): LoadCache<T> {
  let snapshot: Snapshot<T> = { value: null, error: null, loadedAt: null, loading: false };
  let latest: Load<T> | null = null;
  let again = false;
  let watchers = 0;
  let background: ReturnType<typeof setTimeout> | null = null;
  const listeners = new Set<() => void>();

  const publish = (next: Snapshot<T>) => {
    snapshot = next;

    for (const listener of listeners) listener();
  };

  const run = async () => {
    publish({ ...snapshot, loading: true });

    do {
      again = false;
      const load = latest;

      if (load === null) break;

      try {
        const value = await load();

        publish({ value, error: null, loadedAt: now(), loading: true });
      } catch (failure) {
        publish({
          ...snapshot,
          error: failure instanceof Error ? failure.message : "Something went wrong.",
        });
      }
    } while (again);

    publish({ ...snapshot, loading: false });
  };

  const refresh = (load: Load<T>) => {
    latest = load;

    if (background !== null) {
      clearTimeout(background);
      background = null;
    }

    if (snapshot.loading) {
      again = true;

      return;
    }

    void run();
  };

  const changed = (load: Load<T>) => {
    latest = load;

    if (watchers > 0 || background !== null) return;
    const age = snapshot.loadedAt === null ? Infinity : now() - snapshot.loadedAt;

    background = setTimeout(
      () => {
        background = null;
        refresh(load);
      },
      Math.max(0, backgroundMs - age),
    );
    background.unref?.();
  };

  return {
    get: () => snapshot,
    subscribe: (listener) => {
      listeners.add(listener);

      return () => listeners.delete(listener);
    },
    refresh,
    changed,
    watch: () => {
      watchers += 1;

      return () => {
        watchers -= 1;
      };
    },
  };
}
