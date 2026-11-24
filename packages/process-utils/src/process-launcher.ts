import { existsSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { SHARE_ENV, Worker } from "node:worker_threads";
import type { PortableFileRunOptions } from "./exec-portable-file-in-thread.js";
import {
  parseProcessLauncherResponse,
  type ProcessLauncherFailure,
  type ProcessLauncherRequest,
} from "./process-launcher-protocol.js";

interface PendingRun {
  resolve: (output: { stdout: string; stderr: string }) => void;
  reject: (error: Error) => void;
  onStderr: ((chunk: string) => void) | undefined;
  signal: AbortSignal | undefined;
  release: () => void;
}

const WORKER_ENTRY_CANDIDATES = [
  "./omnyo-process-launcher-worker.mjs",
  "./process-launcher-worker.js",
  "./process-launcher-worker.ts",
];

const pendingRuns = new Map<number, PendingRun>();

let enabled = false;

let worker: Worker | null = null;

let nextRunId = 0;

export function enableProcessLauncherWorker(): () => Promise<void> {
  enabled = true;
  workerEntryPath();

  return async () => {
    enabled = false;
    const owner = worker;

    if (owner !== null) await owner.terminate();
  };
}

export function processLauncherWorkerEnabled(): boolean {
  return enabled;
}

export function runInProcessLauncherWorker(
  command: string,
  args: string[],
  options: PortableFileRunOptions,
): Promise<{ stdout: string; stderr: string }> {
  const owner = worker ?? startWorker();
  const id = nextRunId++;

  const request: ProcessLauncherRequest = {
    type: "run",
    id,
    command,
    args,
    cwd: options.cwd,
    env: { ...options.env },
    maxBuffer: options.maxBuffer,
    timeout: options.timeout ?? null,
    input: options.input ?? null,
    streamStderr: options.onStderr !== undefined,
  };

  return new Promise((resolve, reject) => {
    const signal = options.signal;
    const onAbort = (): void => owner.postMessage({ type: "abort", id });
    signal?.addEventListener("abort", onAbort, { once: true });

    pendingRuns.set(id, {
      resolve,
      reject,
      onStderr: options.onStderr,
      signal,
      release: () => signal?.removeEventListener("abort", onAbort),
    });
    owner.ref();
    owner.postMessage(request);
  });
}

function startWorker(): Worker {
  const created = createWorker(workerEntryPath());
  worker = created;

  created.on("message", (message: unknown) => {
    const response = parseProcessLauncherResponse(message);

    if (response === null) {
      retire(created, new Error("it sent an invalid response"));
      void created.terminate();

      return;
    }

    const pending = pendingRuns.get(response.id);

    if (pending === undefined) return;

    if (response.type === "stderr") {
      pending.onStderr?.(response.chunk);

      return;
    }

    pendingRuns.delete(response.id);
    pending.release();

    if (pendingRuns.size === 0) created.unref();

    if (response.type === "succeeded") {
      pending.resolve({ stdout: response.stdout, stderr: response.stderr });

      return;
    }

    pending.reject(toError(response.error, pending.signal));
  });

  created.on("error", (error) => retire(created, error));
  created.on("exit", (exitCode) =>
    retire(created, new Error(`it exited with code ${exitCode}`)),
  );

  return created;
}

function toError(
  failure: ProcessLauncherFailure,
  signal: AbortSignal | undefined,
): Error {
  const cause =
    failure.name === "AbortError" && signal?.aborted
      ? signal.reason
      : failure.cause === null
        ? undefined
        : Object.assign(new Error(failure.cause.message), {
            name: failure.cause.name,
          });

  return Object.assign(new Error(failure.message, { cause }), {
    name: failure.name,
    code: failure.code,
    signal: failure.signal,
    killed: failure.killed,
    treeTermination: failure.treeTermination,
    processGroupId: failure.processGroupId,
    processPlatform: failure.processPlatform,
    stdout: failure.stdout,
    stderr: failure.stderr,
    ...(failure.syscall === null ? {} : { syscall: failure.syscall }),
  });
}

function retire(owner: Worker, cause: Error): void {
  if (worker !== owner) return;

  worker = null;

  const error = Object.assign(
    new Error(`Process launcher worker stopped: ${cause.message}`, { cause }),
    { treeTermination: "unverified" },
  );

  for (const pending of pendingRuns.values()) {
    pending.release();
    pending.reject(error);
  }

  pendingRuns.clear();
}

function createWorker(entryPath: string): Worker {
  if (!entryPath.endsWith(".ts")) {
    return new Worker(entryPath, { execArgv: [], env: SHARE_ENV });
  }

  const api = import.meta.resolve("tsx/esm/api");
  const entry = pathToFileURL(entryPath).href;
  const bootstrap = `(async()=>{const{register}=await import(${JSON.stringify(api)});register();await import(${JSON.stringify(entry)});})();`;

  return new Worker(bootstrap, {
    eval: true,
    execArgv: ["--conditions=source"],
    env: SHARE_ENV,
  });
}

function workerEntryPath(): string {
  for (const candidate of WORKER_ENTRY_CANDIDATES) {
    const candidatePath = fileURLToPath(new URL(candidate, import.meta.url));

    if (existsSync(candidatePath)) return candidatePath;
  }

  throw new Error(
    `process launcher worker entry not found beside ${fileURLToPath(import.meta.url)} (looked for ${WORKER_ENTRY_CANDIDATES.join(", ")})`,
  );
}
