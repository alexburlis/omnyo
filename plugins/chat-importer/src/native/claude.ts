import type { Stats } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import type { NativeChatClient } from "../host-contract.js";
import {
  arrayField,
  asRecord,
  createLineReadStats,
  numberField,
  parseJsonRecord,
  parseTimestamp,
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
  hunksDiff,
  promptTitle,
  replacementHunk,
  TAIL_WINDOWS_BYTES,
  TurnAccumulator,
  type DiffHunk,
  type DraftItem,
  type DraftItemLocation,
  type DraftTurn,
  type NativeSummaryResult,
} from "./normalize.js";
import { caseInsensitivePaths } from "./paths.js";

const INTERACTIVE_ENTRYPOINTS: ReadonlyMap<string, NativeChatClient> = new Map([
  ["cli", "cli"],
  ["claude-vscode", "ide"],
  ["claude-desktop", "desktop"],
]);

const MESSAGE_LINE_TYPES = new Set([
  "user",
  "assistant",
  "system",
  "attachment",
]);

const WRAPPER_PREFIXES = [
  "<local-command-",
  "<bash-",
  "<system-reminder>",
  "<task-notification>",
];

const INTERRUPT_PREFIX = "[Request interrupted by user";

const FILE_EDIT_TOOLS = new Set(["Edit", "MultiEdit", "Write"]);

const PROJECT_SLUG_MAX_CHARS = 200;

export function claudeProjectsDir(claudeConfigDir: string): string {
  return path.join(claudeConfigDir, "projects");
}

export function claudeProjectSlug(cwd: string): string {
  return cwd.replace(/[^A-Za-z0-9]/g, "-");
}

export interface ClaudeSessionFile {
  readonly filePath: string;
  readonly projectDirName: string;
  readonly sessionId: string;
}

export async function listClaudeSessions(
  projectsDir: string,
  signal?: AbortSignal,
): Promise<ClaudeSessionFile[]> {
  let projectEntries;

  try {
    projectEntries = await fs.readdir(projectsDir, { withFileTypes: true });
  } catch {
    return [];
  }

  const sessions: ClaudeSessionFile[] = [];

  for (const projectEntry of projectEntries) {
    signal?.throwIfAborted();

    if (!projectEntry.isDirectory()) continue;
    const projectDir = path.join(projectsDir, projectEntry.name);
    let entries;

    try {
      entries = await fs.readdir(projectDir, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".jsonl")) continue;
      sessions.push({
        filePath: path.join(projectDir, entry.name),
        projectDirName: projectEntry.name,
        sessionId: entry.name.slice(0, -".jsonl".length),
      });
    }
  }

  return sessions.sort((left, right) =>
    left.filePath.localeCompare(right.filePath),
  );
}

function messageContent(record: JsonRecord | null): unknown {
  return recordField(record, "message")?.content;
}

function textBlocks(content: unknown): string | null {
  if (typeof content === "string") return content;

  if (!Array.isArray(content)) return null;
  const blocks = content.map(asRecord);

  if (blocks.some((block) => stringField(block, "type") === "tool_result"))
    return null;

  return blocks
    .filter((block) => stringField(block, "type") === "text")
    .map((block) => stringField(block, "text") ?? "")
    .join("\n");
}

function slashCommand(text: string): string | null {
  const name = text
    .match(/<command-name>([\s\S]*?)<\/command-name>/)?.[1]
    ?.trim()
    .replace(/^\/+/, "");

  if (!name) return null;

  const args =
    text.match(/<command-args>([\s\S]*?)<\/command-args>/)?.[1]?.trim() ?? "";

  return args.length > 0 ? `/${name} ${args}` : `/${name}`;
}

function isPlainUserLine(record: JsonRecord | null): boolean {
  if (stringField(record, "type") !== "user") return false;

  if (
    record?.isMeta === true ||
    record?.isSidechain === true ||
    record?.isCompactSummary === true ||
    record?.isVisibleInTranscriptOnly === true
  )
    return false;
  const originKind = stringField(recordField(record, "origin"), "kind");

  return originKind === null || originKind === "human";
}

interface PromptCandidate {
  readonly text: string;
  readonly command: boolean;
}

