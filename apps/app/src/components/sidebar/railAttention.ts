import { isThreadRead } from "@omnyo/client-core";
import type { ThreadListEntry } from "@omnyo/domain";

export type RailChatState = "failed" | "needs" | "running" | "fresh" | "quiet";

export interface RailAttentionCounts {
  failed: number;
  needs: number;
  running: number;
  fresh: number;
  unread: number;
  hasRunningWork: boolean;
}

export const EMPTY_RAIL_ATTENTION: Readonly<RailAttentionCounts> = {
  failed: 0,
  needs: 0,
  running: 0,
  fresh: 0,
  unread: 0,
  hasRunningWork: false,
};

function ownWorkLabel(thread: ThreadListEntry) {
  return (
    thread.work?.experimental_ownState?.primary.label ??
    thread.work?.primary.label
  );
}

export function railChatState(thread: ThreadListEntry): RailChatState {
  switch (ownWorkLabel(thread)) {
    case "needs-you":
      return "needs";
    case "working":
      return (thread.work?.requiredInput.length ?? 0) +
        (thread.work?.optionalInput.length ?? 0) >
        0
        ? "needs"
        : "running";
    case "failed":
      return "failed";
    default:
      return isThreadRead(thread) ? "quiet" : "fresh";
  }
}

export interface RailRoot {
  thread: ThreadListEntry;
  state: RailChatState;
  hasRunningWork: boolean;
  unread: boolean;
}

export function railRoots(threads: readonly ThreadListEntry[]): RailRoot[] {
  return threads
    .filter(
      (thread) =>
        thread.visibility === "visible" &&
        thread.archivedAt === null &&
        thread.parentThreadId === null &&
        thread.lifecycleOwnerThreadId === null,
    )
    .map((thread) => {
      const work = thread.work;
      const own = work?.experimental_ownState;

      return {
        thread,
        state: railChatState(thread),
        hasRunningWork:
          ownWorkLabel(thread) === "working" ||
          (own?.hasActivity ?? (work?.activity.length ?? 0) > 0),
        unread: !isThreadRead(thread),
      };
    });
}

function addRootState(
  counts: RailAttentionCounts,
  state: RailChatState,
): RailAttentionCounts {
  switch (state) {
    case "failed":
      return { ...counts, failed: counts.failed + 1 };
    case "needs":
      return { ...counts, needs: counts.needs + 1 };
    case "running":
      return { ...counts, running: counts.running + 1 };
    case "fresh":
      return { ...counts, fresh: counts.fresh + 1 };
    case "quiet":
      return counts;
  }
}

export function railAttentionByProject(
  threads: readonly ThreadListEntry[],
): ReadonlyMap<string, RailAttentionCounts> {
  return railAttentionByRootProject(railRoots(threads));
}

export function railAttentionByRootProject(
  roots: readonly RailRoot[],
): ReadonlyMap<string, RailAttentionCounts> {
  const byProject = new Map<string, RailAttentionCounts>();

  for (const root of roots) {
    const projectId = root.thread.projectId;

    const counts = addRootState(
      byProject.get(projectId) ?? EMPTY_RAIL_ATTENTION,
      root.state,
    );

    byProject.set(projectId, {
      ...counts,
      running:
        counts.running +
        (root.state !== "running" && root.hasRunningWork ? 1 : 0),
      hasRunningWork: counts.hasRunningWork || root.hasRunningWork,
      unread: counts.unread + (root.unread ? 1 : 0),
    });
  }

  return byProject;
}

export function sumRailAttention(
  counts: Iterable<RailAttentionCounts>,
): RailAttentionCounts {
  let failed = 0;
  let needs = 0;
  let running = 0;
  let fresh = 0;
  let unread = 0;
  let hasRunningWork = false;

  for (const entry of counts) {
    failed += entry.failed;
    needs += entry.needs;
    running += entry.running;
    fresh += entry.fresh;
    unread += entry.unread;
    hasRunningWork ||= entry.hasRunningWork;
  }

  return { failed, needs, running, fresh, unread, hasRunningWork };
}

export interface InboxTriageCounts {
  needs: number;
  failed: number;
  unread: number;
  ready: number;
}

export const EMPTY_INBOX_TRIAGE: Readonly<InboxTriageCounts> = {
  needs: 0,
  failed: 0,
  unread: 0,
  ready: 0,
};

export function inboxTriage(
  threads: readonly ThreadListEntry[],
): InboxTriageCounts {
  const counts = { ...EMPTY_INBOX_TRIAGE };

  for (const root of railRoots(threads)) {
    if (root.state === "failed") {
      counts.failed += 1;
    } else if (root.state === "needs") {
      counts.needs += 1;
    } else if (root.state === "running" || root.hasRunningWork) {
      continue;
    } else if (root.unread) {
      counts.unread += 1;
    } else if (ownWorkLabel(root.thread) === "ready-to-archive") {
      counts.ready += 1;
    }
  }

  return counts;
}

export function inboxTriageLabel(
  counts: InboxTriageCounts,
  running: number,
): string {
  const parts = ["Inbox"];

  if (counts.needs > 0) {
    parts.push(`${counts.needs} ${counts.needs === 1 ? "needs" : "need"} you`);
  }

  if (counts.failed > 0) parts.push(`${counts.failed} failed`);

  if (counts.unread > 0) parts.push(`${counts.unread} unread`);

  if (counts.ready > 0) parts.push(`${counts.ready} ready to archive`);

  if (running > 0) parts.push(`${running} running`);

  return parts.join(", ");
}

export function railAttentionBadgeCount(counts: RailAttentionCounts): number {
  return counts.failed + counts.needs;
}

export function isRailAttentionQuiet(counts: RailAttentionCounts): boolean {
  return counts.failed + counts.needs + counts.running + counts.fresh === 0;
}

export function railAttentionLabel(
  name: string,
  counts: RailAttentionCounts,
): string {
  const parts = [name];

  if (counts.failed > 0) parts.push(`${counts.failed} failed`);

  if (counts.needs > 0) {
    parts.push(`${counts.needs} ${counts.needs === 1 ? "needs" : "need"} you`);
  }

  if (counts.running > 0) parts.push(`${counts.running} running`);

  if (!counts.hasRunningWork && counts.unread > 0)
    parts.push(`${counts.unread} unread`);

  return parts.join(", ");
}
