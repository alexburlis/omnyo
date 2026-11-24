import { useNavigate } from "react-router-dom";
import { Button } from "@omnyo/shared-ui/button";
import { EmptyStateBlock } from "@omnyo/shared-ui/empty-state";
import { Icon } from "@omnyo/shared-ui/icon";
import { PageShell } from "@/components/ui/page-shell.js";
import { PluginSlotMount } from "@/components/plugin/PluginSlotMount";
import { usePluginFrontendsSettled } from "@/lib/plugin-frontend-boot-state";
import { usePluginSlots } from "@/lib/plugin-slots";
import { getPluginsRoutePath } from "@/lib/route-paths";

import {
  getMergedGraphSubPath,
  STATE_MACHINES_PANEL,
} from "@/lib/workflow-panel-routes";

interface PluginPanelViewProps {
  pluginId: string;
  panelPath: string;
  subPath: string;
}

const PLUGIN_PANEL_SHELL_CLASS =
  "pt-[calc(var(--omnyo-app-chrome-row-height)+1rem)] md:pt-[calc(var(--omnyo-app-chrome-row-height)+1.25rem)]";

export function PluginPanelUnavailable({
  onOpenPlugins,
}: {
  onOpenPlugins: () => void;
}) {
  return (
    <div className="flex min-h-[60dvh] items-center justify-center">
      <EmptyStateBlock
        icon="Puzzle"
        title="This plugin panel is not available"
        description="The plugin that adds this panel is turned off, not running or was removed. Check it in your installed plugins to bring the panel back."
        actions={
          <Button type="button" size="sm" onClick={onOpenPlugins}>
            Go to installed plugins
            <Icon name="ArrowRight" aria-hidden />
          </Button>
        }
      />
    </div>
  );
}

export function PluginPanelView({
  pluginId,
  panelPath,
  subPath,
}: PluginPanelViewProps) {
  const navigate = useNavigate();
  const { navPanels } = usePluginSlots();
  const pluginsSettled = usePluginFrontendsSettled();

  const graphSubPath = getMergedGraphSubPath(
    { pluginId, path: panelPath },
    subPath,
  );

  const address =
    graphSubPath === undefined
      ? { pluginId, path: panelPath }
      : STATE_MACHINES_PANEL;

  const panel =
    navPanels.find(
      (candidate) =>
        candidate.pluginId === address.pluginId &&
        candidate.path === address.path,
    ) ?? null;

  if (panel === null) {
    return (
      <PageShell contentClassName={PLUGIN_PANEL_SHELL_CLASS}>
        {pluginsSettled ? (
          <PluginPanelUnavailable
            onOpenPlugins={() =>
              navigate(`${getPluginsRoutePath()}?view=installed`)
            }
          />
        ) : null}
      </PageShell>
    );
  }

  return (
    <div
      className="-m-4 flex min-h-0 flex-1 flex-col overflow-hidden md:-m-5"
      data-testid="plugin-panel-body"
    >
      <PluginSlotMount
        key={`${panel.pluginId}/${panel.id}/${panel.generation}`}
        pluginId={panel.pluginId}
        slotKind="navPanel"
        slotId={panel.id}
      >
        <panel.component subPath={graphSubPath ?? subPath} />
      </PluginSlotMount>
    </div>
  );
}
