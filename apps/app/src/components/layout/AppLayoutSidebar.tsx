import { useState, type MouseEvent as ReactMouseEvent } from "react";
import {
  AppNavRail,
  NavRailSettingsButton,
} from "@/components/sidebar/AppNavRail";
import { AppSidebar } from "@/components/sidebar/AppSidebar";
import { SidebarFooterStateProvider } from "@/components/sidebar/SidebarFooterState";
import { SettingsSidebar } from "@/components/settings/SettingsSidebar";
import { ResourceSidebar } from "@/components/tools/ResourceSidebar";
import { useSidebar } from "@/components/ui/sidebar.js";

export type AppLayoutSidebarMode = "app" | "settings" | "plugins" | "skills";

interface AppLayoutSidebarProps {
  mode: AppLayoutSidebarMode;
  onResizeMouseDown: (event: ReactMouseEvent<HTMLDivElement>) => void;
  isResizing: boolean;
  settingsToggleRoutePath: string;
}

export function AppLayoutSidebar({
  mode,
  onResizeMouseDown,
  isResizing,
  settingsToggleRoutePath,
}: AppLayoutSidebarProps) {
  const { isCompactViewport, isMobileSidebarClosing } = useSidebar();
  const holdCurrentMode = isCompactViewport && isMobileSidebarClosing;
  const [lastVisibleMode, setLastVisibleMode] = useState(mode);

  if (!holdCurrentMode && lastVisibleMode !== mode) {
    setLastVisibleMode(mode);
  }

  const renderedMode = holdCurrentMode ? lastVisibleMode : mode;

  return (
    <SidebarFooterStateProvider>
      <AppSidebar
        onResizeMouseDown={onResizeMouseDown}
        isResizing={isResizing}
        isBodyHidden={renderedMode !== "app"}
        renderRail={(customize) => (
          <AppNavRail isAppMode={mode === "app"} customize={customize} />
        )}
        railFooter={
          <NavRailSettingsButton
            isSettingsActive={mode === "settings"}
            settingsToggleRoutePath={settingsToggleRoutePath}
          />
        }
        alternateBody={
          renderedMode === "settings" ? (
            <SettingsSidebar
              onResizeMouseDown={onResizeMouseDown}
              isResizing={isResizing}
            />
          ) : renderedMode === "plugins" || renderedMode === "skills" ? (
            <ResourceSidebar
              key={renderedMode}
              workspace={renderedMode}
              onResizeMouseDown={onResizeMouseDown}
              isResizing={isResizing}
            />
          ) : null
        }
      />
    </SidebarFooterStateProvider>
  );
}
