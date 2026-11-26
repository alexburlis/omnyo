import type { PluginApi } from "@omnyo/plugin-sdk";
import { experimental_registerHostProviderUsageSourceV1 } from "@omnyo/plugin-sdk/provider-usage";

export function registerUsageSource(api: PluginApi) {
  experimental_registerHostProviderUsageSourceV1(api, {
    ownsProvider: (provider) =>
      provider.pluginId === "provider-claude-code" &&
      provider.id === "claude-code",
    description:
      "Host-local usage owned by the claude-code provider plugin. Inventory reads metadata only. Independent of display plugins.",
  });
}
