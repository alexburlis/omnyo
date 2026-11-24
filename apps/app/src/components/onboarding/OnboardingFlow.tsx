import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import { z } from "zod";
import { getPluginPanelRoutePath } from "@/lib/route-paths";
import {
  findLocalPathProjectSourceForHost,
  isActiveTerminalSessionStatus,
} from "@omnyo/domain";
import type {
  TerminalOutputChunk,
  TerminalSession,
} from "@omnyo/server-contract";
import { useMediaQuery } from "@omnyo/shared-ui/hooks/use-media-query";
import { AddMachineDialog } from "@/components/dialogs/AddMachineDialog";
import { ProjectPathDialog } from "@/components/dialogs/ProjectPathDialog";
import { PluginSettingsSections } from "@/components/plugin/PluginSettingsSections";
import { useSetPluginEnabled } from "@/components/plugin/useSetPluginEnabled";
import {
  buildProviderCliIssue,
  hasProviderCliAction,
  useProviderCliInstallRunner,
} from "@/components/provider-cli/provider-cli-install";
import {
  openProviderCliInstallLog,
  providerCliJobKey,
} from "@/components/provider-cli/provider-cli-install-store";
import { ThreadTerminalView } from "@/components/thread/terminal/ThreadTerminalView";
import { appToast } from "@/components/ui/app-toast";
import { useCreateProject } from "@/hooks/mutations/project-mutations";
import {
  useHostDiscoveredRepos,
  useHosts,
  usePrimaryHost,
} from "@/hooks/queries/host-queries";
import { usePluginList } from "@/hooks/queries/plugin-settings-queries";
import { useSidebarNavigation } from "@/hooks/queries/sidebar-navigation-query";
import { terminalOutputTailQueryKey } from "@/hooks/queries/query-keys";
import {
  useHostProviderCliStatus,
  useSystemConfig,
  useSystemExecutionOptions,
  useSystemProviderStates,
  useSystemProviders,
} from "@/hooks/queries/system-queries";
import {
  useCloseTerminal,
  useCreateTerminal,
} from "@/hooks/queries/thread-terminal-queries";
import { useDesktopWindowState } from "@/hooks/useDesktopWindowState";
import { useHostDaemon } from "@/hooks/useHostDaemon";
import { useQuickCreateProjectController } from "@/hooks/useQuickCreateProject";
import {
  getOmnyoDesktopInfo,
  shouldReserveMacosTrafficLights,
} from "@/lib/omnyo-desktop";
import { decodeBase64Bytes } from "@/lib/base64-bytes";
import { copyToClipboardWithToast } from "@/lib/clipboard";
import { sdk } from "@/lib/sdk";
import { formatRelativeTime } from "@/lib/relative-time";
import { openUrlInExternalBrowser } from "@/lib/url-open-routing";
import {
  AgentSignInGuide,
  AgentStep,
  AutomationsStep,
  DevicesStep,
  OnboardingLayout,
  OnboardingPluginSections,
  ProjectsStep,
  type OnboardingAgent,
  type OnboardingRepo,
  type OnboardingStepChrome as StepChrome,
} from "./OnboardingViews";
import {
  ONBOARDING_PROVIDERS,
  detectedOnboardingProviders,
  initialOnboardingProviderSelected,
  matchesOnboardingProvider,
  onboardingProviderChanges,
  onboardingProviderEnabled,
  type OnboardingProviderId,
} from "./provider-selection";
import {
  OnboardingBrowserStep,
  browserLoginApi,
} from "./OnboardingBrowserStep";
import {
  AUTOMATIONS_PLUGIN_ID,
  CHAT_IMPORTER_PLUGIN_ID,
  CONNECT_PLUGIN_ID,
  ONBOARDING_STARTERS,
  SENTRY_MANIFEST_FILES,
  SENTRY_PLUGIN_ID,
  starterAutomationInput,
  usesSentrySdk,
  type OnboardingStarterId,
  adjacentOnboardingStep,
  connectAccessUrl,
  defaultSelectedRepoPaths,
  hasReadyAgent,
  onboardingPluginGroups,
  onboardingSteps,
  parseSignInOutput,
  resolveAgentSetupState,
  resolveSignInCommand,
  shortRemoteName,
  type OnboardingStepId,
} from "./onboarding-model";
import {
  recordTelemetryEvent,
  type OnboardingEntry,
} from "./onboarding-telemetry";
import { OnboardingIntro } from "./OnboardingIntro";
import { RecommendedSkillsStep } from "./RecommendedSkillsStep";
import {
  OnboardingStageContainer,
  type OnboardingProjectDraft,
} from "./OnboardingStageContainer";
import { useLeaveOnNavigation } from "./useLeaveOnNavigation";

const SIGN_IN_POLL_INTERVAL_MS = 3_000;

const SIGN_IN_TERMINAL_COLS = 200;

const SIGN_IN_TERMINAL_ROWS = 14;

const SIGN_IN_OUTPUT_POLL_INTERVAL_MS = 1_000;

const SIGN_IN_OUTPUT_TAIL_BYTES = 64 * 1024;

const SIGN_IN_TERMINAL_FALLBACK_DELAY_MS = 6_000;

const INSTALL_FAILED_MESSAGE = "Install failed";

function decodeTerminalChunks(chunks: readonly TerminalOutputChunk[]): string {
  const decoder = new TextDecoder();

  return chunks
    .map((chunk) =>
      decoder.decode(decodeBase64Bytes(chunk.dataBase64), { stream: true }),
    )
    .join("");
}

function encodeTerminalInput(text: string): string {
  return btoa(
    Array.from(new TextEncoder().encode(text), (byte) =>
      String.fromCharCode(byte),
    ).join(""),
  );
}

