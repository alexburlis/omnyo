import type { Stats } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import type { NativeChatClient, ScanDropReason } from "../host-contract.js";
import {
  arrayField,
  asRecord,
  createLineReadStats,
  numberField,
  parseJsonRecord,
  parseTimestamp,
  readFirstLine,
  readLines,
  readTailLines,
  recordField,
  stringField,
  type JsonRecord,
} from "./jsonl.js";
import {
  chatTitle,
  contentDiff,
  diffDisplayPath,
  firstPromptPreview,
  HEAD_SCAN_LIMITS,
  promptTitle,
  TAIL_WINDOWS_BYTES,
  TurnAccumulator,
  withDiffHeader,
  type DraftFileChange,
  type DraftItem,
  type DraftTurn,
  type NativeSummaryResult,
} from "./normalize.js";

const OMNYO_ORIGINATORS = new Set([
  "omnyo",
  "bb",
  "omnyo_composer_predictions",
  "bb_composer_predictions",
]);

const OMNYO_MODEL_PROVIDERS = new Set([
  "omnyo-account-pool",
  "bb-account-pool",
]);

const INTERACTIVE_CLIENTS: ReadonlyMap<string, NativeChatClient> = new Map([
  ["codex-tui", "cli"],
  ["codex_cli_rs", "cli"],
  ["codex_vscode", "ide"],
]);

const SUBAGENT_THREAD_SOURCES = new Set(["subagent", "guardian_review"]);

const ACTIVITY_EVENT_TYPES = new Set([
  "item_completed",
  "task_started",
  "task_complete",
  "turn_aborted",
  "user_message",
  "agent_message",
]);

export function codexSessionsDir(codexHome: string): string {
  return path.join(codexHome, "sessions");
}

export function isCodexRolloutName(name: string): boolean {
  return name.startsWith("rollout-") && name.endsWith(".jsonl");
}

export async function listCodexRollouts(
  sessionsDir: string,
  signal?: AbortSignal,
): Promise<string[]> {
  const files: string[] = [];
  const pending = [sessionsDir];

  while (pending.length > 0) {
    signal?.throwIfAborted();
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

      if (entry.isDirectory()) pending.push(entryPath);
      else if (entry.isFile() && isCodexRolloutName(entry.name))
        files.push(entryPath);
    }
  }

  return files.sort();
}

export async function readCodexTitleIndex(
  codexHome: string,
  signal?: AbortSignal,
): Promise<Map<string, string>> {
  const titles = new Map<string, string>();

  try {
    for await (const line of readLines(
      path.join(codexHome, "session_index.jsonl"),
      { signal },
    )) {
      const record = parseJsonRecord(line);
      const id = stringField(record, "id");
      const name = stringField(record, "thread_name")?.trim();

      if (id !== null && name) titles.set(id, name);
    }
  } catch {
    return titles;
  }

  return titles;
}

interface CodexSessionMeta {
  readonly id: string;
  readonly cwd: string;
  readonly originator: string;
  readonly createdAt: number | null;
  readonly forkedFromId: string | null;
  readonly payload: JsonRecord;
}

async function readCodexSessionMeta(
  filePath: string,
  signal?: AbortSignal,
): Promise<CodexSessionMeta | null> {
  const line = await readFirstLine(filePath, { signal });
  const record = line === null ? null : parseJsonRecord(line);

  if (stringField(record, "type") !== "session_meta") return null;
  const payload = recordField(record, "payload");
  const id = stringField(payload, "id");

  if (payload === null || id === null || id.length === 0 || id.length > 256)
    return null;
  const forkedFromId = stringField(payload, "forked_from_id");

  return {
    id,
    cwd: stringField(payload, "cwd") ?? "",
    originator: stringField(payload, "originator") ?? "",
    createdAt:
      parseTimestamp(payload.timestamp) ?? parseTimestamp(record?.timestamp),
    forkedFromId:
      forkedFromId !== null &&
      forkedFromId.length > 0 &&
      forkedFromId.length <= 256
        ? forkedFromId
        : null,
    payload,
  };
}

export function classifyCodexMeta(payload: JsonRecord): ScanDropReason | null {
  const originator = stringField(payload, "originator") ?? "";
  const modelProvider = stringField(payload, "model_provider") ?? "";

  if (
    OMNYO_ORIGINATORS.has(originator) ||
    OMNYO_MODEL_PROVIDERS.has(modelProvider)
  )
    return "omnyo-session";

  const source = payload.source;
  const threadSource = stringField(payload, "thread_source");

  if (
    asRecord(source) !== null ||
    (threadSource !== null && SUBAGENT_THREAD_SOURCES.has(threadSource))
  )
    return "subagent-session";

  if (typeof source !== "string" || !INTERACTIVE_CLIENTS.has(originator))
    return "scripted-session";

  if (threadSource !== null && threadSource !== "user")
    return "scripted-session";

  return null;
}

