import type {
  experimental_PluginBrowserSdk,
  PluginSidebarThread,
  PluginSidebarThreadsState,
} from "@omnyo/plugin-sdk/app";
import { MOTION_DURATION_MS } from "@/components/ui/motion";
import { canShowChatNotification } from "./notification-eligibility.js";

export const COUNTDOWN_MS = 8_000;

export const SENT_DWELL_MS = 500;

export const SENT_MS = SENT_DWELL_MS + MOTION_DURATION_MS.base;

export const LEAVE_MS = MOTION_DURATION_MS.base;

export type ChatNoticeTone = "needs-you" | "failed";

export type LiveChatNotice = ChatNoticeTone | "silent" | "quiet";

export interface ChatNotice {
  readonly id: string;
  readonly threadId: string;
  readonly title: string;
  readonly body: string;
  readonly receivedAt: number;
}

export type ChatNoticeHold = "pointer" | "focus" | "loading";

export interface Countdown {
  readonly remaining: number;
  readonly runningSince: number | null;
}

export type ChatNoticePhase =
  | { readonly kind: "waiting" }
  | {
      readonly kind: "card";
      readonly tone: ChatNoticeTone;
      readonly error: string | null;
      readonly countdown: Countdown | null;
    }
  | { readonly kind: "sending"; readonly tone: ChatNoticeTone }
  | {
      readonly kind: "sent";
      readonly tone: ChatNoticeTone;
      readonly detail: string;
      readonly until: number;
    }
  | {
      readonly kind: "leaving";
      readonly tone: ChatNoticeTone;
      readonly until: number;
    };

export type ShownChatNoticePhase = Exclude<
  ChatNoticePhase,
  { readonly kind: "waiting" }
>;

export interface ChatNoticeEntry {
  readonly notice: ChatNotice;
  readonly phase: ChatNoticePhase;
  readonly holds: readonly ChatNoticeHold[];
}

export interface ShownChatNotice extends ChatNoticeEntry {
  readonly phase: ShownChatNoticePhase;
}

export interface ChatNoticeContext {
  readonly live: ReadonlyMap<string, LiveChatNotice> | null;
  readonly openThreadId: string | null;
  readonly capacity: number;
  readonly countdown: boolean;
}

export interface ChatNoticeStack {
  readonly context: ChatNoticeContext;
  readonly entries: readonly ChatNoticeEntry[];
}

export type ChatNoticeAction =
  | {
      readonly type: "receive";
      readonly notice: Omit<ChatNotice, "receivedAt">;
    }
  | { readonly type: "sync"; readonly context: ChatNoticeContext }
  | { readonly type: "open"; readonly noticeId: string }
  | { readonly type: "dismiss"; readonly noticeId: string }
  | { readonly type: "cycle" }
  | {
      readonly type: "hold";
      readonly noticeId: string;
      readonly source: ChatNoticeHold;
      readonly held: boolean;
    }
  | { readonly type: "send"; readonly noticeId: string }
  | {
      readonly type: "sent";
      readonly noticeId: string;
      readonly detail: string;
    }
  | { readonly type: "fail"; readonly noticeId: string; readonly error: string }
  | { readonly type: "tick" };

export interface TimedChatNoticeAction {
  readonly action: ChatNoticeAction;
  readonly now: number;
}

export const EMPTY_CHAT_NOTICE_STACK: ChatNoticeStack = {
  context: { live: null, openThreadId: null, capacity: 1, countdown: true },
  entries: [],
};

const UNDRAWN: readonly ChatNoticeHold[] = ["loading"];

type AttentionSnapshot = Awaited<
  ReturnType<experimental_PluginBrowserSdk["experimental_attention"]["history"]>
>;

export type NativeQuestion = AttentionSnapshot["questions"][number];

export type NativeQuestionOption =
  NativeQuestion["question"]["options"][number];

export function chatNoticeTone(
  thread: PluginSidebarThread,
): ChatNoticeTone | null {
  if (thread.status === "error" || thread.queuedWork === "failed")
    return "failed";
  const attention = thread.experimental_attention?.kind;

  return thread.hasPendingInteraction ||
    attention === "required-answer" ||
    attention === "optional-input" ||
    attention === "dependency-failed"
    ? "needs-you"
    : null;
}

export function asksNativeQuestion(
  thread: PluginSidebarThread | null,
): boolean {
  const attention = thread?.experimental_attention?.kind;

  return (
    thread !== null &&
    !thread.hasPendingInteraction &&
    (attention === "required-answer" || attention === "optional-input")
  );
}

export function liveChatNotice(
  sidebar: PluginSidebarThreadsState,
  threadId: string,
): LiveChatNotice {
  const thread = sidebar.threads.find((entry) => entry.id === threadId);

  if (thread === undefined || !canShowChatNotification(sidebar, threadId))
    return "quiet";

  return chatNoticeTone(thread) ?? "silent";
}