function AgentSignInContainer({
  agentName,
  session,
  alternate,
  onUseAlternate,
  onExit,
}: {
  agentName: string;
  session: TerminalSession;
  alternate: { label: string; method: SignInMethod } | null;
  onUseAlternate: (method: SignInMethod) => void;
  onExit: (exitCode: number | null) => void;
}) {
  const outputQuery = useQuery({
    queryKey: terminalOutputTailQueryKey(session.id),
    queryFn: ({ signal }) =>
      sdk.terminals.output({
        terminalId: session.id,
        tailBytes: SIGN_IN_OUTPUT_TAIL_BYTES,
        signal,
      }),
    refetchInterval: SIGN_IN_OUTPUT_POLL_INTERVAL_MS,
    gcTime: 0,
    retry: false,
  });

  const output = outputQuery.data;

  const guide = useMemo(
    () =>
      output === undefined
        ? null
        : parseSignInOutput(decodeTerminalChunks(output.chunks)),
    [output],
  );

  const [code, setCode] = useState("");
  const [codeSubmitted, setCodeSubmitted] = useState(false);
  const [terminalChoice, setTerminalChoice] = useState<boolean | null>(null);
  const [fallbackDue, setFallbackDue] = useState(false);
  useEffect(() => {
    const timer = window.setTimeout(
      () => setFallbackDue(true),
      SIGN_IN_TERMINAL_FALLBACK_DELAY_MS,
    );

    return () => window.clearTimeout(timer);
  }, []);

  const terminalVisible =
    terminalChoice ?? (fallbackDue && (guide === null || guide.url === null));

  const exited =
    output !== undefined && !isActiveTerminalSessionStatus(output.status);

  const exitCode = output?.exitCode ?? null;
  useEffect(() => {
    if (exited) onExit(exitCode);
  }, [exitCode, exited, onExit]);

  const submitCode = () => {
    const trimmed = code.trim();

    if (trimmed.length === 0) return;
    setCodeSubmitted(true);
    sdk.terminals
      .input({
        terminalId: session.id,
        dataBase64: encodeTerminalInput(`${trimmed}\r`),
      })
      .catch(() => {
        setCodeSubmitted(false);
        appToast.error("Couldn't send the code. Try again.");
      });
  };

  return (
    <AgentSignInGuide
      agentName={agentName}
      guide={guide}
      code={code}
      codeSubmitted={codeSubmitted}
      terminalVisible={terminalVisible}
      terminal={
        <ThreadTerminalView autoFocus={false} isPanelOpen session={session} />
      }
      onCodeChange={(next) => {
        setCode(next);
        setCodeSubmitted(false);
      }}
      onSubmitCode={submitCode}
      onOpenUrl={openUrlInExternalBrowser}
      onCopy={(text) => void copyToClipboardWithToast(text)}
      onToggleTerminal={() => setTerminalChoice(!terminalVisible)}
      alternateLabel={alternate?.label ?? null}
      onUseAlternate={() => {
        if (alternate !== null) onUseAlternate(alternate.method);
      }}
    />
  );
}

async function closeAbandonedSignInTerminals({
  hostId,
  title,
}: {
  hostId: string;
  title: string;
}): Promise<void> {
  const listing = await sdk.terminals
    .list({ scope: { kind: "host_path", hostId } })
    .catch(() => null);

  const abandoned = (listing?.sessions ?? []).filter(
    (session) =>
      session.title === title && isActiveTerminalSessionStatus(session.status),
  );

  await Promise.all(
    abandoned.map((session) =>
      sdk.terminals
        .close({ mode: "force", terminalId: session.id })
        .catch(() => null),
    ),
  );
}

type SignInMethod = "local" | "remote";

interface SignInSession {
  providerId: string;
  session: TerminalSession;
  method: SignInMethod;
  hasAlternateMethod: boolean;
}

