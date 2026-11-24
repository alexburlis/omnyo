import { appToast } from "@/components/ui/app-toast";
import type { ActionHistory, HistoryDirection } from "@/lib/action-history";
import { showMutationErrorToast } from "@/lib/mutation-errors";

const STEP_TOAST_ID = "action-history-step";

const STEPS: Record<HistoryDirection, { failure: string; verb: string }> = {
  undo: { verb: "Undid", failure: "Couldn't undo" },
  redo: { verb: "Redid", failure: "Couldn't redo" },
};

export async function replayStep(
  history: ActionHistory,
  direction: HistoryDirection,
): Promise<void> {
  const { verb, failure } = STEPS[direction];
  const label = history.peek(direction)?.label ?? null;

  try {
    const entry = await history[direction]();

    if (entry !== null) {
      appToast.success(`${verb}: ${entry.label}`, { id: STEP_TOAST_ID });
    }
  } catch (error) {
    showMutationErrorToast({
      error,
      fallbackMessage:
        label === null ? `${failure} the last action` : `${failure}: ${label}`,
    });
  }
}
