import { nativeApplicationVersion, nativeBuildVersion } from "expo-application";
import { Stack, useRouter } from "expo-router";
import { useProfiles, useRealtimeConnectionState } from "@/app-shell";
import { describeServerConnection } from "@/lib/connection";
import type { ServerProfile } from "@/lib/profiles";
import { sendShellCommand } from "@/lib/shell";
import {
  ActionSheet,
  GroupedRow,
  Text,
  confirmDestructive,
  toast,
  useSheet,
  type GroupedRowProps,
} from "@/ui";
import { GroupedScreen } from "./GroupedScreen";
import { HapticsSettingsRow } from "./HapticsSettingsRow";
import { LinkRow } from "./LinkRow";
import { settingsSectionHref } from "@/screens/shell/hrefs";
import { HeaderIconButton, SettingsSection } from "./SettingsRows";
import { useBadgeColors } from "./settings-badges";
import { ServerOptionsButton, useServerActions } from "./useServerActions";

const IS_IOS = process.env.EXPO_OS === "ios";

function modeLabel(profile: ServerProfile): string {
  return profile.mode === "connect" ? "Omnyo connect" : "Direct";
}

function serverAddress(serverUrl: string): string {
  return serverUrl.replace(/^https?:\/\//, "").replace(/\/$/, "");
}

export function DeviceSettingsScreen() {
  const router = useRouter();
  const colors = useBadgeColors();
  const clearDataSheet = useSheet();
  const servers = useServerActions();
  const { profiles, activeProfile, connection } = useProfiles();
  const realtime = useRealtimeConnectionState();

  const otherProfiles = profiles.filter(
    (profile) => profile.id !== activeProfile?.id,
  );

  const addServer = () => router.push("/settings/servers/add");

  const serverBadge = (profile: ServerProfile): GroupedRowProps["badge"] =>
    profile.mode === "connect"
      ? { icon: "Globe", color: colors.blue }
      : { icon: "Laptop", color: colors.gray };

  const optionsButton = (profile: ServerProfile) => (
    <ServerOptionsButton
      label={profile.label}
      onPress={() => servers.openOptions(profile)}
      testID={`server-options-${profile.id}`}
    />
  );

  const clearWebsiteData = () => {
    if (!sendShellCommand({ kind: "clear-website-data" })) {
      toast.info("Open the web interface first");
    }
  };

  const clearDataMessage =
    "The cached page and this device's session cookie are removed, then the page reloads. Your servers and pairing stay.";

  const version = nativeApplicationVersion ?? "0.0.0";
  const build = nativeBuildVersion ?? "dev";

  const connectionValue =
    activeProfile === null
      ? null
      : describeServerConnection({
          profileId: activeProfile.id,
          connection,
          realtime,
        });

  return (
    <>
      {IS_IOS ? (
        <Stack.Toolbar placement="right">
          <Stack.Toolbar.Button
            icon="plus"
            accessibilityLabel="Add server"
            onPress={addServer}
          />
        </Stack.Toolbar>
      ) : (
        <Stack.Screen
          options={{
            headerRight: () => (
              <HeaderIconButton
                icon="Plus"
                accessibilityLabel="Add server"
                onPress={addServer}
                testID="servers-add"
              />
            ),
          }}
        />
      )}
      <GroupedScreen testID="device-settings-screen">
        {activeProfile !== null && connectionValue !== null ? (
          <SettingsSection
            title="Current server"
            footnote="Reload or clear cached data if the app gets stuck. Your saved servers stay paired."
          >
            <GroupedRow
              title={activeProfile.label}
              subtitle={`${modeLabel(activeProfile)} · ${serverAddress(activeProfile.serverUrl)}`}
              badge={serverBadge(activeProfile)}
              value={connectionValue}
              selected
              accessibilityLabel={`${activeProfile.label}, current server, ${connectionValue}, ${modeLabel(activeProfile)}, ${serverAddress(activeProfile.serverUrl)}`}
              trailing={optionsButton(activeProfile)}
              onPress={() => servers.openOptions(activeProfile)}
              {...servers.rowActions(activeProfile)}
              testID={`server-row-${activeProfile.id}`}
            />
            <GroupedRow
              title="Reload the page"
              badge={{
                icon: "RotateCcw",
                symbol: "arrow.clockwise",
                color: colors.gray,
              }}
              onPress={() => {
                const delivered = sendShellCommand({ kind: "reload" });
                toast[delivered ? "success" : "info"](
                  delivered ? "Reloading" : "Open the web interface first",
                );
              }}
              testID="device-reload-page"
            />
            <GroupedRow
              title="Clear website data"
              destructive
              badge={{ icon: "Trash2", symbol: "trash", color: colors.red }}
              onPress={() => {
                if (process.env.EXPO_OS === "ios") {
                  confirmDestructive({
                    title: "Clear website data?",
                    message: clearDataMessage,
                    actionLabel: "Clear",
                    onConfirm: clearWebsiteData,
                  });
                } else {
                  clearDataSheet.present();
                }
              }}
              testID="device-clear-website-data"
            />
          </SettingsSection>
        ) : null}

        <SettingsSection
          title={activeProfile === null ? "Servers" : "Other servers"}
          footnote={
            otherProfiles.length > 0
              ? IS_IOS
                ? "Tap a server to switch to it. Tap (i) to rename, sign in again or remove it."
                : "Tap a server to switch to it. Tap (i) to sign in again or remove it."
              : profiles.length === 0
                ? "No servers saved yet. Pair through Omnyo connect or enter a direct URL."
                : undefined
          }
          testID="servers-list"
        >
          {otherProfiles.map((profile) => (
            <GroupedRow
              key={profile.id}
              title={profile.label}
              subtitle={`${modeLabel(profile)} · ${serverAddress(profile.serverUrl)}`}
              badge={serverBadge(profile)}
              accessibilityLabel={`${profile.label}, ${modeLabel(profile)}, ${serverAddress(profile.serverUrl)}`}
              trailing={optionsButton(profile)}
              onPress={() => servers.switchTo(profile)}
              {...servers.rowActions(profile)}
              testID={`server-row-${profile.id}`}
            />
          ))}
          <GroupedRow
            title="Add server"
            badge={{ icon: "Plus", color: colors.green }}
            onPress={addServer}
            testID="servers-add-row"
          />
        </SettingsSection>

        <SettingsSection
          title="This phone"
          footnote="Preferences for this phone."
        >
          <HapticsSettingsRow />
          <LinkRow
            title="Appearance"
            badge={{
              icon: "Palette",
              symbol: "paintpalette",
              color: colors.gray,
            }}
            href={settingsSectionHref("appearance")}
            testID="device-appearance"
          />
          <LinkRow
            title="Notifications"
            badge={{ icon: "Bell", symbol: "bell.badge", color: colors.red }}
            href={settingsSectionHref("notifications")}
            testID="device-notifications"
          />
        </SettingsSection>

        <SettingsSection title="About">
          <GroupedRow
            title="Version"
            trailing={
              <Text className="text-sm text-muted-foreground">
                {version} ({build})
              </Text>
            }
            testID="device-version"
          />
        </SettingsSection>
      </GroupedScreen>
      {servers.sheet}
      {process.env.EXPO_OS !== "ios" ? (
        <ActionSheet
          controller={clearDataSheet}
          presentation="prompt"
          title="Clear website data?"
          message={clearDataMessage}
          actions={[
            {
              key: "clear",
              label: "Clear website data",
              icon: "Trash2",
              destructive: true,
              onPress: clearWebsiteData,
            },
          ]}
        />
      ) : null}
    </>
  );
}
