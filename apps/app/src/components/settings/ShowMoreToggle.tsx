import { Icon } from "@omnyo/shared-ui/icon";
import { cn } from "@omnyo/shared-ui/lib/utils";
import {
  CONTROL_HOVER_TRANSITION,
  DISCLOSURE_CHEVRON_TRANSITION,
} from "@omnyo/shared-ui/motion";

export function ShowMoreToggle({
  expanded,
  onExpandedChange,
  collapsedLabel,
  expandedLabel,
}: {
  expanded: boolean;
  onExpandedChange: (expanded: boolean) => void;
  collapsedLabel: string;
  expandedLabel: string;
}) {
  return (
    <button
      type="button"
      aria-expanded={expanded}
      onClick={() => onExpandedChange(!expanded)}
      className={cn(
        "-ml-1 inline-flex items-center gap-1.5 self-start rounded-md px-1.5 py-0.5 text-xs text-muted-foreground outline-none hover:bg-state-hover hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring",
        CONTROL_HOVER_TRANSITION,
      )}
    >
      <Icon
        name="ChevronDown"
        className={cn(
          "size-3.5",
          DISCLOSURE_CHEVRON_TRANSITION,
          expanded && "rotate-180",
        )}
        aria-hidden
      />
      <span>{expanded ? expandedLabel : collapsedLabel}</span>
    </button>
  );
}
