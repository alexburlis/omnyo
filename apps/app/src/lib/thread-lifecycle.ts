import type { Thread } from "@omnyo/domain";

export type ThreadLifecycle = "active" | "shelved" | "archived";

export function getThreadLifecycle(
  thread: Pick<Thread, "archivedAt" | "shelvedAt">,
): ThreadLifecycle {
  if (thread.archivedAt != null) return "archived";

  return thread.shelvedAt == null ? "active" : "shelved";
}
