import semver from "semver";
import { randomUUID } from "node:crypto";
import {
  readPrivateServerUpdateManifest,
  sourceUpdateCheckSchema,
  type AppRevision,
  type AppUpdateActivity,
  type AppUpdateLauncherRequest,
  type AppUpdateMode,
  type AppUpdateResult,
  type AppUpdateTarget,
  type LauncherAppUpdateStatus,
  type SourceUpdateCheck,
} from "@omnyo/config/app-update";
import type { AppSurface } from "@omnyo/config/app-surface";
import type {
  SystemAppUpdateActivity,
  SystemAppUpdateAvailable,
  SystemAppUpdateResult,
  SystemAppUpdateRevision,
  SystemAppUpdateStatus,
  SystemAppUpdateSupport,
} from "@omnyo/server-contract";
import { ApiError } from "../../errors.js";
import type { ServerLogger, ServerRuntimeConfig } from "../../types.js";
import {
  verifyPrivateDeliveryApproval,
  type PrivateDeliveryApproval,
  type PrivateDeliveryGuard,
} from "./private-delivery-guard.js";
import {
  LauncherRequestRejectedError,
  type LauncherChannel,
} from "./launcher-channel.js";

const SOURCE_CHECK_TTL_MS = 60 * 60 * 1000;

const FIRST_STATUS_WAIT_MS = 1_000;

const RESTART_RECHECK_MS = 2_000;

const STOP_THREADS_TIMEOUT_MS = 60_000;

const RESTART_AFTER_STOP_TIMEOUT_MS = 2 * 60 * 1000;

const PRIVATE_IDLE_WAIT_MS = 10 * 60 * 1000;

export interface AppUpdateService {
  acknowledgeResult(args: { id: string }): Promise<SystemAppUpdateStatus>;
  apply(args: {
    confirmInterruptingThreads: boolean;
  }): Promise<SystemAppUpdateStatus>;
  cancel(): Promise<SystemAppUpdateStatus>;
  dispose(): void;
  getStatus(args: { forceRefresh: boolean }): Promise<SystemAppUpdateStatus>;
}

interface CreateAppUpdateServiceArgs {
  currentCommit: string | null;
  appSurface: AppSurface;
  config: Pick<ServerRuntimeConfig, "appVersion" | "isDevelopment">;
  countRunningThreads: () => number;
  acquireRestartHold?: (
    ownerId: string,
    closePluginLeases: readonly string[],
  ) => Promise<void>;
  releaseRestartHold?: (ownerId: string) => Promise<void>;
  dataDir: string;
  launcher: LauncherChannel | null;
  logger: ServerLogger;
  mode: AppUpdateMode | null;
  notifyChanged: () => void;
  now?: () => number;
  privateDelivery?: PrivateDeliveryGuard;
  setDraining: (draining: boolean) => void;
  sourceCheckTtlMs?: number;
  stopRunningThreads: (args: {
    shouldContinue: () => boolean;
    timeoutMs: number;
  }) => Promise<void>;
}

interface UpdateIssue {
  code: string;
  message: string;
}

interface PendingPrivateUpdate {
  idleOnly: boolean;
  deliveryApproval: PrivateDeliveryApproval;
  readyRestartRequested: boolean;
  startedAt: string;
  stopsRunningChatsAt: number;
  targetVersion: string;
  holdOwnerId: string | null;
  recoveryMessage: string | null;
  cancelled: boolean;
  cancelAcknowledged: boolean;
  stoppingThreads: boolean;
  restartDeadline: number | null;
  cancelling: Promise<void> | null;
}

function toPublicRevision(revision: AppRevision): SystemAppUpdateRevision {
  return revision.kind === "npm"
    ? { commit: null, version: revision.version }
    : { commit: revision.commit, version: revision.version };
}

