import { useEffect, useRef, useState, type ReactNode } from "react";
import { Button } from "@omnyo/shared-ui/button";
import { cn } from "@omnyo/shared-ui/lib/utils";
import {
  AgentSignInGuide,
  AgentStep,
  AutomationsStep,
  DevicesStep,
  OnboardingLayout,
  OnboardingPluginSections,
  ProjectsStep,
  type OnboardingAgent,
  type OnboardingConnectState,
  type OnboardingRepo,
} from "./OnboardingViews";
import {
  ONBOARDING_STARTERS,
  ONBOARDING_STEPS,
  onboardingPluginGroups,
  type OnboardingInstalledPlugin,
  type AgentSetupState,
  type OnboardingStepId,
} from "./onboarding-model";
import { OnboardingIntro } from "./OnboardingIntro";
import { OnboardingMark } from "./OnboardingMark";
import { OnboardingStage } from "./OnboardingStage";
import claudeLogoUrl from "../../../../../plugins/provider-claude-code/icons/claude-code.svg";
import codexLogoUrl from "../../../../../plugins/provider-codex/icons/codex.svg";
import piLogoUrl from "../../../../../plugins/provider-pi/icons/pi.svg";

export default {
  title: "onboarding/First run",
};

const noop = () => {};

const MACHINE_NAME = "Sawyer's MacBook Pro";

const CONNECT_URL = "https://sawyer.example.test";

type AgentId = "claude-code" | "codex" | "pi";

type AgentStates = Record<AgentId, AgentSetupState>;

const AGENT_BASE: readonly { id: AgentId; name: string; logoUrl: string }[] = [
  { id: "claude-code", name: "Claude Code", logoUrl: claudeLogoUrl },
  { id: "codex", name: "Codex", logoUrl: codexLogoUrl },
  { id: "pi", name: "Pi", logoUrl: piLogoUrl },
];

const CHECKING: AgentSetupState = { status: "checking" };

const INSTALL: AgentSetupState = { status: "install", canInstall: true };

const SIGNED_OUT: AgentSetupState = {
  status: "signIn",
  reason: "signedOut",
  canSignIn: true,
};

const CLAUDE_READY: AgentSetupState = {
  status: "ready",
  detail: "sawyer@acme.dev · Ultra",
};

const CODEX_READY: AgentSetupState = {
  status: "ready",
  detail: "sawyer@acme.dev · Pro",
};

function FakeTerminal({ command }: { command: string }) {
  return (
    <pre className="h-full overflow-hidden whitespace-pre-wrap p-3 font-mono text-xs text-foreground">
      <span className="text-muted-foreground">$ </span>
      {command}
    </pre>
  );
}

const CLAUDE_SIGN_IN_URL =
  "https://claude.com/cai/oauth/authorize?code=true&client_id=example";

const CODEX_SIGN_IN_URL = "https://auth.openai.com/codex/device";

type SignInVariant = "starting" | "guided" | "terminal";

function StorySignInGuide({
  agentId,
  agentName,
  variant,
}: {
  agentId: AgentId;
  agentName: string;
  variant: SignInVariant;
}) {
  const [code, setCode] = useState("");
  const [submitted, setSubmitted] = useState(false);

  const [terminalVisible, setTerminalVisible] = useState(
    variant === "terminal",
  );

  const codex = agentId === "codex";

  return (
    <AgentSignInGuide
      agentName={agentName}
      guide={
        variant === "starting"
          ? null
          : variant === "terminal"
            ? { url: null, userCode: null, acceptsPastedCode: false }
            : {
                url: codex ? CODEX_SIGN_IN_URL : CLAUDE_SIGN_IN_URL,
                userCode: codex ? "JWMS-GLRCB" : null,
                acceptsPastedCode: !codex,
              }
      }
      code={code}
      codeSubmitted={submitted}
      terminalVisible={terminalVisible}
      terminal={
        <FakeTerminal
          command={codex ? "codex login --device-auth" : "claude auth login"}
        />
      }
      onCodeChange={(next) => {
        setCode(next);
        setSubmitted(false);
      }}
      onSubmitCode={() => setSubmitted(true)}
      onOpenUrl={noop}
      onCopy={noop}
      onToggleTerminal={() => setTerminalVisible((visible) => !visible)}
      alternateLabel={codex ? "Use browser sign-in instead" : null}
      onUseAlternate={noop}
    />
  );
}

function buildAgents(
  states: AgentStates,
  signInVariant: SignInVariant = "guided",
): OnboardingAgent[] {
  return AGENT_BASE.map((agent) => ({
    id: agent.id,
    name: agent.name,
    provider: { id: agent.id, logoUrl: agent.logoUrl },
    state: states[agent.id],
    expanded:
      states[agent.id].status === "signingIn" ? (
        <StorySignInGuide
          agentId={agent.id}
          agentName={agent.name}
          variant={signInVariant}
        />
      ) : undefined,
  }));
}

function anyReady(states: AgentStates): boolean {
  return Object.values(states).some((state) => state.status === "ready");
}

const REPOS: readonly OnboardingRepo[] = [
  {
    id: "Omnyo",
    name: "Omnyo",
    path: "/Users/sawyer/projects/omnyo",
    lastActive: "12m ago",
    remote: "get-bb/bb",
    added: false,
  },
  {
    id: "acme-web",
    name: "acme-web",
    path: "/Users/sawyer/code/acme/web",
    lastActive: "3h ago",
    remote: "acme/web",
    added: false,
  },
  {
    id: "acme-api",
    name: "acme-api",
    path: "/Users/sawyer/code/acme/api",
    lastActive: "Yesterday",
    remote: "acme/api",
    added: true,
  },
  {
    id: "dotfiles",
    name: "dotfiles",
    path: "/Users/sawyer/dotfiles",
    lastActive: "4d ago",
    remote: "sawyerhood/dotfiles",
    added: false,
  },
  {
    id: "blog",
    name: "blog",
    path: "/Users/sawyer/code/blog",
    lastActive: "2w ago",
    remote: null,
    added: false,
  },
];

