import { useEffect } from "react";
import {
  useAppCommandRunner,
  useAppCommandKeyDispatch,
  useAppCommandHandler,
} from "@/components/commands/AppCommandProvider";
import { replayStep } from "@/lib/action-history-replay";
import { isEditableKeyboardTarget } from "@/lib/app-keybindings";
import { useActionHistory } from "./ActionHistoryProvider";

export function ActionHistoryCommandHandlers() {
  const history = useActionHistory();
  const { getShortcutCommand } = useAppCommandRunner();
  const handleKeyboardEvent = useAppCommandKeyDispatch();

  useEffect(() => {
    const handleInput = (event: Event) => {
      if (isEditableKeyboardTarget(event.target)) history.yieldToTextEditing();
    };

    const handleKeyDown = (event: KeyboardEvent) => {
      if (!history.hasKeyboardPriority) return;

      if (getShortcutCommand(event, ["edit.undo", "edit.redo"]) === null)
        return;

      if (handleKeyboardEvent(event, { allowEditableFocus: true })) {
        event.stopImmediatePropagation();
      }
    };

    window.addEventListener("input", handleInput, true);
    window.addEventListener("keydown", handleKeyDown, true);

    return () => {
      window.removeEventListener("input", handleInput, true);
      window.removeEventListener("keydown", handleKeyDown, true);
    };
  }, [getShortcutCommand, handleKeyboardEvent, history]);

  useAppCommandHandler(
    "edit.undo",
    () => {
      if (!history.canUndo) return false;
      void replayStep(history, "undo");

      return true;
    },
    0,
    true,
    () => history.canUndo,
  );
  useAppCommandHandler(
    "edit.redo",
    () => {
      if (!history.canRedo) return false;
      void replayStep(history, "redo");

      return true;
    },
    0,
    true,
    () => history.canRedo,
  );

  return null;
}
