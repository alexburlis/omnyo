import type { experimental_PluginBrowserSdk } from "@omnyo/plugin-sdk/app";
import type { DotKind } from "../components/state-dot.tsx";
import { upcomingDay, upcomingLabel } from "./feed.ts";
import { familyRoots } from "./family-roots.ts";
import { z } from "zod";

type InboxArea = experimental_PluginBrowserSdk["experimental_inbox"];

export type InboxSnapshot = Awaited<ReturnType<InboxArea["snapshot"]>>;

export type InboxEntry = InboxSnapshot["inbox"][number];

export type InboxCard = NonNullable<InboxEntry["card"]>;

export type InboxPrimary = InboxCard["primary"];

/** What a waiting chat waits for; mirrors the host's `inboxWaitingKindSchema`. */
export type InboxWaitingKind = "check" | "scheduled" | "retry" | "chat" | "event";

/**
 * Newer hosts also send `kind`. The plugin updates independently of
 * the host, so an older host's row has no `kind` and `waitingKind` reads it
 * from the fields every host sends.
 */
export type InboxWaitingRow = NonNullable<InboxEntry["waiting"]> & { kind?: InboxWaitingKind };

export type InboxCounts = InboxSnapshot["counts"];

export type InboxView = InboxEntry["view"];

export type InboxActRequest = Parameters<InboxArea["act"]>[0]["request"];

export type InboxRun = NonNullable<InboxEntry["runs"]>[number];

type InboxAction = InboxCard["actions"][number];

export const DISPLAY_MAX = 3;

export const UNDO_TOAST_MS = 10_000;

export const CARD_LABEL: Readonly<Record<InboxCard["kind"], string>> = {
  question: "Question",
  result: "Result",
  returned: "Returned",
  problem: "Problem",
  runs: "Runs",
  chain: "Chain",
};

export const VIEW_LABEL: Readonly<Record<InboxView, string>> = {
  inbox: "Inbox",
  waiting: "Waiting",
  running: "Running",
  resting: "Resting",
  archive: "Archive",
};

export type InboxCommand = "archive" | "wait" | "reply" | "shelf" | "happened" | "open" | "retry";

export interface ChoiceItem {
  digit: number;
  label: string;
  command: InboxCommand;
}

export type CardIntent =
  | { kind: "act"; request: InboxActRequest }
  | { kind: "command"; command: InboxCommand }
  | { kind: "choose"; items: readonly ChoiceItem[] }
  | { kind: "answer" };

export type WaitChoice =
  | { digit: number; label: string; step: "date"; until: number }
  | { digit: number; label: string; step: "pick" | "report" };

export type KeyCommand =
  | "next"
  | "previous"
  | "primary"
  | "undo"
  | "bulk"
  | "escape"
  | Exclude<InboxCommand, "retry">;

export type KeyResult = { kind: "command"; command: KeyCommand } | { kind: "digit"; digit: number };

export interface KeyInput {
  key: string;
  shiftKey: boolean;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
}

export interface StatusThread {
  id: string;
  projectId: string;
  parentThreadId: string | null;
  status: string;
}

export interface AskingThread {
  id: string;
  experimental_work?: {
    requiredInput: readonly { id: string }[];
    optionalInput: readonly { id: string }[];
  } | null;
}

export interface CardActionLine {
  primary: boolean;
  actions: readonly InboxAction[];
}

const YOUR_CALL: readonly ChoiceItem[] = [
  { digit: 1, label: "Archive", command: "archive" },
  { digit: 2, label: "Reply", command: "reply" },
  { digit: 3, label: "Wait", command: "wait" },
  { digit: 4, label: "Shelf", command: "shelf" },
];

const LETTER_KEYS: ReadonlyMap<string, KeyCommand> = new Map([
  ["j", "next"],
  ["k", "previous"],
  ["e", "archive"],
  ["w", "wait"],
  ["r", "reply"],
  ["s", "shelf"],
  ["h", "happened"],
  ["o", "open"],
  ["z", "undo"],
]);

