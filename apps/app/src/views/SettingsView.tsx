import "@omnyo/shared-ui/icon-extended";
import { defaultAppSettings } from "@omnyo/domain";
import { MobileAppSection } from "@/components/settings/MobileAppSection";
import { MachineEnvironmentSettings } from "@/components/settings/MachineEnvironmentSettings";
import { MachineAccessSettings } from "@/components/settings/MachineAccessSettings";
import { ProvidersSettingsSection } from "@/components/settings/ProvidersSettingsSection";
import { AppearanceSettingsPage } from "@/components/settings/AppearanceSettingsPage";
import { GeneralSettingsPage } from "@/components/settings/GeneralSettingsPage";
import { FilesSettingsPage } from "@/components/settings/FilesSettingsPage";
import { UpdatesSettingsSection } from "@/components/settings/UpdatesSettingsSection";
import { KeyboardSettingsSection } from "@/components/settings/KeyboardSettingsSection";
import { BrowserSettingsSection } from "@/components/settings/BrowserSettingsSection";
import { MachinesSettingsSection } from "@/components/settings/MachinesSettingsSection";
import { ProjectsSettingsSection } from "@/components/settings/ProjectsSettingsSection";
import { ArchivedThreadsSettingsSection } from "@/components/settings/ArchivedThreadsSettingsSection";
import { MarketplacesSettingsSection } from "@/components/settings/MarketplacesSettingsSection";
import { useUpdateGeneralSettings } from "@/hooks/mutations/settings-mutations";
import { useSystemConfig } from "@/hooks/queries/system-queries";
import type { CoreSettingsSectionId } from "@/components/settings/settings-route";

function ProvidersSettingsPage() {
  const systemConfigQuery = useSystemConfig();
  const updateGeneralSettingsMutation = useUpdateGeneralSettings();

  return (
    <ProvidersSettingsSection
      disabled={
        systemConfigQuery.data === undefined ||
        updateGeneralSettingsMutation.isPending
      }
      generalSettings={
        systemConfigQuery.data?.generalSettings ?? defaultAppSettings
      }
      onGeneralSettingsChange={updateGeneralSettingsMutation.mutateAsync}
    />
  );
}

function MachinesSettingsPage() {
  return (
    <>
      <MachinesSettingsSection />
      <MachineAccessSettings />
    </>
  );
}

const pages = {
  general: GeneralSettingsPage,
  appearance: AppearanceSettingsPage,
  providers: ProvidersSettingsPage,
  keyboard: KeyboardSettingsSection,
  browser: BrowserSettingsSection,
  files: FilesSettingsPage,
  projects: ProjectsSettingsSection,
  machines: MachinesSettingsPage,
  "environment-variables": MachineEnvironmentSettings,
  updates: UpdatesSettingsSection,
  mobile: MobileAppSection,
  marketplaces: MarketplacesSettingsSection,
  archived: ArchivedThreadsSettingsSection,
} satisfies Record<CoreSettingsSectionId, React.ComponentType>;

export function SettingsView({ section }: { section: CoreSettingsSectionId }) {
  const Page = pages[section];

  return <Page />;
}
