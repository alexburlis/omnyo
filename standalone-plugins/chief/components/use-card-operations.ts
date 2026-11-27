import { useCallback, useMemo } from "react";
import {
  experimental_useAppNavigate,
  experimental_useInboxSnapshot,
  useRpc,
  useSdk,
  type experimental_PluginBrowserSdk,
} from "@omnyo/plugin-sdk/app";
import type { DeckCardView, rpcContract } from "../lib/contract.ts";
import {
  UNDO_MS,
  acceptPlan,
  answersCommand,
  type OutcomeChoice,
  type SnoozeChoice,
  type StepAnswer,
} from "./deck-logic.ts";
import type { DeckActions, UndoNotice } from "./use-deck-actions.ts";

type InboxArea = experimental_PluginBrowserSdk["experimental_inbox"];

type InboxActRequest = Parameters<InboxArea["act"]>[0]["request"];

function choice(
  action: OutcomeChoice["action"],
  responseMs: number,
  chosen: string[] = [],
  freeText: string | null = null,
  reasonChip: string | null = null,
  steps: StepAnswer[] | null = null,
): OutcomeChoice {
  return { action, chosen, freeText, reasonChip, responseMs, steps };
}

export interface CardOperations {
  resumeFor: (card: DeckCardView) => InboxActRequest | null;
  accept: (card: DeckCardView, responseMs: number) => boolean;
  answer: (card: DeckCardView, answers: StepAnswer[], responseMs: number) => void;
  reply: (card: DeckCardView, responseMs: number) => void;
  archive: (card: DeckCardView, responseMs: number) => void;
  resume: (card: DeckCardView, request: InboxActRequest, responseMs: number) => void;
  snooze: (card: DeckCardView, picked: SnoozeChoice, responseMs: number) => void;
  open: (card: DeckCardView, threadId: string, responseMs: number) => void;
}

export function useCardOperations(actions: DeckActions): CardOperations {
  const sdk = useSdk();
  const rpc = useRpc<typeof rpcContract>();
  const nav = experimental_useAppNavigate();
  const { snapshot } = experimental_useInboxSnapshot();
  const { later, immediately, record } = actions;

  const resumeFor = useCallback(
    (card: DeckCardView): InboxActRequest | null => {
      const entry = snapshot?.inbox.find((item) => item.threadId === card.threadId);
      const primary = entry?.card?.primary;

      if (entry === undefined || entry.card === null || primary?.kind !== "resume") return null;

      return {
        action: "resume",
        threadId: entry.threadId,
        displayedReceiptIds: entry.card.causes.map((cause) => cause.receiptId),
        latch: entry.latch,
        targetThreadId: primary.targetThreadId,
      };
    },
    [snapshot],
  );

  const answer = useCallback(
    (card: DeckCardView, answers: StepAnswer[], responseMs: number) => {
      const threadId = card.threadId;

      if (threadId === null) return;
      const plan = acceptPlan(card);
      const chosen = answers.flatMap((item) => item.selected);

      const texts = answers.flatMap((item) => {
        const text = item.freeText?.trim();

        return text ? [text] : [];
      });

      const recommended = plan?.flatMap((item) => item.selected) ?? [];

      const action =
        texts.length > 0
          ? "custom"
          : chosen.length === recommended.length &&
              chosen.every((value, at) => recommended[at] === value)
            ? "accept"
            : "alternative";

      later(
        card,
        `Sending answer to ${card.title} in ${UNDO_MS / 1000} seconds…`,
        async () => {
          await sdk.experimental_attention.command({ threadId, command: answersCommand(answers) });
        },
        choice(
          action,
          responseMs,
          chosen,
          texts.length === 0 ? null : texts.join("\n\n"),
          null,
          answers,
        ),
      );
    },
    [later, sdk],
  );

  const accept = useCallback(
    (card: DeckCardView, responseMs: number) => {
      const plan = acceptPlan(card);

      if (plan === null) return false;
      answer(
        card,
        plan.map((item) => ({ ...item, freeText: null })),
        responseMs,
      );

      return true;
    },
    [answer],
  );

  const reply = useCallback(
    (card: DeckCardView, responseMs: number) => {
      const { threadId, suggestedReply } = card;

      if (threadId === null || suggestedReply === null) return;
      later(
        card,
        `Sending reply to ${card.title}…`,
        async () => {
          await sdk.threads.send({
            threadId,
            mode: "queue-if-active",
            input: [{ type: "text", text: suggestedReply, mentions: [] }],
          });
        },
        choice("reply", responseMs, [], suggestedReply),
      );
    },
    [later, sdk],
  );

  const archive = useCallback(
    (card: DeckCardView, responseMs: number) => {
      const { threadId, latch } = card;

      if (threadId === null) return;
      immediately(
        card,
        async (): Promise<UndoNotice | null> => {
          const result = await sdk.experimental_inbox.act({
            request: {
              action: "archive",
              threadId,
              displayedReceiptIds: [],
              stopRunning: false,
              latch: latch ?? undefined,
            },
          });

          const { moveId } = result;

          return moveId === null
            ? null
            : {
                label: `Archived ${card.title}.`,
                undo: async () => {
                  await sdk.experimental_inbox.undo({ moveId });
                },
              };
        },
        choice("archive", responseMs, [threadId]),
      );
    },
    [immediately, sdk],
  );

  const resume = useCallback(
    (card: DeckCardView, request: InboxActRequest, responseMs: number) => {
      immediately(
        card,
        async () => {
          await sdk.experimental_inbox.act({ request });

          return null;
        },
        choice("resume", responseMs),
      );
    },
    [immediately, sdk],
  );

  const snooze = useCallback(
    (card: DeckCardView, picked: SnoozeChoice, responseMs: number) => {
      immediately(
        card,
        async () => {
          await rpc.call("snooze", { cardKey: card.key, until: picked.until });

          return {
            label: "Saved for later.",
            undo: async () => {
              await rpc.call("unsnooze", { cardKey: card.key, until: picked.until });
            },
          };
        },
        choice("later", responseMs, [], null, picked.label),
      );
    },
    [immediately, rpc],
  );

  const open = useCallback(
    (card: DeckCardView, threadId: string, responseMs: number) => {
      record(card, choice("open", responseMs));
      nav.toThread(threadId);
    },
    [nav, record],
  );

  return useMemo(
    () => ({ resumeFor, accept, answer, reply, archive, resume, snooze, open }),
    [resumeFor, accept, answer, reply, archive, resume, snooze, open],
  );
}
