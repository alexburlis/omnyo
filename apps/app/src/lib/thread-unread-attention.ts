import { isThreadRead, type ThreadReadState } from "@omnyo/client-core";
import type { ThreadListEntry } from "@omnyo/domain";

export type ThreadUnreadAttentionState = ThreadReadState &
  Partial<Pick<ThreadListEntry, "work">>;

export function isThreadUnreadForAttention(
  thread: ThreadUnreadAttentionState,
): boolean {
  return (
    !isThreadRead(thread) &&
    thread.work?.primary.label !== "working" &&
    (thread.work?.activity.length ?? 0) === 0
  );
}