function eventPayloadType(record: JsonRecord | null): string | null {
  if (stringField(record, "type") !== "event_msg") return null;

  return stringField(recordField(record, "payload"), "type");
}

async function codexTailActivity(filePath: string): Promise<number | null> {
  for (const windowBytes of TAIL_WINDOWS_BYTES) {
    const tail = await readTailLines(filePath, windowBytes);

    for (let index = tail.lines.length - 1; index >= 0; index -= 1) {
      const line = tail.lines[index] ?? "";

      if (!line.includes('"event_msg"')) continue;
      const record = parseJsonRecord(line);
      const type = eventPayloadType(record);

      if (type === null || !ACTIVITY_EVENT_TYPES.has(type)) continue;
      const timestamp = parseTimestamp(record?.timestamp);

      if (timestamp !== null) return timestamp;
    }

    if (tail.reachedStart) break;
  }

  return null;
}

function userMessageText(item: JsonRecord | null): string | null {
  const text = arrayField(item, "content")
    .map(asRecord)
    .filter((part) => stringField(part, "type") === "text")
    .map((part) => stringField(part, "text") ?? "")
    .join("\n")
    .trim();

  return text.length > 0 ? text : null;
}

function codexPromptFromRecord(record: JsonRecord | null): string | null {
  const type = eventPayloadType(record);
  const payload = recordField(record, "payload");

  if (type === "item_completed") {
    const item = recordField(payload, "item");

    return stringField(item, "type") === "UserMessage"
      ? userMessageText(item)
      : null;
  }

  if (type === "user_message") {
    const text = stringField(payload, "message")?.trim();

    return text ? text : null;
  }

  return null;
}

interface CodexHeadScan {
  readonly firstPrompt: string | null;
  readonly firstPromptAt: number | null;
}

async function scanCodexHead(
  filePath: string,
  signal?: AbortSignal,
): Promise<CodexHeadScan> {
  const stats = createLineReadStats();
  let lineCount = 0;

  for await (const line of readLines(filePath, { signal, stats })) {
    lineCount += 1;

    if (
      lineCount > HEAD_SCAN_LIMITS.maxLines ||
      stats.bytesRead > HEAD_SCAN_LIMITS.maxBytes
    )
      break;

    if (!line.includes('"UserMessage"') && !line.includes('"user_message"'))
      continue;
    const record = parseJsonRecord(line);
    const prompt = codexPromptFromRecord(record);

    if (prompt !== null)
      return {
        firstPrompt: prompt,
        firstPromptAt: parseTimestamp(record?.timestamp),
      };
  }

  return { firstPrompt: null, firstPromptAt: null };
}

export interface CodexSummaryOptions {
  readonly cutoffMs: number;
  readonly titles: ReadonlyMap<string, string>;
  readonly signal?: AbortSignal;
}

export async function summarizeCodexRollout(
  filePath: string,
  fileStats: Stats,
  options: CodexSummaryOptions,
): Promise<NativeSummaryResult> {
  const meta = await readCodexSessionMeta(filePath, options.signal);

  if (meta === null) return { kind: "dropped", reason: "unreadable" };
  const classification = classifyCodexMeta(meta.payload);

  if (classification !== null)
    return { kind: "dropped", reason: classification };

  if (meta.cwd.length === 0 || meta.cwd.length > 4096)
    return { kind: "dropped", reason: "unreadable" };
  const tailActivity = await codexTailActivity(filePath);

  if (tailActivity !== null && tailActivity < options.cutoffMs)
    return { kind: "dropped", reason: "older-than-window" };
  const head = await scanCodexHead(filePath, options.signal);

  if (head.firstPrompt === null)
    return { kind: "dropped", reason: "no-user-message" };

  const lastMessageAt =
    tailActivity ?? head.firstPromptAt ?? Math.trunc(fileStats.mtimeMs);

  if (lastMessageAt < options.cutoffMs)
    return { kind: "dropped", reason: "older-than-window" };
  const indexedTitle = options.titles.get(meta.id);

  const createdAt = Math.min(
    meta.createdAt ?? head.firstPromptAt ?? lastMessageAt,
    lastMessageAt,
  );

  return {
    kind: "chat",
    chat: {
      providerId: "codex",
      sourceProviderThreadId: meta.id,
      sourcePath: filePath,
      cwd: meta.cwd,
      cwdMatchesStore: true,
      title: indexedTitle
        ? chatTitle(indexedTitle)
        : promptTitle(head.firstPrompt),
      firstPrompt: firstPromptPreview(head.firstPrompt),
      createdAt,
      lastMessageAt,
      client: INTERACTIVE_CLIENTS.get(meta.originator) ?? "cli",
      sizeBytes: fileStats.size,
      forkedFromProviderThreadId: meta.forkedFromId,
    },
  };
}

