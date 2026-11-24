import fs from "node:fs/promises";
import path from "node:path";
import { isPathWithinDirectory } from "@omnyo/process-utils";
import type { HostWatcher } from "./host-watcher-types.js";

type Observe = (filePath: string, shallow?: boolean) => Promise<void>;

export interface CatalogWatch {
  rootPath: string;
  ignoredPaths: string[];
  targets: { path: string; shallow: boolean }[];
}

export interface CatalogSnapshot<T> {
  value: T;
  watches: CatalogWatch[];
}

export interface CatalogObservationOptions {
  mode: "observation-only";
}

export interface CatalogCacheScope {
  cwd: string | null;
  providerId: string;
}

export function catalogWatchTouches(
  target: CatalogWatch["targets"][number],
  changedPath: string,
): boolean {
  return (
    (target.shallow
      ? path.dirname(changedPath) === target.path || changedPath === target.path
      : isPathWithinDirectory(target.path, changedPath)) ||
    isPathWithinDirectory(changedPath, target.path)
  );
}

interface Entry<T> {
  scope: CatalogCacheScope | null;
  retained: boolean;
  version: number;
  rescanVersion: number;
  builtRescanVersion: number;
  snapshot: CatalogSnapshot<T> | undefined;
  bytes: number;
  pending: Promise<CatalogSnapshot<T>> | null;
  roots: Set<string>;
  stamps: Map<string, { shallow: boolean; value: string }>;
}

interface Root<T> {
  targets: Map<Entry<T>, Map<string, boolean>>;
  path: string;
  shallow: boolean;
  ignoredPaths: string[];
  ready: Promise<void>;
  finishReady: () => void;
  error: Error | null;
  stop: () => void | Promise<void>;
}

export class CatalogCache<T> {
  private readonly entries = new Map<string, Entry<T>>();
  private readonly roots = new Map<string, Root<T>>();
  private readonly pending = new Set<Promise<CatalogSnapshot<T>>>();
  private readonly stopping = new Set<Promise<void>>();
  private bytes = 0;
  private disposed = false;
  private notifyTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly limits = { entries: 32, bytes: 16 * 1024 * 1024 };
  private readonly watcher: HostWatcher | null;
  private readonly onChange: () => void;

  constructor(watcher: HostWatcher, onChange: () => void);
  constructor(options: CatalogObservationOptions);
  constructor(
    source: HostWatcher | CatalogObservationOptions,
    onChange?: () => void,
  ) {
    if ("mode" in source) {
      this.watcher = null;
      this.onChange = () => undefined;
    } else {
      if (!onChange)
        throw new Error("Command catalog requires a change handler");
      this.watcher = source;
      this.onChange = onChange;
    }
  }

  invalidate(): void {
    for (const entry of this.entries.values()) {
      entry.version++;
      entry.rescanVersion++;
    }
  }

  async retain(scopes: readonly CatalogCacheScope[]): Promise<void> {
    const retained = new Set(
      scopes.map((scope) => JSON.stringify([scope.cwd, scope.providerId])),
    );

    for (const [key, entry] of this.entries)
      if (
        entry.scope === null ||
        !retained.has(JSON.stringify([entry.scope.cwd, entry.scope.providerId]))
      )
        this.remove(key);

    if (this.entries.size === 0 && this.notifyTimer) {
      clearTimeout(this.notifyTimer);
      this.notifyTimer = null;
    }

    await Promise.all(this.stopping);
  }

  async get(key: string, build: (observe: Observe) => Promise<T>): Promise<T> {
    return (await this.getSnapshot(key, build)).value;
  }