const DEFAULT_REPO_IDS = ["Omnyo", "acme-web", "dotfiles"];

const STAGE_CHATS: readonly { id: string; repoId: string; title: string }[] = [
  { id: "chat-1", repoId: "Omnyo", title: "Fix flaky sidebar test" },
  { id: "chat-2", repoId: "Omnyo", title: "Speed up cold start" },
  { id: "chat-3", repoId: "acme-web", title: "Checkout copy pass" },
];

const PLUGINS: readonly OnboardingInstalledPlugin[] = [
  {
    id: "inline-ui",
    name: "Inline UI",
    description:
      "Native visual blocks and polished typography inside Omnyo chat.",
    icon: "ChartNoAxesCombined",
    enabled: true,
  },
  {
    id: "inline-vis",
    name: "Inline Visualizations",
    description:
      "Show HTML visualizations inline in assistant messages, written in the reply as a fenced block or read from a workspace or thread-storage file, and Markdown documents from a file.",
    icon: "AppWindow",
    enabled: true,
  },
  {
    id: "glance",
    name: "Glance",
    description:
      "A live card for every chat: status, proof and deliverables, with what changed since you last looked.",
    icon: "Target",
    enabled: true,
  },
  {
    id: "chat-topics",
    name: "Chat Topics",
    description:
      "Short chat titles from the first response, chats sorted into status sections per project and in an Inbox, and type-of-work tags.",
    icon: "Folder",
    enabled: true,
  },
  {
    id: "omnyo--prompt-library",
    name: "Prompt Library",
    description:
      "Search previous prompts, star favorites, and insert them into the composer.",
    icon: "Clock",
    enabled: true,
  },
  {
    id: "omnyo--composer-predictions",
    name: "Composer Predictions",
    description:
      "Predict the next message and archive readiness after completed chat turns.",
    icon: "MessageSquare",
    enabled: true,
  },
  {
    id: "drafts",
    name: "Drafts",
    description: "Save a composer draft as a manually sent queued message.",
    icon: "EditFile",
    enabled: true,
  },
  {
    id: "scheduled-send",
    name: "Send Later",
    description: "Schedule the current composer draft to send at a later time.",
    icon: "Calendar",
    enabled: true,
  },
  {
    id: "side-chat",
    name: "Side Chat",
    description:
      "Reply to messages in hidden side-chat forks rendered in a thread panel.",
    icon: "SideChat",
    enabled: true,
  },
  {
    id: "ask-user-question",
    name: "Ask User Question",
    description:
      "Let any provider ask the user a multiple-choice question, the way Claude Code's AskUserQuestion does natively.",
    icon: "MessageQuestion",
    enabled: true,
  },
  {
    id: "custom-instructions",
    name: "Custom Instructions",
    description:
      "Add persistent custom instructions to agent tasks on this Omnyo host.",
    icon: "EditFile",
    enabled: true,
  },
  {
    id: "local-voice",
    name: "Dictation by Paraspeech",
    description:
      "Private English dictation that runs on your Mac. Needs Apple silicon and macOS 14 or later.",
    icon: "Mic",
    enabled: true,
  },
  {
    id: "chime-local",
    name: "Chime",
    description:
      "Local notification sounds that wait for unread success and all remaining work.",
    icon: "./assets/icon.svg",
    enabled: true,
  },
  {
    id: "browser-automation",
    name: "Browser Automation",
    description:
      "Let Omnyo control the in-app browser and browsers on connected machines, with inline previews for headless sessions.",
    icon: "Globe",
    enabled: true,
  },
  {
    id: "agent-annotations",
    name: "Agent Annotations",
    description:
      "Select elements in a Browser tab, comment on them, and add them to the prompt.",
    icon: "MessageSquarePlus",
    enabled: true,
  },
  {
    id: "workflows",
    name: "Workflow scripts",
    description: "Run durable, provider-independent agent workflows.",
    icon: "Workflow",
    enabled: true,
  },
  {
    id: "automations",
    name: "Automations",
    description: "Schedule recurring and one-shot agent or script work.",
    icon: "Repeat",
    enabled: true,
  },
  {
    id: "pursue",
    name: "Pursue",
    description:
      "Pursue a goal until an independent judge says it is met, and run durable interval loops \u2014 for any provider.",
    icon: "Explore",
    enabled: true,
  },
  {
    id: "state-machines",
    name: "State Machines",
    description:
      "Create durable cyclic workflows with finite actions, explicit transitions and human decisions.",
    icon: "Workflow",
    enabled: true,
  },
  {
    id: "canvas",
    name: "Canvas",
    description:
      "A shared canvas for each project, with linked chat boards, saved views and conversations beside the work.",
    icon: "GridView",
    enabled: true,
  },
  {
    id: "project-actions",
    name: "Project Actions",
    description: "Project-wide shortcuts editable by agents.",
    icon: "Zap",
    enabled: true,
  },
  {
    id: "secrets",
    name: "Secrets",
    description:
      "Securely request credentials from a user and reconcile them into dotenv files.",
    icon: "Lock",
    enabled: true,
  },
  {
    id: "provider-retry",
    name: "Provider Retry",
    description:
      "Retry turns after transient provider overloads and subscription limits reset.",
    icon: "ArrowReloadHorizontal",
    enabled: true,
  },
  {
    id: "omnyo--wait-sources",
    name: "Wait Sources",
    description:
      "Wake waiting chats when a URL answers, a file appears or a command succeeds.",
    icon: "Eye",
    enabled: true,
  },
  {
    id: "omnyo--git",
    name: "Git",
    description:
      "Shows a thread's branch, changes, commits, and pull request in one control in the thread header.",
    icon: "GitBranch",
    enabled: true,
  },
  {
    id: "workspace-github",
    name: "Workspace GitHub",
    description:
      "Browse GitHub issues and PRs from root and nested Omnyo repositories, with explicit recent-history filters.",
    icon: "Github",
    enabled: true,
  },
  {
    id: "tidy",
    name: "Tidy",
    description:
      "Ready to archive: chats recommended by Omnyo's shared work summary. You archive them.",
    icon: "Clean",
    enabled: true,
  },
  {
    id: "leftover-processes",
    name: "Left Running",
    description:
      "See what each chat left running and stop it when the chat is archived or idle.",
    icon: "Terminal",
    enabled: true,
  },
  {
    id: "omnyo--storage-retention",
    name: "Storage & Retention [Experimental]",
    description:
      "Inspect machine storage and automatically archive or delete old threads.",
    icon: "./icons/database-restore.svg",
    enabled: true,
  },
  {
    id: "stats",
    name: "Stats",
    description:
      "Durable local agent, token, throughput and model analytics across every Omnyo chat and machine.",
    icon: "ChartColumn",
    enabled: true,
  },
  {
    id: "omnyo--account-usage",
    name: "Account Usage",
    description:
      "Show pooled Claude and Codex usage and selected-account reset credits.",
    icon: "ChartColumn",
    enabled: true,
  },
  {
    id: "skill-discovery",
    name: "Skill Discovery",
    description:
      "Find the right skill with a category tree, short descriptions, live search and source previews.",
    icon: "Library",
    enabled: true,
  },
  {
    id: "self-improvement",
    name: "Omnyo Customizer",
    description:
      "Toggle Omnyo Customizer in the footer, click any part of Omnyo, and describe the change in a new chat.",
    icon: "./assets/improve.svg",
    enabled: true,
  },
  {
    id: "sentry",
    name: "Sentry",
    description:
      "Investigate Sentry issues in local chats on the model you pick and deliver verified, reviewed fixes as pull requests.",
    icon: "Bug",
    enabled: true,
  },
  {
    id: "keep-awake",
    name: "Keep Awake",
    description:
      "Keeps selected macOS and Windows hosts awake while Omnyo is running.",
    icon: "Coffee",
    enabled: true,
  },
  {
    id: "concurrency-limit",
    name: "Concurrency Limit",
    description:
      "Control the number of concurrent threads that are running in Omnyo",
    icon: "Limitation",
    enabled: true,
  },
  {
    id: "pdf-preview",
    name: "PDF Preview",
    description: "Preview PDF files with the browser's built-in viewer.",
    icon: "FileText",
    enabled: true,
  },
];

