import fs from "node:fs/promises";
import path from "node:path";

export type NativeEnv = Readonly<Record<string, string | undefined>>;

export interface NativeHostEnvironment {
  readonly homeDir: string;
  readonly env: NativeEnv;
  readonly platform: NodeJS.Platform;
}

export interface NativeRoots {
  readonly homeDir: string;
  readonly codexHome: string;
  readonly claudeConfigDir: string;
}

function resolveHomeRelative(homeDir: string, value: string): string {
  if (value === "~") return homeDir;

  if (value.startsWith("~/") || value.startsWith("~\\"))
    return path.join(homeDir, value.slice(2));

  return path.resolve(homeDir, value);
}

function resolveConfiguredDir(
  homeDir: string,
  configured: string | undefined,
  defaultName: string,
): string {
  const trimmed = configured?.trim();

  return trimmed
    ? resolveHomeRelative(homeDir, trimmed)
    : path.join(homeDir, defaultName);
}

export function resolveNativeRoots(
  environment: NativeHostEnvironment,
): NativeRoots {
  const homeDir = path.resolve(environment.homeDir);

  return {
    homeDir,
    codexHome: resolveConfiguredDir(
      homeDir,
      environment.env.CODEX_HOME,
      ".codex",
    ),
    claudeConfigDir: resolveConfiguredDir(
      homeDir,
      environment.env.CLAUDE_CONFIG_DIR,
      ".claude",
    ),
  };
}

export async function isDirectory(directoryPath: string): Promise<boolean> {
  try {
    return (await fs.stat(directoryPath)).isDirectory();
  } catch {
    return false;
  }
}

export function isPathInside(rootPath: string, candidatePath: string): boolean {
  const relative = path.relative(rootPath, candidatePath);

  return (
    relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative)
  );
}

export function caseInsensitivePaths(platform: NodeJS.Platform): boolean {
  return platform === "darwin" || platform === "win32";
}
