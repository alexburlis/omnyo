import { fork, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  sanitizeInheritedChildProcessEnv,
  supportsProcessGroups,
  killProcessGroup,
  killPortableProcess,
} from "@omnyo/process-utils";
import type {
  HostWatcher,
  WatchWorkspaceArgs,
  WatchPathRootArgs,
  WatchThreadStorageArgs,
} from "@omnyo/host-watcher";
import type { HostDaemonWatchSet } from "@omnyo/host-daemon-contract";
import type { HostDaemonLogger } from "./logger.js";
import type { WatchManager, WatchManagerOptions } from "./watch-manager.js";
import {
  workspaceObserverResponseSchema,
  type WorkspaceObserverCommand,
  type WorkspaceObserverResponse,
} from "./workspace-observer-protocol.js";

export type WatchManagerClient = Pick<
  WatchManager,
  | "replaceWatchSet"
  | "replaceAuthoritativeWatchSet"
  | "workspaceWatchCount"
  | "threadStorageWatchTargetCount"
  | "shutdown"
>;

type Options = Omit<
  WatchManagerOptions,
  "hostWatcher" | "provisionWorkspace" | "refreshWorkspace"
> & { logger: Pick<HostDaemonLogger, "warn"> };

type WatchDataDirSkillsRootArgs = Parameters<
  NonNullable<HostWatcher["watchDataDirSkillsRoot"]>
>[0];

type RawWatch =
  | { kind: "workspace"; args: WatchWorkspaceArgs }
  | { kind: "path"; args: WatchPathRootArgs }
  | { kind: "thread-storage"; args: WatchThreadStorageArgs }
  | { kind: "skills"; args: WatchDataDirSkillsRootArgs };

type Result = Extract<WorkspaceObserverResponse, { kind: "result" }>;

interface Pending {
  timer: ReturnType<typeof setTimeout>;
  resolve: (result: Result) => void;
  reject: (error: Error) => void;
}

interface ChildState {
  child: ChildProcess;
  pending: Map<number, Pending>;
  rawWatches: Set<number>;
  ready: Promise<void>;
  resolveReady: () => void;
  rejectReady: (error: Error) => void;
  readyTimer: ReturnType<typeof setTimeout>;
}

const START_TIMEOUT_MS = 5_000;

const SOURCE_START_TIMEOUT_MS = 30_000;

const REQUEST_TIMEOUT_MS = 10_000;

const SHUTDOWN_TIMEOUT_MS = 2_000;

function childEntry(): string {
  for (const candidate of [
    "./omnyo-workspace-observer-child.mjs",
    "./workspace-observer-child.js",
    "./workspace-observer-child.ts",
  ]) {
    const entry = fileURLToPath(new URL(candidate, import.meta.url));

    if (existsSync(entry)) return entry;
  }

  throw new Error("Workspace observer child entry is missing");
}