function promptCandidate(record: JsonRecord | null): PromptCandidate | null {
  if (!isPlainUserLine(record)) return null;
  const text = textBlocks(messageContent(record))?.trim();

  if (!text) return null;

  if (
    text.startsWith("<command-name>") ||
    text.startsWith("<command-message>")
  ) {
    const command = slashCommand(text);

    return command === null ? null : { text: command, command: true };
  }

  if (WRAPPER_PREFIXES.some((prefix) => text.startsWith(prefix))) return null;

  if (text.startsWith(INTERRUPT_PREFIX)) return null;

  return { text, command: false };
}

function userLineText(record: JsonRecord | null): string | null {
  if (stringField(record, "type") !== "user" || record?.isSidechain === true)
    return null;

  return textBlocks(messageContent(record))?.trim() ?? null;
}

function isInterruptMarker(record: JsonRecord | null): boolean {
  return userLineText(record)?.startsWith(INTERRUPT_PREFIX) === true;
}

function isLocalCommandOutput(record: JsonRecord | null): boolean {
  if (
    stringField(record, "type") === "system" &&
    stringField(record, "subtype") === "local_command"
  )
    return true;
  const text = userLineText(record);

  return (
    text !== null &&
    (text.startsWith("<local-command-stdout>") ||
      text.startsWith("<local-command-stderr>"))
  );
}

export interface ClaudePrompt {
  readonly text: string;
  readonly at: number | null;
}

export interface ObservedPrompts {
  readonly resolved: ClaudePrompt | null;
  readonly prompt: ClaudePrompt | null;
}

export class ClaudePromptTracker {
  private pendingCommand: ClaudePrompt | null = null;

  observe(record: JsonRecord | null, at: number | null): ObservedPrompts {
    let resolved: ClaudePrompt | null = null;

    if (this.pendingCommand !== null) {
      if (!isLocalCommandOutput(record)) resolved = this.pendingCommand;
      this.pendingCommand = null;
    }

    const candidate = promptCandidate(record);

    if (candidate === null) return { resolved, prompt: null };

    if (candidate.command) {
      this.pendingCommand = { text: candidate.text, at };

      return { resolved, prompt: null };
    }

    return { resolved, prompt: { text: candidate.text, at } };
  }

  flush(): ClaudePrompt | null {
    const pending = this.pendingCommand;

    this.pendingCommand = null;

    return pending;
  }
}

function slugMatches(
  cwd: string,
  projectDirName: string,
  platform: NodeJS.Platform,
): boolean {
  const fold = caseInsensitivePaths(platform)
    ? (value: string) => value.toLowerCase()
    : (value: string) => value;

  const slug = fold(claudeProjectSlug(cwd));
  const dirName = fold(projectDirName);

  if (slug === dirName) return true;

  if (slug.length <= PROJECT_SLUG_MAX_CHARS) return false;
  const hashedPrefix = `${slug.slice(0, PROJECT_SLUG_MAX_CHARS)}-`;

  return (
    dirName.length > hashedPrefix.length && dirName.startsWith(hashedPrefix)
  );
}

function forkedFromSessionId(record: JsonRecord | null): string | null {
  const forkedFrom = recordField(record, "forkedFrom");

  if (forkedFrom === null) return null;
  const sessionId = stringField(forkedFrom, "sessionId");

  return sessionId !== null && sessionId.length > 0 && sessionId.length <= 256
    ? sessionId
    : null;
}

interface ClaudeHeadScan {
  sawMessageLine: boolean;
  sawMainLine: boolean;
  forkedFrom: string | null;
  identityConfirmed: boolean;
  entrypoint: string | null;
  firstCwd: string | null;
  matchedCwd: string | null;
  firstPrompt: string | null;
  createdAt: number | null;
  lastMessageAt: number | null;
  customTitle: string | null;
  aiTitle: string | null;
}

function readTitle(record: JsonRecord | null, key: string): string | null {
  const title = stringField(record, key)?.trim();

  return title ? title : null;
}