function AgentStepContainer({
  chrome,
  entry,
  hostId,
  hostName,
  providerSelection,
  onProviderSelectionChange,
  onContinue,
}: {
  chrome: StepChrome;
  entry: OnboardingEntry;
  hostId: string | null;
  hostName: string | null;
  providerSelection: Partial<Record<OnboardingProviderId, boolean>>;
  onProviderSelectionChange: (
    id: OnboardingProviderId,
    enabled: boolean,
  ) => void;
  onContinue: (ready: boolean) => void;
}) {
  const statesQuery = useSystemProviderStates({
    enabled: hostId !== null,
    ...(hostId === null ? {} : { hostId }),
  });

  const providersQuery = useSystemProviders(
    hostId === null ? { enabled: false } : { hostId },
  );

  const cliStatusQuery = useHostProviderCliStatus({ hostId });
  const pluginListQuery = usePluginList({ enabled: true });
  const setPluginEnabled = useSetPluginEnabled();
  const [savingProviders, setSavingProviders] = useState(false);
  const [setupApplied, setSetupApplied] = useState(false);

  const detectionQuery = useQuery({
    queryKey: ["onboarding-provider-detection", hostId],
    enabled: hostId !== null,
    queryFn: ({ signal }) => {
      if (hostId === null) throw new Error("A connected computer is required.");

      return sdk.hosts.detectProviderClis({ hostId, signal });
    },
    retry: false,
  });

  const installRunner = useProviderCliInstallRunner();
  const { isLocalDaemonHost } = useHostDaemon();
  const createTerminal = useCreateTerminal();
  const closeTerminal = useCloseTerminal();
  const [signIn, setSignIn] = useState<SignInSession | null>(null);

  const [signInFailedProviderId, setSignInFailedProviderId] = useState<
    string | null
  >(null);

  const signInRef = useRef<SignInSession | null>(null);
  const { refetch: refetchStates } = statesQuery;
  const { mutate: closeTerminalMutate } = closeTerminal;
  const { mutateAsync: createTerminalAsync } = createTerminal;

  const endSignIn = useCallback(
    (
      outcome: "ready" | "exited" | "failed" | "cancelled" = "cancelled",
      failureReason?: "nonzero_exit" | "unknown",
    ) => {
      const current = signInRef.current;

      if (current === null) return;
      signInRef.current = null;
      recordTelemetryEvent({
        name: "onboarding_sign_in",
        properties: {
          entry,
          outcome,
          ...(outcome === "failed"
            ? { failure_reason: failureReason ?? "unknown" }
            : {}),
        },
      });
      setSignIn(null);
      closeTerminalMutate({ mode: "force", terminalId: current.session.id });
      void refetchStates();
    },
    [closeTerminalMutate, entry, refetchStates],
  );

  const signInRequestRef = useRef(0);
  useEffect(
    () => () => {
      signInRequestRef.current += 1;
      endSignIn();
    },
    [endSignIn],
  );

  const handleSignInExit = useCallback(
    (exitCode: number | null) => {
      const current = signInRef.current;

      if (current !== null && exitCode !== 0) {
        setSignInFailedProviderId(current.providerId);
      }

      endSignIn(
        exitCode === 0 ? "exited" : "failed",
        exitCode === null ? "unknown" : "nonzero_exit",
      );
    },
    [endSignIn],
  );

  useEffect(() => {
    if (signIn === null) return;

    const interval = window.setInterval(() => {
      void refetchStates();
    }, SIGN_IN_POLL_INTERVAL_MS);

    return () => window.clearInterval(interval);
  }, [refetchStates, signIn]);

  const states = statesQuery.data?.providers;
  const signingInProviderId = signIn?.providerId ?? null;

  const signingInProviderReady =
    signingInProviderId !== null &&
    states?.find((state) => state.providerId === signingInProviderId)
      ?.status === "ready";

  useEffect(() => {
    if (signingInProviderReady) endSignIn("ready");
  }, [endSignIn, signingInProviderReady]);

  const { runningJobKey } = installRunner;
  useEffect(() => {
    if (runningJobKey === null) void refetchStates();
  }, [refetchStates, runningJobKey]);

  const startSignIn = async (
    providerId: string,
    requestedMethod?: SignInMethod,
  ) => {
    const state = states?.find((entry) => entry.providerId === providerId);

    if (hostId === null || !state) return;

    const method =
      requestedMethod ?? (isLocalDaemonHost(hostId) ? "local" : "remote");

    const command = resolveSignInCommand(state, method === "local");

    if (command === null) return;
    endSignIn();
    setSignInFailedProviderId(null);
    signInRequestRef.current += 1;
    const request = signInRequestRef.current;
    recordTelemetryEvent({
      name: "onboarding_sign_in",
      properties: { entry, outcome: "started" },
    });
    const title = `Sign in to ${state.displayName}`;
    await closeAbandonedSignInTerminals({ hostId, title });
    let session: TerminalSession;

    try {
      session = await createTerminalAsync({
        cols: SIGN_IN_TERMINAL_COLS,
        rows: SIGN_IN_TERMINAL_ROWS,
        title,
        start: { mode: "command", command },
        target: { kind: "host_path", hostId, cwd: null },
      });
    } catch {
      recordTelemetryEvent({
        name: "onboarding_sign_in",
        properties: {
          entry,
          outcome: "failed",
          failure_reason: "start_rejected",
        },
      });

      return;
    }

    if (signInRequestRef.current !== request) {
      recordTelemetryEvent({
        name: "onboarding_sign_in",
        properties: { entry, outcome: "cancelled" },
      });
      void sdk.terminals
        .close({ mode: "force", terminalId: session.id })
        .catch(() => null);

      return;
    }

    const next: SignInSession = {
      providerId,
      session,
      method,
      hasAlternateMethod:
        state.localLoginCommand !== null &&
        state.loginCommand !== null &&
        state.localLoginCommand !== state.loginCommand,
    };

    signInRef.current = next;
    setSignIn(next);
  };

  const startInstall = (providerId: string) => {
    const status = cliStatusQuery.data?.[providerId];

    if (hostId === null || status === undefined) return;
    const issue = buildProviderCliIssue({ provider: providerId, status });

    if (issue === null || !hasProviderCliAction(issue)) return;
    installRunner.startInstall({ hostId, issue });
  };

  const viewInstallLog = (providerId: string) => {
    if (hostId === null) return;

    const failure = installRunner.failuresByJobKey.get(
      providerCliJobKey(hostId, providerId),
    );

    if (failure === undefined) return;
    openProviderCliInstallLog(failure.logDialogState);
  };

  const agents: OnboardingAgent[] | null =
    hostId === null || states === undefined
      ? null
      : states.map((health) => {
          const info = providersQuery.data?.find(
            (provider) => provider.id === health.providerId,
          );

          const jobKey = providerCliJobKey(hostId, health.providerId);
          const signingIn = signIn?.providerId === health.providerId;

          return {
            id: health.providerId,
            name: health.displayName,
            provider: info ?? { id: health.providerId, logoUrl: null },
            state: resolveAgentSetupState({
              health,
              cliStatus: cliStatusQuery.data?.[health.providerId],
              installing:
                installRunner.runningJobKey === jobKey ||
                installRunner.queuedJobKeys.has(jobKey),
              installFailure: installRunner.failuresByJobKey.has(jobKey)
                ? INSTALL_FAILED_MESSAGE
                : null,
              signingIn,
              signInFailed: signInFailedProviderId === health.providerId,
              installInfoPending: cliStatusQuery.isPending,
            }),
            expanded:
              signingIn && signIn !== null ? (
                <AgentSignInContainer
                  key={signIn.session.id}
                  agentName={health.displayName}
                  session={signIn.session}
                  alternate={
                    signIn.hasAlternateMethod
                      ? signIn.method === "local"
                        ? {
                            label: "Use a one-time code instead",
                            method: "remote",
                          }
                        : {
                            label: "Use browser sign-in instead",
                            method: "local",
                          }
                      : null
                  }
                  onUseAlternate={(method) =>
                    void startSignIn(health.providerId, method)
                  }
                  onExit={handleSignInExit}
                />
              ) : undefined,
          };
        });

  const installedPlugins = pluginListQuery.data?.plugins;
  const checkingProviders = hostId !== null && detectionQuery.isPending;

  const choices = ONBOARDING_PROVIDERS.map((definition) => {
    const detected = detectedOnboardingProviders(
      definition.id,
      detectionQuery.data,
      states,
    );

    const enabled = onboardingProviderEnabled(
      definition.id,
      installedPlugins ?? [],
    );

    const selected =
      providerSelection[definition.id] ??
      initialOnboardingProviderSelected({
        id: definition.id,
        replay: entry === "replay",
        detected,
        enabled,
      });

    const plugin = definition.pluginIds.flatMap(
      (id) => installedPlugins?.find((item) => item.id === id) ?? [],
    )[0];

    return {
      id: definition.id,
      name: definition.name,
      selected,
      disabled:
        savingProviders ||
        installedPlugins === undefined ||
        plugin === undefined ||
        checkingProviders,
      detail:
        pluginListQuery.isError && installedPlugins === undefined
          ? "Couldn't load provider plugins"
          : plugin === undefined && installedPlugins !== undefined
            ? "Provider plugin unavailable"
            : detected === undefined
              ? detectionQuery.isError || hostId === null
                ? "Couldn't check this computer"
                : "Checking this computer…"
              : detected.length > 0
                ? definition.id === "acp"
                  ? `Detected: ${detected.join(", ")}`
                  : "Detected on this computer"
                : "Not detected on this computer",
      provider: { id: definition.id, logoUrl: plugin?.logoUrl ?? null },
      agents: (agents ?? []).filter((agent) =>
        matchesOnboardingProvider(definition.id, agent.id),
      ),
    };
  });

  const selectedAgentReady = (providerStates: typeof states) =>
    providerStates?.some((state) => {
      if (state.status !== "ready") return false;

      const choice = choices.find((item) =>
        matchesOnboardingProvider(item.id, state.providerId),
      );

      return choice?.selected ?? true;
    }) ?? false;

  const saveProviders = async (skipSetup = false) => {
    if (installedPlugins === undefined || savingProviders) return;
    setSavingProviders(true);

    try {
      for (const choice of choices) {
        onProviderSelectionChange(choice.id, choice.selected);

        for (const change of onboardingProviderChanges({
          id: choice.id,
          enabled: choice.selected,
          plugins: installedPlugins,
          preferredAcpPluginId: detectionQuery.data?.acpPluginId,
        })) {
          await setPluginEnabled(change.pluginId, change.enabled);
        }
      }

      if (skipSetup) {
        await pluginListQuery.refetch();
        onContinue(false);

        return;
      }

      const [, refreshedStates] = await Promise.all([
        pluginListQuery.refetch(),
        refetchStates(),
        providersQuery.refetch(),
        cliStatusQuery.refetch(),
      ]);

      setSetupApplied(true);

      if (
        !choices.some((choice) => choice.selected) ||
        (refreshedStates.isSuccess &&
          selectedAgentReady(refreshedStates.data.providers))
      ) {
        onContinue(
          refreshedStates.isSuccess &&
            selectedAgentReady(refreshedStates.data.providers),
        );
      }
    } catch (error) {
      appToast.error(
        error instanceof Error
          ? error.message
          : "Couldn't update the selected providers.",
      );
      await pluginListQuery.refetch();
    } finally {
      setSavingProviders(false);
    }
  };

  return (
    <OnboardingLayout
      {...chrome}
      step="agent"
      title="Choose your coding agents"
      description="Choose the providers you want to use. Detected agents are selected for you."
      footerNote={
        setupApplied && !selectedAgentReady(states)
          ? "Install and sign in to an agent to start a chat."
          : null
      }
      primaryLabel="Continue"
      primaryDisabled={
        installedPlugins === undefined ||
        checkingProviders ||
        (setupApplied &&
          !selectedAgentReady(states) &&
          choices.some((choice) => choice.selected))
      }
      primaryBusy={savingProviders}
      onPrimary={() => void saveProviders()}
      secondaryLabel={setupApplied ? "Skip for now" : undefined}
      onSecondary={() => void saveProviders(true)}
    >
      <AgentStep
        machineName={hostName}
        agents={agents}
        choices={choices}
        onToggleProvider={(id, enabled) => {
          setSetupApplied(false);
          onProviderSelectionChange(id, enabled);
        }}
        onSignIn={(providerId) => void startSignIn(providerId)}
        onInstall={startInstall}
        onViewInstallLog={viewInstallLog}
        onCancelSignIn={() => endSignIn()}
        onRecheck={() => {
          void refetchStates();
          void cliStatusQuery.refetch();
          void detectionQuery.refetch();
          void pluginListQuery.refetch();
        }}
      />
    </OnboardingLayout>
  );
}

