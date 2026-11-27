import type { ReactNode } from "react";
import type { DeckCardView, Suggestions } from "../lib/contract.ts";
import { confidenceWord, kindLabel, stepNote, type StepNote } from "./chief-logic.ts";
import { agentValues, chiefValues, type DeckStep } from "./deck-logic.ts";
import { Button } from "./ui/button.tsx";
import { cn } from "./ui/utils.ts";

type Tone = "plain" | "strong" | "danger";

const TONES: Record<Tone, string> = {
  plain: "border-border text-muted-foreground",
  strong: "border-foreground/40 text-foreground",
  danger: "border-destructive/45 text-destructive-text",
};

export function Badge({ children, tone = "plain" }: { children: string; tone?: Tone }) {
  return (
    <span
      className={cn(
        "inline-flex h-[18px] shrink-0 items-center rounded-full border px-1.5 text-2xs whitespace-nowrap",
        TONES[tone],
      )}
    >
      {children}
    </span>
  );
}

function NoteLine({
  note,
  options,
}: {
  note: StepNote;
  options: DeckStep["question"]["options"];
}) {
  if (note.kind === "verdict")
    return (
      <div className="flex flex-col gap-1 rounded-md bg-state-hover px-3 py-2 text-xs">
        <p className="m-0 text-muted-foreground">
          {options.length === 0 ? "Chief’s reasoning" : "Chief recommends"} ·{" "}
          {confidenceWord(note.verdict.confidence)}
        </p>
        {options.map((option) => (
          <div key={option.value} className="flex flex-col gap-0.5">
            <p className="m-0 text-sm font-medium">{option.label}</p>
            {option.description === null ? null : <p className="m-0">{option.description}</p>}
          </div>
        ))}
        <p className="m-0 text-muted-foreground">{note.verdict.reason}</p>
      </div>
    );

  if (note.kind === "reading")
    return <p className="m-0 text-xs text-muted-foreground">Reading the question…</p>;

  if (note.kind === "none")
    return (
      <details className="text-xs text-muted-foreground">
        <summary className="cursor-pointer">No suggestion this time. Why?</summary>
        <p className="m-0 mt-1">{note.reason}</p>
      </details>
    );

  return null;
}

function StepView({
  step,
  suggestions,
  ruleOffer,
  optionView,
}: {
  step: DeckStep;
  suggestions: Suggestions;
  ruleOffer: boolean;
  optionView: "summary" | "preview" | "picker";
}) {
  const chief = new Set(chiefValues(step));
  const agent = new Set(agentValues(step));
  const note: StepNote = ruleOffer ? { kind: "hidden" } : stepNote(step, suggestions);
  const showOptions = optionView === "preview";
  const placedNote = showOptions && note.kind === "verdict" && chief.size > 0;

  const recommended = step.question.options.filter((option) => chief.has(option.value));

  return (
    <section className="flex flex-col gap-2">
      <p className="m-0 text-base leading-snug font-medium whitespace-pre-wrap">
        {step.question.prompt}
      </p>
      {step.question.context === null ? null : (
        <p className="m-0 whitespace-pre-wrap text-sm text-muted-foreground">
          {step.question.context}
        </p>
      )}
      {!showOptions || step.question.options.length === 0 ? null : (
        <ol className="m-0 mt-1.5 flex list-none flex-col gap-1.5 p-0">
          {step.question.options.map((option) => {
            const body = (
              <>
                <span className="min-w-0 flex-1 text-left">
                  <span className="text-sm">{option.label}</span>
                  {option.description === null ? null : (
                    <span className="block text-xs text-muted-foreground">
                      {option.description}
                    </span>
                  )}
                </span>
                <span className="flex shrink-0 gap-1">
                  {chief.has(option.value) ? <Badge tone="strong">Chief suggests</Badge> : null}
                  {agent.has(option.value) && !ruleOffer ? <Badge>Agent&apos;s pick</Badge> : null}
                </span>
              </>
            );

            const row = "flex min-h-9 w-full items-center gap-2 rounded-md border px-3 py-1.5";

            return (
              <li key={option.value} className="flex flex-col gap-1">
                <div
                  className={cn(
                    row,
                    chief.has(option.value) ? "border-foreground/40" : "border-border",
                  )}
                >
                  {body}
                </div>
                {placedNote && chief.has(option.value) && [...chief][0] === option.value ? (
                  <NoteLine note={note} options={[]} />
                ) : null}
              </li>
            );
          })}
        </ol>
      )}
      {placedNote || (optionView === "picker" && recommended.length > 0) ? null : (
        <NoteLine note={note} options={recommended} />
      )}
    </section>
  );
}

export function CardBody({
  card,
  suggestions,
  onOpenChat,
  optionView,
  footer,
}: {
  card: DeckCardView;
  suggestions: Suggestions;
  onOpenChat: (() => void) | null;
  optionView: "summary" | "preview" | "picker";
  footer: ReactNode;
}) {
  const kind = kindLabel(card);
  const question = card.steps[0]?.question;
  const heading = card.kind === "question" ? question?.shortLabel.trim() : undefined;

  return (
    <div className="flex flex-col gap-4">
      <header className="flex min-w-0 items-start gap-3">
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <span className="flex items-center gap-1.5">
            {card.kind === "question" && card.required && !card.ruleOffer ? null : (
              <Badge tone={card.kind === "problem" ? "danger" : "plain"}>{kind}</Badge>
            )}
            {card.required ? (
              <Badge tone="strong">
                {card.kind === "question" ? "Answer required" : "Required"}
              </Badge>
            ) : null}
          </span>
          <span className="truncate text-xs text-muted-foreground">
            {[card.title, card.project].filter((part) => part !== "").join(" · ")}
          </span>
        </div>
        {onOpenChat === null || card.threadId === null ? null : (
          <Button variant="ghost" size="sm" className="shrink-0 pointer-coarse:min-h-11" onClick={onOpenChat}>
            Open chat
          </Button>
        )}
      </header>
      {heading && heading !== question?.prompt.trim() ? (
        <h2 className="m-0 text-lg font-semibold">{heading}</h2>
      ) : null}
      {card.kind === "question" ? null : (
        <p className="m-0 text-base leading-snug whitespace-pre-wrap">{card.text}</p>
      )}
      {card.steps.map((step) => (
        <StepView
          key={step.key}
          step={step}
          suggestions={suggestions}
          ruleOffer={card.ruleOffer}
          optionView={optionView}
        />
      ))}
      {card.alsoAsked.length === 0 ? null : (
        <p className="m-0 text-xs text-muted-foreground">
          Also asked in {card.alsoAsked.length} {card.alsoAsked.length === 1 ? "chat" : "chats"}:{" "}
          {card.alsoAsked.map((chat) => chat.title).join(", ")}
        </p>
      )}
      {card.kind === "result" && card.suggestedReply !== null ? (
        <blockquote className="m-0 whitespace-pre-wrap rounded-md border border-border bg-muted px-3 py-2 text-sm">
          {card.suggestedReply}
        </blockquote>
      ) : null}
      {footer}
    </div>
  );
}
