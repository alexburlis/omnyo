import { spawn } from "node:child_process";

const MACOS_LOGIN_SHELL = "/bin/zsh";

const SHELL_PATH_COMMAND = 'printf "%s" "$PATH"';

const SHELL_PATH_TIMEOUT_MS = 2_000;

const SHELL_PATH_MAX_BUFFER_BYTES = 1024 * 1024;

export interface DesktopShellPathLogger {
  warn(message: string): void;
}

export interface SpawnLoginShellPathArgs {
  command: string;
  args: string[];
  timeoutMs: number;
}

export interface ShellPathSpawnResult {
  error?: Error;
  signal: NodeJS.Signals | null;
  status: number | null;
  stderr: string;
  stdout: string;
}

export type SpawnLoginShellPath = (
  args: SpawnLoginShellPathArgs,
) => Promise<ShellPathSpawnResult>;

type EnsurePackagedUserShellPathResult =
  | ShellPathSkippedResult
  | ShellPathUpdatedResult
  | ShellPathUnchangedResult;

interface EnsurePackagedUserShellPathArgs {
  env: NodeJS.ProcessEnv;
  isPackaged: boolean;
  logger: DesktopShellPathLogger;
  platform: NodeJS.Platform;
  spawnLoginShellPath?: SpawnLoginShellPath;
}

interface ShellPathSkippedResult {
  kind: "skipped";
  reason: "not-packaged" | "unsupported-platform";
}

interface ShellPathUnchangedResult {
  kind: "unchanged";
  reason: "empty-output" | "non-zero-status" | "shell-error" | "signal";
}

interface ShellPathUpdatedResult {
  kind: "updated";
  path: string;
}

function defaultSpawnLoginShellPath(
  args: SpawnLoginShellPathArgs,
): Promise<ShellPathSpawnResult> {
  return new Promise((resolveResult) => {
    const child = spawn(args.command, args.args, {
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let outputBytes = 0;
    let error: Error | undefined;

    const timeout = setTimeout(() => {
      error = new Error(`spawn ${args.command} ETIMEDOUT`);
      child.kill("SIGKILL");
      child.stdout.destroy();
      child.stderr.destroy();
    }, args.timeoutMs);

    const append = (chunk: string, stream: "stdout" | "stderr") => {
      outputBytes += Buffer.byteLength(chunk);

      if (outputBytes > SHELL_PATH_MAX_BUFFER_BYTES) {
        error = new Error(`spawn ${args.command} ENOBUFS`);
        child.kill("SIGKILL");
        child.stdout.destroy();
        child.stderr.destroy();

        return;
      }

      if (stream === "stdout") stdout += chunk;
      else stderr += chunk;
    };

    child.stdout
      .setEncoding("utf8")
      .on("data", (chunk: string) => append(chunk, "stdout"));
    child.stderr
      .setEncoding("utf8")
      .on("data", (chunk: string) => append(chunk, "stderr"));
    child.once("error", (spawnError) => {
      error = spawnError;
    });
    child.once("close", (status, signal) => {
      clearTimeout(timeout);
      const result: ShellPathSpawnResult = { status, signal, stdout, stderr };

      if (error !== undefined) result.error = error;
      resolveResult(result);
    });
  });
}

function warnShellPathFallback(
  args: EnsurePackagedUserShellPathArgs,
  message: string,
): void {
  args.logger.warn(
    `Could not load the user shell PATH for the packaged desktop app: ${message}. Continuing with the inherited PATH.`,
  );
}

export async function ensurePackagedUserShellPath(
  args: EnsurePackagedUserShellPathArgs,
): Promise<EnsurePackagedUserShellPathResult> {
  if (args.platform !== "darwin" && args.platform !== "linux") {
    return { kind: "skipped", reason: "unsupported-platform" };
  }

  if (!args.isPackaged) {
    return { kind: "skipped", reason: "not-packaged" };
  }

  const spawnLoginShellPath =
    args.spawnLoginShellPath ?? defaultSpawnLoginShellPath;

  let result: ShellPathSpawnResult;

  try {
    result = await spawnLoginShellPath({
      args: ["-ilc", SHELL_PATH_COMMAND],
      command:
        args.platform === "darwin"
          ? MACOS_LOGIN_SHELL
          : (args.env.SHELL ?? "/bin/bash"),
      timeoutMs: SHELL_PATH_TIMEOUT_MS,
    });
  } catch (error) {
    warnShellPathFallback(
      args,
      error instanceof Error ? error.message : "shell failed",
    );

    return { kind: "unchanged", reason: "shell-error" };
  }

  if (result.error !== undefined) {
    warnShellPathFallback(args, result.error.message);

    return { kind: "unchanged", reason: "shell-error" };
  }

  if (result.signal !== null) {
    warnShellPathFallback(args, `shell exited from signal ${result.signal}`);

    return { kind: "unchanged", reason: "signal" };
  }

  if (result.status !== 0) {
    const stderr = result.stderr.trim();
    warnShellPathFallback(
      args,
      stderr.length > 0
        ? `shell exited with status ${result.status}: ${stderr}`
        : `shell exited with status ${result.status}`,
    );

    return { kind: "unchanged", reason: "non-zero-status" };
  }

  const shellPath = result.stdout.trim();

  if (shellPath.length === 0) {
    warnShellPathFallback(args, "shell returned an empty PATH");

    return { kind: "unchanged", reason: "empty-output" };
  }

  args.env.PATH = shellPath;

  return { kind: "updated", path: shellPath };
}
