import type { ReactNode } from "react";
import { cn } from "../../lib/utils";
import { Icon } from "./icon";

export function EmptyStateBlock({
  icon,
  title,
  description,
  actions,
  tone = "neutral",
  className,
}: {
  icon?: string;
  title: string;
  description?: ReactNode;
  actions?: ReactNode;
  tone?: "neutral" | "error";
  className?: string;
}) {
  return (
    <div className={cn("flex flex-col items-center gap-3 px-6 py-10 text-center", className)}>
      {icon === undefined ? null : (
        <span
          className={cn(
            "grid size-11 place-items-center rounded-full ring-1",
            tone === "error"
              ? "bg-surface-destructive text-destructive-text ring-surface-destructive-border"
              : "bg-state-hover text-muted-foreground ring-border",
          )}
        >
          <Icon name={icon} aria-hidden="true" className="size-5" />
        </span>
      )}
      <div className="flex max-w-sm flex-col gap-1">
        <p className="text-base font-semibold text-foreground">{title}</p>
        {description === undefined ? null : (
          <div className="text-sm leading-relaxed text-muted-foreground">{description}</div>
        )}
      </div>
      {actions === undefined ? null : (
        <div className="mt-1 flex flex-wrap items-center justify-center gap-2">{actions}</div>
      )}
    </div>
  );
}
