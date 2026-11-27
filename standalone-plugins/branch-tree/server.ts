import type { PluginApi } from "@omnyo/plugin-sdk";

export default function plugin(api: PluginApi) {
  api.onInstall(async () => {
    const { preferences } = await api.sdk.system.uiPreferences.list();
    await api.sdk.system.uiPreferences.set({
      key: "sidebar.threadListProvider",
      value: `${api.pluginId}/tree`,
      expectedRevision: preferences["sidebar.threadListProvider"].revision,
    });
  });
}
