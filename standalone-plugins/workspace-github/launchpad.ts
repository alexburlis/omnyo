import type { Item } from "./app-logic.js";

export type TriageTone = "ready" | "blocked" | "attention" | "none";

export const triageGroups = [
  { id: "ready", label: "Ready to merge", icon: "GitMerge", tone: "ready" },
  { id: "blocked", label: "Blocked", icon: "CircleX", tone: "blocked" },
  { id: "follow-up", label: "Requires follow-up", icon: "MessageSquare", tone: "attention" },
  { id: "needs-review", label: "Needs your review", icon: "Eye", tone: "attention" },
  { id: "waiting", label: "Waiting", icon: "Clock", tone: "none" },
  { id: "unknown", label: "Checking with GitHub", icon: "CircleDashed", tone: "none" },
  { id: "draft", label: "Drafts", icon: "GitPullRequestDraft", tone: "none" },
  { id: "issues", label: "Open issues", icon: "Circle", tone: "none" },
  { id: "closed", label: "Closed and merged", icon: "Archive", tone: "none" },
] as const satisfies readonly { id: string; label: string; icon: string; tone: TriageTone }[];

export type TriageGroupId = (typeof triageGroups)[number]["id"];

export type TriageGroup = (typeof triageGroups)[number];

export interface Triage {
  group: TriageGroupId;
  reason: string;
}

export function triage(item: Item, viewer: string | null): Triage {
  if (item.state !== "OPEN") {
    if (item.kind === "issue") return { group: "closed", reason: "Closed" };

    return { group: "closed", reason: item.state === "MERGED" ? "Merged" : "Closed" };
  }

  if (item.kind === "issue") {
    const assigned = viewer !== null && item.assignees.includes(viewer);

    return { group: "issues", reason: assigned ? "Assigned to you" : "Opened by you" };
  }

  if (item.pullReview === "draft" || item.pullMerge === "DRAFT") {
    return { group: "draft", reason: "Draft" };
  }

  if (item.pullReview === "conflicts" || item.pullMerge === "DIRTY") {
    return { group: "blocked", reason: `Conflicts with ${item.baseRef ?? "the base branch"}` };
  }

  if (item.pullMerge === "UNSTABLE") {
    return { group: "follow-up", reason: "Optional checks failing" };
  }

  if (item.checks === "failure") return { group: "blocked", reason: "Checks failing" };

  if (item.pullReview === "changes-requested") {
    return { group: "follow-up", reason: "Changes requested" };
  }

  const requested =
    viewer !== null &&
    (item.reviewers ?? []).some(
      (reviewer) =>
        reviewer.state === "requested" && reviewer.login.toLowerCase() === viewer.toLowerCase(),
    );

  if (requested) return { group: "needs-review", reason: "Your review is requested" };

  if (item.pullReview === "review-required") {
    return { group: "waiting", reason: "Waiting for review" };
  }

  if (item.checks === "pending") return { group: "waiting", reason: "Checks running" };

  if (item.pullMerge === "BEHIND") {
    return { group: "blocked", reason: `Behind ${item.baseRef ?? "the base branch"}` };
  }

  if (item.pullMerge === "BLOCKED") {
    return { group: "blocked", reason: "Blocked by branch rules" };
  }

  if (item.pullMerge === "CLEAN" || item.pullMerge === "HAS_HOOKS") {
    return {
      group: "ready",
      reason: item.pullReview === "approved" ? "Approved" : "Ready to merge",
    };
  }

  return { group: "unknown", reason: "GitHub has not computed mergeability yet" };
}

export interface TriagedItem {
  item: Item;
  triage: Triage;
}

export type TriageSection = TriageGroup & { rows: TriagedItem[] };

export function groupTriaged(entries: TriagedItem[]): TriageSection[] {
  const byGroup = new Map<TriageGroupId, TriagedItem[]>();

  for (const entry of entries) {
    const rows = byGroup.get(entry.triage.group) ?? [];
    rows.push(entry);
    byGroup.set(entry.triage.group, rows);
  }

  return triageGroups.flatMap((group) => {
    const rows = byGroup.get(group.id);

    if (rows === undefined) return [];

    if (group.id === "ready") {
      rows.sort(
        (a, b) =>
          Number(importantLabel(b.item.labels) === "security") -
            Number(importantLabel(a.item.labels) === "security") ||
          b.item.updatedAt.localeCompare(a.item.updatedAt),
      );
    }

    return [{ ...group, rows }];
  });
}

export function groupItems(items: Item[], viewer: string | null): TriageSection[] {
  return groupTriaged(items.map((item) => ({ item, triage: triage(item, viewer) })));
}

export function itemKey(item: Pick<Item, "kind" | "repo" | "number">): string {
  return `${item.kind}:${item.repo}#${item.number}`;
}

const LANE_COUNT = 10;

export function laneIndex(repo: string): number {
  let hash = 0;

  for (const char of repo.toLowerCase()) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;

  return hash % LANE_COUNT;
}

export function repoName(repo: string): string {
  return repo.slice(repo.indexOf("/") + 1);
}

export function compactAge(iso: string, now = Date.now()): string {
  const then = Date.parse(iso);

  if (Number.isNaN(then)) return "";
  const minutes = Math.max(0, Math.floor((now - then) / 60_000));

  if (minutes < 1) return "now";

  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);

  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);

  if (days < 30) return `${days}d`;
  const months = Math.floor(days / 30);

  if (months < 12) return `${months}mo`;

  return `${Math.floor(days / 365)}y`;
}

export function diffBarWidths(additions: number, deletions: number, track = 48) {
  const total = additions + deletions;

  if (total === 0) return { added: 0, removed: 0 };
  const length = Math.max(4, Math.min(track, (Math.sqrt(Math.min(total, 1600)) / 40) * track));
  const added = Math.round((additions / total) * length);

  return { added, removed: Math.round(length) - added };
}

export function importantLabel(labels: string[]): string | null {
  const lowered = labels.map((label) => label.toLowerCase());

  if (lowered.some((label) => label.includes("security"))) return "security";

  if (lowered.some((label) => label.includes("major"))) return "major";

  return null;
}