  async getSnapshot(
    key: string,
    build: (observe: Observe) => Promise<T>,
    scope: CatalogCacheScope | null = null,
  ): Promise<CatalogSnapshot<T>> {
    if (this.disposed) throw new Error("Command catalog is closed");
    let entry = this.entries.get(key);

    if (entry) this.entries.delete(key);
    else {
      entry = {
        scope:
          scope === null
            ? null
            : { cwd: scope.cwd, providerId: scope.providerId },
        retained: true,
        version: 0,
        rescanVersion: 0,
        builtRescanVersion: -1,
        snapshot: undefined,
        bytes: 0,
        pending: null,
        roots: new Set(),
        stamps: new Map(),
      };
    }

    this.entries.set(key, entry);

    if (entry.pending) return entry.pending;

    const current = entry;

    const pending = (async () => {
      const cachedValidationVersion = current.version;

      const cachedWatches =
        current.snapshot &&
        current.builtRescanVersion === current.rescanVersion &&
        this.watcher === null
          ? await this.observeStamps(current, current.stamps)
          : current.snapshot?.watches;

      if (
        current.builtRescanVersion === current.rescanVersion &&
        current.snapshot !== undefined &&
        cachedWatches !== undefined &&
        (await this.unchanged(current.stamps)) &&
        cachedValidationVersion === current.version
      )
        return {
          value: current.snapshot.value,
          watches: cachedWatches,
        };

      for (let attempt = 0; attempt < 3; attempt++) {
        const rescanVersion = current.rescanVersion;

        const stamps = new Map<string, { shallow: boolean; value: string }>();

        const roots =
          this.watcher === null ? new Map<string, Root<T>>() : this.roots;

        const rootKeys =
          this.watcher === null ? new Set<string>() : current.roots;

        const value = await build(async (target, shallow = false) => {
          await this.observe(current, rootKeys, roots, target, shallow);
          stamps.set(path.resolve(target), {
            shallow,
            value: await this.stamp(target, shallow),
          });
          const physical = await fs.realpath(target).catch(() => target);

          if (physical !== target)
            stamps.set(physical, {
              shallow,
              value: await this.stamp(physical, shallow),
            });
        });

        if (this.disposed) throw new Error("Command catalog is closed");

        const validationVersion = current.version;

        if (
          rescanVersion !== current.rescanVersion ||
          !(await this.unchanged(stamps)) ||
          validationVersion !== current.version
        )
          continue;
        current.stamps = stamps;

        for (const rootKey of rootKeys) {
          const root = roots.get(rootKey);
          const targets = root?.targets.get(current);

          if (!root || !targets) continue;

          for (const target of targets.keys())
            if (!stamps.has(target)) targets.delete(target);

          if (targets.size > 0) continue;
          rootKeys.delete(rootKey);
          this.release(rootKey, current, roots);
        }

        const bytes = Buffer.byteLength(JSON.stringify(value));

        if (bytes > this.limits.bytes)
          throw new Error("Command catalog exceeds the metadata memory budget");

        if (current.retained) {
          this.bytes += bytes - current.bytes;
          current.bytes = bytes;
        }

        const snapshot = {
          value,
          watches: this.snapshotWatches(current, rootKeys, roots),
        };

        current.snapshot = snapshot;
        current.builtRescanVersion = rescanVersion;
        this.prune(key);

        return snapshot;
      }

      throw new Error(
        "Command catalog changed during discovery; retry after edits finish",
      );
    })();

    current.pending = pending;
    this.pending.add(pending);

    try {
      return await pending;
    } finally {
      current.pending = null;
      this.pending.delete(pending);
      this.prune(current.retained ? key : undefined);
    }
  }

  async dispose(): Promise<void> {
    this.disposed = true;

    if (this.notifyTimer) clearTimeout(this.notifyTimer);
    await Promise.allSettled(this.pending);

    for (const key of this.entries.keys()) this.remove(key);
    await Promise.all(this.stopping);
  }

