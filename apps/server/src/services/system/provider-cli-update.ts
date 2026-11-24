import { randomUUID } from "node:crypto";
import { setProviderCliStartupFailure } from "./provider-cli-startup-state.js";
import { setTimeout as sleep } from "node:timers/promises";
import { getSessionById } from "@omnyo/db";
import type {
  HostDaemonOnlineRpcCommand,
  ProviderCliInstallEvent,
  ProviderInstallationOperation,
} from "@omnyo/host-daemon-contract";
import { ApiError } from "../../errors.js";
import type { LoggedPendingInteractionWorkSessionDeps as AppDeps } from "../../types.js";
import {
  callHostOnlineRpcForWork,
  callHostRetryableOnlineRpc,
} from "../hosts/online-rpc.js";
import { stopRunningWorkForAppUpdate } from "../server-move/stop-work.js";
import { requestQueuedMessageDispatch } from "../threads/queued-message-dispatch.js";
import { serializeProviderInstallation } from "./provider-installations.js";
import {
  isServerRestartDraining,
  reserveHostUpdateDrain,
} from "./server-update-drain.js";

const PROVIDER_CLI_PAUSE_TIMEOUT_MS = 30_000;

const PROVIDER_CLI_OPERATION_TIMEOUT_MS = 15 * 60_000;

const PROVIDER_CLI_OPERATION_RPC_TIMEOUT_MS = 5_000;

const PROVIDER_CLI_OPERATION_POLL_MS = 500;

const PROVIDER_CLI_UPDATE_PROTOCOL = 250;

type InstallationCommand = Extract<
  HostDaemonOnlineRpcCommand,
  { type: "provider.installation.start" }
>;

type UpdateRequest = Omit<InstallationCommand, "type" | "operationId"> & {
  hostId: string;
};

type UpdateState =
  | { kind: "queued" }
  | { kind: "running"; releaseDrain: () => void }
  | { kind: "reconciling"; releaseDrain: () => void }
  | { kind: "uncertain"; releaseDrain: () => void }
  | { kind: "finished" };

interface UpdateJob {
  request: UpdateRequest;
  operationId: string;
  events: ProviderCliInstallEvent[];
  observers: Set<ReadableStreamDefaultController<Uint8Array>>;
  state: UpdateState;
}

const jobs = new WeakMap<AppDeps["db"], Map<string, UpdateJob>>();

function hostJobs(deps: AppDeps): Map<string, UpdateJob> {
  let hosts = jobs.get(deps.db);

  if (hosts === undefined) {
    hosts = new Map();
    jobs.set(deps.db, hosts);
  }

  return hosts;
}

function emit(job: UpdateJob, event: ProviderCliInstallEvent): void {
  job.events.push(event);
  const bytes = new TextEncoder().encode(`${JSON.stringify(event)}\n`);

  for (const observer of job.observers) {
    try {
      observer.enqueue(bytes);
    } catch {
      job.observers.delete(observer);
    }
  }
}

function progress(
  job: UpdateJob,
  phase: Extract<ProviderCliInstallEvent, { type: "progress" }>["phase"],
  message: string,
): void {
  const previous = job.events.at(-1);

  if (previous?.type === "progress" && previous.phase === phase) return;
  emit(job, {
    type: "progress",
    provider: job.request.providerId,
    phase,
    message,
  });
}

function closeObservers(job: UpdateJob): void {
  for (const observer of job.observers) {
    try {
      observer.close();
    } catch {
      job.observers.delete(observer);
    }
  }

  job.observers.clear();
}

function resumeChats(deps: AppDeps, job: UpdateJob): void {
  if (job.state.kind !== "running" && job.state.kind !== "uncertain") return;
  progress(job, "resuming", "Resuming chats on this machine.");
  job.state.releaseDrain();
  job.state = { kind: "finished" };
  requestQueuedMessageDispatch(deps, {
    kind: "idle-recovery",
    now: Date.now(),
  });
}

function finishInstallation(
  deps: AppDeps,
  job: UpdateJob,
  operation: ProviderInstallationOperation,
): void {
  resumeChats(deps, job);

  const success = operation.events.some(
    (event) => event.type === "completed" && event.success,
  );

  if (success) {
    setProviderCliStartupFailure(
      deps.db,
      job.request.hostId,
      job.request.providerId,
      null,
    );
    setProviderCliStartupFailure(deps.db, job.request.hostId, "*", null);
    deps.providerRegistry.forgetInstalledKey({
      hostId: job.request.hostId,
      providerId: job.request.providerId,
    });
    deps.lifecycleDedupers.providerModelCatalogs.clearFailure(
      job.request.hostId,
      job.request.providerId,
    );
  }

  for (const event of operation.events) emit(job, event);

  if (!success)
    deps.logger.warn(
      {
        hostId: job.request.hostId,
        providerId: job.request.providerId,
        operationId: job.operationId,
        code: "provider_cli_install_failed",
      },
      "Provider CLI installation failed",
    );

  if (!success && !operation.events.some((event) => event.type === "error")) {
    emit(job, {
      type: "error",
      provider: job.request.providerId,
      code: "provider_cli_install_failed",
      message:
        "The CLI update failed. Chats have resumed. Review the update log, then try again.",
    });
  }
}