async function scanClaudeHead(
  session: ClaudeSessionFile,
  platform: NodeJS.Platform,
  signal?: AbortSignal,
): Promise<ClaudeHeadScan> {
  const scan: ClaudeHeadScan = {
    sawMessageLine: false,
    sawMainLine: false,
    forkedFrom: null,
    identityConfirmed: false,
    entrypoint: null,
    firstCwd: null,
    matchedCwd: null,
    firstPrompt: null,
    createdAt: null,
    lastMessageAt: null,
    customTitle: null,
    aiTitle: null,
  };

  const stats = createLineReadStats();
  const prompts = new ClaudePromptTracker();
  let lineCount = 0;

  for await (const line of readLines(session.filePath, { signal, stats })) {
    lineCount += 1;

    if (
      lineCount > HEAD_SCAN_LIMITS.maxLines ||
      stats.bytesRead > HEAD_SCAN_LIMITS.maxBytes
    )
      break;
    const record = parseJsonRecord(line);
    const type = stringField(record, "type");

    if (type === "custom-title")
      scan.customTitle = readTitle(record, "customTitle") ?? scan.customTitle;

    if (type === "ai-title")
      scan.aiTitle = readTitle(record, "aiTitle") ?? scan.aiTitle;

    if (type === null || !MESSAGE_LINE_TYPES.has(type)) continue;
    scan.sawMessageLine = true;
    const timestamp = parseTimestamp(record?.timestamp);

    scan.createdAt ??= timestamp;

    if (stringField(record, "sessionId") === session.sessionId)
      scan.identityConfirmed = true;

    if (record?.isSidechain === true) continue;
    scan.sawMainLine = true;
    scan.forkedFrom ??= forkedFromSessionId(record);
    scan.entrypoint ??= stringField(record, "entrypoint");
    const cwd = stringField(record, "cwd");

    if (cwd) {
      scan.firstCwd ??= cwd;

      if (
        scan.matchedCwd === null &&
        slugMatches(cwd, session.projectDirName, platform)
      )
        scan.matchedCwd = cwd;
    }

    if ((type === "user" || type === "assistant") && timestamp !== null)
      scan.lastMessageAt = Math.max(scan.lastMessageAt ?? 0, timestamp);

    if (
      scan.firstPrompt === null &&
      (type === "user" || type === "assistant" || isLocalCommandOutput(record))
    ) {
      const { resolved, prompt } = prompts.observe(record, timestamp);

      scan.firstPrompt = resolved?.text ?? prompt?.text ?? null;
    }

    if (
      scan.entrypoint !== null &&
      scan.firstPrompt !== null &&
      scan.matchedCwd !== null &&
      scan.identityConfirmed
    )
      break;
  }

  scan.firstPrompt ??= prompts.flush()?.text ?? null;

  return scan;
}

interface ClaudeTailScan {
  readonly lastMessageAt: number | null;
  readonly customTitle: string | null;
  readonly aiTitle: string | null;
}

async function scanClaudeTail(filePath: string): Promise<ClaudeTailScan> {
  let customTitle: string | null = null;
  let aiTitle: string | null = null;

  for (const windowBytes of TAIL_WINDOWS_BYTES) {
    const tail = await readTailLines(filePath, windowBytes);
    let lastMessageAt: number | null = null;

    customTitle = null;
    aiTitle = null;

    for (let index = tail.lines.length - 1; index >= 0; index -= 1) {
      const record = parseJsonRecord(tail.lines[index] ?? "");
      const type = stringField(record, "type");

      if (type === "custom-title")
        customTitle ??= readTitle(record, "customTitle");
      else if (type === "ai-title") aiTitle ??= readTitle(record, "aiTitle");
      else if (
        lastMessageAt === null &&
        (type === "user" || type === "assistant") &&
        record?.isSidechain !== true
      )
        lastMessageAt = parseTimestamp(record?.timestamp);
    }

    if (lastMessageAt !== null || tail.reachedStart)
      return { lastMessageAt, customTitle, aiTitle };
  }

  return { lastMessageAt: null, customTitle, aiTitle };
}

export interface ClaudeSummaryOptions {
  readonly cutoffMs: number;
  readonly platform: NodeJS.Platform;
  readonly signal?: AbortSignal;
}

