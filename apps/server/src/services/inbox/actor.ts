import {
  INBOX_CALLER_AUTOMATION_HEADER,
  INBOX_CALLER_AUTOMATION_RUN_HEADER,
  INBOX_CALLER_PLUGIN_HEADER,
  INBOX_CALLER_THREAD_HEADER,
} from "@omnyo/domain";

export type InboxActor =
  | { kind: "owner" }
  | { kind: "thread"; threadId: string }
  | { kind: "automation"; automationId: string; runId: string | null }
  | { kind: "plugin"; pluginId: string };

export const OWNER_ACTOR: InboxActor = { kind: "owner" };

function clean(value: string | undefined): string | null {
  const trimmed = value?.trim();

  return trimmed ? trimmed : null;
}

export function inboxActorFromHeaders(
  header: (name: string) => string | undefined,
): InboxActor {
  const automationId = clean(header(INBOX_CALLER_AUTOMATION_HEADER));

  if (automationId !== null)
    return {
      kind: "automation",
      automationId,
      runId: clean(header(INBOX_CALLER_AUTOMATION_RUN_HEADER)),
    };

  const threadId = clean(header(INBOX_CALLER_THREAD_HEADER));

  if (threadId !== null) return { kind: "thread", threadId };

  const pluginId = clean(header(INBOX_CALLER_PLUGIN_HEADER));

  if (pluginId !== null) return { kind: "plugin", pluginId };

  return OWNER_ACTOR;
}

export function isOwner(actor: InboxActor): boolean {
  return actor.kind === "owner";
}