function quoteShellArgument(argument: string): string {
  if (/^[\w@%+=:,./-]+$/.test(argument)) return argument;

  return `'${argument.replace(/'/g, `'\\''`)}'`;
}

export function codexCommandText(command: unknown): string {
  if (typeof command === "string") return command;

  if (!Array.isArray(command)) return "";

  const parts = command.filter(
    (part): part is string => typeof part === "string",
  );

  if (parts.length === 3 && (parts[1] === "-lc" || parts[1] === "-c"))
    return parts[2] ?? "";

  return parts.map(quoteShellArgument).join(" ");
}

function durationMs(value: unknown): number | null {
  const record = asRecord(value);

  if (record !== null) {
    const seconds = numberField(record, "secs") ?? 0;
    const nanos = numberField(record, "nanos") ?? 0;

    return seconds * 1000 + nanos / 1_000_000;
  }

  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function jsonText(value: unknown): string | null {
  if (value === undefined || value === null) return null;

  if (typeof value === "string") return value;

  try {
    return JSON.stringify(value) ?? null;
  } catch {
    return null;
  }
}

function contentText(parts: readonly unknown[]): string {
  return parts
    .map(asRecord)
    .map((part) => stringField(part, "text"))
    .filter((text): text is string => text !== null)
    .join("\n");
}

function errorText(value: unknown): string | null {
  if (typeof value === "string") return value.length > 0 ? value : null;

  return stringField(asRecord(value), "message");
}

function taskFailure(payload: JsonRecord | null): string | null {
  const error = payload?.error;

  if (error === undefined || error === null) return null;
  const message = errorText(error);

  if (message !== null && message.length > 0) return message;

  return (
    stringField(asRecord(error), "codex_error_info") ?? JSON.stringify(error)
  );
}

function fileChangeItem(
  item: JsonRecord,
  cwd: string | null,
): DraftItem | null {
  const changesRecord = recordField(item, "changes");

  if (changesRecord === null) return null;
  const changes: DraftFileChange[] = [];

  for (const [filePath, value] of Object.entries(changesRecord)) {
    const change = asRecord(value);
    const kind = stringField(change, "type") ?? stringField(change, "kind");
    const displayPath = diffDisplayPath(filePath, cwd);

    if (kind === "add" || kind === "delete") {
      const content = stringField(change, "content");

      changes.push({
        path: filePath,
        kind,
        diff: content === null ? null : contentDiff(displayPath, kind, content),
      });
    } else if (kind === "update") {
      const diff = stringField(change, "unified_diff");
      const movePath = stringField(change, "move_path");

      changes.push({
        path: filePath,
        kind,
        diff:
          diff === null || diff.length === 0
            ? null
            : withDiffHeader(
                displayPath,
                diff,
                movePath === null ? null : diffDisplayPath(movePath, cwd),
              ),
      });
    }
  }

  if (changes.length === 0) return null;

  return { type: "fileChange", nativeId: stringField(item, "id"), changes };
}

export function codexDraftItem(
  item: JsonRecord,
  sessionCwd: string | null,
): DraftItem | null {
  const nativeId = stringField(item, "id");

  switch (stringField(item, "type")) {
    case "AgentMessage": {
      const text = contentText(arrayField(item, "content")).trim();

      return text.length === 0
        ? null
        : { type: "agentMessage", nativeId, text };
    }

    case "CommandExecution": {
      const command = codexCommandText(item.command);

      if (command.length === 0) return null;

      return {
        type: "commandExecution",
        nativeId,
        command,
        cwd: stringField(item, "cwd"),
        output: stringField(item, "aggregated_output") ?? "",
        exitCode: numberField(item, "exit_code"),
        durationMs: durationMs(item.duration),
      };
    }

    case "FileChange":
      return fileChangeItem(item, stringField(item, "cwd") ?? sessionCwd);

    case "McpToolCall": {
      const tool = stringField(item, "tool");

      if (!tool) return null;
      const result = recordField(item, "result");

      const resultText =
        result === null ? null : contentText(arrayField(result, "content"));

      const failed = result?.isError === true;

      return {
        type: "toolCall",
        nativeId,
        tool,
        server: stringField(item, "server"),
        arguments: jsonText(item.arguments),
        result: failed ? null : resultText,
        error: errorText(item.error) ?? (failed ? resultText : null),
      };
    }

    case "DynamicToolCall": {
      const tool = stringField(item, "tool") ?? stringField(item, "name");

      if (!tool) return null;

      const parts = [
        ...arrayField(item, "content_items"),
        ...arrayField(item, "contentItems"),
      ];

      const resultText = parts.length > 0 ? contentText(parts) : null;
      const failed = item.success === false;

      return {
        type: "toolCall",
        nativeId,
        tool,
        server: null,
        arguments: jsonText(item.arguments),
        result: failed ? null : resultText,
        error: errorText(item.error) ?? (failed ? resultText : null),
      };
    }

    default:
      return null;
  }
}

function legacyTurnsBefore(
  legacy: TurnAccumulator,
  turnsAtTaskStart: number,
  firstModernText: string,
): DraftTurn[] {
  const open = legacy.openTurn;

  legacy.closeTurn("interrupted", null);

  const duplicate =
    open !== null &&
    open === legacy.turns.at(-1) &&
    legacy.turns.length > turnsAtTaskStart &&
    open.userText === firstModernText;

  return duplicate ? legacy.turns.slice(0, -1) : legacy.turns.slice();
}

export interface CodexTranscript {
  readonly turns: DraftTurn[];
  readonly skippedLines: number;
  readonly identityMatches: boolean;
}

export async function readCodexTranscript(
  filePath: string,
  expectedId: string,
  sessionCwd: string,
  signal?: AbortSignal,
): Promise<CodexTranscript> {
  const stats = createLineReadStats();
  const modern = new TurnAccumulator();
  const legacy = new TurnAccumulator();
  let accumulators = [modern, legacy];
  let legacyTurnsAtTaskStart = 0;
  let legacyPrefix: DraftTurn[] | null = null;
  let skippedLines = 0;
  let lineIndex = 0;
  let identityMatches = false;

  for await (const line of readLines(filePath, { signal, stats })) {
    lineIndex += 1;

    if (lineIndex === 1) {
      const record = parseJsonRecord(line);

      identityMatches =
        stringField(record, "type") === "session_meta" &&
        stringField(recordField(record, "payload"), "id") === expectedId;

      if (!identityMatches) break;
      continue;
    }

    if (!line.includes('"event_msg"')) continue;
    const record = parseJsonRecord(line);

    if (record === null) {
      skippedLines += 1;
      continue;
    }

    const type = eventPayloadType(record);

    if (type === null) continue;
    const at = parseTimestamp(record.timestamp);
    const payload = recordField(record, "payload");

    switch (type) {
      case "task_started":
        legacyTurnsAtTaskStart = legacy.turns.length;

        for (const accumulator of accumulators) {
          if (accumulator.openTurn !== null) accumulator.interruptTask(at);
          accumulator.closeTurn("interrupted", at);
          accumulator.beginTask();
        }

        break;

      case "task_complete": {
        const failure = taskFailure(payload);

        for (const accumulator of accumulators) {
          if (failure === null) {
            accumulator.closeTurn("completed", at);
            continue;
          }

          if (accumulator.openTurn !== null) {
            accumulator.addItem(
              {
                type: "toolCall",
                nativeId: null,
                tool: "error",
                server: null,
                arguments: null,
                result: null,
                error: failure,
              },
              at,
            );
          }

          accumulator.interruptTask(at);
          accumulator.closeTurn("interrupted", at);
        }

        break;
      }

      case "turn_aborted":
        for (const accumulator of accumulators) {
          accumulator.interruptTask(at);
          accumulator.closeTurn("interrupted", at);
        }

        break;

      case "user_message": {
        const prompt = codexPromptFromRecord(record);

        if (prompt !== null && legacyPrefix === null)
          legacy.startTurn(prompt, at);
        break;
      }

      case "agent_message": {
        const text = stringField(payload, "message")?.trim();

        if (text && legacyPrefix === null)
          legacy.addItem({ type: "agentMessage", nativeId: null, text }, at);
        break;
      }

      case "item_completed": {
        const item = recordField(payload, "item");

        if (item === null) break;

        if (stringField(item, "type") === "UserMessage") {
          const text = userMessageText(item);

          if (text === null) break;

          if (legacyPrefix === null) {
            legacyPrefix = legacyTurnsBefore(
              legacy,
              legacyTurnsAtTaskStart,
              text,
            );
            accumulators = [modern];
          }

          modern.startTurn(text, at);
          break;
        }

        const draft = codexDraftItem(item, sessionCwd);

        if (draft !== null) modern.addItem(draft, at);
        else modern.touch(at);
        break;
      }

      default:
        break;
    }
  }

  for (const accumulator of accumulators) {
    if (accumulator.openTurn !== null) accumulator.interruptTask(null);
    accumulator.closeTurn("interrupted", null);
  }

  return {
    turns:
      legacyPrefix === null ? legacy.turns : [...legacyPrefix, ...modern.turns],
    skippedLines: skippedLines + stats.oversizedLines,
    identityMatches,
  };
}
