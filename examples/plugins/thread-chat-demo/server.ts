import type { PluginApi } from "@omnyo/plugin-sdk";

export default function plugin(api: PluginApi) {
  api.log.info("thread-chat-demo loaded (frontend-only demo)");
}
