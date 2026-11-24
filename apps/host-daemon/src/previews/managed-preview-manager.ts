import { randomUUID } from "node:crypto";
import { get as httpGet } from "node:http";
import { get as httpsGet } from "node:https";
import { createServer } from "node:net";
import { isAbsolute } from "node:path";
import {
  createProcessStop,
  spawnPortableOutputProcess,
} from "@omnyo/process-utils";
import type {
  HostDaemonContributedEnvEntry,
  ManagedPreviewLaunch,
  ManagedPreviewStatus,
} from "@omnyo/host-daemon-contract";
import { operationEnvironment } from "../operation-environment.js";
import {
  inspectPreviewListeners,
  PreviewInspectionError,
  listenersBelongToPreview,
} from "./listeners.js";

type PreviewChild = ReturnType<typeof spawnPortableOutputProcess>;

interface PreviewRun {
  preview: ManagedPreviewLaunch;
  child: PreviewChild;
  runId: string;
  startedAt: number;
  failure: string | null;
}

interface ManagedPreviewManagerOptions {
  logger?: Pick<import("../logger.js").HostDaemonLogger, "warn">;
  shellEnv: () => NodeJS.ProcessEnv;
  markActive: (environmentId: string, previewId: string) => void;
  markInactive: (environmentId: string, previewId: string) => void;
  startupWaitMs?: number;
}

const SAFE_ENV_KEYS = new Set([
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "SHELL",
  "LANG",
  "TZ",
  "TMP",
  "TEMP",
  "TMPDIR",
  "SYSTEMROOT",
  "WINDIR",
  "COMSPEC",
  "PATHEXT",
  "USERPROFILE",
  "APPDATA",
  "LOCALAPPDATA",
  "PROGRAMFILES",
  "PROGRAMFILES(X86)",
]);

const READINESS_TIMEOUT_MS = 30_000;

function previewBaseEnvironment(
  shellEnv: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};

  for (const [key, value] of Object.entries(shellEnv)) {
    if (SAFE_ENV_KEYS.has(key.toUpperCase()) || key.startsWith("LC_")) {
      env[key] = value;
    }
  }

  if (shellEnv.OMNYO_SERVER_URL !== undefined)
    env.OMNYO_SERVER_URL = shellEnv.OMNYO_SERVER_URL;

  return env;
}

function childIsRunning(child: PreviewChild): boolean {
  return (
    child.pid !== undefined &&
    child.exitCode === null &&
    child.signalCode === null
  );
}

function launchMatches(
  left: ManagedPreviewLaunch,
  right: ManagedPreviewLaunch,
): boolean {
  return (
    left.id === right.id &&
    left.projectId === right.projectId &&
    left.environmentId === right.environmentId &&
    left.cwd === right.cwd &&
    left.protocol === right.protocol &&
    left.hostname === right.hostname &&
    left.port === right.port &&
    left.readinessPath === right.readinessPath &&
    left.argv.length === right.argv.length &&
    left.argv.every((arg, index) => arg === right.argv[index])
  );
}

function endpointUrl(preview: ManagedPreviewLaunch): URL {
  const hostname = preview.hostname === "::1" ? "[::1]" : preview.hostname;

  return new URL(
    `${preview.protocol}//${hostname}:${preview.port}${preview.readinessPath}`,
  );
}

async function readinessStatus(
  preview: ManagedPreviewLaunch,
): Promise<number | null> {
  return new Promise((resolveStatus) => {
    const get = preview.protocol === "https:" ? httpsGet : httpGet;

    const finish = (result: number | null): void => {
      clearTimeout(deadline);
      resolveStatus(result);
    };

    const request = get(endpointUrl(preview), { agent: false }, (response) => {
      finish(response.statusCode ?? null);
      response.destroy();
    });

    const deadline = setTimeout(() => {
      finish(null);
      request.destroy();
    }, 1_200);

    request.once("error", () => finish(null));
  });
}

async function canBindEndpoint(
  preview: ManagedPreviewLaunch,
): Promise<boolean> {
  return new Promise((resolveAvailable) => {
    const server = createServer();
    server.once("error", () => resolveAvailable(false));
    server.listen(
      { host: preview.hostname, port: preview.port, exclusive: true },
      () => {
        server.close(() => resolveAvailable(true));
      },
    );
  });
}

