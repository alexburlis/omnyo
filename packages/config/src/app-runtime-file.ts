import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { z } from "zod";
import { isProcessRunning } from "./verified-process-stop.js";

const APP_RUNTIME_FILE_NAME = "app-runtime.json";

const appRuntimeFileSchema = z.object({
  entryPath: z.string().min(1),
  pid: z.number().int().positive(),
  surface: z.string().min(1),
  serverUrl: z.string().min(1),
  startedAt: z.string().min(1),
  version: z.string().min(1),
});

export type AppRuntimeFile = z.infer<typeof appRuntimeFileSchema>;

interface WriteAppRuntimeFileArgs {
  dataDir: string;
  entryPath: string;
  pid: number;
  serverUrl: string;
  startedAt: string;
  surface: string;
  version: string;
}

export function formatAppRuntimeFilePath(dataDir: string): string {
  return join(dataDir, APP_RUNTIME_FILE_NAME);
}

export async function writeAppRuntimeFile(
  args: WriteAppRuntimeFileArgs,
): Promise<void> {
  const runtimeFile: AppRuntimeFile = {
    entryPath: args.entryPath,
    pid: args.pid,
    serverUrl: args.serverUrl,
    startedAt: args.startedAt,
    surface: args.surface,
    version: args.version,
  };

  await mkdir(args.dataDir, { recursive: true });
  await writeFile(
    formatAppRuntimeFilePath(args.dataDir),
    `${JSON.stringify(runtimeFile, null, 2)}\n`,
    "utf8",
  );
}

export async function claimAppRuntimeFile(
  args: WriteAppRuntimeFileArgs & { isRunning?: (pid: number) => boolean },
): Promise<boolean> {
  const isRunning = args.isRunning ?? isProcessRunning;

  const existing = await readAppRuntimeFile(args.dataDir);

  if (existing !== null && existing.pid !== args.pid && isRunning(existing.pid))
    return false;

  await writeAppRuntimeFile(args);

  return true;
}

async function clearAppRuntimeFile(dataDir: string): Promise<void> {
  await rm(formatAppRuntimeFilePath(dataDir), { force: true });
}

export async function clearOwnAppRuntimeFile(args: {
  dataDir: string;
  pid: number;
}): Promise<boolean> {
  const runtimeFile = await readAppRuntimeFile(args.dataDir);

  if (runtimeFile === null || runtimeFile.pid !== args.pid) {
    return false;
  }

  await clearAppRuntimeFile(args.dataDir);

  return true;
}

export function appRuntimeVerifyTokens(entryPath: string): string[] {
  return [entryPath, basename(entryPath)];
}

export async function readAppRuntimeFile(
  dataDir: string,
): Promise<AppRuntimeFile | null> {
  let rawContents: string;

  try {
    rawContents = await readFile(formatAppRuntimeFilePath(dataDir), "utf8");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT")
      return null;
    throw error;
  }

  return appRuntimeFileSchema.parse(JSON.parse(rawContents));
}
