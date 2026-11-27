import type { PluginNavPanelProps } from "@omnyo/plugin-sdk/app";

import { useAttention } from "./data/hooks.js";
import { QueryProvider } from "./data/query.js";
import { DraftEditorScreen } from "./editor/DraftEditor.js";
import { InstanceScreen } from "./instance/InstanceScreen.js";
import { Button, EmptyState } from "./primitives.js";
import { parseRoute } from "./routes.js";
import { AttentionInbox } from "./screens/AttentionInbox.js";
import { MachineList } from "./screens/MachineList.js";
import { MachinePage } from "./screens/MachinePage.js";
import { MachineSettings } from "./screens/MachineSettings.js";
import { NewMachine } from "./screens/NewMachine.js";
import { VersionList, VersionScreen } from "./screens/Versions.js";
import { Announcer, Page, useGo, useConnectionFrozen } from "./shell.js";

export function MachinesPanel({ subPath }: PluginNavPanelProps) {
  return (
    <div className="stm-root stm-panel">
      <QueryProvider>
        <Announcer>
          <PanelRoute subPath={subPath} />
        </Announcer>
      </QueryProvider>
    </div>
  );
}

function PanelRoute({ subPath }: { subPath: string }) {
  const route = parseRoute(subPath);
  const go = useGo();

  switch (route.screen) {
    case "list":
      return <MachineList />;
    case "new":
      return <NewMachine />;
    case "attention":
      return <AttentionInbox />;
    case "machine":
      return <MachinePage machineId={route.machineId} />;
    case "instance":
      return (
        <InstanceScreen
          machineId={route.machineId}
          instanceId={route.instanceId}
          view={route.view}
          selection={route.selection}
        />
      );
    case "draft":
      return <DraftEditorScreen machineId={route.machineId} selection={route.selection} />;
    case "versions":
      return <VersionList machineId={route.machineId} />;
    case "version":
      return (
        <VersionScreen
          machineId={route.machineId}
          versionId={route.versionId}
          compareWith={route.compareWith}
          selection={route.selection}
        />
      );
    case "settings":
      return <MachineSettings machineId={route.machineId} />;
    case "not-found":
      return (
        <Page crumbs={[{ label: "State machines", route: { screen: "list" } }]} title="Not found">
          <EmptyState
            title="This page doesn't exist."
            actions={<Button onClick={() => go({ screen: "list" })}>Back to State machines</Button>}
          />
        </Page>
      );
  }
}

export function MachinesHeaderContent() {
  return (
    <div className="stm-root">
      <QueryProvider>
        <HeaderStatus />
      </QueryProvider>
    </div>
  );
}

function HeaderStatus() {
  const attention = useAttention(null, null);
  const frozen = useConnectionFrozen();
  const go = useGo();
  const count = attention.data?.length ?? 0;

  if (count === 0 && !frozen) return null;

  return (
    <button type="button" className="stm-header-status" onClick={() => go({ screen: "attention" })}>
      {count > 0 ? (
        <>
          <span className="stm-pill-dot stm-pill-dot--attention" aria-hidden="true" />
          <span>
            {count} need{count === 1 ? "s" : ""} you
          </span>
        </>
      ) : null}
      {frozen ? <span className="stm-text-muted">Reconnecting…</span> : null}
    </button>
  );
}
