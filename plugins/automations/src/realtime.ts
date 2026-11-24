import type { PluginApi } from "@omnyo/plugin-sdk";

type AutomationSignalKind = "automations-changed" | "automation-runs-changed";

export function publishAutomationChange(
  api: Pick<PluginApi, "realtime">,
  projectId: string,
  kinds: AutomationSignalKind | AutomationSignalKind[],
): void {
  for (const kind of Array.isArray(kinds) ? kinds : [kinds]) {
    api.realtime.publish("automations", { projectId, kind });
  }
}
