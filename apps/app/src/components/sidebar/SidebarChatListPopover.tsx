import { useState, type ReactNode } from "react";
import { RouteAnchor } from "@/components/ui/app-route-anchor";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@omnyo/shared-ui/popover";
import { cn } from "@omnyo/shared-ui/lib/utils";
import { getThreadRoutePath } from "@/lib/route-paths";
import { getThreadDisplayTitle } from "@/lib/thread-title";
import type { RailRoot } from "./railAttention";

export function SidebarChatListPopover({
  label,
  title,
  roots,
  className,
  children,
  onNavigate,
  badgeKind,
  side = "bottom",
}: {
  label: string;
  title: string;
  roots: readonly RailRoot[];
  className: string;
  children: ReactNode;
  onNavigate?: () => void;
  badgeKind?: "failed" | "needs";
  side?: "bottom" | "right";
}) {
  const [open, setOpen] = useState(false);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={label}
          data-rail-tile-badge={badgeKind}
          className={cn(
            "cursor-pointer outline-none hover:brightness-110 focus-visible:ring-2 focus-visible:ring-sidebar-ring",
            className,
          )}
        >
          {children}
        </button>
      </PopoverTrigger>
      <PopoverContent
        aria-label={title}
        mobileTitle={title}
        side={side}
        align={side === "right" ? "start" : "end"}
        className="max-h-80 w-72 max-w-[calc(100vw-1.5rem)] overflow-y-auto p-1.5"
      >
        <div className="px-2 py-1.5 text-xs font-semibold">{title}</div>
        {roots.map(({ thread, state }) => {
          const primary =
            thread.work?.experimental_ownState?.primary ?? thread.work?.primary;

          const reason = state === "failed" ? primary?.reason.text : null;

          return (
            <RouteAnchor
              key={thread.id}
              href={getThreadRoutePath({
                projectId: thread.projectId,
                threadId: thread.id,
              })}
              className="block rounded-sm px-2 py-1.5 text-xs outline-none hover:bg-state-hover focus-visible:bg-state-hover"
              onClick={() => {
                setOpen(false);
                onNavigate?.();
              }}
            >
              <span className="block truncate">
                {getThreadDisplayTitle(thread)}
              </span>
              {reason ? (
                <span className="line-clamp-2 text-muted-foreground">
                  {reason}
                </span>
              ) : state === "needs" ? (
                <span className="block text-muted-foreground">Needs you</span>
              ) : null}
            </RouteAnchor>
          );
        })}
        {roots.length === 0 ? (
          <p className="px-2 py-1.5 text-xs text-muted-foreground">
            No chats match this count now.
          </p>
        ) : null}
      </PopoverContent>
    </Popover>
  );
}
