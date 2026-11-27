import {
  familyWorkSource,
  rootAttention,
  type ChatNode,
  type ChatState,
  type GroupThread,
} from "./grouping.ts";

type FeedState = "failed" | "need" | "blk" | "run" | "wait";

export type FeedFilter = "all" | "run";

type CardState = FeedState | "idle" | "ext" | "done";

export const CARD_LABEL: Readonly<Record<CardState, string>> = {
  need: "Needs you",
  failed: "Failed",
  blk: "Blocked",
  run: "Working",
  wait: "Waiting",
  idle: "Open",
  ext: "Awaiting",
  done: "Ready to archive",
};

export const PHASES = ["investigate", "build", "test", "ship", "done"] as const;

export type Phase = (typeof PHASES)[number];

export const PHASE_LABEL: Readonly<Record<Phase, string>> = {
  investigate: "Investigate",
  build: "Build",
  test: "Test",
  ship: "Ship",
  done: "Done",
};

export interface GlanceCard {
  threadId: string;
  status: "working" | "needs-you" | "blocked" | "done";
  phase: Phase;
  headline: string;
  sidebarSummary: string | null;
  blocker: string | null;
  next: string | null;
  stale: boolean;
  unseen: boolean;
  updatedAt: number;
}

const MINUTE = 60_000;

function feedStateOf(state: ChatState): FeedState | null {
  switch (state) {
    case "failed":
      return "failed";
    case "need":
      return "need";
    case "blk":
      return "blk";
    case "run":
      return "run";
    case "que":
      return "wait";
    default:
      return null;
  }
}

export function cardStateOf(state: ChatState): CardState {
  if (state === "done" || state === "ext") return state;

  return feedStateOf(state) ?? "idle";
}

export interface RowLine {
  verb: string;
  reason: string | null;
}

export function rowLine(node: ChatNode): RowLine {
  const source = familyWorkSource(node);
  const work = source.work;

  if (work === null) return { verb: "Open", reason: "Work summary unavailable" };

  const optionalDecision =
    node.state !== "need" &&
    node.state !== "failed" &&
    node.family.some((thread) => (thread.work?.optionalInput.length ?? 0) > 0);

  const label = optionalDecision ? "Open decision" : CARD_LABEL[cardStateOf(node.state)];

  const describe = (thread: GroupThread, detail: string) =>
    thread.id === node.thread.id ? detail : `Sub-chat ${thread.displayTitle}: ${detail}`;

  const detail = [
    ...node.family.flatMap((thread) =>
      (thread.work?.optionalInput ?? []).map((input) => describe(thread, input.label)),
    ),
    describe(
      source,
      work.primary.label === "external"
        ? (work.assessment.waitingOn ?? work.primary.reason.text)
        : work.primary.reason.text,
    ),
    ...(node.state === "need" || optionalDecision
      ? node.family.flatMap((thread) =>
          (thread.work?.activity ?? []).map((activity) => describe(thread, activity.label)),
        )
      : []),
    ...(node.thread.work?.failures ?? []).map((failure) => failure.text),
  ];

  return { verb: label, reason: [...new Set(detail)].join(" · ") };
}

export function rowSummary(node: ChatNode, subtitle: string | null): string | null {
  const asking = rootAttention(node).asking;

  if (node.state === "run" && !asking) return null;
  const title = node.thread.displayTitle.trim().toLocaleLowerCase();

  const meaningful = (value: string | null) => {
    const text = value?.trim();

    if (!text || text.toLocaleLowerCase() === title) return null;

    if (
      /^(?:working|open|waiting|blocked|needs you|ready to archive|work summary unavailable)[.!…]*$/iu.test(
        text,
      )
    )
      return null;

    return text;
  };

  const reason = meaningful(rowLine(node).reason);

  if (asking || node.state === "need" || node.state === "failed" || node.state === "blk")
    return reason;
  const current = meaningful(subtitle);

  if (current !== null && !/^needs you:/iu.test(current)) return current;

  return reason;
}

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;

const MONTHS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
] as const;

const DAY = 24 * 60 * MINUTE;

function localDay(at: number): number {
  const date = new Date(at);

  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
}

function twoDigits(value: number): string {
  return String(value).padStart(2, "0");
}

function clockOf(date: Date): string {
  return `${twoDigits(date.getHours())}:${twoDigits(date.getMinutes())}`;
}

function calendarDate(now: number, date: Date): string {
  const day = `${date.getDate()} ${MONTHS[date.getMonth()]}`;

  return date.getFullYear() === new Date(now).getFullYear() ? day : `${day} ${date.getFullYear()}`;
}

export function createdLabel(now: number, at: number): string {
  const date = new Date(at);
  const days = Math.round((localDay(now) - localDay(at)) / DAY);

  if (days <= 0) return clockOf(date);

  if (days < 7) return `${WEEKDAYS[date.getDay()]} ${clockOf(date)}`;

  return calendarDate(now, date);
}

export function upcomingDay(now: number, at: number): string {
  const date = new Date(at);
  const days = Math.round((localDay(at) - localDay(now)) / DAY);

  if (days <= 0) return "today";

  if (days === 1) return "tomorrow";

  if (days < 7) return WEEKDAYS[date.getDay()];

  return calendarDate(now, date);
}

export function upcomingLabel(now: number, at: number): string {
  const date = new Date(at);
  const days = Math.round((localDay(at) - localDay(now)) / DAY);

  if (days <= 0) return clockOf(date);

  if (days < 7) return `${upcomingDay(now, at)} ${clockOf(date)}`;

  return calendarDate(now, date);
}

export function cardPhase(card: GlanceCard | null): Phase | null {
  if (card === null || card.stale || card.status === "done") return null;

  return card.phase;
}

export function age(now: number, at: number): string {
  const minutes = Math.max(1, Math.round((now - at) / MINUTE));

  if (minutes < 60) return `${minutes}m`;

  if (minutes < 24 * 60) return `${Math.floor(minutes / 60)}h`;

  return `${Math.floor(minutes / (24 * 60))}d`;
}
