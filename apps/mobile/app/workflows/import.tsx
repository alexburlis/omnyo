import { Stack, useLocalSearchParams, useRouter } from "expo-router";
import { useState } from "react";
import { useProfiles } from "@/app-shell";
import { waitForActiveConnection } from "@/app-shell/connector";
import { GroupedRow, Text, toast } from "@/ui";
import { GroupedScreen } from "@/screens/settings/GroupedScreen";
import { SettingsSection } from "@/screens/settings/SettingsRows";
import { webViewShellHref } from "@/screens/shell/hrefs";

export default function WorkflowImportRoute() {
  const { shareId } = useLocalSearchParams<{ shareId?: string }>();
  const { profiles, setActiveProfile } = useProfiles();
  const router = useRouter();
  const [selecting, setSelecting] = useState(false);

  const valid =
    typeof shareId === "string" && /^[A-Za-z0-9_-]{22,128}$/.test(shareId);

  async function select(profileId: string) {
    if (selecting || !valid) return;
    setSelecting(true);

    try {
      await setActiveProfile(profileId);

      if (!(await waitForActiveConnection(profileId))) {
        toast.error("Could not connect to this server. Try again.");

        return;
      }

      router.replace(
        webViewShellHref({
          profileId,
          path: `/plugins/automations/automations/import/${shareId}`,
        }),
      );
    } catch {
      toast.error("Could not connect to this server. Try again.");
    } finally {
      setSelecting(false);
    }
  }

  return (
    <GroupedScreen testID="workflow-import-server-picker">
      <Stack.Screen options={{ title: "Import workflow" }} />
      {!valid ? (
        <Text>This workflow link is invalid.</Text>
      ) : (
        <SettingsSection
          title="Choose a server"
          footnote="Review the workflow on the server you choose before saving it."
        >
          {profiles.map((profile) => (
            <GroupedRow
              key={profile.id}
              title={profile.label}
              subtitle={profile.serverUrl}
              onPress={() => {
                void select(profile.id);
              }}
              testID={`workflow-import-server-${profile.id}`}
            />
          ))}
          {profiles.length === 0 ? (
            <GroupedRow
              title="Add a server"
              onPress={() => router.push("/settings/servers/add")}
            />
          ) : null}
        </SettingsSection>
      )}
    </GroupedScreen>
  );
}
