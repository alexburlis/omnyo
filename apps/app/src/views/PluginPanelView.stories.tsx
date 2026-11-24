import { markPluginFrontendsSettled } from "@/lib/plugin-frontend-boot-state";
import { PluginPanelView } from "./PluginPanelView";

export default {
  title: "views/Plugin panel",
};

export function Unavailable() {
  markPluginFrontendsSettled();

  return (
    <div className="flex h-[640px] flex-col p-4 md:p-5">
      <PluginPanelView
        pluginId="missing-plugin"
        panelPath="dashboard"
        subPath=""
      />
    </div>
  );
}
