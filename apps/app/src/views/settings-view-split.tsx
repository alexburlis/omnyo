import type { ReactNode } from "react";
import { Navigate, parsePath, useLocation } from "react-router-dom";
import { LazyPluginsOverview } from "@/components/plugin/PluginsOverviewSplit";
import { PageShell } from "@/components/ui/page-shell";
import { RouteLoadingSkeleton } from "@/components/ui/route-loading-skeleton";
import {
  resolveSettingsRoute,
  type CoreSettingsSectionId,
} from "@/components/settings/settings-route";
import { defineSplit } from "@/lib/define-split";
import { SETTINGS_ROUTE_PATH } from "@/lib/route-paths";
import { LazyPluginDetailPaneView } from "./ToolsViewSplits";

function SettingsLoading() {
  return <RouteLoadingSkeleton isBoundedPane={false} />;
}

const SettingsViewSplit = defineSplit<{ section: CoreSettingsSectionId }>({
  id: "settings-view",
  load: () =>
    import("./SettingsView").then(
      ({ SettingsView }) =>
        function CoreSettingsPage({
          section,
        }: {
          section: CoreSettingsSectionId;
        }) {
          return (
            <SettingsPage>
              <SettingsView section={section} />
            </SettingsPage>
          );
        },
    ),
  loading: SettingsLoading,
});

const PluginSettingsSplit = defineSplit<{ pluginId: string }>({
  id: "plugin-settings-view",
  load: () =>
    import("@/components/plugin/PluginSettings").then(
      ({ PluginSettingsPage }) =>
        function PluginConfigurationPage({ pluginId }: { pluginId: string }) {
          return (
            <SettingsPage>
              <PluginSettingsPage pluginId={pluginId} />
            </SettingsPage>
          );
        },
    ),
  loading: SettingsLoading,
});

const ProjectSettingsSplit = defineSplit({
  id: "project-settings-view",
  load: () =>
    import("./ProjectDetailSettingsView").then(
      (module) => module.ProjectDetailSettingsView,
    ),
  loading: SettingsLoading,
});

const MachineSettingsSplit = defineSplit({
  id: "machine-settings-view",
  load: () =>
    import("./MachineSettingsView").then(
      (module) => module.MachineSettingsView,
    ),
  loading: SettingsLoading,
});

const settingsSplits = {
  core: SettingsViewSplit,
  installed: LazyPluginsOverview,
  "installed-detail": LazyPluginDetailPaneView,
  plugin: PluginSettingsSplit,
  machine: MachineSettingsSplit,
  project: ProjectSettingsSplit,
};

export function preloadSettingsRoute(location: {
  pathname: string;
  search?: string;
}) {
  const route = resolveSettingsRoute(location);

  if (route !== null && route.kind !== "unknown")
    return settingsSplits[route.kind].preload();
}

export function getSettingsRouteIntent(to: string) {
  const preload = () => {
    const { pathname = "", search } = parsePath(to);

    void preloadSettingsRoute({ pathname, search });
  };

  return {
    onPointerEnter: preload,
    onFocus: preload,
    onPointerDown: preload,
  };
}

function SettingsPage({ children }: { children: ReactNode }) {
  return (
    <PageShell contentClassName="pt-4 md:pt-5">
      <div className="mx-auto w-full max-w-3xl space-y-10">{children}</div>
    </PageShell>
  );
}

export function SettingsRoute() {
  const route = resolveSettingsRoute(useLocation());

  switch (route?.kind) {
    case "core":
      return <SettingsViewSplit section={route.section} />;
    case "plugin":
      return <PluginSettingsSplit pluginId={route.pluginId} />;
    case "installed":
    case "installed-detail":
      return (
        <div className="-mx-4 -mt-4 flex min-h-0 flex-1 flex-col overflow-hidden md:-mx-5 md:-mt-5">
          {route.kind === "installed-detail" ? (
            <LazyPluginDetailPaneView pluginId={route.pluginId} />
          ) : (
            <div className="flex min-h-0 flex-1 flex-col pt-4 md:pt-5">
              <LazyPluginsOverview mode="installed" />
            </div>
          )}
        </div>
      );
    case "machine":
      return <MachineSettingsSplit />;
    case "project":
      return <ProjectSettingsSplit />;
    default:
      return <Navigate to={SETTINGS_ROUTE_PATH} replace />;
  }
}