function ProjectsStepContainer({
  chrome,
  hostId,
  projectIdsAtOpen,
  onBack,
  onContinue,
  onSkip,
  onDraftChange,
}: {
  chrome: StepChrome;
  hostId: string | null;
  projectIdsAtOpen: ReadonlySet<string> | null;
  onBack: () => void;
  onContinue: () => void;
  onSkip: () => void;
  onDraftChange: (draft: readonly OnboardingProjectDraft[]) => void;
}) {
  const reposQuery = useHostDiscoveredRepos(hostId);
  const createProject = useCreateProject();
  const quickCreateProject = useQuickCreateProjectController();
  const navigationQuery = useSidebarNavigation();
  const [selection, setSelection] = useState<ReadonlySet<string> | null>(null);
  const [importing, setImporting] = useState(false);
  const [rescanning, setRescanning] = useState(false);
  const [now] = useState(() => Date.now());

  const { refetch: refetchRepos } = reposQuery;
  const navigationProjects = navigationQuery.data?.projects;

  const hostProjects = useMemo(
    () =>
      hostId === null
        ? []
        : (navigationProjects ?? []).flatMap((project) => {
            const source = findLocalPathProjectSourceForHost(
              project.sources,
              hostId,
            );

            return source === undefined
              ? []
              : [{ id: project.id, name: project.name, path: source.path }];
          }),
    [hostId, navigationProjects],
  );

  const scannedRepos = reposQuery.data?.repos;

  const discovered = useMemo(
    () =>
      scannedRepos?.map((repo) =>
        repo.projectId !== null
          ? repo
          : {
              ...repo,
              projectId:
                hostProjects.find((project) => project.path === repo.path)
                  ?.id ?? null,
            },
      ),
    [hostProjects, scannedRepos],
  );

  const selectedPaths = useMemo(() => {
    const importable = new Set(
      (discovered ?? [])
        .filter((repo) => repo.projectId === null)
        .map((repo) => repo.path),
    );

    const chosen = selection ?? defaultSelectedRepoPaths(discovered ?? [], now);

    return new Set([...chosen].filter((path) => importable.has(path)));
  }, [discovered, now, selection]);

  const draft = useMemo(
    () =>
      (discovered ?? [])
        .filter((repo) => selectedPaths.has(repo.path))
        .map((repo) => ({ id: repo.path, name: repo.name })),
    [discovered, selectedPaths],
  );

  useEffect(() => onDraftChange(draft), [draft, onDraftChange]);
  useEffect(() => () => onDraftChange([]), [onDraftChange]);

  const repos = useMemo((): OnboardingRepo[] => {
    const discoveredPaths = new Set(
      (discovered ?? []).map((repo) => repo.path),
    );

    return [
      ...hostProjects
        .filter(
          (project) =>
            !discoveredPaths.has(project.path) &&
            projectIdsAtOpen !== null &&
            !projectIdsAtOpen.has(project.id),
        )
        .map((project) => ({
          id: `project:${project.id}`,
          name: project.name,
          path: project.path,
          lastActive: "",
          remote: null,
          added: true,
        })),
      ...(discovered ?? []).map((repo) => ({
        id: repo.path,
        name: repo.name,
        path: repo.path,
        lastActive: formatRelativeTime({
          timestamp: Date.parse(repo.lastActivityAt),
          now,
        }),
        remote: shortRemoteName(repo.originUrl),
        added: repo.projectId !== null,
      })),
    ];
  }, [discovered, hostProjects, now, projectIdsAtOpen]);

  const importSelected = async () => {
    if (hostId === null || discovered === undefined) return;

    const chosen = discovered.filter(
      (repo) => repo.projectId === null && selectedPaths.has(repo.path),
    );

    setImporting(true);

    try {
      for (const repo of chosen) {
        await createProject.mutateAsync({
          name: repo.name,
          source: { type: "local_path", hostId, path: repo.path },
        });
      }
    } catch {
      return;
    } finally {
      setImporting(false);
      void refetchRepos();
    }

    onContinue();
  };

  const scanning = hostId === null || reposQuery.isPending || rescanning;

  return (
    <OnboardingLayout
      {...chrome}
      step="projects"
      title="Add your projects"
      description="Git repos on this computer that you've worked in over the last 30 days."
      primaryLabel={
        scanning || selectedPaths.size === 0
          ? "Continue"
          : `Import ${selectedPaths.size} ${selectedPaths.size === 1 ? "project" : "projects"}`
      }
      primaryDisabled={scanning}
      primaryBusy={importing}
      secondaryLabel="Skip"
      onPrimary={() => {
        if (selectedPaths.size === 0) onContinue();
        else void importSelected();
      }}
      onSecondary={onSkip}
      onBack={onBack}
    >
      <ProjectsStep
        status={
          scanning
            ? { kind: "scanning" }
            : reposQuery.isError
              ? {
                  kind: "error",
                  message: "Omnyo couldn't scan this computer for git repos.",
                }
              : { kind: "results", truncated: reposQuery.data.truncated }
        }
        repos={repos}
        selectedIds={selectedPaths}
        onToggle={(path) => {
          const next = new Set(selectedPaths);

          if (next.has(path)) next.delete(path);
          else next.add(path);
          setSelection(next);
        }}
        onSelectAll={() =>
          setSelection(
            new Set(
              (discovered ?? [])
                .filter((repo) => repo.projectId === null)
                .map((repo) => repo.path),
            ),
          )
        }
        onSelectNone={() => setSelection(new Set())}
        onAddFolder={quickCreateProject.openCreateDialog}
        onRetry={() => {
          setRescanning(true);
          void refetchRepos().finally(() => setRescanning(false));
        }}
      />
      <ProjectPathDialog
        target={quickCreateProject.projectPathDialog.target}
        pending={quickCreateProject.isCreating}
        platform={quickCreateProject.platform}
        hostId={quickCreateProject.hostId}
        hostName={quickCreateProject.hostName}
        hosts={quickCreateProject.hosts}
        onOpenChange={quickCreateProject.projectPathDialog.onOpenChange}
        onSubmit={quickCreateProject.submitProjectPath}
      />
    </OnboardingLayout>
  );
}