const NAMED_KEYS: ReadonlyMap<string, KeyCommand> = new Map([
  ["ArrowDown", "next"],
  ["ArrowUp", "previous"],
  ["Enter", "primary"],
  ["Escape", "escape"],
]);

const PRIMARY_ACTION: ReadonlyMap<InboxPrimary["kind"], InboxAction> = new Map([
  ["archive", "archive"],
  ["reply", "reply"],
]);

const BUSY: ReadonlySet<string> = new Set(["active", "starting", "stopping"]);

const DATE_INPUT = /^(\d{4})-(\d{2})-(\d{2})$/;

function chatsWaitingPhrase(titles: readonly string[]): string {
  const last = titles.at(-1) ?? "A chat";

  const names = titles.length <= 1 ? last : `${titles.slice(0, -1).join(", ")} and ${last}`;

  return `${names} ${titles.length > 1 ? "are" : "is"} waiting`;
}

function plural(count: number, word: string): string {
  return `${count} ${word}${count === 1 ? "" : "s"}`;
}

export function displayedReceiptIds(card: InboxCard, focused: boolean): string[] {
  const ids = card.causes.map((cause) => cause.receiptId);

  return focused ? ids : ids.slice(0, DISPLAY_MAX);
}

export function cardKind(card: InboxCard): string {
  return card.kind === "question" && card.questionFrom !== null
    ? `Question from ${card.questionFrom}`
    : CARD_LABEL[card.kind];
}

export function cardActionLine(card: InboxCard): CardActionLine {
  const direct = PRIMARY_ACTION.get(card.primary.kind);

  return {
    primary: card.primary.kind !== "your-call",
    actions: card.actions.filter((action) => action !== direct),
  };
}

export function primaryLabel(primary: InboxPrimary, now: number, touch: boolean): string {
  switch (primary.kind) {
    case "answer":
      return "Answer";
    case "accept-proposal":
      return primary.label;
    case "ok":
      return "OK";
    case "reply":
      return "Reply";
    case "archive":
      return "Archive";
    case "your-call":
      return touch ? "Open" : "Your call";
    case "problem-chooser":
      return "Your call";
    case "resume":
      return primary.targetTitle === null ? "Resume" : `Resume ${primary.targetTitle}`;
    case "keep-waiting":
      return `Keep waiting until ${upcomingLabel(now, primary.until)}`;
    case "remind-later":
      return "Remind me in 14 days";
    case "continue-with-result":
      return "Continue with it";
    case "archive-runs":
      return primary.mode === "done"
        ? `Archive ${plural(primary.threadIds.length, "done run")}`
        : `Keep latest · archive ${primary.threadIds.length} older`;
    case "resume-all-at-reset":
      return `Resume all at reset · ${upcomingLabel(now, primary.resetAt)}`;
  }
}

function primaryLines(card: InboxCard): string[] {
  const primary = card.primary;

  if (primary.kind === "ok")
    return primary.thenWaits === null ? [] : [`Then waits: ${primary.thenWaits}`];

  if (primary.kind === "reply")
    return primary.waiterTitles.length === 0
      ? []
      : [`${chatsWaitingPhrase(primary.waiterTitles)} on this chat's result`];

  if (primary.kind !== "your-call" || card.kind === "problem") return [];

  return [card.notAssessed === null ? "Nothing next" : `Not assessed: ${card.notAssessed}`];
}

export function cardLines(card: InboxCard, now: number): string[] {
  const lines: string[] = [];
  const failure = card.failure;

  if (failure !== null) {
    lines.push(`Failed: ${failure.reason}`);

    if (failure.queuedCount > 0)
      lines.push(`${plural(failure.queuedCount, "queued message")} waiting`);

    if (failure.scheduledCount > 0)
      lines.push(`${plural(failure.scheduledCount, "scheduled message")} waiting`);
  }

  if (card.stillOnYou !== null) lines.push(`Still on you: ${card.stillOnYou}`);

  if (card.snoozedQuestionUntil !== null)
    lines.push(`Question waits until ${upcomingLabel(now, card.snoozedQuestionUntil)}`);

  return [...lines, ...primaryLines(card)];
}