export async function summarizeClaudeSession(
  session: ClaudeSessionFile,
  fileStats: Stats,
  options: ClaudeSummaryOptions,
): Promise<NativeSummaryResult> {
  const head = await scanClaudeHead(session, options.platform, options.signal);

  if (!head.sawMessageLine)
    return { kind: "dropped", reason: "no-user-message" };

  if (!head.sawMainLine) return { kind: "dropped", reason: "subagent-session" };

  const client =
    head.entrypoint === null
      ? undefined
      : INTERACTIVE_ENTRYPOINTS.get(head.entrypoint);

  if (client === undefined)
    return { kind: "dropped", reason: "scripted-session" };

  if (!head.identityConfirmed || session.sessionId.length > 256)
    return { kind: "dropped", reason: "unreadable" };
  const cwd = head.matchedCwd ?? head.firstCwd;

  if (cwd === null || cwd.length > 4096)
    return { kind: "dropped", reason: "unreadable" };
  const tail = await scanClaudeTail(session.filePath);
  const lastMessageAt = tail.lastMessageAt ?? head.lastMessageAt;

  if (lastMessageAt !== null && lastMessageAt < options.cutoffMs)
    return { kind: "dropped", reason: "older-than-window" };

  if (head.firstPrompt === null || lastMessageAt === null)
    return { kind: "dropped", reason: "no-user-message" };

  const name =
    tail.customTitle ?? head.customTitle ?? tail.aiTitle ?? head.aiTitle;

  return {
    kind: "chat",
    chat: {
      providerId: "claude-code",
      sourceProviderThreadId: session.sessionId,
      sourcePath: session.filePath,
      cwd,
      cwdMatchesStore: head.matchedCwd !== null,
      title: name === null ? promptTitle(head.firstPrompt) : chatTitle(name),
      firstPrompt: firstPromptPreview(head.firstPrompt),
      createdAt: Math.min(head.createdAt ?? lastMessageAt, lastMessageAt),
      lastMessageAt,
      client,
      sizeBytes: fileStats.size,
      forkedFromProviderThreadId: head.forkedFrom,
    },
  };
}

interface PendingTool {
  readonly name: string;
  readonly input: JsonRecord | null;
  readonly location: DraftItemLocation;
  readonly displayPath: string | null;
}

function toolResultText(content: unknown): string {
  if (typeof content === "string") return content;

  return arrayField({ content }, "content")
    .map(asRecord)
    .filter((block) => stringField(block, "type") === "text")
    .map((block) => stringField(block, "text") ?? "")
    .join("\n");
}

function jsonArguments(input: JsonRecord | null): string | null {
  if (input === null) return null;

  try {
    return JSON.stringify(input);
  } catch {
    return null;
  }
}

function parseHunks(value: unknown): DiffHunk[] {
  if (!Array.isArray(value)) return [];
  const hunks: DiffHunk[] = [];

  for (const entry of value) {
    const hunk = asRecord(entry);
    const oldStart = numberField(hunk, "oldStart");
    const oldLines = numberField(hunk, "oldLines");
    const newStart = numberField(hunk, "newStart");
    const newLines = numberField(hunk, "newLines");

    const lines = arrayField(hunk, "lines").filter(
      (line): line is string => typeof line === "string",
    );

    if (
      oldStart === null ||
      oldLines === null ||
      newStart === null ||
      newLines === null
    )
      return [];
    hunks.push({ oldStart, oldLines, newStart, newLines, lines });
  }

  return hunks;
}

function editHunks(name: string, input: JsonRecord | null): DiffHunk[] {
  if (name === "MultiEdit") {
    return arrayField(input, "edits")
      .map(asRecord)
      .map((edit) =>
        replacementHunk(
          stringField(edit, "old_string") ?? "",
          stringField(edit, "new_string") ?? "",
        ),
      );
  }

  return [
    replacementHunk(
      stringField(input, "old_string") ?? "",
      stringField(input, "new_string") ?? "",
    ),
  ];
}

function fileEditDraft(
  name: string,
  nativeId: string | null,
  input: JsonRecord | null,
  displayPath: string,
  filePath: string,
  result: JsonRecord | null,
): DraftItem {
  const patch = parseHunks(result?.structuredPatch);

  if (name === "Write") {
    const content = stringField(input, "content") ?? "";
    const kind = stringField(result, "type") === "update" ? "update" : "add";
    let diff: string;

    if (patch.length > 0) diff = hunksDiff(displayPath, patch);
    else if (kind === "add") diff = contentDiff(displayPath, "add", content);
    else
      diff = hunksDiff(displayPath, [
        replacementHunk(stringField(result, "originalFile") ?? "", content),
      ]);

    return {
      type: "fileChange",
      nativeId,
      changes: [{ path: filePath, kind, diff }],
    };
  }

  return {
    type: "fileChange",
    nativeId,
    changes: [
      {
        path: filePath,
        kind: "update",
        diff: hunksDiff(
          displayPath,
          patch.length > 0 ? patch : editHunks(name, input),
        ),
      },
    ],
  };
}