function PluginsStepContainer({
  chrome,
  onBack,
  onContinue,
}: {
  chrome: StepChrome;
  onBack: () => void;
  onContinue: () => void;
}) {
  const listQuery = usePluginList({ enabled: true });
  const setPluginEnabled = useSetPluginEnabled();
  const { refetch: refetchList } = listQuery;

  const [targets, setTargets] = useState<ReadonlyMap<string, boolean>>(
    () => new Map(),
  );

  const installed = listQuery.data?.plugins;

  const groups =
    installed === undefined ? null : onboardingPluginGroups(installed);

  const toggle = async (pluginId: string, enabled: boolean) => {
    setTargets((current) => new Map(current).set(pluginId, enabled));

    try {
      await setPluginEnabled(pluginId, enabled);
      await refetchList();
    } catch (error) {
      appToast.error(
        error instanceof Error ? error.message : "Couldn't change that plugin.",
      );
    } finally {
      setTargets((current) => {
        const next = new Map(current);
        next.delete(pluginId);

        return next;
      });
    }
  };

  const sections =
    groups === null
      ? null
      : groups.map((group) => ({
          id: group.id,
          label: group.label,
          plugins: group.plugins.map((plugin) => ({
            id: plugin.id,
            name: plugin.name ?? plugin.id,
            description: plugin.description,
            icon: plugin.icon,
            enabled: targets.get(plugin.id) ?? plugin.enabled,
            pending: targets.has(plugin.id),
          })),
        }));

  const rows = sections?.flatMap((section) => section.plugins) ?? [];
  const onCount = rows.filter((plugin) => plugin.enabled).length;
  const allOn = rows.length > 0 && onCount === rows.length;

  return (
    <OnboardingLayout
      {...chrome}
      step="plugins"
      title="Recommended plugins are on"
      description="Omnyo starts with these. Turn off anything you don't want."
      footerNote={
        sections === null || rows.length === 0
          ? null
          : `${onCount} of ${rows.length} on`
      }
      primaryLabel={allOn ? "Continue with recommended" : "Continue"}
      primaryDisabled={targets.size > 0}
      onPrimary={onContinue}
      onBack={onBack}
    >
      <OnboardingPluginSections
        sections={sections}
        compact={chrome.compact}
        onToggle={(pluginId, enabled) => void toggle(pluginId, enabled)}
      />
    </OnboardingLayout>
  );
}

const STARTER_ICONS: Record<OnboardingStarterId, string> = {
  briefing: "Coffee",
  dependencies: "PackageReceive",
};

const createdAutomationSchema = z.object({ id: z.string().min(1) });

const deletedAutomationSchema = z.object({ ok: z.literal(true) });

export type ScheduledStarters = Partial<
  Record<OnboardingStarterId, { projectId: string; automationId: string }>
>;

function decodeFileContent(file: {
  content: string;
  contentEncoding?: string;
}): string {
  if (file.contentEncoding !== "base64") return file.content;

  return new TextDecoder().decode(decodeBase64Bytes(file.content));
}