export function cardSummary(card: InboxCard, now: number): string {
  const causes = new Map<string, number>();

  for (const cause of card.causes) {
    const line =
      cause.fromTitle === null ? cause.summary : `${cause.summary} · from ${cause.fromTitle}`;

    causes.set(line, (causes.get(line) ?? 0) + 1);
  }

  const lines = [...causes].map(([line, count]) => (count === 1 ? line : `${line} ×${count}`));

  return [cardKind(card), ...lines, ...cardLines(card, now)].join("\n");
}

function shownOf(entry: InboxEntry, card: InboxCard, focused: boolean) {
  return {
    threadId: entry.threadId,
    displayedReceiptIds: displayedReceiptIds(card, focused),
    latch: entry.latch,
  };
}

function problemChoices(retryAllowed: boolean): ChoiceItem[] {
  const rest: ChoiceItem[] = [
    { digit: 2, label: "Reply", command: "reply" },
    { digit: 3, label: "Archive", command: "archive" },
  ];

  return retryAllowed ? [{ digit: 1, label: "Retry", command: "retry" }, ...rest] : rest;
}

export function primaryIntent(
  entry: InboxEntry,
  card: InboxCard,
  focused: boolean,
  touch: boolean,
): CardIntent {
  const primary = card.primary;
  const shown = shownOf(entry, card, focused);

  switch (primary.kind) {
    case "answer":
      return { kind: "answer" };
    case "accept-proposal":
      return primary.waitId === null
        ? { kind: "command", command: "open" }
        : { kind: "act", request: { action: "accept-proposal", ...shown, waitId: primary.waitId } };
    case "ok":
      return { kind: "act", request: { action: "ok", ...shown } };
    case "reply":
      return { kind: "command", command: "reply" };
    case "archive":
      return { kind: "command", command: "archive" };
    case "your-call":
      return touch ? { kind: "command", command: "open" } : { kind: "choose", items: YOUR_CALL };
    case "problem-chooser":
      return { kind: "choose", items: problemChoices(primary.retryAllowed) };
    case "resume":
      return {
        kind: "act",
        request: { action: "resume", ...shown, targetThreadId: primary.targetThreadId },
      };
    case "keep-waiting":
      return {
        kind: "act",
        request: {
          action: "keep-waiting",
          ...shown,
          waitId: primary.waitId,
          until: primary.until,
        },
      };
    case "remind-later":
      return { kind: "act", request: { action: "remind-later", ...shown, waitId: primary.waitId } };
    case "continue-with-result":
      return {
        kind: "act",
        request: { action: "continue-with-result", ...shown, waitId: primary.waitId },
      };
    case "archive-runs":
      return {
        kind: "act",
        request: {
          action: "archive-runs",
          threadId: entry.threadId,
          threadIds: primary.threadIds,
          latch: entry.latch,
        },
      };
    case "resume-all-at-reset":
      return {
        kind: "act",
        request: {
          action: "resume-all-at-reset",
          threadId: entry.threadId,
          threadIds: primary.threadIds,
          latch: entry.latch,
        },
      };
  }
}

export function runEntry(entry: InboxEntry, run: InboxRun): InboxEntry {
  return {
    ...entry,
    threadId: run.threadId,
    title: run.title,
    card: {
      kind: "result",
      causes: run.causes,
      primary: run.primary,
      actions: [],
      questionIds: [],
      questionMode: null,
      questionFrom: null,
      snoozedQuestionUntil: null,
      stillOnYou: null,
      notAssessed: null,
      failure: null,
      since: run.since,
    },
    runs: null,
    incident: null,
    latch: run.latch,
  };
}

