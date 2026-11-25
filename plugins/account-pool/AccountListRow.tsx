import type { CSSProperties, ReactNode, Ref } from "react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Icon } from "@/components/ui/icon";
import { LIST_HOVER_TRANSITION } from "@/components/ui/motion";
import { cn } from "@/lib/utils";

export function SettingsBadge({ children }: { children: ReactNode }) {
  return (
    <span className="shrink-0 rounded-sm border border-border bg-muted/40 px-1.5 py-0.5 text-2xs leading-none text-subtle-foreground">
      {children}
    </span>
  );
}

export type QuotaSlot = {
  key: string;
  label: string;
  utilization: number | null;
  status: string | null;
};

function quotaToneClass(slot: QuotaSlot, threshold: number): string {
  if (
    slot.status?.toLowerCase() === "rejected" ||
    (slot.utilization !== null && slot.utilization >= 1)
  )
    return "text-destructive-text";

  if (slot.utilization !== null && slot.utilization >= threshold - 0.1)
    return "text-warning-text";

  return slot.utilization === null
    ? "text-subtle-foreground"
    : "text-foreground";
}

function QuotaValue({
  slot,
  threshold,
  refreshing,
}: {
  slot: QuotaSlot;
  threshold: number;
  refreshing: boolean;
}) {
  return (
    <div
      className={cn(
        "w-16 text-left tabular-nums transition-opacity @min-[32rem]/account-row:text-right",
        refreshing && "opacity-50",
      )}
    >
      <div className="text-2xs uppercase tracking-wide text-subtle-foreground">
        {slot.label}
      </div>
      <div
        className={cn("text-xs font-semibold", quotaToneClass(slot, threshold))}
      >
        {slot.utilization === null
          ? "—"
          : `${Math.round(slot.utilization * 100)}%`}
      </div>
    </div>
  );
}

export function AccountListRow({
  name,
  secondaryName,
  badges,
  status,
  statusDetail,
  slots,
  threshold,
  refreshing = false,
  disabled = false,
  actions,
  missingUsage,
  onOpen,
  rowRef,
  style,
  dragging = false,
  reorderHandle,
}: {
  name: string;
  secondaryName?: string | null;
  badges?: ReactNode;
  status: { label: string; dot: string };
  statusDetail?: ReactNode;
  slots: QuotaSlot[];
  threshold: number;
  refreshing?: boolean;
  disabled?: boolean;
  actions: ReactNode;
  missingUsage?: ReactNode;
  onOpen?: () => void;
  rowRef?: Ref<HTMLDivElement>;
  style?: CSSProperties;
  dragging?: boolean;
  reorderHandle?: ReactNode;
}) {
  const identityClass = "min-w-0 flex-1 space-y-1 text-left";

  const identity = (
    <>
      <div className="flex min-w-0 flex-wrap items-center gap-1.5">
        <span className="truncate text-sm font-medium text-foreground">
          {name}
        </span>
        {secondaryName == null ? null : (
          <span className="min-w-0 truncate text-xs text-subtle-foreground">
            {secondaryName}
          </span>
        )}
        {badges}
      </div>
      <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-0.5 text-xs text-subtle-foreground">
        <span className="inline-flex shrink-0 items-center gap-1.5">
          <span className={cn("size-1.5 rounded-full", status.dot)} />
          {status.label}
        </span>
        {statusDetail}
      </div>
    </>
  );

  return (
    <div
      ref={rowRef}
      style={style}
      className={cn(
        "@container/account-row text-sm transition-[box-shadow,opacity] duration-(--motion-duration-fast)",
        dragging && "relative z-10 rounded-md bg-card opacity-90 shadow-lift",
      )}
    >
      <div
        className={cn(
          "relative -mx-2 flex select-none items-center gap-2 rounded-md px-2 py-2.5 hover:bg-state-hover focus-within:bg-state-hover",
          LIST_HOVER_TRANSITION,
          disabled && "opacity-55",
        )}
      >
        <div className="grid min-w-0 flex-1 items-center gap-y-1.5 @min-[32rem]/account-row:grid-cols-[minmax(0,1fr)_auto] @min-[32rem]/account-row:gap-x-2">
          <div className="flex min-w-0 items-center gap-2">
            {onOpen === undefined ? (
              <div className={identityClass}>{identity}</div>
            ) : (
              <button
                type="button"
                className={cn(
                  identityClass,
                  "rounded-md outline-none after:absolute after:inset-0 after:rounded-md after:content-[''] focus-visible:ring-2 focus-visible:ring-ring",
                )}
                aria-label={`Open ${name} details`}
                onClick={onOpen}
              >
                {identity}
              </button>
            )}
            {reorderHandle}
          </div>
          {slots.length === 0 ? (
            missingUsage
          ) : (
            <div className="flex flex-wrap items-center gap-x-4 gap-y-1 @min-[32rem]/account-row:flex-nowrap @min-[32rem]/account-row:gap-1">
              {slots.map((slot) => (
                <QuotaValue
                  key={slot.key}
                  slot={slot}
                  threshold={threshold}
                  refreshing={refreshing}
                />
              ))}
            </div>
          )}
        </div>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              className="relative h-7 w-7 shrink-0 data-[state=open]:bg-state-active"
              aria-label={`${name} actions`}
            >
              <Icon name="MoreHorizontal" className="size-4" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-52">
            {actions}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </div>
  );
}
