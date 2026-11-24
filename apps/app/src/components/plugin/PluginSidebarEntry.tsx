import { memo } from "react";
import { Link, useLocation } from "react-router-dom";
import type { ExperimentalSidebarEntryStatus } from "@omnyo/plugin-sdk/app";
import { Button } from "@omnyo/shared-ui/button";
import { cn } from "@omnyo/shared-ui/lib/utils";
import { PROJECT_LIST_ACTION_BUTTON_CLASS } from "@omnyo/shared-ui/sidebar-row-classes";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@omnyo/shared-ui/tooltip";
import { useCloseMobileSidebar } from "@/components/ui/sidebar.js";
import {
  usePluginSlots,
  type ExperimentalSidebarEntrySlot,
  type PluginNavPanelSlot,
} from "@/lib/plugin-slots";
import { getPluginPanelRoutePath, NEEDS_YOU_PANEL } from "@/lib/route-paths";
import type { SidebarScope } from "@/components/sidebar/sidebarScope";
import { PluginIcon } from "./PluginIcon";
import { PluginSlotMount } from "./PluginSlotMount";

const IDLE_STATUS: ExperimentalSidebarEntryStatus = {
  dot: null,
  tooltip: null,
  state: null,
};

function isInboxEntry(entry: ExperimentalSidebarEntrySlot): boolean {
  return (
    entry.pluginId === NEEDS_YOU_PANEL.pluginId &&
    entry.id === NEEDS_YOU_PANEL.pluginId &&
    entry.panel === NEEDS_YOU_PANEL.path
  );
}

export function resolveSidebarEntry(
  sidebarEntries: readonly ExperimentalSidebarEntrySlot[],
  navPanels: readonly PluginNavPanelSlot[],
  scope: SidebarScope["kind"],
): { entry: ExperimentalSidebarEntrySlot; panel: PluginNavPanelSlot } | null {
  for (const entry of sidebarEntries) {
    if (scope !== "inbox" && isInboxEntry(entry)) continue;

    const panel = navPanels.find(
      (candidate) =>
        candidate.pluginId === entry.pluginId && candidate.id === entry.panel,
    );

    if (panel !== undefined) return { entry, panel };
  }

  return null;
}

export function useNeedsYouRoute(): string | null {
  const { sidebarEntries, navPanels } = usePluginSlots();

  const match = resolveSidebarEntry(
    sidebarEntries.filter(isInboxEntry),
    navPanels,
    "inbox",
  );

  return match
    ? getPluginPanelRoutePath({
        pluginId: match.panel.pluginId,
        path: match.panel.path,
      })
    : null;
}

function SidebarEntryRow({
  entry,
  to,
  status,
}: {
  entry: ExperimentalSidebarEntrySlot;
  to: string;
  status: ExperimentalSidebarEntryStatus | null;
}) {
  const closeOnMobile = useCloseMobileSidebar();
  const location = useLocation();

  const active =
    location.pathname === to || location.pathname.startsWith(`${to}/`);

  const current = status ?? IDLE_STATUS;
  const tooltip = current.tooltip ?? entry.tooltip;
  const lit = current.dot !== null && current.state !== "error";

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          asChild
          size="sm"
          variant="ghost"
          className={cn(
            PROJECT_LIST_ACTION_BUTTON_CLASS,
            "w-full",
            lit && "pr-2",
            active && "bg-sidebar-accent text-sidebar-foreground",
          )}
        >
          <Link
            to={to}
            onClick={closeOnMobile}
            aria-current={active ? "page" : undefined}
            aria-label={`${entry.title}. ${tooltip}`}
            data-testid="sidebar-entry"
            data-sidebar-entry={`${entry.pluginId}/${entry.id}`}
          >
            <PluginIcon pluginId={entry.pluginId} icon={entry.icon} />
            <span
              className={cn(
                "min-w-0 flex-1 truncate text-left",
                lit && "font-medium",
              )}
            >
              {entry.title}
            </span>
            {current.state === "paused" ? (
              <span className="shrink-0 text-muted-foreground">Paused</span>
            ) : null}
            {current.state === "error" ? (
              <span
                data-testid="sidebar-entry-error"
                className="shrink-0 text-muted-foreground"
                aria-hidden="true"
              >
                !
              </span>
            ) : lit ? (
              <span
                data-testid="sidebar-entry-dot"
                data-tone={current.dot}
                aria-hidden="true"
                className={cn(
                  "size-2 shrink-0 rounded-full max-md:pointer-coarse:size-2.5",
                  current.dot === "failed" ? "bg-destructive" : "bg-attention",
                )}
              />
            ) : null}
          </Link>
        </Button>
      </TooltipTrigger>
      <TooltipContent side="right">{tooltip}</TooltipContent>
    </Tooltip>
  );
}

function SidebarEntryStatusRow({
  entry,
  to,
}: {
  entry: ExperimentalSidebarEntrySlot;
  to: string;
}) {
  const status =
    entry.useStatus === undefined ? IDLE_STATUS : entry.useStatus();

  return <SidebarEntryRow entry={entry} to={to} status={status} />;
}

export const PluginSidebarEntry = memo(function PluginSidebarEntry({
  scope,
}: {
  scope: SidebarScope["kind"];
}) {
  const { sidebarEntries, navPanels } = usePluginSlots();
  const resolved = resolveSidebarEntry(sidebarEntries, navPanels, scope);

  if (resolved === null) return null;
  const { entry, panel } = resolved;
  const inInbox = isInboxEntry(entry);

  const to = getPluginPanelRoutePath({
    pluginId: panel.pluginId,
    path: panel.path,
  });

  return (
    <div
      className="px-2 pb-1"
      role={inInbox ? "group" : undefined}
      aria-label={inInbox ? "Inbox" : undefined}
    >
      {inInbox ? (
        <div className="px-2 pb-1 text-xs font-medium text-sidebar-foreground/70">
          Inbox
        </div>
      ) : null}
      <PluginSlotMount
        key={`${entry.pluginId}/${entry.id}/${entry.generation}`}
        pluginId={entry.pluginId}
        slotKind="sidebarEntry"
        slotId={entry.id}
        crashFallback={
          <SidebarEntryRow
            entry={entry}
            to={to}
            status={{
              dot: null,
              tooltip: `${entry.title} isn't responding`,
              state: "error",
            }}
          />
        }
      >
        <SidebarEntryStatusRow entry={entry} to={to} />
      </PluginSlotMount>
    </div>
  );
});
