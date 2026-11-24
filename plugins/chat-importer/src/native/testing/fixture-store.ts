import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { NativeHostEnvironment } from "../paths.js";

export const NOW_MS = Date.parse("2026-11-12T12:00:00.000Z");

export const HOUR_MS = 3_600_000;

export const DAY_MS = 86_400_000;

export function iso(ms: number): string {
  return new Date(ms).toISOString();
}

export interface FixtureHome {
  readonly homeDir: string;
  readonly codexHome: string;
  readonly claudeDir: string;
  readonly workDir: string;
  environment(platform?: NodeJS.Platform): NativeHostEnvironment;
  cleanup(): Promise<void>;
}

export async function createFixtureHome(): Promise<FixtureHome> {
  const homeDir = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), "chat-importer-home-")),
  );

  const workDir = path.join(homeDir, "work", "app");

  await fs.mkdir(workDir, { recursive: true });

  return {
    homeDir,
    codexHome: path.join(homeDir, ".codex"),
    claudeDir: path.join(homeDir, ".claude"),
    workDir,
    environment: (platform = "darwin") => ({ homeDir, env: {}, platform }),
    cleanup: () => fs.rm(homeDir, { recursive: true, force: true }),
  };
}

export type JsonLine = Readonly<Record<string, unknown>>;

export async function writeJsonl(
  filePath: string,
  lines: readonly (JsonLine | string)[],
  mtimeMs: number,
): Promise<string> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(
    filePath,
    lines
      .map((line) => (typeof line === "string" ? line : JSON.stringify(line)))
      .map((line) => `${line}\n`)
      .join(""),
  );
  await fs.utimes(filePath, mtimeMs / 1000, mtimeMs / 1000);

  return filePath;
}

export interface CodexMetaOptions {
  readonly id: string;
  readonly cwd: string;
  readonly at: number;
  readonly originator?: string;
  readonly source?: unknown;
  readonly threadSource?: string | null;
  readonly modelProvider?: string;
  readonly baseInstructions?: string;
  readonly forkedFromId?: string;
}

export function codexMeta(options: CodexMetaOptions): JsonLine {
  return {
    timestamp: iso(options.at),
    ordinal: 0,
    type: "session_meta",
    payload: {
      session_id: options.id,
      id: options.id,
      timestamp: iso(options.at),
      cwd: options.cwd,
      originator: options.originator ?? "codex-tui",
      cli_version: "0.167.0",
      source: options.source === undefined ? "vscode" : options.source,
      ...(options.threadSource === null
        ? {}
        : { thread_source: options.threadSource ?? "user" }),
      model_provider: options.modelProvider ?? "openai",
      base_instructions: { text: options.baseInstructions ?? "base" },
      history_mode: "paginated",
      ...(options.forkedFromId === undefined
        ? {}
        : { forked_from_id: options.forkedFromId }),
    },
  };
}

export function codexEvent(at: number, payload: JsonLine): JsonLine {
  return { timestamp: iso(at), ordinal: 1, type: "event_msg", payload };
}

export function codexTaskStarted(at: number, turnId: string): JsonLine {
  return codexEvent(at, {
    type: "task_started",
    turn_id: turnId,
    started_at: Math.floor(at / 1000),
  });
}

export function codexTaskComplete(
  at: number,
  turnId: string,
  error: JsonLine | null = null,
): JsonLine {
  return codexEvent(at, {
    type: "task_complete",
    turn_id: turnId,
    last_agent_message: error === null ? null : "",
    duration_ms: 1,
    ...(error === null ? {} : { error }),
  });
}

export function codexTurnAborted(at: number, turnId: string): JsonLine {
  return codexEvent(at, {
    type: "turn_aborted",
    turn_id: turnId,
    reason: "interrupted",
  });
}

export function codexItem(at: number, item: JsonLine): JsonLine {
  return codexEvent(at, {
    type: "item_completed",
    thread_id: "thread",
    turn_id: "turn",
    item,
    started_at_ms: at,
    completed_at_ms: at,
  });
}

export function codexUserMessage(at: number, id: string, text: string) {
  return codexItem(at, {
    type: "UserMessage",
    id,
    client_id: "client",
    content: [{ type: "text", text, text_elements: [] }],
  });
}

export function codexAgentMessage(at: number, id: string, text: string) {
  return codexItem(at, {
    type: "AgentMessage",
    id,
    content: [{ type: "Text", text }],
    phase: "final_answer",
  });
}

export function codexWorldState(at: number): JsonLine {
  return {
    timestamp: iso(at),
    ordinal: 1,
    type: "world_state",
    payload: { full: true, state: {} },
  };
}

export function codexTokenCount(at: number): JsonLine {
  return codexEvent(at, { type: "token_count", info: null });
}