function status(
  state: ManagedPreviewStatus["state"],
  run: PreviewRun | undefined,
  detail: string | null = null,
): ManagedPreviewStatus {
  return { state, checkedAt: Date.now(), detail, runId: run?.runId ?? null };
}

export class ManagedPreviewManager {
  private readonly runs = new Map<string, PreviewRun>();
  private readonly ports = new Map<number, Promise<void>>();
  private readonly probes = new Map<string, Promise<ManagedPreviewStatus>>();
  private readonly socketOwners = new Map<PreviewRun, Promise<void>>();
  private readonly pendingEnsures = new Map<string, number>();
  private readonly retainedEnvironments = new Map<string, string>();
  private closed = false;

  constructor(private readonly options: ManagedPreviewManagerOptions) {}

  activityCount(): number {
    const ids = new Set(this.pendingEnsures.keys());

    for (const run of this.runs.values()) {
      if (childIsRunning(run.child)) ids.add(run.preview.id);
    }

    return ids.size;
  }

  status(preview: ManagedPreviewLaunch): Promise<ManagedPreviewStatus> {
    const pending = this.probes.get(preview.id);

    if (pending !== undefined) return pending;

    const probe = this.probe(preview).finally(() => {
      if (this.probes.get(preview.id) === probe) this.probes.delete(preview.id);
    });

    this.probes.set(preview.id, probe);

    return probe;
  }

  ensure(
    preview: ManagedPreviewLaunch,
    contributedEnv: readonly HostDaemonContributedEnvEntry[],
  ): Promise<ManagedPreviewStatus> {
    this.pendingEnsures.set(
      preview.id,
      (this.pendingEnsures.get(preview.id) ?? 0) + 1,
    );

    if (!this.retainedEnvironments.has(preview.id)) {
      this.options.markActive(preview.environmentId, preview.id);
      this.retainedEnvironments.set(preview.id, preview.environmentId);
    }

    const previous = this.ports.get(preview.port) ?? Promise.resolve();

    const operation = previous
      .then(() => this.ensureOnce(preview, contributedEnv))
      .finally(() => {
        const remaining = (this.pendingEnsures.get(preview.id) ?? 1) - 1;

        if (remaining === 0) this.pendingEnsures.delete(preview.id);
        else this.pendingEnsures.set(preview.id, remaining);
        this.releaseInactiveEnvironment(preview.id);
      });

    const completed = operation.then(
      () => undefined,
      () => undefined,
    );

    this.ports.set(preview.port, completed);
    void completed.then(() => {
      if (this.ports.get(preview.port) === completed)
        this.ports.delete(preview.port);
    });

    return operation;
  }

  async resolveTarget(
    previewId: string,
    runId: string,
  ): Promise<Pick<ManagedPreviewLaunch, "hostname" | "port" | "protocol">> {
    const run = this.runs.get(previewId);

    if (run === undefined || run.runId !== runId) {
      throw new Error("Preview is not available");
    }

    const observed = await this.status(run.preview);

    if (
      observed.state !== "online" ||
      observed.runId !== runId ||
      !childIsRunning(run.child)
    ) {
      this.options.logger?.warn(
        {
          previewId,
          runId,
          state: observed.state,
          childRunning: childIsRunning(run.child),
        },
        "Preview target validation failed",
      );
      throw new Error("Preview is not available");
    }

    return {
      hostname: run.preview.hostname,
      port: run.preview.port,
      protocol: run.preview.protocol,
    };
  }

  async validateSocketOwner(previewId: string, runId: string): Promise<void> {
    const run = this.runs.get(previewId);

    if (
      this.closed ||
      run === undefined ||
      run.runId !== runId ||
      !childIsRunning(run.child)
    )
      throw new Error("Preview is not available");

    const pending = this.socketOwners.get(run);

    if (pending !== undefined) return pending;

    const validation = this.inspectSocketOwner(run).finally(() => {
      if (this.socketOwners.get(run) === validation)
        this.socketOwners.delete(run);
    });

    this.socketOwners.set(run, validation);

    return validation;
  }

