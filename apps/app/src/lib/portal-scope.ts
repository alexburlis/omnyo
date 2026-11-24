import { useContext } from "react";
import { PluginContext } from "@/components/plugin/plugin-context";

export function usePortalScopeProps(): {
  "data-omnyo-portaled-overlay": "";
  "data-omnyo-plugin-root"?: "";
  "data-omnyo-plugin"?: string;
} {
  const pluginId = useContext(PluginContext);

  return pluginId === null
    ? { "data-omnyo-portaled-overlay": "" }
    : {
        "data-omnyo-portaled-overlay": "",
        "data-omnyo-plugin-root": "",
        "data-omnyo-plugin": pluginId,
      };
}
