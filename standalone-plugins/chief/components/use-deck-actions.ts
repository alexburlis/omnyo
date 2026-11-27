import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRpc } from "@omnyo/plugin-sdk/app";
import { toast } from "sonner";
import type { DeckCardView, rpcContract } from "../lib/contract.ts";
import {
  UNDO_MS,
  cancelById,
  cancelLatest,
  outcomesFor,
  pruneHidden,
  schedule,
  takeDue,
  type OutcomeChoice,
  type PendingSend,
  type StepAnswer,
} from "./deck-logic.ts";
import { errorText } from "./use-loaded.ts";

const NOTICE_MS = 10_000;

interface Job {
  card: DeckCardView;
  run: () => Promise<void>;
  outcome: OutcomeChoice;
  dispose: () => void;
}

export interface UndoNotice {
  label: string;
  undo: () => Promise<void>;
}

export interface FailedAnswer {
  draft: StepAnswer[];
  message: string;
}

export interface DeckActions {
  hidden: ReadonlySet<string>;
  error: string | null;
  failedAnswers: ReadonlyMap<string, FailedAnswer>;
  discardFailedAnswer: (key: string) => void;
  handled: boolean;
  later: (
    card: DeckCardView,
    label: string,
    run: () => Promise<void>,
    outcome: OutcomeChoice,
  ) => void;
  immediately: (
    card: DeckCardView,
    run: () => Promise<UndoNotice | null>,
    outcome: OutcomeChoice,
  ) => void;
  record: (card: DeckCardView, outcome: OutcomeChoice) => void;
  undo: () => void;
  dismissError: () => void;
  prune: (cards: readonly DeckCardView[]) => void;
}

interface ActiveNotice {
  id: string;
  notice: UndoNotice;
}

