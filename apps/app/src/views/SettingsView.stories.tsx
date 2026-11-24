import { MobileAppSection } from "@/components/settings/MobileAppSection";
import { CliSkillsSettingsSectionContent } from "@/components/settings/CliSkillsSettingsSection";
import { useEffect, useRef, useState } from "react";
import { createStore, Provider as JotaiProvider } from "jotai";
import { Route, Routes, useNavigate } from "react-router-dom";
import {
  defaultAppTheme,
  type AppTheme,
  defaultAppSettings,
  type AppSettings,
} from "@omnyo/domain";
import type {
  WorkspaceOpenTarget,
  WorkspaceOpenTargetId,
} from "@omnyo/host-daemon-contract";
import { VoiceInputSettingsSectionContent } from "@/components/settings/VoiceInputSettingsSection";
import { ArchivedThreadsSettingsSection } from "@/components/settings/ArchivedThreadsSettingsSection";
import { KeyboardSettingsSection } from "@/components/settings/KeyboardSettingsSection";
import { MarketplacesSettingsSection } from "@/components/settings/MarketplacesSettingsSection";
import { MachineEnvironmentSettings } from "@/components/settings/MachineEnvironmentSettings";
import { MachinesSettingsSection } from "@/components/settings/MachinesSettingsSection";
import { ProjectsSettingsSection } from "@/components/settings/ProjectsSettingsSection";
import {
  SettingsStoryChrome,
  type SettingsStoryRoute,
  useSettingsStoryRoute,
} from "../../.ladle/story-settings-chrome";
import {
  SETTINGS_STORY_HIDDEN_MODELS,
  SETTINGS_STORY_MODEL_PICKER_FAVORITES,
  SettingsStoryFixtures,
  SettingsUpdatesStory,
} from "../../.ladle/settings-story-fixtures";
import {
  modelPickerFavoritesAtom,
  modelPickerHiddenModelsAtom,
} from "@/components/pickers/modelPickerPreferences";
import type { ThemePreference } from "@/hooks/useTheme";
import type { AudioInputDeviceOption } from "@/hooks/useAudioInputDevices";
import { useAudioInputDevicePreferenceValue } from "@/lib/audio-input-device-preference";
import {
  SETTINGS_MACHINE_ROUTE_PATH,
  SETTINGS_PROJECT_ROUTE_PATH,
} from "@/lib/route-paths";
import { AppearanceSettingsSection } from "@/components/settings/AppearanceSettingsPage";
import {
  PrivacySettingsSection,
  GeneralSettingsSection,
} from "@/components/settings/GeneralSettingsPage";
import {
  LocalOpenTargetSettingsSection,
  type LocalOpenTargetSettingsSectionProps,
} from "@/components/settings/FilesSettingsPage";
import { MachineSettingsView } from "./MachineSettingsView";
import { ProjectDetailSettingsView } from "./ProjectDetailSettingsView";
import { ProvidersSettingsSection } from "@/components/settings/ProvidersSettingsSection";

export default {
  title: "settings/Settings",
};

type StoredTargetId = LocalOpenTargetSettingsSectionProps["directoryTargetId"];

const audioInputDevices: AudioInputDeviceOption[] = [
  { deviceId: "macbook-mic", label: "MacBook Pro Microphone" },
  { deviceId: "studio-mic", label: "Studio Display Microphone" },
];

const vscodeTarget: WorkspaceOpenTarget = {
  capabilities: {
    openDirectory: true,
    openFile: true,
    openFileAtLine: true,
  },
  id: "vscode",
  label: "VS Code",
};

const finderTarget: WorkspaceOpenTarget = {
  capabilities: {
    openDirectory: true,
    openFile: false,
    openFileAtLine: false,
  },
  id: "finder",
  label: "Finder",
};

const terminalTarget: WorkspaceOpenTarget = {
  capabilities: {
    openDirectory: true,
    openFile: false,
    openFileAtLine: false,
  },
  id: "terminal",
  label: "Terminal",
};

const defaultAppTarget: WorkspaceOpenTarget = {
  capabilities: {
    openDirectory: true,
    openFile: true,
    openFileAtLine: false,
  },
  id: "default-app",
  label: "Default App",
};

