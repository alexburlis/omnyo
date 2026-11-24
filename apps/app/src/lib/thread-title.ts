import type { Thread } from "@omnyo/domain";

export function getThreadDisplayTitle(
  thread: Pick<Thread, "id" | "title" | "titleFallback">,
): string {
  if (thread.title && thread.title.trim().length > 0) return thread.title;

  if (thread.titleFallback && thread.titleFallback.trim().length > 0) {
    return thread.titleFallback;
  }

  return `Thread ${thread.id.slice(0, 8)}`;
}

export function describeThreadAction(
  verb: string,
  thread: Pick<Thread, "id" | "title" | "titleFallback"> | null,
): string {
  return thread === null
    ? `${verb} chat`
    : `${verb} “${getThreadDisplayTitle(thread)}”`;
}
