import { BATCH_LIMIT, itemKey } from "./inputs.ts";
import { adoptionChoiceSchema, type AdoptionChoice } from "./rules.ts";
import type { QuestionPayload } from "./sources.ts";

export function untriaged(
  open: readonly QuestionPayload[],
  known: ReadonlySet<string>,
  offerQuestionIds: ReadonlySet<string>,
  limit: number = BATCH_LIMIT,
): QuestionPayload[] {
  return open
    .filter(
      (question) =>
        !offerQuestionIds.has(question.id) && !known.has(itemKey(question.id, question.revision)),
    )
    .toSorted((a, b) => a.createdAt - b.createdAt)
    .slice(0, limit);
}

export type RuleAnswerPlan =
  | { kind: "wait" }
  | { kind: "unbind" }
  | {
      kind: "apply";
      choice: AdoptionChoice;
      revision: number;
      ownerAttributed: boolean;
      coreSupportsAttribution: boolean;
    };

export function planRuleAnswer(question: QuestionPayload | undefined): RuleAnswerPlan {
  if (question === undefined || question.state === "open") return { kind: "wait" };

  if (question.state !== "answered" || question.answer === null) return { kind: "unbind" };

  const choice = adoptionChoiceSchema.safeParse(question.answer.selected[0]);

  if (!choice.success) return { kind: "unbind" };

  return {
    kind: "apply",
    choice: choice.data,
    revision: question.revision,
    ownerAttributed: question.answeredBy?.kind === "owner",
    coreSupportsAttribution: question.answeredBy !== undefined,
  };
}