function StoryWindow({
  compact = false,
  wide = false,
  fullscreen = false,
  children,
}: {
  compact?: boolean;
  wide?: boolean;
  fullscreen?: boolean;
  children: ReactNode;
}) {
  if (fullscreen) {
    return (
      <div className="flex h-dvh w-full flex-col bg-background text-foreground">
        {children}
      </div>
    );
  }

  return (
    <div
      className="flex shrink-0 flex-col overflow-hidden rounded-xl border border-border bg-background text-foreground shadow-lg"
      style={{
        width: compact ? 390 : wide ? 1400 : 960,
        height: wide ? 860 : 760,
        maxWidth: "100%",
      }}
    >
      {children}
    </div>
  );
}

function Captioned({
  label,
  hint,
  children,
}: {
  label: string;
  hint: string;
  children: ReactNode;
}) {
  return (
    <figure className="flex flex-col gap-2">
      <figcaption className="flex max-w-[960px] flex-col gap-0.5">
        <span className="text-sm font-medium text-foreground">{label}</span>
        <span className="text-xs text-muted-foreground">{hint}</span>
      </figcaption>
      {children}
    </figure>
  );
}

function Gallery({ children }: { children: ReactNode }) {
  return <div className="flex flex-col gap-10 p-6">{children}</div>;
}

interface StepChromeProps {
  compact?: boolean;
  previousStep?: OnboardingStepId | null;
  onSelectStep?: (step: OnboardingStepId) => void;
  onSkipAll?: () => void;
  onPrimary?: () => void;
  onSecondary?: () => void;
  onBack?: () => void;
}

function AgentFrame({
  states,
  machineName = MACHINE_NAME,
  loading = false,
  signInVariant = "guided",
  onSignIn = noop,
  onInstall = noop,
  onViewInstallLog = noop,
  onCancelSignIn = noop,
  onRecheck = noop,
  ...chrome
}: StepChromeProps & {
  states: AgentStates;
  machineName?: string | null;
  loading?: boolean;
  signInVariant?: SignInVariant;
  onSignIn?: (id: string) => void;
  onInstall?: (id: string) => void;
  onViewInstallLog?: (id: string) => void;
  onCancelSignIn?: (id: string) => void;
  onRecheck?: () => void;
}) {
  const ready = anyReady(states);
  const blocked = !loading && !ready;

  return (
    <OnboardingLayout
      step="agent"
      compact={chrome.compact}
      title="Connect a coding agent"
      description="Omnyo runs the agents you already use. You need one that is installed and signed in on this computer."
      footerNote={
        blocked ? "Threads can't start until one agent is ready." : null
      }
      primaryLabel="Continue"
      primaryDisabled={loading || !ready}
      secondaryLabel={blocked ? "Skip for now" : undefined}
      onPrimary={chrome.onPrimary ?? noop}
      onSecondary={chrome.onSecondary ?? noop}
      steps={ONBOARDING_STEPS}
      onSelectStep={chrome.onSelectStep ?? noop}
      onSkipAll={chrome.onSkipAll ?? noop}
      previousStep={chrome.previousStep ?? null}
    >
      <AgentStep
        machineName={machineName}
        agents={loading ? null : buildAgents(states, signInVariant)}
        onSignIn={onSignIn}
        onInstall={onInstall}
        onViewInstallLog={onViewInstallLog}
        onCancelSignIn={onCancelSignIn}
        onRecheck={onRecheck}
      />
    </OnboardingLayout>
  );
}

