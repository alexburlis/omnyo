import type { ThreadListEntry } from "@omnyo/domain";
import { isSidebarProjectThread } from "@omnyo/client-core";
import {
  isThreadUnreadForAttention,
  type ThreadUnreadAttentionState,
} from "@/lib/thread-unread-attention";

type FaviconSidebarThread = ThreadUnreadAttentionState &
  Pick<
    ThreadListEntry,
    | "hasPendingInteraction"
    | "attention"
    | "id"
    | "originKind"
    | "parentThreadId"
    | "visibility"
  >;

interface ShouldShowFaviconAttentionDotArgs {
  currentThreadHasPendingInteraction: boolean;
  currentThreadId?: string | null;
  isThreadView: boolean;
  sidebarThreads: readonly FaviconSidebarThread[];
  thread: ThreadUnreadAttentionState | null | undefined;
}

function isUnreadSidebarThread(thread: FaviconSidebarThread): boolean {
  return isSidebarProjectThread(thread) && isThreadUnreadForAttention(thread);
}

function isPendingSidebarThread(thread: FaviconSidebarThread): boolean {
  return (
    isSidebarProjectThread(thread) &&
    (thread.hasPendingInteraction ||
      thread.attention?.kind === "required-answer" ||
      thread.attention?.kind === "optional-input" ||
      (thread.attention?.requiredCount ?? 0) > 0 ||
      (thread.attention?.optionalCount ?? 0) > 0)
  );
}

export function shouldShowFaviconAttentionDot({
  currentThreadHasPendingInteraction,
  currentThreadId,
  isThreadView,
  sidebarThreads,
  thread,
}: ShouldShowFaviconAttentionDotArgs): boolean {
  if (isThreadView) {
    return (
      currentThreadHasPendingInteraction ||
      sidebarThreads.some(
        (candidate) =>
          candidate.id === currentThreadId && isPendingSidebarThread(candidate),
      ) ||
      Boolean(thread && isThreadUnreadForAttention(thread))
    );
  }

  return sidebarThreads.some(
    (candidate) =>
      isPendingSidebarThread(candidate) || isUnreadSidebarThread(candidate),
  );
}
