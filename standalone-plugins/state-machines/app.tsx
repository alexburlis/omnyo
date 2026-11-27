import { definePluginApp } from "@omnyo/plugin-sdk/app";

import { RUN_DECISION_RENDERER_ID } from "./src/contracts/run-decision.js";
import { RunDecision } from "./src/ui/attention/RunDecision.js";
import { MachinesHeaderContent, MachinesPanel } from "./src/ui/MachinesPanel.js";
import { PANEL_PATH } from "./src/ui/routes.js";
import "./app.css";

export default definePluginApp((app) => {
  app.slots.pendingInteraction({ id: RUN_DECISION_RENDERER_ID, component: RunDecision });
  app.slots.navPanel({
    id: "machines",
    title: "State machines",
    icon: "Workflow",
    path: PANEL_PATH,
    component: MachinesPanel,
    headerContent: MachinesHeaderContent,
  });
});
