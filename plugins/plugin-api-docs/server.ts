import type { PluginApi } from "@omnyo/plugin-sdk";
import {
  PLUGIN_GUIDE_SURFACE_PROVIDER_ID,
  pluginSurfaceAgentContext,
} from "./src/agent-reference";

export default function plugin(api: PluginApi) {
  api.ui.registerMentionProvider({
    id: PLUGIN_GUIDE_SURFACE_PROVIDER_ID,
    label: "Plugin Guide",
    search: () => [],
    resolve(surfaceId) {
      const context = pluginSurfaceAgentContext(surfaceId);

      if (context === null) {
        throw new Error(`Unknown Plugin Guide surface: ${surfaceId}`);
      }

      return { context };
    },
  });
  api.log.debug("plugin API docs loaded");
}
