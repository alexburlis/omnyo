import { useId, type ReactNode } from "react";
import { experimental_Icon as Icon } from "@omnyo/plugin-sdk/app";
import { cn } from "./cn";
import { FOCUS_RING_CLASS } from "./focus-ring";

export const SECTION_COUNT_CLASS =
  "inline-flex h-4 min-w-4 shrink-0 items-center justify-center rounded-full bg-state-hover px-1.5 text-2xs font-semibold leading-none tabular-nums text-muted-foreground";

function revealClass(open: boolean): string {
  const base =
    "grid transition-[grid-template-rows,opacity] ease-(--motion-ease-smooth) motion-reduce:transition-[opacity] motion-reduce:duration-(--motion-duration-fast)";

  return open
    ? `${base} grid-rows-[1fr] opacity-100 duration-(--motion-duration-slow)`
    : `${base} pointer-events-none grid-rows-[0fr] opacity-0 duration-(--motion-duration-base)`;
}

export function CollapsibleSection({
  title,
  count,
  countLabel,
  description,
  leading,
  open,
  onOpenChange,
  children,
  className,
}: {
  title: string;
  count?: number;
  countLabel?: string;
  description?: string;
  leading?: ReactNode;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  children: ReactNode;
  className?: string;
}) {
  const contentId = useId();

  return (
    <section aria-label={title} className={cn("min-w-0", className)}>
      <button
        type="button"
        aria-expanded={open}
        aria-controls={contentId}
        onClick={() => onOpenChange(!open)}
        className={cn(
          "group/section-toggle -mx-1.5 flex min-h-7 w-[calc(100%+0.75rem)] min-w-0 cursor-pointer items-center gap-1.5 rounded-md px-1.5 text-left hover:bg-state-hover pointer-coarse:min-h-10",
          FOCUS_RING_CLASS,
        )}
      >
        <Icon
          name="ChevronRight"
          aria-hidden="true"
          className={cn(
            "size-3.5 shrink-0 text-subtle-foreground transition-transform duration-(--motion-duration-base) ease-(--motion-ease-smooth) group-hover/section-toggle:text-muted-foreground motion-reduce:transition-none",
            open && "rotate-90",
          )}
        />
        {leading}
        <span className="truncate text-xs font-semibold text-muted-foreground">{title}</span>
        {count === undefined ? null : (
          <span className={SECTION_COUNT_CLASS}>
            <span aria-hidden={countLabel === undefined ? undefined : true}>{count}</span>
            {countLabel === undefined ? null : <span className="sr-only">{countLabel}</span>}
          </span>
        )}
        {description === undefined ? null : (
          <span className="min-w-0 truncate text-xs text-subtle-foreground">{description}</span>
        )}
      </button>
      <div
        id={contentId}
        aria-hidden={open ? undefined : true}
        inert={!open}
        className={revealClass(open)}
      >
        <div className="min-h-0 overflow-hidden">{children}</div>
      </div>
    </section>
  );
}