function assertCurrentWorker(deps: AppDeps, hostId: string): void {
  const sessionId = deps.hub.getDaemonSessionIdForHost(hostId);

  const session =
    sessionId === null ? null : getSessionById(deps.db, { sessionId });

  if (session === null) {
    throw new ApiError(
      502,
      "host_unavailable",
      "The machine is not connected.",
    );
  }

  if (session.protocolVersion < PROVIDER_CLI_UPDATE_PROTOCOL) {
    throw new ApiError(
      409,
      "provider_cli_update_requires_worker_update",
      "Update Omnyo on this machine before using Update now for a CLI.",
    );
  }
}

function uncertainOutcome(job: UpdateJob): void {
  if (job.state.kind !== "running" && job.state.kind !== "reconciling") return;
  job.state = { kind: "uncertain", releaseDrain: job.state.releaseDrain };
  emit(job, {
    type: "error",
    provider: job.request.providerId,
    code: "provider_cli_update_outcome_unknown",
    message:
      "The machine has not confirmed the update result. Chats are still paused. Reconnect the machine, then retry to check the same update.",
  });
}

async function observeInstallation(
  deps: AppDeps,
  job: UpdateJob,
  initial: ProviderInstallationOperation | null,
): Promise<void> {
  const deadline = Date.now() + PROVIDER_CLI_OPERATION_TIMEOUT_MS;
  let operation = initial;
  let holdReleased = false;

  while (true) {
    if (operation !== null) {
      if (
        holdReleased &&
        (operation.state === "completed" || operation.state === "failed")
      ) {
        finishInstallation(deps, job, operation);

        return;
      }

      if (operation.state === "installing" || operation.state === "verifying") {
        progress(
          job,
          operation.state,
          operation.state === "verifying"
            ? "Checking the installed CLI version."
            : "Updating the CLI on this machine.",
        );
      } else if (!holdReleased) {
        progress(
          job,
          "waiting-for-host",
          "Waiting for the machine to release the update hold.",
        );
      }
    }

    if (Date.now() >= deadline) {
      uncertainOutcome(job);

      return;
    }

    try {
      const result = await callHostRetryableOnlineRpc(deps, {
        hostId: job.request.hostId,
        timeoutMs: PROVIDER_CLI_OPERATION_RPC_TIMEOUT_MS,
        command: {
          type: "provider.installation.get",
          operationId: job.operationId,
        },
      });

      operation = result.operation;
      holdReleased = !result.held;

      if (operation === null && !result.held) {
        resumeChats(deps, job);
        emit(job, {
          type: "error",
          provider: job.request.providerId,
          code: "provider_cli_update_result_unavailable",
          message:
            "The machine no longer has this update result. Chats have resumed. Check the installed CLI version before trying another update.",
        });

        return;
      }
    } catch (error) {
      operation = null;
      holdReleased = false;
      progress(
        job,
        "waiting-for-host",
        "Waiting for the machine to confirm the update result.",
      );
      deps.logger.debug(
        {
          err: error,
          hostId: job.request.hostId,
          operationId: job.operationId,
        },
        "Waiting for provider CLI installation result",
      );
    }

    if (
      operation === null ||
      !holdReleased ||
      (operation.state !== "completed" && operation.state !== "failed")
    ) {
      await sleep(PROVIDER_CLI_OPERATION_POLL_MS);
    }
  }
}