function ProjectsFrame({
  status = { kind: "results", truncated: false },
  repos = REPOS,
  selectedIds = new Set(DEFAULT_REPO_IDS),
  importing = false,
  onToggle = noop,
  onSelectAll = noop,
  onSelectNone = noop,
  ...chrome
}: StepChromeProps & {
  status?: Parameters<typeof ProjectsStep>[0]["status"];
  repos?: readonly OnboardingRepo[];
  selectedIds?: ReadonlySet<string>;
  importing?: boolean;
  onToggle?: (id: string) => void;
  onSelectAll?: () => void;
  onSelectNone?: () => void;
}) {
  const scanning = status.kind === "scanning";

  return (
    <OnboardingLayout
      step="projects"
      compact={chrome.compact}
      title="Add your projects"
      description="Git repos on this computer that you've worked in over the last 30 days."
      primaryLabel={
        scanning || selectedIds.size === 0
          ? "Continue"
          : `Import ${selectedIds.size} projects`
      }
      primaryDisabled={scanning}
      primaryBusy={importing}
      secondaryLabel="Skip"
      onPrimary={chrome.onPrimary ?? noop}
      onSecondary={chrome.onSecondary ?? noop}
      onBack={chrome.onBack ?? noop}
      steps={ONBOARDING_STEPS}
      onSelectStep={chrome.onSelectStep ?? noop}
      onSkipAll={chrome.onSkipAll ?? noop}
      previousStep={chrome.previousStep ?? null}
    >
      <ProjectsStep
        status={status}
        repos={repos}
        selectedIds={selectedIds}
        onToggle={onToggle}
        onSelectAll={onSelectAll}
        onSelectNone={onSelectNone}
        onAddFolder={noop}
        onRetry={noop}
      />
    </OnboardingLayout>
  );
}

function ChatsFrame(chrome: StepChromeProps) {
  return (
    <OnboardingLayout
      step="chats"
      steps={ONBOARDING_STEPS}
      compact={chrome.compact}
      title="Pick up where you left off"
      description="Bring your recent Codex and Claude Code chats into Omnyo. Each one continues where you left off; your CLI history stays as it is."
      primaryLabel="Continue"
      secondaryLabel="Skip"
      onPrimary={chrome.onPrimary ?? noop}
      onSecondary={chrome.onSecondary ?? noop}
      onBack={chrome.onBack ?? noop}
      onSelectStep={chrome.onSelectStep ?? noop}
      onSkipAll={chrome.onSkipAll ?? noop}
      previousStep={chrome.previousStep ?? null}
    >
      <div className="rounded-lg border border-border p-4">
        <p className="text-sm font-medium">Import chats</p>
        <p className="mt-1 text-xs text-muted-foreground">
          The Chat import plugin's own settings render here: 27 chats with
          messages in the last 2 days, each listed with its project, ready to
          import.
        </p>
      </div>
    </OnboardingLayout>
  );
}

function PluginsFrame({
  disabledIds = new Set<string>(),
  pendingIds = new Set<string>(),
  loading = false,
  onToggle = noop,
  ...chrome
}: StepChromeProps & {
  disabledIds?: ReadonlySet<string>;
  pendingIds?: ReadonlySet<string>;
  loading?: boolean;
  onToggle?: (id: string, enabled: boolean) => void;
}) {
  const sections = onboardingPluginGroups(PLUGINS).map((group) => ({
    id: group.id,
    label: group.label,
    plugins: group.plugins.map((plugin) => ({
      id: plugin.id,
      name: plugin.name ?? plugin.id,
      description: plugin.description,
      icon: plugin.icon,
      enabled: !disabledIds.has(plugin.id),
      pending: pendingIds.has(plugin.id),
    })),
  }));

  const onCount = PLUGINS.filter(
    (plugin) => !disabledIds.has(plugin.id),
  ).length;

  return (
    <OnboardingLayout
      step="plugins"
      compact={chrome.compact}
      title="Recommended plugins are on"
      description="Omnyo starts with these. Turn off anything you don't want."
      footerNote={loading ? null : `${onCount} of ${PLUGINS.length} on`}
      primaryLabel={
        onCount === PLUGINS.length ? "Continue with recommended" : "Continue"
      }
      onPrimary={chrome.onPrimary ?? noop}
      onBack={chrome.onBack ?? noop}
      steps={ONBOARDING_STEPS}
      onSelectStep={chrome.onSelectStep ?? noop}
      onSkipAll={chrome.onSkipAll ?? noop}
      previousStep={chrome.previousStep ?? null}
    >
      <OnboardingPluginSections
        sections={loading ? null : sections}
        compact={chrome.compact}
        onToggle={onToggle}
      />
    </OnboardingLayout>
  );
}

const STORY_STARTER_ICONS = {
  briefing: "Coffee",
  dependencies: "PackageReceive",
} as const;

