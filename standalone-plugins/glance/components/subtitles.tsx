import { useEffect } from "react";
import { experimental_useSidebarThreads } from "@omnyo/plugin-sdk/app";
import type { PluginContentScriptContext } from "@omnyo/plugin-sdk/app";
import { useIndex } from "./data";
import type { CardIndexEntry } from "../contract";
import { useInboxStates } from "./inbox-views";
import { cardPresentation, type CardPresentation, type PresentationStatus } from "./presentation";

interface ThreadSubtitle {
  text: string;
}

type SubtitleSetter = (threadId: string, subtitle: ThreadSubtitle | null) => void;

interface SubtitleContext extends PluginContentScriptContext {
  readonly experimental_setThreadRowSubtitle?: SubtitleSetter;
}

let setter: SubtitleSetter | null = null;

let desired = new Map<string, string>();

let applied = new Map<string, string>();

function sync() {
  if (setter === null) return;

  for (const threadId of applied.keys()) {
    if (!desired.has(threadId)) setter(threadId, null);
  }

  for (const [threadId, text] of desired) {
    if (applied.get(threadId) !== text) setter(threadId, { text });
  }

  applied = new Map(desired);
}

export function mountSubtitles(context: SubtitleContext) {
  if (context.experimental_setThreadRowSubtitle === undefined) return;
  setter = context.experimental_setThreadRowSubtitle;
  applied = new Map();
  sync();

  return () => {
    setter = null;
    applied = new Map();
  };
}

function subtitle(card: CardIndexEntry, presentation: CardPresentation) {
  const status = presentation.status;

  if (status === "done") {
    const text = card.sidebarSummary ?? card.headline;
    const characters = Array.from(text);

    if (characters.length <= 64) return text;

    const clipped = characters.slice(0, 63).join("");
    const boundary = clipped.lastIndexOf(" ");

    return `${boundary > 0 ? clipped.slice(0, boundary) : clipped}…`;
  }

  const prefixes: Record<PresentationStatus, string> = {
    "needs-you": "Needs you: ",
    blocked: "Blocked: ",
    working: "",
    done: "",
    finished: "Finished: ",
    waiting: "Waiting: ",
    open: "",
    idle: "",
    unknown: "",
    failed: "Failed: ",
  };

  const prefix = prefixes[status];

  const text = `${prefix}${presentation.headline}`;

  return text.length > 140 ? `${text.slice(0, 139)}…` : text;
}

export function SubtitleSync() {
  const { cards } = useIndex();
  const { threads } = experimental_useSidebarThreads();
  const serverViews = useInboxStates();

  useEffect(() => {
    desired = new Map();
    const threadsById = new Map(threads.map((thread) => [thread.id, thread]));

    for (const card of cards ?? []) {
      const thread = threadsById.get(card.threadId);

      if (thread === undefined && card.status === "needs-you" && card.stale) continue;
      desired.set(
        card.threadId,
        subtitle(
          card,
          cardPresentation(card, thread, undefined, serverViews.get(card.threadId) ?? null),
        ),
      );
    }

    sync();
  }, [cards, threads, serverViews]);

  useEffect(
    () => () => {
      desired = new Map();
      sync();
    },
    [],
  );

  return null;
}
