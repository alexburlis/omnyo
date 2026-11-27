import type { experimental_PluginBrowserSdk } from "@omnyo/plugin-sdk/app";
import type { DeckCardView, OutcomeInput } from "../lib/contract.ts";

type AttentionArea = experimental_PluginBrowserSdk["experimental_attention"];

type AttentionCommand = Parameters<AttentionArea["command"]>[0]["command"];

export type AnswersCommand = Extract<AttentionCommand, { action: "answers" }>;

export type DeckStep = DeckCardView["steps"][number];

export type SwipeDirection = "right" | "left" | "up";

export const EDGE_GUARD_PX = 24;

export const SWIPE_X_PX = 90;

export const SWIPE_UP_PX = 80;

export const PREVIEW_PX = 16;

export const UNDO_MS = 5000;

export const REFRESH_MS = 15_000;

const HOUR_MS = 3_600_000;

const MAX_DIGIT = 8;

export function inEdgeGuard(x: number, viewportWidth: number): boolean {
  return x < EDGE_GUARD_PX || x > viewportWidth - EDGE_GUARD_PX;
}

export function dragDirection(dx: number, dy: number): SwipeDirection | null {
  if (Math.abs(dx) >= Math.abs(dy)) {
    if (Math.abs(dx) < PREVIEW_PX) return null;

    return dx > 0 ? "right" : "left";
  }

  return dy <= -PREVIEW_PX ? "up" : null;
}

export function committedSwipe(dx: number, dy: number): SwipeDirection | null {
  const direction = dragDirection(dx, dy);

  if (direction === "up") return -dy >= SWIPE_UP_PX ? "up" : null;

  if (direction === null) return null;

  return Math.abs(dx) >= SWIPE_X_PX ? direction : null;
}

export function swipeProgress(direction: SwipeDirection | null, dx: number, dy: number): number {
  if (direction === null) return 0;

  return Math.min(1, direction === "up" ? -dy / SWIPE_UP_PX : Math.abs(dx) / SWIPE_X_PX);
}

export interface AcceptStep {
  id: string;
  revision: number;
  selected: string[];
}

export function chiefValues(step: DeckStep): string[] {
  const values = new Set(step.question.options.map((option) => option.value));
  const recommended = (step.verdict?.recommendation ?? []).filter((value) => values.has(value));

  return step.question.multiSelect ? recommended : recommended.slice(0, 1);
}

export function agentValues(step: DeckStep): string[] {
  const recommended = step.question.options.flatMap((option) =>
    option.recommended ? [option.value] : [],
  );

  return step.question.multiSelect ? recommended : recommended.slice(0, 1);
}

export function acceptPlan(card: DeckCardView): AcceptStep[] | null {
  if (card.kind !== "question" || card.ruleOffer || card.steps.length === 0) return null;
  const plan: AcceptStep[] = [];

  for (const step of card.steps) {
    const chief = chiefValues(step);

    if (chief.length === 0) return null;
    plan.push({ id: step.question.id, revision: step.question.revision, selected: chief });
  }

  return plan;
}

export function suggestedChoice(card: DeckCardView): string | null {
  const plan = acceptPlan(card);

  if (plan?.length !== 1 || plan[0].selected.length !== 1) return null;

  return (
    card.steps[0]?.question.options.find((option) => option.value === plan[0].selected[0])
      ?.label ?? null
  );
}

export interface StepAnswer {
  id: string;
  revision: number;
  selected: string[];
  freeText: string | null;
}

export function restoreAnswers(card: DeckCardView, draft: readonly StepAnswer[]): StepAnswer[] {
  const byId = new Map(draft.map((answer) => [answer.id, answer]));

  return card.steps.map(({ question }) => {
    const previous = byId.get(question.id);
    const options = new Set(question.options.map((option) => option.value));
    const selected = previous?.selected.filter((value) => options.has(value)) ?? [];

    return {
      id: question.id,
      revision: question.revision,
      selected: question.multiSelect ? selected : selected.slice(0, 1),
      freeText: question.allowFreeText ? previous?.freeText ?? null : null,
    };
  });
}

export function answersCommand(answers: readonly StepAnswer[]): AnswersCommand {
  return {
    action: "answers",
    answers: answers.map((item) => {
      const text = item.freeText?.trim() ?? "";

      if (item.selected.length === 0 && text === "")
        return { id: item.id, revision: item.revision, answer: null };

      return {
        id: item.id,
        revision: item.revision,
        answer:
          text === "" ? { selected: item.selected } : { selected: item.selected, freeText: text },
      };
    }),
  };
}

export function answerShortcutIndex(key: string): number | null {
  const digit = /^[1-9]$/u.test(key) ? Number(key) : 0;

  return digit >= 1 && digit <= MAX_DIGIT ? digit - 1 : null;
}

