import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { WINDOWS_DIRECTORY_PROCESS_SCRIPT } from "./windows-directory-process-script.js";

export type DirectoryProcessInspection =
  | { kind: "idle" }
  | { kind: "busy"; message: string }
  | { kind: "unknown"; message: string };

export type DirectoryProcessInspector = (
  directory: string,
  signal?: AbortSignal,
) => Promise<DirectoryProcessInspection>;

const MAX_OUTPUT_BYTES = 8 * 1024 * 1024;

const INSPECTION_TIMEOUT_MS = 5000;

function isInside(directory: string, candidate: string) {
  const normalized = candidate.endsWith(" (deleted)")
    ? candidate.slice(0, -10)
    : candidate;

  return (
    normalized === directory || normalized.startsWith(`${directory}${path.sep}`)
  );
}

export function parseDirectoryLsof(
  output: Buffer,
  directory: string,
): DirectoryProcessInspection {
  if (
    output.length === 0 ||
    output.length > MAX_OUTPUT_BYTES ||
    !output.subarray(-2).equals(Buffer.from([0, 10]))
  )
    return {
      kind: "unknown",
      message: "The native process table was empty, incomplete or oversized.",
    };
  let pid: string | null = null;
  let descriptor = false;
  let sawName = false;
  const names: string[] = [];

  for (const raw of output.toString("utf8").split("\0")) {
    const field = raw.replace(/^\n/, "");

    if (field === "") continue;

    if (/^p[0-9]+$/.test(field)) {
      pid = field.slice(1);
      descriptor = false;
    } else if (field.startsWith("f") && field.length > 1 && pid !== null) {
      descriptor = true;
    } else if (field.startsWith("n") && pid !== null && descriptor) {
      sawName = true;

      if (isInside(directory, field.slice(1))) names.push(pid);
    } else
      return {
        kind: "unknown",
        message: "The native process table contained a malformed field.",
      };
  }

  if (!sawName)
    return {
      kind: "unknown",
      message: "The native process table contained no file names.",
    };

  return names.length
    ? {
        kind: "busy",
        message: `A current-user process is using this allocation (${[...new Set(names)].join(", ")}).`,
      }
    : { kind: "idle" };
}

async function inspectMac(
  directory: string,
  signal?: AbortSignal,
): Promise<DirectoryProcessInspection> {
  const uid = process.getuid?.();

  if (uid === undefined)
    return {
      kind: "unknown",
      message: "The current user identity is unavailable.",
    };

  return new Promise((resolve) => {
    const child = spawn(
      "/usr/sbin/lsof",
      ["-nP", "-u", String(uid), "-F0pfn"],
      { stdio: ["ignore", "pipe", "pipe"] },
    );

    const output: Buffer[] = [];
    let size = 0;
    let warning = false;
    let failure: string | null = null;

    const stop = (message: string) => {
      failure = message;
      child.kill();
    };

    const timeout = setTimeout(
      () => stop("Native process inspection timed out."),
      INSPECTION_TIMEOUT_MS,
    );

    const abort = () => stop("Native process inspection was cancelled.");
    signal?.addEventListener("abort", abort, { once: true });

    if (signal?.aborted) abort();
    child.stdout.on("data", (chunk: Buffer) => {
      size += chunk.length;

      if (size > MAX_OUTPUT_BYTES)
        stop("The native process table exceeded its bounded output size.");
      else output.push(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      if (chunk.length) warning = true;
    });
    child.on("error", () => {
      failure = "Native process inspection could not start.";
    });
    child.on("close", (code) => {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", abort);

      if (failure || warning || code !== 0)
        resolve({
          kind: "unknown",
          message:
            failure ?? "Native process inspection returned warnings or failed.",
        });
      else resolve(parseDirectoryLsof(Buffer.concat(output), directory));
    });
  });
}

function vanished(error: unknown) {
  return (
    error instanceof Error &&
    "code" in error &&
    (error.code === "ENOENT" || error.code === "ESRCH")
  );
}

async function inspectLinux(
  directory: string,
  signal?: AbortSignal,
): Promise<DirectoryProcessInspection> {
  const uid = process.getuid?.();

  if (uid === undefined)
    return {
      kind: "unknown",
      message: "The current user identity is unavailable.",
    };
  const started = Date.now();
  let inspected = 0;

  try {
    for (const name of await fs.readdir("/proc")) {
      signal?.throwIfAborted();

      if (!/^\d+$/.test(name)) continue;

      if (Date.now() - started > INSPECTION_TIMEOUT_MS || ++inspected > 100000)
        return {
          kind: "unknown",
          message: "Native process inspection exceeded its bound.",
        };
      const processPath = path.join("/proc", name);

      try {
        if ((await fs.stat(processPath)).uid !== uid) continue;
        const targets = [path.join(processPath, "cwd")];

        for (const fd of await fs.readdir(path.join(processPath, "fd")))
          targets.push(path.join(processPath, "fd", fd));

        for (const target of targets) {
          signal?.throwIfAborted();

          if (
            Date.now() - started > INSPECTION_TIMEOUT_MS ||
            ++inspected > 100000
          )
            return {
              kind: "unknown",
              message: "Native process inspection exceeded its bound.",
            };

          try {
            if (isInside(directory, await fs.readlink(target)))
              return {
                kind: "busy",
                message: `A current-user process is using this allocation (${name}).`,
              };
          } catch (error) {
            if (!vanished(error)) throw error;
          }
        }
      } catch (error) {
        if (!vanished(error)) throw error;
      }
    }

    return { kind: "idle" };
  } catch {
    return {
      kind: "unknown",
      message:
        "The current-user process table could not be inspected completely.",
    };
  }
}

async function inspectWindows(
  directory: string,
  signal?: AbortSignal,
): Promise<DirectoryProcessInspection> {
  return new Promise((resolve) => {
    const child = spawn(
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
        "-EncodedCommand",
        Buffer.from(WINDOWS_DIRECTORY_PROCESS_SCRIPT, "utf16le").toString(
          "base64",
        ),
      ],
      { stdio: ["pipe", "pipe", "pipe"], windowsHide: true },
    );

    let output = "";
    let failed = false;

    const stop = () => {
      failed = true;
      child.kill();
    };

    const timeout = setTimeout(stop, INSPECTION_TIMEOUT_MS);
    signal?.addEventListener("abort", stop, { once: true });

    if (signal?.aborted) stop();
    child.stdin.on("error", stop);
    child.stdin.end(directory);
    child.stdout.on("data", (chunk: Buffer) => {
      output += chunk.toString("utf8");

      if (output.length > 1024) stop();
    });
    child.stderr.on("data", stop);
    child.on("error", stop);
    child.on("close", (code) => {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", stop);
      const result = output.trim();

      if (!failed && code === 0 && result === "idle") resolve({ kind: "idle" });
      else if (!failed && code === 0 && result === "busy")
        resolve({
          kind: "busy",
          message: "A process is using this allocation.",
        });
      else
        resolve({
          kind: "unknown",
          message:
            "Native allocation inspection was incomplete or unavailable.",
        });
    });
  });
}

export const inspectDirectoryProcesses: DirectoryProcessInspector = (
  directory,
  signal,
) => {
  if (process.platform === "darwin") return inspectMac(directory, signal);

  if (process.platform === "linux") return inspectLinux(directory, signal);

  if (process.platform === "win32") return inspectWindows(directory, signal);

  return Promise.resolve({
    kind: "unknown",
    message:
      "Complete native process inspection is unsupported on this platform; physical cleanup is held.",
  });
};
