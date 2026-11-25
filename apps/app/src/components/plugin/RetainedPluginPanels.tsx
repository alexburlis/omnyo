import {
  createPluginPortalRetention,
  PluginPortalRetentionBoundary,
  type PluginPortalRetention,
} from "@/lib/plugin-portal-retention";
import {
  Activity,
  useCallback,
  useLayoutEffect,
  useState,
  type ReactNode,
} from "react";
import type { PaneContent } from "@/lib/split-layout";
import { usePluginSlots } from "@/lib/plugin-slots";
import {
  getMergedGraphSubPath,
  STATE_MACHINES_PANEL,
} from "@/lib/workflow-panel-routes";

type Panel = Extract<PaneContent, { kind: "plugin-panel" }>;

const panelLimit = 4;

function registeredPanel(
  content: Panel,
  panels: ReturnType<typeof usePluginSlots>["navPanels"],
) {
  const address = { pluginId: content.pluginId, path: content.panelPath };

  const target =
    getMergedGraphSubPath(address, content.subPath) === undefined
      ? address
      : STATE_MACHINES_PANEL;

  return panels.find(
    (panel) => panel.pluginId === target.pluginId && panel.path === target.path,
  );
}

export function RetainedPluginPanels({
  content,
  children,
  renderPanel,
}: {
  content: PaneContent;
  children?: ReactNode;
  renderPanel: (panel: Panel) => ReactNode;
}) {
  const { navPanels } = usePluginSlots();

  const [history, setHistory] = useState<
    readonly {
      content: Panel;
      generation: number;
      retention: PluginPortalRetention;
    }[]
  >([]);

  const active = content.kind === "plugin-panel" ? content : null;
  const generation = active && registeredPanel(active, navPanels)?.generation;

  const [retentions] = useState(() => new Map<string, PluginPortalRetention>());

  const retentionFor = useCallback(
    (panel: Panel) => {
      const key = JSON.stringify([panel.pluginId, panel.panelPath]);
      let retention = retentions.get(key);

      if (!retention) {
        retention = createPluginPortalRetention();
        retentions.set(key, retention);
      }

      return retention;
    },
    [retentions],
  );

  const other = history.filter(
    (entry) =>
      !(
        active?.pluginId === entry.content.pluginId &&
        active.panelPath === entry.content.panelPath
      ) &&
      entry.retention.canRetain() &&
      registeredPanel(entry.content, navPanels)?.generation ===
        entry.generation,
  );

  useLayoutEffect(() => {
    if (!active) {
      setHistory((previous) =>
        other.length === previous.length ? previous : other,
      );

      return;
    }

    if (generation == null) return;
    setHistory((previous) => {
      const last = previous.at(-1);

      if (
        last?.content.pluginId === active.pluginId &&
        last.content.panelPath === active.panelPath &&
        last.content.subPath === active.subPath &&
        last.generation === generation
      )
        return previous;

      const next = [
        ...other.slice(1 - panelLimit),
        { content: active, generation, retention: retentionFor(active) },
      ];

      const keys = new Set(
        next.map((entry) =>
          JSON.stringify([entry.content.pluginId, entry.content.panelPath]),
        ),
      );

      for (const key of retentions.keys())
        if (!keys.has(key)) retentions.delete(key);

      return next;
    });
  }, [active, generation, other, retentionFor, retentions]);

  const panels = active
    ? [...other.slice(1 - panelLimit).map((entry) => entry.content), active]
    : other.map((entry) => entry.content);

  return (
    <>
      {panels.map((panel) => (
        <Activity
          key={JSON.stringify([panel.pluginId, panel.panelPath])}
          mode={panel === active ? "visible" : "hidden"}
        >
          <PluginPortalRetentionBoundary retention={retentionFor(panel)}>
            {renderPanel(panel)}
          </PluginPortalRetentionBoundary>
        </Activity>
      ))}
      {active ? null : children}
    </>
  );
}