export function quickAnswers(
  question: NativeQuestion,
): readonly NativeQuestionOption[] | null {
  const { multiSelect, options } = question.question;

  return !multiSelect && options.length >= 2 && options.length <= 4
    ? options
    : null;
}

export function countdownElapsed(
  { remaining, runningSince }: Countdown,
  now: number,
): number {
  const left =
    runningSince === null ? remaining : remaining - (now - runningSince);

  return Math.min(COUNTDOWN_MS, Math.max(0, COUNTDOWN_MS - left));
}

export function isShownChatNotice(
  entry: ChatNoticeEntry,
): entry is ShownChatNotice {
  return entry.phase.kind !== "waiting";
}

export function isDrawnChatNotice(entry: ChatNoticeEntry): boolean {
  return !entry.holds.includes("loading");
}

export function shownChatNotices(
  stack: ChatNoticeStack,
): readonly ShownChatNotice[] {
  return stack.entries
    .filter(isShownChatNotice)
    .slice(0, stack.context.capacity);
}

export function hiddenChatNoticeCount(stack: ChatNoticeStack): number {
  return Math.max(
    0,
    stack.entries.filter(isShownChatNotice).length - stack.context.capacity,
  );
}

function deadline(phase: ChatNoticePhase): number | null {
  switch (phase.kind) {
    case "card": {
      const { countdown } = phase;

      return countdown === null || countdown.runningSince === null
        ? null
        : countdown.runningSince + countdown.remaining;
    }

    case "sent":
    case "leaving":
      return phase.until;
    case "waiting":
    case "sending":
      return null;
  }
}

export function nextChatNoticeDeadline(stack: ChatNoticeStack): number | null {
  let next: number | null = null;

  for (const entry of stack.entries) {
    const due = deadline(entry.phase);

    if (due !== null && (next === null || due < next)) next = due;
  }

  return next;
}

function sameLive(
  left: ChatNoticeContext["live"],
  right: ChatNoticeContext["live"],
): boolean {
  if (left === null || right === null) return left === right;

  if (left.size !== right.size) return false;

  for (const [threadId, live] of left) {
    if (right.get(threadId) !== live) return false;
  }

  return true;
}

function sameContext(
  left: ChatNoticeContext,
  right: ChatNoticeContext,
): boolean {
  return (
    left.openThreadId === right.openThreadId &&
    left.capacity === right.capacity &&
    left.countdown === right.countdown &&
    sameLive(left.live, right.live)
  );
}

function reconcile(
  entry: ChatNoticeEntry,
  context: ChatNoticeContext,
): ChatNoticeEntry | null {
  if (entry.notice.threadId === context.openThreadId) return null;
  const { phase } = entry;

  if (phase.kind !== "waiting" && phase.kind !== "card") return entry;
  const live = context.live?.get(entry.notice.threadId);

  if (live === undefined) return entry;

  if (phase.kind === "waiting") {
    if (live === "quiet") return entry;

    if (live === "silent") return null;

    return {
      ...entry,
      phase: { kind: "card", tone: live, error: null, countdown: null },
    };
  }

  if (live === "quiet" || live === "silent") return null;

  return live === phase.tone
    ? entry
    : { ...entry, phase: { ...phase, tone: live } };
}

function expire(entry: ChatNoticeEntry, now: number): ChatNoticeEntry | null {
  const due = deadline(entry.phase);

  if (due === null || now < due) return entry;

  return entry.phase.kind === "card"
    ? {
        ...entry,
        phase: {
          kind: "leaving",
          tone: entry.phase.tone,
          until: now + LEAVE_MS,
        },
      }
    : null;
}

function runCountdown(
  countdown: Countdown,
  running: boolean,
  now: number,
): Countdown {
  const { remaining, runningSince } = countdown;

  if (running)
    return runningSince === null ? { remaining, runningSince: now } : countdown;

  return runningSince === null
    ? countdown
    : { remaining: remaining - (now - runningSince), runningSince: null };
}

function present(
  entry: ChatNoticeEntry,
  countdown: boolean,
  now: number,
): ChatNoticeEntry {
  const { phase } = entry;

  if (phase.kind !== "card") return entry;

  const next = countdown
    ? runCountdown(
        phase.countdown ?? { remaining: COUNTDOWN_MS, runningSince: null },
        entry.holds.length === 0,
        now,
      )
    : null;

  return next === phase.countdown
    ? entry
    : { ...entry, phase: { ...phase, countdown: next } };
}

function conceal(entry: ChatNoticeEntry): ChatNoticeEntry {
  const { phase, holds } = entry;
  const counting = phase.kind === "card" && phase.countdown !== null;

  if (!counting && holds.length === 1 && holds[0] === "loading") return entry;

  return {
    ...entry,
    holds: UNDRAWN,
    phase: phase.kind === "card" ? { ...phase, countdown: null } : phase,
  };
}

