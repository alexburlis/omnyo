import type { ProviderCliStatus } from "@omnyo/host-daemon-contract";
import type {
  HostDiscoveredRepo,
  ServerAccessStatus,
  SystemProviderState,
} from "@omnyo/server-contract";

export type OnboardingStepId =
  | "agent"
  | "projects"
  | "chats"
  | "browser"
  | "plugins"
  | "automations"
  | "devices";

export interface OnboardingStep {
  id: OnboardingStepId;
  label: string;
}

export const ONBOARDING_STEPS: readonly OnboardingStep[] = [
  { id: "agent", label: "Agent" },
  { id: "projects", label: "Projects" },
  { id: "chats", label: "Chats" },
  { id: "browser", label: "Browser" },
  { id: "plugins", label: "Plugins" },
  { id: "automations", label: "Automations" },
  { id: "devices", label: "Devices" },
];

export function onboardingSteps({
  browserLogins,
  chatImporterEnabled,
  automationsEnabled,
}: {
  browserLogins: boolean;
  chatImporterEnabled: boolean;
  automationsEnabled: boolean;
}): readonly OnboardingStep[] {
  return ONBOARDING_STEPS.filter(
    (step) =>
      (step.id !== "browser" || browserLogins) &&
      (step.id !== "chats" || chatImporterEnabled) &&
      (step.id !== "automations" || automationsEnabled),
  );
}

export const ONBOARDING_PLUGIN_GROUPS: readonly {
  id: string;
  label: string;
  pluginIds: readonly string[];
}[] = [
  {
    id: "chats",
    label: "Chats",
    pluginIds: [
      "inline-ui",
      "inline-vis",
      "glance",
      "chat-topics",
      "omnyo--prompt-library",
      "omnyo--composer-predictions",
      "drafts",
      "scheduled-send",
      "side-chat",
      "ask-user-question",
      "custom-instructions",
      "local-voice",
      "chime-local",
    ],
  },
  {
    id: "agents",
    label: "Agents",
    pluginIds: [
      "browser-automation",
      "agent-annotations",
      "workflows",
      "automations",
      "pursue",
      "state-machines",
      "canvas",
      "project-actions",
      "secrets",
      "provider-retry",
      "omnyo--wait-sources",
    ],
  },
  {
    id: "upkeep",
    label: "Code and upkeep",
    pluginIds: [
      "omnyo--git",
      "workspace-github",
      "tidy",
      "leftover-processes",
      "omnyo--storage-retention",
      "stats",
      "omnyo--account-usage",
      "skill-discovery",
      "self-improvement",
      "sentry",
      "keep-awake",
      "concurrency-limit",
      "pdf-preview",
    ],
  },
];

export interface OnboardingInstalledPlugin {
  id: string;
  name: string | null;
  description: string | null;
  icon: string | null;
  enabled: boolean;
}

export interface OnboardingPluginGroup<T extends OnboardingInstalledPlugin> {
  id: string;
  label: string;
  plugins: readonly T[];
}

export function onboardingPluginGroups<T extends OnboardingInstalledPlugin>(
  installed: readonly T[],
): readonly OnboardingPluginGroup<T>[] {
  const byId = new Map(installed.map((plugin) => [plugin.id, plugin]));

  return ONBOARDING_PLUGIN_GROUPS.flatMap((group) => {
    const plugins = group.pluginIds.flatMap((id) => {
      const plugin = byId.get(id);

      return plugin === undefined ? [] : [plugin];
    });

    return plugins.length === 0
      ? []
      : [{ id: group.id, label: group.label, plugins }];
  });
}

export const AUTOMATIONS_PLUGIN_ID = "automations";

export const SENTRY_PLUGIN_ID = "sentry";

export type OnboardingStarterId = "briefing" | "dependencies";

export interface OnboardingStarter {
  id: OnboardingStarterId;
  name: string;
  description: string;
  scheduleLabel: string;
  cron: string;
  permissionMode: "accept-edits" | "auto" | "full";
  workspace: "checkout" | "worktree";
  prompt: string;
}

export const ONBOARDING_STARTERS: readonly OnboardingStarter[] = [
  {
    id: "briefing",
    name: "Morning briefing",
    description: "What changed, open pull requests and what's stuck.",
    scheduleLabel: "Weekdays at 9:00",
    cron: "0 9 * * 1-5",
    permissionMode: "auto",
    workspace: "checkout",
    prompt: [
      "Write a short morning briefing for this project.",
      "Cover commits and merged pull requests since the previous weekday, open pull requests with their review and CI state, failing checks on the default branch, and anything that looks stuck or waits on a decision.",
      "Use git and, when it is available and signed in, the gh CLI.",
      "Do not change files, branches, issues, pull requests or any remote state.",
      "End with the three things most worth doing today.",
    ].join(" "),
  },
  {
    id: "dependencies",
    name: "Dependency updates",
    description: "Updates on a branch, runs the tests and reports back.",
    scheduleLabel: "Mondays at 10:00",
    cron: "0 10 * * 1",
    permissionMode: "full",
    workspace: "worktree",
    prompt: [
      "Update this project's dependencies in this worktree on a new branch named omnyo/dependency-updates-YYYY-MM-DD with today's date.",
      "Use the project's own package manager and lockfile.",
      "Apply patch and minor updates; list available major updates without applying them.",
      "Run the project's tests, type checks and build. If an update breaks them, revert that update and say why.",
      "Commit the remaining updates on the branch.",
      "Do not push, open a pull request or merge.",
      "Report what changed, what you skipped and the check results.",
    ].join(" "),
  },
];

