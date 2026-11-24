import { describe, expect, it } from "vitest";
import {
  ensurePackagedUserShellPath,
  type DesktopShellPathLogger,
  type ShellPathSpawnResult,
  type SpawnLoginShellPath,
  type SpawnLoginShellPathArgs,
} from "../src/desktop-shell-path.js";

interface FakeSpawn {
  calls: SpawnLoginShellPathArgs[];
  spawn: SpawnLoginShellPath;
}

interface CreateSpawnResultArgs {
  error?: Error;
  signal?: NodeJS.Signals | null;
  status?: number | null;
  stderr?: string;
  stdout?: string;
}

interface CreateFakeSpawnArgs {
  result: ShellPathSpawnResult;
}

interface WarningLogger {
  logger: DesktopShellPathLogger;
  warnings: string[];
}

function createSpawnResult(args: CreateSpawnResultArgs): ShellPathSpawnResult {
  const result: ShellPathSpawnResult = {
    signal: args.signal ?? null,
    status: args.status ?? 0,
    stderr: args.stderr ?? "",
    stdout: args.stdout ?? "",
  };

  if (args.error !== undefined) result.error = args.error;

  return result;
}

function createFakeSpawn(args: CreateFakeSpawnArgs): FakeSpawn {
  const calls: SpawnLoginShellPathArgs[] = [];

  return {
    calls,
    async spawn(spawnArgs) {
      calls.push(spawnArgs);

      return args.result;
    },
  };
}

function createWarningLogger(): WarningLogger {
  const warnings: string[] = [];

  return {
    logger: {
      warn(message) {
        warnings.push(message);
      },
    },
    warnings,
  };
}

function failIfSpawned(): SpawnLoginShellPath {
  return () => {
    throw new Error("shell spawn should not run");
  };
}

