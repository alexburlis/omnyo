import { useCallback, useMemo, useState } from "react";
import { experimental_useInboxSnapshot, useSdk } from "@omnyo/plugin-sdk/app";
import type { InboxActRequest, InboxSnapshot } from "./inbox.ts";
import { inboxLoad, inboxOutcome, type InboxLoad, type InboxOutcome } from "./inbox-store.ts";

export type { InboxLoad, InboxOutcome } from "./inbox-store.ts";

export function useInboxPrefetch(): void {
  experimental_useInboxSnapshot();
}

export type InboxPrediction = (snapshot: InboxSnapshot) => InboxSnapshot;

export interface InboxSource {
  preview: (predict: InboxPrediction) => () => void;
  load: InboxLoad;
  refresh: () => void;
  act: (request: InboxActRequest) => Promise<InboxOutcome>;
  undo: (moveId: string) => Promise<InboxOutcome>;
  retry: (targetThreadId: string) => Promise<InboxOutcome>;
}

export function useInbox(): InboxSource {
  const sdk = useSdk();
  const { snapshot, status, stale, refresh } = experimental_useInboxSnapshot();
  const [predictions, setPredictions] = useState<InboxPrediction[]>([]);

  const preview = useCallback((predict: InboxPrediction) => {
    setPredictions((current) => [...current, predict]);

    return () => setPredictions((current) => current.filter((item) => item !== predict));
  }, []);

  const load = useMemo(
    () =>
      inboxLoad({
        snapshot:
          snapshot === null ? null : predictions.reduce((value, item) => item(value), snapshot),
        status,
        stale,
      }),
    [snapshot, status, stale, predictions],
  );

  const act = useCallback(
    (request: InboxActRequest) =>
      inboxOutcome(() => sdk.experimental_inbox.act({ request }), refresh),
    [sdk, refresh],
  );

  const undo = useCallback(
    (moveId: string) => inboxOutcome(() => sdk.experimental_inbox.undo({ moveId }), refresh),
    [sdk, refresh],
  );

  const retry = useCallback(
    (targetThreadId: string) =>
      inboxOutcome(async () => {
        await sdk.threads.retry({ threadId: targetThreadId });

        return { moveId: null, entry: null };
      }, refresh),
    [sdk, refresh],
  );

  return useMemo(
    () => ({ load, refresh, act, undo, retry, preview }),
    [load, refresh, act, undo, retry, preview],
  );
}
