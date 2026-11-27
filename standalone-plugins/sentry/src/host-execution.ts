import { spawn } from "node:child_process";
import type { CheckReceipt } from "./repair-result-contract";

export type Execution = {
  exitCode: number | null;
  output: string;
  durationMs: number;
  outputBytes: number;
  signal?: NodeJS.Signals;
  termination?: NonNullable<CheckReceipt["termination"]>;
};

function childEnvironment() {
  const result: NodeJS.ProcessEnv = {
    GIT_TERMINAL_PROMPT: "0",
    GH_PROMPT_DISABLED: "1",
    GCM_INTERACTIVE: "never",
  };

  for (const key of [
    "PATH",
    "HOME",
    "USER",
    "LOGNAME",
    "TMPDIR",
    "LANG",
    "LC_ALL",
    "SSH_AUTH_SOCK",
    "SystemRoot",
    "USERPROFILE",
    "APPDATA",
    "LOCALAPPDATA",
    "PATHEXT",
  ]) {
    if (process.env[key]) result[key] = process.env[key];
  }

  return result;
}

export async function execute(
  command: string,
  args: string[],
  cwd: string,
  timeoutMs: number,
  capture: boolean,
  signal?: AbortSignal,
): Promise<Execution> {
  signal?.throwIfAborted();
  const started = Date.now();

  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, {
      cwd,
      env: childEnvironment(),
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
    });

    let output = "";
    let bytes = 0;
    let termination: Execution["termination"];
    let grace: ReturnType<typeof setTimeout> | undefined;

    const stop = (reason: NonNullable<Execution["termination"]>) => {
      if (termination) return;
      termination = reason;

      try {
        if (child.pid && process.platform !== "win32") process.kill(-child.pid, "SIGTERM");
        else child.kill("SIGTERM");
      } catch {}

      grace = setTimeout(() => {
        try {
          if (child.pid && process.platform !== "win32") process.kill(-child.pid, "SIGKILL");
          else child.kill("SIGKILL");
        } catch {}
      }, 1500);
      grace.unref();
    };

    const abort = () => stop("cancelled");
    const timer = setTimeout(() => stop("timeout"), timeoutMs);

    const collect = (data: Buffer) => {
      bytes += data.byteLength;

      if (capture && bytes > 4 * 1024 * 1024) {
        stop("output-limit");

        return;
      }

      if (capture) output += data.toString("utf8");
    };

    child.stdout.on("data", collect);
    child.stderr.on("data", collect);
    signal?.addEventListener("abort", abort, { once: true });

    if (signal?.aborted) abort();
    child.on("error", () => {
      termination ??= "spawn-error";
    });
    child.on("close", (code, childSignal) => {
      clearTimeout(timer);

      if (grace) clearTimeout(grace);
      signal?.removeEventListener("abort", abort);

      if (capture && termination) {
        reject(
          new Error(
            termination === "spawn-error"
              ? "Required local executable is unavailable: " + command
              : "Local operation was cancelled, timed out, or exceeded its output bound",
          ),
        );

        return;
      }

      const result: Execution = {
        exitCode: termination === "spawn-error" ? null : code,
        output,
        durationMs: Date.now() - started,
        outputBytes: bytes,
      };

      if (childSignal) result.signal = childSignal;

      if (termination) result.termination = termination;
      resolvePromise(result);
    });
  });
}
