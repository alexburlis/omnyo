import type { KeyboardCommandId } from "@omnyo/domain";

export const APP_COMMAND_TARGET_ATTRIBUTE = "data-app-command";

export const APP_COMMAND_TARGET_SELECTOR = `[${APP_COMMAND_TARGET_ATTRIBUTE}]`;

export const APP_COMMAND_INLINE_HINT_ATTRIBUTE = "data-app-command-hint";

export function appCommandTarget(command: KeyboardCommandId): {
  [APP_COMMAND_TARGET_ATTRIBUTE]: KeyboardCommandId;
} {
  return { [APP_COMMAND_TARGET_ATTRIBUTE]: command };
}

export function readAppCommandTarget(
  element: Element,
): KeyboardCommandId | null {
  const value = element.getAttribute(APP_COMMAND_TARGET_ATTRIBUTE);

  return value === null || value.length === 0
    ? null
    : (value as KeyboardCommandId);
}