function toolUseDraft(
  block: JsonRecord,
  cwd: string | null,
): { draft: DraftItem; displayPath: string | null } {
  const nativeId = stringField(block, "id");
  const name = stringField(block, "name") ?? "tool";
  const input = recordField(block, "input");
  const filePath = stringField(input, "file_path");

  if (name === "Bash") {
    return {
      draft: {
        type: "commandExecution",
        nativeId,
        command: stringField(input, "command") ?? "",
        cwd,
        output: "",
        exitCode: null,
        durationMs: null,
      },
      displayPath: null,
    };
  }

  if (FILE_EDIT_TOOLS.has(name) && filePath) {
    const displayPath = diffDisplayPath(filePath, cwd);

    return {
      draft: fileEditDraft(name, nativeId, input, displayPath, filePath, null),
      displayPath,
    };
  }

  return {
    draft: {
      type: "toolCall",
      nativeId,
      tool: name,
      server: null,
      arguments: jsonArguments(input),
      result: null,
      error: null,
    },
    displayPath: null,
  };
}

function bashOutput(
  resultText: string,
  toolUseResult: JsonRecord | null,
): string {
  const joined = [
    stringField(toolUseResult, "stdout"),
    stringField(toolUseResult, "stderr"),
  ]
    .filter((part): part is string => part !== null && part.length > 0)
    .join("\n");

  return joined.length > 0 ? joined : resultText;
}

function resolvedToolDraft(
  pending: PendingTool,
  block: JsonRecord,
  toolUseResult: JsonRecord | null,
): DraftItem {
  const current = pending.location.turn.items[pending.location.index];
  const nativeId = current?.nativeId ?? null;
  const resultText = toolResultText(block.content);
  const isError = block.is_error === true;

  if (current?.type === "commandExecution") {
    return {
      ...current,
      output: bashOutput(resultText, toolUseResult),
      exitCode: isError ? 1 : 0,
    };
  }

  if (current?.type === "fileChange" && pending.displayPath !== null) {
    if (isError) {
      return {
        type: "toolCall",
        nativeId,
        tool: pending.name,
        server: null,
        arguments: jsonArguments(pending.input),
        result: null,
        error: resultText,
      };
    }

    return fileEditDraft(
      pending.name,
      nativeId,
      pending.input,
      pending.displayPath,
      stringField(pending.input, "file_path") ?? "",
      toolUseResult,
    );
  }

  return {
    type: "toolCall",
    nativeId,
    tool: pending.name,
    server: null,
    arguments: jsonArguments(pending.input),
    result: isError ? null : resultText,
    error: isError ? resultText : null,
  };
}

interface TextCursor {
  readonly messageId: string;
  readonly location: DraftItemLocation;
}

function extendAgentText(
  cursor: TextCursor | null,
  messageId: string,
  text: string,
): boolean {
  if (cursor === null || messageId.length === 0) return false;

  if (cursor.messageId !== messageId) return false;
  const { turn, index } = cursor.location;
  const item = turn.items[index];

  if (index !== turn.items.length - 1 || item?.type !== "agentMessage")
    return false;
  turn.items[index] = { ...item, text: `${item.text}\n\n${text}` };

  return true;
}

function queuedHumanPrompt(record: JsonRecord): string | null {
  if (
    stringField(record, "type") !== "attachment" ||
    record.isSidechain === true
  )
    return null;
  const attachment = recordField(record, "attachment");

  if (
    stringField(attachment, "type") !== "queued_command" ||
    stringField(attachment, "commandMode") !== "prompt" ||
    attachment?.isMeta === true
  )
    return null;
  const originKind = stringField(recordField(attachment, "origin"), "kind");

  if (originKind !== null && originKind !== "human") return null;
  const text = textBlocks(attachment?.prompt)?.trim();

  if (!text || WRAPPER_PREFIXES.some((prefix) => text.startsWith(prefix)))
    return null;

  return text;
}