export function archiveRequest(
  entry: InboxEntry,
  focused: boolean,
  stopRunning: boolean,
): InboxActRequest {
  return {
    action: "archive",
    threadId: entry.threadId,
    displayedReceiptIds: entry.card === null ? [] : displayedReceiptIds(entry.card, focused),
    stopRunning,
    latch: entry.latch,
  };
}

function nineOn(now: number, days: number): number {
  const date = new Date(now);

  date.setDate(date.getDate() + days);
  date.setHours(9, 0, 0, 0);

  return date.getTime();
}

export function waitChoices(card: InboxCard, now: number): WaitChoice[] {
  const keep = card.primary.kind === "keep-waiting";
  const monday = nineOn(now, (8 - new Date(now).getDay()) % 7 || 7);

  const dated = (digit: number, label: string, until: number): WaitChoice => ({
    digit,
    label: keep ? `Keep waiting until ${upcomingLabel(now, until)}` : label,
    step: "date",
    until,
  });

  return [
    dated(1, "Tomorrow 09:00", nineOn(now, 1)),
    dated(2, "Monday 09:00", monday),
    { digit: 3, label: "Pick a date", step: "pick" },
    { digit: 4, label: "On you (When I report it)", step: "report" },
  ];
}

export function waitRequest(
  entry: InboxEntry,
  card: InboxCard,
  focused: boolean,
  until: number,
): InboxActRequest {
  const shown = shownOf(entry, card, focused);
  const primary = card.primary;

  return primary.kind === "keep-waiting"
    ? { action: "keep-waiting", ...shown, waitId: primary.waitId, until }
    : { action: "wait", ...shown, until };
}

export function reportRequest(
  entry: InboxEntry,
  card: InboxCard,
  focused: boolean,
  event: string,
): InboxActRequest {
  return { action: "wait-report", ...shownOf(entry, card, focused), event };
}

export function pickedDate(value: string): number | null {
  const match = DATE_INPUT.exec(value);

  if (match === null) return null;
  const date = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]), 9, 0, 0, 0);

  return Number.isNaN(date.getTime()) ? null : date.getTime();
}

export function dateInputValue(at: number): string {
  const date = new Date(at);
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");

  return `${date.getFullYear()}-${month}-${day}`;
}

export function happenedWaitId(entry: InboxEntry): string | null {
  if (entry.waiting?.group === "on-you") return entry.waiting.waitId;

  return entry.card?.primary.kind === "remind-later" ? entry.card.primary.waitId : null;
}

export function replyTarget(entry: InboxEntry): string {
  return entry.card?.failure?.threadId ?? entry.threadId;
}

export function bulkArchive(
  entries: readonly InboxEntry[],
  busy: ReadonlySet<string>,
): InboxEntry[] {
  return entries.filter(
    (entry) =>
      entry.card !== null &&
      entry.card.primary.kind === "archive" &&
      entry.card.kind !== "runs" &&
      !entry.shelved &&
      !busy.has(entry.threadId),
  );
}

export function moveLabel(request: InboxActRequest, now: number): string {
  switch (request.action) {
    case "ok":
      return "Cleared";
    case "archive":
      return "Archived";
    case "wait":
    case "keep-waiting":
      return `Waits until ${upcomingLabel(now, request.until)}`;
    case "wait-report":
      return `On you: ${request.event}`;
    case "accept-proposal":
      return "Accepted";
    case "remind-later":
      return "Reminds you in 14 days";
    case "shelf":
      return request.shelved ? "On the Shelf" : "Off the Shelf";
    case "snooze-question":
      return `Question waits until ${upcomingLabel(now, request.until)}`;
    case "cancel-wait":
      return "Stopped waiting";
    case "archive-runs":
      return `Archived ${plural(request.threadIds.length, "run")}`;
    case "resume-all-at-reset":
      return `${plural(request.threadIds.length, "chat")} resume at the reset`;
    case "happened":
    case "resume":
    case "continue-with-result":
      return "Sent";
  }
}

