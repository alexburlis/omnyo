import { spawn, type ChildProcess } from "node:child_process";
import { closeSync, mkdirSync, openSync, renameSync, statSync } from "node:fs";
import { join } from "node:path";

const MAX_STDIO_LOG_BYTES_AT_SPAWN = 10 * 1024 * 1024;

interface SpawnLoggedProcessArgs {
  args: string[];
  command: string;
  env: NodeJS.ProcessEnv;
  ipc?: boolean;
  logDir: string;
  logName: "server" | "host-daemon";
  qosClamp?: "utility";
}

const TASKPOLICY_PATH = "/usr/sbin/taskpolicy";

export function managedProcessQosClamp(
  processName: "server" | "daemon",
): SpawnLoggedProcessArgs["qosClamp"] {
  return processName === "daemon" ? "utility" : undefined;
}

export function resolveLoggedProcessLaunch(
  args: Pick<SpawnLoggedProcessArgs, "args" | "command" | "qosClamp">,
  platform: NodeJS.Platform = process.platform,
): { args: string[]; command: string } {
  return args.qosClamp !== undefined && platform === "darwin"
    ? {
        command: TASKPOLICY_PATH,
        args: ["-c", args.qosClamp, args.command, ...args.args],
      }
    : { command: args.command, args: args.args };
}

export function spawnLoggedProcess(args: SpawnLoggedProcessArgs): ChildProcess {
  mkdirSync(args.logDir, { recursive: true });
  const logPath = join(args.logDir, `${args.logName}-stdio.log`);

  if (
    (statSync(logPath, { throwIfNoEntry: false })?.size ?? 0) >
    MAX_STDIO_LOG_BYTES_AT_SPAWN
  ) {
    renameSync(logPath, join(args.logDir, `${args.logName}-stdio.1.log`));
  }

  const fd = openSync(logPath, "a", 0o600);

  const launch = resolveLoggedProcessLaunch(args);

  try {
    return spawn(launch.command, launch.args, {
      cwd: process.cwd(),
      env: args.env,
      stdio: args.ipc === true ? ["ignore", fd, fd, "ipc"] : ["ignore", fd, fd],
    });
  } finally {
    closeSync(fd);
  }
}