  private async stamp(target: string, shallow: boolean): Promise<string> {
    try {
      const stat = await fs.lstat(target);
      let value = `${stat.dev}:${stat.ino}:${stat.mode}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;

      if (shallow && stat.isDirectory()) {
        const entries = (await fs.readdir(target, { withFileTypes: true }))
          .filter((entry) => !entry.isDirectory())
          .sort((a, b) => a.name.localeCompare(b.name));

        for (let start = 0; start < entries.length; start += 8) {
          const children = await Promise.all(
            entries.slice(start, start + 8).map(async (entry) => {
              const stamp = await this.stamp(
                path.join(target, entry.name),
                false,
              );

              return `\0${entry.name}:${stamp}`;
            }),
          );

          value += children.join("");
        }
      }

      return value;
    } catch (error) {
      if (
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        error.code === "ENOENT"
      )
        return "missing";
      throw error;
    }
  }

  private async unchanged(
    stamps: Map<string, { shallow: boolean; value: string }>,
  ): Promise<boolean> {
    const entries = [...stamps];

    for (let start = 0; start < entries.length; start += 8) {
      const matches = await Promise.all(
        entries
          .slice(start, start + 8)
          .map(
            async ([target, stamp]) =>
              (await this.stamp(target, stamp.shallow)) === stamp.value,
          ),
      );

      if (matches.some((match) => !match)) return false;
    }

    return true;
  }

  private async observe(
    entry: Entry<T>,
    rootKeys: Set<string>,
    roots: Map<string, Root<T>>,
    target: string,
    shallow = false,
  ): Promise<void> {
    if (this.watcher !== null && !entry.retained) return;
    const logical = path.resolve(target);

    const physical = await fs.realpath(logical).catch((error: unknown) => {
      if (
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        error.code === "ENOENT"
      )
        return logical;
      throw error;
    });

    await this.subscribe(entry, rootKeys, roots, physical, shallow);

    if (physical !== logical)
      await this.subscribe(entry, rootKeys, roots, logical, shallow);
  }

  private async subscribe(
    entry: Entry<T>,
    rootKeys: Set<string>,
    roots: Map<string, Root<T>>,
    target: string,
    shallow: boolean,
  ): Promise<void> {
    if (this.watcher !== null && !entry.retained) return;
    let rootPath = target;
    let watchShallow = shallow;
    let rootKey: string | undefined;

    if (this.watcher === null)
      for (const [watchedKey, watched] of roots) {
        if (!watched.shallow && isPathWithinDirectory(watched.path, target)) {
          rootPath = watched.path;
          rootKey = watchedKey;
          break;
        }
      }

    if (rootKey === undefined) {
      for (;;) {
        try {
          const stat = await fs.stat(rootPath);

          if (!stat.isDirectory()) {
            rootPath = path.dirname(rootPath);
            watchShallow = true;
          }

          break;
        } catch (error) {
          if (
            !(
              typeof error === "object" &&
              error !== null &&
              "code" in error &&
              error.code === "ENOENT"
            )
          )
            throw error;
          const parent = path.dirname(rootPath);

          if (parent === rootPath) throw error;
          rootPath = parent;
          watchShallow = true;
        }
      }

      rootKey = `${rootPath}\0${watchShallow}`;

      for (const [watchedKey, watched] of roots) {
        if (!watched.shallow && isPathWithinDirectory(watched.path, target)) {
          rootPath = watched.path;
          rootKey = watchedKey;
          break;
        }
      }
    }

    let root = roots.get(rootKey);

    if (!root) {
      const watch = this.watcher?.watchPathRoot;

      if (this.watcher !== null && !watch)
        throw new Error(
          "Filesystem watching is unavailable for command discovery",
        );
      let ready!: () => void;
      let reject!: (error: Error) => void;

      const state: Root<T> = {
        path: rootPath,
        shallow: watchShallow,
        ignoredPaths: [],
        targets: new Map(),
        error: null,
        stop: () => undefined,
        ready: new Promise<void>((resolve, fail) => {
          ready = resolve;
          reject = fail;
        }),
        finishReady: () => ready(),
      };

      root = state;
      roots.set(rootKey, state);
      void state.ready.catch(() => {});

      const ignoredChildren = watchShallow
        ? (
            await fs
              .readdir(rootPath, { withFileTypes: true })
              .catch((error: unknown) => {
                state.error =
                  error instanceof Error ? error : new Error(String(error));
                reject(state.error);
                throw state.error;
              })
          )
            .filter((child) => child.isDirectory())
            .map((child) => path.join(rootPath, child.name))
            .sort()
        : [];

      state.ignoredPaths = [
        "**/node_modules/**",
        "**/.git/**",
        ...ignoredChildren,
      ];

      const dirty = (paths?: readonly string[]) => {
        let changed = false;

        for (const [affected, targets] of state.targets) {
          if (
            paths &&
            !paths.some((p) =>
              [...targets].some(([targetPath, shallow]) =>
                catalogWatchTouches({ path: targetPath, shallow }, p),
              ),
            )
          )
            continue;

          if (affected.retained) {
            affected.version++;

            if (paths === undefined) affected.rescanVersion++;
            changed = true;
          }
        }

        if (changed && !this.disposed && !this.notifyTimer) {
          this.notifyTimer = setTimeout(() => {
            this.notifyTimer = null;

            if (!this.disposed) this.onChange();
          }, 75);
          this.notifyTimer.unref();
        }
      };

      if (watch && !entry.retained && state.targets.size === 0) {
        if (roots.get(rootKey) === state) roots.delete(rootKey);
        ready();
      } else if (watch)
        state.stop = watch.call(this.watcher, {
          rootPath,
          ignoredPaths: state.ignoredPaths,
          onChange: (changes) => dirty(changes.map((change) => change.path)),
          onReady: () => {
            const recovered = state.error !== null;
            state.error = null;
            state.ready = Promise.resolve();
            ready();

            if (recovered) dirty();
          },
          onRescanRequired: () => dirty(),
          onWatchError: ({ message }) => {
            state.error = new Error(message);
            reject(state.error);
            dirty();
          },
        });
      else ready();
    }

    if (this.watcher !== null && !entry.retained) {
      if (roots.get(rootKey) === root) this.release(rootKey, entry, roots);

      return;
    }

    const targets = root.targets.get(entry) ?? new Map<string, boolean>();
    targets.set(target, shallow);
    root.targets.set(entry, targets);
    rootKeys.add(rootKey);
    await root.ready;

    if (root.error) throw root.error;
  }

  private async observeStamps(
    entry: Entry<T>,
    stamps: Entry<T>["stamps"],
  ): Promise<CatalogWatch[]> {
    const roots = new Map<string, Root<T>>();
    const rootKeys = new Set<string>();

    for (const [target, stamp] of [...stamps].sort(
      ([left], [right]) =>
        left.length - right.length || left.localeCompare(right),
    ))
      await this.subscribe(entry, rootKeys, roots, target, stamp.shallow);

    return this.snapshotWatches(entry, rootKeys, roots);
  }

  private snapshotWatches(
    entry: Entry<T>,
    rootKeys: Set<string>,
    roots: Map<string, Root<T>>,
  ): CatalogWatch[] {
    return [...rootKeys]
      .flatMap((rootKey) => {
        const root = roots.get(rootKey);
        const targets = root?.targets.get(entry);

        return root && targets
          ? [
              {
                rootPath: root.path,
                ignoredPaths: [...root.ignoredPaths],
                targets: [...targets]
                  .map(([targetPath, shallow]) => ({
                    path: targetPath,
                    shallow,
                  }))
                  .sort((left, right) => left.path.localeCompare(right.path)),
              },
            ]
          : [];
      })
      .sort((left, right) => left.rootPath.localeCompare(right.rootPath));
  }

  private prune(retain?: string): void {
    for (const [key, entry] of this.entries) {
      if (
        this.entries.size <= this.limits.entries &&
        this.bytes <= this.limits.bytes
      )
        break;

      if (key !== retain && !entry.pending) this.remove(key);
    }
  }

  private remove(key: string): void {
    const entry = this.entries.get(key);

    if (!entry) return;
    this.entries.delete(key);
    entry.retained = false;
    this.bytes -= entry.bytes;
    entry.bytes = 0;

    for (const rootPath of entry.roots) {
      this.release(rootPath, entry);
    }
  }

  private release(rootKey: string, entry: Entry<T>, roots = this.roots): void {
    const root = roots.get(rootKey);

    if (!root) return;
    root.targets.delete(entry);

    if (root.targets.size !== 0) return;
    roots.delete(rootKey);
    root.finishReady();
    const stopped = Promise.resolve(root.stop());
    this.stopping.add(stopped);
    void stopped.finally(() => this.stopping.delete(stopped)).catch(() => {});
  }
}
