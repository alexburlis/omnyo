import { spawn, type ChildProcess } from "node:child_process";
import { posix as posixPath } from "node:path";
import {
  hasProcessExited,
  waitForProcessExit,
  waitForProcessExitWithTimeout,
  type ChildProcessExitResult,
} from "@omnyo/config/child-process-exit";

interface RuntimeLogBuffer {
  append(chunk: Buffer | string): void;
  text(): string;
}

interface CreateRuntimeLogBufferArgs {
  maxLines: number;
}

interface StartOmnyoAppProcessArgs {
  bridgePath: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
  logLineLimit: number;
  runtime: OmnyoAppProcessRuntime;
}

export interface OmnyoAppProcess {
  childProcess: ChildProcess;
  exit: Promise<OmnyoAppProcessExit>;
  logs: RuntimeLogBuffer;
  pid: number;
  stop(args: StopOmnyoAppProcessArgs): Promise<void>;
}

export type OmnyoAppProcessExit = ChildProcessExitResult;

type StopOmnyoAppProcessArgs =
  | {
      mode: "graceful-only";
      signal: "SIGTERM";
      timeoutMs: number;
    }
  | {
      mode?: "escalating";
      killSignal: NodeJS.Signals;
      killTimeoutMs: number;
      signal: NodeJS.Signals;
      timeoutMs: number;
    };

type OmnyoAppProcessRuntimeMode = "electron-node" | "node";

interface DirectOmnyoAppProcessRuntime {
  executablePath: string;
  kind: "direct";
  mode: OmnyoAppProcessRuntimeMode;
}

interface AppImageOmnyoAppProcessRuntime {
  appDirPath: string;
  executablePath: string;
  kind: "appimage";
  mode: "electron-node";
}

type OmnyoAppProcessRuntime =
  | AppImageOmnyoAppProcessRuntime
  | DirectOmnyoAppProcessRuntime;

interface CreateOmnyoAppProcessLaunchArgs {
  bridgePath: string;
  env: NodeJS.ProcessEnv;
  runtime: OmnyoAppProcessRuntime;
}

interface OmnyoAppProcessLaunch {
  args: string[];
  env: NodeJS.ProcessEnv;
  executablePath: string;
}

interface CreateOmnyoAppProcessEnvArgs {
  env: NodeJS.ProcessEnv;
  runtimeMode: OmnyoAppProcessRuntimeMode;
}

interface ResolveOmnyoAppProcessRuntimeArgs {
  env: NodeJS.ProcessEnv;
  isPackaged: boolean;
  platform: NodeJS.Platform;
  processExecPath: string;
}

const APPIMAGE_BRIDGE_RELATIVE_PATH_ENV =
  "OMNYO_DESKTOP_APPIMAGE_BRIDGE_RELATIVE_PATH";

