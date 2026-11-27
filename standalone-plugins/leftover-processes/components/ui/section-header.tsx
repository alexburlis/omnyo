import { useId, type ReactNode } from "react";
import { cn } from "../../lib/utils";
import { FOCUS_RING_CLASS } from "./focus-ring";
import { Icon } from "./icon";
import {
  DISCLOSURE_CHEVRON_TRANSITION,
  getDisclosureRevealClass,
  LIST_HOVER_TRANSITION,
} from "./motion";

export const SECTION_TITLE_CLASS = "truncate text-xs font-semibold text-muted-foreground";

export const SECTION_COUNT_CLASS =
  "inline-flex h-4 min-w-4 shrink-0 items-center justify-center rounded-full bg-state-hover px-1.5 text-2xs font-semibold leading-none tabular-nums text-muted-foreground";

function SectionCount({ count, label }: { count: number; label?: string }) {
  return (
    <span className={SECTION_COUNT_CLASS}>
      <span aria-hidden={label === undefined ? undefined : true}>{count}</span>
      {label === undefined ? null : <span className="sr-only">{label}</span>}
    </span>
  );
}

export function SectionHeader({
  title,
  count,
  countLabel,
  description,
  actions,
  className,
}: {
  title: string;
  count?: number;
  countLabel?: string;
  description?: string;
  actions?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("flex min-h-8 min-w-0 items-center gap-2 px-2", className)}>
      <span className="flex min-w-0 flex-1 items-center gap-1.5">
        <span className={SECTION_TITLE_CLASS}>{title}</span>
        {count === undefined ? null : <SectionCount count={count} label={countLabel} />}
        {description === undefined ? null : (
          <span className="min-w-0 truncate text-xs text-subtle-foreground">{description}</span>
        )}
      </span>
      {actions === undefined ? null : (
        <span className="flex shrink-0 items-center gap-1">{actions}</span>
      )}
    </div>
  );
}

export function CollapsibleSectionHeader({
  title,
  count,
  countLabel,
  description,
  open,
  onOpenChange,
  controlsId,
  actions,
  className,
}: {
  title: string;
  count?: number;
  countLabel?: string;
  description?: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  controlsId?: string;
  actions?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("flex min-h-8 min-w-0 items-center gap-1", className)}>
      <button
        type="button"
        aria-expanded={open}
        aria-controls={controlsId}
        onClick={() => onOpenChange(!open)}
        className={cn(
          "group/section-toggle flex min-h-7 min-w-0 flex-1 cursor-pointer items-center gap-1.5 rounded-md px-1.5 text-left hover:bg-state-hover pointer-coarse:min-h-10",
          LIST_HOVER_TRANSITION,
          FOCUS_RING_CLASS,
        )}
      >
        <Icon
          name="ChevronRight"
          aria-hidden="true"
          className={cn(
            "size-3.5 shrink-0 text-subtle-foreground group-hover/section-toggle:text-muted-foreground",
            DISCLOSURE_CHEVRON_TRANSITION,
            open && "rotate-90",
          )}
        />
        <span className={SECTION_TITLE_CLASS}>{title}</span>
        {count === undefined ? null : <SectionCount count={count} label={countLabel} />}
        {description === undefined ? null : (
          <span className="min-w-0 truncate text-xs text-subtle-foreground">{description}</span>
        )}
      </button>
      {actions === undefined ? null : (
        <span className="flex shrink-0 items-center gap-1">{actions}</span>
      )}
    </div>
  );
}

export function CollapsibleSection({
  title,
  count,
  countLabel,
  description,
  open,
  onOpenChange,
  actions,
  children,
  className,
  headerClassName,
  contentClassName,
}: {
  title: string;
  count?: number;
  countLabel?: string;
  description?: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
  headerClassName?: string;
  contentClassName?: string;
}) {
  const contentId = useId();

  return (
    <section aria-label={title} className={cn("min-w-0", className)}>
      <CollapsibleSectionHeader
        title={title}
        count={count}
        countLabel={countLabel}
        description={description}
        open={open}
        onOpenChange={onOpenChange}
        controlsId={contentId}
        actions={actions}
        className={headerClassName}
      />
      <div
        id={contentId}
        aria-hidden={open ? undefined : true}
        inert={!open}
        className={getDisclosureRevealClass(open)}
      >
        <div className={cn("min-h-0 overflow-hidden", contentClassName)}>{children}</div>
      </div>
    </section>
  );
}
