import { useHosts } from "@/hooks/queries/host-queries";
import { usePluginList } from "@/hooks/queries/plugin-settings-queries";
import { useSidebarNavigation } from "@/hooks/queries/sidebar-navigation-query";
import {
  useSystemConfig,
  useSystemProviderStates,
  useSystemProviders,
} from "@/hooks/queries/system-queries";
import {
  connectAccessUrl,
  onboardingPluginGroups,
  type OnboardingStepId,
} from "./onboarding-model";
import {
  OnboardingStage,
  type OnboardingStageAgent,
  type OnboardingStageAutomation,
  type OnboardingStagePlugin,
  type OnboardingStageProject,
} from "./OnboardingStage";

export interface OnboardingProjectDraft {
  id: string;
  name: string;
}

export function OnboardingStageContainer({
  step,
  hostId,
  hostName,
  projectDraft,
  browserConnected,
  scheduled,
  className,
}: {
  step: OnboardingStepId;
  hostId: string | null;
  hostName: string | null;
  projectDraft: readonly OnboardingProjectDraft[];
  browserConnected: boolean;
  scheduled: readonly OnboardingStageAutomation[];
  className?: string;
}) {
  const statesQuery = useSystemProviderStates({
    enabled: hostId !== null,
    poll: false,
    ...(hostId === null ? {} : { hostId }),
  });

  const providersQuery = useSystemProviders(
    hostId === null ? { enabled: false } : { hostId },
  );

  const navigation = useSidebarNavigation().data;
  const installed = usePluginList({ enabled: true }).data?.plugins;
  const serverAccess = useSystemConfig().data?.serverAccess;
  const hosts = useHosts().data;

  const agents: OnboardingStageAgent[] = (statesQuery.data?.providers ?? [])
    .filter((state) => state.status === "ready")
    .map((state) => ({
      id: state.providerId,
      name: state.displayName,
      provider: providersQuery.data?.find(
        (provider) => provider.id === state.providerId,
      ) ?? { id: state.providerId, logoUrl: null },
    }));

  const savedProjects: OnboardingStageProject[] = (
    navigation?.projects ?? []
  ).map((project) => ({
    id: project.id,
    name: project.name,
    chats: project.threads.map((thread) => ({
      id: thread.id,
      title: thread.title ?? thread.titleFallback ?? "New chat",
    })),
  }));

  const savedNames = new Set(savedProjects.map((project) => project.name));

  const projects = [
    ...savedProjects,
    ...projectDraft
      .filter((draft) => !savedNames.has(draft.name))
      .map((draft) => ({ id: draft.id, name: draft.name, chats: [] })),
  ];

  const plugins: OnboardingStagePlugin[] = onboardingPluginGroups(
    installed ?? [],
  ).flatMap((group) =>
    group.plugins
      .filter((plugin) => plugin.enabled)
      .map((plugin) => ({
        id: plugin.id,
        name: plugin.name ?? plugin.id,
        icon: plugin.icon,
      })),
  );

  return (
    <OnboardingStage
      step={step}
      machineName={hostName}
      agents={agents}
      projects={projects}
      browserConnected={browserConnected}
      plugins={plugins}
      scheduled={scheduled}
      remoteAccess={connectAccessUrl(serverAccess).status === "on"}
      otherMachineCount={
        (hosts ?? []).filter((host) => host.id !== hostId).length
      }
      className={className}
    />
  );
}