export function createIsolatedWatchManager(
  options: Options,
): WatchManagerClient & { hostWatcher: HostWatcher } {
  let owner: ChildState | null = null;
  let starting: Promise<ChildState> | null = null;
  let disposed = false;
  let nextId = 0;
  let workspaceWatches = 0;
  let threadStorageTargets = 0;
  let latestWatchSet: HostDaemonWatchSet | null = null;
  let recoveryAvailable = true;
  let recoveryTimer: ReturnType<typeof setTimeout> | null = null;
  const rawWatches = new Map<number, RawWatch>();

  function rawError(watch: RawWatch, message: string): void {
    switch (watch.kind) {
      case "workspace":
        watch.args.onWatchError({
          kind: "workspace-watch-error",
          environmentId: watch.args.environmentId,
          rootPath: watch.args.workspacePath,
          message,
        });
        break;
      case "path":
        watch.args.onWatchError({ rootPath: watch.args.rootPath, message });
        break;
      case "thread-storage":
        watch.args.onWatchError({
          kind: "thread-storage-watch-error",
          rootPath: watch.args.threadStoragePath,
          message,
        });
        break;
      case "skills":
        watch.args.onWatchError({
          kind: "data-dir-skills-watch-error",
          rootPath: watch.args.dataDirSkillsRootPath,
          message,
        });
        break;
      default: {
        const impossible: never = watch;
        throw new Error(`Unsupported observer watch: ${impossible}`);
      }
    }
  }

  function retire(state: ChildState, error: Error): void {
    if (owner !== state) return;
    owner = null;
    starting = null;
    workspaceWatches = 0;
    threadStorageTargets = 0;
    clearTimeout(state.readyTimer);
    state.rejectReady(error);

    for (const pending of state.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }

    state.pending.clear();

    if (supportsProcessGroups())
      killProcessGroup({ child: state.child, signal: "SIGKILL" });
    else killPortableProcess(state.child, "SIGKILL");

    if (state.child.connected) {
      try {
        state.child.disconnect();
      } catch (cause) {
        options.logger.warn(
          { err: cause },
          "Workspace observer IPC did not disconnect",
        );
      }
    }

    state.child.unref();

    if (disposed) return;
    options.logger.warn(
      { err: error },
      "Workspace observer stopped; filesystem updates require recovery",
    );

    for (const target of latestWatchSet?.workspaceTargets ?? [])
      options.onWorkspaceStatusWatchError?.({
        error: {
          kind: "workspace-watch-error",
          environmentId: target.environmentId,
          rootPath: target.workspaceContext.workspacePath,
          message: error.message,
        },
      });

    for (const watch of rawWatches.values()) rawError(watch, error.message);

    if (recoveryAvailable && (latestWatchSet !== null || rawWatches.size > 0)) {
      recoveryAvailable = false;
      options.logger.warn(
        {},
        "Workspace observer will restart once and restore its watches",
      );
      recoveryTimer = setTimeout(() => {
        recoveryTimer = null;
        void ensure().catch((cause: unknown) => {
          options.logger.warn(
            { err: cause },
            "Workspace observer recovery failed; awaiting a new watch request",
          );
        });
      }, 250);
      recoveryTimer.unref?.();
    }
  }

  function handle(state: ChildState, input: unknown): void {
    if (owner !== state) return;
    const parsed = workspaceObserverResponseSchema.safeParse(input);

    if (!parsed.success) {
      retire(state, new Error("Workspace observer sent an invalid response"));

      return;
    }

    const message = parsed.data;

    switch (message.kind) {
      case "backend-failure":
        retire(
          state,
          new Error(
            `Workspace watcher failed at ${message.rootPath}: ${message.message}`,
          ),
        );
        break;
      case "ready":
        clearTimeout(state.readyTimer);
        state.resolveReady();
        break;
      case "result": {
        const pending = state.pending.get(message.id);

        if (!pending) return;
        state.pending.delete(message.id);
        clearTimeout(pending.timer);
        workspaceWatches = message.workspaceWatches;
        threadStorageTargets = message.threadStorageTargets;
        pending.resolve(message);
        break;
      }

      case "failure": {
        const pending = state.pending.get(message.id);

        if (!pending) return;
        state.pending.delete(message.id);
        clearTimeout(pending.timer);
        pending.reject(new Error(message.message));
        break;
      }

      case "storage-change":
        options.onThreadStorageChanged?.({
          environmentId: message.environmentId,
          threadId: message.threadId,
        });
        break;
      case "storage-error":
        options.onThreadStorageWatchError?.({
          error: {
            kind: "thread-storage-watch-error",
            rootPath: message.rootPath,
            message: message.message,
          },
        });
        break;
      case "workspace-change":
        options.onWorkspaceStatusChanged?.({
          environmentId: message.environmentId,
          changeKinds: message.changeKinds,
        });
        break;
      case "metadata-change":
        options.onWorkspaceMetadataChanged?.({
          environmentId: message.environmentId,
          workspace: message.workspace,
        });
        break;
      case "workspace-error":
        options.onWorkspaceStatusWatchError?.({
          error: {
            kind: "workspace-watch-error",
            environmentId: message.environmentId,
            rootPath: message.rootPath,
            message: message.message,
          },
        });
        break;
      case "watch-ready": {
        const watch = rawWatches.get(message.watchId);

        if (watch?.kind === "path" || watch?.kind === "workspace")
          watch.args.onReady();
        break;
      }

      case "watch-error": {
        const watch = rawWatches.get(message.watchId);

        if (watch) rawError(watch, message.message);
        break;
      }

      case "watch-path-change": {
        const watch = rawWatches.get(message.watchId);

        if (watch?.kind === "path") watch.args.onChange(message.changes);
        break;
      }

      case "watch-workspace-change": {
        const watch = rawWatches.get(message.watchId);

        if (watch?.kind === "workspace")
          watch.args.onChange({
            kind: "workspace-status-changed",
            environmentId: watch.args.environmentId,
            changedPaths: message.changedPaths,
            changeKinds: message.changeKinds,
          });
        break;
      }

      case "watch-storage-change": {
        const watch = rawWatches.get(message.watchId);

        if (watch?.kind === "thread-storage") watch.args.onChange();
        break;
      }

      case "watch-skills-change": {
        const watch = rawWatches.get(message.watchId);

        if (watch?.kind === "skills")
          watch.args.onChange({
            kind: "injected-skills-changed",
            sourceType: "data-dir",
            changedPaths: message.changedPaths,
          });
        break;
      }

      case "watch-rescan": {
        const watch = rawWatches.get(message.watchId);

        if (watch?.kind === "path") watch.args.onRescanRequired();
        else if (watch?.kind === "workspace")
          watch.args.onChange({
            kind: "workspace-status-changed",
            environmentId: watch.args.environmentId,
            changedPaths: [watch.args.workspacePath],
            changeKinds: [
              "workspace-content-changed",
              "workspace-git-changed",
              "workspace-git-repository-created",
              "shared-git-refs-changed",
            ],
          });
        else if (watch?.kind === "skills")
          watch.args.onChange({
            kind: "injected-skills-changed",
            sourceType: "data-dir",
            changedPaths: [watch.args.dataDirSkillsRootPath],
          });
        break;
      }

      default: {
        const impossible: never = message;
        throw new Error(`Unsupported observer response: ${impossible}`);
      }
    }
  }

  function send(
    state: ChildState,
    command: WorkspaceObserverCommand,
    timeoutMs = REQUEST_TIMEOUT_MS,
  ): Promise<Result> {
    if (owner !== state)
      return Promise.reject(new Error("Workspace observer is unavailable"));
    const id = ++nextId;

    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () =>
          retire(
            state,
            new Error(
              `Workspace observer ${command.kind} timed out after ${timeoutMs}ms`,
            ),
          ),
        timeoutMs,
      );

      timer.unref?.();
      state.pending.set(id, { timer, resolve, reject });

      try {
        state.child.send({ ...command, id }, (error) => {
          if (error)
            retire(
              state,
              new Error("Workspace observer connection failed", {
                cause: error,
              }),
            );
        });
      } catch (error) {
        retire(
          state,
          new Error("Workspace observer connection failed", { cause: error }),
        );
      }
    });
  }

  function watchCommand(
    watchId: number,
    watch: RawWatch,
  ): WorkspaceObserverCommand {
    switch (watch.kind) {
      case "workspace":
        return {
          kind: "watch",
          watchId,
          watch: {
            kind: "workspace",
            environmentId: watch.args.environmentId,
            rootPath: watch.args.workspacePath,
          },
        };
      case "path":
        return {
          kind: "watch",
          watchId,
          watch: {
            kind: "path",
            rootPath: watch.args.rootPath,
            ignoredPaths: [...watch.args.ignoredPaths],
          },
        };
      case "thread-storage":
        return {
          kind: "watch",
          watchId,
          watch: {
            kind: "thread-storage",
            rootPath: watch.args.threadStoragePath,
          },
        };
      case "skills":
        return {
          kind: "watch",
          watchId,
          watch: { kind: "skills", rootPath: watch.args.dataDirSkillsRootPath },
        };
      default: {
        const impossible: never = watch;
        throw new Error(`Unsupported observer watch: ${impossible}`);
      }
    }
  }

  async function register(
    state: ChildState,
    watchId: number,
    watch: RawWatch,
  ): Promise<void> {
    if (state.rawWatches.has(watchId) || !rawWatches.has(watchId)) return;
    state.rawWatches.add(watchId);
    await send(state, watchCommand(watchId, watch));
  }

  function ensure(): Promise<ChildState> {
    if (disposed)
      return Promise.reject(new Error("Workspace observer is closed"));

    if (starting) return starting;
    const entry = childEntry();

    const child = fork(entry, [], {
      detached: supportsProcessGroups(),
      env: sanitizeInheritedChildProcessEnv({ env: process.env }),
      execArgv: entry.endsWith(".ts")
        ? ["--import", import.meta.resolve("tsx"), "--conditions=source"]
        : [],
      stdio: ["ignore", "ignore", "ignore", "ipc"],
    });

    let resolveReady: () => void = () => undefined;
    let rejectReady: (error: Error) => void = () => undefined;

    const ready = new Promise<void>((resolve, reject) => {
      resolveReady = resolve;
      rejectReady = reject;
    });

    const state: ChildState = {
      child,
      ready,
      resolveReady,
      rejectReady,
      pending: new Map(),
      rawWatches: new Set(),
      readyTimer: setTimeout(
        () => retire(state, new Error("Workspace observer startup timed out")),
        entry.endsWith(".ts") ? SOURCE_START_TIMEOUT_MS : START_TIMEOUT_MS,
      ),
    };

    state.readyTimer.unref?.();
    owner = state;
    child.on("message", (input: unknown) => handle(state, input));
    child.on("error", (error) => retire(state, error));
    child.on("exit", (code, signal) =>
      retire(state, new Error(`Workspace observer exited (${signal ?? code})`)),
    );

    const pending = (async () => {
      await ready;
      await send(state, {
        kind: "initialize",
        threadStorageRootPath: options.threadStorageRootPath ?? null,
        shellPath: options.shellEnv?.().PATH,
      });

      for (const [watchId, watch] of rawWatches)
        await register(state, watchId, watch);

      if (latestWatchSet !== null)
        await send(state, {
          kind: "replace",
          authoritative: true,
          watchSet: latestWatchSet,
          shellPath: options.shellEnv?.().PATH,
        });

      recoveryAvailable = true;

      return state;
    })().catch((error: unknown) => {
      const failure =
        error instanceof Error
          ? error
          : new Error("Workspace observer startup failed");

      retire(state, failure);
      throw failure;
    });

    starting = pending;

    return pending;
  }

  function startWatch(watch: RawWatch): () => Promise<void> {
    const id = ++nextId;
    rawWatches.set(id, watch);
    void ensure()
      .then((state) => register(state, id, watch))
      .catch((error: unknown) => {
        if (rawWatches.has(id))
          rawError(
            watch,
            error instanceof Error
              ? error.message
              : "Workspace observer watch failed",
          );
      });

    return async () => {
      if (!rawWatches.delete(id)) return;
      const state = owner;

      if (state && state.rawWatches.delete(id))
        await send(
          state,
          { kind: "stop-watch", watchId: id },
          SHUTDOWN_TIMEOUT_MS,
        );
    };
  }

  async function replace(
    watchSet: HostDaemonWatchSet,
    authoritative: boolean,
  ): Promise<void> {
    if (
      authoritative ||
      latestWatchSet === null ||
      watchSet.generation > latestWatchSet.generation
    )
      latestWatchSet = watchSet;
    const state = await ensure();
    await send(state, {
      kind: "replace",
      authoritative,
      watchSet,
      shellPath: options.shellEnv?.().PATH,
    });
  }

  return {
    hostWatcher: {
      watchWorkspace: (args) => startWatch({ kind: "workspace", args }),
      watchPathRoot: (args) => startWatch({ kind: "path", args }),
      watchThreadStorage: (args) =>
        startWatch({ kind: "thread-storage", args }),
      watchDataDirSkillsRoot: (args) => startWatch({ kind: "skills", args }),
    },
    replaceWatchSet: (watchSet) => replace(watchSet, false),
    replaceAuthoritativeWatchSet: (watchSet) => replace(watchSet, true),
    workspaceWatchCount: () => workspaceWatches,
    threadStorageWatchTargetCount: () => threadStorageTargets,
    async shutdown() {
      if (disposed) return;
      disposed = true;

      if (recoveryTimer !== null) {
        clearTimeout(recoveryTimer);
        recoveryTimer = null;
      }

      rawWatches.clear();
      const state = owner;

      if (!state) return;

      try {
        await send(state, { kind: "shutdown" }, SHUTDOWN_TIMEOUT_MS);
      } catch (error) {
        options.logger.warn(
          { err: error },
          "Workspace observer shutdown required termination",
        );
      } finally {
        retire(state, new Error("Workspace observer is closed"));
      }
    },
  };
}
