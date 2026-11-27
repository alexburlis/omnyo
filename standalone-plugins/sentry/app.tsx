import { useEffect, useSyncExternalStore } from "react";
import {
  definePluginApp,
  experimental_ProviderModelPicker as ProviderModelPicker,
  experimental_useAppNavigate,
  useRealtime,
  usePluginResource,
  useRpc,
} from "@omnyo/plugin-sdk/app";
import type { rpcContract } from "./contract";
import { ModelDefaultsBar } from "./src/ui/models";
import { SentryRailBadge } from "./src/ui/badge";
import { InboxClient } from "./src/ui/client";
import {
  mountSentryCallbackRows,
  SentryCallbackBridge,
  SentryCallbackFooter,
} from "./src/ui/callbacks";
import { SentrySettingsSummary } from "./src/ui/settings-summary";
import { SentryView } from "./src/ui/view";

const emptyInbox = new InboxClient({
  call: async () => {
    throw new Error("Sentry client is not ready");
  },
});

const noSubscription = () => () => {};

function useInbox(badgeOnly = false) {
  const rpc = useRpc<typeof rpcContract>();

  const owner = usePluginResource({
    key: ["sentry", "client"],
    load: async () => new InboxClient(rpc),
  });

  const client = owner.data;

  const snapshot = useSyncExternalStore(
    client?.subscribe ?? noSubscription,
    client?.getSnapshot ?? emptyInbox.getSnapshot,
  );

  const resource = usePluginResource({
    key: ["sentry", badgeOnly ? "badge" : "screen"],
    staleTime: 0,
    enabled: Boolean(client),
    load: async () => {
      if (!client) throw new Error("Sentry client is not ready");
      await (badgeOnly ? client.refreshBadge() : client.refresh());

      return client.getSnapshot();
    },
  });

  useEffect(() => {
    if (!badgeOnly || !client) return;
    const timer = window.setTimeout(() => client.warm(), 2000);

    return () => window.clearTimeout(timer);
  }, [client, badgeOnly]);
  useRealtime("changed", () => {
    void resource.refresh();
  });

  return { client, snapshot };
}

function SentryPage() {
  const { client, snapshot } = useInbox();
  const navigate = experimental_useAppNavigate();

  if (!client) return <p role="status">Loading Sentry…</p>;

  return (
    <SentryView
      client={client}
      snapshot={snapshot}
      onOpenThread={(id) => {
        navigate.toThread(id);
      }}
      ModelPicker={ProviderModelPicker}
    />
  );
}

function SentrySettings() {
  const { client, snapshot } = useInbox();
  const { status, error, pending } = snapshot;
  const navigate = experimental_useAppNavigate();

  return (
    <SentrySettingsSummary
      status={status}
      error={error}
      onOpen={() => navigate.toPluginPanel("sentry")}
    >
      {status && client && (
        <ModelDefaultsBar
          models={status.models}
          Picker={ProviderModelPicker}
          pending={(key) => pending.includes(key)}
          onSave={client.saveModel}
        />
      )}
    </SentrySettingsSummary>
  );
}

function IconCount() {
  const { snapshot } = useInbox(true);
  const { badge, badgeRefreshing, badgeError } = snapshot;

  return badge ? (
    <SentryRailBadge
      count={badge.count}
      freshness={badgeRefreshing || badgeError ? "stale" : badge.freshness}
    />
  ) : null;
}

export default definePluginApp((app) => {
  app.contentScripts.register({
    id: "sentry-native-callback-status",
    mount: mountSentryCallbackRows,
  });
  app.composer.customize({
    id: "sentry-native-callback",
    scopes: ["thread"],
    banners: [{ id: "sentry-native-callback", chrome: "bare", component: SentryCallbackFooter }],
  });
  app.slots.experimental_appOverlay({
    id: "sentry-native-callback-status",
    component: SentryCallbackBridge,
  });
  app.slots.navPanel({
    id: "sentry",
    title: "Sentry",
    icon: "Bug",
    path: "sentry",
    component: SentryPage,
  });
  app.slots.experimental_appOverlay({ id: "sentry-icon-count", component: IconCount });
  app.slots.settingsSection({ id: "sentry-routes", title: "Status", component: SentrySettings });
});
