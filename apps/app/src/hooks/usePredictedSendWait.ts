import { useCallback, useMemo, useSyncExternalStore } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { QueuedMessageWaitingOn } from "@omnyo/domain";
import type { SendMessageRequest } from "@omnyo/server-contract";
import { predictCachedThreadSendWait } from "@/hooks/cache-owners/thread-runtime-cache-owner";

const NO_SUBSCRIPTION = (): (() => void) => () => {};

export function usePredictedSendWait({
  enabled,
  mode,
  threadId,
}: {
  enabled: boolean;
  mode: SendMessageRequest["mode"];
  threadId: string;
}): QueuedMessageWaitingOn | null {
  const queryClient = useQueryClient();

  const subscribe = useCallback(
    (onChange: () => void) => queryClient.getQueryCache().subscribe(onChange),
    [queryClient],
  );

  const readSnapshot = useCallback(() => {
    const waitingOn = predictCachedThreadSendWait(queryClient, {
      id: threadId,
      mode,
    });

    return waitingOn === undefined ? null : JSON.stringify(waitingOn);
  }, [mode, queryClient, threadId]);

  const snapshot = useSyncExternalStore(
    enabled ? subscribe : NO_SUBSCRIPTION,
    enabled ? readSnapshot : () => null,
  );

  return useMemo(
    () =>
      snapshot === null
        ? null
        : (JSON.parse(snapshot) as QueuedMessageWaitingOn),
    [snapshot],
  );
}
