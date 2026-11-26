import type { NotificationHub } from "../../ws/hub.js";

const admitting = new Set<string>();

export function beginInboxAdmission(threadId: string): void {
  admitting.add(threadId);
}

export function endInboxAdmission(
  hub: Pick<NotificationHub, "notifyThread">,
  threadId: string,
): void {
  if (admitting.delete(threadId)) hub.notifyThread(threadId, ["work-changed"]);
}

export function isAdmittingToInbox(threadId: string): boolean {
  return admitting.has(threadId);
}
