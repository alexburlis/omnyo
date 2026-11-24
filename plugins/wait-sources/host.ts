import { spawn } from "node:child_process";
import { stat } from "node:fs/promises";
import { homedir } from "node:os";
import {
  experimental_defineHostEntry,
  experimental_sanitizeInheritedChildProcessEnv,
} from "@omnyo/plugin-sdk/host";
import {
  COMMAND_OUTPUT_MAX,
  COMMAND_TIMEOUT_MS,
  waitSourcesHostContract,
  type CommandRun,
  type PathFacts,
} from "./contract.js";

function isMissing(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error.code === "ENOENT" || error.code === "ENOTDIR")
  );
}

export async function statPath(path: string): Promise<PathFacts> {
  try {
    const facts = await stat(path);

    return {
      exists: true,
      kind: facts.isFile()
        ? "file"
        : facts.isDirectory()
          ? "directory"
          : "other",
      size: facts.size,
      modifiedAt: Math.round(facts.mtimeMs),
    };
  } catch (error) {
    if (isMissing(error))
      return { exists: false, kind: null, size: null, modifiedAt: null };

    throw error;
  }
}

function isGone(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ESRCH";
}

function stopTree(pid: number | undefined): void {
  if (pid === undefined) return;

  if (process.platform === "win32") {
    spawn("taskkill", ["/pid", String(pid), "/T", "/F"], {
      stdio: "ignore",
      windowsHide: true,
    });

    return;
  }

  try {
    process.kill(-pid, "SIGKILL");
  } catch (error) {
    if (!isGone(error)) throw error;
  }
}

export function runCommand(
  command: string,
  signal: AbortSignal,
  timeoutMs: number = COMMAND_TIMEOUT_MS,
): Promise<CommandRun> {
  return new Promise((resolve, reject) => {
    signal.throwIfAborted();

    const child = spawn(command, {
      shell: true,
      cwd: homedir(),
      env: experimental_sanitizeInheritedChildProcessEnv({ env: process.env }),
      stdio: ["ignore", "pipe", "ignore"],
      detached: process.platform !== "win32",
      windowsHide: true,
    });

    const chunks: Buffer[] = [];
    let captured = 0;
    let timedOut = false;

    const stop = () => stopTree(child.pid);

    const timer = setTimeout(() => {
      timedOut = true;
      stop();
    }, timeoutMs);

    signal.addEventListener("abort", stop, { once: true });
    child.stdout.on("data", (chunk: Buffer) => {
      if (captured >= COMMAND_OUTPUT_MAX) return;

      const kept = chunk.subarray(0, COMMAND_OUTPUT_MAX - captured);

      chunks.push(kept);
      captured += kept.length;
    });
    child.once("error", (error) => {
      clearTimeout(timer);
      signal.removeEventListener("abort", stop);
      reject(error);
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      signal.removeEventListener("abort", stop);
      resolve({
        exitCode: timedOut ? null : code,
        stdout: Buffer.concat(chunks).toString("utf8"),
        timedOut,
      });
    });
  });
}

export default experimental_defineHostEntry({
  contract: waitSourcesHostContract,
  handlers: {
    stat: ({ path }) => statPath(path),
    runCheck: ({ command }, context) => runCommand(command, context.signal),
  },
});
