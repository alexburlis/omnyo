import { readFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { z } from "zod";
import { pathExists } from "./fs.js";

const OMNYO_APP_VERSION_DEV_FALLBACK = "0.0.0-dev";

const OMNYO_APP_PACKAGE_NAME = "omnyo-app";

const packageJsonVersionSchema = z.object({ version: z.string().min(1) });

export function resolvePackagedOmnyoAppRoot(
  daemonEntryPath: string | null,
): string | null {
  if (daemonEntryPath === null) {
    return null;
  }

  const distDir = dirname(resolve(daemonEntryPath));
  const hostDaemonDir = dirname(distDir);

  if (
    basename(daemonEntryPath) !== "daemon-bundle.mjs" ||
    basename(distDir) !== "dist" ||
    basename(hostDaemonDir) !== "host-daemon"
  ) {
    return null;
  }

  return dirname(hostDaemonDir);
}

export function npmPrefixOmnyoAppRoot(npmPrefix: string): string {
  return join(npmPrefix, "lib", "node_modules", OMNYO_APP_PACKAGE_NAME);
}

export async function resolveOmnyoServerEntry(
  packageRoot: string,
): Promise<string | null> {
  const serverEntry = join(packageRoot, "dist", "omnyo-server.js");

  const required = [
    join(packageRoot, "dist", "omnyo-app.js"),
    serverEntry,
    join(packageRoot, "server", "dist", "index.js"),
    join(packageRoot, "app", "dist", "index.html"),
  ];

  for (const path of required) {
    if (!(await pathExists(path))) {
      return null;
    }
  }

  return serverEntry;
}

export async function resolveOmnyoAppLauncherEntry(
  packageRoot: string,
): Promise<string | null> {
  const entry = join(packageRoot, "dist", "omnyo-app.js");

  return (await pathExists(entry)) ? entry : null;
}

export async function readOmnyoAppVersion(args: {
  env: NodeJS.ProcessEnv;
  packageRoot: string | null;
}): Promise<string> {
  const configured = args.env.OMNYO_APP_VERSION?.trim();

  if (configured !== undefined && configured !== "") {
    return configured;
  }

  if (args.packageRoot === null) {
    return OMNYO_APP_VERSION_DEV_FALLBACK;
  }

  try {
    return packageJsonVersionSchema.parse(
      JSON.parse(
        await readFile(join(args.packageRoot, "package.json"), "utf8"),
      ),
    ).version;
  } catch {
    return OMNYO_APP_VERSION_DEV_FALLBACK;
  }
}

export function readWorkerRuntimeVersion(args: {
  env: NodeJS.ProcessEnv;
  packageRoot: string | null;
}): Promise<string> {
  return readOmnyoAppVersion({
    env: args.packageRoot === null ? args.env : {},
    packageRoot: args.packageRoot,
  });
}