const connectedTargets: WorkspaceOpenTarget[] = [
  vscodeTarget,
  finderTarget,
  terminalTarget,
  defaultAppTarget,
];

function useSettingsStoryState() {
  const [themePreference, setThemePreference] =
    useState<ThemePreference>("system");

  const [appearance, setAppearance] = useState<AppTheme>({
    ...defaultAppTheme,
    faviconColor: "red",
  });

  const [navigateToThreadAfterCreate, setNavigateToThreadAfterCreate] =
    useState(false);

  const [openLinksInAppBrowser, setOpenLinksInAppBrowser] = useState(false);
  const [rewriteLocalhostLinks, setRewriteLocalhostLinks] = useState(true);

  const [directoryTargetId, setDirectoryTargetId] =
    useState<StoredTargetId>("finder");

  const [fileTargetId, setFileTargetId] =
    useState<StoredTargetId>("default-app");

  return {
    appearance,
    directoryTargetId,
    fileTargetId,
    navigateToThreadAfterCreate,
    openLinksInAppBrowser,
    rewriteLocalhostLinks,
    setAppearance,
    setDirectoryTargetId,
    setFileTargetId,
    setNavigateToThreadAfterCreate,
    setOpenLinksInAppBrowser,
    setRewriteLocalhostLinks,
    setThemePreference,
    themePreference,
  };
}

function VoiceInputStory() {
  const preferredDeviceId = useAudioInputDevicePreferenceValue();

  return (
    <VoiceInputSettingsSectionContent
      devices={audioInputDevices}
      errorMessage={null}
      isLoading={false}
      isSupported={true}
      onRefresh={() => undefined}
      preferredDeviceId={preferredDeviceId}
    />
  );
}

function GeneralSettingsStory({
  desktopBrowserAvailable = false,
}: {
  desktopBrowserAvailable?: boolean;
}) {
  const state = useSettingsStoryState();

  const [settings, setSettings] = useState({
    ...defaultAppSettings,
    showGitChanges: true,
    confirmThreadArchive: true,
    keepHistoryAfterContextClear: false,
    compactExpiredCache: true,
    steerActiveThreadOnEnter: false,
    streamerMode: false,
    telemetryEnabled: true,
    crashReportsEnabled: true,
    showDiagnosticEvents: false,
  });

  function updateSettings(patch: Partial<AppSettings>) {
    setSettings((current) => ({ ...current, ...patch }));
  }

  return (
    <>
      <GeneralSettingsSection
        settings={settings}
        disabled={false}
        onSettingsChange={updateSettings}
        desktopBrowserAvailable={desktopBrowserAvailable}
        onManagedBranchPrefixChange={(managedBranchPrefix) =>
          updateSettings({ managedBranchPrefix })
        }
        navigateToThreadAfterCreate={state.navigateToThreadAfterCreate}
        onNavigateToThreadAfterCreateChange={
          state.setNavigateToThreadAfterCreate
        }
        openLinksInAppBrowser={state.openLinksInAppBrowser}
        onOpenLinksInAppBrowserChange={state.setOpenLinksInAppBrowser}
        rewriteLocalhostLinks={state.rewriteLocalhostLinks}
        onRewriteLocalhostLinksChange={state.setRewriteLocalhostLinks}
      />
      <CliSkillsSettingsSectionContent
        hasConnectedMachine={false}
        onOpenPicker={() => {}}
        pending={false}
        statusBadge={null}
      />
      <VoiceInputStory />
      <PrivacySettingsSection
        settings={settings}
        disabled={false}
        onSettingsChange={updateSettings}
      />
    </>
  );
}

function AppearanceSettingsStory() {
  const state = useSettingsStoryState();

  return (
    <AppearanceSettingsSection
      appearance={state.appearance}
      appearanceDisabled={false}
      customThemes={["Monochrome Lab", "Low Contrast"]}
      pluginThemes={[]}
      faviconColor={state.appearance.faviconColor}
      onAppearanceThemeChange={(themeId) =>
        state.setAppearance((current) => ({ ...current, themeId }))
      }
      onAppearanceThemePrefetch={() => undefined}
      onAppearanceThemePreview={() => undefined}
      onCreatePalette={() => undefined}
      onFaviconColorChange={(faviconColor) =>
        state.setAppearance((current) => ({ ...current, faviconColor }))
      }
      onThemePreferenceChange={state.setThemePreference}
      themePreference={state.themePreference}
    />
  );
}

