import { cn } from "@omnyo/shared-ui/lib/utils";
import type { AppShortcutPresentation } from "@/lib/app-keybindings";
import { APP_COMMAND_INLINE_HINT_ATTRIBUTE } from "@/lib/app-command-targets";
import { useIsAppCommandModifierHeld } from "./AppCommandProvider";

interface AppCommandShortcutHintProps {
  shortcut: AppShortcutPresentation | null;
  className?: string;
}

interface AppCommandShortcutPillProps {
  ariaHidden?: boolean;
  inlineHint?: boolean;
  shortcut: Pick<AppShortcutPresentation, "label">;
  className?: string;
}

const APP_COMMAND_SHORTCUT_HINT_CLASS =
  "pointer-events-none inline-flex shrink-0 items-center justify-center whitespace-nowrap rounded-sm bg-state-hover px-1.5 py-1 font-sans text-xs font-normal leading-none tabular-nums text-subtle-foreground opacity-60";

export function AppCommandShortcutPill({
  ariaHidden = true,
  inlineHint = false,
  shortcut,
  className,
}: AppCommandShortcutPillProps) {
  return (
    <kbd
      aria-hidden={ariaHidden}
      {...(inlineHint ? { [APP_COMMAND_INLINE_HINT_ATTRIBUTE]: "" } : {})}
      className={cn(APP_COMMAND_SHORTCUT_HINT_CLASS, className)}
    >
      {shortcut.label}
    </kbd>
  );
}

export function AppCommandShortcutHint({
  shortcut,
  className,
}: AppCommandShortcutHintProps) {
  const isPrimaryModifierHeld = useIsAppCommandModifierHeld();

  if (!isPrimaryModifierHeld || !shortcut) return null;

  return (
    <AppCommandShortcutPill
      inlineHint
      shortcut={shortcut}
      className={cn(
        "animate-in fade-in-0 duration-(--motion-duration-fast)",
        className,
      )}
    />
  );
}
