import { matchRoutes } from "react-router-dom";
import {
  SETTINGS_MACHINE_ROUTE_PATH,
  SETTINGS_PLUGIN_ROUTE_PATH,
  SETTINGS_PROJECT_ROUTE_PATH,
  SETTINGS_ROUTE_PATH,
  SETTINGS_SECTION_ROUTE_PATH,
} from "@/lib/route-paths";
import {
  isSettingsSectionId,
  type SettingsSectionId,
} from "./settings-sections";

const settingsRoutes = [
  { path: SETTINGS_ROUTE_PATH, kind: "general" },
  { path: SETTINGS_SECTION_ROUTE_PATH, kind: "section" },
  { path: SETTINGS_PLUGIN_ROUTE_PATH, kind: "plugin" },
  { path: SETTINGS_MACHINE_ROUTE_PATH, kind: "machine" },
  { path: SETTINGS_PROJECT_ROUTE_PATH, kind: "project" },
] satisfies {
  path: string;
  kind: "general" | "section" | "plugin" | "machine" | "project";
}[];

export const settingsRoutePaths = settingsRoutes.map(({ path }) => path);

export type CoreSettingsSectionId = Exclude<SettingsSectionId, "plugins">;

type SettingsRoute =
  | { kind: "core"; section: CoreSettingsSectionId }
  | { kind: "installed" }
  | { kind: "installed-detail"; pluginId: string }
  | { kind: "plugin"; pluginId: string }
  | { kind: "machine" }
  | { kind: "project" }
  | { kind: "unknown" };

export function resolveSettingsRoute({
  pathname,
  search,
}: {
  pathname: string;
  search?: string;
}): SettingsRoute | null {
  const match = matchRoutes(settingsRoutes, pathname)?.[0];

  switch (match?.route.kind) {
    case "general":
      return { kind: "core", section: "general" };
    case "section": {
      const { section } = match.params;

      if (section !== undefined && isSettingsSectionId(section))
        return section === "plugins"
          ? { kind: "installed" }
          : { kind: "core", section };

      return { kind: "unknown" };
    }

    case "plugin": {
      const { pluginId } = match.params;

      if (pluginId === undefined) return { kind: "unknown" };

      return new URLSearchParams(search).get("view") === "installed"
        ? { kind: "installed-detail", pluginId }
        : { kind: "plugin", pluginId };
    }

    case "machine":
      return { kind: "machine" };
    case "project":
      return { kind: "project" };
    default:
      return null;
  }
}
