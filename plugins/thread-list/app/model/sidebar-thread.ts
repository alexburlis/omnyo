import type { PluginSidebarThread } from "@omnyo/plugin-sdk/app";

export type SidebarThread = PluginSidebarThread & {
  handoffGroupHeadId?: string;
};
