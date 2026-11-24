import { createContext, useContext, type ReactNode } from "react";
import { cn } from "../../lib/utils";
import { Icon } from "./icon";

export type StatusTone =
  | "active"
  | "success"
  | "pending"
  | "warning"
  | "error"
  | "neutral";

const STATUS_DOT_CLASS: Record<StatusTone, string> = {
  active: "bg-success ring-[3px] ring-success/20",
  success: "bg-success",
  pending: "border-[1.5px] border-subtle-foreground bg-transparent",
  warning: "bg-warning ring-[3px] ring-warning/20",
  error: "bg-destructive ring-[3px] ring-destructive/20",
  neutral: "bg-subtle-foreground",
};

const STATUS_BADGE_CLASS: Record<StatusTone, string> = {
  active: "bg-success/12 text-success-foreground",
  success: "bg-success/12 text-success-foreground",
  pending: "bg-state-hover text-muted-foreground",
  warning: "bg-warning/15 text-warning-text",
  error: "bg-destructive/10 text-destructive-text",
  neutral: "bg-state-hover text-muted-foreground",
};

const StatusListContext = createContext(false);

export function StatusDot({
  tone,
  label,
  className,
}: {
  tone: StatusTone;
  label?: string;
  className?: string;
}) {
  return (
    <span
      role={label === undefined ? undefined : "img"}
      aria-label={label}
      aria-hidden={label === undefined ? true : undefined}
      className={cn(
        "inline-block size-2 shrink-0 rounded-full",
        STATUS_DOT_CLASS[tone],
        className,
      )}
    />
  );
}

export function StatusBadge({
  tone,
  children,
  className,
}: {
  tone: StatusTone;
  children: ReactNode;
  className?: string;
}) {
  return (
    <span
      className={cn(
        "inline-flex h-5 shrink-0 items-center whitespace-nowrap rounded-full px-2 text-xs font-medium",
        STATUS_BADGE_CLASS[tone],
        className,
      )}
    >
      {children}
    </span>
  );
}

export function StatusRow({
  tone,
  title,
  status,
  meta,
  detail,
  error,
  actions,
  leading,
  className,
}: {
  tone: StatusTone;
  title: ReactNode;
  status?: ReactNode;
  meta?: readonly ReactNode[];
  detail?: ReactNode;
  error?: ReactNode;
  actions?: ReactNode;
  leading?: ReactNode;
  className?: string;
}) {
  const inList = useContext(StatusListContext);

  const metaItems = meta?.filter(
    (item) => item !== null && item !== undefined && item !== false,
  );

  return (
    <div
      role={inList ? "listitem" : undefined}
      className={cn("flex min-w-0 items-start gap-3 px-3 py-2.5", className)}
    >
      <span className="flex h-6 w-3.5 shrink-0 items-center justify-center">
        {leading ?? <StatusDot tone={tone} />}
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex min-h-6 min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
          <span className="min-w-0 truncate text-sm font-medium text-foreground">
            {title}
          </span>
          {status === undefined ? null : (
            <StatusBadge tone={tone}>{status}</StatusBadge>
          )}
          {metaItems === undefined || metaItems.length === 0 ? null : (
            <span className="flex min-w-0 max-w-full flex-wrap items-center gap-x-1.5 gap-y-0.5 text-xs text-subtle-foreground">
              {metaItems.map((item, index) => (
                <span
                  key={index}
                  className="flex min-w-0 max-w-full items-center gap-1.5"
                >
                  {index === 0 ? null : <span aria-hidden="true">·</span>}
                  <span className="min-w-0 truncate">{item}</span>
                </span>
              ))}
            </span>
          )}
        </div>
        {detail === undefined ? null : (
          <div className="mt-0.5 text-xs leading-5 text-muted-foreground">
            {detail}
          </div>
        )}
        {error === undefined ? null : (
          <div className="mt-1 flex items-start gap-1.5 text-xs leading-5 text-destructive-text">
            <Icon
              name="AlertCircle"
              aria-hidden="true"
              className="mt-0.5 size-3.5 shrink-0"
            />
            <span className="min-w-0 break-words">{error}</span>
          </div>
        )}
      </div>
      {actions === undefined ? null : (
        <div className="flex min-h-6 shrink-0 items-center gap-1.5">
          {actions}
        </div>
      )}
    </div>
  );
}

export function StatusList({
  children,
  label,
  variant = "card",
  className,
}: {
  children: ReactNode;
  label?: string;
  variant?: "card" | "plain";
  className?: string;
}) {
  return (
    <div
      role="list"
      aria-label={label}
      className={cn(
        "flex min-w-0 flex-col divide-y divide-border-seam [&>*]:min-w-0",
        variant === "card" &&
          "overflow-hidden rounded-lg border border-border bg-card shadow-card",
        className,
      )}
    >
      <StatusListContext.Provider value>{children}</StatusListContext.Provider>
    </div>
  );
}
