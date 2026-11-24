import { createHostWatcher, setParcelWatcherBackend } from "@omnyo/host-watcher";
import parcelWatcher from "@parcel/watcher";
import { enableInheritedProcessGroup } from "@omnyo/process-utils";
import { WatchManager } from "./watch-manager.js";
import {
  workspaceObserverRequestSchema,
  type WorkspaceObserverResponse,
} from "./workspace-observer-protocol.js";

enableInheritedProcessGroup();

const hostWatcher = createHostWatcher();

const rawWatches = new Map<number, () => void | Promise<void>>();

let manager: WatchManager | null = null;

let shellPath: string | undefined;

function send(message: WorkspaceObserverResponse): void {
  if (
    (message.kind === "watch-path-change" && message.changes.length > 10_000) ||
    ((message.kind === "watch-workspace-change" ||
      message.kind === "watch-skills-change") &&
      message.changedPaths.length > 10_000)
  ) {
    send({ kind: "watch-rescan", watchId: message.watchId });

    return;
  }

  if (process.connected) process.send?.(message);
}

setParcelWatcherBackend({
  async subscribe(dir, callback, options, signal) {
    if (signal?.aborted) throw new Error("Workspace watch was cancelled");

    const pending = parcelWatcher
      .subscribe(
        dir,
        (error, events) => {
          if (
            error &&
            !error.message.includes("File system must be re-scanned")
          ) {
            send({
              kind: "backend-failure",
              rootPath: dir,
              message: error.message,
            });

            return;
          }

          if (events.length > 10_000)
            callback(
              new Error("Watcher event batch was too large to deliver"),
              [],
            );
          else callback(error, events);
        },
        options,
      )
      .catch((error: unknown) => {
        if (
          error instanceof Error &&
          error.message.includes("inotify_add_watch")
        )
          send({
            kind: "backend-failure",
            rootPath: dir,
            message: error.message,
          });
        throw error;
      });

    if (signal === undefined) return pending;

    return new Promise<Awaited<typeof pending>>((resolve, reject) => {
      const abort = () => reject(new Error("Workspace watch was cancelled"));
      signal.addEventListener("abort", abort, { once: true });

      if (signal.aborted) abort();
      void pending.then(
        (subscription) => {
          signal.removeEventListener("abort", abort);

          if (signal.aborted)
            void subscription.unsubscribe().catch(() => undefined);
          else resolve(subscription);
        },
        (error: unknown) => {
          signal.removeEventListener("abort", abort);
          reject(error);
        },
      );
    });
  },
});

async function handle(input: unknown): Promise<void> {
  const request = workspaceObserverRequestSchema.parse(input);

  try {
    switch (request.kind) {
      case "initialize":
        if (manager !== null)
          throw new Error("Workspace observer is already initialized");
        shellPath = request.shellPath;
        manager = new WatchManager({
          hostWatcher,
          shellEnv: () => (shellPath === undefined ? {} : { PATH: shellPath }),
          threadStorageRootPath: request.threadStorageRootPath,
          onThreadStorageChanged: (event) =>
            send({ kind: "storage-change", ...event }),
          onThreadStorageWatchError: ({ error }) =>
            send({
              kind: "storage-error",
              rootPath: error.rootPath,
              message: error.message,
            }),
          onWorkspaceStatusChanged: (event) =>
            send({ kind: "workspace-change", ...event }),
          onWorkspaceMetadataChanged: (event) =>
            send({ kind: "metadata-change", ...event }),
          onWorkspaceStatusWatchError: ({ error }) =>
            send({
              kind: "workspace-error",
              environmentId: error.environmentId,
              rootPath: error.rootPath,
              message: error.message,
            }),
        });
        break;
      case "replace":
        if (manager === null)
          throw new Error("Workspace observer is not initialized");
        shellPath = request.shellPath;

        if (request.authoritative)
          await manager.replaceAuthoritativeWatchSet(request.watchSet);
        else await manager.replaceWatchSet(request.watchSet);
        break;
      case "watch": {
        if (rawWatches.has(request.watchId))
          throw new Error("Workspace observer watch already exists");
        const { watchId, watch } = request;
        let resolveReady: () => void = () => undefined;
        let rejectReady: (error: Error) => void = () => undefined;

        const ready = new Promise<void>((resolve, reject) => {
          resolveReady = resolve;
          rejectReady = reject;
        });

        void ready.catch(() => undefined);

        const onReady = () => {
          send({ kind: "watch-ready", watchId });
          resolveReady();
        };

        const onWatchError = (error: { rootPath: string; message: string }) => {
          send({
            kind: "watch-error",
            watchId,
            rootPath: error.rootPath,
            message: error.message,
          });
          rejectReady(new Error(error.message));
        };

        let stop: () => void | Promise<void>;

        switch (watch.kind) {
          case "workspace":
            stop = hostWatcher.watchWorkspace({
              environmentId: watch.environmentId,
              workspacePath: watch.rootPath,
              onReady,
              onWatchError,
              onChange: (event) =>
                send({
                  kind: "watch-workspace-change",
                  watchId,
                  changedPaths: event.changedPaths,
                  changeKinds: event.changeKinds,
                }),
            });
            break;
          case "path": {
            const start = hostWatcher.watchPathRoot;

            if (start === undefined)
              throw new Error(
                "Workspace observer path watching is unavailable",
              );
            stop = start({
              rootPath: watch.rootPath,
              ignoredPaths: watch.ignoredPaths,
              onReady,
              onWatchError,
              onRescanRequired: () => send({ kind: "watch-rescan", watchId }),
              onChange: (changes) =>
                send({
                  kind: "watch-path-change",
                  watchId,
                  changes: [...changes],
                }),
            });
            break;
          }

          case "thread-storage":
            stop = hostWatcher.watchThreadStorage({
              threadStoragePath: watch.rootPath,
              onWatchError,
              onChange: () => send({ kind: "watch-storage-change", watchId }),
            });
            break;
          case "skills": {
            const start = hostWatcher.watchDataDirSkillsRoot;

            if (start === undefined)
              throw new Error(
                "Workspace observer skills watching is unavailable",
              );
            stop = start({
              dataDirSkillsRootPath: watch.rootPath,
              onWatchError,
              onChange: ({ changedPaths }) =>
                send({ kind: "watch-skills-change", watchId, changedPaths }),
            });
            break;
          }

          default: {
            const impossible: never = watch;
            throw new Error(
              `Unsupported workspace observer watch: ${impossible}`,
            );
          }
        }

        rawWatches.set(watchId, stop);

        if (watch.kind === "path" || watch.kind === "workspace") await ready;
        break;
      }

      case "stop-watch": {
        const stop = rawWatches.get(request.watchId);
        rawWatches.delete(request.watchId);
        await stop?.();
        break;
      }

      case "shutdown":
        await Promise.all([
          manager?.shutdown(),
          ...[...rawWatches.values()].map((stop) => stop()),
        ]);
        rawWatches.clear();
        break;
      default: {
        const impossible: never = request;
        throw new Error(
          `Unsupported workspace observer request: ${impossible}`,
        );
      }
    }

    send({
      kind: "result",
      id: request.id,
      workspaceWatches: manager?.workspaceWatchCount() ?? 0,
      threadStorageTargets: manager?.threadStorageWatchTargetCount() ?? 0,
    });
  } catch (error) {
    send({
      kind: "failure",
      id: request.id,
      message:
        error instanceof Error ? error.message : "Workspace observer failed",
    });
  }
}

process.on("message", (input: unknown) => {
  void handle(input).catch(() => process.exit(1));
});

process.on("disconnect", () => process.exit(0));

send({ kind: "ready" });
