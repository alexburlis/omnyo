import { z } from "zod";
import { PHASES, type GlanceCard } from "./feed.ts";

export const CARD_CHANGED_EVENT = "omnyo-glance:changed";

export const cardSchema = z.object({
  threadId: z.string(),
  status: z.enum(["working", "needs-you", "blocked", "done"]),
  phase: z.enum(PHASES),
  headline: z.string(),
  sidebarSummary: z.string().nullable(),
  blocker: z.string().nullable(),
  next: z.string().nullable(),
  stale: z.boolean(),
  unseen: z.boolean(),
  updatedAt: z.number(),
});

const changeSchema = z.object({ threadId: z.string(), entry: cardSchema.nullable() });

export const missingGlanceSchema = z.object({ status: z.literal(404) });

export interface CardChange {
  threadId: string;
  card: GlanceCard | null;
}

export interface CardPatch {
  card: GlanceCard | null;
  at: number;
}

export function onCardChange(
  target: EventTarget,
  listener: (change: CardChange | null) => void,
): () => void {
  const handle = (event: Event) => {
    const change = changeSchema.safeParse(event instanceof CustomEvent ? event.detail : null);

    listener(change.success ? { threadId: change.data.threadId, card: change.data.entry } : null);
  };

  target.addEventListener(CARD_CHANGED_EVENT, handle);

  return () => target.removeEventListener(CARD_CHANGED_EVENT, handle);
}

export function mergeIndex(
  index: ReadonlyMap<string, GlanceCard>,
  patches: ReadonlyMap<string, CardPatch>,
  requestedAt: number,
): Map<string, GlanceCard> {
  const cards = new Map(index);

  for (const [threadId, patch] of patches) {
    if (patch.at < requestedAt) continue;

    if (patch.card === null) cards.delete(threadId);
    else cards.set(threadId, patch.card);
  }

  return cards;
}
