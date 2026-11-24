import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
} from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { resolveCliDataDir } from "./data-dir.js";

export const CLI_ERROR_LOG_FILE_NAME = "cli-errors.jsonl";

const CLI_ERROR_LOG_MAX_BYTES = 2 * 1024 * 1024;

const CLI_ERROR_LOG_DISABLE_VALUES = new Set(["0", "false", "off"]);

const cliErrorLogEntrySchema = z.object({
  at: z.string(),
  cliVersion: z.string(),
  code: z.string(),
  command: z.string(),
  exitCode: z.number(),
  threadId: z.string().nullable(),
  token: z.string().nullable(),
});

export type CliErrorLogEntry = z.infer<typeof cliErrorLogEntrySchema>;

export interface CliErrorLogLocation {
  dataDir: string;
}

export function resolveCliErrorLogLocation(
  env: NodeJS.ProcessEnv = process.env,
): CliErrorLogLocation {
  return { dataDir: resolveCliDataDir(env) };
}

export function formatCliErrorLogPath(location: CliErrorLogLocation): string {
  return join(location.dataDir, "logs", CLI_ERROR_LOG_FILE_NAME);
}

export function isCliErrorLogEnabled(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const raw = env.OMNYO_CLI_ERROR_LOG;

  if (raw === undefined) return true;

  return !CLI_ERROR_LOG_DISABLE_VALUES.has(raw.trim().toLowerCase());
}

export function appendCliErrorLogEntry(
  entry: CliErrorLogEntry,
  env: NodeJS.ProcessEnv = process.env,
): void {
  if (!isCliErrorLogEnabled(env)) return;

  try {
    const location = resolveCliErrorLogLocation(env);
    const logPath = formatCliErrorLogPath(location);

    if (!existsSync(location.dataDir)) return;
    mkdirSync(join(location.dataDir, "logs"), { recursive: true });
    rotateIfOversized(logPath);
    appendFileSync(logPath, `${JSON.stringify(entry)}\n`);
  } catch {}
}

function rotateIfOversized(logPath: string): void {
  let size: number;

  try {
    size = statSync(logPath).size;
  } catch {
    return;
  }

  if (size < CLI_ERROR_LOG_MAX_BYTES) return;
  renameSync(logPath, `${logPath}.1`);
}

export function readCliErrorLogEntries(
  location: CliErrorLogLocation,
): CliErrorLogEntry[] {
  const logPath = formatCliErrorLogPath(location);
  const entries: CliErrorLogEntry[] = [];

  for (const path of [`${logPath}.1`, logPath]) {
    let contents: string;

    try {
      contents = readFileSync(path, "utf8");
    } catch {
      continue;
    }

    for (const line of contents.split("\n")) {
      if (line.trim().length === 0) continue;
      let raw: unknown;

      try {
        raw = JSON.parse(line);
      } catch {
        continue;
      }

      const parsed = cliErrorLogEntrySchema.safeParse(raw);

      if (parsed.success) entries.push(parsed.data);
    }
  }

  return entries;
}