function AutomationsStepContainer({
  chrome,
  hostId,
  scheduled,
  contentFeedQueued,
  sentryEnabled,
  onScheduledChange,
  onContentFeedQueuedChange,
  onBack,
  onContinue,
}: {
  chrome: StepChrome;
  hostId: string | null;
  scheduled: ScheduledStarters;
  contentFeedQueued: boolean;
  sentryEnabled: boolean;
  onScheduledChange: (
    update: (current: ScheduledStarters) => ScheduledStarters,
  ) => void;
  onContentFeedQueuedChange: (queued: boolean) => void;
  onBack: () => void;
  onContinue: () => void;
}) {
  const navigationProjects = useSidebarNavigation().data?.projects;
  const [chosenProjectId, setChosenProjectId] = useState<string | null>(null);

  const [pending, setPending] = useState<ReadonlySet<OnboardingStarterId>>(
    () => new Set(),
  );

  const [sentryOpen, setSentryOpen] = useState(false);

  const projects = (hostId === null ? [] : (navigationProjects ?? [])).flatMap(
    (project) => {
      const source =
        hostId === null
          ? undefined
          : findLocalPathProjectSourceForHost(project.sources, hostId);

      return source === undefined
        ? []
        : [{ id: project.id, name: project.name, path: source.path }];
    },
  );

  const project =
    projects.find((entry) => entry.id === chosenProjectId) ??
    projects[0] ??
    null;

  const statesQuery = useSystemProviderStates({
    enabled: hostId !== null,
    poll: false,
    ...(hostId === null ? {} : { hostId }),
  });

  const readyAgent =
    statesQuery.data?.providers.find((state) => state.status === "ready") ??
    null;

  const modelsQuery = useSystemExecutionOptions({
    enabled: hostId !== null && readyAgent !== null,
    ...(hostId === null ? {} : { hostId }),
    ...(readyAgent === null ? {} : { providerId: readyAgent.providerId }),
  });

  const defaultModel =
    modelsQuery.data?.models.find((model) => model.isDefault)?.model ?? null;

  const sentryQuery = useQuery({
    queryKey: ["onboarding", "sentry-sdk", hostId, project?.path ?? null],
    enabled: sentryEnabled && hostId !== null && project !== null,
    staleTime: Infinity,
    queryFn: async ({ signal }) => {
      if (hostId === null || project === null) return false;

      const manifests = await Promise.all(
        SENTRY_MANIFEST_FILES.map((file) =>
          sdk.files
            .read({ hostId, path: `${project.path}/${file}`, signal })
            .then(
              (result) => ({ file, content: decodeFileContent(result) }),
              () => null,
            ),
        ),
      );

      return usesSentrySdk(
        manifests.flatMap((manifest) => (manifest === null ? [] : [manifest])),
      );
    },
  });

  const toggleStarter = async (id: OnboardingStarterId, enabled: boolean) => {
    const starter = ONBOARDING_STARTERS.find((entry) => entry.id === id);
    const existing = scheduled[id];

    if (starter === undefined) return;
    setPending((current) => new Set(current).add(id));

    try {
      if (enabled && existing === undefined) {
        if (
          hostId === null ||
          project === null ||
          readyAgent === null ||
          defaultModel === null
        )
          return;

        const created = await sdk.plugins.callRpc({
          pluginId: AUTOMATIONS_PLUGIN_ID,
          method: "automations_create",
          input: starterAutomationInput({
            starter,
            projectId: project.id,
            hostId,
            providerId: readyAgent.providerId,
            model: defaultModel,
            timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
          }),
          outputSchema: createdAutomationSchema,
        });

        onScheduledChange((current) => ({
          ...current,
          [id]: { projectId: project.id, automationId: created.id },
        }));
      } else if (!enabled && existing !== undefined) {
        await sdk.plugins.callRpc({
          pluginId: AUTOMATIONS_PLUGIN_ID,
          method: "automations_delete",
          input: existing,
          outputSchema: deletedAutomationSchema,
        });
        onScheduledChange((current) => {
          const next = { ...current };
          delete next[id];

          return next;
        });
      }
    } catch (error) {
      appToast.error(
        error instanceof Error
          ? error.message
          : `Couldn't change ${starter.name}.`,
      );
    } finally {
      setPending((current) => {
        const next = new Set(current);
        next.delete(id);

        return next;
      });
    }
  };

  const agentName =
    readyAgent === null || defaultModel === null
      ? null
      : readyAgent.displayName;

  const scheduledCount = Object.keys(scheduled).length;

  return (
    <OnboardingLayout
      {...chrome}
      step="automations"
      title="Put Omnyo to work"
      description="Each one runs on a schedule and uses your agent when it does."
      footerNote={scheduledCount === 0 ? null : `${scheduledCount} scheduled`}
      primaryLabel="Continue"
      primaryDisabled={pending.size > 0}
      onPrimary={onContinue}
      onBack={onBack}
    >
      <AutomationsStep
        projects={projects}
        projectId={project?.id ?? null}
        agentName={agentName}
        starters={ONBOARDING_STARTERS.map((starter) => ({
          id: starter.id,
          name: starter.name,
          description: starter.description,
          scheduleLabel: starter.scheduleLabel,
          icon: STARTER_ICONS[starter.id],
          enabled: scheduled[starter.id] !== undefined,
          pending: pending.has(starter.id),
        }))}
        sentry={
          sentryQuery.data === true && project !== null
            ? {
                status: "detected",
                projectName: project.name,
                open: sentryOpen,
                setup: <PluginSettingsSections pluginId={SENTRY_PLUGIN_ID} />,
              }
            : { status: "hidden" }
        }
        contentFeedQueued={contentFeedQueued}
        onSelectProject={setChosenProjectId}
        onToggleStarter={(id, enabled) => {
          const starter = ONBOARDING_STARTERS.find((entry) => entry.id === id);

          if (starter !== undefined) void toggleStarter(starter.id, enabled);
        }}
        onToggleSentrySetup={() => setSentryOpen((open) => !open)}
        onToggleContentFeed={onContentFeedQueuedChange}
      />
    </OnboardingLayout>
  );
}

