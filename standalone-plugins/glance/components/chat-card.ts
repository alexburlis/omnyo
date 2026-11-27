import { useEffect, useRef, useState } from "react";
import {
  experimental_useSidebarThreads,
  experimental_useThreadWork,
  useRpc,
  type PluginSidebarThread,
} from "@omnyo/plugin-sdk/app";
import type { CardView, GlanceRpcContract } from "../contract";
import { useCard } from "./data";
import { cardPresentation, currentWorkPresentation, type CardPresentation } from "./presentation";
import { useInboxStates, type ServerView } from "./inbox-views";
import { useReadiness, type Readiness } from "./readiness";
import { formatAge } from "./summary";

export type WorkSummary = NonNullable<PluginSidebarThread["experimental_work"]>;

export function waitsForServerUpdate(work: WorkSummary | null): boolean {
  if (work?.primary.reason.code !== "external-wait") return false;
  const actor = work.waits[0]?.actor;

  return actor?.kind === "external" && actor.label === "Server update";
}

export type CardSource = ReturnType<typeof useCard>;

export interface LoadedCard {
  kind: "card";
  view: CardView;
  thread: PluginSidebarThread | undefined;
  readiness: Readiness;
  presentation: CardPresentation;
  archive: PluginSidebarThread | null;
  changed: boolean;
  line: string;
  updating: boolean;
  age: string;
  freshness: string;
  stale: boolean;
}

export interface WorkCard {
  kind: "work";
  work: WorkSummary;
  thread: PluginSidebarThread | undefined;
  ready: boolean;
  presentation: CardPresentation;
  line: string;
  stale: boolean;
  updating: boolean;
}

export type ChatCard =
  | { kind: "hidden" }
  | WorkCard
  | { kind: "failed"; error: string }
  | LoadedCard;

const hidden: ChatCard = { kind: "hidden" };

function chatCard(
  source: CardSource,
  thread: PluginSidebarThread | undefined,
  work: WorkSummary | null,
  readiness: Readiness,
  now: number,
  serverView: ServerView | null,
): ChatCard {
  const { view, diff } = source;

  if (view === null) {
    if (source.loading) return hidden;

    if (source.error !== null) return { kind: "failed", error: source.error };

    if (work === null) return hidden;
    const presentation = currentWorkPresentation(work, serverView);

    return {
      kind: "work",
      work,
      thread,
      ready: readiness === "ready" && (serverView === null || serverView.archiveReady),
      presentation,
      line: presentation.headline,
      stale: serverView?.stale ?? false,
      updating: waitsForServerUpdate(work) && presentation.headline === work.primary.reason.text,
    };
  }

  if (thread === undefined && view.card.status === "needs-you" && view.staleSince !== null)
    return hidden;

  const presentation = cardPresentation(
    { ...view.card, stale: view.staleSince !== null },
    thread,
    work,
    serverView,
  );

  const age = formatAge(view.updatedAt, now);

  const complete =
    (serverView === null ? presentation.status === "done" : serverView.archiveReady) &&
    readiness === "ready" &&
    view.staleSince === null &&
    thread !== undefined &&
    !thread.isArchived;

  return {
    kind: "card",
    view,
    thread,
    readiness,
    presentation,
    archive: complete ? thread : null,
    changed:
      diff !== null &&
      diff.seenRevision !== null &&
      (diff.seenRevision < view.revision || diff.newReplies > 0 || diff.moreActivity),
    line:
      presentation.status === "done" && view.card.sidebarSummary !== undefined
        ? view.card.sidebarSummary
        : presentation.headline,
    updating: waitsForServerUpdate(work) && presentation.headline === work?.primary.reason.text,
    age,
    stale: serverView?.stale ?? false,
    freshness:
      view.staleSince === null
        ? `Card updated ${age}.`
        : `The chat continued after this card was updated ${age}.`,
  };
}

function useNow() {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 60_000);

    return () => clearInterval(timer);
  }, []);

  return now;
}

export function useChatCard(threadId: string) {
  const source = useCard(threadId);
  const { threads } = experimental_useSidebarThreads();
  const thread = threads.find((entry) => entry.id === threadId);
  const work = experimental_useThreadWork(threadId);
  const readiness = useReadiness(threadId);
  const now = useNow();
  const serverView = useInboxStates().get(threadId) ?? null;

  return { source, card: chatCard(source, thread, work, readiness, now, serverView) };
}

export function useMarkSeen(threadId: string, source: CardSource, visible: boolean) {
  const rpc = useRpc<GlanceRpcContract>();
  const seen = useRef({ revision: 0, conversationSeq: 0 });
  const [seenError, setSeenError] = useState(false);
  const { view, conversationSeq, current } = source;

  useEffect(() => {
    if (
      !visible ||
      !current ||
      conversationSeq === null ||
      view === null ||
      (seen.current.revision >= view.revision && seen.current.conversationSeq >= conversationSeq)
    )
      return;
    const revision = view.revision;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let active = true;

    const schedule = () => {
      clearTimeout(timer);

      if (document.visibilityState !== "visible") return;
      timer = setTimeout(() => {
        rpc.call("card.markSeen", { threadId, revision, conversationSeq }).then(
          () => {
            if (!active) return;
            seen.current = {
              revision: Math.max(seen.current.revision, revision),
              conversationSeq: Math.max(seen.current.conversationSeq, conversationSeq),
            };
            setSeenError(false);
          },
          () => {
            if (active) setSeenError(true);
          },
        );
      }, 2000);
    };

    schedule();
    document.addEventListener("visibilitychange", schedule);

    return () => {
      active = false;
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", schedule);
    };
  }, [conversationSeq, current, rpc, threadId, view, visible]);

  return seenError;
}
