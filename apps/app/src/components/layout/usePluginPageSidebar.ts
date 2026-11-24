import { useCallback, useState } from "react";
import { matchPath, useLocation } from "react-router-dom";
import { NEEDS_YOU_PANEL, PLUGIN_PANEL_ROUTE_PATH } from "@/lib/route-paths";

export function usePluginPageSidebar(
  appOpen: boolean,
  setAppOpen: (open: boolean) => void,
): [boolean, (open: boolean) => void] {
  const { pathname } = useLocation();

  const panel = matchPath(PLUGIN_PANEL_ROUTE_PATH, pathname);

  const keepsSidebar =
    (panel?.params.pluginId === "canvas" && panel.params.panelPath === "p") ||
    (panel?.params.pluginId === NEEDS_YOU_PANEL.pluginId &&
      panel.params.panelPath === NEEDS_YOU_PANEL.path);

  const pluginPagePath = panel && !keepsSidebar ? pathname : null;

  const [pluginSidebar, setPluginSidebar] = useState({
    path: pluginPagePath,
    open: false,
  });

  if (pluginSidebar.path !== pluginPagePath) {
    setPluginSidebar({ path: pluginPagePath, open: false });
  }

  const open =
    pluginPagePath === null
      ? appOpen
      : pluginSidebar.path === pluginPagePath && pluginSidebar.open;

  const setOpen = useCallback(
    (nextOpen: boolean) => {
      if (pluginPagePath === null) setAppOpen(nextOpen);
      else setPluginSidebar({ path: pluginPagePath, open: nextOpen });
    },
    [pluginPagePath, setAppOpen],
  );

  return [open, setOpen];
}
