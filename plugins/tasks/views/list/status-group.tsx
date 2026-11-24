import type { TaskStatus } from "../../shared/contract.js";
import { INSET_FOCUS_RING_CLASS } from "@/components/ui/focus-ring";
import { Icon } from "@/components/ui/icon";
import {
  DISCLOSURE_CHEVRON_TRANSITION,
  LIST_HOVER_TRANSITION,
} from "@/components/ui/motion";
import { SECTION_COUNT_CLASS } from "@/components/ui/section-header";
import { cn } from "@/lib/utils";
import { StatusIcon } from "./icons.js";
import { STATUS_LABELS } from "./lib.js";

export function StatusGroupHeader({
  status,
  count,
  open,
  onOpenChange,
  controlsId,
}: {
  status: TaskStatus;
  count: number;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  controlsId?: string;
}) {
  const label = STATUS_LABELS[status];

  return (
    <div
      data-status-group-header={status}
      className="sticky top-0 z-20 isolate border-b border-border-hairline bg-background"
    >
      <button
        type="button"
        aria-expanded={open}
        aria-controls={controlsId}
        aria-label={`${label}, ${count} ${count === 1 ? "task" : "tasks"}`}
        title={open ? `Collapse ${label}` : `Show ${label}`}
        onClick={() => onOpenChange(!open)}
        className={cn(
          "group/status-group flex h-9 w-full cursor-pointer items-center gap-2 px-3.5 text-left text-sm font-semibold hover:bg-state-hover max-md:pointer-coarse:h-11",
          LIST_HOVER_TRANSITION,
          INSET_FOCUS_RING_CLASS,
        )}
      >
        <Icon
          name="ChevronRight"
          aria-hidden="true"
          className={cn(
            "-ml-1 size-3.5 shrink-0 text-subtle-foreground group-hover/status-group:text-muted-foreground",
            DISCLOSURE_CHEVRON_TRANSITION,
            open && "rotate-90",
          )}
        />
        <StatusIcon status={status} />
        <span className="truncate">{label}</span>
        <span aria-hidden="true" className={SECTION_COUNT_CLASS}>
          {count}
        </span>
      </button>
    </div>
  );
}