function FilePreferencesStory() {
  const state = useSettingsStoryState();

  function handleDirectoryTargetChange(targetId: WorkspaceOpenTargetId): void {
    state.setDirectoryTargetId(targetId);
  }

  function handleFileTargetChange(targetId: WorkspaceOpenTargetId): void {
    state.setFileTargetId(targetId);
  }

  return (
    <LocalOpenTargetSettingsSection
      accessState="available"
      directoryTargetId={state.directoryTargetId}
      fileTargetId={state.fileTargetId}
      hasDaemon={true}
      onDirectoryTargetChange={handleDirectoryTargetChange}
      onFileTargetChange={handleFileTargetChange}
      onRequestAccess={async () => true}
      targets={connectedTargets}
    />
  );
}

function ProvidersSettingsStory() {
  const [generalSettings, setGeneralSettings] =
    useState<AppSettings>(defaultAppSettings);

  const [store] = useState(() => {
    const providersStore = createStore();
    providersStore.set(
      modelPickerFavoritesAtom,
      SETTINGS_STORY_MODEL_PICKER_FAVORITES,
    );
    providersStore.set(
      modelPickerHiddenModelsAtom,
      SETTINGS_STORY_HIDDEN_MODELS,
    );

    return providersStore;
  });

  return (
    <JotaiProvider store={store}>
      <ProvidersSettingsSection
        disabled={false}
        generalSettings={generalSettings}
        onGeneralSettingsChange={(patch) =>
          setGeneralSettings((current) => ({ ...current, ...patch }))
        }
      />
    </JotaiProvider>
  );
}

function SettingsStoryContent({ route }: { route: SettingsStoryRoute }) {
  if (route.kind === "machine") {
    return (
      <Routes>
        <Route
          path={SETTINGS_MACHINE_ROUTE_PATH}
          element={<MachineSettingsView />}
        />
      </Routes>
    );
  }

  if (route.kind === "project") {
    return (
      <Routes>
        <Route
          path={SETTINGS_PROJECT_ROUTE_PATH}
          element={<ProjectDetailSettingsView />}
        />
      </Routes>
    );
  }

  switch (route.id) {
    case "providers":
      return <ProvidersSettingsStory />;
    case "appearance":
      return <AppearanceSettingsStory />;
    case "keyboard":
      return <KeyboardSettingsSection />;
    case "files":
      return <FilePreferencesStory />;
    case "projects":
      return <ProjectsSettingsSection />;
    case "machines":
      return <MachinesSettingsSection />;
    case "environment-variables":
      return <MachineEnvironmentSettings />;
    case "updates":
      return <SettingsUpdatesStory />;
    case "mobile":
      return <MobileAppSection />;
    case "marketplaces":
      return <MarketplacesSettingsSection />;
    case "archived":
      return <ArchivedThreadsSettingsSection />;
    case "general":
      return (
        <>
          <GeneralSettingsStory desktopBrowserAvailable />
        </>
      );
  }
}

export function FullPage() {
  const navigate = useNavigate();
  const route = useSettingsStoryRoute();
  const initializedFromStoryPath = useRef(false);
  useEffect(() => {
    if (initializedFromStoryPath.current) return;
    initializedFromStoryPath.current = true;

    const storyPath =
      new URLSearchParams(window.location.hash.slice(1)).get("settingsPath") ??
      new URLSearchParams(window.location.search).get("settingsPath");

    if (storyPath?.startsWith("/settings") === true) {
      navigate(storyPath, { replace: true });
    }
  }, [navigate]);

  return (
    <SettingsStoryFixtures>
      <SettingsStoryChrome contentOwnsPageShell={route.kind !== "section"}>
        <SettingsStoryContent route={route} />
      </SettingsStoryChrome>
    </SettingsStoryFixtures>
  );
}
