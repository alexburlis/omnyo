import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import type { DeckCardView, Suggestions } from "../lib/contract.ts";
import { CardBody } from "./card.tsx";
import {
  acceptPlan,
  actionLabels,
  keyIntent,
  requiresAnswerReview,
  type StepAnswer,
  type SwipeDirection,
} from "./deck-logic.ts";
import { AnswerPicker, SnoozeMenu } from "./picker.tsx";
import { SwipeCard } from "./swipe.tsx";
import { Button, Kbd } from "./ui/button.tsx";
import type { CardOperations } from "./use-card-operations.ts";
import type { FailedAnswer } from "./use-deck-actions.ts";

type Panel =
  | { kind: "none" }
  | { kind: "picker"; initial: StepAnswer[] }
  | { kind: "snooze" }
  | { kind: "reply" };

const NO_PANEL: Panel = { kind: "none" };

const ACTION_BUTTON =
  "min-h-8 h-auto flex-auto whitespace-normal py-1.5 sm:flex-none pointer-coarse:min-h-11";

function isEditable(target: EventTarget | null): boolean {
  return (
    target instanceof HTMLElement &&
    (target.isContentEditable || target.closest("input, textarea, select") !== null)
  );
}

function useTopSince(key: string | undefined): () => number {
  const since = useRef(Date.now());

  useEffect(() => {
    since.current = Date.now();
  }, [key]);

  return useCallback(() => Date.now() - since.current, []);
}

export function DeckStack({
  card: top,
  framed,
  operations,
  suggestions,
  offer,
  comparisons,
  failedAnswer,
  discardFailedAnswer,
}: {
  card: DeckCardView;
  framed: boolean;
  operations: CardOperations;
  suggestions: Suggestions;
  offer: ReactNode;
  comparisons: ReactNode;
  failedAnswer: FailedAnswer | null;
  discardFailedAnswer: () => void;
}) {
  const [panel, setPanel] = useState<Panel>(() =>
    failedAnswer === null ? NO_PANEL : { kind: "picker", initial: failedAnswer.draft },
  );

  const elapsed = useTopSince(top.key);
  const trigger = useRef<HTMLElement | null>(null);
  const actionsRow = useRef<HTMLDivElement>(null);
  const restoreFocus = useRef(false);

  const showPanel = useCallback((next: Panel) => {
    trigger.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setPanel(next);
  }, []);

  const closePanel = () => {
    restoreFocus.current = true;

    if (failedAnswer !== null) discardFailedAnswer();
    setPanel(NO_PANEL);
  };

  useEffect(() => {
    if (panel.kind !== "none" || !restoreFocus.current) return;
    restoreFocus.current = false;
    const previous = trigger.current;

    if (previous?.isConnected && previous !== document.body) {
      previous.focus();

      return;
    }

    const buttons = Array.from(actionsRow.current?.querySelectorAll("button") ?? []);

    const matching = buttons.find(
      (button) => button.dataset.cardAction === previous?.dataset.cardAction,
    );

    (matching ?? buttons[0])?.focus();
  }, [panel.kind]);

  const resume = operations.resumeFor(top);
  const labels = actionLabels(top, resume !== null);

  const openChat = useCallback(
    (card: DeckCardView) => {
      if (card.threadId !== null) operations.open(card, card.threadId, elapsed());
    },
    [elapsed, operations],
  );

  const act = useCallback(
    (direction: SwipeDirection) => {
      if (direction === "up") return showPanel({ kind: "snooze" });

      switch (top.kind) {
        case "question": {
          if (
            direction === "right" &&
            !requiresAnswerReview(top) &&
            operations.accept(top, elapsed())
          )
            return;

          const suggested = direction === "right" && !top.ruleOffer ? acceptPlan(top) : null;
          showPanel({
            kind: "picker",
            initial: suggested?.map((step) => ({ ...step, freeText: null })) ?? [],
          });

          return;
        }

        case "result":
          if (direction === "left") openChat(top);
          else if (top.suggestedReply === null) openChat(top);
          else showPanel({ kind: "reply" });

          return;
        case "problem":
          if (direction === "right" && resume !== null) operations.resume(top, resume, elapsed());
          else openChat(top);

          return;
        case "ask":
          openChat(top);
      }
    },
    [elapsed, openChat, operations, resume, showPanel, top],
  );

  const onKey = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey) return;

    if (isEditable(event.target)) return;

    const intent = keyIntent(event.key);

    if (intent === null || intent.kind === "undo" || panel.kind !== "none") return;

    const button =
      event.target instanceof HTMLElement ? event.target.closest<HTMLElement>("button, a") : null;

    if (button !== null && (event.key === "Enter" || button.dataset.cardAction !== intent.kind))
      return;
    event.preventDefault();
    act(intent.kind);
  };

  const footer =
    panel.kind === "picker" ? (
      <AnswerPicker
        card={top}
        initial={panel.initial}
        failure={failedAnswer?.message ?? null}
        onCancel={closePanel}
        onSubmit={(answers) => operations.answer(top, answers, elapsed())}
      />
    ) : panel.kind === "snooze" ? (
      <SnoozeMenu
        onCancel={closePanel}
        onPick={(picked) => operations.snooze(top, picked, elapsed())}
      />
    ) : panel.kind === "reply" ? (
      <ReplyReview onSend={() => operations.reply(top, elapsed())} onCancel={closePanel} />
    ) : (
      <div ref={actionsRow}>
        <ActionRow
          card={top}
          labels={labels}
          act={act}
          onArchive={() => operations.archive(top, elapsed())}
        />
      </div>
    );

  const showOffer = top.kind === "question" && !top.ruleOffer && panel.kind === "none";

  return (
    <div className="flex flex-col" onKeyDown={onKey}>
      <div className="relative">
        <SwipeCard
          key={top.key}
          labels={labels}
          framed={framed}
          onSwipe={(direction) => {
            if (panel.kind === "none") act(direction);
          }}
        >
          <CardBody
            card={top}
            suggestions={suggestions}
            onOpenChat={top.threadId === null ? null : () => openChat(top)}
            optionView={
              panel.kind === "picker" ? "picker" : requiresAnswerReview(top) ? "summary" : "preview"
            }
            footer={
              <>
                {comparisons}
                <div className="pt-1">{footer}</div>
                {showOffer ? offer : null}
              </>
            }
          />
        </SwipeCard>
      </div>
    </div>
  );
}