  private async inspectSocketOwner(run: PreviewRun): Promise<void> {
    const pid = run.child.pid;

    if (pid === undefined) throw new Error("Preview is not available");

    let listeners: Awaited<ReturnType<typeof inspectPreviewListeners>>;

    try {
      listeners = await inspectPreviewListeners(run.preview.port);
    } catch (error) {
      this.options.logger?.warn(
        {
          previewId: run.preview.id,
          runId: run.runId,
          phase: "socket-ownership",
          inspector:
            error instanceof PreviewInspectionError ? error.phase : "other",
          failure:
            error instanceof PreviewInspectionError ? error.failure : "other",
          exitCode:
            error instanceof PreviewInspectionError ? error.exitCode : null,
          elapsedMs:
            error instanceof PreviewInspectionError ? error.elapsedMs : null,
        },
        "Preview ownership inspection failed",
      );
      throw new Error("Preview ownership could not be checked");
    }

    if (
      this.closed ||
      this.runs.get(run.preview.id) !== run ||
      !childIsRunning(run.child) ||
      run.child.pid !== pid ||
      !listenersBelongToPreview(pid, listeners)
    )
      throw new Error("Preview is not available");
  }

  async shutdown(): Promise<void> {
    this.closed = true;
    await Promise.all(this.ports.values());
    await Promise.all(
      [...this.runs.values()].map(async (run) => {
        if (childIsRunning(run.child)) {
          const stopped = await createProcessStop(run.child)();

          if (stopped.treeTermination !== "confirmed")
            throw new Error("The owned preview process did not fully stop");
        }
      }),
    );
  }

  private releaseInactiveEnvironment(previewId: string): void {
    const run = this.runs.get(previewId);

    if (
      this.pendingEnsures.has(previewId) ||
      (run !== undefined && childIsRunning(run.child))
    )
      return;
    const environmentId = this.retainedEnvironments.get(previewId);

    if (environmentId !== undefined) {
      this.options.markInactive(environmentId, previewId);
      this.retainedEnvironments.delete(previewId);
    }
  }

  private async probe(
    preview: ManagedPreviewLaunch,
  ): Promise<ManagedPreviewStatus> {
    const run = this.runs.get(preview.id);

    if (run !== undefined && !launchMatches(run.preview, preview)) {
      return status("error", run, "The registered preview recipe changed.");
    }

    let listeners: Awaited<ReturnType<typeof inspectPreviewListeners>>;

    try {
      listeners = await inspectPreviewListeners(preview.port);
    } catch (error) {
      this.options.logger?.warn(
        {
          previewId: preview.id,
          runId: run?.runId ?? null,
          phase: "ownership-before",
          inspector:
            error instanceof PreviewInspectionError ? error.phase : "other",
          failure:
            error instanceof PreviewInspectionError ? error.failure : "other",
          exitCode:
            error instanceof PreviewInspectionError ? error.exitCode : null,
          elapsedMs:
            error instanceof PreviewInspectionError ? error.elapsedMs : null,
        },
        "Preview ownership inspection failed",
      );

      return status(
        "unknown",
        run,
        "Server process ownership could not be checked.",
      );
    }

    if (run === undefined || !childIsRunning(run.child)) {
      if (
        listeners.listenerPids.length > 0 ||
        !(await canBindEndpoint(preview))
      ) {
        return status(
          "conflict",
          run,
          "Another process is using this preview port.",
        );
      }

      return run?.failure === undefined || run.failure === null
        ? status("stopped", run)
        : status("error", run, run.failure);
    }

    const pid = run.child.pid;

    if (pid === undefined)
      return status("error", run, "The preview process did not start.");

    if (
      listeners.listenerPids.length > 0 &&
      !listenersBelongToPreview(pid, listeners)
    ) {
      return status(
        "conflict",
        run,
        "Another process is using this preview port.",
      );
    }

    if (listeners.listenerPids.length === 0) {
      return this.unready(run);
    }

    const responseStatus = await readinessStatus(preview);

    if (!childIsRunning(run.child)) return status("stopped", run);

    if (
      responseStatus !== null &&
      responseStatus >= 200 &&
      responseStatus < 400
    ) {
      try {
        if (
          !listenersBelongToPreview(
            pid,
            await inspectPreviewListeners(preview.port),
          )
        ) {
          return status("conflict", run, "The preview port changed ownership.");
        }
      } catch (error) {
        this.options.logger?.warn(
          {
            previewId: preview.id,
            runId: run?.runId ?? null,
            phase: "ownership-after",
            inspector:
              error instanceof PreviewInspectionError ? error.phase : "other",
            failure:
              error instanceof PreviewInspectionError ? error.failure : "other",
            exitCode:
              error instanceof PreviewInspectionError ? error.exitCode : null,
            elapsedMs:
              error instanceof PreviewInspectionError ? error.elapsedMs : null,
          },
          "Preview ownership inspection failed",
        );

        return status(
          "unknown",
          run,
          "Server process ownership could not be checked.",
        );
      }

      if (!childIsRunning(run.child)) return status("stopped", run);

      return status("online", run);
    }

    return this.unready(
      run,
      responseStatus === null
        ? null
        : `The server returned HTTP ${responseStatus}.`,
    );
  }