const WITHOUT_MOVE: ReadonlySet<InboxActRequest["action"]> = new Set([
  "happened",
  "resume",
  "continue-with-result",
  "resume-all-at-reset",
]);

export function offersUndo(request: InboxActRequest): boolean {
  return !WITHOUT_MOVE.has(request.action);
}

export function chainsBehindPending(request: InboxActRequest): boolean {
  return !("latch" in request);
}

export function keyCommand(input: KeyInput): KeyResult | null {
  if (input.metaKey || input.ctrlKey || input.altKey) return null;

  if (input.shiftKey) return input.key === "E" ? { kind: "command", command: "bulk" } : null;

  if (/^[1-9]$/.test(input.key)) return { kind: "digit", digit: Number(input.key) };
  const command = NAMED_KEYS.get(input.key) ?? LETTER_KEYS.get(input.key.toLowerCase());

  return command === undefined ? null : { kind: "command", command };
}

export function waitingDetail(row: InboxWaitingRow, now: number): string | null {
  if (row.checking) return "Checking…";
  const retry = row.retry;

  if (retry !== null) {
    const at = retry.at === null ? "" : ` ${upcomingLabel(now, retry.at)}`;

    const attempt =
      retry.attempt === null || retry.maxAttempts === null
        ? ""
        : ` · ${retry.attempt} of ${retry.maxAttempts}`;

    return `Retrying${at}${attempt}`;
  }

  if (row.checkAt !== null) {
    const check =
      row.checkCount > 0
        ? `checked ${row.checkCount}× · next ${upcomingLabel(now, row.checkAt)}`
        : `checks ${upcomingLabel(now, row.checkAt)}`;

    return row.returnAt === null || row.returnAt <= row.checkAt
      ? check
      : `${check} · back by ${upcomingDay(now, row.returnAt)}`;
  }

  return row.returnAt === null ? null : `back ${upcomingLabel(now, row.returnAt)}`;
}

/** The titled groups of the Waiting section, top to bottom. */
export type WaitingLane = "on-you" | InboxWaitingKind;

export function waitingKind(row: InboxWaitingRow): InboxWaitingKind {
  if (row.kind !== undefined) return row.kind;

  if (row.retry !== null) return "retry";

  if (row.behind !== null) return "chat";

  if (row.checkAt !== null) return "check";

  return row.returnAt === null ? "event" : "scheduled";
}

export const WAITING_LANES: readonly WaitingLane[] = [
  "on-you",
  "check",
  "scheduled",
  "retry",
  "chat",
  "event",
];

export const WAITING_LANE_LABEL: Readonly<Record<WaitingLane, string>> = {
  "on-you": "On you",
  check: "Checking",
  scheduled: "Scheduled",
  retry: "Retrying",
  chat: "On another chat",
  event: "When something happens",
};

export function waitingLane(row: InboxWaitingRow | null): WaitingLane {
  if (row === null) return "event";

  return row.group === "on-you" ? "on-you" : waitingKind(row);
}

/** When the chat next comes back or is next looked at; null when nothing is dated. */
export function waitingNextAt(row: InboxWaitingRow, now: number): number | null {
  if (row.checking) return now;

  return earliest([row.retry?.at ?? null, row.checkAt, row.returnAt]);
}

/** Compact "how soon" for the timeline gutter: now, 55m, 20h, 2d. */
export function waitingIn(now: number, at: number): string {
  if (at - now < 60_000) return "now";
  const minutes = Math.round((at - now) / 60_000);

  if (minutes < 60) return `${minutes}m`;
  const hours = Math.round(minutes / 60);

  if (hours < 48) return `${hours}h`;

  return `${Math.round(hours / 24)}d`;
}