function settleEntries(
  context: ChatNoticeContext,
  entries: readonly ChatNoticeEntry[],
  now: number,
): readonly ChatNoticeEntry[] {
  let slots = context.capacity;
  let changed = false;
  const settled: ChatNoticeEntry[] = [];

  for (const entry of entries) {
    const live = reconcile(entry, context);
    const current = live === null ? null : expire(live, now);

    if (current === null) {
      changed = true;
      continue;
    }

    const shown = isShownChatNotice(current) && slots > 0;

    if (shown) slots -= 1;

    const next = shown
      ? present(current, context.countdown, now)
      : conceal(current);

    if (next !== entry) changed = true;
    settled.push(next);
  }

  return changed ? settled : entries;
}

function receive(
  entries: readonly ChatNoticeEntry[],
  notice: Omit<ChatNotice, "receivedAt">,
  now: number,
): readonly ChatNoticeEntry[] {
  const next: ChatNoticeEntry = {
    notice: { ...notice, receivedAt: now },
    phase: { kind: "waiting" },
    holds: UNDRAWN,
  };

  const index = entries.findIndex(
    (entry) => entry.notice.threadId === notice.threadId,
  );

  return index < 0
    ? [...entries, next]
    : entries.map((entry, position) =>
        position === index ? { ...next, holds: entry.holds } : entry,
      );
}

function withHold(
  entry: ChatNoticeEntry,
  source: ChatNoticeHold,
  held: boolean,
): ChatNoticeEntry {
  if (entry.holds.includes(source) === held) return entry;

  return {
    ...entry,
    holds: held
      ? [...entry.holds, source]
      : entry.holds.filter((hold) => hold !== source),
  };
}

function cycle(stack: ChatNoticeStack): readonly ChatNoticeEntry[] {
  const first = shownChatNotices(stack).find(
    (entry) => entry.phase.kind === "card",
  );

  if (first === undefined || hiddenChatNoticeCount(stack) === 0)
    return stack.entries;

  return [...stack.entries.filter((entry) => entry !== first), first];
}

export function chatNoticeReducer(
  stack: ChatNoticeStack,
  { action, now }: TimedChatNoticeAction,
): ChatNoticeStack {
  const settle = (
    context: ChatNoticeContext,
    entries: readonly ChatNoticeEntry[],
  ): ChatNoticeStack => {
    const settled = settleEntries(context, entries, now);

    return context === stack.context && settled === stack.entries
      ? stack
      : { context, entries: settled };
  };

  const update = (
    noticeId: string,
    change: (entry: ChatNoticeEntry) => ChatNoticeEntry,
  ): ChatNoticeStack => {
    let changed = false;

    const entries = stack.entries.map((entry) => {
      if (entry.notice.id !== noticeId) return entry;
      const next = change(entry);

      if (next !== entry) changed = true;

      return next;
    });

    return settle(stack.context, changed ? entries : stack.entries);
  };

  switch (action.type) {
    case "receive":
      return settle(stack.context, receive(stack.entries, action.notice, now));
    case "sync":
      return sameContext(stack.context, action.context)
        ? stack
        : settle(action.context, stack.entries);
    case "open":
      return settle(
        stack.context,
        stack.entries.filter((entry) => entry.notice.id !== action.noticeId),
      );
    case "dismiss":
      return update(action.noticeId, (entry) =>
        entry.phase.kind === "card" || entry.phase.kind === "sending"
          ? {
              ...entry,
              phase: {
                kind: "leaving",
                tone: entry.phase.tone,
                until: now + LEAVE_MS,
              },
            }
          : entry,
      );
    case "cycle":
      return settle(stack.context, cycle(stack));
    case "hold":
      return update(action.noticeId, (entry) =>
        withHold(entry, action.source, action.held),
      );
    case "send":
      return update(action.noticeId, (entry) =>
        entry.phase.kind === "card"
          ? { ...entry, phase: { kind: "sending", tone: entry.phase.tone } }
          : entry,
      );
    case "sent":
      return update(action.noticeId, (entry) =>
        entry.phase.kind === "sending"
          ? {
              ...entry,
              phase: {
                kind: "sent",
                tone: entry.phase.tone,
                detail: action.detail,
                until: now + SENT_MS,
              },
            }
          : entry,
      );
    case "fail":
      return update(action.noticeId, (entry) =>
        entry.phase.kind === "sending"
          ? {
              ...entry,
              phase: {
                kind: "card",
                tone: entry.phase.tone,
                error: action.error,
                countdown: null,
              },
            }
          : entry,
      );
    case "tick":
      return settle(stack.context, stack.entries);
  }
}
