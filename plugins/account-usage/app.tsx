import { definePluginApp } from "@omnyo/plugin-sdk/app";
import {
  UsagePanel,
  type UsagePanelLayout,
} from "./components/usage-panel.tsx";

const CARD_LAYOUT = {
  rail: "rail",
  sidebar: "rail",
  footer: "footer",
} as const satisfies Record<string, UsagePanelLayout>;

export default definePluginApp((app) => {
  app.slots.experimental_sidebarFooterCard({
    id: "usage",
    component: ({ experimental_placement = "rail" }) => (
      <UsagePanel layout={CARD_LAYOUT[experimental_placement]} />
    ),
  });
});