export interface WaitingChip {
  icon: string;
  text: string;
  warning: boolean;
}

/**
 * The trailing chip, only for what the gutter cannot say: a check running now
 * or which retry attempt is next. Times live in the gutter alone, so the title
 * keeps the row's width.
 */
export function waitingChip(row: InboxWaitingRow): WaitingChip | null {
  if (row.checking) return { icon: "Spinner", text: "Checking", warning: false };
  const retry = row.retry;

  if (retry === null) return null;

  return {
    icon: "RotateCcw",
    text:
      retry.attempt !== null && retry.maxAttempts !== null
        ? `${retry.attempt}/${retry.maxAttempts}`
        : "Retry",
    warning: true,
  };
}

/**
 * The one line under a waiting row, kept only for waits on a condition: what a
 * check looks for, the chat that reports back or the outside event. Dates and
 * retries say everything in the gutter and chip, so they get no second line.
 */
export function waitingCondition(row: InboxWaitingRow): string | null {
  const kind = waitingKind(row);

  if (row.retry !== null || kind === "scheduled" || kind === "retry") return null;

  if (kind === "chat" && row.behind !== null) return `${row.reason} · from ${row.behind}`;

  if (kind === "check" && row.checkCount > 0) return `${row.reason} · checked ${row.checkCount}×`;

  return row.reason;
}

function earliest(values: readonly (number | null)[]): number | null {
  let best: number | null = null;

  for (const value of values) if (value !== null && (best === null || value < best)) best = value;

  return best;
}

const runningProgressSchema = z.object({
  progress: z.object({
    done: z.number().int().nonnegative(),
    total: z.number().int().positive(),
  }),
});

export interface RunningProgress {
  done: number;
  total: number;
}

export function runningProgress(entry: InboxEntry): RunningProgress | null {
  const parsed = runningProgressSchema.safeParse(entry.running);

  if (!parsed.success) return null;
  const { done, total } = parsed.data.progress;

  return { done: Math.min(done, total), total };
}

const SHELF_ONLY_PRIMARIES: ReadonlySet<string> = new Set(["archive", "archive-runs", "ok"]);

function resultCard(entry: InboxEntry): InboxCard | null {
  const card = entry.card;

  return card === null || card.kind === "question" || card.kind === "problem" ? null : card;
}

export function readyToArchive(entry: InboxEntry): boolean {
  return entry.state === "finished" && entry.archiveReady;
}

export type RowMark = "failed" | "need" | "blk" | "run" | "stop" | "wait" | "done" | "ready";

export function rowMark(
  dot: DotKind,
  entry: Pick<InboxEntry, "state" | "archiveReady">,
): RowMark | null {
  if (entry.state === "failed") return "failed";

  if (dot === "need" || dot === "blk" || dot === "run" || dot === "stop") return dot;

  if (entry.state === "working") return "run";

  if (dot === "que") return "wait";

  if (entry.state === "finished") return entry.archiveReady ? "ready" : "done";

  return null;
}

export function asksWhileWorking(entry: InboxEntry): boolean {
  return (
    entry.state === "working" &&
    entry.card?.kind === "question" &&
    entry.card.questionFrom === null &&
    entry.reason.threadId === entry.threadId
  );
}

export function inboxSection(
  entry: InboxEntry,
): "failed" | "need" | "finished" | "ready" | "run" | "waiting" | "shelf" {
  switch (entry.state) {
    case "failed":
      return "failed";
    case "needs-you":
      return "need";
    case "finished":
      return entry.archiveReady ? "ready" : "finished";
    case "working":
      return asksWhileWorking(entry) ? "need" : "run";
    case "waiting":
      return "waiting";
    case "resting":
    case "archive":
      return "shelf";
  }
}

export function shelvedOnly(entry: InboxEntry): boolean {
  const primary = resultCard(entry)?.primary;

  return entry.shelved && primary !== undefined && SHELF_ONLY_PRIMARIES.has(primary.kind);
}

