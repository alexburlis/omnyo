import { useMemo } from "react";
import { experimental_useInboxSnapshot } from "@omnyo/plugin-sdk/app";

type InboxSnapshot = NonNullable<ReturnType<typeof experimental_useInboxSnapshot>["snapshot"]>;

type InboxEntry = InboxSnapshot["inbox"][number];

export interface ServerView {
  view: InboxEntry["view"];
  state: InboxEntry["state"];
  reason: InboxEntry["reason"];
  archiveReady: boolean;
  stale: boolean;
  card: NonNullable<InboxEntry["card"]>["kind"] | null;
  primary: NonNullable<InboxEntry["card"]>["primary"]["kind"] | null;
}

export function viewsFromSnapshot(snapshot: InboxSnapshot, stale = false): Map<string, ServerView> {
  const found = new Map<string, ServerView>();

  for (const entry of [
    ...snapshot.inbox,
    ...snapshot.waiting,
    ...snapshot.running,
    ...snapshot.shelf,
  ]) {
    const view: ServerView = {
      view: entry.view,
      state: entry.state,
      reason: entry.reason,
      archiveReady: entry.archiveReady,
      stale,
      card: entry.card?.kind ?? null,
      primary: entry.card?.primary.kind ?? null,
    };

    found.set(entry.threadId, view);

    for (const member of entry.runs ?? []) found.set(member.threadId, view);

    for (const member of entry.incident?.members ?? []) found.set(member.threadId, view);
  }

  return found;
}

export function useInboxStates(): ReadonlyMap<string, ServerView> {
  const { snapshot, stale } = experimental_useInboxSnapshot();

  return useMemo(
    () => (snapshot === null ? new Map<string, ServerView>() : viewsFromSnapshot(snapshot, stale)),
    [snapshot, stale],
  );
}
