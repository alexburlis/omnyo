import type { InboxCardKind, InboxSnapshot } from "@omnyo/domain";

export const HOME_NEEDS_ROW_LIMIT = 3;

export interface HomeNeedsRow {
  threadId: string;
  projectId: string;
  title: string;
  kind: InboxCardKind | null;
  at: number;
}

export interface HomeInboxSummary {
  failed: number;
  failedRows: HomeNeedsRow[];
  needs: number;
  needsRows: HomeNeedsRow[];
  ready: number;
}

export const EMPTY_HOME_INBOX_SUMMARY: HomeInboxSummary = {
  failed: 0,
  failedRows: [],
  needs: 0,
  needsRows: [],
  ready: 0,
};

export const HOME_CARD_KIND_LABEL: Record<InboxCardKind, string> = {
  question: "Question",
  result: "Result",
  returned: "Back from wait",
  problem: "Problem",
  runs: "Several runs",
  chain: "Wait closed",
};

export type HomeRowKind = InboxCardKind | "failed";

export const HOME_CARD_KIND_DESCRIPTION: Record<HomeRowKind, string> = {
  question: "The chat is asking you a question",
  result: "The chat finished and has a result for you to review",
  returned:
    "A wait ended: a deadline passed, a reminder fired or a late result arrived",
  problem: "The chat hit a problem it can’t solve without you",
  runs: "Several runs of the same automation finished",
  chain: "The chat it was waiting for was archived without a result",
  failed: "The chat stopped with an error before finishing",
};

export function homeGreetingText(
  hour: number,
  firstName: string | null,
): string {
  const period =
    hour >= 5 && hour < 12
      ? "morning"
      : hour >= 12 && hour < 18
        ? "afternoon"
        : "evening";

  return firstName === null ? `Good ${period}` : `Good ${period}, ${firstName}`;
}

export interface HomeOwnerAccount {
  name: string;
  githubLogin: string | null;
  handle: string | null;
}

function foldHandle(value: string): string {
  return value.trim().replace(/^@/, "").toLowerCase();
}

export function ownerFirstName(account: HomeOwnerAccount): string | null {
  const name = account.name.trim();

  const isHandle = [account.githubLogin, account.handle].some(
    (handle) => handle !== null && foldHandle(handle) === foldHandle(name),
  );

  if (isHandle || name.includes("@")) return null;

  const first = name.split(/\s+/)[0];

  return first === undefined || first === "" ? null : first;
}

export function homeCountsLine(counts: {
  running: number;
  needs: number;
  failed?: number;
}): string | null {
  const parts: string[] = [];

  if (counts.running > 0) {
    parts.push(
      `${counts.running} ${counts.running === 1 ? "chat" : "chats"} running`,
    );
  }

  if (counts.needs > 0) {
    parts.push(`${counts.needs} ${counts.needs === 1 ? "needs" : "need"} you`);
  }

  if (counts.failed) parts.push(`${counts.failed} failed`);

  return parts.length === 0 ? null : parts.join(" · ");
}

export function homeQuietCountsLine(counts: {
  running: number;
  ready: number;
}): string | null {
  const parts: string[] = [];

  if (counts.running > 0) parts.push(`${counts.running} running`);

  if (counts.ready > 0) parts.push(`${counts.ready} ready to archive`);

  return parts.length === 0 ? null : parts.join(" · ");
}

export function homeInboxSummary(snapshot: InboxSnapshot): HomeInboxSummary {
  const entries = [...snapshot.inbox, ...snapshot.running, ...snapshot.waiting];
  const needing = entries.filter((entry) => entry.state === "needs-you");

  const failed = entries.filter((entry) => entry.state === "failed");

  const rows = (items: typeof entries) =>
    items.slice(0, HOME_NEEDS_ROW_LIMIT).map((entry) => ({
      threadId: entry.threadId,
      projectId: entry.projectId,
      title: entry.title,
      kind: entry.card?.kind ?? null,
      at: entry.sortAt,
    }));

  return {
    failed: failed.length,
    failedRows: rows(failed),
    needs: snapshot.counts.needsYou,
    needsRows: rows(needing),
    ready: entries.filter((entry) => entry.archiveReady).length,
  };
}