  private unready(
    run: PreviewRun,
    detail: string | null = null,
  ): ManagedPreviewStatus {
    return Date.now() - run.startedAt > READINESS_TIMEOUT_MS
      ? status(
          "error",
          run,
          detail ?? "The server did not become ready within 30 seconds.",
        )
      : status("starting", run, detail);
  }

  private async ensureOnce(
    preview: ManagedPreviewLaunch,
    contributedEnv: readonly HostDaemonContributedEnvEntry[],
  ): Promise<ManagedPreviewStatus> {
    if (this.closed)
      return status("error", undefined, "Preview execution is shutting down.");

    const observed = await this.probe(preview);
    const current = this.runs.get(preview.id);

    if (
      observed.state === "online" ||
      observed.state === "starting" ||
      observed.state === "conflict" ||
      observed.state === "unknown" ||
      (current !== undefined && !launchMatches(current.preview, preview))
    )
      return observed;

    if (current !== undefined && childIsRunning(current.child)) {
      let listeners: Awaited<ReturnType<typeof inspectPreviewListeners>>;

      try {
        listeners = await inspectPreviewListeners(preview.port);
      } catch {
        return status(
          "unknown",
          current,
          "Server process ownership could not be checked.",
        );
      }

      if (
        listeners.listenerPids.length > 0 &&
        (current.child.pid === undefined ||
          !listenersBelongToPreview(current.child.pid, listeners))
      ) {
        return status(
          "conflict",
          current,
          "The preview port changed ownership.",
        );
      }

      if (childIsRunning(current.child)) {
        try {
          const stopped = await createProcessStop(current.child)();

          if (stopped.treeTermination !== "confirmed") {
            return status(
              "error",
              current,
              "The owned preview process did not fully stop.",
            );
          }
        } catch {
          return status(
            "error",
            current,
            "The owned preview process could not be stopped.",
          );
        }
      }

      const stopped = await this.probe(preview);

      if (stopped.state !== "stopped" && stopped.state !== "error")
        return stopped;
    }

    if (!isAbsolute(preview.cwd) || preview.argv[0]?.length === 0) {
      return status(
        "error",
        current,
        "The registered preview command or directory is invalid.",
      );
    }

    const [command, ...args] = preview.argv;

    if (command === undefined)
      return status("error", current, "No preview command is registered.");

    let child: PreviewChild;

    try {
      const env = operationEnvironment(
        contributedEnv,
        previewBaseEnvironment(this.options.shellEnv()),
      );

      delete env.OMNYO_SERVER_URL;
      child = spawnPortableOutputProcess({
        command,
        args,
        cwd: preview.cwd,
        env,
        detached: process.platform !== "win32",
      });
    } catch {
      return status(
        "error",
        current,
        "The registered preview command could not start.",
      );
    }

    const run: PreviewRun = {
      preview,
      child,
      runId: randomUUID(),
      startedAt: Date.now(),
      failure: null,
    };

    child.stdout.resume();
    child.stderr.resume();
    child.once("error", () => {
      run.failure = "The registered preview command could not start.";
      this.releaseInactiveEnvironment(preview.id);
    });
    child.once("exit", (code) => {
      if (code !== 0 && code !== null)
        run.failure = `The preview command exited with code ${code}.`;
      this.releaseInactiveEnvironment(preview.id);
    });
    this.runs.set(preview.id, run);

    const deadline = Date.now() + (this.options.startupWaitMs ?? 8_000);
    let result: ManagedPreviewStatus;

    do {
      result = await this.probe(preview);

      if (result.state !== "starting") return result;
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
    } while (Date.now() < deadline && !this.closed);

    return result;
  }
}