async function runInstallation(deps: AppDeps, job: UpdateJob): Promise<void> {
  await serializeProviderInstallation(deps, job.request.hostId, async () => {
    if (job.state.kind === "reconciling") {
      job.state = { kind: "running", releaseDrain: job.state.releaseDrain };
      await observeInstallation(deps, job, null);

      return;
    }

    assertCurrentWorker(deps, job.request.hostId);

    if (isServerRestartDraining(deps.db)) {
      throw new ApiError(
        409,
        "runtime_update_busy",
        "An Omnyo update is already in progress. Wait for it to finish, then retry the CLI update.",
      );
    }

    const releaseDrain = reserveHostUpdateDrain(deps.db, job.request.hostId);
    job.state = { kind: "running", releaseDrain };
    const deadline = Date.now() + PROVIDER_CLI_PAUSE_TIMEOUT_MS;

    try {
      progress(job, "pausing", "Pausing chats on this machine.");
      await stopRunningWorkForAppUpdate(deps, {
        hostId: job.request.hostId,
        shouldContinue: () => job.state.kind === "running",
        timeoutMs: Math.max(0, deadline - Date.now()),
      });
    } catch (error) {
      resumeChats(deps, job);
      throw new ApiError(
        409,
        "provider_cli_pause_failed",
        error instanceof Error
          ? error.message
          : "Chats could not pause for the CLI update.",
      );
    }

    progress(
      job,
      "waiting-for-host",
      "Waiting for the machine to start the CLI update.",
    );
    let operation: ProviderInstallationOperation | null = null;
    let refusal: ApiError | null = null;

    try {
      while (true) {
        const remainingMs = deadline - Date.now();

        if (remainingMs <= 0)
          throw (
            refusal ??
            new ApiError(
              409,
              "runtime_update_busy",
              "The machine did not become idle in time for the CLI update.",
            )
          );

        try {
          operation = await callHostOnlineRpcForWork(deps, {
            hostId: job.request.hostId,
            timeoutMs: Math.min(
              PROVIDER_CLI_OPERATION_RPC_TIMEOUT_MS,
              remainingMs,
            ),
            command: {
              type: "provider.installation.start",
              operationId: job.operationId,
              providerId: job.request.providerId,
              action: job.request.action,
              bridgeLaunch: job.request.bridgeLaunch,
            },
          });

          break;
        } catch (error) {
          if (
            !(error instanceof ApiError) ||
            error.body.code !== "runtime_update_busy"
          )
            throw error;

          if (refusal === null)
            deps.logger.debug(
              {
                hostId: job.request.hostId,
                providerId: job.request.providerId,
                operationId: job.operationId,
                code: error.body.code,
              },
              "Waiting for worker activity before updating the provider CLI",
            );
          refusal = error;
          const remainingAfterRefusalMs = deadline - Date.now();

          if (remainingAfterRefusalMs <= 0) throw error;
          await sleep(
            Math.min(PROVIDER_CLI_OPERATION_POLL_MS, remainingAfterRefusalMs),
          );
        }
      }
    } catch (error) {
      if (
        error instanceof ApiError &&
        (error.status < 500 ||
          [
            "runtime_update_busy",
            "provider_installation_operation_conflict",
            "direct_access_held",
          ].includes(error.body.code))
      ) {
        resumeChats(deps, job);
        throw error;
      }
    }

    await observeInstallation(deps, job, operation);
  });
}

function launch(deps: AppDeps, job: UpdateJob): void {
  void runInstallation(deps, job)
    .catch((error: unknown) => {
      deps.logger.warn(
        {
          hostId: job.request.hostId,
          providerId: job.request.providerId,
          operationId: job.operationId,
          code:
            error instanceof ApiError
              ? error.body.code
              : "provider_cli_update_failed",
        },
        "Provider CLI update failed",
      );
      emit(job, {
        type: "error",
        provider: job.request.providerId,
        code:
          error instanceof ApiError
            ? error.body.code
            : "provider_cli_update_failed",
        message:
          error instanceof ApiError
            ? error.body.message
            : "The CLI update could not finish. Review the update log, then retry.",
      });

      if (job.state.kind === "running" || job.state.kind === "reconciling")
        uncertainOutcome(job);
      else if (job.state.kind === "queued") job.state = { kind: "finished" };
    })
    .finally(() => {
      closeObservers(job);

      if (
        job.state.kind === "finished" &&
        hostJobs(deps).get(job.request.hostId) === job
      ) {
        hostJobs(deps).delete(job.request.hostId);
      }
    });
}

export function pendingProviderCliUpdateRequest(
  deps: AppDeps,
  hostId: string,
): UpdateRequest | null {
  const job = hostJobs(deps).get(hostId);

  return job !== undefined && job.state.kind !== "finished"
    ? job.request
    : null;
}

export function providerCliUpdateResponse(
  deps: AppDeps,
  request: UpdateRequest,
): Response {
  assertCurrentWorker(deps, request.hostId);
  const hosts = hostJobs(deps);
  let job = hosts.get(request.hostId);
  let shouldLaunch = false;

  if (job === undefined) {
    job = {
      request,
      operationId: randomUUID(),
      events: [],
      observers: new Set(),
      state: { kind: "queued" },
    };
    hosts.set(request.hostId, job);
    shouldLaunch = true;
  } else if (
    job.request.providerId !== request.providerId ||
    job.request.action !== request.action
  ) {
    throw new ApiError(
      409,
      "provider_cli_update_in_progress",
      "Another CLI update is in progress on this machine. Wait for it to finish, then retry.",
    );
  } else if (job.state.kind === "uncertain") {
    job.state = { kind: "reconciling", releaseDrain: job.state.releaseDrain };
    shouldLaunch = true;
  }

  const active = job;
  let observer: ReadableStreamDefaultController<Uint8Array> | null = null;

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      observer = controller;
      active.observers.add(controller);
      const encoder = new TextEncoder();

      for (const event of active.events)
        controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));

      if (shouldLaunch) launch(deps, active);
    },
    cancel() {
      if (observer !== null) active.observers.delete(observer);
    },
  });

  return new Response(stream, {
    headers: {
      "content-type": "application/x-ndjson; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}
