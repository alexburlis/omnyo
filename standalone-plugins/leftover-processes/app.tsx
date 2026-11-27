import { definePluginApp } from "@omnyo/plugin-sdk/app";
import { LeftRunningCompanion } from "./components/companion";
import { LeftRunningPage } from "./components/panel";
import { PANEL_PATH } from "./lib/names";

const ICON = "Terminal";

export default definePluginApp((app) => {
  app.slots.navPanel({
    id: "left-running",
    title: "Task Manager",
    icon: ICON,
    path: PANEL_PATH,
    component: LeftRunningPage,
  });

  app.slots.experimental_threadCompanion({
    id: "left-running",
    title: "Task Manager",
    icon: ICON,
    component: LeftRunningCompanion,
  });
});
