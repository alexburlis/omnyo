import path from "node:path";
import {
  HISTORY_LIMITS,
  type NativeChatSummary,
  type NativeHistoryItem,
  type NativeHistoryTurn,
  type ScanDropReason,
} from "../host-contract.js";

export type NativeChatCore = Omit<
  NativeChatSummary,
  "cwdExists" | "realCwd" | "projectRoot"
>;

export type NativeSummaryResult =
  | { readonly kind: "chat"; readonly chat: NativeChatCore }
  | { readonly kind: "dropped"; readonly reason: ScanDropReason };

export const HEAD_SCAN_LIMITS = {
  maxBytes: 8 * 1024 * 1024,
  maxLines: 4000,
} as const;

export const TAIL_WINDOWS_BYTES = [256 * 1024, 16 * 1024 * 1024] as const;

export interface DraftItemLocation {
  readonly turn: DraftTurn;
  readonly index: number;
}

export const TITLE_MAX_CHARS = 120;

export const PROMPT_TITLE_CHARS = 80;

export const FIRST_PROMPT_MAX_CHARS = 200;

const ELLIPSIS = "…";

function safeCut(text: string, length: number): string {
  if (length <= 0) return "";
  const code = text.charCodeAt(length - 1);
  const end = code >= 0xd800 && code <= 0xdbff ? length - 1 : length;

  return text.slice(0, end);
}

function safeTail(text: string, length: number): string {
  if (length <= 0) return "";
  let start = text.length - length;
  const code = text.charCodeAt(start);

  if (code >= 0xdc00 && code <= 0xdfff) start += 1;

  return text.slice(start);
}

export function truncateText(text: string, max: number): string {
  if (text.length <= max) return text;

  return safeCut(text, max - ELLIPSIS.length) + ELLIPSIS;
}

export function truncateHeadTail(text: string, max: number): string {
  if (text.length <= max) return text;
  const omitted = text.length - max;
  const marker = `\n… ${omitted} characters omitted …\n`;
  const budget = max - marker.length;

  if (budget <= 0) return truncateText(text, max);
  const head = Math.ceil(budget / 2);

  return safeCut(text, head) + marker + safeTail(text, budget - head);
}

export function collapseWhitespace(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

export function truncateOnWordBoundary(text: string, max: number): string {
  const collapsed = collapseWhitespace(text);

  if (collapsed.length <= max) return collapsed;
  const cut = safeCut(collapsed, max - ELLIPSIS.length);
  const lastSpace = cut.lastIndexOf(" ");
  const base = lastSpace >= Math.floor(max / 2) ? cut.slice(0, lastSpace) : cut;

  return base.trimEnd() + ELLIPSIS;
}

export function promptTitle(prompt: string): string {
  return truncateOnWordBoundary(prompt, PROMPT_TITLE_CHARS);
}

export function chatTitle(name: string): string {
  return truncateOnWordBoundary(name, TITLE_MAX_CHARS);
}

export function firstPromptPreview(prompt: string): string {
  return truncateText(collapseWhitespace(prompt), FIRST_PROMPT_MAX_CHARS);
}

export interface DraftFileChange {
  path: string;
  kind: "add" | "delete" | "update";
  diff: string | null;
}

export type DraftItem =
  | { type: "agentMessage"; nativeId: string | null; text: string }
  | {
      type: "commandExecution";
      nativeId: string | null;
      command: string;
      cwd: string | null;
      output: string;
      exitCode: number | null;
      durationMs: number | null;
    }
  | {
      type: "fileChange";
      nativeId: string | null;
      changes: DraftFileChange[];
    }
  | {
      type: "toolCall";
      nativeId: string | null;
      tool: string;
      server: string | null;
      arguments: string | null;
      result: string | null;
      error: string | null;
    };

export interface DraftTurn {
  startedAt: number;
  completedAt: number;
  status: "completed" | "interrupted";
  userText: string;
  items: DraftItem[];
}

export class TurnAccumulator {
  readonly turns: DraftTurn[] = [];

  private current: DraftTurn | null = null;

  private lastTimestamp = 0;

  private taskStart: number | null = null;

  clamp(timestamp: number | null): number {
    if (timestamp !== null && timestamp > this.lastTimestamp)
      this.lastTimestamp = timestamp;

    return this.lastTimestamp;
  }

  get openTurn(): DraftTurn | null {
    return this.current;
  }

  startTurn(userText: string, timestamp: number | null): void {
    const at = this.clamp(timestamp);

    this.closeTurn("completed", null);
    this.current = {
      startedAt: at,
      completedAt: at,
      status: "completed",
      userText,
      items: [],
    };
    this.turns.push(this.current);
  }

  private extend(turn: DraftTurn | null, timestamp: number | null): void {
    if (timestamp === null) return;
    const at = this.clamp(timestamp);

    if (turn !== null) turn.completedAt = Math.max(turn.completedAt, at);
  }

  touch(timestamp: number | null): void {
    this.extend(this.current, timestamp);
  }

  addItem(item: DraftItem, timestamp: number | null): DraftItemLocation | null {
    const turn = this.current ?? this.turns.at(-1) ?? null;

    this.extend(turn, timestamp);

    if (turn === null) return null;
    turn.items.push(item);

    return { turn, index: turn.items.length - 1 };
  }

  markInterrupted(timestamp: number | null): void {
    const turn = this.current ?? this.turns.at(-1) ?? null;

    this.extend(turn, timestamp);

    if (turn !== null) turn.status = "interrupted";
  }

  beginTask(): void {
    this.taskStart = this.turns.length - (this.current === null ? 0 : 1);
  }

  interruptTask(timestamp: number | null): void {
    if (this.taskStart === null) {
      this.markInterrupted(timestamp);

      return;
    }

    this.extend(this.current, timestamp);

    for (const turn of this.turns.slice(this.taskStart))
      turn.status = "interrupted";
  }

  closeTurn(
    status: "completed" | "interrupted",
    timestamp: number | null,
  ): void {
    this.extend(this.current, timestamp);

    if (this.current === null) return;

    if (status === "interrupted") this.current.status = "interrupted";
    this.current = null;
  }
}

function jsonByteLength(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value));
}