function toPublicActivity(
  activity: AppUpdateActivity,
): SystemAppUpdateActivity {
  switch (activity.phase) {
    case "idle":
      return { phase: "idle" };
    case "ready":
      return {
        output: [],
        phase: "preparing",
        startedAt: activity.startedAt,
        step: "Ready to restart",
        targetVersion: activity.targetVersion,
      };
    case "preparing":
      return {
        output: activity.output,
        phase: "preparing",
        startedAt: activity.startedAt,
        step: activity.step,
        targetVersion: activity.targetVersion,
      };
    case "restarting":
      return {
        phase: "restarting",
        startedAt: activity.startedAt,
        targetCommit:
          activity.target.kind === "source" ? activity.target.commit : null,
        targetVersion: activity.targetVersion,
      };
  }
}

function toPublicResult(result: AppUpdateResult): SystemAppUpdateResult {
  return {
    acknowledged: result.acknowledged,
    errorCode: result.errorCode ?? null,
    finishedAt: result.finishedAt,
    from: toPublicRevision(result.from),
    id: result.id,
    logTail: result.logTail,
    message: result.message,
    outcome: result.outcome,
    phase: result.phase,
    to: toPublicRevision(result.to),
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function unsupportedMessage(support: SystemAppUpdateSupport): string {
  if (support.kind === "supported") return "";

  switch (support.reason) {
    case "development":
      return "In-app updates are unavailable in development mode.";
    case "desktop":
      return "The desktop app updates itself; use its update controls.";
    case "unmanaged":
      return "Use the verified private release installer, or start a managed source checkout without --no-in-app-updates.";
  }
}

export function createAppUpdateService(
  args: CreateAppUpdateServiceArgs,
): AppUpdateService {
  const now = args.now ?? Date.now;
  const sourceCheckTtlMs = args.sourceCheckTtlMs ?? SOURCE_CHECK_TTL_MS;
  let launcherStatus: LauncherAppUpdateStatus | null = null;
  let resolveFirstStatus: (() => void) | null = null;

  const firstStatus = new Promise<void>((resolvePromise) => {
    resolveFirstStatus = resolvePromise;
  });

  let sourceCheck: SourceUpdateCheck | null = null;
  let lastSourceCheckAttemptAt: number | null = null;
  let sourceCheckInflight: Promise<SourceUpdateCheck | null> | null = null;
  let launcherConnected = args.launcher !== null;
  let confirmedInterruptingThreads = false;
  let decidedReadyAt: string | null = null;
  let pending: PendingPrivateUpdate | null = null;
  let restartRecheck: ReturnType<typeof setInterval> | null = null;
  let restartAttempt: Promise<void> | null = null;
  let newTurnsPaused = false;

  const pauseNewTurns = (): void => {
    if (newTurnsPaused) return;
    newTurnsPaused = true;
    args.setDraining(true);
    args.notifyChanged();
  };

  const resumeNewTurns = (): void => {
    if (!newTurnsPaused) return;
    newTurnsPaused = false;
    args.setDraining(false);
    args.notifyChanged();
  };

  const stopRestartRecheck = (): void => {
    if (restartRecheck !== null) clearInterval(restartRecheck);
    restartRecheck = null;
  };

  const endPending = (): void => {
    stopRestartRecheck();

    if (pending === null) return;

    if (
      pending.holdOwnerId !== null ||
      restartAttempt !== null ||
      pending.readyRestartRequested
    ) {
      pending.recoveryMessage =
        "The runtime update needs recovery before new work can start.";
      args.notifyChanged();

      return;
    }

    pending = null;
    resumeNewTurns();
    args.notifyChanged();
  };

  const requestLauncher = (
    launcher: LauncherChannel,
    request: AppUpdateLauncherRequest,
  ): void => {
    void launcher.request(request).catch((error: unknown) => {
      args.logger.warn(
        { error: errorMessage(error), request: request.type },
        "Launcher did not accept the restart decision",
      );
    });
  };

  const watchRestart = (launcher: LauncherChannel): void => {
    if (
      pending === null ||
      pending.readyRestartRequested ||
      restartRecheck !== null
    )
      return;

    restartRecheck = setInterval(
      () => restartWhenReady(launcher),
      RESTART_RECHECK_MS,
    );
  };

  const restartWhenReady = (launcher: LauncherChannel): void => {
    const current = pending;

    if (
      current === null ||
      current.readyRestartRequested ||
      restartAttempt !== null ||
      current.recoveryMessage !== null ||
      current.cancelled
    )
      return;

    const runningThreadCount = args.countRunningThreads();

    if (
      !confirmedInterruptingThreads &&
      !current.idleOnly &&
      runningThreadCount !== 0 &&
      now() >= current.stopsRunningChatsAt
    ) {
      confirmedInterruptingThreads = true;
      args.logger.info(
        { targetVersion: current.targetVersion, runningThreadCount },
        "Private Omnyo update waited 10 minutes for idle chats; pausing running chats and resuming them after the restart",
      );
      args.notifyChanged();
    }

    const interrupting = confirmedInterruptingThreads;

    if (!interrupting && runningThreadCount !== 0) return;

    const releaseHold = async (): Promise<void> => {
      if (current.holdOwnerId === null) return;

      if (!args.releaseRestartHold)
        throw new Error("Worker update admission is unavailable");
      await args.releaseRestartHold(current.holdOwnerId);
      current.holdOwnerId = null;
    };

    const deliveryIssue = async (): Promise<UpdateIssue | null> => {
      try {
        if (args.privateDelivery === undefined)
          throw new Error(
            "Private runtime delivery verification is unavailable.",
          );
        await args.privateDelivery.flush();
        await verifyPrivateDeliveryApproval({
          dataDir: args.dataDir,
          manifest: current.deliveryApproval,
          guard: args.privateDelivery,
          expected: current.deliveryApproval,
        });

        return null;
      } catch (error) {
        return {
          code: "app_update_delivered_fixes_changed",
          message: errorMessage(error),
        };
      }
    };

    const attempt = async (): Promise<UpdateIssue | null> => {
      pauseNewTurns();
      const initialDeliveryIssue = await deliveryIssue();

      if (initialDeliveryIssue !== null) return initialDeliveryIssue;

      if (current.cancelled || pending !== current) return null;

      if (interrupting) {
        current.stoppingThreads = true;
        args.notifyChanged();

        try {
          await args.stopRunningThreads({
            shouldContinue: () => !current.cancelled && pending === current,
            timeoutMs: STOP_THREADS_TIMEOUT_MS,
          });
        } catch (error) {
          return {
            code: "app_update_pause_failed",
            message: `Chats could not all be paused. Omnyo kept its current version and resumed them. ${errorMessage(error)}`,
          };
        } finally {
          current.stoppingThreads = false;
        }

        current.restartDeadline ??= now() + RESTART_AFTER_STOP_TIMEOUT_MS;
      }

      if (
        current.cancelled ||
        pending !== current ||
        args.countRunningThreads() !== 0
      )
        return null;

      if (!interrupting) {
        const ownerId = randomUUID();
        current.holdOwnerId = ownerId;

        try {
          if (!args.acquireRestartHold)
            throw new Error("Worker update admission is unavailable");
          await args.acquireRestartHold(ownerId, []);
        } catch (error) {
          if (
            error instanceof ApiError &&
            error.body.code === "runtime_update_busy"
          ) {
            current.holdOwnerId = null;

            return null;
          }

          throw error;
        }
      }

      if (
        current.cancelled ||
        pending !== current ||
        args.countRunningThreads() !== 0 ||
        (!interrupting && confirmedInterruptingThreads)
      ) {
        await releaseHold();

        return null;
      }

      const finalDeliveryIssue = await deliveryIssue();

      if (finalDeliveryIssue !== null) {
        await releaseHold();

        return finalDeliveryIssue;
      }

      if (current.cancelled || pending !== current) {
        await releaseHold();

        return null;
      }

      current.readyRestartRequested = true;
      stopRestartRecheck();

      try {
        await launcher.request({ type: "restart" });
      } catch (error) {
        if (!(error instanceof LauncherRequestRejectedError)) throw error;
        await releaseHold();
        current.readyRestartRequested = false;
        current.recoveryMessage = null;
        args.logger.warn(
          { error: errorMessage(error) },
          "Launcher rejected the restart; waiting to retry",
        );
      }

      return null;
    };

    let abandonIssue: UpdateIssue | null = null;

    restartAttempt = attempt()
      .then((message) => {
        abandonIssue = message;
      })
      .catch((error: unknown) => {
        stopRestartRecheck();
        current.recoveryMessage =
          current.holdOwnerId === null
            ? "The update handoff is uncertain. New turns remain paused; recover this update before starting new work."
            : "The update handoff is uncertain. Worker admission remains held; recover this update before starting new work.";
        args.logger.warn(
          { error: errorMessage(error), ownerId: current.holdOwnerId },
          "Private restart admission needs recovery",
        );
      })
      .finally(() => {
        restartAttempt = null;

        const waiting =
          pending === current &&
          !current.readyRestartRequested &&
          current.holdOwnerId === null &&
          current.recoveryMessage === null &&
          !current.cancelled;

        if (
          waiting &&
          abandonIssue === null &&
          current.restartDeadline !== null &&
          now() >= current.restartDeadline
        )
          abandonIssue = {
            code: "app_update_pause_timeout",
            message:
              "Chats did not finish pausing in time. Omnyo kept its current version and resumed them.",
          };

        if (waiting && abandonIssue !== null) {
          void abandonPending(current, abandonIssue);
        } else if (waiting && !interrupting && confirmedInterruptingThreads) {
          restartWhenReady(launcher);
        } else if (waiting) {
          if (current.restartDeadline === null && !confirmedInterruptingThreads)
            resumeNewTurns();
          watchRestart(launcher);
        }

        args.notifyChanged();
      });
  };

  const decidePrivateRestart = (launcher: LauncherChannel): void => {
    if (pending === null) {
      requestLauncher(launcher, {
        message: "The update was cancelled.",
        type: "cancel",
      });

      return;
    }

    restartWhenReady(launcher);
    watchRestart(launcher);
  };

  const decideRestart = (launcher: LauncherChannel, readyAt: string): void => {
    if (decidedReadyAt === readyAt) return;
    decidedReadyAt = readyAt;

    if (args.mode === "private") {
      decidePrivateRestart(launcher);

      return;
    }

    const runningThreadCount = args.countRunningThreads();

    const request: AppUpdateLauncherRequest =
      runningThreadCount > 0 && !confirmedInterruptingThreads
        ? {
            message: `${String(runningThreadCount)} thread${
              runningThreadCount === 1 ? "" : "s"
            } started while Omnyo was downloading the update. Update again to restart.`,
            type: "cancel",
          }
        : { type: "restart" };

    requestLauncher(launcher, request);
  };

  const unsubscribeStatus =
    args.launcher?.onStatus((status) => {
      launcherStatus = status;
      resolveFirstStatus?.();
      resolveFirstStatus = null;

      if (
        status.activity.phase === "ready" &&
        args.launcher !== null &&
        resolveSupport().kind === "supported"
      ) {
        decideRestart(args.launcher, status.activity.startedAt);
      }

      if (status.activity.phase === "idle" && pending !== null) endPending();
      args.notifyChanged();
    }) ?? (() => undefined);

  const unsubscribeDisconnect =
    args.launcher?.onDisconnect(() => {
      launcherConnected = false;
      launcherStatus = null;
      endPending();
      args.notifyChanged();
    }) ?? (() => undefined);

  function resolveSupport(): SystemAppUpdateSupport {
    if (args.appSurface === "desktop") {
      return { kind: "unsupported", reason: "desktop" };
    }

    if (args.config.isDevelopment) {
      return { kind: "unsupported", reason: "development" };
    }

    if (
      args.mode === null ||
      args.mode === "npm" ||
      args.launcher === null ||
      !launcherConnected
    ) {
      return { kind: "unsupported", reason: "unmanaged" };
    }

    return { kind: "supported", mode: args.mode };
  }

  const refreshSourceCheck = (
    launcher: LauncherChannel,
  ): Promise<SourceUpdateCheck | null> => {
    if (sourceCheckInflight !== null) return sourceCheckInflight;
    lastSourceCheckAttemptAt = now();

    const request = (async () => {
      try {
        const parsed = sourceUpdateCheckSchema.safeParse(
          await launcher.request({ type: "check-source" }),
        );

        if (!parsed.success) {
          args.logger.warn(
            { issue: parsed.error.message },
            "Launcher returned an invalid source update check",
          );

          return sourceCheck;
        }

        sourceCheck = parsed.data;

        return parsed.data;
      } catch (error) {
        args.logger.warn(
          { error: errorMessage(error) },
          "Source update check failed",
        );

        return sourceCheck;
      }
    })();

    sourceCheckInflight = request;
    void request.finally(() => {
      if (sourceCheckInflight === request) sourceCheckInflight = null;
    });

    return request;
  };

  const readSourceCheck = async (
    launcher: LauncherChannel,
    forceRefresh: boolean,
  ): Promise<SourceUpdateCheck | null> => {
    if (forceRefresh) {
      return refreshSourceCheck(launcher);
    }

    if (
      lastSourceCheckAttemptAt === null ||
      now() - lastSourceCheckAttemptAt >= sourceCheckTtlMs
    ) {
      void refreshSourceCheck(launcher).then(() => args.notifyChanged());
    }

    return sourceCheck;
  };

  const readPrivateManifest = () =>
    readPrivateServerUpdateManifest(args.dataDir);

  const currentVersion = (): string =>
    launcherStatus?.current.version ?? args.config.appVersion;

  const readPrivateAvailability = async (): Promise<{
    available: SystemAppUpdateAvailable | null;
    blocked: SystemAppUpdateStatus["blocked"];
  }> => {
    const read = await readPrivateManifest();

    switch (read.kind) {
      case "none":
        return { available: null, blocked: null };
      case "invalid":
        return {
          available: null,
          blocked: { message: read.message, reason: "update-unreadable" },
        };
      case "available": {
        if (!semver.gt(read.manifest.version, currentVersion()))
          return { available: null, blocked: null };

        try {
          if (args.privateDelivery === undefined)
            throw new Error(
              "Private runtime delivery verification is unavailable.",
            );
          await verifyPrivateDeliveryApproval({
            dataDir: args.dataDir,
            manifest: read.manifest,
            guard: args.privateDelivery,
          });
        } catch (error) {
          return {
            available: null,
            blocked: {
              reason: "update-unreadable",
              message: errorMessage(error),
            },
          };
        }

        return {
          available: {
            channel: "private",
            commit: read.manifest.sourceCommit,
            commitCount: null,
            subjects: [],
            version: read.manifest.version,
            ...(read.manifest.schema === 2
              ? { activation: read.manifest.activation }
              : {}),
          },
          blocked: null,
        };
      }
    }
  };

  const readAvailability = async (
    support: SystemAppUpdateSupport,
    forceRefresh: boolean,
  ): Promise<{
    available: SystemAppUpdateAvailable | null;
    blocked: SystemAppUpdateStatus["blocked"];
  }> => {
    if (support.kind !== "supported" || args.launcher === null) {
      return { available: null, blocked: null };
    }

    if (support.mode === "private") {
      return readPrivateAvailability();
    }

    const check = await readSourceCheck(args.launcher, forceRefresh);

    if (check === null)
      return {
        available: null,
        blocked: {
          reason: "fetch-failed",
          message: "Source update status is not available yet.",
        },
      };

    return {
      available:
        check.incoming === null
          ? null
          : {
              channel: "main",
              commit: check.incoming.commit,
              commitCount: check.incoming.commitCount,
              subjects: check.incoming.subjects,
              version: check.incoming.version,
            },
      blocked: check.blocked,
    };
  };

  const getStatus = async ({
    forceRefresh,
  }: {
    forceRefresh: boolean;
  }): Promise<SystemAppUpdateStatus> => {
    const support = resolveSupport();

    if (support.kind === "supported" && launcherStatus === null) {
      await Promise.race([
        firstStatus,
        new Promise((resolvePromise) =>
          setTimeout(resolvePromise, FIRST_STATUS_WAIT_MS),
        ),
      ]);
    }

    const { available, blocked } = await readAvailability(
      support,
      forceRefresh,
    );

    const status = launcherStatus;

    return {
      activity:
        status === null
          ? { phase: "idle" }
          : pending !== null &&
              !pending.readyRestartRequested &&
              status.activity.phase === "ready"
            ? pendingActivity(pending)
            : toPublicActivity(status.activity),
      available,
      blocked: pending?.recoveryMessage
        ? {
            code: "app_update_recovery_required",
            reason: "update-unreadable",
            message: pending.recoveryMessage,
          }
        : blocked,
      current:
        status === null
          ? { commit: args.currentCommit, version: args.config.appVersion }
          : toPublicRevision(status.current),
      lastResult:
        status?.lastResult === null || status?.lastResult === undefined
          ? null
          : toPublicResult(status.lastResult),
      installsWhenIdle:
        pending !== null &&
        !pending.readyRestartRequested &&
        !pending.cancelled &&
        !confirmedInterruptingThreads,
      newTurnsPausedForUpdate: newTurnsPaused,
      runningThreadCount: args.countRunningThreads(),
      support,
    };
  };

  const pendingActivity = (
    current: PendingPrivateUpdate,
  ): SystemAppUpdateActivity =>
    current.idleOnly
      ? {
          code: null,
          output: [],
          phase: "preparing",
          startedAt: current.startedAt,
          step: "Waiting for idle",
          targetVersion: current.targetVersion,
        }
      : confirmedInterruptingThreads
        ? {
            code: null,
            output: [],
            phase: "preparing",
            startedAt: current.startedAt,
            step: current.stoppingThreads
              ? "Pausing chats"
              : "Restarting Omnyo",
            targetVersion: current.targetVersion,
          }
        : {
            phase: "draining",
            startedAt: current.startedAt,
            stopsRunningChatsAt: new Date(
              current.stopsRunningChatsAt,
            ).toISOString(),
            targetVersion: current.targetVersion,
          };

  const applyPrivate = async (
    launcher: LauncherChannel,
    confirmInterruptingThreads: boolean,
  ): Promise<SystemAppUpdateStatus> => {
    if (pending !== null) {
      if (pending.idleOnly && confirmInterruptingThreads)
        throw new ApiError(
          409,
          "app_update_idle_only",
          "This identity update waits for all work to finish. Running chats cannot be interrupted.",
        );

      if (pending.cancelled)
        throw new ApiError(
          409,
          "app_update_in_progress",
          "The update is being cancelled.",
        );

      if (confirmInterruptingThreads && !confirmedInterruptingThreads) {
        confirmedInterruptingThreads = true;
        args.notifyChanged();

        if (launcherStatus?.activity.phase === "ready") {
          restartWhenReady(launcher);
        }
      }

      return getStatus({ forceRefresh: false });
    }

    if (launcherStatus !== null && launcherStatus.activity.phase !== "idle") {
      throw new ApiError(
        409,
        "app_update_in_progress",
        "An update is already in progress.",
      );
    }

    const read = await readPrivateManifest();

    if (read.kind === "invalid") {
      throw new ApiError(409, "app_update_blocked", read.message);
    }

    if (
      read.kind === "none" ||
      !semver.gt(read.manifest.version, currentVersion())
    ) {
      throw new ApiError(
        409,
        "app_update_unavailable",
        "Omnyo is already up to date.",
      );
    }

    if (pending !== null)
      return applyPrivate(launcher, confirmInterruptingThreads);

    const idleOnly = read.manifest.schema === 2;

    if (idleOnly && confirmInterruptingThreads)
      throw new ApiError(
        409,
        "app_update_idle_only",
        "This identity update waits for all work to finish. Running chats cannot be interrupted.",
      );

    let deliveryApproval: PrivateDeliveryApproval;

    try {
      if (args.privateDelivery === undefined)
        throw new Error(
          "Private runtime delivery verification is unavailable.",
        );
      deliveryApproval = await verifyPrivateDeliveryApproval({
        dataDir: args.dataDir,
        manifest: read.manifest,
        guard: args.privateDelivery,
      });
    } catch (error) {
      throw new ApiError(409, "app_update_blocked", errorMessage(error));
    }

    if (pending !== null)
      return applyPrivate(launcher, confirmInterruptingThreads);

    const target: AppUpdateTarget = {
      kind: "private",
      runtimeSha256: read.manifest.runtimeSha256,
      version: read.manifest.version,
    };

    const appliedAt = now();
    confirmedInterruptingThreads = confirmInterruptingThreads;
    pending = {
      idleOnly,
      deliveryApproval,
      readyRestartRequested: false,
      startedAt: new Date(appliedAt).toISOString(),
      stopsRunningChatsAt: appliedAt + PRIVATE_IDLE_WAIT_MS,
      targetVersion: read.manifest.version,
      holdOwnerId: null,
      recoveryMessage: null,
      cancelled: false,
      cancelAcknowledged: false,
      stoppingThreads: false,
      restartDeadline: null,
      cancelling: null,
    };
    args.notifyChanged();

    try {
      await launcher.request({
        target,
        targetVersion: read.manifest.version,
        type: "apply",
      });
    } catch (error) {
      endPending();
      throw new ApiError(409, "app_update_rejected", errorMessage(error));
    }

    args.logger.info(
      {
        targetVersion: read.manifest.version,
        targetCommit: read.manifest.sourceCommit,
        stopsRunningThreads: confirmInterruptingThreads,
      },
      idleOnly
        ? "Private identity update requested; waiting for all work to finish without interrupting chats"
        : confirmInterruptingThreads
          ? "Private Omnyo update requested; running chats stop and resume after the restart"
          : "Private Omnyo update requested; it installs once every chat is idle, or pauses and resumes running chats after 10 minutes",
    );

    return getStatus({ forceRefresh: false });
  };

  const cancelPending = (
    current: PendingPrivateUpdate,
    message: string,
    errorCode?: string,
  ): Promise<void> => {
    current.cancelling ??= cancelPendingOnce(
      current,
      message,
      errorCode,
    ).finally(() => {
      current.cancelling = null;
    });

    return current.cancelling;
  };

  const cancelPendingOnce = async (
    current: PendingPrivateUpdate,
    message: string,
    errorCode?: string,
  ): Promise<void> => {
    const launcher = requireLauncher();

    const ready =
      launcherStatus?.activity.phase === "ready" ||
      current.holdOwnerId !== null ||
      current.readyRestartRequested;

    current.cancelled = true;
    stopRestartRecheck();

    if (ready && !current.cancelAcknowledged) {
      try {
        await launcher.request({
          message,
          type: "cancel",
          ...(errorCode === undefined ? {} : { errorCode }),
        });
        current.cancelAcknowledged = true;
      } catch (error) {
        current.recoveryMessage =
          current.holdOwnerId === null
            ? "Cancellation was not acknowledged. New turns remain paused until this update is recovered."
            : "Cancellation was not acknowledged. Worker admission remains held until this update is recovered.";
        args.notifyChanged();
        throw new ApiError(409, "app_update_rejected", errorMessage(error));
      }
    }

    await restartAttempt;

    if (current.holdOwnerId !== null) {
      try {
        if (!args.releaseRestartHold)
          throw new Error("Worker update admission is unavailable");
        await args.releaseRestartHold(current.holdOwnerId);
        current.holdOwnerId = null;
      } catch (error) {
        current.recoveryMessage =
          "The update was cancelled, but worker admission remains held. Recover the owned hold before starting new work.";
        args.notifyChanged();
        throw new ApiError(409, "app_update_rejected", errorMessage(error));
      }
    }

    current.readyRestartRequested = false;
    endPending();
  };

  const abandonPending = async (
    current: PendingPrivateUpdate,
    issue: UpdateIssue,
  ): Promise<void> => {
    if (pending !== current) return;

    args.logger.warn(issue, "Private Omnyo update abandoned");

    try {
      await cancelPending(current, issue.message, issue.code);
    } catch (error) {
      args.logger.warn(
        { error: errorMessage(error) },
        "Abandoning the private Omnyo update needs recovery",
      );
    }
  };

  const requireLauncher = (): LauncherChannel => {
    const support = resolveSupport();

    if (support.kind !== "supported" || args.launcher === null) {
      throw new ApiError(
        409,
        "app_update_unsupported",
        unsupportedMessage(support),
      );
    }

    return args.launcher;
  };

  return {
    async acknowledgeResult({ id }) {
      const launcher = requireLauncher();

      try {
        await launcher.request({ id, type: "acknowledge-result" });
      } catch (error) {
        throw new ApiError(409, "app_update_rejected", errorMessage(error));
      }

      return getStatus({ forceRefresh: false });
    },
    async apply({ confirmInterruptingThreads }) {
      const launcher = requireLauncher();

      if (args.mode === "private") {
        return applyPrivate(launcher, confirmInterruptingThreads);
      }

      if (launcherStatus !== null && launcherStatus.activity.phase !== "idle") {
        throw new ApiError(
          409,
          "app_update_in_progress",
          "An update is already in progress.",
        );
      }

      const support = resolveSupport();

      const status = await getStatus({
        forceRefresh: support.kind === "supported" && support.mode === "source",
      });

      if (status.blocked !== null) {
        throw new ApiError(409, "app_update_blocked", status.blocked.message);
      }

      const available = status.available;

      if (available === null) {
        throw new ApiError(
          409,
          "app_update_unavailable",
          "Omnyo is already up to date.",
        );
      }

      if (status.runningThreadCount > 0 && !confirmInterruptingThreads) {
        throw new ApiError(
          409,
          "threads_running",
          `${String(status.runningThreadCount)} thread${
            status.runningThreadCount === 1 ? " is" : "s are"
          } running. Updating restarts Omnyo and interrupts ${
            status.runningThreadCount === 1 ? "it" : "them"
          }.`,
          { details: { runningThreadCount: status.runningThreadCount } },
        );
      }

      const target: AppUpdateTarget | null =
        available.commit === null
          ? null
          : { commit: available.commit, kind: "source" };

      if (target === null) {
        throw new ApiError(
          409,
          "app_update_unavailable",
          "Omnyo is already up to date.",
        );
      }

      confirmedInterruptingThreads = confirmInterruptingThreads;

      try {
        await launcher.request({
          target,
          targetVersion: available.version,
          type: "apply",
        });
      } catch (error) {
        throw new ApiError(409, "app_update_rejected", errorMessage(error));
      }

      args.logger.info(
        { targetVersion: available.version, targetCommit: available.commit },
        "In-app Omnyo update requested",
      );

      return getStatus({ forceRefresh: false });
    },
    async cancel() {
      requireLauncher();

      if (pending === null) {
        throw new ApiError(
          409,
          "app_update_not_draining",
          "No update is waiting to restart.",
        );
      }

      await cancelPending(pending, "The update was cancelled.");

      args.logger.info("In-app Omnyo update cancelled");

      return getStatus({ forceRefresh: false });
    },
    dispose() {
      stopRestartRecheck();
      unsubscribeStatus();
      unsubscribeDisconnect();
      args.launcher?.dispose();
    },
    getStatus,
  };
}
