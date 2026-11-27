import { definePluginApp } from "@omnyo/plugin-sdk/app";
import { panelAction } from "./components/thread-panel-action";
import { CanvasHeaderButton, compactCanvasAction } from "./components/header";
import { modeMenuItem, modePopup } from "./components/mode-toggle";
import { CanvasFullScreen } from "./components/fullscreen";
import { CanvasPanel } from "./components/panel";
import { ProjectCanvasPage } from "./components/project";
import { ProjectCanvasHeader } from "./components/project-header";
import {
  ProjectEntryPoints,
  projectPaletteAction,
  projectThreadAction,
  projectRowMarksScript,
} from "./components/project-entry-points";
import { projectSidebarItems } from "./components/project-sidebar";
import "./project.css";
import "./app.css";
import "./editor.css";

export default definePluginApp((app) => {
  app.contentScripts.register(projectRowMarksScript);
  app.slots.experimental_projectSidebarItems(projectSidebarItems);
  app.slots.commandPaletteAction(projectPaletteAction);
  app.slots.experimental_threadAction(projectThreadAction);
  app.slots.experimental_threadAction(compactCanvasAction);
  app.slots.experimental_appOverlay({ id: "project-entry-points", component: ProjectEntryPoints });
  app.slots.navPanel({
    id: "project-canvas",
    title: "Canvas",
    icon: "GridView",
    path: "p",
    component: ProjectCanvasPage,
    headerContent: ProjectCanvasHeader,
  });
  app.slots.threadPanelAction({
    id: panelAction.actionId,
    title: panelAction.title,
    icon: "GridView",
    layout: "flush",
    component: CanvasPanel,
  });
  app.slots.experimental_threadHeaderAction({
    id: "canvas-open",
    title: panelAction.title,
    component: CanvasHeaderButton,
  });
  app.slots.experimental_appOverlay({ id: "canvas-full-screen", component: CanvasFullScreen });
  app.composer.customize({
    id: "canvas-mode",
    scopes: ["new-thread", "thread"],
    plusMenu: [modeMenuItem],
    experimental_popups: [modePopup],
  });
});