export class ItemIdAllocator {
  private readonly used = new Set<string>();

  allocate(nativeId: string | null, turnIndex: number): string {
    if (
      nativeId !== null &&
      nativeId.length > 0 &&
      nativeId.length <= 200 &&
      !this.used.has(nativeId)
    ) {
      this.used.add(nativeId);

      return nativeId;
    }

    let sequence = 0;
    let candidate = `imp-${turnIndex}-${sequence}`;

    while (this.used.has(candidate)) {
      sequence += 1;
      candidate = `imp-${turnIndex}-${sequence}`;
    }

    this.used.add(candidate);

    return candidate;
  }
}

function finalizeItem(item: DraftItem, id: string): NativeHistoryItem | null {
  switch (item.type) {
    case "agentMessage": {
      return {
        type: "agentMessage",
        id,
        text: truncateText(item.text, HISTORY_LIMITS.agentTextChars),
      };
    }

    case "commandExecution": {
      return {
        type: "commandExecution",
        id,
        command: truncateText(item.command, HISTORY_LIMITS.commandChars),
        cwd: item.cwd === null ? null : truncateText(item.cwd, 4096),
        output: truncateHeadTail(
          item.output,
          HISTORY_LIMITS.commandOutputChars,
        ),
        exitCode: item.exitCode === null ? null : Math.trunc(item.exitCode),
        durationMs:
          item.durationMs === null
            ? null
            : Math.max(0, Math.round(item.durationMs)),
      };
    }

    case "fileChange": {
      const changes = item.changes
        .filter((change) => change.path.length > 0)
        .slice(0, HISTORY_LIMITS.changesPerFileChange)
        .map((change) => ({
          path: truncateText(change.path, 4096),
          kind: change.kind,
          diff:
            change.diff === null
              ? null
              : truncateHeadTail(change.diff, HISTORY_LIMITS.diffChars),
        }));

      if (changes.length === 0) return null;

      return { type: "fileChange", id, changes };
    }

    case "toolCall": {
      return {
        type: "toolCall",
        id,
        tool: truncateText(item.tool, 200),
        server: item.server === null ? null : truncateText(item.server, 200),
        arguments:
          item.arguments === null
            ? null
            : truncateText(item.arguments, HISTORY_LIMITS.toolArgumentsChars),
        result:
          item.result === null
            ? null
            : truncateHeadTail(item.result, HISTORY_LIMITS.toolResultChars),
        error:
          item.error === null
            ? null
            : truncateText(item.error, HISTORY_LIMITS.toolErrorChars),
      };
    }
  }
}