export function useDeckActions(refresh: () => void): DeckActions {
  const rpc = useRpc<typeof rpcContract>();
  const [hidden, setHidden] = useState<ReadonlySet<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const [failedAnswers, setFailedAnswers] = useState<ReadonlyMap<string, FailedAnswer>>(new Map());
  const [handled, setHandled] = useState(false);
  const pendingRef = useRef<PendingSend[]>([]);
  const noticeRef = useRef<ActiveNotice | null>(null);
  const jobs = useRef(new Map<string, Job>());
  const mounted = useRef(false);

  useEffect(() => {
    mounted.current = true;

    return () => {
      mounted.current = false;
    };
  }, []);

  const hide = useCallback((key: string, on: boolean) => {
    setHidden((current) => {
      const next = new Set(current);

      if (on) next.add(key);
      else next.delete(key);

      return next;
    });
  }, []);

  const discardFailedAnswer = useCallback((key: string) => {
    setFailedAnswers((current) => {
      if (!current.has(key)) return current;
      const next = new Map(current);

      next.delete(key);

      return next;
    });
  }, []);

  const record = useCallback(
    (card: DeckCardView, outcome: OutcomeChoice) => {
      setHandled(true);

      for (const row of outcomesFor(card, outcome))
        rpc.call("outcome.record", row).catch((failure: Error) => {
          setError(`Your choice went through, but the Chief couldn't save it: ${errorText(failure)}`);
        });
    },
    [rpc],
  );

  const finish = useCallback(
    async (card: DeckCardView, run: () => Promise<void>, outcome: OutcomeChoice) => {
      try {
        await run();
      } catch (failure) {
        const message = errorText(failure instanceof Error ? failure : null);
        const draft = outcome.steps;

        if (!mounted.current) toast.error(message);
        else if (draft !== null)
          setFailedAnswers((current) => new Map(current).set(card.key, { draft, message }));
        else setError(message);

        hide(card.key, false);

        return;
      }

      if (outcome.steps !== null) discardFailedAnswer(card.key);
      record(card, outcome);
      refresh();
    },
    [discardFailedAnswer, hide, record, refresh],
  );

  const release = useCallback(
    (items: readonly PendingSend[]) => {
      for (const item of items) {
        const job = jobs.current.get(item.id);

        jobs.current.delete(item.id);
        toast.dismiss(item.id);

        if (job === undefined) continue;

        job.dispose();
        void finish(job.card, job.run, job.outcome);
      }
    },
    [finish],
  );

  const cancel = useCallback(
    (id: string) => {
      const { queue, cancelled } = cancelById(pendingRef.current, id);

      if (cancelled === null) return;
      jobs.current.get(cancelled.id)?.dispose();
      jobs.current.delete(cancelled.id);
      pendingRef.current = queue;
      hide(cancelled.cardKey, false);
      toast.dismiss(cancelled.id);
    },
    [hide],
  );

  const later = useCallback(
    (card: DeckCardView, label: string, run: () => Promise<void>, outcome: OutcomeChoice) => {
      const id = crypto.randomUUID();

      const dueAt = Date.now() + UNDO_MS;
      const onPageHide = () => cancel(id);

      const timer = window.setTimeout(() => {
        const { due, rest } = takeDue(pendingRef.current, dueAt);

        pendingRef.current = rest;
        release(due);
      }, UNDO_MS);

      window.addEventListener("pagehide", onPageHide);
      jobs.current.set(id, {
        card,
        run,
        outcome,
        dispose: () => {
          window.clearTimeout(timer);
          window.removeEventListener("pagehide", onPageHide);
        },
      });
      hide(card.key, true);
      pendingRef.current = schedule(pendingRef.current, { id, cardKey: card.key, label, dueAt });
      toast(label, {
        id,
        duration: UNDO_MS,
        action: { label: "Undo", onClick: () => cancel(id) },
      });
    },
    [cancel, hide, release],
  );

  const runNotice = useCallback((active: ActiveNotice) => {
    if (noticeRef.current?.id === active.id) noticeRef.current = null;
    toast.dismiss(active.id);
    active.notice.undo().catch((failure: Error) => setError(errorText(failure)));
  }, []);

  const immediately = useCallback(
    (card: DeckCardView, run: () => Promise<UndoNotice | null>, outcome: OutcomeChoice) => {
      hide(card.key, true);
      void finish(
        card,
        async () => {
          const undo = await run();

          if (undo === null) return;

          const active: ActiveNotice = {
            id: crypto.randomUUID(),
            notice: {
              label: undo.label,
              undo: async () => {
                await undo.undo();
                hide(card.key, false);
                refresh();
              },
            },
          };

          noticeRef.current = active;
          toast(undo.label, {
            id: active.id,
            duration: NOTICE_MS,
            action: { label: "Undo", onClick: () => runNotice(active) },
            onAutoClose: () => {
              if (noticeRef.current?.id === active.id) noticeRef.current = null;
            },
          });
        },
        outcome,
      );
    },
    [finish, hide, refresh, runNotice],
  );

  const undo = useCallback(() => {
    const { cancelled } = cancelLatest(pendingRef.current);

    if (cancelled !== null) return cancel(cancelled.id);
    const active = noticeRef.current;

    if (active !== null) runNotice(active);
  }, [cancel, runNotice]);

  const dismissError = useCallback(() => setError(null), []);

  const prune = useCallback((cards: readonly DeckCardView[]) => {
    setHidden((current) => pruneHidden(current, cards));
    setFailedAnswers((current) => {
      if (current.size === 0) return current;
      const keys = new Set(cards.map((card) => card.key));
      const next = new Map([...current].filter(([key]) => keys.has(key)));

      return next.size === current.size ? current : next;
    });
  }, []);

  return useMemo(
    () => ({
      hidden,
      error,
      failedAnswers,
      discardFailedAnswer,
      handled,
      later,
      immediately,
      record,
      undo,
      dismissError,
      prune,
    }),
    [
      hidden, error, failedAnswers, discardFailedAnswer, handled, later, immediately,
      record, undo, dismissError, prune,
    ],
  );
}