type StarterEnvironment =
  | { type: "project-default" }
  | {
      type: "host";
      hostId: string;
      workspace: {
        type: "managed-worktree";
        baseBranch: { kind: "default" };
      };
    };

export function starterAutomationInput({
  starter,
  projectId,
  hostId,
  providerId,
  model,
  timezone,
}: {
  starter: OnboardingStarter;
  projectId: string;
  hostId: string;
  providerId: string;
  model: string;
  timezone: string;
}) {
  const environment: StarterEnvironment =
    starter.workspace === "worktree"
      ? {
          type: "host",
          hostId,
          workspace: {
            type: "managed-worktree",
            baseBranch: { kind: "default" },
          },
        }
      : { type: "project-default" };

  return {
    projectId,
    name: starter.name,
    enabled: true,
    trigger: { triggerType: "schedule" as const, cron: starter.cron, timezone },
    execution: {
      mode: "agent" as const,
      prompt: starter.prompt,
      providerId,
      model,
      permissionMode: starter.permissionMode,
      environment,
    },
    origin: "app" as const,
  };
}

export const SENTRY_MANIFEST_FILES = [
  "package.json",
  "requirements.txt",
  "pyproject.toml",
  "Gemfile",
  "go.mod",
  "Cargo.toml",
  "composer.json",
] as const;

const SENTRY_SDK_PATTERNS: Record<
  (typeof SENTRY_MANIFEST_FILES)[number],
  RegExp
