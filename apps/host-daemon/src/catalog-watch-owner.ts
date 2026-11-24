import {
  catalogWatchTouches,
  type CatalogWatch,
  type CatalogCacheScope,
  type HostWatcher,
} from "@omnyo/host-watcher";

interface Interest {
  scope: CatalogCacheScope;
  version: number;
  snapshotKey: string | null;
  leases: Lease[];
  tail: Promise<void>;
  active: number;
}

interface Subscription {
  key: string;
  leases: Set<Lease>;
  ready: Promise<void>;
  cancelReady: (error: Error) => void;
  error: Error | null;
  stop: () => void | Promise<void>;
}

interface Lease {
  owner: Interest;
  targets: CatalogWatch["targets"];
  subscription: Subscription;
}

function scopeKey(scope: CatalogCacheScope): string {
  return JSON.stringify([scope.cwd, scope.providerId]);
}

function orderedWatches(watches: CatalogWatch[]): CatalogWatch[] {
  return watches
    .map((watch) => ({
      rootPath: watch.rootPath,
      ignoredPaths: [...watch.ignoredPaths].sort(),
      targets: [...watch.targets].sort((a, b) => a.path.localeCompare(b.path)),
    }))
    .sort(
      (a, b) =>
        a.rootPath.localeCompare(b.rootPath) ||
        JSON.stringify(a.ignoredPaths).localeCompare(
          JSON.stringify(b.ignoredPaths),
        ),
    );
}

export class CatalogWatchOwner {
  private readonly interests = new Map<string, Interest>();
  private readonly subscriptions = new Map<string, Subscription>();
  private readonly dirty = new Map<string, CatalogCacheScope>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private disposed = false;

  constructor(
    private readonly watcher: HostWatcher,
    private readonly invalidateReader: (scope: CatalogCacheScope) => void,
    private readonly notify: (scopes: CatalogCacheScope[]) => void,
  ) {}

  async read<T>(
    scope: CatalogCacheScope,
    discover: () => Promise<{ result: T; watches: CatalogWatch[] }>,
  ): Promise<T> {
    if (this.disposed) throw new Error("Command catalog is disposed");
    const key = scopeKey(scope);
    let entry = this.interests.get(key);

    if (entry) this.interests.delete(key);
    else
      entry = {
        scope,
        version: 0,
        snapshotKey: null,
        leases: [],
        tail: Promise.resolve(),
        active: 0,
      };
    this.interests.set(key, entry);
    entry.active++;
    const owner = entry;
    const work = entry.tail.then(() => this.stabilize(owner, discover));
    entry.tail = work.then(
      () => undefined,
      () => undefined,
    );

    try {
      return await work;
    } finally {
      entry.active--;

      for (const [oldKey, old] of this.interests) {
        if (this.interests.size <= 32) break;

        if (old.active > 0) continue;
        this.interests.delete(oldKey);
        await this.release(old.leases);
      }
    }
  }

  private async stabilize<T>(
    entry: Interest,
    discover: () => Promise<{ result: T; watches: CatalogWatch[] }>,
  ): Promise<T> {
    let staged: Lease[] = [];
    let stagedKey: string | null = null;

    try {
      for (let attempt = 0; attempt < 3; attempt++) {
        this.requireInterest(entry);
        const version = entry.version;
        const { result, watches } = await discover();

        this.requireInterest(entry);
        const ordered = orderedWatches(watches);
        const key = JSON.stringify(ordered);

        if (key === entry.snapshotKey || key === stagedKey) {
          const leases = key === entry.snapshotKey ? entry.leases : staged;

          for (const lease of leases) {
            if (lease.subscription.error) throw lease.subscription.error;
          }

          if (version !== entry.version) continue;

          if (leases === staged) {
            const old = entry.leases;
            entry.leases = staged;
            staged = [];
            entry.snapshotKey = key;
            await this.release(old);
          }

          return result;
        }

        const previous = staged;
        staged = [];

        try {
          for (const watch of ordered) staged.push(this.acquire(entry, watch));
          await Promise.all(
            staged.map(({ subscription }) => subscription.ready),
          );
        } finally {
          await this.release(previous);
        }

        stagedKey = key;
      }

      throw new Error(
        "Command catalog changed during watch registration; retry after edits finish",
      );
    } finally {
      await this.release(staged);
    }
  }

