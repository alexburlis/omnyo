import type { PluginNavPanelSlot } from "@/lib/plugin-slots";
import { getPluginPanelRoutePath } from "@/lib/route-paths";
import {
  hasWorkflowsPanel,
  isStateMachinesPanel,
} from "@/lib/workflow-panel-routes";
import type { PaletteAction } from "./palette-action";

interface BuildPluginPagePaletteActionsArgs {
  navigate: (path: string) => void;
  panels: readonly PluginNavPanelSlot[];
}

export function buildPluginPagePaletteActions(
  args: BuildPluginPagePaletteActionsArgs,
): PaletteAction[] {
  const hasWorkflows = hasWorkflowsPanel(args.panels);

  return args.panels
    .filter((panel) => !(hasWorkflows && isStateMachinesPanel(panel)))
    .map((panel) => ({
      id: `plugin-page:${panel.pluginId}/${panel.id}`,
      bucket: "Plugins" as const,
      group: "Plugin pages",
      title: panel.title,
      shortcut: null,
      run: () =>
        args.navigate(
          getPluginPanelRoutePath({
            pluginId: panel.pluginId,
            path: panel.path,
          }),
        ),
    }));
}