function ChatsStepContainer({
  chrome,
  onBack,
  onContinue,
  onLeave,
  onSkip,
}: {
  chrome: StepChrome;
  onBack: () => void;
  onContinue: () => void;
  onLeave: () => void;
  onSkip: () => void;
}) {
  useLeaveOnNavigation(onLeave);

  return (
    <OnboardingLayout
      {...chrome}
      step="chats"
      title="Pick up where you left off"
      description="Bring your recent Codex and Claude Code chats into Omnyo. Each one continues where you left off; your CLI history stays as it is."
      primaryLabel="Continue"
      secondaryLabel="Skip"
      onPrimary={onContinue}
      onSecondary={onSkip}
      onBack={onBack}
    >
      <PluginSettingsSections pluginId={CHAT_IMPORTER_PLUGIN_ID} />
    </OnboardingLayout>
  );
}

function DevicesStepContainer({
  chrome,
  hostId,
  onBack,
  onFinish,
  onLeave,
}: {
  chrome: StepChrome;
  hostId: string | null;
  onBack: () => void;
  onFinish: () => void;
  onLeave: () => void;
}) {
  const configQuery = useSystemConfig();
  const hostsQuery = useHosts();
  const [connectSetupOpen, setConnectSetupOpen] = useState(false);
  const [addMachineOpen, setAddMachineOpen] = useState(false);
  useLeaveOnNavigation(onLeave);

  const otherMachineCount = (hostsQuery.data ?? []).filter(
    (host) => host.id !== hostId,
  ).length;

  return (
    <OnboardingLayout
      {...chrome}
      step="devices"
      title="Use Omnyo from anywhere"
      description="All optional. Everything here also lives in Settings → Machines."
      primaryLabel="Start using Omnyo"
      onPrimary={onFinish}
      onBack={onBack}
    >
      <DevicesStep
        connect={connectAccessUrl(configQuery.data?.serverAccess)}
        connectSetup={<PluginSettingsSections pluginId={CONNECT_PLUGIN_ID} />}
        connectSetupOpen={connectSetupOpen}
        otherMachineCount={otherMachineCount}
        onToggleConnectSetup={() => setConnectSetupOpen((open) => !open)}
        onCopyConnectUrl={(url) => void copyToClipboardWithToast(url)}
        onAddMachine={() => setAddMachineOpen(true)}
      />
      <AddMachineDialog
        open={addMachineOpen}
        onOpenChange={setAddMachineOpen}
      />
    </OnboardingLayout>
  );
}

const INTRO_PLAYED_STORAGE_KEY = "omnyo.onboarding.intro-played";

function readIntroPlayed(): boolean {
  try {
    return window.sessionStorage.getItem(INTRO_PLAYED_STORAGE_KEY) === "1";
  } catch {
    return false;
  }
}

function rememberIntroPlayed(): void {
  try {
    window.sessionStorage.setItem(INTRO_PLAYED_STORAGE_KEY, "1");
  } catch {
    return;
  }
}

