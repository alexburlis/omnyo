import {
  AUTOMATIONS_PLUGIN_ID,
  AUTOMATIONS_ROUTE_PATH,
  getPluginPanelRoutePath,
} from "@/lib/route-paths";

const WORKFLOWS_PANEL = {
  pluginId: AUTOMATIONS_PLUGIN_ID,
  path: "automations",
};

export const STATE_MACHINES_PANEL = {
  pluginId: "state-machines",
  path: "machines",
};

export const WORKFLOW_GRAPHS_PATH = `${AUTOMATIONS_ROUTE_PATH}/graphs`;

const stateMachinesPath = getPluginPanelRoutePath(STATE_MACHINES_PANEL);

interface PanelAddress {
  pluginId: string;
  path: string;
}

export function isStateMachinesPanel(panel: PanelAddress): boolean {
  return (
    panel.pluginId === STATE_MACHINES_PANEL.pluginId &&
    panel.path === STATE_MACHINES_PANEL.path
  );
}

export function hasWorkflowsPanel(panels: readonly PanelAddress[]): boolean {
  return panels.some(
    (panel) =>
      panel.pluginId === WORKFLOWS_PANEL.pluginId &&
      panel.path === WORKFLOWS_PANEL.path,
  );
}

export function getMergedGraphSubPath(
  panel: PanelAddress,
  subPath: string,
): string | undefined {
  if (
    panel.pluginId === WORKFLOWS_PANEL.pluginId &&
    panel.path === WORKFLOWS_PANEL.path &&
    subPath.startsWith("graphs/") &&
    subPath.length > "graphs/".length
  ) {
    return subPath.slice("graphs/".length);
  }
}

export function getWorkflowGraphPath(subPath = ""): string {
  return getPluginPanelRoutePath({
    ...WORKFLOWS_PANEL,
    subPath: `graphs/${subPath}`,
  });
}

export function getLegacyGraphRedirect(pathname: string): string | null {
  if (pathname === stateMachinesPath) return WORKFLOW_GRAPHS_PATH;

  return pathname.startsWith(`${stateMachinesPath}/`)
    ? `${WORKFLOW_GRAPHS_PATH}${pathname.slice(stateMachinesPath.length)}`
    : null;
}
