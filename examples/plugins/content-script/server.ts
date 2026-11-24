import type { PluginApi } from "@omnyo/plugin-sdk";

export default function contentScriptExample(api: PluginApi) {
  api.log.info("Content script example loaded");
}
