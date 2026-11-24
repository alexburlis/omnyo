import { useState } from "react";
import type { ThreadRuntimeDisplayStatus } from "@omnyo/domain";
import type { AutoCompactionOffer } from "@/components/promptbox/CompactBeforeSendChip";
import { useSetThreadAutoCompaction } from "@/hooks/mutations/thread-state-mutations";
import { useTimeHasPassed } from "@/hooks/useTimeHasPassed";

export const AUTO_COMPACTION_CHIP_LEAD_MS = 10 * 60 * 1000;

interface AutoCompactionChoice {
  threadId: string;
  at: number;
  keepFullHistory: boolean;
}

interface UseAutoCompactionOfferArgs {
  autoCompactionAt: string | undefined;
  autoCompactionOptedOut: boolean;
  runtimeDisplayStatus: ThreadRuntimeDisplayStatus;
  threadId: string;
}

function parseScheduledAt(autoCompactionAt: string | undefined): number | null {
  if (autoCompactionAt === undefined) return null;

  const at = Date.parse(autoCompactionAt);

  return Number.isNaN(at) ? null : at;
}

export function useAutoCompactionOffer({
  autoCompactionAt,
  autoCompactionOptedOut,
  runtimeDisplayStatus,
  threadId,
}: UseAutoCompactionOfferArgs): AutoCompactionOffer | null {
  const setAutoCompaction = useSetThreadAutoCompaction();
  const [choice, setChoice] = useState<AutoCompactionChoice | null>(null);
  const scheduledAt = parseScheduledAt(autoCompactionAt);

  const chipDue = useTimeHasPassed(
    scheduledAt === null ? null : scheduledAt - AUTO_COMPACTION_CHIP_LEAD_MS,
  );

  const threadChoice = choice?.threadId === threadId ? choice : null;
  const threadChoiceExpired = useTimeHasPassed(threadChoice?.at ?? null);
  const activeChoice = threadChoiceExpired ? null : threadChoice;

  const keepFullHistory =
    activeChoice?.keepFullHistory ?? autoCompactionOptedOut;

  const at =
    chipDue && scheduledAt !== null ? scheduledAt : (activeChoice?.at ?? null);

  if (at === null || runtimeDisplayStatus !== "idle") return null;

  return {
    at,
    keepFullHistory,
    pending: setAutoCompaction.isPending,
    onKeepFullHistoryChange: (nextKeepFullHistory) => {
      const previousChoice = choice;

      setChoice({ threadId, at, keepFullHistory: nextKeepFullHistory });
      setAutoCompaction.mutate(
        { threadId, enabled: !nextKeepFullHistory },
        { onError: () => setChoice(previousChoice) },
      );
    },
  };
}
