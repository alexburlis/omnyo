import { Icon } from "@omnyo/shared-ui/icon";
import { CONTROL_HOVER_TRANSITION } from "@omnyo/shared-ui/motion";
import { cn } from "@omnyo/shared-ui/lib/utils";

export const MODEL_PICKER_CHIP_CLASS_NAME = cn(
  "flex h-5 shrink-0 select-none items-center justify-center gap-0.5 whitespace-nowrap rounded-md px-1 text-2xs text-muted-foreground outline-none hover:bg-state-hover hover:text-foreground focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring max-md:pointer-coarse:h-9",
  CONTROL_HOVER_TRANSITION,
);

export const MODEL_PICKER_PRESSED_CHIP_CLASS_NAME =
  "bg-state-active font-medium text-foreground shadow-xs hover:bg-state-active";

export function FavoriteLevelToggle({
  modelLabel,
  levelLabel,
  favorite,
  disabled,
  onContextMenu,
  onToggle,
}: {
  modelLabel: string;
  levelLabel: string;
  favorite: boolean;
  disabled?: boolean;
  onContextMenu?: () => void;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      aria-label={`Favorite ${modelLabel} at ${levelLabel}`}
      aria-pressed={favorite}
      disabled={disabled}
      onContextMenu={onContextMenu}
      onClick={onToggle}
      className={cn(
        MODEL_PICKER_CHIP_CLASS_NAME,
        "disabled:pointer-events-none disabled:opacity-50",
        favorite && MODEL_PICKER_PRESSED_CHIP_CLASS_NAME,
      )}
    >
      <span>{levelLabel}</span>
      <Icon
        name="Star"
        aria-hidden
        className={cn(
          "size-2.5",
          favorite ? "fill-current" : "text-subtle-foreground",
        )}
      />
    </button>
  );
}