export function shelfRows(snapshot: InboxSnapshot): InboxEntry[] {
  const elsewhere = new Set(
    [
      ...snapshot.inbox.filter((entry) => !shelvedOnly(entry)),
      ...snapshot.waiting,
      ...snapshot.running,
    ].map((entry) => entry.threadId),
  );

  return snapshot.shelf.filter((entry) => !elsewhere.has(entry.threadId));
}

type InboxList = "inbox" | "waiting" | "running" | "shelf";

const INBOX_LISTS: readonly InboxList[] = ["inbox", "waiting", "running", "shelf"];

const ALL_LISTS = new Set<InboxList>(INBOX_LISTS);

const WORK_LISTS = new Set<InboxList>(["inbox", "waiting", "running"]);

const CARD_ONLY = new Set<InboxList>(["inbox"]);

const CARD_AND_WAIT = new Set<InboxList>(["inbox", "waiting"]);

function recount(snapshot: InboxSnapshot): InboxSnapshot {
  const { inbox, waiting, running } = snapshot;

  return {
    ...snapshot,
    counts: {
      needsYou: [...inbox, ...waiting, ...running].filter((entry) => entry.state === "needs-you")
        .length,
      inbox: inbox.length,
      questions: inbox.filter((entry) => entry.card?.kind === "question").length,
      running: running.length,
      waiting: waiting.length,
      onYou: waiting.flatMap((entry) =>
        entry.waiting?.group === "on-you" ? [entry.waiting.reason ?? entry.title] : [],
      ),
      nextBackAt: earliest(
        waiting.map((entry) => (entry.waiting?.guaranteed ? entry.waiting.returnAt : null)),
      ),
    },
  };
}

function mapLists(
  snapshot: InboxSnapshot,
  lists: ReadonlySet<InboxList>,
  change: (entries: InboxEntry[], list: InboxList) => InboxEntry[],
): InboxSnapshot {
  const next = { ...snapshot };

  for (const list of INBOX_LISTS) if (lists.has(list)) next[list] = change(snapshot[list], list);

  return next;
}

function withoutThreads(
  snapshot: InboxSnapshot,
  threadIds: ReadonlySet<string>,
  lists: ReadonlySet<InboxList>,
): InboxSnapshot {
  return mapLists(snapshot, lists, (entries) =>
    entries.filter((entry) => !threadIds.has(entry.threadId)),
  );
}

const RESTS_WHEN_SHELVED: ReadonlySet<string> = new Set(["archive", "your-call"]);

function shelvedEntry(entry: InboxEntry): InboxEntry {
  const card = resultCard(entry);
  const shelved = { ...entry, shelved: true, archiveReady: false };

  return card === null || !RESTS_WHEN_SHELVED.has(card.primary.kind)
    ? shelved
    : { ...shelved, card: { ...card, primary: { kind: "ok", thenWaits: null } } };
}

function restingOnShelf(entry: InboxEntry): boolean {
  const primary = resultCard(entry)?.primary;

  return entry.shelved && primary?.kind === "ok" && primary.thenWaits === null;
}

function withShelf(snapshot: InboxSnapshot, threadId: string, shelved: boolean): InboxSnapshot {
  const source = INBOX_LISTS.flatMap((list) => snapshot[list]).find(
    (entry) => entry.threadId === threadId,
  );

  const moved = (entry: InboxEntry): InboxEntry[] => {
    if (entry.threadId !== threadId) return [entry];

    if (shelved) return [shelvedEntry(entry)];

    return restingOnShelf(entry) ? [] : [{ ...entry, shelved: false }];
  };

  const marked = mapLists(snapshot, WORK_LISTS, (entries) => entries.flatMap(moved));
  const rest = snapshot.shelf.filter((entry) => entry.threadId !== threadId);

  if (!shelved || source === undefined) return { ...marked, shelf: rest };
  const entry = shelvedEntry(source);
  const at = rest.findIndex((item) => item.sortAt > entry.sortAt);

  return {
    ...marked,
    shelf: at < 0 ? [...rest, entry] : [...rest.slice(0, at), entry, ...rest.slice(at)],
  };
}