  private requireInterest(entry: Interest): void {
    if (this.disposed || this.interests.get(scopeKey(entry.scope)) !== entry)
      throw new Error("Command catalog interest was released");
  }

  async retain(scopes: readonly CatalogCacheScope[]): Promise<void> {
    const retained = new Set(scopes.map(scopeKey));
    const removed = new Set<Interest>();

    for (const [key, entry] of this.interests) {
      if (retained.has(key)) continue;
      this.interests.delete(key);
      this.dirty.delete(key);
      removed.add(entry);
    }

    const abandoned: Lease[] = [];

    for (const subscription of this.subscriptions.values()) {
      for (const lease of subscription.leases) {
        if (removed.has(lease.owner)) abandoned.push(lease);
      }
    }

    await this.release(abandoned);
  }

  private acquire(entry: Interest, watch: CatalogWatch): Lease {
    const key = JSON.stringify([watch.rootPath, watch.ignoredPaths]);
    let subscription = this.subscriptions.get(key);

    if (!subscription) {
      const start = this.watcher.watchPathRoot;

      if (!start)
        throw new Error("Command catalog filesystem watching is unavailable");
      let ready!: () => void;
      let reject!: (err: Error) => void;

      const pending = new Promise<void>((resolve, fail) => {
        ready = resolve;
        reject = fail;
      });

      void pending.catch(() => undefined);

      const state: Subscription = {
        key,
        leases: new Set(),
        ready: pending,
        cancelReady: reject,
        error: null,
        stop: () => undefined,
      };

      state.stop = start.call(this.watcher, {
        rootPath: watch.rootPath,
        ignoredPaths: watch.ignoredPaths,
        onReady: () => {
          const recovered = state.error !== null;
          state.error = null;
          state.ready = Promise.resolve();
          ready();

          if (recovered) this.changed(state);
        },
        onChange: (changes) =>
          this.changed(
            state,
            changes.map((change) => change.path),
          ),
        onRescanRequired: () => this.changed(state),
        onWatchError: ({ message }) => {
          state.error = new Error(message);
          reject(state.error);
          this.changed(state);
        },
      });
      this.subscriptions.set(key, state);
      subscription = state;
    }

    const lease = { owner: entry, targets: watch.targets, subscription };
    subscription.leases.add(lease);

    return lease;
  }

  private changed(subscription: Subscription, paths?: string[]): void {
    if (this.disposed) return;
    const affected = new Set<Interest>();

    for (const lease of subscription.leases) {
      if (
        paths &&
        !paths.some((path) =>
          lease.targets.some((target) => catalogWatchTouches(target, path)),
        )
      )
        continue;
      affected.add(lease.owner);
    }

    for (const owner of affected) {
      owner.version++;
      this.invalidateReader(owner.scope);
      this.dirty.set(scopeKey(owner.scope), owner.scope);
    }

    if (this.dirty.size === 0 || this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      const scopes = [...this.dirty.values()];
      this.dirty.clear();

      for (let start = 0; start < scopes.length; start += 32)
        this.notify(scopes.slice(start, start + 32));
    }, 75);
    this.timer.unref();
  }

  private async release(leases: Lease[]): Promise<void> {
    const stops = [];

    for (const lease of leases) {
      const root = lease.subscription;
      root.leases.delete(lease);

      if (root.leases.size || this.subscriptions.get(root.key) !== root)
        continue;
      this.subscriptions.delete(root.key);
      root.cancelReady(new Error("Command catalog watch was released"));
      stops.push(root.stop());
    }

    await Promise.all(stops);
  }

  async dispose(): Promise<void> {
    this.disposed = true;

    if (this.timer) clearTimeout(this.timer);
    this.dirty.clear();
    const entries = [...this.interests.values()];
    this.interests.clear();

    for (const subscription of this.subscriptions.values())
      subscription.cancelReady(new Error("Command catalog is disposed"));
    await Promise.all(entries.map((entry) => entry.tail));
    await Promise.all(entries.map((entry) => this.release(entry.leases)));
  }
}
