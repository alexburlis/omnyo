import { useLayoutEffect, useMemo } from "react";
import { atom, useAtomValue, useSetAtom } from "jotai";
import { matchPath, useLocation } from "react-router-dom";
import type { ExperimentalVisibleAppContext } from "@omnyo/plugin-sdk";
import type { FixedPanelTab } from "./fixed-panel-tabs-state";
import type { MarketplacePluginDetailPanelTab } from "@/components/secondary-panel/secondaryPanelTab";
import { useRouteState } from "@/hooks/useRouteState";
import { useRootComposeProjectId } from "./root-compose-selection";

type VisiblePanel = ExperimentalVisibleAppContext["panel"];

type PanelTab = FixedPanelTab | MarketplacePluginDetailPanelTab;

interface PanelRegistration {
  token: symbol;
  pathname: string;
  panel: VisiblePanel;
}

const visiblePanelsAtom = atom<readonly PanelRegistration[]>([]);

export function projectVisiblePanel(tab: PanelTab | null): VisiblePanel {
  if (tab === null) return null;

  switch (tab.kind) {
    case "workspace-file-preview":
    case "host-file-preview":
    case "thread-storage-file-preview":
    case "attachment-file-preview":
      return {
        kind: "file",
        label: tab.path.split(/[\\/]/).at(-1) || "File",
        resourceId: null,
      };
    case "browser": {
      let label = "Browser";

      try {
        const url = new URL(tab.url);

        if (url.protocol === "https:" || url.protocol === "http:")
          label = url.origin;
      } catch {
        label = "Browser";
      }

      return { kind: "browser", label, resourceId: null };
    }

    case "terminal":
      return {
        kind: "terminal",
        label: "Terminal",
        resourceId: tab.terminalId,
      };
    case "git-diff":
      return { kind: "diff", label: "Changes", resourceId: null };
    case "thread-info":
      return { kind: "thread-info", label: "Chat details", resourceId: null };
    case "plugin-panel":
      return {
        kind: "plugin",
        label: "Plugin panel",
        resourceId: `${tab.pluginId}:${tab.actionId}`,
      };
    case "plugin-page-fixed":
      return {
        kind: "plugin",
        label: "Plugin panel",
        resourceId: `${tab.pluginId}:${tab.pageId}:${tab.fixedTabId}`,
      };
    case "marketplace-plugin-detail":
      return { kind: "plugin", label: "Plugin details", resourceId: null };
    case "new-tab":
      return { kind: "new-tab", label: "New tab", resourceId: null };
  }
}

export function usePublishVisiblePanel({
  tab,
  isOpen,
  isFocused,
}: {
  tab: PanelTab | null;
  isOpen: boolean;
  isFocused: boolean;
}): void {
  const { pathname } = useLocation();
  const setPanels = useSetAtom(visiblePanelsAtom);
  const projected = isOpen ? projectVisiblePanel(tab) : null;
  const kind = projected?.kind ?? null;
  const label = projected?.label ?? "";
  const resourceId = projected?.resourceId ?? null;
  useLayoutEffect(() => {
    if (!isFocused) return;
    const token = Symbol("visible-panel");
    const panel = kind === null ? null : { kind, label, resourceId };
    setPanels((panels) => [...panels, { token, pathname, panel }]);

    return () =>
      setPanels((panels) => panels.filter((entry) => entry.token !== token));
  }, [isFocused, kind, label, resourceId, pathname, setPanels]);
}

export function useVisibleAppContext(): ExperimentalVisibleAppContext {
  const { pathname } = useLocation();
  const route = useRouteState();
  const [composeProjectId] = useRootComposeProjectId();
  const panels = useAtomValue(visiblePanelsAtom);

  const isCompose =
    route.isRootView ||
    matchPath({ path: "/projects/:projectId", end: true }, pathname) !== null;

  const view: ExperimentalVisibleAppContext["view"] = route.isThreadView
    ? "thread"
    : pathname === "/settings" || pathname.startsWith("/settings/")
      ? "settings"
      : route.isArchivedView
        ? "archive"
        : isCompose
          ? "compose"
          : pathname.startsWith("/plugins/")
            ? "plugin"
            : route.isToolsView || route.isSkillsView
              ? "tools"
              : "other";

  const panel =
    view === "thread" || view === "compose" || view === "plugin"
      ? (panels.filter((entry) => entry.pathname === pathname).at(-1)?.panel ??
        null)
      : null;

  return useMemo(
    () => ({
      view,
      projectId: isCompose
        ? (route.projectId ?? composeProjectId)
        : (route.projectId ?? null),
      threadId: route.threadId ?? null,
      panel,
    }),
    [view, isCompose, route.projectId, route.threadId, composeProjectId, panel],
  );
}
