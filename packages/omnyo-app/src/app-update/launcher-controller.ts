import { randomUUID } from "node:crypto";
import {
  APP_UPDATE_RESTART_EXIT_CODE,
  mutateAppUpdateState,
  readAppUpdateState,
  serverToLauncherMessageSchema,
  type AppRevision,
  type AppUpdateActivity,
  type AppUpdateFailurePhase,
  type AppUpdateLauncherRequest,
  type AppUpdateMode,
  type AppUpdatePending,
  type AppUpdateResult,
  type AppUpdateTarget,
  type LauncherToServerMessage,
} from "@omnyo/config/app-update";
import {
  formatNpmRevisionPackageRoot,
  markNpmRevisionActivated,
  pruneNpmRevisions,
} from "./npm-revision.js";
import { adoptPrivateRevision } from "./private-revision.js";
import type { RunCommand } from "./run-command.js";
import { inspectSourceCheckout } from "./source-checkout.js";
import {
  formatRevision,
  installedNpmRevision,
  isSameRevision,
  readLiveShimLock,
} from "./shim-support.js";

const DEFAULT_RESTART_NOTICE_MS = 1_500;

const READY_DECISION_TIMEOUT_MS = 60 * 1000;

const SERVER_STOPPED_MESSAGE =
  "The server stopped before confirming the restart. Update again to retry.";

type RestartDecision =
  | { kind: "abort" }
  | { kind: "cancel"; message: string }
  | { errorCode?: string; kind: "failed"; message: string }
  | { kind: "restart" };

export interface LauncherAppUpdateControllerArgs {
  current: AppRevision;
  dataDir: string;
  log: (message: string) => void;
  mode: AppUpdateMode;
  now?: () => Date;
  repoRoot: string | null;
  requestShutdown: (message: string) => void;
  restartNoticeMs?: number;
  runner: RunCommand;
}

export interface LauncherServerPort {
  readonly connected: boolean;
  on(event: "message", listener: (message: unknown) => void): unknown;
  once(event: "exit", listener: () => void): unknown;
  send(
    message: LauncherToServerMessage,
    callback: (error: Error | null) => void,
  ): boolean;
}

