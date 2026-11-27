import type { ReactNode } from "react";
import type { TerminalSession } from "@omnyo/server-contract";
import { COARSE_POINTER_COMPACT_ICON_SIZE_CLASS } from "@omnyo/shared-ui/coarse-pointer-sizing";
import { Icon } from "@omnyo/shared-ui/icon";
import { PluginItemIcon } from "@/components/plugin/PluginIcon";
import { getBrowserUrlHost } from "@/lib/browser-url";
import type { SecondaryFileFixedPanelTab } from "@/lib/fixed-panel-tabs-state";
import type {
  PluginNewThreadPanelActionSlot,
  PluginThreadPanelActionSlot,
} from "@/lib/plugin-slots";
import { RightPanelFileTabIcon } from "./RightPanelFileTabIcon";
import type {
  SecondaryPanelPaneRenderContext,
  SecondaryPanelRenderableTab,
} from "./secondaryPanelTab";
import type { PanelTerminals } from "./usePanelTerminals";

interface BuildSecondaryPanelRenderableTabsArgs {
  tabs: readonly SecondaryFileFixedPanelTab[];
  pluginActions: readonly Pick<
    PluginNewThreadPanelActionSlot | PluginThreadPanelActionSlot,
    "pluginId" | "id" | "icon" | "layout"
  >[];
  terminalsById: ReadonlyMap<string, Pick<TerminalSession, "title" | "status">>;
  terminals: Pick<PanelTerminals, "select" | "close">;
  onActivateTab: (tabId: string) => void;
  onCloseTab: (tabId: string) => void;
  renderTabContent: (
    tab: SecondaryFileFixedPanelTab,
    pane: SecondaryPanelPaneRenderContext,
  ) => ReactNode;
}

export function buildSecondaryPanelRenderableTabs({
  tabs,
  pluginActions,
  terminalsById,
  terminals,
  onActivateTab,
  onCloseTab,
  renderTabContent,
}: BuildSecondaryPanelRenderableTabsArgs): SecondaryPanelRenderableTab[] {
  const filenameOf = (path: string) => path.split("/").at(-1) ?? path;

  return tabs.map((tab): SecondaryPanelRenderableTab => {
    const pluginAction =
      tab.kind === "plugin-panel"
        ? pluginActions.find(
            (action) =>
              action.pluginId === tab.pluginId && action.id === tab.actionId,
          )
        : undefined;

    const shared = {
      contentFillsRegion:
        tab.kind === "plugin-panel" &&
        (tab.fileOpenerOwner !== undefined || pluginAction?.layout === "flush"),
      onClose: () => onCloseTab(tab.id),
      onSelect: () => onActivateTab(tab.id),
      renderContent: (pane: SecondaryPanelPaneRenderContext) =>
        renderTabContent(tab, pane),
      statusLabel: null,
      tab,
    };

    switch (tab.kind) {
      case "browser": {
        const browserLabel =
          tab.title ?? (tab.url.length > 0 ? getBrowserUrlHost(tab.url) : "");

        return {
          ...shared,
          label: browserLabel.length > 0 ? browserLabel : "Browser",
          leadingVisual: (
            <Icon
              name="Globe"
              className={COARSE_POINTER_COMPACT_ICON_SIZE_CLASS}
              aria-hidden
            />
          ),
        };
      }

      case "terminal": {
        const session = terminalsById.get(tab.terminalId);

        return {
          ...shared,
          label: session?.title ?? "Terminal",
          leadingVisual: (
            <Icon
              name="Terminal"
              className={COARSE_POINTER_COMPACT_ICON_SIZE_CLASS}
              aria-hidden
            />
          ),
          statusLabel:
            session === undefined || session.status === "running"
              ? null
              : session.status,
          onSelect: () => terminals.select(tab.terminalId),
          onClose: () => terminals.close(tab.terminalId),
        };
      }

      case "workspace-file-preview":
        return {
          ...shared,
          label: filenameOf(tab.path),
          leadingVisual: <RightPanelFileTabIcon path={tab.path} />,
          statusLabel: tab.statusLabel,
        };
      case "host-file-preview":
        return {
          ...shared,
          label: filenameOf(tab.path),
          leadingVisual: <RightPanelFileTabIcon path={tab.path} />,
        };
      case "thread-storage-file-preview":
        return {
          ...shared,
          label: filenameOf(tab.path),
          isPinned: tab.isPinned,
          leadingVisual: <RightPanelFileTabIcon path={tab.path} />,
        };
      case "attachment-file-preview":
        return {
          ...shared,
          label: tab.name,
          leadingVisual: <RightPanelFileTabIcon path={tab.name} />,
        };
      case "new-tab":
        return {
          ...shared,
          label: "New tab",
          leadingVisual: (
            <Icon
              name="NewTab"
              className={COARSE_POINTER_COMPACT_ICON_SIZE_CLASS}
              aria-hidden
            />
          ),
        };
      case "plugin-panel":
        return {
          ...shared,
          label: tab.title,
          leadingVisual: (
            <PluginItemIcon
              pluginId={tab.pluginId}
              icon={pluginAction?.icon ?? null}
              className={COARSE_POINTER_COMPACT_ICON_SIZE_CLASS}
            />
          ),
        };
    }
  });
}