export interface ClaudeTranscript {
  readonly turns: DraftTurn[];
  readonly skippedLines: number;
  readonly identityMatches: boolean;
}

export async function readClaudeTranscript(
  filePath: string,
  expectedId: string,
  signal?: AbortSignal,
): Promise<ClaudeTranscript> {
  const stats = createLineReadStats();
  const accumulator = new TurnAccumulator();
  const pendingTools = new Map<string, PendingTool>();
  const prompts = new ClaudePromptTracker();
  let skippedLines = 0;
  let identityMatches = false;
  let lastText: TextCursor | null = null;
  let queuedTurn: DraftTurn | null = null;

  for await (const line of readLines(filePath, { signal, stats })) {
    const record = parseJsonRecord(line);

    if (record === null) {
      skippedLines += 1;
      continue;
    }

    const type = stringField(record, "type");

    if (type === "system") {
      if (record.isSidechain !== true && isLocalCommandOutput(record))
        prompts.observe(record, parseTimestamp(record.timestamp));
      continue;
    }

    const queued = queuedHumanPrompt(record);

    if (queued !== null) {
      accumulator.startTurn(queued, parseTimestamp(record.timestamp));
      lastText = null;
      queuedTurn = accumulator.openTurn;
      continue;
    }

    if (type !== "user" && type !== "assistant") continue;

    if (stringField(record, "sessionId") === expectedId) identityMatches = true;

    if (record.isSidechain === true) continue;
    const at = parseTimestamp(record.timestamp);
    const { resolved, prompt } = prompts.observe(record, at);

    for (const started of [resolved, prompt]) {
      if (started === null) continue;

      if (
        queuedTurn !== null &&
        queuedTurn === accumulator.openTurn &&
        queuedTurn.items.length === 0 &&
        queuedTurn.userText === started.text
      ) {
        queuedTurn = null;
        continue;
      }

      queuedTurn = null;
      accumulator.startTurn(started.text, started.at);
      pendingTools.clear();
      lastText = null;
    }

    if (prompt !== null || promptCandidate(record)?.command === true) continue;

    if (type === "user") {
      if (isInterruptMarker(record)) {
        if (accumulator.openTurn !== null) accumulator.markInterrupted(at);
        continue;
      }

      const content = messageContent(record);

      if (!Array.isArray(content)) continue;
      const toolUseResult = recordField(record, "toolUseResult");

      for (const block of content.map(asRecord)) {
        if (block === null || stringField(block, "type") !== "tool_result")
          continue;

        const pending = pendingTools.get(
          stringField(block, "tool_use_id") ?? "",
        );

        if (pending === undefined) continue;
        pending.location.turn.items[pending.location.index] = resolvedToolDraft(
          pending,
          block,
          toolUseResult,
        );
        pendingTools.delete(stringField(block, "tool_use_id") ?? "");
      }

      accumulator.touch(at);
      continue;
    }

    if (accumulator.openTurn === null) continue;
    const message = recordField(record, "message");
    const messageId = stringField(message, "id") ?? "";
    const cwd = stringField(record, "cwd");

    for (const block of arrayField(message, "content").map(asRecord)) {
      const blockType = stringField(block, "type");

      if (block === null) continue;

      if (blockType === "text") {
        const text = stringField(block, "text")?.trim();

        if (!text) continue;

        if (extendAgentText(lastText, messageId, text)) {
          accumulator.touch(at);
          continue;
        }

        const location = accumulator.addItem(
          {
            type: "agentMessage",
            nativeId: messageId.length > 0 ? messageId : null,
            text,
          },
          at,
        );

        lastText = location === null ? null : { messageId, location };
        continue;
      }

      if (blockType === "tool_use") {
        const { draft, displayPath } = toolUseDraft(block, cwd);
        const location = accumulator.addItem(draft, at);
        const toolId = stringField(block, "id");

        if (location !== null && toolId !== null) {
          pendingTools.set(toolId, {
            name: stringField(block, "name") ?? "tool",
            input: recordField(block, "input"),
            location,
            displayPath,
          });
        }

        lastText = null;
      }
    }

    accumulator.touch(at);
  }

  accumulator.closeTurn("completed", null);

  return {
    turns: accumulator.turns,
    skippedLines: skippedLines + stats.oversizedLines,
    identityMatches,
  };
}
