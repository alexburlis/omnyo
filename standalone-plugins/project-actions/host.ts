import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { open } from "node:fs/promises";
import { join } from "node:path";
import { experimental_defineHostEntry } from "@omnyo/plugin-sdk";
import { clipText, hostContract, hostSignals, type Activity } from "./contract";

const STOP_GRACE_MS = 3000;

const ACTIVITY_POLL_MS = 1000;

const ACTIVITY_TAIL_BYTES = 4096;

const STEP = /^(\d{1,4})\/(\d{1,4})\s+(\S.*)$/;

function printable(text: string) {
  let result = "";

  for (const character of text) if (character >= " " && character !== "\u007f") result += character;

  return result.trim();
}

/** Reads the last non-empty line; a leading `current/total` marks a step. */
export function parseActivity(content: string): Activity | null {
  const lines = content.split(/\r\n|\r|\n/);

  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = printable(lines[index] ?? "");

    if (!line) continue;
    const step = STEP.exec(line);
    const current = Number(step?.[1]);
    const total = Number(step?.[2]);

    if (step?.[3] && current >= 1 && current <= total)
      return { text: clipText(step[3]), progress: { current, total } };

    return { text: clipText(line), progress: null };
  }

  return null;
}

async function readActivity(path: string) {
  const file = await open(path, "r");

  try {
    const { size } = await file.stat();
    const length = Math.min(size, ACTIVITY_TAIL_BYTES);
    const buffer = Buffer.alloc(length);
    await file.read(buffer, 0, length, size - length);

    return parseActivity(buffer.toString("utf8"));
  } finally {
    await file.close();
  }
}

const children = new Map<string, { child: ChildProcess; stopped: boolean }>();

function signalTree(child: ChildProcess, signal: NodeJS.Signals) {
  if (child.pid === undefined || child.exitCode !== null || child.signalCode !== null) return;

  if (process.platform === "win32") {
    spawn("taskkill", ["/T", "/F", "/PID", String(child.pid)], { stdio: "ignore" });

    return;
  }

  try {
    process.kill(-child.pid, signal);
  } catch {
    child.kill(signal);
  }
}

function terminate(child: ChildProcess) {
  signalTree(child, "SIGTERM");
  setTimeout(() => signalTree(child, "SIGKILL"), STOP_GRACE_MS).unref();
}

/** Starts argv in its own process group, with an empty file at OMNYO_ACTION_STATUS. */
function start(argv: string[], cwd: string, tempDir: string) {
  const [file, ...args] = argv;
  const statusPath = join(tempDir, `activity-${randomUUID()}`);
  mkdirSync(tempDir, { recursive: true });
  writeFileSync(statusPath, "");

  // Command output may contain credentials, so stdout and stderr are discarded.
  // Only exit metadata and lines the command writes to OMNYO_ACTION_STATUS cross RPC.
  const child = spawn(file, args, {
    cwd,
    env: { ...process.env, OMNYO_ACTION_STATUS: statusPath },
    stdio: "ignore",
    detached: process.platform !== "win32",
    windowsHide: true,
  });

  return { child, statusPath };
}

export default experimental_defineHostEntry({
  contract: hostContract,
  experimental_signals: hostSignals,
  handlers: {
    execute({ runId, action }, context) {
      return new Promise((resolve, reject) => {
        const { child, statusPath } = start(
          action.argv,
          action.cwd,
          context.experimental_paths.tempDir,
        );

        const entry = { child, stopped: false };
        children.set(runId, entry);
        let timedOut = false;

        const timer = setTimeout(() => {
          timedOut = true;
          signalTree(child, "SIGKILL");
        }, action.timeoutMs);

        let reported = "";
        let reading = false;

        const poll = setInterval(() => {
          if (reading) return;
          reading = true;
          readActivity(statusPath)
            .then(async (activity) => {
              const serialized = JSON.stringify(activity);

              if (!activity || serialized === reported) return;
              reported = serialized;

              await context
                .experimental_emitSignal("activity", { runId, ...activity })
                .catch(() => {
                  // Resend this activity on the next poll.
                  reported = "";
                });
            })
            // The command owns its status file and may delete it; keep the last activity.
            .catch(() => undefined)
            .finally(() => {
              reading = false;
            });
        }, ACTIVITY_POLL_MS);

        const abort = () => terminate(child);
        const signal = AbortSignal.any([context.signal, context.lifecycle.signal]);
        signal.addEventListener("abort", abort, { once: true });

        const settle = () => {
          clearTimeout(timer);
          clearInterval(poll);
          signal.removeEventListener("abort", abort);
          children.delete(runId);
          rmSync(statusPath, { force: true });
        };

        child.on("error", () => {
          settle();
          reject(new Error("Command could not start on the selected machine."));
        });
        child.on("close", (exitCode, exitSignal) => {
          settle();
          resolve({
            exitCode,
            signal: timedOut ? "SIGKILL" : exitSignal,
            stopped: entry.stopped,
          });
        });
      });
    },
    check({ cwd, argv, timeoutMs }, context) {
      return new Promise((resolve) => {
        const { child, statusPath } = start(argv, cwd, context.experimental_paths.tempDir);
        let timedOut = false;
        let settled = false;

        const timer = setTimeout(() => {
          timedOut = true;
          signalTree(child, "SIGKILL");
        }, timeoutMs);

        const abort = () => signalTree(child, "SIGKILL");
        const signal = AbortSignal.any([context.signal, context.lifecycle.signal]);
        signal.addEventListener("abort", abort, { once: true });

        // Node emits close after error too, so only the first of them settles.
        const settle = () => {
          if (settled) return false;
          settled = true;
          clearTimeout(timer);
          signal.removeEventListener("abort", abort);

          return true;
        };

        // The machine answered, so a check that cannot start is the saved check's fault.
        child.on("error", (error: NodeJS.ErrnoException) => {
          if (!settle()) return;
          rmSync(statusPath, { force: true });
          resolve({
            exitCode: null,
            signal: null,
            activity: null,
            startError: error.code ?? "unknown error",
          });
        });
        child.on("close", (exitCode, exitSignal) => {
          if (!settle()) return;
          void readActivity(statusPath)
            .catch(() => null)
            .then((activity) => {
              rmSync(statusPath, { force: true });
              resolve({
                exitCode,
                signal: timedOut ? "SIGKILL" : exitSignal,
                activity,
                startError: null,
              });
            });
        });
      });
    },
    stop({ runId }) {
      const entry = children.get(runId);

      if (!entry) return { stopped: false };
      entry.stopped = true;
      terminate(entry.child);

      return { stopped: true };
    },
  },
});