export function finalizeTurns(
  drafts: readonly DraftTurn[],
): NativeHistoryTurn[] {
  const allocator = new ItemIdAllocator();

  return drafts.map((draft, turnIndex) => {
    const items: NativeHistoryItem[] = [];
    const kept = draft.items.slice(-HISTORY_LIMITS.itemsPerTurn);

    for (const item of kept) {
      const finalized = finalizeItem(
        item,
        allocator.allocate(item.nativeId, turnIndex),
      );

      if (finalized !== null) items.push(finalized);
    }

    return {
      startedAt: draft.startedAt,
      completedAt: Math.max(draft.startedAt, draft.completedAt),
      status: draft.status,
      userText: truncateText(draft.userText, HISTORY_LIMITS.userTextChars),
      items,
    };
  });
}

export interface FittedTurns {
  readonly turns: NativeHistoryTurn[];
  readonly totalTurns: number;
  readonly omittedTurns: number;
}

export function fitTurnsToBudget(
  turns: readonly NativeHistoryTurn[],
  envelope: unknown,
  maxBytes: number = HISTORY_LIMITS.serializedChatBytes,
): FittedTurns {
  const totalTurns = turns.length;
  let start = Math.max(0, totalTurns - HISTORY_LIMITS.turnsPerChat);
  const sizes = turns.map((turn) => jsonByteLength(turn) + 1);
  let total = jsonByteLength(envelope);

  for (let index = start; index < totalTurns; index += 1)
    total += sizes[index] ?? 0;

  while (start < totalTurns && total > maxBytes) {
    total -= sizes[start] ?? 0;
    start += 1;
  }

  return {
    turns: turns.slice(start),
    totalTurns,
    omittedTurns: start,
  };
}

function splitLines(text: string): string[] {
  if (text.length === 0) return [];
  const lines = text.split("\n");

  if (lines.at(-1) === "") lines.pop();

  return lines;
}

function diffHeader(oldPath: string | null, newPath: string | null): string {
  return `--- ${oldPath === null ? "/dev/null" : `a/${oldPath}`}\n+++ ${newPath === null ? "/dev/null" : `b/${newPath}`}\n`;
}

export function diffDisplayPath(filePath: string, cwd: string | null): string {
  if (cwd !== null && path.isAbsolute(filePath)) {
    const relative = path.relative(cwd, filePath);

    if (
      relative !== "" &&
      !relative.startsWith("..") &&
      !path.isAbsolute(relative)
    )
      return relative.split(path.sep).join("/");
  }

  return filePath
    .replace(/^[\\/]+/, "")
    .split("\\")
    .join("/");
}

export function contentDiff(
  displayPath: string,
  kind: "add" | "delete",
  content: string,
): string {
  const lines = splitLines(content);

  if (kind === "add") {
    return (
      diffHeader(null, displayPath) +
      `@@ -0,0 +1,${lines.length} @@\n` +
      lines.map((line) => `+${line}\n`).join("")
    );
  }

  return (
    diffHeader(displayPath, null) +
    `@@ -1,${lines.length} +0,0 @@\n` +
    lines.map((line) => `-${line}\n`).join("")
  );
}

export function withDiffHeader(
  displayPath: string,
  diff: string,
  movedToDisplayPath: string | null = null,
): string {
  if (diff.startsWith("--- ")) return diff;

  return diffHeader(displayPath, movedToDisplayPath ?? displayPath) + diff;
}

export interface DiffHunk {
  readonly oldStart: number;
  readonly oldLines: number;
  readonly newStart: number;
  readonly newLines: number;
  readonly lines: readonly string[];
}

export function hunksDiff(
  displayPath: string,
  hunks: readonly DiffHunk[],
): string {
  return (
    diffHeader(displayPath, displayPath) +
    hunks
      .map(
        (hunk) =>
          `@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@\n` +
          hunk.lines.map((line) => `${line}\n`).join(""),
      )
      .join("")
  );
}

export function replacementHunk(oldText: string, newText: string): DiffHunk {
  const oldLines = splitLines(oldText);
  const newLines = splitLines(newText);

  return {
    oldStart: 1,
    oldLines: oldLines.length,
    newStart: 1,
    newLines: newLines.length,
    lines: [
      ...oldLines.map((line) => `-${line}`),
      ...newLines.map((line) => `+${line}`),
    ],
  };
}
