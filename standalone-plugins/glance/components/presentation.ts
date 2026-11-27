import type { PluginSidebarThread } from "@omnyo/plugin-sdk/app";
import type { CardStatus } from "../contract";
import type { ServerView } from "./inbox-views";

export type PresentationStatus =
  | CardStatus
  | "finished"
  | "waiting"
  | "open"
  | "idle"
  | "failed"
  | "unknown";

type WorkSummary = NonNullable<PluginSidebarThread["experimental_work"]>;

type PresentationSource = {
  status: CardStatus;
  stale: boolean;
  headline: string;
  blocker?: string | null;
  next?: string | null;
};

export interface CardPresentation {
  status: PresentationStatus;
  headline: string;
  blocker: string | null;
  next: string | null;
  lastReported: { headline: string; next: string | null } | null;
}

const currentHeadlines: Record<PresentationStatus, string> = {
  "needs-you": "A question is open in this chat",
  blocked: "The task has an external blocker",
  working: "The agent is continuing this task",
  done: "The agent reported a completed result",
  finished: "The chat finished",
  waiting: "The agent is waiting to continue",
  open: "Nothing is running in this chat",
  idle: "The agent is idle",
  unknown: "Current activity is unavailable",
  failed: "The chat has a failed operation",
};

function updatedStatus(source: PresentationSource, status: PresentationStatus): CardPresentation {
  return {
    status,
    headline: status === source.status ? source.headline : currentHeadlines[status],
    blocker: status === "blocked" ? (source.blocker ?? null) : null,
    next: status === source.status ? (source.next ?? null) : null,
    lastReported:
      status === source.status ? null : { headline: source.headline, next: source.next ?? null },
  };
}

function workStatus(source: PresentationSource, work: WorkSummary): PresentationStatus {
  const label = work.primary.label;

  if (label === "ready-to-archive") return "done";

  if (label === "external") return "waiting";

  if (label !== "open") return label;

  if (source.status === "done") return "done";

  if (source.status === "blocked" && !source.stale) return "blocked";

  return "open";
}

function workPresentation(source: PresentationSource, work: WorkSummary): CardPresentation {
  const status = workStatus(source, work);

  if (status === source.status) return updatedStatus(source, status);
  const next = work.nextActors.map((actor) => actor.label).join(", ");

  return {
    ...updatedStatus(source, status),
    headline: work.primary.reason.text,
    next: next === "" ? null : next,
  };
}

export function serverStatus(view: ServerView): PresentationStatus {
  switch (view.state) {
    case "failed":
      return "failed";
    case "needs-you":
      return "needs-you";
    case "finished":
      return "finished";
    case "archive":
      return "done";
    case "waiting":
      return "waiting";
    case "working":
      return "working";
    case "resting":
      return "open";
  }
}

export function inboxStatus(view: ServerView, _work: WorkSummary | null): PresentationStatus {
  return serverStatus(view);
}

export function currentWorkPresentation(
  work: WorkSummary,
  view: ServerView | null,
): CardPresentation {
  const label = work.primary.label;
  const next = work.nextActors.map((actor) => actor.label).join(", ");

  return {
    status:
      view === null
        ? label === "ready-to-archive"
          ? "done"
          : label === "external"
            ? "waiting"
            : label
        : serverStatus(view),
    headline: view?.reason.text || work.primary.reason.text,
    blocker: null,
    next: next === "" ? null : next,
    lastReported: null,
  };
}

export function cardPresentation(
  source: PresentationSource,
  thread: PluginSidebarThread | undefined,
  work: WorkSummary | null = thread?.experimental_work ?? null,
  view: ServerView | null = null,
): CardPresentation {
  if (view !== null)
    return {
      status: inboxStatus(view, work),
      headline: view.reason.text || source.headline,
      blocker: null,
      next: source.next ?? null,
      lastReported: null,
    };

  if (work !== null) return workPresentation(source, work);

  if (thread === undefined)
    return updatedStatus(source, source.status === "working" ? "unknown" : source.status);
  const attention = thread.experimental_attention;

  if (
    thread.queuedWork === "failed" ||
    thread.runtimeStatus === "error" ||
    thread.status === "error"
  )
    return updatedStatus(source, "failed");

  if (
    thread.hasPendingInteraction ||
    attention?.kind === "required-answer" ||
    attention?.kind === "optional-input" ||
    (attention?.requiredCount ?? 0) > 0 ||
    (attention?.optionalCount ?? 0) > 0
  )
    return {
      ...updatedStatus(source, "needs-you"),
      headline: currentHeadlines["needs-you"],
      next: null,
    };

  if (
    thread.runtimeStatus === "active" ||
    thread.runtimeStatus === "starting" ||
    thread.runtimeStatus === "stopping" ||
    thread.runtimeStatus === "provisioning" ||
    (thread.runtimeStatus !== "waiting-for-host" &&
      (thread.status === "active" || thread.status === "starting" || thread.status === "stopping"))
  )
    return { ...updatedStatus(source, "working"), next: null };

  if (
    thread.queuedWork === "waiting" ||
    thread.runtimeStatus === "pending" ||
    thread.runtimeStatus === "waiting-for-host" ||
    attention?.kind === "callback-waiting" ||
    attention?.kind === "dependency-failed"
  )
    return updatedStatus(source, "waiting");

  if (
    [
      thread.activity.workflows,
      thread.activity.backgroundAgents,
      thread.activity.backgroundCommands,
    ].some((count) => count > 0)
  )
    return { ...updatedStatus(source, "working"), next: null };

  if (
    source.status === "working" ||
    source.status === "needs-you" ||
    (source.status === "blocked" && source.stale)
  )
    return updatedStatus(source, "idle");

  return updatedStatus(source, source.status);
}
