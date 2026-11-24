import { cn } from "@omnyo/shared-ui/lib/utils";
import { Icon } from "@omnyo/shared-ui/icon";
import { CONTROL_PRESS_FEEDBACK } from "@omnyo/shared-ui/motion";

interface ScrollToBottomButtonProps {
  visible: boolean;
  active?: boolean;
  onClick: () => void;
}

export function ScrollToBottomButton({
  visible,
  active = false,
  onClick,
}: ScrollToBottomButtonProps) {
  return (
    <div className="flex h-0 items-center justify-center">
      <button
        onClick={onClick}
        className={cn(
          "z-20 -mt-16 flex h-7 cursor-pointer items-center gap-1 rounded-full border border-border bg-background pr-3 pl-2 text-xs font-medium text-foreground shadow-sm transition-[translate,opacity,visibility,background-color,scale] hover:bg-accent motion-reduce:translate-y-0",
          CONTROL_PRESS_FEEDBACK,
          visible
            ? "translate-y-0 opacity-100 [transition-duration:var(--motion-duration-base),var(--motion-duration-base),var(--motion-duration-base),var(--motion-duration-fast),var(--motion-duration-base)] [transition-timing-function:var(--motion-ease-out),var(--motion-ease-out),var(--motion-ease-standard),var(--motion-ease-standard),var(--motion-ease-snappy)] active:[transition-duration:var(--motion-duration-base),var(--motion-duration-base),var(--motion-duration-base),var(--motion-duration-fast),var(--motion-duration-fast)]"
            : "pointer-events-none invisible translate-y-1.5 opacity-0 duration-(--motion-duration-fast)",
        )}
        aria-label="Jump to latest"
        type="button"
      >
        <Icon
          name="ArrowDown"
          className={cn("size-3.5", active && visible && "animate-shine-icon")}
        />
        Latest
      </button>
    </div>
  );
}