function AutomationsFrame({
  scheduledIds = new Set<string>(),
  pendingIds = new Set<string>(),
  noProject = false,
  sentry = "hidden",
  contentFeedQueued = false,
  onToggleStarter = noop,
  onToggleSentrySetup = noop,
  onToggleContentFeed = noop,
  ...chrome
}: StepChromeProps & {
  scheduledIds?: ReadonlySet<string>;
  pendingIds?: ReadonlySet<string>;
  noProject?: boolean;
  sentry?: "hidden" | "detected" | "open";
  contentFeedQueued?: boolean;
  onToggleStarter?: (id: string, enabled: boolean) => void;
  onToggleSentrySetup?: () => void;
  onToggleContentFeed?: (queued: boolean) => void;
}) {
  return (
    <OnboardingLayout
      step="automations"
      compact={chrome.compact}
      title="Put Omnyo to work"
      description="Each one runs on a schedule and uses your agent when it does."
      footerNote={
        scheduledIds.size === 0 ? null : `${scheduledIds.size} scheduled`
      }
      primaryLabel="Continue"
      onPrimary={chrome.onPrimary ?? noop}
      onBack={chrome.onBack ?? noop}
      steps={ONBOARDING_STEPS}
      onSelectStep={chrome.onSelectStep ?? noop}
      onSkipAll={chrome.onSkipAll ?? noop}
      previousStep={chrome.previousStep ?? null}
    >
      <AutomationsStep
        projects={
          noProject
            ? []
            : [
                { id: "omnyo", name: "Omnyo" },
                { id: "acme-web", name: "acme-web" },
              ]
        }
        projectId={noProject ? null : "omnyo"}
        agentName="Claude Code"
        starters={ONBOARDING_STARTERS.map((starter) => ({
          id: starter.id,
          name: starter.name,
          description: starter.description,
          scheduleLabel: starter.scheduleLabel,
          icon: STORY_STARTER_ICONS[starter.id],
          enabled: scheduledIds.has(starter.id),
          pending: pendingIds.has(starter.id),
        }))}
        sentry={
          sentry === "hidden"
            ? { status: "hidden" }
            : {
                status: "detected",
                projectName: "Omnyo",
                open: sentry === "open",
                setup: (
                  <p className="text-xs text-muted-foreground">
                    The Sentry plugin's own settings render here: paste a Sentry
                    token, then map Sentry projects to repositories.
                  </p>
                ),
              }
        }
        contentFeedQueued={contentFeedQueued}
        onSelectProject={noop}
        onToggleStarter={onToggleStarter}
        onToggleSentrySetup={onToggleSentrySetup}
        onToggleContentFeed={onToggleContentFeed}
      />
    </OnboardingLayout>
  );
}

function DevicesFrame({
  connect = { status: "off" },
  connectSetupOpen = false,
  otherMachineCount = 0,
  onToggleConnectSetup = noop,
  ...chrome
}: StepChromeProps & {
  connect?: OnboardingConnectState;
  connectSetupOpen?: boolean;
  otherMachineCount?: number;
  onToggleConnectSetup?: () => void;
}) {
  return (
    <OnboardingLayout
      step="devices"
      compact={chrome.compact}
      title="Use Omnyo from anywhere"
      description="All optional. Everything here also lives in Settings → Machines."
      primaryLabel="Start using Omnyo"
      onPrimary={chrome.onPrimary ?? noop}
      onBack={chrome.onBack ?? noop}
      steps={ONBOARDING_STEPS}
      onSelectStep={chrome.onSelectStep ?? noop}
      onSkipAll={chrome.onSkipAll ?? noop}
      previousStep={chrome.previousStep ?? null}
    >
      <DevicesStep
        connect={connect}
        connectSetup={
          <p className="text-xs text-muted-foreground">
            The Omnyo connect plugin's own settings render here: sign in to your
            Omnyo account, then turn on remote access.
          </p>
        }
        connectSetupOpen={connectSetupOpen}
        otherMachineCount={otherMachineCount}
        onToggleConnectSetup={onToggleConnectSetup}
        onCopyConnectUrl={noop}
        onAddMachine={noop}
      />
    </OnboardingLayout>
  );
}

function HomeFrame() {
  return (
    <div className="mx-auto flex w-full max-w-[760px] flex-1 flex-col px-6 pt-14">
      <p className="rounded-lg border border-border px-3 py-6 text-sm text-muted-foreground">
        The usual Omnyo home composer goes here.
      </p>
    </div>
  );
}

type Scenario = "ready" | "signedOut" | "nothing";

const SCENARIOS: readonly { id: Scenario; label: string }[] = [
  { id: "ready", label: "Already signed in" },
  { id: "signedOut", label: "Installed, signed out" },
  { id: "nothing", label: "Nothing installed" },
];

function scenarioStates(scenario: Scenario): AgentStates {
  switch (scenario) {
    case "ready":
      return { "claude-code": CLAUDE_READY, codex: SIGNED_OUT, pi: INSTALL };
    case "signedOut":
      return { "claude-code": SIGNED_OUT, codex: INSTALL, pi: INSTALL };
    case "nothing":
      return { "claude-code": INSTALL, codex: INSTALL, pi: INSTALL };
  }
}

function isAgentId(id: string): id is AgentId {
  return id === "claude-code" || id === "codex" || id === "pi";
}