> = {
  "package.json": /"@sentry\/[a-z0-9-]+"\s*:/u,
  "requirements.txt": /^sentry-sdk\b/mu,
  "pyproject.toml": /["']?sentry-sdk\b/u,
  Gemfile: /gem\s+["']sentry-(ruby|rails)["']/u,
  "go.mod": /github\.com\/getsentry\/sentry-go/u,
  "Cargo.toml": /^sentry\s*=/mu,
  "composer.json": /"sentry\/(sentry|sentry-laravel|sentry-symfony)"\s*:/u,
};

export function usesSentrySdk(
  manifests: readonly {
    file: (typeof SENTRY_MANIFEST_FILES)[number];
    content: string;
  }[],
): boolean {
  return manifests.some(({ file, content }) =>
    SENTRY_SDK_PATTERNS[file].test(content),
  );
}

export const CONNECT_PLUGIN_ID = "connect";

export const CHAT_IMPORTER_PLUGIN_ID = "omnyo--chat-importer";

export function adjacentOnboardingStep({
  steps,
  step,
  direction,
}: {
  steps: readonly OnboardingStep[];
  step: OnboardingStepId;
  direction: 1 | -1;
}): OnboardingStepId | null {
  const position = ONBOARDING_STEPS.findIndex((entry) => entry.id === step);
  const visible = new Set(steps.map((entry) => entry.id));

  for (
    let index = position + direction;
    index >= 0 && index < ONBOARDING_STEPS.length;
    index += direction
  ) {
    const candidate = ONBOARDING_STEPS[index];

    if (candidate !== undefined && visible.has(candidate.id)) {
      return candidate.id;
    }
  }

  return null;
}

export type AgentSetupState =
  | { status: "checking" }
  | { status: "ready"; detail: string | null }
  | {
      status: "signIn";
      reason: "signedOut" | "expired" | "failed";
      canSignIn: boolean;
    }
  | { status: "signingIn" }
  | { status: "install"; canInstall: boolean }
  | { status: "update"; detail: string | null; canInstall: boolean }
  | { status: "installing" }
  | { status: "installFailed"; message: string; canInstall: boolean }
  | { status: "unknown"; message: string | null };

interface ResolveAgentSetupStateArgs {
  health: SystemProviderState;
  cliStatus: ProviderCliStatus | undefined;
  installing: boolean;
  installFailure: string | null;
  signingIn: boolean;
  signInFailed: boolean;
  installInfoPending: boolean;
}

export function resolveAgentSetupState({
  health,
  cliStatus,
  installing,
  installFailure,
  signingIn,
  signInFailed,
  installInfoPending,
}: ResolveAgentSetupStateArgs): AgentSetupState {
  if (health.status === "ready") {
    const detail = [health.accountEmail, health.planLabel]
      .filter((part): part is string => part !== null && part !== "")
      .join(" · ");

    return { status: "ready", detail: detail === "" ? null : detail };
  }

  if (installing) return { status: "installing" };

  const canInstall =
    cliStatus?.installAction !== null && cliStatus?.installAction !== undefined;

  if (installFailure !== null) {
    return { status: "installFailed", message: installFailure, canInstall };
  }

  const awaitingInstallInfo = cliStatus === undefined && installInfoPending;

  switch (health.status) {
    case "not_installed":
      return awaitingInstallInfo
        ? { status: "checking" }
        : { status: "install", canInstall };
    case "unsupported_version":
      if (awaitingInstallInfo) return { status: "checking" };

      return {
        status: "update",
        detail:
          health.minimumSupportedVersion === null
            ? health.statusMessage
            : `Needs version ${health.minimumSupportedVersion} or newer`,
        canInstall,
      };
    case "unauthenticated":
    case "expired":
      if (signingIn) return { status: "signingIn" };

      return {
        status: "signIn",
        reason: signInFailed
          ? "failed"
          : health.status === "expired"
            ? "expired"
            : "signedOut",
        canSignIn: health.loginCommand !== null,
      };
    case "unknown":
      return { status: "unknown", message: health.statusMessage };
  }
}

export function resolveSignInCommand(
  health: Pick<SystemProviderState, "loginCommand" | "localLoginCommand">,
  browserIsOnMachine: boolean,
): string | null {
  return browserIsOnMachine && health.localLoginCommand !== null
    ? health.localLoginCommand
    : health.loginCommand;
}

export function hasReadyAgent(
  providers: readonly SystemProviderState[] | undefined,
): boolean {
  return providers?.some((provider) => provider.status === "ready") ?? false;
}

const RECENT_REPO_WINDOW_MS = 7 * 86_400_000;

const DEFAULT_SELECTED_REPO_LIMIT = 5;

export function defaultSelectedRepoPaths(
  repos: readonly HostDiscoveredRepo[],
  now: number,
): Set<string> {
  const importable = repos.filter((repo) => repo.projectId === null);

  const recent = importable.filter(
    (repo) => now - Date.parse(repo.lastActivityAt) <= RECENT_REPO_WINDOW_MS,
  );

  const chosen =
    recent.length > 0
      ? recent.slice(0, DEFAULT_SELECTED_REPO_LIMIT)
      : importable.slice(0, 1);

  return new Set(chosen.map((repo) => repo.path));
}

export function shortRemoteName(originUrl: string | null): string | null {
  if (originUrl === null) return null;

  const match =
    /^(?:[a-z+]+:\/\/)?(?:[^@/]+@)?[^/:]+[/:](.+?)(?:\.git)?\/?$/iu.exec(
      originUrl.trim(),
    );

  const path = match?.[1];

  if (path === undefined) return null;
  const segments = path.split("/").filter((segment) => segment !== "");

  return segments.length < 2 ? null : segments.slice(-2).join("/");
}

export function connectAccessUrl(
  serverAccess: ServerAccessStatus | undefined,
):
  | { status: "on"; url: string }
  | { status: "off" }
  | { status: "unavailable" } {
  const provider = serverAccess?.providers.find(
    (candidate) => candidate.pluginId === CONNECT_PLUGIN_ID,
  );

  if (provider === undefined) return { status: "unavailable" };

  if (
    provider.availability?.status === "available" &&
    provider.availability.serverUrl !== undefined
  ) {
    return { status: "on", url: provider.availability.serverUrl };
  }

  return { status: "off" };
}

export interface SignInGuide {
  url: string | null;
  userCode: string | null;
  acceptsPastedCode: boolean;
}

const TERMINAL_OSC_SEQUENCE = /\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/gu;

const TERMINAL_CSI_SEQUENCE = /\u001b\[[0-9;?]*[ -/]*[@-~]/gu;

const TERMINAL_HYPERLINK =
  /\u001b\]8;[^;\u0007\u001b]*;(https:\/\/[^\u0007\u001b]+)(?:\u0007|\u001b\\)/u;

const SIGN_IN_URL = /https:\/\/[^\s\u0007\u001b"'<>]+/u;

const SIGN_IN_USER_CODE =
  /(?<![A-Za-z0-9-])[A-Z0-9]{4,5}-[A-Z0-9]{4,5}(?![A-Za-z0-9-])/u;

const SIGN_IN_PASTE_PROMPT = /paste (?:the |your )?(?:authorization )?code/iu;

export function parseSignInOutput(output: string): SignInGuide {
  const text = output
    .replace(TERMINAL_OSC_SEQUENCE, "")
    .replace(TERMINAL_CSI_SEQUENCE, "")
    .replace(/\r/gu, "");

  const url =
    TERMINAL_HYPERLINK.exec(output)?.[1] ?? SIGN_IN_URL.exec(text)?.[0] ?? null;

  const withoutUrls = text.replace(new RegExp(SIGN_IN_URL.source, "gu"), " ");

  return {
    url,
    userCode: SIGN_IN_USER_CODE.exec(withoutUrls)?.[0] ?? null,
    acceptsPastedCode: SIGN_IN_PASTE_PROMPT.test(withoutUrls),
  };
}
