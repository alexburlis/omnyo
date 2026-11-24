import { parentPort, type MessagePort } from "node:worker_threads";
import { execPortableFileInThread } from "./exec-portable-file-in-thread.js";
import {
  parseProcessLauncherRequest,
  type ProcessLauncherFailure,
  type ProcessLauncherResponse,
} from "./process-launcher-protocol.js";

function requireParentPort(): MessagePort {
  if (parentPort === null)
    throw new Error("process launcher worker needs a parent");

  return parentPort;
}

const port = requireParentPort();

const running = new Map<number, AbortController>();

function send(response: ProcessLauncherResponse): void {
  port.postMessage(response);
}

function readString(value: object, key: string): string | null {
  const field: unknown = Reflect.get(value, key);

  return typeof field === "string" ? field : null;
}

function toFailure(error: unknown): ProcessLauncherFailure {
  if (!(error instanceof Error))
    return {
      name: "Error",
      message: String(error),
      code: null,
      signal: null,
      killed: false,
      treeTermination: "confirmed",
      processGroupId: null,
      processPlatform: process.platform,
      stdout: "",
      stderr: "",
      syscall: null,
      cause: null,
    };

  const code: unknown = Reflect.get(error, "code");
  const cause: unknown = error.cause;

  return {
    name: error.name,
    message: error.message,
    code: typeof code === "string" || typeof code === "number" ? code : null,
    signal: readString(error, "signal"),
    killed: Reflect.get(error, "killed") === true,
    treeTermination:
      readString(error, "treeTermination") === "unverified"
        ? "unverified"
        : readString(error, "treeTermination") === "confirmed"
          ? "confirmed"
          : null,
    processGroupId:
      typeof Reflect.get(error, "processGroupId") === "number"
        ? Reflect.get(error, "processGroupId")
        : null,
    processPlatform: readString(error, "processPlatform"),
    stdout: readString(error, "stdout") ?? "",
    stderr: readString(error, "stderr") ?? "",
    syscall: readString(error, "syscall"),
    cause:
      cause instanceof Error
        ? { name: cause.name, message: cause.message }
        : null,
  };
}

port.on("message", (message: unknown) => {
  const request = parseProcessLauncherRequest(message);

  if (request.type === "abort") {
    running.get(request.id)?.abort();

    return;
  }

  const controller = new AbortController();
  running.set(request.id, controller);

  execPortableFileInThread(request.command, request.args, {
    cwd: request.cwd,
    env: request.env,
    maxBuffer: request.maxBuffer,
    signal: controller.signal,
    ...(request.timeout === null ? {} : { timeout: request.timeout }),
    ...(request.input === null ? {} : { input: request.input }),
    ...(request.streamStderr
      ? {
          onStderr: (chunk: string) =>
            send({ type: "stderr", id: request.id, chunk }),
        }
      : {}),
  }).then(
    (output) => {
      running.delete(request.id);
      send({ type: "succeeded", id: request.id, ...output });
    },
    (error: unknown) => {
      running.delete(request.id);
      send({ type: "failed", id: request.id, error: toFailure(error) });
    },
  );
});