export interface LauncherAppUpdateController {
  attachServer(child: LauncherServerPort): void;
  dispose(): Promise<void>;
  finalizeExit(): Promise<number | null>;
  onFullStackReady(): Promise<void>;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

export function createLauncherAppUpdateController(
  args: LauncherAppUpdateControllerArgs,
): LauncherAppUpdateController {
  const now = args.now ?? (() => new Date());
  const restartNoticeMs = args.restartNoticeMs ?? DEFAULT_RESTART_NOTICE_MS;
  let server: LauncherServerPort | null = null;
  let activity: AppUpdateActivity = { phase: "idle" };
  let lastResult: AppUpdateResult | null = null;
  let restartPending: AppUpdatePending | null = null;
  const abortController = new AbortController();
  let applyTask: Promise<void> | null = null;
  const requestTasks = new Set<Promise<void>>();
  let decideRestart: ((decision: RestartDecision) => void) | null = null;
  let cancelOnServerExit: (() => void) | null = null;

  const waitForRestartDecision = (): Promise<RestartDecision> =>
    new Promise((resolvePromise) => {
      if (abortController.signal.aborted) {
        resolvePromise({ kind: "abort" });

        return;
      }

      const waitsForDrain = args.mode === "private";

      if (waitsForDrain && (server === null || !server.connected)) {
        resolvePromise({ kind: "failed", message: SERVER_STOPPED_MESSAGE });

        return;
      }

      const finish = (decision: RestartDecision): void => {
        if (timer !== null) clearTimeout(timer);
        abortController.signal.removeEventListener("abort", onAbort);
        decideRestart = null;
        cancelOnServerExit = null;
        resolvePromise(decision);
      };

      const onAbort = (): void => finish({ kind: "abort" });

      const timer = waitsForDrain
        ? null
        : setTimeout(
            () =>
              finish({
                kind: "failed",
                message:
                  "The server did not confirm the restart. Update again to retry.",
              }),
            READY_DECISION_TIMEOUT_MS,
          );

      abortController.signal.addEventListener("abort", onAbort, { once: true });
      decideRestart = finish;

      if (waitsForDrain) {
        cancelOnServerExit = () =>
          finish({ kind: "failed", message: SERVER_STOPPED_MESSAGE });
      }
    });

  const send = (message: LauncherToServerMessage): void => {
    const child = server;

    if (child === null || !child.connected) return;

    try {
      child.send(message, () => undefined);
    } catch {}
  };

  const pushStatus = (): void => {
    send({
      channel: "omnyo-app-update/status",
      status: {
        activity,
        current: args.current,
        lastResult,
        mode: args.mode,
      },
    });
  };

  const refreshLastResult = async (): Promise<void> => {
    lastResult = (await readAppUpdateState(args.dataDir)).lastResult;
  };

  const recordPrepareResult = async (
    target: AppRevision,
    phase: AppUpdateFailurePhase | null,
    message: string,
    output: string[],
    outcome: "failed" | "cancelled",
    errorCode: string | null = null,
  ): Promise<void> => {
    const state = await mutateAppUpdateState(args.dataDir, (current) => ({
      ...current,
      lastResult: {
        acknowledged: false,
        errorCode:
          outcome === "failed"
            ? (errorCode ?? "app_update_prepare_failed")
            : null,
        finishedAt: now().toISOString(),
        from: args.current,
        id: randomUUID(),
        logTail: output,
        message,
        outcome,
        phase,
        to: target,
      },
    }));

    lastResult = state.lastResult;
  };

  const stageTarget = async (
    target: AppUpdateTarget,
    output: string[],
    setStep: (step: string) => void,
  ): Promise<AppRevision> => {
    if (target.kind === "npm") {
      throw new Error(
        "Public registry updates are unavailable for Omnyo. Use the verified private release installer.",
      );
    }

    if (target.kind === "private") {
      setStep("Verifying staged runtime");

      return adoptPrivateRevision({
        dataDir: args.dataDir,
        runtimeSha256: target.runtimeSha256,
        version: target.version,
      });
    }

    if (args.repoRoot === null) {
      throw new Error("This Omnyo is not running from a source checkout.");
    }

    setStep("Checking origin/main");

    const check = await inspectSourceCheckout({
      fetch: true,
      repoRoot: args.repoRoot,
      runner: args.runner,
      signal: abortController.signal,
    });

    if (check.blocked !== null) throw new Error(check.blocked.message);

    if (check.incoming === null || check.incoming.commit !== target.commit) {
      throw new Error(
        "origin/main changed since the update was offered. Check for updates again.",
      );
    }

    return {
      commit: check.incoming.commit,
      kind: "source",
      version: check.incoming.version,
    };
  };

  const runApply = async (
    target: AppUpdateTarget,
    targetVersion: string,
  ): Promise<void> => {
    const output: string[] = [];
    const startedAt = now().toISOString();
    activity = {
      output,
      phase: "preparing",
      startedAt,
      step: "Preparing",
      target,
      targetVersion,
    };
    pushStatus();

    const setStep = (step: string): void => {
      if (activity.phase === "preparing") {
        activity = { ...activity, step };
        pushStatus();
      }
    };

    let to: AppRevision;

    try {
      to = await stageTarget(target, output, setStep);
    } catch (error) {
      if (abortController.signal.aborted) return;

      const intended: AppRevision =
        target.kind === "source"
          ? { commit: target.commit, kind: "source", version: targetVersion }
          : {
              kind: "npm",
              packageRoot: formatNpmRevisionPackageRoot(
                args.dataDir,
                target.version,
              ),
              version: target.version,
            };

      await recordPrepareResult(
        intended,
        target.kind === "npm" ? "install" : "prepare",
        errorMessage(error),
        [...output],
        "failed",
      );
      args.log(
        `In-app update to ${targetVersion} failed: ${errorMessage(error)}`,
      );
      activity = { phase: "idle" };
      pushStatus();

      return;
    }

    if (abortController.signal.aborted) return;

    const pending: AppUpdatePending = {
      from: args.current,
      id: randomUUID(),
      requestedAt: startedAt,
      to,
    };

    activity = { phase: "ready", startedAt, target, targetVersion };
    pushStatus();
    const decision = await waitForRestartDecision();

    if (decision.kind === "abort") return;

    if (decision.kind === "cancel" || decision.kind === "failed") {
      await recordPrepareResult(
        to,
        decision.kind === "cancel" ? null : "prepare",
        decision.message,
        [],
        decision.kind === "cancel" ? "cancelled" : "failed",
        decision.kind === "failed"
          ? (decision.errorCode ?? "app_update_restart_unconfirmed")
          : null,
      );
      activity = { phase: "idle" };
      pushStatus();

      return;
    }

    activity = { phase: "restarting", startedAt, target, targetVersion };
    pushStatus();
    await delay(restartNoticeMs);

    if (abortController.signal.aborted) return;
    restartPending = pending;
    args.requestShutdown(`Stopping Omnyo to update to ${formatRevision(to)}`);
  };

  const handleRequest = async (
    request: AppUpdateLauncherRequest,
  ): Promise<unknown> => {
    switch (request.type) {
      case "check-source": {
        if (args.mode !== "source" || args.repoRoot === null) {
          throw new Error("This Omnyo is not running from a source checkout.");
        }

        return inspectSourceCheckout({
          fetch: true,
          repoRoot: args.repoRoot,
          runner: args.runner,
          signal: abortController.signal,
        });
      }

      case "apply": {
        if (request.target.kind !== args.mode) {
          throw new Error(
            `This Omnyo updates through ${args.mode}, not ${request.target.kind}.`,
          );
        }

        if (activity.phase !== "idle" || restartPending !== null) {
          throw new Error("An update is already in progress.");
        }

        if (abortController.signal.aborted) {
          throw new Error("Omnyo is shutting down.");
        }

        if (request.target.kind === "npm") {
          throw new Error(
            "Public registry updates are unavailable for Omnyo. Use the verified private release installer.",
          );
        }

        applyTask = runApply(request.target, request.targetVersion).catch(
          (error: unknown) => {
            args.log(`In-app update failed: ${errorMessage(error)}`);
            activity = { phase: "idle" };
            pushStatus();
          },
        );

        return null;
      }

      case "restart":
      case "cancel": {
        const decide = decideRestart;

        if (activity.phase !== "ready" || decide === null) {
          throw new Error("No update is waiting to restart.");
        }

        decide(
          request.type === "restart"
            ? { kind: "restart" }
            : request.errorCode === undefined
              ? { kind: "cancel", message: request.message }
              : {
                  kind: "failed",
                  message: request.message,
                  errorCode: request.errorCode,
                },
        );

        return null;
      }

      case "acknowledge-result": {
        const state = await mutateAppUpdateState(args.dataDir, (current) =>
          current.lastResult?.id === request.id
            ? {
                ...current,
                lastResult: { ...current.lastResult, acknowledged: true },
              }
            : current,
        );

        lastResult = state.lastResult;
        pushStatus();

        return null;
      }
    }
  };

  const onMessage = (raw: unknown): void => {
    const parsed = serverToLauncherMessageSchema.safeParse(raw);

    if (!parsed.success) return;
    const message = parsed.data;

    if (message.channel === "omnyo-app-update/hello") {
      void refreshLastResult().finally(pushStatus);

      return;
    }

    const task = handleRequest(message.request).then(
      (result) => {
        send({
          channel: "omnyo-app-update/response",
          error: null,
          requestId: message.requestId,
          result: result ?? null,
        });
      },
      (error: unknown) => {
        send({
          channel: "omnyo-app-update/response",
          error: errorMessage(error),
          requestId: message.requestId,
          result: null,
        });
      },
    );

    requestTasks.add(task);
    void task.then(() => requestTasks.delete(task));
  };

  const dispose = async (): Promise<void> => {
    abortController.abort();
    await Promise.all([applyTask, ...requestTasks]);
  };

  return {
    attachServer(child) {
      server = child;
      child.on("message", onMessage);
      child.once("exit", () => {
        if (server !== child) return;
        server = null;
        cancelOnServerExit?.();
      });
    },
    dispose,
    async finalizeExit() {
      await dispose();
      const pending = restartPending;

      if (pending === null) return null;

      try {
        await mutateAppUpdateState(args.dataDir, (state) => ({
          ...state,
          ...(pending.to.kind === "npm"
            ? {
                current: installedNpmRevision(
                  pending.to,
                  process.versions.modules,
                ),
              }
            : {}),
          pending,
        }));
      } catch (error) {
        const message = `Could not prepare the restart: ${errorMessage(error)}`;
        args.log(`${message} Keeping ${formatRevision(args.current)}.`);
        await mutateAppUpdateState(args.dataDir, (state) => ({
          ...state,
          lastResult: {
            acknowledged: false,
            errorCode: "app_update_restart_failed",
            finishedAt: now().toISOString(),
            from: pending.from,
            id: pending.id,
            logTail: [],
            message,
            outcome: "failed",
            phase: "prepare",
            to: pending.to,
          },
          pending: state.pending?.id === pending.id ? null : state.pending,
        })).catch(() => undefined);
      }

      return APP_UPDATE_RESTART_EXIT_CODE;
    },
    async onFullStackReady() {
      const initialState = await readAppUpdateState(args.dataDir);
      const { pending } = initialState;
      const previousResult = initialState.lastResult;

      if (pending !== null) {
        const updated = isSameRevision(pending.to, args.current);
        await mutateAppUpdateState(args.dataDir, (state) =>
          state.pending?.id !== pending.id
            ? state
            : {
                ...state,
                lastResult: {
                  acknowledged: false,
                  errorCode: updated ? null : "app_update_startup_failed",
                  finishedAt: now().toISOString(),
                  from: pending.from,
                  id: pending.id,
                  logTail: [],
                  message: updated
                    ? null
                    : `Omnyo started ${formatRevision(args.current)} instead of ${formatRevision(pending.to)}.`,
                  outcome: updated ? "updated" : "failed",
                  phase: updated ? null : "startup",
                  to: pending.to,
                },
                pending: null,
              },
        );
      } else if (previousResult !== null) {
        await mutateAppUpdateState(args.dataDir, (state) => {
          const result = state.lastResult;

          return state.pending === null &&
            result !== null &&
            result.id === previousResult.id &&
            !result.acknowledged &&
            result.outcome !== "updated" &&
            isSameRevision(result.to, args.current) &&
            !isSameRevision(result.from, args.current)
            ? {
                ...state,
                lastResult: { ...result, acknowledged: true },
              }
            : state;
        });
      }

      const shim = await readLiveShimLock(args.dataDir);

      if (args.current.kind === "npm" && shim !== null) {
        const current = args.current;
        await markNpmRevisionActivated(args.dataDir, current)
          .then(() =>
            pruneNpmRevisions({
              bootstrapEntryPath: shim.entryPath,
              dataDir: args.dataDir,
              keepPackageRoots: [current.packageRoot],
            }),
          )
          .catch((error: unknown) => {
            args.log(
              `Runtime retention failed: ${errorMessage(error)}. Existing recovery inputs were preserved.`,
            );
          });
      }

      await refreshLastResult();
      pushStatus();
    },
  };
}
