import { definePluginApp } from "@omnyo/plugin-sdk/app";
import { Callout, InlineBadge, MetricRow, Progress } from "./blocks";
import { MiniChart } from "./chart";
import { ComparisonBars } from "./comparison";
import { RecordFence } from "./fences";
import { recordFenceLanguages } from "./record-fields";
import { FileCard, StatusTable } from "./records";
import { OrderedSteps } from "./steps";
import { registerVisualizations } from "./visualizations";
import "./app.css";

export default definePluginApp((app) => {
  registerVisualizations(app);
  app.slots.messageDirective({ id: "metric-row", component: MetricRow });
  app.slots.messageDirective({ id: "mini-chart", component: MiniChart });
  app.slots.messageDirective({ id: "comparison-bars", component: ComparisonBars });
  app.slots.messageDirective({ id: "ordered-steps", component: OrderedSteps });
  app.slots.messageDirective({ id: "status-table", component: StatusTable });
  app.slots.messageDirective({ id: "file-card", component: FileCard });
  app.slots.experimental_codeFenceRenderer({
    id: "record-fences",
    languages: recordFenceLanguages,
    component: RecordFence,
  });
  app.slots.messageDirective({ id: "callout", component: Callout });
  app.slots.messageDirective({ id: "inline-badge", component: InlineBadge });
  app.slots.messageDirective({ id: "progress", component: Progress });
  app.contentScripts.register({
    id: "chat-typography",
    mount() {
      const root = document.documentElement;
      root.setAttribute("data-omnyo-inline-ui", "true");

      return () => root.removeAttribute("data-omnyo-inline-ui");
    },
  });
});