function InteractiveFlowRun({
  scenario,
  fullscreen = false,
}: {
  scenario: Scenario;
  fullscreen?: boolean;
}) {
  const [view, setView] = useState<OnboardingStepId | "home">("agent");

  const [viewHistory, setViewHistory] = useState<{
    view: OnboardingStepId | "home";
    previous: OnboardingStepId | null;
  }>({ view, previous: null });

  if (viewHistory.view !== view) {
    setViewHistory({
      view,
      previous: viewHistory.view === "home" ? null : viewHistory.view,
    });
  }

  const [agentStates, setAgentStates] = useState<AgentStates | null>(null);
  const [scanning, setScanning] = useState(true);

  const [selectedRepoIds, setSelectedRepoIds] = useState<ReadonlySet<string>>(
    () => new Set(DEFAULT_REPO_IDS),
  );

  const [disabledPluginIds, setDisabledPluginIds] = useState<
    ReadonlySet<string>
  >(() => new Set());

  const [connectSetupOpen, setConnectSetupOpen] = useState(false);

  const [scheduledIds, setScheduledIds] = useState<ReadonlySet<string>>(
    () => new Set(),
  );

  const [sentryOpen, setSentryOpen] = useState(false);
  const [contentFeedQueued, setContentFeedQueued] = useState(false);
  const timers = useRef<number[]>([]);

  const later = (delayMs: number, run: () => void) => {
    timers.current.push(window.setTimeout(run, delayMs));
  };

  useEffect(() => {
    const pending = timers.current;
    pending.push(
      window.setTimeout(() => setAgentStates(scenarioStates(scenario)), 700),
      window.setTimeout(() => setScanning(false), 1500),
    );

    return () => {
      for (const timer of pending) window.clearTimeout(timer);
    };
  }, [scenario]);

  const setAgent = (id: string, state: AgentSetupState) => {
    if (!isAgentId(id)) return;
    setAgentStates((current) =>
      current === null ? current : { ...current, [id]: state },
    );
  };

  const resolveAgent = (
    id: string,
    from: AgentSetupState["status"],
    to: AgentSetupState,
  ) => {
    if (!isAgentId(id)) return;
    setAgentStates((current) =>
      current !== null && current[id].status === from
        ? { ...current, [id]: to }
        : current,
    );
  };

  const chrome = {
    previousStep: viewHistory.previous,
    onSelectStep: setView,
    onSkipAll: () => setView("home"),
  };

  const states = agentStates ?? {
    "claude-code": CHECKING,
    codex: CHECKING,
    pi: CHECKING,
  };

  if (view === "home") {
    return (
      <StoryWindow fullscreen={fullscreen}>
        <HomeFrame />
      </StoryWindow>
    );
  }

  const stage = (
    <OnboardingStage
      className="w-[46%] shrink-0"
      step={view}
      machineName={MACHINE_NAME}
      agents={AGENT_BASE.filter(
        (agent) => agentStates?.[agent.id].status === "ready",
      ).map((agent) => ({
        id: agent.id,
        name: agent.name,
        provider: { id: agent.id, logoUrl: agent.logoUrl },
      }))}
      projects={REPOS.filter(
        (repo) =>
          view !== "agent" && (repo.added || selectedRepoIds.has(repo.id)),
      ).map((repo) => ({
        id: repo.id,
        name: repo.name,
        chats:
          view === "chats" || view === "plugins" || view === "devices"
            ? STAGE_CHATS.filter((chat) => chat.repoId === repo.id)
            : [],
      }))}
      browserConnected={false}
      plugins={PLUGINS.filter(
        (plugin) => !disabledPluginIds.has(plugin.id),
      ).map((plugin) => ({
        id: plugin.id,
        name: plugin.name ?? plugin.id,
        icon: plugin.icon,
      }))}
      scheduled={ONBOARDING_STARTERS.filter((starter) =>
        scheduledIds.has(starter.id),
      ).map((starter) => ({
        id: starter.id,
        name: starter.name,
        scheduleLabel: starter.scheduleLabel,
      }))}
      remoteAccess={false}
      otherMachineCount={0}
    />
  );

  return (
    <StoryWindow wide fullscreen={fullscreen}>
      <div className="flex min-h-0 flex-1">
        <div className="flex min-w-0 flex-1 flex-col">
          {view === "agent" ? (
            <AgentFrame
              {...chrome}
              states={states}
              loading={agentStates === null}
              onPrimary={() => setView("projects")}
              onSecondary={() => setView("projects")}
              onSignIn={(id) => {
                setAgent(id, { status: "signingIn" });
                later(2400, () =>
                  resolveAgent(
                    id,
                    "signingIn",
                    id === "codex" ? CODEX_READY : CLAUDE_READY,
                  ),
                );
              }}
              onInstall={(id) => {
                setAgent(id, { status: "installing" });
                later(1800, () => resolveAgent(id, "installing", SIGNED_OUT));
              }}
              onCancelSignIn={(id) => setAgent(id, SIGNED_OUT)}
            />
          ) : null}
          {view === "projects" ? (
            <ProjectsFrame
              {...chrome}
              status={
                scanning
                  ? { kind: "scanning" }
                  : { kind: "results", truncated: false }
              }
              selectedIds={selectedRepoIds}
              onToggle={(id) =>
                setSelectedRepoIds((current) => {
                  const next = new Set(current);

                  if (next.has(id)) next.delete(id);
                  else next.add(id);

                  return next;
                })
              }
              onSelectAll={() =>
                setSelectedRepoIds(
                  new Set(
                    REPOS.filter((repo) => !repo.added).map((repo) => repo.id),
                  ),
                )
              }
              onSelectNone={() => setSelectedRepoIds(new Set())}
              onPrimary={() => setView("chats")}
              onSecondary={() => setView("chats")}
              onBack={() => setView("agent")}
            />
          ) : null}
          {view === "chats" ? (
            <ChatsFrame
              {...chrome}
              onPrimary={() => setView("plugins")}
              onSecondary={() => setView("plugins")}
              onBack={() => setView("projects")}
            />
          ) : null}
          {view === "plugins" ? (
            <PluginsFrame
              {...chrome}
              disabledIds={disabledPluginIds}
              onToggle={(id, enabled) =>
                setDisabledPluginIds((current) => {
                  const next = new Set(current);

                  if (enabled) next.delete(id);
                  else next.add(id);

                  return next;
                })
              }
              onPrimary={() => setView("automations")}
              onBack={() => setView("chats")}
            />
          ) : null}
          {view === "automations" ? (
            <AutomationsFrame
              {...chrome}
              scheduledIds={scheduledIds}
              sentry={sentryOpen ? "open" : "detected"}
              contentFeedQueued={contentFeedQueued}
              onToggleStarter={(id, enabled) =>
                setScheduledIds((current) => {
                  const next = new Set(current);

                  if (enabled) next.add(id);
                  else next.delete(id);

                  return next;
                })
              }
              onToggleSentrySetup={() => setSentryOpen((open) => !open)}
              onToggleContentFeed={setContentFeedQueued}
              onPrimary={() => setView("devices")}
              onBack={() => setView("plugins")}
            />
          ) : null}
          {view === "devices" ? (
            <DevicesFrame
              {...chrome}
              connectSetupOpen={connectSetupOpen}
              onToggleConnectSetup={() => setConnectSetupOpen((open) => !open)}
              onPrimary={() => setView("home")}
              onBack={() => setView("automations")}
            />
          ) : null}
        </div>
        {stage}
      </div>
    </StoryWindow>
  );
}

