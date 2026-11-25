import { useNavigate } from "react-router-dom";
import { Button } from "@omnyo/shared-ui/button";
import { EmptyStateBlock } from "@omnyo/shared-ui/empty-state";
import { Icon } from "@omnyo/shared-ui/icon";
import {
  PluginPageLoad,
  PluginPanelLoading,
} from "@/components/plugin/PluginPageLoad";
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

  return (
    <div
      className="-m-4 flex min-h-0 flex-1 flex-col overflow-hidden md:-m-5"
      data-testid="plugin-panel-body"
    >
      {panel === null ? (
        pluginsSettled ? (
          <PluginPanelUnavailable
            onOpenPlugins={() =>
              navigate(`${getPluginsRoutePath()}?view=installed`)
            }
          />
        ) : (
          <PluginPanelLoading />
        )
      ) : (
        <PluginPageLoad
          key={`${panel.pluginId}/${panel.id}/${panel.generation}`}
        >
          <PluginSlotMount
            pluginId={panel.pluginId}
            slotKind="navPanel"
            slotId={panel.id}
          >
            <panel.component subPath={graphSubPath ?? subPath} />
          </PluginSlotMount>
        </PluginPageLoad>
      )}
    </div>
  );
}
