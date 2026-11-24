import type { MouseEvent as ReactMouseEvent, ReactNode } from "react";
import { SidebarFooterStateProvider } from "@/components/sidebar/SidebarFooterState";
import { SidebarInset } from "@/components/ui/sidebar.js";
import { AppFooter } from "./AppFooter";
import {
  AppLayoutSidebar,
  type AppLayoutSidebarMode,
} from "./AppLayoutSidebar";

export interface AppShellFrameProps {
  mode: AppLayoutSidebarMode;
  onResizeMouseDown: (event: ReactMouseEvent<HTMLDivElement>) => void;
  isResizing: boolean;
  settingsToggleRoutePath: string;
  children: ReactNode;
}

export function AppShellFrame({
  mode,
  onResizeMouseDown,
  isResizing,
  settingsToggleRoutePath,
  children,
}: AppShellFrameProps) {
  return (
    <SidebarFooterStateProvider>
      <div
        aria-hidden="true"
        data-app-ambient=""
        data-testid="app-ambient"
        className="pointer-events-none fixed inset-0 -z-10"
      />
      <AppLayoutSidebar
        mode={mode}
        onResizeMouseDown={onResizeMouseDown}
        isResizing={isResizing}
        settingsToggleRoutePath={settingsToggleRoutePath}
      />
      <SidebarInset>{children}</SidebarInset>
      <AppFooter
        isSettingsActive={mode === "settings"}
        settingsToggleRoutePath={settingsToggleRoutePath}
      />
    </SidebarFooterStateProvider>
  );
}