export function FullFirstRun() {
  const [started, setStarted] = useState(false);
  const [introPlaying, setIntroPlaying] = useState(false);

  if (!started) {
    return (
      <div className="flex h-dvh flex-col items-center justify-center gap-6 bg-background text-foreground">
        <OnboardingMark className="size-12 text-foreground" />
        <Button
          size="lg"
          onClick={() => {
            setStarted(true);
            setIntroPlaying(true);
          }}
        >
          Start first run
        </Button>
        <p className="text-xs text-muted-foreground">
          Plays the intro with sound, then setup. Reload to start over.
        </p>
      </div>
    );
  }

  return (
    <>
      <InteractiveFlowRun scenario="signedOut" fullscreen />
      {introPlaying ? (
        <OnboardingIntro onDone={() => setIntroPlaying(false)} />
      ) : null}
    </>
  );
}

export function Intro() {
  const [run, setRun] = useState(0);
  const [playing, setPlaying] = useState(true);

  return (
    <div className="flex h-dvh items-center justify-center">
      <Button
        variant="outline"
        onClick={() => {
          setRun((current) => current + 1);
          setPlaying(true);
        }}
      >
        Play intro again
      </Button>
      {playing ? (
        <OnboardingIntro key={run} onDone={() => setPlaying(false)} />
      ) : null}
    </div>
  );
}

export function InteractiveFlow() {
  const [scenario, setScenario] = useState<Scenario>("signedOut");
  const [run, setRun] = useState(0);

  return (
    <div className="flex flex-col items-center gap-4 p-6">
      <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
        <span>This computer starts with:</span>
        {SCENARIOS.map((entry) => (
          <button
            key={entry.id}
            type="button"
            onClick={() => {
              setScenario(entry.id);
              setRun((current) => current + 1);
            }}
            className={cn(
              "rounded-full border px-2.5 py-1",
              entry.id === scenario
                ? "border-foreground text-foreground"
                : "border-border hover:text-foreground",
            )}
          >
            {entry.label}
          </button>
        ))}
        <Button
          size="sm"
          variant="ghost"
          onClick={() => setRun((current) => current + 1)}
        >
          Restart
        </Button>
      </div>
      <InteractiveFlowRun key={`${scenario}:${run}`} scenario={scenario} />
    </div>
  );
}

export function Step1AgentStates() {
  return (
    <Gallery>
      <Captioned
        label="An agent is already signed in"
        hint="The common case: Continue is the only action."
      >
        <StoryWindow>
          <AgentFrame
            states={{
              "claude-code": CLAUDE_READY,
              codex: SIGNED_OUT,
              pi: INSTALL,
            }}
          />
        </StoryWindow>
      </Captioned>
      <Captioned
        label="Waiting for the machine, then loading"
        hint="No machine yet shows a waiting line; a connected machine shows skeleton rows until health answers."
      >
        <StoryWindow>
          <AgentFrame
            loading
            machineName={null}
            states={{ "claude-code": CHECKING, codex: CHECKING, pi: CHECKING }}
          />
        </StoryWindow>
      </Captioned>
      <Captioned
        label="Signing in with a pasted code (Claude Code)"
        hint="The login command runs in a hidden terminal; Omnyo lifts the sign-in link out of its output and types the pasted code back in."
      >
        <StoryWindow>
          <AgentFrame
            states={{
              "claude-code": { status: "signingIn" },
              codex: { status: "signIn", reason: "expired", canSignIn: true },
              pi: INSTALL,
            }}
          />
        </StoryWindow>
      </Captioned>
      <Captioned
        label="Signing in with a device code (Codex)"
        hint="The code and link come from the login command's output; the CLI finishes on its own once the code is entered."
      >
        <StoryWindow>
          <AgentFrame
            states={{
              "claude-code": {
                status: "signIn",
                reason: "failed",
                canSignIn: true,
              },
              codex: { status: "signingIn" },
              pi: INSTALL,
            }}
          />
        </StoryWindow>
      </Captioned>
      <Captioned
        label="Sign-in starting, and the terminal fallback"
        hint="If no link shows up within a few seconds, or on request, the raw terminal is shown so any agent's login still works."
      >
        <StoryWindow>
          <AgentFrame
            signInVariant="starting"
            states={{
              "claude-code": { status: "signingIn" },
              codex: SIGNED_OUT,
              pi: INSTALL,
            }}
          />
        </StoryWindow>
        <StoryWindow>
          <AgentFrame
            signInVariant="terminal"
            states={{
              "claude-code": SIGNED_OUT,
              codex: SIGNED_OUT,
              pi: { status: "signingIn" },
            }}
          />
        </StoryWindow>
      </Captioned>
      <Captioned
        label="Installing, failed, update needed, unknown"
        hint="Install and Update reuse the provider CLI install action. A failed install offers its log. Unknown health never blocks or nags."
      >
        <StoryWindow>
          <AgentFrame
            states={{
              "claude-code": { status: "installing" },
              codex: {
                status: "installFailed",
                message: "Install failed",
                canInstall: true,
              },
              pi: {
                status: "update",
                detail: "Needs version 0.84.0 or newer",
                canInstall: true,
              },
            }}
          />
        </StoryWindow>
      </Captioned>
      <Captioned
        label="Phone width"
        hint="Step labels collapse to the active one."
      >
        <StoryWindow compact>
          <AgentFrame
            compact
            states={{
              "claude-code": CLAUDE_READY,
              codex: SIGNED_OUT,
              pi: { status: "unknown", message: "Machine is paused." },
            }}
          />
        </StoryWindow>
      </Captioned>
    </Gallery>
  );
}