async function runAppImageBridgeSupervisor(
  bridgeRelativePathEnv: string,
): Promise<void> {
  const { spawn: spawnChild } = process.getBuiltinModule("node:child_process");
  const { readdirSync, readFileSync } = process.getBuiltinModule("node:fs");
  const { resolve: resolvePath } = process.getBuiltinModule("node:path");
  const appDirPath = process.env.APPDIR;
  const bridgeRelativePath = process.env[bridgeRelativePathEnv];

  if (!appDirPath || !bridgeRelativePath) {
    throw new Error("AppImage bridge bootstrap environment is incomplete");
  }

  const bridgePath = resolvePath(appDirPath, bridgeRelativePath);

  const bridgeProcess = spawnChild(process.execPath, [bridgePath], {
    env: process.env,
    stdio: "inherit",
  });

  if (bridgeProcess.pid === undefined) {
    throw new Error("AppImage bridge process did not expose a PID");
  }

  const supervisorPid = process.pid;
  let terminationSignal: NodeJS.Signals | null = null;
  let killTimer: ReturnType<typeof setTimeout> | null = null;

  const signalBridgeGroup = (signal: NodeJS.Signals | 0): boolean => {
    try {
      process.kill(-supervisorPid, signal);

      return true;
    } catch (error) {
      if (
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        error.code === "ESRCH"
      ) {
        return false;
      }

      throw error;
    }
  };

  const bridgeGroupHasLiveDescendants = (): boolean => {
    for (const entry of readdirSync("/proc", { withFileTypes: true })) {
      if (!entry.isDirectory() || !/^\d+$/u.test(entry.name)) {
        continue;
      }

      const pid = Number(entry.name);

      if (pid === supervisorPid) {
        continue;
      }

      try {
        const stat = readFileSync(`/proc/${entry.name}/stat`, "utf8");
        const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
        const state = fields[0];
        const processGroupId = Number(fields[2]);

        if (state !== "Z" && processGroupId === supervisorPid) {
          return true;
        }
      } catch (error) {
        if (
          typeof error === "object" &&
          error !== null &&
          "code" in error &&
          (error.code === "ENOENT" || error.code === "ESRCH")
        ) {
          continue;
        }

        throw error;
      }
    }

    return false;
  };

  const beginTermination = (signal: NodeJS.Signals): void => {
    if (terminationSignal !== null) {
      return;
    }

    terminationSignal = signal;
    signalBridgeGroup(signal);
    killTimer = setTimeout(() => signalBridgeGroup("SIGKILL"), 4_000);
  };

  process.on("SIGINT", () => beginTermination("SIGINT"));
  process.on("SIGTERM", () => beginTermination("SIGTERM"));

  const bridgeExitCode = await new Promise<number | null>(
    (resolveExit, rejectExit) => {
      bridgeProcess.once("error", rejectExit);
      bridgeProcess.once("exit", (code) => resolveExit(code));
    },
  );

  while (bridgeGroupHasLiveDescendants()) {
    await new Promise<void>((resolveDelay) => {
      setTimeout(resolveDelay, 100);
    });
  }

  if (killTimer !== null) {
    clearTimeout(killTimer);
  }

  if (terminationSignal === null) {
    process.exitCode = bridgeExitCode ?? 1;
  }
}

const APPIMAGE_BRIDGE_BOOTSTRAP = `await (${runAppImageBridgeSupervisor.toString()})(${JSON.stringify(APPIMAGE_BRIDGE_RELATIVE_PATH_ENV)});`;

function createRuntimeLogBuffer(
  args: CreateRuntimeLogBufferArgs,
): RuntimeLogBuffer {
  const lines: string[] = [];

  return {
    append(chunk) {
      const text = Buffer.isBuffer(chunk) ? chunk.toString("utf8") : chunk;

      for (const line of text.split(/\r?\n/u)) {
        if (line.length === 0) {
          continue;
        }

        lines.push(line);
      }

      while (lines.length > args.maxLines) {
        lines.shift();
      }
    },
    text() {
      return lines.join("\n");
    },
  };
}

export function createOmnyoAppProcessEnv(
  args: CreateOmnyoAppProcessEnvArgs,
): NodeJS.ProcessEnv {
  if (args.runtimeMode === "electron-node") {
    return { ...args.env, ELECTRON_RUN_AS_NODE: "1" };
  }

  const env = { ...args.env };
  delete env.ELECTRON_RUN_AS_NODE;

  return env;
}

export function resolveOmnyoAppProcessRuntime(
  args: ResolveOmnyoAppProcessRuntimeArgs,
): OmnyoAppProcessRuntime {
  if (args.isPackaged) {
    const appImagePath = args.env.APPIMAGE?.trim();
    const appDirPath = args.env.APPDIR?.trim();

    if (
      args.platform === "linux" &&
      appImagePath !== undefined &&
      appImagePath.length > 0 &&
      appDirPath !== undefined &&
      appDirPath.length > 0
    ) {
      return {
        appDirPath,
        executablePath: appImagePath,
        kind: "appimage",
        mode: "electron-node",
      };
    }

    return {
      executablePath: args.processExecPath,
      kind: "direct",
      mode: "electron-node",
    };
  }

  const rawNodeExecPath = args.env.OMNYO_DESKTOP_NODE_EXEC_PATH?.trim();

  if (rawNodeExecPath === undefined || rawNodeExecPath.length === 0) {
    throw new Error(
      "OMNYO_DESKTOP_NODE_EXEC_PATH is required in desktop dev mode. Launch through apps/desktop/scripts/run-electron-dev.mjs.",
    );
  }

  return {
    executablePath: rawNodeExecPath,
    kind: "direct",
    mode: "node",
  };
}

