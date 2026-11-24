import {
  strongestThreadWorkSummary,
  type ThreadListIndicatorState,
  type Thread,
  type ThreadListEntry,
  type ThreadWorkSummary,
} from "@omnyo/domain";
import { isThreadRead } from "./thread-read-state.js";

export {
  resolveThreadListIndicator,
  getThreadListIndicatorLabel,
  strongestThreadWorkSummary,
  type ThreadListIndicatorState,
  type ThreadListIndicatorKind,
} from "@omnyo/domain";

type ThreadReadShape = Pick<
  Thread,
  "status" | "lastReadAt" | "latestAttentionAt" | "parentThreadId"
>;

export function threadListIndicatorStateForThread(
  thread: Pick<ThreadListEntry, "work">,
  hasUnsubmittedDraft: boolean,
): ThreadListIndicatorState {
  return { work: thread.work ?? null, hasUnsubmittedDraft };
}

export interface CollapsedChildActivity {
  work: ThreadWorkSummary | null;
  summaries: readonly ThreadWorkSummary[];
  hasUnsubmittedDraft: boolean;
  unread: boolean;
  unreadError: boolean;
}

const EMPTY_DRAFT_THREAD_IDS: ReadonlySet<string> = new Set();

export function getCollapsedChildActivity(
  threads: readonly (ThreadReadShape & Pick<ThreadListEntry, "id" | "work">)[],
  draftThreadIds: ReadonlySet<string> = EMPTY_DRAFT_THREAD_IDS,
): CollapsedChildActivity {
  const summaries = threads.flatMap((thread) =>
    thread.work === null || thread.work === undefined ? [] : [thread.work],
  );

  return {
    work: strongestThreadWorkSummary(summaries),
    summaries,
    hasUnsubmittedDraft: threads.some((thread) =>
      draftThreadIds.has(thread.id),
    ),
    unread: threads.some(
      (thread) => isUnreadThread(thread) && thread.status !== "error",
    ),
    unreadError: threads.some(
      (thread) => isUnreadThread(thread) && thread.status === "error",
    ),
  };
}

export function isUnreadThread(thread: ThreadReadShape): boolean {
  return !isThreadRead(thread);
}
