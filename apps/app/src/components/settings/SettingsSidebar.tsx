import { type MouseEvent as ReactMouseEvent } from "react";
import { cn } from "@omnyo/shared-ui/lib/utils";
import { PluginIcon } from "@/components/plugin/PluginIcon";
import {
  SectionSidebar,
  SectionSidebarIcon,
  SectionSidebarLabel,
  SectionSidebarActionRow,
  SectionSidebarRow,
} from "@/components/sidebar/SectionSidebar";
import { canOpenNativeScreen, shellOpenNative } from "@/lib/native-shell";
import { getPluginConfigurationRoutePath } from "@/lib/route-paths";
import { useSettingsNavState } from "./settings-nav";
import type { SettingsNavState } from "./settings-nav";
import { getSettingsRouteIntent } from "@/views/settings-view-split";
import {
  getSettingsSectionRoutePath,
  type SettingsNavSection,
} from "./settings-sections";

interface SettingsSidebarProps {
  onResizeMouseDown: (event: ReactMouseEvent<HTMLDivElement>) => void;
  isResizing: boolean;
}

type SettingsSidebarNavigation = Pick<
  SettingsNavState,
  "activePluginId" | "activeSection" | "pluginEntries" | "sections"
>;

interface SettingsSidebarContentProps extends SettingsSidebarProps {
  navigation: SettingsSidebarNavigation;
  testIdPrefix?: string;
}

export function SettingsSidebarContent({
  onResizeMouseDown,
  isResizing,
  navigation,
  testIdPrefix = "settings",
}: SettingsSidebarContentProps) {
  const { activePluginId, activeSection, pluginEntries, sections } = navigation;
  const archivedSection = sections.find((section) => section.id === "archived");

  const renderSection = (section: SettingsNavSection) => {
    const to = getSettingsSectionRoutePath(section.id);

    return (
      <SectionSidebarRow
        key={section.id}
        active={activeSection === section.id}
        label={section.label}
        to={to}
        intent={getSettingsRouteIntent(to)}
      >
        <SectionSidebarIcon name={section.icon} />
      </SectionSidebarRow>
    );
  };

  const hasPlugins = pluginEntries.length > 0;
  const showsPhone = canOpenNativeScreen();

  return (
    <SectionSidebar
      isResizing={isResizing}
      onResizeMouseDown={onResizeMouseDown}
      testIdPrefix={testIdPrefix}
    >
      {showsPhone ? (
        <>
          <div className="mt-1">
            <SectionSidebarLabel>This phone</SectionSidebarLabel>
          </div>
          <div className="mt-1 space-y-0.5">
            <SectionSidebarActionRow
              label="Servers and phone settings"
              testId="settings-nav-native-device"
              onClick={() => shellOpenNative("device-settings")}
            >
              <SectionSidebarIcon name="Smartphone" />
            </SectionSidebarActionRow>
          </div>
        </>
      ) : null}
      <div className={cn("space-y-0.5", showsPhone ? "mt-4" : "mt-1")}>
        {sections
          .filter((section) => section !== archivedSection)
          .map(renderSection)}
      </div>
      {hasPlugins ? (
        <>
          <div className="mt-4">
            <SectionSidebarLabel>Plugins</SectionSidebarLabel>
          </div>
          <div className="mt-1 space-y-0.5">
            {pluginEntries.map((entry) => {
              const to = getPluginConfigurationRoutePath({
                pluginId: entry.id,
              });

              return (
                <SectionSidebarRow
                  key={entry.id}
                  active={activePluginId === entry.id}
                  label={entry.label}
                  to={to}
                  intent={getSettingsRouteIntent(to)}
                >
                  <PluginIcon
                    pluginId={entry.id}
                    icon={entry.icon}
                    className="size-4 shrink-0"
                  />
                </SectionSidebarRow>
              );
            })}
          </div>
        </>
      ) : null}
      {archivedSection !== undefined ? (
        <>
          <div className="mt-4">
            <SectionSidebarLabel>Archived</SectionSidebarLabel>
          </div>
          <div className="mt-1 space-y-0.5">
            {renderSection(archivedSection)}
          </div>
        </>
      ) : null}
    </SectionSidebar>
  );
}

export function SettingsSidebar({
  onResizeMouseDown,
  isResizing,
}: SettingsSidebarProps) {
  const navigation = useSettingsNavState();

  return (
    <SettingsSidebarContent
      isResizing={isResizing}
      navigation={navigation}
      onResizeMouseDown={onResizeMouseDown}
    />
  );
}
