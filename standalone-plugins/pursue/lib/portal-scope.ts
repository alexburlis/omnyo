declare const __OMNYO_PLUGIN_ID__: string | undefined;

export function usePortalScopeProps(): {
  "data-omnyo-portaled-overlay": "";
  "data-omnyo-plugin-root"?: "";
  "data-omnyo-plugin"?: string;
} {
  const pluginId =
    typeof __OMNYO_PLUGIN_ID__ === "string" ? __OMNYO_PLUGIN_ID__ : undefined;
  return {
    "data-omnyo-portaled-overlay": "",
    "data-omnyo-plugin-root": "",
    ...(pluginId !== undefined ? { "data-omnyo-plugin": pluginId } : {}),
  };
}
