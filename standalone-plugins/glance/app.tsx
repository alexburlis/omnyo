import { z } from "zod";
import {
  definePluginApp,
  experimental_useAppContext,
  useComposer,
  type PluginAppBuilder,
  type PluginAppSlots,
} from "@omnyo/plugin-sdk/app";
import {
  ComposerDevServers,
  devServersPopupId,
  DevServersPopup,
  HeaderDevServers,
} from "./components/dev-servers";
import { ComposerReadiness } from "./components/composer-readiness";
import { CardChangeBroadcast } from "./components/broadcast";
import { useCard } from "./components/data";
import { GlanceCard } from "./components/card";
import { CompanionIcon, companionIcon, GlanceCompanion } from "./components/companion";
import { GlancePage } from "./components/page";
import { useNotReadyAction, useReadinessSource } from "./components/readiness";
import { mountSubtitles, SubtitleSync } from "./components/subtitles";

function ComposerCard() {
  const composer = useComposer();

  if (composer.scope.kind !== "thread") return null;

  return <GlanceCard key={composer.scope.threadId} threadId={composer.scope.threadId} />;
}

function EarlyCard({ threadId }: { threadId: string }) {
  useCard(threadId);

  return null;
}

function ChatSync() {
  const { threadId } = experimental_useAppContext();
  useReadinessSource();

  return (
    <>
      <CardChangeBroadcast />
      <SubtitleSync />
      {threadId === null ? null : <EarlyCard key={threadId} threadId={threadId} />}
    </>
  );
}

type HostSlots = Omit<PluginAppSlots, "experimental_threadCompanion"> &
  Partial<Pick<PluginAppSlots, "experimental_threadCompanion">>;

type GlanceAppBuilder = Omit<PluginAppBuilder, "slots"> & { slots: HostSlots };

export function setupGlance(app: GlanceAppBuilder) {
  app.slots.experimental_threadAction({
    id: "not-ready",
    title: "Not ready to archive",
    icon: "X",
    group: "lifecycle",
    useData: useNotReadyAction,
    item: ({ thread, data, sdk }) => {
      if (thread.archivedAt !== null || data.ready(thread.id) !== "ready") return null;

      return {
        label: "Not ready to archive",
        icon: "X",
        run: async () => {
          await sdk.plugins.callRpc({
            pluginId: "tidy",
            method: "dismiss",
            input: { threadId: thread.id },
            outputSchema: z.object({ threadId: z.string(), dismissed: z.boolean() }),
          });
          await data.refresh();
        },
      };
    },
  });
  app.slots.experimental_threadHeaderAction({
    id: "dev-servers",
    title: "Dev servers",
    component: HeaderDevServers,
  });
  app.composer.customize({
    id: "glance-dev-servers",
    scopes: ["thread"],
    experimental_popups: [
      { id: devServersPopupId, label: "Dev servers", component: DevServersPopup },
    ],
    banners: [
      {
        id: "dev-servers",
        chrome: "bare",
        experimental_placement: "adjacent-to-composer",
        component: ComposerDevServers,
      },
    ],
  });

  if (app.slots.experimental_threadCompanion === undefined) {
    app.composer.customize({
      id: "glance",
      scopes: ["thread"],
      banners: [
        {
          id: "card",
          chrome: "bare",
          experimental_placement: "adjacent-to-composer",
          component: ComposerCard,
        },
      ],
    });
  } else {
    app.composer.customize({
      id: "glance-ready",
      scopes: ["thread"],
      banners: [
        {
          id: "ready",
          chrome: "bare",
          experimental_placement: "adjacent-to-composer",
          component: ComposerReadiness,
        },
      ],
    });
    app.experimental_icons.register({ name: companionIcon, component: CompanionIcon });
    app.slots.experimental_threadCompanion({
      id: "card",
      title: "Glance",
      icon: companionIcon,
      component: GlanceCompanion,
    });
  }

  app.slots.navPanel({
    id: "glance",
    title: "Glance",
    icon: "GridView",
    path: "glance",
    component: GlancePage,
  });
  app.slots.experimental_appOverlay({ id: "subtitles", component: ChatSync });
  app.contentScripts.register({ id: "subtitles", mount: mountSubtitles });
}

export default definePluginApp(setupGlance);
