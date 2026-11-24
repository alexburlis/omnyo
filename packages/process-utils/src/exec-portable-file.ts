import {
  runVcsProcess,
  type VcsProcessPriority,
} from "./vcs-process-scheduler.js";
import { basename } from "node:path";
import {
  execPortableFileInThread,
  type PortableFileRunOptions,
} from "./exec-portable-file-in-thread.js";
import {
  processLauncherWorkerEnabled,
  runInProcessLauncherWorker,
} from "./process-launcher.js";

interface ExecPortableFileOptions extends PortableFileRunOptions {
  priority?: VcsProcessPriority;
}

export async function execPortableFile(
  command: string,
  args: string[],
  options: ExecPortableFileOptions,
): Promise<{ stdout: string; stderr: string }> {
  const executable = basename(command)
    .toLowerCase()
    .replace(/\.(exe|cmd|bat)$/u, "");

  if (executable === "git" || executable === "gh") {
    return runVcsProcess(
      executable,
      args,
      () => execPortableFileUnbounded(command, args, options),
      {
        priority: options.priority,
        signal: options.signal,
      },
    );
  }

  return execPortableFileUnbounded(command, args, options);
}

async function execPortableFileUnbounded(
  command: string,
  args: string[],
  options: PortableFileRunOptions,
): Promise<{ stdout: string; stderr: string }> {
  if (options.signal?.aborted) throw options.signal.reason;

  return processLauncherWorkerEnabled()
    ? runInProcessLauncherWorker(command, args, options)
    : execPortableFileInThread(command, args, options);
}
