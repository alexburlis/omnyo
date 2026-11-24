import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { WINDOWS_HOST_JOB_SCRIPT } from "./windows-host-job-script.js";

export interface WindowsHostJobStatus {
  active: number;
  adoptedDescendants: number;
  jobMemoryLimitBytes: number;
  peakJobMemoryBytes: number;
  pids: number[];
  unadoptable: number;
}

export interface WindowsHostJob {
  adopt(pid: number): Promise<void>;
  close(): void;
  readonly closed: Promise<void>;
  status(): Promise<WindowsHostJobStatus>;
  terminate(): Promise<number>;
}

interface StartWindowsHostJobOptions {
  memoryLimitBytes: number;
  readyTimeoutMs?: number;
  requestTimeoutMs?: number;
}

type HelperMessage =
  | { type: "ready" }
  | { type: "adopted"; pid: number }
  | { type: "error"; pid?: number; code: number }
  | { type: "terminated"; count: number }
  | ({ type: "status" } & WindowsHostJobStatus);

function parseHelperMessage(line: string): HelperMessage {
  const value: unknown = JSON.parse(line);

  if (
    typeof value !== "object" ||
    value === null ||
    !("type" in value) ||
    typeof value.type !== "string"
  ) {
    throw new Error("Windows host job helper sent an invalid message");
  }

  return value as HelperMessage;
}

export async function startWindowsHostJob(
  options: StartWindowsHostJobOptions,
): Promise<WindowsHostJob> {
  const directory = await mkdtemp(path.join(tmpdir(), "omnyo-host-job-"));
  const scriptPath = path.join(directory, "host-job.ps1");

  await writeFile(scriptPath, WINDOWS_HOST_JOB_SCRIPT, "utf8");

  const helper: ChildProcessWithoutNullStreams = spawn(
    path.join(
      process.env.SystemRoot ?? "C:\\Windows",
      "System32",
      "WindowsPowerShell",
      "v1.0",
      "powershell.exe",
    ),
    [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      scriptPath,
      "-MemoryLimitBytes",
      String(Math.max(0, Math.floor(options.memoryLimitBytes))),
    ],
    { stdio: ["pipe", "pipe", "pipe"], windowsHide: true },
  );

  let stderrTail = "";

  const waiters: Array<{
    resolve: (message: HelperMessage) => void;
    reject: (error: Error) => void;
  }> = [];

  let failure: Error | undefined;
  let queue = Promise.resolve();

  const fail = (error: Error): void => {
    failure ??= error;

    for (const waiter of waiters.splice(0)) waiter.reject(failure);
  };

  const closed = new Promise<void>((resolve) => {
    helper.once("close", (code, signal) => {
      fail(
        new Error(
          `Windows host job helper exited (${code ?? signal ?? "unknown"})` +
            (stderrTail.trim() ? `: ${stderrTail.trim().slice(-500)}` : ""),
        ),
      );
      void rm(directory, { recursive: true, force: true });
      resolve();
    });
  });

  helper.once("error", (error) => fail(error));
  helper.stdin.on("error", () => undefined);
  helper.stderr.on("data", (chunk: Buffer) => {
    stderrTail = (stderrTail + chunk.toString("utf8")).slice(-4_000);
  });
  createInterface({ input: helper.stdout }).on("line", (line) => {
    let message: HelperMessage;

    try {
      message = parseHelperMessage(line);
    } catch (error) {
      fail(error instanceof Error ? error : new Error(String(error)));
      helper.kill();

      return;
    }

    waiters.shift()?.resolve(message);
  });

  const nextMessage = (timeoutMs: number): Promise<HelperMessage> => {
    if (failure !== undefined) return Promise.reject(failure);

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const error = new Error("Windows host job helper did not respond");

        fail(error);
        helper.kill();
        reject(error);
      }, timeoutMs);

      waiters.push({
        resolve: (message) => {
          clearTimeout(timer);
          resolve(message);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
    });
  };

  const requestTimeoutMs = options.requestTimeoutMs ?? 10_000;

  const request = (command: string): Promise<HelperMessage> => {
    const result = queue.then(() => {
      const response = nextMessage(requestTimeoutMs);

      helper.stdin.write(`${command}\n`);

      return response;
    });

    queue = result.then(
      () => undefined,
      () => undefined,
    );

    return result;
  };

  const ready = await nextMessage(options.readyTimeoutMs ?? 60_000).catch(
    (error: unknown) => {
      helper.kill();
      throw error;
    },
  );

  if (ready.type !== "ready") {
    helper.kill();
    throw new Error("Windows host job helper did not start");
  }

  return {
    async adopt(pid) {
      const message = await request(`adopt ${pid}`);

      if (message.type !== "adopted" || message.pid !== pid) {
        const code = message.type === "error" ? message.code : "unexpected";

        throw new Error(
          `Could not place process ${pid} in the Omnyo host job (${code})`,
        );
      }
    },
    close() {
      helper.stdin.end();
    },
    closed,
    async status() {
      const message = await request("status");

      if (message.type !== "status") {
        throw new Error("Windows host job helper status failed");
      }

      const { type: _type, ...status } = message;

      return status;
    },
    async terminate() {
      const message = await request("terminate");

      if (message.type !== "terminated") {
        throw new Error("Could not end the Omnyo host job's processes");
      }

      return message.count;
    },
  };
}
