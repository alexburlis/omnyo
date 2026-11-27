import { Activity, useEffect, useState, useSyncExternalStore } from "react";
import type { PluginRpcClient } from "@omnyo/plugin-sdk/app";
import { InboxClient } from "../src/ui/client";
import { SentryView } from "../src/ui/view";
import { statusSchema, type InboxPage, type rpcContract } from "../contract";
import { incident, route } from "./fixtures";
import { inboxViewProps } from "./inbox-view-fixture";

const mappings = [route(), { ...route(), id: "other", projectId: "proj_other" }];

const projects = [
  { id: "proj_app", name: "App" },
  { id: "proj_other", name: "Other" },
];

const calls = { status: 0, targets: 0, pages: { proj_app: 0, proj_other: 0 } };

let releaseTargets = () => {};

const targets = new Promise<{ projects: typeof projects; hosts: [] }>((resolve) => {
  releaseTargets = () => resolve({ projects, hosts: [] });
});

const pages = new Map<string, (page: InboxPage) => void>();

function releasePage(projectId: string, fresh = false) {
  const mapping = mappings.find((entry) => entry.projectId === projectId);

  if (!mapping) throw new Error("Unknown fixture project");
  const base = projectId === "proj_app" ? (fresh ? 510 : 500) : 600;

  const incidents = [1, 2].map((index) => ({
    ...incident(String(base + index)),
    matchedRouteIds: [mapping.id],
  }));

  const resolve = pages.get(projectId);

  if (!resolve) throw new Error("No pending fixture page");
  resolve({ incidents, total: incidents.length });
}

declare global {
  interface Window {
    sentryLoading: {
      releaseTargets: typeof releaseTargets;
      releasePage: typeof releasePage;
      calls: typeof calls;
      warm: () => void;
      setVisible: (visible: boolean) => void;
    };
  }
}

window.sentryLoading = { releaseTargets, releasePage, calls, warm: () => {}, setVisible: () => {} };

// SAFETY: the fixture implements only status, targets and inbox.list, each with its contracted shape.
const call = (async (method: string, input?: { projectId: string }) => {
  if (method === "targets") {
    calls.targets++;

    return targets;
  }

  if (method === "status") {
    calls.status++;

    return statusSchema.parse({
      connected: true,
      apiOrigin: "https://fixture.invalid",
      lastError: null,
      routes: mappings,
      incidents: [incident()],
      runs: [],
      syncs: [],
      batches: [],
      projectIssueCounts: projects.map((project) => ({ projectId: project.id, count: 2 })),
      projectPolicies: [],
      notificationLimit: "Fixture only",
      badge: { count: 4, watchedRoutes: 2, freshness: "live", lastSyncedAt: null },
    });
  }

  if (method !== "inbox.list" || !input) throw new Error("Unexpected fixture RPC");
  const projectId = input.projectId;

  if (projectId === "proj_app" || projectId === "proj_other") calls.pages[projectId]++;

  return new Promise<InboxPage>((resolve) => pages.set(projectId, resolve));
}) as PluginRpcClient<typeof rpcContract>["call"];

export function LoadingFixture() {
  const [client] = useState(() => new InboxClient({ call }));
  const [visible, setVisible] = useState(true);
  window.sentryLoading.warm = () => client.warm();
  window.sentryLoading.setVisible = setVisible;
  const snapshot = useSyncExternalStore(client.subscribe, client.getSnapshot);
  useEffect(() => {
    void client.refresh();
  }, [client]);
  const props = inboxViewProps(snapshot.status);

  return (
    <Activity mode={visible ? "visible" : "hidden"}>
      <SentryView {...props} client={client} snapshot={snapshot} />
    </Activity>
  );
}
