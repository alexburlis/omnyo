import { useEffect, useRef, useState } from "react";
import type { DeckCardView } from "../lib/contract.ts";
import { Button } from "./ui/button.tsx";
import {
  answerShortcutIndex,
  chiefValues,
  requiresAnswerReview,
  restoreAnswers,
  snoozeChoices,
  type SnoozeChoice,
  type StepAnswer,
} from "./deck-logic.ts";

function toggled(values: readonly string[], value: string, multi: boolean): string[] {
  if (!multi) return [value];

  return values.includes(value) ? values.filter((item) => item !== value) : [...values, value];
}

export function AnswerPicker({
  card,
  initial,
  failure,
  onSubmit,
  onCancel,
}: {
  card: DeckCardView;
  initial: StepAnswer[];
  failure: string | null;
  onSubmit: (answers: StepAnswer[]) => void;
  onCancel: () => void;
}) {
  const [draft, setDraft] = useState(initial);
  const answers = restoreAnswers(card, draft);
  const form = useRef<HTMLFormElement>(null);

  useEffect(() => {
    const first =
      form.current?.querySelector("input:checked") ??
      form.current?.querySelector("input, textarea, button");

    if (first instanceof HTMLElement) first.focus();
  }, []);

  const review = requiresAnswerReview(card);

  const complete = card.steps.every(
    (step, index) =>
      (step.question.mode === "optional" && !review) ||
      answers[index].selected.length > 0 ||
      Boolean(answers[index].freeText?.trim()),
  );

  const update = (id: string, change: (answer: StepAnswer) => StepAnswer) => {
    setDraft((current) =>
      restoreAnswers(card, current).map((answer) => (answer.id === id ? change(answer) : answer)),
    );
  };

  return (
    <form
      ref={form}
      className="flex flex-col gap-3"
      onSubmit={(event) => {
        event.preventDefault();

        if (complete) onSubmit(answers);
      }}
      onKeyDown={(event) => {
        if (event.key !== "Escape") return;

        event.preventDefault();
        onCancel();
      }}
    >
      {card.steps.map((step, index) => {
        const question = step.question;
        const suggested = card.ruleOffer ? [] : chiefValues(step);

        return (
          <fieldset
            key={step.key}
            className="m-0 flex flex-col gap-1.5 border-0 p-0"
            onKeyDown={(event) => {
              const { target } = event;

              if (
                event.defaultPrevented ||
                event.repeat ||
                event.altKey ||
                event.ctrlKey ||
                event.metaKey ||
                event.shiftKey ||
                !(target instanceof HTMLInputElement) ||
                (target.type !== "radio" && target.type !== "checkbox")
              )
                return;

              const at = answerShortcutIndex(event.key);

              if (at === null) return;
              const option = question.options[at];
              const input = event.currentTarget.querySelectorAll<HTMLInputElement>("input")[at];

              if (option === undefined || input === undefined) return;
              event.preventDefault();
              update(question.id, (answer) => ({
                ...answer,
                selected: toggled(answer.selected, option.value, question.multiSelect),
              }));
              input.focus();
            }}
          >
            <legend className="mb-1 text-sm font-medium">
              {card.steps.length === 1 ? "Choose your answer" : step.question.prompt}
            </legend>
            {question.options.map((option, at) => (
              <label
                key={option.value}
                className="flex min-h-8 cursor-pointer items-center gap-2 text-sm pointer-coarse:min-h-10"
              >
                <input
                  type={question.multiSelect ? "checkbox" : "radio"}
                  name={step.key}
                  checked={answers[index].selected.includes(option.value)}
                  aria-keyshortcuts={at < 8 ? String(at + 1) : undefined}
                  onChange={() =>
                    update(question.id, (answer) => ({
                      ...answer,
                      selected: toggled(answer.selected, option.value, question.multiSelect),
                    }))
                  }
                />
                <span>
                  {at < 8 ? (
                    <span aria-hidden className="mr-1.5 font-mono text-xs text-muted-foreground pointer-coarse:hidden">
                      {at + 1}
                    </span>
                  ) : null}
                  {option.label}
                  {suggested.includes(option.value) ? (
                    <span className="ml-2 text-xs text-muted-foreground">Chief recommends</span>
                  ) : null}
                  {option.description === null ? null : (
                    <span className="block text-xs text-muted-foreground">{option.description}</span>
                  )}
                  {suggested[0] === option.value && step.verdict !== null ? (
                    <span className="mt-0.5 block text-xs text-muted-foreground">
                      {step.verdict.reason}
                    </span>
                  ) : null}
                </span>
              </label>
            ))}
            {question.allowFreeText ? (
              <textarea
                aria-label={`Your own answer to: ${step.question.prompt}`}
                placeholder="Or write your own answer"
                rows={2}
                className="rounded-md border border-input bg-transparent px-2 py-1 text-sm"
                value={answers[index].freeText ?? ""}
                onChange={(event) => {
                  const freeText = event.currentTarget.value || null;

                  update(question.id, (answer) => ({
                    ...answer,
                    freeText,
                  }));
                }}
              />
            ) : null}
          </fieldset>
        );
      })}
      <div className="flex flex-wrap items-center justify-end gap-2">
        {failure === null ? null : (
          <p role="alert" className="m-0 mr-auto w-full text-sm text-destructive-text">
            Couldn’t send your answer. {failure}
          </p>
        )}
        <Button variant="ghost" size="sm" className="pointer-coarse:h-10" onClick={onCancel}>
          Cancel
        </Button>
        <Button size="sm" className="pointer-coarse:h-10" type="submit" disabled={!complete}>
          {failure !== null
            ? "Try again"
            : card.steps.length === 1
              ? "Send answer to chat"
              : "Send answers to chat"}
        </Button>
      </div>
    </form>
  );
}

export function SnoozeMenu({
  onPick,
  onCancel,
}: {
  onPick: (choice: SnoozeChoice) => void;
  onCancel: () => void;
}) {
  const [choices] = useState(() => snoozeChoices(new Date()));

  return (
    <div
      role="group"
      aria-label="Show again"
      className="flex flex-wrap items-center gap-2"
      onKeyDown={(event) => {
        if (event.key !== "Escape") return;

        event.preventDefault();
        onCancel();
      }}
    >
      <span className="text-sm text-muted-foreground">Show again</span>
      {choices.map((choice, index) => (
        <Button
          key={choice.label}
          variant="outline"
          size="sm"
          className="pointer-coarse:h-10"
          autoFocus={index === 0}
          onClick={() => onPick(choice)}
        >
          {choice.label}
        </Button>
      ))}
      <Button variant="ghost" size="sm" className="pointer-coarse:h-10" onClick={onCancel}>
        Cancel
      </Button>
    </div>
  );
}
