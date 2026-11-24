import { join } from "node:path";
import semver from "semver";
import {
  APP_UPDATE_RESTART_EXIT_CODE,
  AppUpdateStateUnreadableError,
  formatAppUpdateStatePath,
  readAppUpdateBootstrapStateFile,
  type AppUpdateBootstrapState,
  type InstalledNpmAppRevision,
  type NpmAppRevision,
} from "@omnyo/config/app-update";
import type { ChildProcessExitResult } from "@omnyo/config/child-process-exit";
import { isUsableNpmRevision } from "./npm-revision.js";
import {
  acquireShimLock,
  createLauncherEnv,
  installShimSignalForwarding,
  spawnLauncherProcess,
  toShimExitCode,
  type AcquireShimLock,
  type LauncherRun,
  type LauncherUpdateMode,
  type ShimOutput,
  type ShimLock,
} from "./shim-support.js";

export interface RunNpmShimArgs {
  acquireLock?: AcquireShimLock;
  bundled: NpmAppRevision;
  dataDir: string;
  isUsable?: (revision: NpmAppRevision) => boolean;
  nodeAbi?: string;
  output: ShimOutput;
  spawnLauncher: (
    revision: NpmAppRevision,
    mode: LauncherUpdateMode,
  ) => LauncherRun;
  updateMode: "private";
  useBundled: boolean;
}

export interface NpmRevisionSelection {
  reason: "bundled-newer" | "installed-newer" | "none";
  revision: NpmAppRevision;
}

export function selectNpmRevision(args: {
  bundled: NpmAppRevision;
  current: InstalledNpmAppRevision | null;
  isUsable: (revision: NpmAppRevision) => boolean;
  nodeAbi: string;
}): NpmRevisionSelection {
  const current = args.current;

  if (
    semver.valid(args.bundled.version) === null ||
    (current !== null && semver.valid(current.version) === null)
  ) {
    throw new Error(
      "Refusing to select omnyo-app because its runtime version is invalid. Restore a valid installation or explicitly run with --bundled.",
    );
  }

  if (current === null) {
    return { reason: "none", revision: args.bundled };
  }

  if (semver.compareBuild(current.version, args.bundled.version) <= 0) {
    return { reason: "bundled-newer", revision: args.bundled };
  }

  if (!args.isUsable(current)) {
    throw new Error(
      `Refusing to downgrade omnyo-app ${current.version} to bundled ${args.bundled.version}: the selected runtime is missing or incomplete. Restore omnyo-app ${current.version} or newer, or explicitly run with --bundled.`,
    );
  }

  if (current.nodeAbi !== args.nodeAbi) {
    throw new Error(
      `Refusing to downgrade omnyo-app ${current.version} to bundled ${args.bundled.version}: the selected runtime requires Node.js ABI ${current.nodeAbi}, but this Node.js uses ${args.nodeAbi}. Use the matching Node.js version, install omnyo-app ${current.version} or newer, or explicitly run with --bundled.`,
    );
  }

  return { reason: "installed-newer", revision: current };
}

export function spawnNpmLauncher(args: {
  cliArgs: string[];
  mode: LauncherUpdateMode;
  revision: NpmAppRevision;
}): LauncherRun {
  return spawnLauncherProcess({
    args: [
      join(args.revision.packageRoot, "dist", "omnyo-app.js"),
      ...args.cliArgs,
    ],
    env: createLauncherEnv(args.mode),
  });
}

export async function runNpmShim(args: RunNpmShimArgs): Promise<number> {
  const isUsable = args.isUsable ?? isUsableNpmRevision;
  const nodeAbi = args.nodeAbi ?? process.versions.modules;
  let useBundled = args.useBundled;
  let shuttingDown = false;
  let running: LauncherRun | null = null;
  let lastLaunchedVersion: string | null = null;
  let lock: ShimLock | null = null;

  const removeSignalForwarding = installShimSignalForwarding({
    current: () => running,
    onShutdown: () => {
      shuttingDown = true;
    },
  });

  const select = (state: AppUpdateBootstrapState | null): NpmAppRevision => {
    if (useBundled) return args.bundled;

    if (state === null) {
      throw new AppUpdateStateUnreadableError(
        formatAppUpdateStatePath(args.dataDir),
      );
    }

    const selection = selectNpmRevision({
      bundled: args.bundled,
      current: state.current,
      isUsable,
      nodeAbi,
    });

    if (selection.reason === "installed-newer") {
      args.output.info(
        `Using omnyo-app ${selection.revision.version} from an in-app update. Run with --bundled to use ${args.bundled.version}.`,
      );
    }

    return selection.revision;
  };

  const run = async (
    revision: NpmAppRevision,
    mode: LauncherUpdateMode,
  ): Promise<ChildProcessExitResult> => {
    if (semver.valid(revision.version) === null) {
      throw new Error(
        "Refusing to launch omnyo-app with an invalid runtime version.",
      );
    }

    if (
      lastLaunchedVersion !== null &&
      semver.compareBuild(revision.version, lastLaunchedVersion) < 0
    ) {
      throw new Error(
        `Refusing to downgrade omnyo-app ${lastLaunchedVersion} to ${revision.version} during restart. Restore the selected runtime to ${lastLaunchedVersion} or newer before restarting.`,
      );
    }

    lastLaunchedVersion = revision.version;
    running = args.spawnLauncher(revision, mode);
    const exit = await running.exit;
    running = null;

    return exit;
  };

  try {
    lock = await (args.acquireLock ?? acquireShimLock)(args.dataDir);
    const initialState = await readAppUpdateBootstrapStateFile(args.dataDir);
    let launch = select(initialState);

    if (lock === null || initialState === null) {
      args.output.info(
        initialState === null
          ? "Using the bundled omnyo-app by explicit request; unreadable update state is preserved and in-app updates are off for this run."
          : "Another omnyo-app is managing this data directory; in-app updates are off for this run.",
      );

      return toShimExitCode(await run(launch, "passive"));
    }

    for (;;) {
      const exit = await run(launch, args.updateMode);

      if (exit.code !== APP_UPDATE_RESTART_EXIT_CODE) {
        return toShimExitCode(exit);
      }

      if (shuttingDown) return 0;
      useBundled = false;
      const state = await readAppUpdateBootstrapStateFile(args.dataDir);

      launch = select(state);
    }
  } catch (error) {
    args.output.error(error instanceof Error ? error.message : String(error));

    return 1;
  } finally {
    removeSignalForwarding();
    await lock?.release();
  }
}