export function OnboardingFlow({
  initialStep,
  entry,
  onClose,
}: {
  initialStep: OnboardingStepId;
  entry: OnboardingEntry;
  onClose: () => void;
}) {
  const [step, setStep] = useState(initialStep);

  const [providerSelection, setProviderSelection] = useState<
    Partial<Record<OnboardingProviderId, boolean>>
  >({});

  const [previousStep, setPreviousStep] = useState<OnboardingStepId | null>(
    null,
  );

  const [introPlaying, setIntroPlaying] = useState(
    () => entry === "first_run" && !readIntroPlayed(),
  );

  const [projectDraft, setProjectDraft] = useState<
    readonly OnboardingProjectDraft[]
  >([]);

  const [browserConnected, setBrowserConnected] = useState(false);

  const [scheduledStarters, setScheduledStarters] = useState<ScheduledStarters>(
    {},
  );

  const [contentFeedQueued, setContentFeedQueued] = useState(false);
  const navigate = useNavigate();

  const showStep = (next: OnboardingStepId) => {
    setPreviousStep(step);
    setStep(next);
  };

  const navigationProjects = useSidebarNavigation().data?.projects;

  const [projectIdsAtOpen, setProjectIdsAtOpen] =
    useState<ReadonlySet<string> | null>(null);

  if (projectIdsAtOpen === null && navigationProjects !== undefined) {
    setProjectIdsAtOpen(
      new Set(navigationProjects.map((project) => project.id)),
    );
  }

  const primaryHost = usePrimaryHost();
  const hostId = primaryHost?.id ?? null;
  useHostDiscoveredRepos(hostId);

  const agentStatesQuery = useSystemProviderStates({
    enabled: hostId !== null,
    poll: false,
    ...(hostId === null ? {} : { hostId }),
  });

  const agentStates = agentStatesQuery.data?.providers;
  const agentStateRef = useRef<string | null>(null);
  useEffect(() => {
    if (agentStates === undefined && !agentStatesQuery.isError) return;
    const knownStates = agentStatesQuery.isError ? undefined : agentStates;

    const hasUnknown =
      knownStates?.some((state) => state.status === "unknown") ?? true;

    const installed =
      knownStates?.some(
        (state) =>
          state.status !== "not_installed" && state.status !== "unknown",
      ) ?? false;

    const properties = {
      entry,
      agent_installed: installed ? true : hasUnknown ? null : false,
      agent_ready: hasReadyAgent(knownStates)
        ? true
        : hasUnknown
          ? null
          : false,
    };

    const key = JSON.stringify(properties);

    if (agentStateRef.current === key) return;
    agentStateRef.current = key;
    recordTelemetryEvent({ name: "onboarding_agent_state", properties });
  }, [agentStates, agentStatesQuery.isError, entry]);
  const startReportedRef = useRef(entry !== "first_run");
  useEffect(() => {
    if (startReportedRef.current || agentStates === undefined) return;
    startReportedRef.current = true;
    recordTelemetryEvent({
      name: "onboarding_started",
      properties: {
        agent_installed: agentStates.some(
          (state) =>
            state.status !== "not_installed" && state.status !== "unknown",
        ),
        agent_ready: hasReadyAgent(agentStates),
      },
    });
  }, [agentStates]);
  const reachedStepsRef = useRef(new Set<OnboardingStepId>());
  useEffect(() => {
    if (reachedStepsRef.current.has(step)) return;
    reachedStepsRef.current.add(step);
    recordTelemetryEvent({
      name: "onboarding_step_reached",
      properties: { step, entry },
    });
  }, [entry, step]);
  const finishedRef = useRef(false);

  const close = (outcome: "completed" | "skipped") => {
    if (finishedRef.current) return;
    finishedRef.current = true;

    if (outcome === "skipped") {
      recordTelemetryEvent({
        name: "onboarding_step_skipped",
        properties: { step, entry },
      });
    } else {
      recordTelemetryEvent({
        name: "onboarding_step_completed",
        properties: { step, entry },
      });
    }

    recordTelemetryEvent({
      name: "onboarding_finished",
      properties: { outcome, entry, last_step: step },
    });

    if (contentFeedQueued) {
      void navigate(
        getPluginPanelRoutePath({
          pluginId: AUTOMATIONS_PLUGIN_ID,
          path: "automations",
          subPath: "import",
        }),
      );
    }

    onClose();
  };

  const compact = useMediaQuery("(max-width: 640px)");
  const showStage = useMediaQuery("(min-width: 1100px)");
  const [desktopInfo] = useState(getOmnyoDesktopInfo);
  const [browserLogins] = useState(() => browserLoginApi(desktopInfo));
  const windowState = useDesktopWindowState();

  const pluginListQuery = usePluginList({ enabled: true });
  const pluginList = pluginListQuery.data?.plugins;

  const chatImporterEnabled =
    pluginList === undefined
      ? !pluginListQuery.isError
      : pluginList.some(
          (plugin) => plugin.id === CHAT_IMPORTER_PLUGIN_ID && plugin.enabled,
        );

  const pluginEnabled = (pluginId: string) =>
    pluginList?.some((plugin) => plugin.id === pluginId && plugin.enabled) ??
    false;

  const steps = onboardingSteps({
    browserLogins: browserLogins !== null,
    chatImporterEnabled,
    automationsEnabled: pluginEnabled(AUTOMATIONS_PLUGIN_ID),
  });

  const chrome: StepChrome = {
    compact,
    reserveMacosTrafficLights: shouldReserveMacosTrafficLights({
      desktopInfo,
      windowState,
    }),
    steps,
    previousStep,
    onSelectStep: showStep,
    onSkipAll: () => close("skipped"),
  };

  const goTo = (direction: 1 | -1) => () => {
    const next = adjacentOnboardingStep({ steps, step, direction });

    if (next !== null) showStep(next);
  };

  const advance = (outcome: "completed" | "skipped") => () => {
    recordTelemetryEvent({
      name:
        outcome === "completed"
          ? "onboarding_step_completed"
          : "onboarding_step_skipped",
      properties: { step, entry },
    });
    goTo(1)();
  };

  const stepContent = () => {
    switch (step) {
      case "agent":
        return (
          <AgentStepContainer
            chrome={chrome}
            entry={entry}
            hostId={hostId}
            hostName={primaryHost?.name ?? null}
            providerSelection={providerSelection}
            onProviderSelectionChange={(id, enabled) =>
              setProviderSelection((current) => ({ ...current, [id]: enabled }))
            }
            onContinue={(ready) => advance(ready ? "completed" : "skipped")()}
          />
        );
      case "projects":
        return (
          <ProjectsStepContainer
            chrome={chrome}
            hostId={hostId}
            projectIdsAtOpen={projectIdsAtOpen}
            onBack={goTo(-1)}
            onContinue={advance("completed")}
            onSkip={advance("skipped")}
            onDraftChange={setProjectDraft}
          />
        );
      case "chats":
        return (
          <ChatsStepContainer
            chrome={chrome}
            onBack={goTo(-1)}
            onContinue={advance("completed")}
            onLeave={() => close("completed")}
            onSkip={advance("skipped")}
          />
        );
      case "browser":
        return browserLogins === null ? null : (
          <OnboardingBrowserStep
            chrome={chrome}
            browser={browserLogins}
            permissionNote={
              desktopInfo?.platform === "macos"
                ? "If macOS asks, choose Always Allow so Omnyo stays in sync."
                : null
            }
            onBack={goTo(-1)}
            onContinue={advance("completed")}
            onSkip={advance("skipped")}
            onConnectedChange={setBrowserConnected}
          />
        );
      case "plugins":
        return (
          <PluginsStepContainer
            chrome={chrome}
            onBack={goTo(-1)}
            onContinue={advance("completed")}
          />
        );
      case "skills":
        return (
          <RecommendedSkillsStep
            chrome={chrome}
            hostId={primaryHost?.status === "connected" ? hostId : null}
            onBack={goTo(-1)}
            onContinue={advance("completed")}
          />
        );
      case "automations":
        return (
          <AutomationsStepContainer
            chrome={chrome}
            hostId={hostId}
            scheduled={scheduledStarters}
            contentFeedQueued={contentFeedQueued}
            sentryEnabled={pluginEnabled(SENTRY_PLUGIN_ID)}
            onScheduledChange={setScheduledStarters}
            onContentFeedQueuedChange={setContentFeedQueued}
            onBack={goTo(-1)}
            onContinue={advance(
              Object.keys(scheduledStarters).length > 0 || contentFeedQueued
                ? "completed"
                : "skipped",
            )}
          />
        );
      case "devices":
        return (
          <DevicesStepContainer
            chrome={chrome}
            hostId={hostId}
            onBack={goTo(-1)}
            onFinish={() => close("completed")}
            onLeave={() => close("skipped")}
          />
        );
    }
  };

  return (
    <>
      <div className="flex min-h-0 flex-1">
        <div className="flex min-w-0 flex-1 flex-col">{stepContent()}</div>
        {showStage && !compact ? (
          <OnboardingStageContainer
            className="w-[46%] shrink-0"
            step={step}
            hostId={hostId}
            hostName={primaryHost?.name ?? null}
            projectDraft={projectDraft}
            browserConnected={browserConnected}
            scheduled={ONBOARDING_STARTERS.flatMap((starter) =>
              scheduledStarters[starter.id] === undefined
                ? []
                : [
                    {
                      id: starter.id,
                      name: starter.name,
                      scheduleLabel: starter.scheduleLabel,
                    },
                  ],
            )}
          />
        ) : null}
      </div>
      {introPlaying ? (
        <OnboardingIntro
          onDone={() => {
            rememberIntroPlayed();
            setIntroPlaying(false);
          }}
        />
      ) : null}
    </>
  );
}
