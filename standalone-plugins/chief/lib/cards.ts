import type { DeckCardView, OpenQuestion } from "./contract.ts";
import { itemKey, type Verdict } from "./inputs.ts";

export type CardKind = DeckCardView["kind"];

export type Priority = Verdict["priority"];

export interface InboxItem {
  threadId: string;
  title: string;
  project: string;
  state: string;
  reasonKind: string;
  reasonText: string;
  archiveReady: boolean;
  latch: string;
  since: number;
}

export interface ChatInfo {
  title: string;
  project: string;
}

export interface DeckSources {
  questions: readonly OpenQuestion[];
  inbox: readonly InboxItem[];
  chats: ReadonlyMap<string, ChatInfo>;
  verdicts: ReadonlyMap<string, Verdict>;
  triageErrors: ReadonlyMap<string, string>;
  replies: ReadonlyMap<string, string>;
  snoozedUntil: ReadonlyMap<string, number>;
  chiefThreadId: string | null;
  offerQuestionIds: ReadonlySet<string>;
  showReplies: boolean;
  now: number;
}

export type DeckCard = DeckCardView;

export interface Deck {
  cards: DeckCard[];
  saved: number;
  savedCards: { card: DeckCard; until: number }[];
  toDecide: number;
  dot: "attention" | "failed" | null;
}

const PRIORITY_RANK: Record<Priority, number> = { now: 0, soon: 1, later: 2 };

const KIND_RANK: Record<CardKind, number> = {
  question: 0,
  problem: 1,
  ask: 2,
  result: 3,
};

function defaultPriority(kind: CardKind, required: boolean): Priority {
  if (kind === "problem" || (kind === "question" && required)) return "now";

  return kind === "question" || kind === "ask" ? "soon" : "later";
}

function strongest(priorities: readonly Priority[], fallback: Priority): Priority {
  return priorities.length === 0
    ? fallback
    : priorities.reduce((best, next) => (PRIORITY_RANK[next] < PRIORITY_RANK[best] ? next : best));
}

function questionCards(sources: DeckSources): DeckCard[] {
  const groups = new Map<string, OpenQuestion[]>();

  for (const question of sources.questions) {
    const groupKey = `${question.threadId}:${question.createdAt}`;
    const group = groups.get(groupKey);

    if (group) group.push(question);
    else groups.set(groupKey, [question]);
  }

  return [...groups.values()].map((group) => {
    const ordered = group.toSorted((a, b) => a.id.localeCompare(b.id));
    const first = ordered[0];
    const chat = sources.chats.get(first.threadId);

    const steps = ordered.map((question) => {
      const key = itemKey(question.id, question.revision);

      return {
        question,
        key,
        verdict: sources.verdicts.get(key) ?? null,
        triageError: sources.triageErrors.get(key) ?? null,
      };
    });

    const required = ordered.some((question) => question.mode === "required");
    const triaged = steps.flatMap((step) => (step.verdict ? [step.verdict.priority] : []));

    return {
      key: `question:${first.id}`,
      kind: "question",
      threadId: first.threadId,
      title: chat?.title ?? "Chat",
      project: chat?.project ?? "",
      text: first.prompt,
      steps,
      required,
      priority: strongest(triaged, defaultPriority("question", required)),
      suggestedReply: null,
      ruleOffer: ordered.some((question) => sources.offerQuestionIds.has(question.id)),
      latch: null,
      alsoAsked: [],
      since: first.createdAt,
    } satisfies DeckCard;
  });
}

function inboxCard(item: InboxItem, kind: CardKind, sources: DeckSources): DeckCard {
  return {
    key: `${kind}:${item.threadId}:${item.latch}`,
    kind,
    threadId: item.threadId,
    title: item.title,
    project: item.project,
    text: item.reasonText,
    steps: [],
    required: false,
    priority: defaultPriority(kind, false),
    suggestedReply: kind === "result" ? (sources.replies.get(item.threadId) ?? null) : null,
    ruleOffer: false,
    latch: item.latch,
    alsoAsked: [],
    since: item.since,
  };
}

function inboxCards(sources: DeckSources): DeckCard[] {
  const questionChats = new Set(sources.questions.map((question) => question.threadId));
  const cards: DeckCard[] = [];

  for (const item of sources.inbox) {
    if (item.threadId === sources.chiefThreadId || item.archiveReady) continue;

    if (item.reasonKind === "failure") cards.push(inboxCard(item, "problem", sources));
    else if (item.state === "needs-you" && !questionChats.has(item.threadId))
      cards.push(inboxCard(item, "ask", sources));
    else if (
      sources.showReplies &&
      item.state === "finished" &&
      !questionChats.has(item.threadId) &&
      sources.replies.has(item.threadId)
    )
      cards.push(inboxCard(item, "result", sources));
  }

  return cards;
}

export function countsTowardDecisions(card: DeckCard): boolean {
  return !card.ruleOffer && card.kind !== "result";
}

function annotateDuplicates(cards: DeckCard[]): DeckCard[] {
  const owner = new Map<string, DeckCard>();

  for (const card of cards) for (const step of card.steps) owner.set(step.key, card);

  for (const card of cards)
    for (const step of card.steps) {
      const target = step.verdict?.duplicateOf ? owner.get(step.verdict.duplicateOf) : undefined;

      if (target === undefined || target === card) continue;

      if (!target.alsoAsked.some((entry) => entry.key === step.key))
        target.alsoAsked.push({ threadId: card.threadId ?? "", title: card.title, key: step.key });

      const targetKey = step.verdict?.duplicateOf ?? "";

      if (!card.alsoAsked.some((entry) => entry.key === targetKey))
        card.alsoAsked.push({
          threadId: target.threadId ?? "",
          title: target.title,
          key: targetKey,
        });
    }

  return cards;
}

function rank(card: DeckCard): number {
  return card.ruleOffer ? 1 : card.kind === "result" ? 2 : 0;
}

export function buildDeck(sources: DeckSources): Deck {
  const all = annotateDuplicates([...questionCards(sources), ...inboxCards(sources)]);

  const savedCards = all.flatMap((card) => {
    const until = sources.snoozedUntil.get(card.key);

    return until !== undefined && until > sources.now ? [{ card, until }] : [];
  });

  const visible = all.filter((card) => (sources.snoozedUntil.get(card.key) ?? 0) <= sources.now);
  const deciding = visible.filter(countsTowardDecisions);

  return {
    cards: visible.toSorted(
      (a, b) =>
        rank(a) - rank(b) ||
        PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority] ||
        KIND_RANK[a.kind] - KIND_RANK[b.kind] ||
        a.since - b.since ||
        a.key.localeCompare(b.key),
    ),
    saved: savedCards.filter(({ card }) => countsTowardDecisions(card)).length,
    savedCards: savedCards.toSorted((a, b) => a.until - b.until),
    toDecide: new Set(deciding.map((card) => card.threadId ?? card.key)).size,
    dot:
      deciding.length === 0
        ? null
        : deciding.some((card) => card.kind === "problem")
          ? "failed"
          : "attention",
  };
}
