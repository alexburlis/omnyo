import { useCallback, useRef } from "react";
import type { ServiceTier } from "@omnyo/domain";
import { useUpdateThread } from "./mutations/thread-state-mutations";

export function useLiveThreadSpeed({
  threadId,
  value,
  onChange,
}: {
  threadId: string | null;
  value: ServiceTier | undefined;
  onChange: (value: ServiceTier | undefined) => void;
}) {
  const { mutateAsync } = useUpdateThread({
    errorMessage: "Failed to change session speed.",
  });

  const pending = useRef(Promise.resolve());
  const revision = useRef(0);
  const confirmed = useRef({ threadId, value });

  if (confirmed.current.threadId !== threadId)
    confirmed.current = { threadId, value };
  const currentThreadId = useRef(threadId);
  currentThreadId.current = threadId;

  return useCallback(
    (serviceTier: ServiceTier | undefined) => {
      onChange(serviceTier);

      if (threadId === null || serviceTier === undefined) return;
      const current = ++revision.current;
      pending.current = pending.current.then(async () => {
        try {
          await mutateAsync({ id: threadId, serviceTier });

          if (currentThreadId.current === threadId)
            confirmed.current = { threadId, value: serviceTier };
        } catch {
          if (
            currentThreadId.current === threadId &&
            revision.current === current
          )
            onChange(confirmed.current.value);
        }
      });
    },
    [mutateAsync, onChange, threadId],
  );
}
