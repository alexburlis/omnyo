import { definePluginApp } from "@omnyo/plugin-sdk/app";
import {
  ASSISTANT_TITLE,
  HOME_PATH,
  IDLE_TOOLTIP,
  NEEDS_YOU_TITLE,
} from "./components/chief-logic.ts";
import { ChiefPage } from "./components/chief-page.tsx";
import { ChiefCard } from "./components/companion.tsx";
import { CHIEF_ICON, ChiefDiamond } from "./components/icon.tsx";
import { ChiefSettings } from "./components/settings.tsx";
import { useChiefRowStatus } from "./components/use-row-status.ts";

export default definePluginApp((app) => {
  app.experimental_icons.register({ name: CHIEF_ICON, component: ChiefDiamond });
  app.slots.navPanel({
    id: HOME_PATH,
    title: NEEDS_YOU_TITLE,
    icon: CHIEF_ICON,
    path: HOME_PATH,
    component: ChiefPage,
  });
  app.slots.experimental_sidebarEntry({
    id: "chief",
    title: NEEDS_YOU_TITLE,
    icon: CHIEF_ICON,
    panel: HOME_PATH,
    tooltip: IDLE_TOOLTIP,
    useStatus: useChiefRowStatus,
  });
  app.slots.experimental_threadCompanion({
    id: "chief",
    title: "Chief",
    icon: CHIEF_ICON,
    component: ChiefCard,
  });
  app.slots.settingsSection({
    id: "chief",
    title: ASSISTANT_TITLE,
    description: "Manage answer suggestions, agents and rules.",
    component: ChiefSettings,
  });
});
