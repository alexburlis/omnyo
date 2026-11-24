import type { ReactNode } from "react";
import { cn } from "@omnyo/shared-ui/lib/utils";
import { FooterStatusLine } from "@/components/plugin/FooterStatusLine";
import { PluginSidebarFooterCards } from "@/components/plugin/PluginSidebarFooterCards";
import { NAV_RAIL_WIDTH_CLASS } from "./navRailWidth";

export function MobileBottomRail({
  settings,
  children,
}: {
  settings: ReactNode;
  children: ReactNode;
}) {
  return (
    <div
      data-testid="sidebar-bottom-rail"
      className="@container/app-footer col-span-2 -mb-[env(safe-area-inset-bottom)] flex flex-col border-t border-border-seam bg-surface-recessed pb-[env(safe-area-inset-bottom)] text-xs text-muted-foreground select-none"
    >
      <div className="flex items-stretch">
        <div
          className={cn(
            "flex h-12 shrink-0 items-center justify-center",
            NAV_RAIL_WIDTH_CLASS,
          )}
        >
          {settings}
        </div>
        <div className="flex h-12 min-w-0 flex-1 items-center gap-1 pr-1.5">
          <FooterStatusLine>
            <PluginSidebarFooterCards placement="status" />
          </FooterStatusLine>
          {children}
        </div>
      </div>
    </div>
  );
}