describe("desktop shell PATH loading", () => {
  it("uses the macOS login shell PATH for packaged desktop launches", async () => {
    const env: NodeJS.ProcessEnv = { PATH: "/usr/bin:/bin" };
    const shellPath = "/Users/sawyerhood/.bun/bin:/usr/bin:/bin";

    const fakeSpawn = createFakeSpawn({
      result: createSpawnResult({ stdout: shellPath }),
    });

    const warningLogger = createWarningLogger();

    const result = await ensurePackagedUserShellPath({
      env,
      isPackaged: true,
      logger: warningLogger.logger,
      platform: "darwin",
      spawnLoginShellPath: fakeSpawn.spawn,
    });

    expect(result).toEqual({ kind: "updated", path: shellPath });
    expect(env.PATH).toBe(shellPath);
    expect(warningLogger.warnings).toEqual([]);
    expect(fakeSpawn.calls).toEqual([
      {
        args: ["-ilc", 'printf "%s" "$PATH"'],
        command: "/bin/zsh",
        timeoutMs: 2_000,
      },
    ]);
  });

  it("leaves PATH alone in desktop dev mode", async () => {
    const env: NodeJS.ProcessEnv = { PATH: "/opt/homebrew/bin:/usr/bin:/bin" };
    const warningLogger = createWarningLogger();

    const result = await ensurePackagedUserShellPath({
      env,
      isPackaged: false,
      logger: warningLogger.logger,
      platform: "darwin",
      spawnLoginShellPath: failIfSpawned(),
    });

    expect(result).toEqual({ kind: "skipped", reason: "not-packaged" });
    expect(env.PATH).toBe("/opt/homebrew/bin:/usr/bin:/bin");
    expect(warningLogger.warnings).toEqual([]);
  });

  it("falls back to the inherited PATH when the shell spawn fails", async () => {
    const env: NodeJS.ProcessEnv = { PATH: "/usr/bin:/bin" };

    const fakeSpawn = createFakeSpawn({
      result: createSpawnResult({ error: new Error("spawn failed") }),
    });

    const warningLogger = createWarningLogger();

    const result = await ensurePackagedUserShellPath({
      env,
      isPackaged: true,
      logger: warningLogger.logger,
      platform: "darwin",
      spawnLoginShellPath: fakeSpawn.spawn,
    });

    expect(result).toEqual({ kind: "unchanged", reason: "shell-error" });
    expect(env.PATH).toBe("/usr/bin:/bin");
    expect(warningLogger.warnings).toEqual([
      "Could not load the user shell PATH for the packaged desktop app: spawn failed. Continuing with the inherited PATH.",
    ]);
  });

  it("falls back to the inherited PATH when shell PATH loading times out", async () => {
    const env: NodeJS.ProcessEnv = { PATH: "/usr/bin:/bin" };

    const fakeSpawn = createFakeSpawn({
      result: createSpawnResult({
        error: new Error("spawnSync /bin/zsh ETIMEDOUT"),
        signal: "SIGTERM",
      }),
    });

    const warningLogger = createWarningLogger();

    const result = await ensurePackagedUserShellPath({
      env,
      isPackaged: true,
      logger: warningLogger.logger,
      platform: "darwin",
      spawnLoginShellPath: fakeSpawn.spawn,
    });

    expect(result).toEqual({ kind: "unchanged", reason: "shell-error" });
    expect(env.PATH).toBe("/usr/bin:/bin");
    expect(warningLogger.warnings[0]).toContain("ETIMEDOUT");
  });

  it.each([
    {
      result: createSpawnResult({ signal: "SIGTERM", status: null }),
      reason: "signal",
      warning: "shell exited from signal SIGTERM",
    },
    {
      result: createSpawnResult({ status: 7, stderr: "synthetic failure\n" }),
      reason: "non-zero-status",
      warning: "shell exited with status 7: synthetic failure",
    },
    {
      result: createSpawnResult({ status: 7 }),
      reason: "non-zero-status",
      warning: "shell exited with status 7",
    },
    {
      result: createSpawnResult({ stdout: " \n" }),
      reason: "empty-output",
      warning: "shell returned an empty PATH",
    },
  ])("preserves inherited PATH after $reason", async (failure) => {
    const env: NodeJS.ProcessEnv = { PATH: "/usr/bin:/bin" };
    const warningLogger = createWarningLogger();

    const result = await ensurePackagedUserShellPath({
      env,
      isPackaged: true,
      logger: warningLogger.logger,
      platform: "darwin",
      spawnLoginShellPath: createFakeSpawn({ result: failure.result }).spawn,
    });

    expect(result).toEqual({ kind: "unchanged", reason: failure.reason });
    expect(env.PATH).toBe("/usr/bin:/bin");
    expect(warningLogger.warnings).toEqual([
      `Could not load the user shell PATH for the packaged desktop app: ${failure.warning}. Continuing with the inherited PATH.`,
    ]);
  });

  it("uses the configured Linux login shell", async () => {
    const env: NodeJS.ProcessEnv = {
      PATH: "/usr/bin:/bin",
      SHELL: "/usr/bin/fish",
    };

    const shellPath = "/home/user/.local/bin:/usr/bin:/bin";

    const fakeSpawn = createFakeSpawn({
      result: createSpawnResult({ stdout: shellPath }),
    });

    const result = await ensurePackagedUserShellPath({
      env,
      isPackaged: true,
      logger: createWarningLogger().logger,
      platform: "linux",
      spawnLoginShellPath: fakeSpawn.spawn,
    });

    expect(result).toEqual({ kind: "updated", path: shellPath });
    expect(env.PATH).toBe(shellPath);
    expect(fakeSpawn.calls).toEqual([
      {
        args: ["-ilc", 'printf "%s" "$PATH"'],
        command: "/usr/bin/fish",
        timeoutMs: 2_000,
      },
    ]);
  });

  it("falls back to bash when Linux SHELL is unset", async () => {
    const env: NodeJS.ProcessEnv = { PATH: "/usr/bin:/bin" };

    const fakeSpawn = createFakeSpawn({
      result: createSpawnResult({ stdout: "/home/user/bin:/usr/bin:/bin" }),
    });

    await ensurePackagedUserShellPath({
      env,
      isPackaged: true,
      logger: createWarningLogger().logger,
      platform: "linux",
      spawnLoginShellPath: fakeSpawn.spawn,
    });

    expect(fakeSpawn.calls[0]?.command).toBe("/bin/bash");
  });

  it("skips unsupported platforms", async () => {
    const env: NodeJS.ProcessEnv = { PATH: "C:\\Windows\\System32" };

    const result = await ensurePackagedUserShellPath({
      env,
      isPackaged: true,
      logger: createWarningLogger().logger,
      platform: "win32",
      spawnLoginShellPath: failIfSpawned(),
    });

    expect(result).toEqual({
      kind: "skipped",
      reason: "unsupported-platform",
    });
    expect(env.PATH).toBe("C:\\Windows\\System32");
  });
});