export type KeyIntent =
  | { kind: "right" }
  | { kind: "left" }
  | { kind: "up" }
  | { kind: "undo" };

export function keyIntent(key: string): KeyIntent | null {
  if (key === "ArrowRight" || key === "Enter") return { kind: "right" };

  if (key === "ArrowLeft") return { kind: "left" };

  if (key === "ArrowUp") return { kind: "up" };

  if (key === "z" || key === "Z") return { kind: "undo" };

  return null;
}

export interface ActionLabels {
  right: string;
  left: string;
  up: string;
}

export function requiresAnswerReview(card: DeckCardView): boolean {
  return card.ruleOffer || card.steps.some((step) => step.verdict?.authorityLike === true);
}

export function actionLabels(card: DeckCardView, resumable: boolean): ActionLabels {
  const up = "Save for later";

  switch (card.kind) {
    case "question":
      if (card.ruleOffer) return { right: "Review rule", left: "Review rule", up };

      const plan = acceptPlan(card);
      const action = requiresAnswerReview(card) ? "Review" : "Send";

      return {
        right:
          plan === null
            ? "Choose an answer"
            : `${action} suggested ${plan.length === 1 ? "answer" : "answers"}`,
        left: "See other answers",
        up,
      };
    case "result":
      return {
        right: card.suggestedReply === null ? "Open chat" : "Review reply",
        left: "Open chat",
        up,
      };
    case "problem":
      return { right: resumable ? "Resume" : "Open chat", left: "Open chat", up };
    case "ask":
      return { right: "Open chat", left: "Open chat", up };
  }
}

export interface SnoozeChoice {
  label: string;
  until: number;
}

export function snoozeChoices(now: Date): SnoozeChoice[] {
  const tonight = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 18, 0);
  const tomorrow = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 9, 0);
  const choices: SnoozeChoice[] = [{ label: "In 1 hour", until: now.getTime() + HOUR_MS }];

  if (tonight.getTime() > now.getTime() + HOUR_MS)
    choices.push({ label: "Tonight 18:00", until: tonight.getTime() });
  choices.push({ label: "Tomorrow 09:00", until: tomorrow.getTime() });

  return choices;
}

export interface PendingSend {
  id: string;
  cardKey: string;
  label: string;
  dueAt: number;
}

export function schedule(queue: readonly PendingSend[], item: PendingSend): PendingSend[] {
  return [...queue, item];
}

export interface Cancellation {
  queue: PendingSend[];
  cancelled: PendingSend | null;
}

export function cancelLatest(queue: readonly PendingSend[]): Cancellation {
  const cancelled = queue.at(-1) ?? null;

  return { queue: queue.slice(0, -1), cancelled };
}

export function cancelById(queue: readonly PendingSend[], id: string): Cancellation {
  const cancelled = queue.find((item) => item.id === id) ?? null;

  return { queue: queue.filter((item) => item.id !== id), cancelled };
}

export interface Release {
  due: PendingSend[];
  rest: PendingSend[];
}

export function takeDue(queue: readonly PendingSend[], now: number): Release {
  return {
    due: queue.filter((item) => item.dueAt <= now),
    rest: queue.filter((item) => item.dueAt > now),
  };
}

export function pruneHidden(
  hidden: ReadonlySet<string>,
  cards: readonly DeckCardView[],
): Set<string> {
  const listed = new Set(cards.map((card) => card.key));

  return new Set([...hidden].filter((key) => listed.has(key)));
}

export interface OutcomeChoice {
  action: OutcomeInput["action"];
  chosen: string[];
  freeText: string | null;
  reasonChip: string | null;
  responseMs: number | null;
  steps: StepAnswer[] | null;
}

export function outcomesFor(card: DeckCardView, choice: OutcomeChoice): OutcomeInput[] {
  const responseMs = choice.responseMs === null ? null : Math.max(0, Math.round(choice.responseMs));

  const base = {
    cardKey: card.key,
    cardKind: card.kind,
    threadId: card.threadId,
    reasonChip: choice.reasonChip,
    responseMs,
  };

  if (choice.steps === null || choice.steps.length === 0)
    return [
      {
        ...base,
        action: choice.action,
        questionIds: card.steps.map((step) => step.question.id),
        chosen: choice.chosen,
        freeText: choice.freeText,
      },
    ];

  const plan = new Map(card.steps.map((step) => [step.question.id, chiefValues(step)]));

  return choice.steps.map((step) => {
    const recommended = plan.get(step.id) ?? [];
    const freeText = step.freeText?.trim() || null;

    const accepted =
      recommended.length > 0 &&
      step.selected.length === recommended.length &&
      step.selected.every((value) => recommended.includes(value));

    return {
      ...base,
      action: freeText !== null ? "custom" : accepted ? "accept" : "alternative",
      questionIds: [step.id],
      chosen: step.selected,
      freeText,
    };
  });
}
