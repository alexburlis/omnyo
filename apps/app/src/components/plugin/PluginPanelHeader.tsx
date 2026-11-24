import { Component, type ReactNode } from "react";
import type { PluginNavPanelChrome } from "@/lib/plugin-nav-panel-chrome";
import type { PluginNavPanelSlot } from "@/lib/plugin-slots";
import { usePluginCss } from "@/lib/plugin-css";
import { PluginItemIcon } from "./PluginIcon";
import { PluginContext } from "./plugin-context";
import { useOptionalPaneContext } from "@/views/thread-detail/PaneContext";
import { getPluginPagePanelStateId } from "./plugin-page-panel-state";
import { AppPageHeader } from "@/components/layout/AppPageHeader";
import {
  usePageTitleBarSlots,
  WindowTitleBarChrome,
} from "@/components/layout/page-title-bar-chrome";

class HeaderContentBoundary extends Component<
  { pluginId: string; children: ReactNode },
  { crashed: boolean }
> {
  override state = { crashed: false };

  static getDerivedStateFromError(): { crashed: boolean } {
    return { crashed: true };
  }

  override componentDidCatch(error: Error): void {
    console.warn(
      `[plugin:${this.props.pluginId}] navPanel headerContent crashed and is hidden: ${error.message}`,
    );
  }

  override render(): ReactNode {
    return this.state.crashed ? null : this.props.children;
  }
}

export function PluginPanelHeaderCenter({
  chrome,
}: {
  chrome: Pick<PluginNavPanelChrome, "pluginId" | "icon" | "title">;
}) {
  return (
    <div className="flex min-w-0 flex-1 items-center gap-2">
      <PluginItemIcon
        pluginId={chrome.pluginId}
        icon={chrome.icon}
        className="text-muted-foreground"
      />
      <p className="truncate text-sm font-semibold">{chrome.title}</p>
    </div>
  );
}

function PluginPanelHeaderContent({
  panel,
  subPath,
}: {
  panel: PluginNavPanelSlot;
  subPath: string;
}) {
  const HeaderContent = panel.headerContent;
  usePluginCss(HeaderContent === undefined ? null : panel.pluginId);

  if (HeaderContent === undefined) return null;

  return (
    <HeaderContentBoundary
      key={`${panel.pluginId}/${panel.id}/${panel.generation}`}
      pluginId={panel.pluginId}
    >
      <PluginContext.Provider value={panel.pluginId}>
        <div
          data-omnyo-plugin-root=""
          data-omnyo-plugin={panel.pluginId}
          className="flex shrink-0 items-center gap-2"
        >
          <HeaderContent subPath={subPath} />
        </div>
      </PluginContext.Provider>
    </HeaderContentBoundary>
  );
}

export function PluginPanelHeaderActions({
  panel,
  paneId,
  subPath,
  paneActions,
}: {
  panel: PluginNavPanelSlot;
  paneId?: string;
  subPath: string;
  paneActions?: ReactNode;
}) {
  const paneContext = useOptionalPaneContext();

  const panelStateId = getPluginPagePanelStateId({
    panelPath: panel.path,
    paneId: paneId ?? paneContext?.paneId,
    pluginId: panel.pluginId,
  });

  return (
    <div className="flex shrink-0 items-center gap-2">
      <PluginPanelHeaderContent panel={panel} subPath={subPath} />
      {paneActions}
      <div data-plugin-right-panel-toggle-portal={panelStateId} />
    </div>
  );
}

export function PluginPanelPageHeader({
  center,
  panel,
  paneActions,
  paneId,
  subPath,
}: {
  center: ReactNode;
  panel: PluginNavPanelSlot | undefined;
  paneActions: ReactNode;
  paneId?: string;
  subPath: string;
}) {
  const titleBarSlots = usePageTitleBarSlots();

  if (titleBarSlots !== null) {
    return (
      <WindowTitleBarChrome
        slots={titleBarSlots}
        title={
          <div
            data-testid="plugin-panel-title-bar-title"
            className="flex min-w-0 items-center text-sidebar-foreground"
          >
            {center}
          </div>
        }
        actions={
          panel?.headerContent === undefined ? null : (
            <PluginPanelHeaderContent panel={panel} subPath={subPath} />
          )
        }
      />
    );
  }

  return (
    <AppPageHeader
      center={
        <div className="relative flex min-w-0 flex-1 items-center">
          {center}
        </div>
      }
      actions={
        panel === undefined ? (
          paneActions
        ) : (
          <PluginPanelHeaderActions
            panel={panel}
            paneId={paneId}
            subPath={subPath}
            paneActions={paneActions}
          />
        )
      }
    />
  );
}