export function createOmnyoAppProcessLaunch(
  args: CreateOmnyoAppProcessLaunchArgs,
): OmnyoAppProcessLaunch {
  const env = createOmnyoAppProcessEnv({
    env: args.env,
    runtimeMode: args.runtime.mode,
  });

  if (args.runtime.kind === "direct") {
    return {
      args: [args.bridgePath],
      env,
      executablePath: args.runtime.executablePath,
    };
  }

  const bridgeRelativePath = posixPath.relative(
    args.runtime.appDirPath,
    args.bridgePath,
  );

  if (
    bridgeRelativePath.length === 0 ||
    posixPath.isAbsolute(bridgeRelativePath) ||
    bridgeRelativePath === ".." ||
    bridgeRelativePath.startsWith("../")
  ) {
    throw new Error("Omnyo app bridge path must be inside the AppImage mount");
  }

  return {
    args: [
      "--input-type=module",
      "--eval",
      APPIMAGE_BRIDGE_BOOTSTRAP,
      "--",
      args.bridgePath,
      "--no-sandbox",
    ],
    env: {
      ...env,
      [APPIMAGE_BRIDGE_RELATIVE_PATH_ENV]: bridgeRelativePath,
    },
    executablePath: args.runtime.executablePath,
  };
}

export function startOmnyoAppProcess(
  args: StartOmnyoAppProcessArgs,
): OmnyoAppProcess {
  const logs = createRuntimeLogBuffer({ maxLines: args.logLineLimit });

  const launch = createOmnyoAppProcessLaunch({
    bridgePath: args.bridgePath,
    env: args.env,
    runtime: args.runtime,
  });

  const childProcess = spawn(launch.executablePath, launch.args, {
    cwd: args.cwd,
    detached: args.runtime.kind === "appimage",
    env: launch.env,
    stdio: ["ignore", "pipe", "pipe"],
  });

  const pid = childProcess.pid;

  if (pid === undefined) {
    throw new Error("Omnyo app child process did not expose a PID");
  }

  if (childProcess.stdout !== null) {
    childProcess.stdout.on("data", (chunk: Buffer) => {
      logs.append(chunk);
    });
  }

  if (childProcess.stderr !== null) {
    childProcess.stderr.on("data", (chunk: Buffer) => {
      logs.append(chunk);
    });
  }

  const exit = waitForProcessExit(childProcess);
  let gracefulStopRequested = false;

  return {
    childProcess,
    exit,
    logs,
    pid,
    async stop(stopArgs) {
      if (hasProcessExited(childProcess)) {
        return;
      }

      if (stopArgs.mode === "graceful-only") {
        if (process.platform === "win32")
          throw new Error(
            "Graceful desktop identity shutdown requires the Windows runtime control owner; no termination was sent",
          );

        if (!gracefulStopRequested) {
          gracefulStopRequested = true;
          childProcess.kill(stopArgs.signal);
        }

        const result = await waitForProcessExitWithTimeout({
          childProcess,
          timeoutMs: stopArgs.timeoutMs,
        });

        if (result !== "exited")
          throw new Error(
            "Desktop identity shutdown is unconfirmed; retain its owner without replay or escalation",
          );

        return;
      }

      childProcess.kill(stopArgs.signal);

      const gracefulResult = await waitForProcessExitWithTimeout({
        childProcess,
        timeoutMs: stopArgs.timeoutMs,
      });

      if (gracefulResult === "exited") {
        return;
      }

      if (!hasProcessExited(childProcess)) {
        childProcess.kill(stopArgs.killSignal);
      }

      await waitForProcessExitWithTimeout({
        childProcess,
        timeoutMs: stopArgs.killTimeoutMs,
      });
    },
  };
}
