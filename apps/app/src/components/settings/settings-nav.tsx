import { useMemo } from "react";
import { useLocation } from "react-router-dom";
import { useHostDaemon, useLocalHostDaemonAccess } from "@/hooks/useHostDaemon";
import { usePluginSlots, type PluginFileOpenerSlot } from "@/lib/plugin-slots";
import { usePluginList } from "@/hooks/queries/plugin-settings-queries";
import { resolveSettingsRoute } from "./settings-route";
import {
  SETTINGS_NAV_SECTIONS,
  type SettingsNavSection,
  type SettingsSectionId,
} from "./settings-sections";
import {
  buildPluginSettingsEntries,
  type PluginSettingsEntry,
} from "./plugin-settings-entries";

export interface SettingsNavState {
  activeSection: SettingsSectionId | null;
  activePluginId: string | null;
  pluginEntries: readonly PluginSettingsEntry[];
  sections: readonly SettingsNavSection[];
}

export function useSettingsNavSections(
  fileOpeners: readonly PluginFileOpenerSlot[],
): readonly SettingsNavSection[] {
  const { hasDaemon } = useHostDaemon();
  const { accessState } = useLocalHostDaemonAccess();

  return useMemo(
    () =>
      SETTINGS_NAV_SECTIONS.filter(
        (section) =>
          section.id !== "files" ||
          hasDaemon ||
          accessState !== "unavailable" ||
          fileOpeners.length > 0,
      ),
    [accessState, fileOpeners.length, hasDaemon],
  );
}

export function useSettingsNavState(): SettingsNavState {
  const location = useLocation();
  const { fileOpeners, settingsSections } = usePluginSlots();
  const sections = useSettingsNavSections(fileOpeners);
  const pluginListQuery = usePluginList({ enabled: true });

  const route = resolveSettingsRoute(location);
  const activePluginId = route?.kind === "plugin" ? route.pluginId : null;
  let activeSection: SettingsSectionId | null;

  switch (route?.kind) {
    case "core":
      activeSection = route.section;
      break;
    case "installed":
    case "installed-detail":
      activeSection = "plugins";
      break;
    case "machine":
      activeSection = "machines";
      break;
    case "project":
      activeSection = "projects";
      break;
    case "plugin":
      activeSection = null;
      break;
    default:
      activeSection = "general";
  }

  const installedPlugins = pluginListQuery.data?.plugins;

  const pluginEntries = useMemo(
    () =>
      buildPluginSettingsEntries({
        installedPlugins: installedPlugins ?? [],
        settingsSections,
      }),
    [installedPlugins, settingsSections],
  );

  return {
    activePluginId,
    activeSection,
    pluginEntries,
    sections,
  };
}
