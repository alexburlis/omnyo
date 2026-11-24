import { useCallback, type KeyboardEvent } from "react";
import type { KeyboardCommandId } from "@omnyo/domain";
import { useAppCommandRunner } from "./AppCommandProvider";

export const COMPOSER_SHORTCUT_COMMANDS: readonly KeyboardCommandId[] = [
  "modelPicker.toggle",
  "modelPicker.cycleModel",
  "modelPicker.cycleModelBackward",
  "modelPicker.cycleProvider",
  "modelPicker.cycleProviderBackward",
  "modelPicker.cycleReasoning",
  "modelPicker.cycleReasoningBackward",
];

export function useComposerShortcutCapture(
  commands: readonly KeyboardCommandId[] = COMPOSER_SHORTCUT_COMMANDS,
  intercept?: (command: KeyboardCommandId) => boolean,
): (event: KeyboardEvent<HTMLElement>) => void {
  const runner = useAppCommandRunner();

  return useCallback(
    (event: KeyboardEvent<HTMLElement>) => {
      if (
        !(event.target instanceof Node) ||
        !event.currentTarget.contains(event.target)
      ) {
        return;
      }

      const command = runner.getShortcutCommand(event.nativeEvent, commands);

      if (command === null) return;

      if (
        intercept?.(command) !== true &&
        !runner.dispatch(command, event.target)
      ) {
        return;
      }

      event.preventDefault();
      event.stopPropagation();
    },
    [commands, intercept, runner],
  );
}