export function codexRolloutPath(
  codexHome: string,
  at: number,
  id: string,
): string {
  const date = new Date(at);
  const year = String(date.getUTCFullYear());
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  const day = String(date.getUTCDate()).padStart(2, "0");

  return path.join(
    codexHome,
    "sessions",
    year,
    month,
    day,
    `rollout-${year}-${month}-${day}T00-00-00-${id}.jsonl`,
  );
}

export interface SimpleCodexChat {
  readonly id: string;
  readonly cwd: string;
  readonly startAt: number;
  readonly lastAt: number;
  readonly prompt?: string;
  readonly meta?: Partial<CodexMetaOptions>;
}

export async function writeSimpleCodexChat(
  codexHome: string,
  chat: SimpleCodexChat,
): Promise<string> {
  return writeJsonl(
    codexRolloutPath(codexHome, chat.startAt, chat.id),
    [
      codexMeta({ id: chat.id, cwd: chat.cwd, at: chat.startAt, ...chat.meta }),
      codexTaskStarted(chat.startAt, "t1"),
      codexWorldState(chat.startAt),
      ...(chat.prompt === undefined
        ? []
        : [
            codexUserMessage(chat.startAt + 1000, `${chat.id}-u1`, chat.prompt),
          ]),
      codexAgentMessage(chat.lastAt, `${chat.id}-a1`, "Done."),
      codexTaskComplete(chat.lastAt, "t1"),
      codexTokenCount(chat.lastAt + 5000),
    ],
    chat.lastAt + 10_000,
  );
}

export function claudeSlug(cwd: string): string {
  return cwd.replace(/[^A-Za-z0-9]/g, "-");
}

export interface ClaudeLineBase {
  readonly sessionId: string;
  readonly cwd: string;
  readonly entrypoint?: string;
}

export function claudeUser(
  base: ClaudeLineBase,
  at: number,
  content: unknown,
  extra: JsonLine = {},
): JsonLine {
  return {
    parentUuid: null,
    isSidechain: false,
    type: "user",
    message: { role: "user", content },
    uuid: `u-${at}`,
    timestamp: iso(at),
    userType: "external",
    entrypoint: base.entrypoint ?? "cli",
    cwd: base.cwd,
    sessionId: base.sessionId,
    version: "2.1.300",
    ...extra,
  };
}

export function claudeAssistant(
  base: ClaudeLineBase,
  at: number,
  messageId: string,
  block: JsonLine,
  extra: JsonLine = {},
): JsonLine {
  return {
    parentUuid: null,
    isSidechain: false,
    type: "assistant",
    message: {
      model: "claude",
      id: messageId,
      type: "message",
      role: "assistant",
      content: [block],
      stop_reason: null,
    },
    uuid: `a-${at}-${messageId}`,
    timestamp: iso(at),
    userType: "external",
    entrypoint: base.entrypoint ?? "cli",
    cwd: base.cwd,
    sessionId: base.sessionId,
    version: "2.1.300",
    ...extra,
  };
}

export function claudeToolResult(
  base: ClaudeLineBase,
  at: number,
  toolUseId: string,
  content: unknown,
  options: { isError?: boolean; toolUseResult?: unknown } = {},
): JsonLine {
  return claudeUser(
    base,
    at,
    [
      {
        tool_use_id: toolUseId,
        type: "tool_result",
        content,
        ...(options.isError === undefined ? {} : { is_error: options.isError }),
      },
    ],
    options.toolUseResult === undefined
      ? {}
      : { toolUseResult: options.toolUseResult },
  );
}

export function claudeSessionPath(
  claudeDir: string,
  projectDirName: string,
  sessionId: string,
): string {
  return path.join(claudeDir, "projects", projectDirName, `${sessionId}.jsonl`);
}

export interface FileFingerprint {
  readonly sha256: string;
  readonly mtimeMs: number;
  readonly size: number;
}

export async function fingerprintTree(
  root: string,
): Promise<Map<string, FileFingerprint>> {
  const fingerprints = new Map<string, FileFingerprint>();
  const pending = [root];

  while (pending.length > 0) {
    const directory = pending.pop();

    if (directory === undefined) break;
    let entries;

    try {
      entries = await fs.readdir(directory, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      const entryPath = path.join(directory, entry.name);

      if (entry.isDirectory()) {
        pending.push(entryPath);
        continue;
      }

      const [content, stats] = await Promise.all([
        fs.readFile(entryPath),
        fs.stat(entryPath),
      ]);

      fingerprints.set(entryPath, {
        sha256: createHash("sha256").update(content).digest("hex"),
        mtimeMs: stats.mtimeMs,
        size: stats.size,
      });
    }
  }

  return fingerprints;
}