export function Step2ProjectStates() {
  return (
    <Gallery>
      <Captioned
        label="Recent repos found"
        hint="Repos touched in the last week are preselected; repos that are already projects are checked and locked."
      >
        <StoryWindow>
          <ProjectsFrame />
        </StoryWindow>
      </Captioned>
      <Captioned
        label="Scanning"
        hint="The scan starts as soon as setup opens."
      >
        <StoryWindow>
          <ProjectsFrame status={{ kind: "scanning" }} />
        </StoryWindow>
      </Captioned>
      <Captioned
        label="Importing, with a truncated scan"
        hint="Projects are created one at a time; the note appears when the walk ran out of time."
      >
        <StoryWindow>
          <ProjectsFrame
            importing
            status={{ kind: "results", truncated: true }}
          />
        </StoryWindow>
      </Captioned>
      <Captioned label="Nothing found" hint="Falls back to the folder picker.">
        <StoryWindow>
          <ProjectsFrame repos={[]} selectedIds={new Set()} />
        </StoryWindow>
      </Captioned>
      <Captioned label="Scan failed" hint="Retry, or pick a folder by hand.">
        <StoryWindow>
          <ProjectsFrame
            repos={[]}
            selectedIds={new Set()}
            status={{
              kind: "error",
              message: "Omnyo couldn't scan this computer for git repos.",
            }}
          />
        </StoryWindow>
      </Captioned>
    </Gallery>
  );
}

export function StepChats() {
  return (
    <Gallery>
      <Captioned
        label="Chat import"
        hint="Between Projects and Plugins. The step embeds the Chat import plugin's settings section and is hidden when that plugin is off."
      >
        <StoryWindow>
          <ChatsFrame />
        </StoryWindow>
      </Captioned>
    </Gallery>
  );
}

export function Step3Plugins() {
  return (
    <Gallery>
      <Captioned
        label="Recommended plugins, all on"
        hint="Every plugin a new install turns on by default, grouped; infrastructure plugins stay hidden."
      >
        <StoryWindow>
          <PluginsFrame />
        </StoryWindow>
      </Captioned>
      <Captioned
        label="Two turned off, one switching"
        hint="Turning a plugin off applies at once; the main button drops 'with recommended'."
      >
        <StoryWindow>
          <PluginsFrame
            disabledIds={new Set(["sentry", "stats"])}
            pendingIds={new Set(["canvas"])}
          />
        </StoryWindow>
      </Captioned>
      <Captioned label="Loading" hint="Before the plugin list answers.">
        <StoryWindow>
          <PluginsFrame loading />
        </StoryWindow>
      </Captioned>
    </Gallery>
  );
}

export function StepAutomations() {
  return (
    <Gallery>
      <Captioned
        label="Starters, all off"
        hint="Sentry shows only when the chosen project uses a Sentry SDK."
      >
        <StoryWindow>
          <AutomationsFrame sentry="detected" />
        </StoryWindow>
      </Captioned>
      <Captioned
        label="Briefing scheduled, Sentry connecting, Content Feed queued"
        hint="The Content Feed setup opens when the guide finishes."
      >
        <StoryWindow>
          <AutomationsFrame
            scheduledIds={new Set(["briefing"])}
            pendingIds={new Set(["dependencies"])}
            sentry="open"
            contentFeedQueued
          />
        </StoryWindow>
      </Captioned>
      <Captioned
        label="No project yet"
        hint="Starters need a project to run in."
      >
        <StoryWindow>
          <AutomationsFrame noProject />
        </StoryWindow>
      </Captioned>
    </Gallery>
  );
}

export function Step4Devices() {
  return (
    <Gallery>
      <Captioned label="Default" hint="Three optional rows.">
        <StoryWindow>
          <DevicesFrame />
        </StoryWindow>
      </Captioned>
      <Captioned
        label="Setting up Omnyo connect"
        hint="The connect plugin's settings section is embedded in the row."
      >
        <StoryWindow>
          <DevicesFrame connectSetupOpen />
        </StoryWindow>
      </Captioned>
      <Captioned
        label="Omnyo connect on, another machine already connected"
        hint="The address is copyable; Add machine opens the existing dialog."
      >
        <StoryWindow>
          <DevicesFrame
            connect={{ status: "on", url: CONNECT_URL }}
            otherMachineCount={1}
          />
        </StoryWindow>
      </Captioned>
      <Captioned
        label="Omnyo connect plugin disabled"
        hint="The browser-access row is hidden when the plugin is off."
      >
        <StoryWindow>
          <DevicesFrame connect={{ status: "unavailable" }} />
        </StoryWindow>
      </Captioned>
    </Gallery>
  );
}

export function HomeAfterSkipping() {
  return (
    <Gallery>
      <Captioned
        label="Home after Skip setup"
        hint="The home composer is ready."
      >
        <StoryWindow>
          <HomeFrame />
        </StoryWindow>
      </Captioned>
    </Gallery>
  );
}