export function predictAct(snapshot: InboxSnapshot, request: InboxActRequest): InboxSnapshot {
  switch (request.action) {
    case "archive":
      return recount(withoutThreads(snapshot, new Set([request.threadId]), ALL_LISTS));
    case "archive-runs": {
      const archived = new Set(request.threadIds);
      const next = withoutThreads(snapshot, archived, ALL_LISTS);

      return recount({
        ...next,
        inbox: next.inbox.map((entry) =>
          entry.threadId === request.threadId && entry.runs !== null && entry.runs !== undefined
            ? { ...entry, runs: entry.runs.filter((run) => !archived.has(run.threadId)) }
            : entry,
        ),
      });
    }

    case "shelf":
      return recount(withShelf(snapshot, request.threadId, request.shelved));
    case "happened":
    case "cancel-wait":
      return recount(withoutThreads(snapshot, new Set([request.threadId]), CARD_AND_WAIT));
    case "ok":
    case "wait":
    case "wait-report":
    case "accept-proposal":
    case "keep-waiting":
    case "remind-later":
    case "snooze-question":
    case "resume":
    case "continue-with-result":
    case "resume-all-at-reset":
      return recount(withoutThreads(snapshot, new Set([request.threadId]), CARD_ONLY));
  }
}

export function predictRetry(snapshot: InboxSnapshot, threadId: string): InboxSnapshot {
  return recount(withoutThreads(snapshot, new Set([threadId]), CARD_ONLY));
}

export function leavesInbox(
  snapshot: InboxSnapshot,
  predict: (snapshot: InboxSnapshot) => InboxSnapshot,
  threadId: string,
): boolean {
  const before = snapshot.inbox.find((entry) => entry.threadId === threadId);

  if (before === undefined || shelvedOnly(before)) return false;
  const after = predict(snapshot).inbox.find((entry) => entry.threadId === threadId);

  return after === undefined || shelvedOnly(after);
}

export function busyRoots(threads: readonly StatusThread[]): ReadonlySet<string> {
  const roots = familyRoots(threads.map((thread) => ({ ...thread, shelvedAt: null })));
  const busy = new Set<string>();

  for (const thread of threads)
    if (BUSY.has(thread.status)) busy.add(roots.get(thread.id) ?? thread.id);

  return busy;
}

export function questionThreadId(
  card: InboxCard,
  rootId: string,
  threads: readonly AskingThread[],
): string {
  const asked = new Set(card.questionIds);

  const required = threads.find(
    (thread) =>
      thread.experimental_work?.requiredInput.some((input) => asked.has(input.id)) ?? false,
  );

  const optional = threads.find(
    (thread) =>
      thread.experimental_work?.optionalInput.some((input) => asked.has(input.id)) ?? false,
  );

  return required?.id ?? optional?.id ?? rootId;
}

export function openTarget(entry: InboxEntry, threads: readonly AskingThread[]): string {
  const card = entry.card;

  return card?.kind === "question"
    ? questionThreadId(card, entry.threadId, threads)
    : entry.threadId;
}

export function restoreThreadRows(
  snapshot: InboxSnapshot,
  before: InboxSnapshot,
  threadIds: ReadonlySet<string>,
): InboxSnapshot {
  return recount(
    mapLists(snapshot, ALL_LISTS, (entries, list) => {
      const next = entries.filter((entry) => !threadIds.has(entry.threadId));

      for (const [index, entry] of before[list].entries())
        if (threadIds.has(entry.threadId)) next.splice(Math.min(index, next.length), 0, entry);

      return next;
    }),
  );
}