function ReplyReview({ onSend, onCancel }: { onSend: () => void; onCancel: () => void }) {
  return (
    <div
      className="flex flex-wrap items-center justify-end gap-2"
      onKeyDown={(event) => {
        if (event.key !== "Escape") return;

        event.preventDefault();
        onCancel();
      }}
    >
      <Button autoFocus variant="ghost" size="sm" className={ACTION_BUTTON} onClick={onCancel}>
        Cancel
      </Button>
      <Button size="sm" className={ACTION_BUTTON} onClick={onSend}>
        Send to chat
      </Button>
    </div>
  );
}

function ActionRow({
  card,
  labels,
  act,
  onArchive,
}: {
  card: DeckCardView;
  labels: ReturnType<typeof actionLabels>;
  act: (direction: SwipeDirection) => void;
  onArchive: () => void;
}) {
  const save = (
    <Button
      variant="ghost"
      size="sm"
      className={ACTION_BUTTON}
      data-card-action="up"
      onClick={() => act("up")}
    >
      {labels.up}
      <Kbd>↑</Kbd>
    </Button>
  );

  const primary = (
    <Button
      size="sm"
      className={ACTION_BUTTON}
      data-card-action="right"
      onClick={() => act("right")}
    >
      {labels.right}
      <Kbd>→</Kbd>
    </Button>
  );

  const secondary = (
    <Button
      variant="outline"
      size="sm"
      className={ACTION_BUTTON}
      data-card-action="left"
      onClick={() => act("left")}
    >
      {labels.left}
      <Kbd>←</Kbd>
    </Button>
  );

  const row = "flex flex-wrap items-center gap-2";

  if (card.ruleOffer)
    return (
      <div className={row}>
        {primary}
        {save}
      </div>
    );

  if (card.kind === "question")
    return (
      <div className={row}>
        {primary}
        {acceptPlan(card) === null ? null : secondary}
        {save}
      </div>
    );

  if (card.kind === "result")
    return (
      <div className={row}>
        {primary}
        {secondary}
        {save}
        <Button variant="ghost" size="sm" className={ACTION_BUTTON} onClick={onArchive}>
          Archive chat
        </Button>
      </div>
    );

  return (
    <div className={row}>
      {primary}
      {save}
    </div>
  );
}
