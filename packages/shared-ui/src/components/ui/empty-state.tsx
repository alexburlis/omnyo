import type { HTMLAttributes, ReactNode } from "react";
import { cn } from "../../lib/utils";
import { Icon, type IconName } from "./icon";

export interface EmptyStateProps {
  message: string;
  icon?: IconName;
  className?: string;
  iconClassName?: string;
  messageClassName?: string;
}

export function EmptyState({
  message,
  icon,
  className,
  iconClassName,
  messageClassName,
}: EmptyStateProps) {
  return (
    <div className={cn("flex items-center gap-2", className)}>
      {icon ? (
        <Icon
          name={icon}
          aria-hidden="true"
          className={cn(
            "size-4 shrink-0 text-subtle-foreground",
            iconClassName,
          )}
        />
      ) : null}
      <p
        className={cn(
          "text-xs leading-5 text-muted-foreground",
          messageClassName,
        )}
      >
        {message}
      </p>
    </div>
  );
}

type EmptyStatePanelProps = HTMLAttributes<HTMLDivElement>;

export function EmptyStatePanel({
  className,
  children,
  ...props
}: EmptyStatePanelProps) {
  return (
    <div
      className={cn(
        "rounded-md border border-dashed border-border px-3 py-6 text-center text-sm text-muted-foreground",
        className,
      )}
      {...props}
    >
      {children}
    </div>
  );
}

export function EmptyStateBlock({
  icon,
  title,
  description,
  actions,
  tone = "neutral",
  className,
}: {
  icon?: IconName;
  title: string;
  description?: ReactNode;
  actions?: ReactNode;
  tone?: "neutral" | "error";
  className?: string;
}) {
  return (
    <div
      className={cn(
        "flex flex-col items-center gap-3 px-6 py-10 text-center",
        className,
      )}
    >
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
          <div className="text-sm leading-relaxed text-muted-foreground">
            {description}
          </div>
        )}
      </div>
      {actions === undefined ? null : (
        <div className="mt-1 flex flex-wrap items-center justify-center gap-2">
          {actions}
        </div>
      )}
    </div>
  );
}
