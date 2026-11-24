import "./onboarding-brand.css";

import type { CSSProperties, ReactNode } from "react";
import type { ExperimentalProviderIconProps } from "@omnyo/plugin-sdk/app";
import { Button } from "@omnyo/shared-ui/button";
import { Checkbox } from "@omnyo/shared-ui/checkbox";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@omnyo/shared-ui/dropdown-menu";
import { Icon, type IconName } from "@omnyo/shared-ui/icon";
import { Switch } from "@omnyo/shared-ui/switch";
import { cn } from "@omnyo/shared-ui/lib/utils";
import { PluginIcon } from "@/components/plugin/PluginIcon";
import { ProviderIcon } from "@/components/plugin/ProviderIcon";
import { BrowserSourceIcon } from "@/components/settings/BrowserSourceIcon";
import {
  MACOS_APP_REGION_NO_DRAG_CLASS,
  MACOS_WINDOW_DRAG_CLASS,
} from "@/lib/omnyo-desktop";
import type {
  AgentSetupState,
  OnboardingStep,
  OnboardingStepId,
  SignInGuide,
} from "./onboarding-model";
import { OnboardingMark } from "./OnboardingMark";
import type { OnboardingProviderId } from "./provider-selection";
import {
  ONBOARDING_PROVIDERS,
  matchesOnboardingProvider,
} from "./provider-selection";

const CONTENT_COLUMN_CLASS = "mx-auto w-full max-w-[560px] px-6";

export interface OnboardingStepChrome {
  compact: boolean;
  reserveMacosTrafficLights: boolean;
  steps: readonly OnboardingStep[];
  previousStep: OnboardingStepId | null;
  onSelectStep: (step: OnboardingStepId) => void;
  onSkipAll: () => void;
}

interface OnboardingLayoutProps {
  step: OnboardingStepId;
  steps: readonly OnboardingStep[];
  compact?: boolean;
  reserveMacosTrafficLights?: boolean;
  previousStep?: OnboardingStepId | null;
  title: string;
  description: ReactNode;
  children: ReactNode;
  footerNote?: ReactNode;
  primaryLabel: string;
  primaryDisabled?: boolean;
  primaryBusy?: boolean;
  secondaryLabel?: string;
  onPrimary: () => void;
  onSecondary?: () => void;
  onBack?: () => void;
  onSelectStep: (step: OnboardingStepId) => void;
  onSkipAll: () => void;
}

type ProgressMotion = "fill" | "complete" | "retract" | "reopen";

function progressMotion(
  index: number,
  activeIndex: number,
  previousIndex: number,
): ProgressMotion | undefined {
  if (previousIndex === -1 || previousIndex === activeIndex) return undefined;

  if (previousIndex < activeIndex) {
    if (index === activeIndex) return "fill";

    if (index >= previousIndex && index < activeIndex) return "complete";

    return undefined;
  }

  if (index === activeIndex) return "reopen";

  if (index > activeIndex && index <= previousIndex) return "retract";

  return undefined;
}

function OnboardingProgress({
  steps,
  activeIndex,
  previousIndex,
  compact,
  onSelectStep,
}: {
  steps: readonly OnboardingStep[];
  activeIndex: number;
  previousIndex: number;
  compact: boolean;
  onSelectStep: (step: OnboardingStepId) => void;
}) {
  return (
    <nav
      aria-label="Setup steps"
      className="omnyo-onboarding-steps flex min-w-0 flex-1 items-center justify-center gap-1.5"
    >
      {steps.map((entry, index) => {
        const done = index < activeIndex;
        const active = index === activeIndex;
        const motion = progressMotion(index, activeIndex, previousIndex);

        const stagger =
          motion === "retract"
            ? previousIndex - index
            : motion === "complete"
              ? index - previousIndex
              : 0;

        return (
          <button
            key={entry.id}
            type="button"
            disabled={!done}
            aria-current={active ? "step" : undefined}
            aria-label={`Step ${index + 1}: ${entry.label}`}
            onClick={() => onSelectStep(entry.id)}
            data-motion={motion}
            style={{ "--step-stagger": stagger } as CSSProperties}
            className={cn(
              "group/step flex flex-col gap-1.5 rounded-sm pt-1 text-left text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
              compact ? "w-8" : "w-20",
              MACOS_APP_REGION_NO_DRAG_CLASS,
              active && "text-foreground",
              done && "text-subtle-foreground hover:text-foreground",
              !active && !done && "text-muted-foreground",
            )}
          >
            {compact ? null : (
              <span className="flex items-center truncate">
                {done || motion === "reopen" ? (
                  <span
                    aria-hidden
                    className="omnyo-onboarding-step-check flex w-4 shrink-0 overflow-hidden"
                  >
                    <Icon
                      name="Check"
                      aria-hidden
                      className="size-3 shrink-0 text-success"
                    />
                  </span>
                ) : null}
                <span className="truncate">{entry.label}</span>
              </span>
            )}
            <span
              aria-hidden
              className="relative h-0.5 w-full rounded-full bg-border"
            >
              <span
                data-filled={done || active}
                className={cn(
                  "omnyo-onboarding-step-fill absolute inset-0 rounded-full bg-foreground",
                  done && "opacity-50 group-hover/step:opacity-100",
                )}
              />
              {motion === "fill" ? (
                <span className="omnyo-onboarding-step-comet" />
              ) : null}
            </span>
          </button>
        );
      })}
    </nav>
  );
}

export function OnboardingLayout({
  step,
  steps,
  compact = false,
  reserveMacosTrafficLights = false,
  previousStep = null,
  title,
  description,
  children,
  footerNote,
  primaryLabel,
  primaryDisabled = false,
  primaryBusy = false,
  secondaryLabel,
  onPrimary,
  onSecondary,
  onBack,
  onSelectStep,
  onSkipAll,
}: OnboardingLayoutProps) {
  const activeIndex = steps.findIndex((entry) => entry.id === step);
  const revealStep = previousStep !== null;

  return (
    <div
      data-testid="onboarding"
      className="flex min-h-0 flex-1 flex-col bg-background text-foreground"
    >
      <header
        className={cn(
          "flex h-14 shrink-0 items-center gap-3 pr-4",
          reserveMacosTrafficLights
            ? cn("pl-[84px]", MACOS_WINDOW_DRAG_CLASS)
            : "pl-4",
        )}
      >
        <OnboardingMark className="size-5 shrink-0 text-foreground" />
        <OnboardingProgress
          steps={steps}
          activeIndex={activeIndex}
          previousIndex={
            previousStep === null
              ? -1
              : steps.findIndex((entry) => entry.id === previousStep)
          }
          compact={compact}
          onSelectStep={onSelectStep}
        />
        <Button
          variant="ghost"
          size="sm"
          className={cn(
            "shrink-0 text-muted-foreground",
            MACOS_APP_REGION_NO_DRAG_CLASS,
          )}
          onClick={onSkipAll}
        >
          Skip setup
        </Button>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div
          key={step}
          className={cn(
            CONTENT_COLUMN_CLASS,
            "flex flex-col",
            compact ? "gap-6 py-4" : "min-h-full justify-center gap-8 py-12",
            revealStep &&
              "animate-in fade-in-0 slide-in-from-bottom-1.5 duration-(--motion-duration-base) ease-out",
          )}
        >
          <div className="flex flex-col gap-2">
            <h1
              className={cn(
                "text-balance font-semibold tracking-tight",
                compact ? "text-2xl" : "text-display",
              )}
            >
              {title}
            </h1>
            <p
              className={cn(
                "text-pretty text-muted-foreground",
                compact ? "text-sm" : "text-base",
              )}
            >
              {description}
            </p>
          </div>
          {children}
        </div>
      </div>
      <footer className="shrink-0 border-t border-border-hairline">
        <div
          className={cn(CONTENT_COLUMN_CLASS, "flex items-center gap-2 py-3")}
        >
          {onBack ? (
            <Button variant="ghost" size="sm" onClick={onBack}>
              <Icon name="ArrowLeft" aria-hidden />
              Back
            </Button>
          ) : null}
          <span className="min-w-0 flex-1 text-xs text-muted-foreground">
            {footerNote}
          </span>
          {secondaryLabel && onSecondary ? (
            <Button variant="ghost" size="sm" onClick={onSecondary}>
              {secondaryLabel}
            </Button>
          ) : null}
          <Button
            className="min-w-28"
            disabled={primaryDisabled || primaryBusy}
            onClick={onPrimary}
          >
            {primaryBusy ? (
              <Icon name="Spinner" aria-hidden className="animate-spin" />
            ) : null}
            {primaryLabel}
            {primaryBusy ? null : <Icon name="ArrowRight" aria-hidden />}
          </Button>
        </div>
      </footer>
    </div>
  );
}

export interface OnboardingAgent {
  id: string;
  name: string;
  provider: ExperimentalProviderIconProps["provider"];
  state: AgentSetupState;
  expanded?: ReactNode;
}

function agentSubline(state: AgentSetupState): string {
  switch (state.status) {
    case "checking":
      return "Checking…";
    case "ready":
      return state.detail ?? "Signed in";
    case "signIn":
      return state.reason === "failed"
        ? "Sign-in didn't finish · try again"
        : state.reason === "expired"
          ? "Installed · your session expired"
          : "Installed · not signed in";
    case "signingIn":
      return "Finish signing in below";
    case "install":
      return "Not installed";
    case "update":
      return state.detail ?? "Update needed";
    case "installing":
      return "Installing…";
    case "installFailed":
      return state.message;
    case "unknown":
      return state.message ?? "Couldn't check this agent";
  }
}

interface AgentRowHandlers {
  onSignIn: (id: string) => void;
  onInstall: (id: string) => void;
  onViewInstallLog: (id: string) => void;
  onCancelSignIn: (id: string) => void;
}

function AgentRow({
  agent,
  onSignIn,
  onInstall,
  onViewInstallLog,
  onCancelSignIn,
  hideIdentity = false,
}: AgentRowHandlers & { agent: OnboardingAgent; hideIdentity?: boolean }) {
  const { state } = agent;

  return (
    <li className="px-4 py-3.5" data-agent-id={agent.id}>
      <div className="flex items-center gap-3">
        {hideIdentity ? null : (
          <span className="flex size-10 shrink-0 items-center justify-center rounded-lg border border-border-hairline bg-surface-recessed">
            <ProviderIcon
              providerKind="agent"
              provider={agent.provider}
              className={cn(
                "size-5",
                state.status === "install" && "text-muted-foreground",
              )}
            />
          </span>
        )}
        <div className="flex min-w-0 flex-1 flex-col">
          {hideIdentity ? null : (
            <span className="text-sm font-medium">{agent.name}</span>
          )}
          <span
            className={cn(
              "truncate text-xs text-muted-foreground",
              state.status === "installFailed" && "text-destructive-text",
            )}
          >
            {agentSubline(state)}
          </span>
        </div>
        {state.status === "checking" || state.status === "installing" ? (
          <Icon
            name="Spinner"
            aria-hidden
            className="size-4 animate-spin text-muted-foreground"
          />
        ) : null}
        {state.status === "ready" ? (
          <span className="flex items-center gap-1 rounded-full bg-success/12 py-1 pl-1.5 pr-2.5 text-xs font-medium text-success">
            <Icon name="CircleCheck" aria-hidden className="size-3.5" />
            Ready
          </span>
        ) : null}
        {state.status === "signIn" && state.canSignIn ? (
          <Button size="sm" onClick={() => onSignIn(agent.id)}>
            Sign in
          </Button>
        ) : null}
        {state.status === "installFailed" ? (
          <Button
            size="sm"
            variant="ghost"
            onClick={() => onViewInstallLog(agent.id)}
          >
            View log
          </Button>
        ) : null}
        {(state.status === "install" ||
          state.status === "update" ||
          state.status === "installFailed") &&
        state.canInstall ? (
          <Button
            size="sm"
            variant="outline"
            onClick={() => onInstall(agent.id)}
          >
            <Icon name="Download" aria-hidden />
            {state.status === "installFailed"
              ? "Retry"
              : state.status === "update"
                ? "Update"
                : "Install"}
          </Button>
        ) : null}
        {state.status === "signingIn" ? (
          <Button
            size="sm"
            variant="ghost"
            onClick={() => onCancelSignIn(agent.id)}
          >
            Cancel
          </Button>
        ) : null}
      </div>
      {agent.expanded}
    </li>
  );
}

interface AgentStepProps extends AgentRowHandlers {
  machineName: string | null;
  agents: readonly OnboardingAgent[] | null;
  onRecheck: () => void;
  choices?: readonly OnboardingProviderChoice[];
  onToggleProvider?: (id: OnboardingProviderId, enabled: boolean) => void;
}

export interface OnboardingProviderChoice {
  id: OnboardingProviderId;
  name: string;
  selected: boolean;
  disabled: boolean;
  detail: string;
  provider: ExperimentalProviderIconProps["provider"];
  agents: readonly OnboardingAgent[];
}

export function AgentStep({
  machineName,
  agents,
  onRecheck,
  choices,
  onToggleProvider,
  ...rowHandlers
}: AgentStepProps) {
  const additionalAgents =
    choices === undefined
      ? []
      : (agents ?? []).filter(
          (agent) =>
            !ONBOARDING_PROVIDERS.some((provider) =>
              matchesOnboardingProvider(provider.id, agent.id),
            ),
        );

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <Icon name="Laptop" aria-hidden className="size-3.5" />
        <span className="min-w-0 flex-1 truncate">
          {machineName === null
            ? "Waiting for this computer to connect…"
            : `On ${machineName}`}
        </span>
        {machineName === null ? null : (
          <button
            type="button"
            onClick={onRecheck}
            className="flex items-center gap-1 rounded-sm hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
          >
            <Icon
              name="ArrowReloadHorizontal"
              aria-hidden
              className="size-3.5"
            />
            Check again
          </button>
        )}
      </div>
      {choices !== undefined ? (
        <ul className="divide-y divide-border-hairline overflow-hidden rounded-xl border border-border bg-card shadow-xs">
          {choices.map((choice) => (
            <li key={choice.id}>
              <div className="flex items-center gap-3 px-4 py-3.5">
                <span className="flex size-10 shrink-0 items-center justify-center rounded-lg border border-border-hairline bg-surface-recessed">
                  <ProviderIcon
                    providerKind="agent"
                    provider={choice.provider}
                    className="size-5"
                  />
                </span>
                <div className="flex min-w-0 flex-1 flex-col">
                  <span className="text-sm font-medium">{choice.name}</span>
                  <span className="text-xs text-muted-foreground">
                    {choice.detail}
                  </span>
                </div>
                <Switch
                  aria-label={`Enable ${choice.name}`}
                  checked={choice.selected}
                  disabled={choice.disabled}
                  onCheckedChange={(enabled) =>
                    onToggleProvider?.(choice.id, enabled)
                  }
                />
              </div>
              {choice.selected && choice.agents.length > 0 ? (
                <ul className="border-t border-border-hairline">
                  {choice.agents.map((agent) => (
                    <AgentRow
                      key={agent.id}
                      agent={agent}
                      hideIdentity={choice.id !== "acp"}
                      {...rowHandlers}
                    />
                  ))}
                </ul>
              ) : null}
            </li>
          ))}
        </ul>
      ) : agents === null ? (
        <ul className="divide-y divide-border-hairline overflow-hidden rounded-xl border border-border bg-card shadow-xs">
          {[0, 1, 2].map((index) => (
            <li key={index} className="flex items-center gap-3 px-4 py-3.5">
              <span className="size-10 rounded-lg bg-state-hover" />
              <span className="flex flex-1 flex-col gap-1.5">
                <span className="h-3 w-28 rounded-sm bg-state-hover" />
                <span className="h-2.5 w-40 rounded-sm bg-state-hover" />
              </span>
            </li>
          ))}
        </ul>
      ) : (
        <ul className="divide-y divide-border-hairline overflow-hidden rounded-xl border border-border bg-card shadow-xs">
          {agents.map((agent) => (
            <AgentRow key={agent.id} agent={agent} {...rowHandlers} />
          ))}
        </ul>
      )}
      {additionalAgents.length > 0 ? (
        <div className="flex flex-col gap-2">
          <p className="text-xs text-muted-foreground">Other providers</p>
          <ul className="divide-y divide-border-hairline overflow-hidden rounded-xl border border-border bg-card shadow-xs">
            {additionalAgents.map((agent) => (
              <AgentRow key={agent.id} agent={agent} {...rowHandlers} />
            ))}
          </ul>
        </div>
      ) : null}
      {choices === undefined ? (
        <p className="text-xs text-muted-foreground">
          Don't see your agent? Omnyo picks up other ACP agents, such as
          opencode, once they are installed.
        </p>
      ) : null}
    </div>
  );
}

interface AgentSignInGuideProps {
  agentName: string;
  guide: SignInGuide | null;
  code: string;
  codeSubmitted: boolean;
  terminalVisible: boolean;
  terminal: ReactNode;
  onCodeChange: (code: string) => void;
  onSubmitCode: () => void;
  onOpenUrl: (url: string) => void;
  onCopy: (text: string) => void;
  onToggleTerminal: () => void;
  alternateLabel: string | null;
  onUseAlternate: () => void;
}

export function AgentSignInGuide({
  agentName,
  guide,
  code,
  codeSubmitted,
  terminalVisible,
  terminal,
  onCodeChange,
  onSubmitCode,
  onOpenUrl,
  onCopy,
  onToggleTerminal,
  alternateLabel,
  onUseAlternate,
}: AgentSignInGuideProps) {
  const url = guide?.url ?? null;
  const userCode = guide?.userCode ?? null;
  const acceptsPastedCode = guide?.acceptsPastedCode ?? false;

  return (
    <div className="mt-3 overflow-hidden rounded-md border border-border bg-surface-recessed">
      <div className="flex flex-col gap-3 p-3">
        {url === null ? (
          terminalVisible ? (
            <p className="text-xs text-muted-foreground">
              Sign in to {agentName} in the terminal below.
            </p>
          ) : (
            <p className="flex items-center gap-2 text-xs text-muted-foreground">
              <Icon
                name="Spinner"
                aria-hidden
                className="size-3.5 animate-spin"
              />
              Starting {agentName} sign-in…
            </p>
          )
        ) : (
          <>
            <p className="text-xs text-muted-foreground">
              {userCode !== null
                ? `Open the ${agentName} sign-in page and enter this code.`
                : acceptsPastedCode
                  ? `Sign in on the ${agentName} page, then paste the code it shows you.`
                  : `Finish signing in on the ${agentName} page.`}
            </p>
            {userCode === null ? null : (
              <div className="flex items-center justify-center gap-2 rounded-md border border-border bg-background px-3 py-3">
                <span
                  aria-label={`${agentName} sign-in code`}
                  className="select-all font-mono text-xl font-semibold tracking-widest"
                >
                  {userCode}
                </span>
                <Button
                  variant="ghost"
                  size="sm"
                  aria-label="Copy sign-in code"
                  onClick={() => onCopy(userCode)}
                >
                  <Icon name="Copy" aria-hidden />
                </Button>
              </div>
            )}
            <div className="flex items-center gap-2">
              <Button size="sm" onClick={() => onOpenUrl(url)}>
                Open sign-in page
                <Icon name="ExternalLink" aria-hidden />
              </Button>
              <Button
                variant="ghost"
                size="sm"
                className="text-muted-foreground"
                onClick={() => onCopy(url)}
              >
                <Icon name="Copy" aria-hidden />
                Copy link
              </Button>
            </div>
            {acceptsPastedCode && userCode === null ? (
              <form
                className="flex items-center gap-2"
                onSubmit={(event) => {
                  event.preventDefault();
                  onSubmitCode();
                }}
              >
                <input
                  value={code}
                  onChange={(event) => onCodeChange(event.target.value)}
                  aria-label={`${agentName} authorization code`}
                  placeholder="Paste the code here"
                  autoComplete="off"
                  spellCheck={false}
                  className="h-8 min-w-0 flex-1 rounded-md border border-input bg-background px-2.5 font-mono text-xs outline-none placeholder:font-sans placeholder:text-muted-foreground focus-visible:ring-1 focus-visible:ring-ring"
                />
                <Button
                  type="submit"
                  size="sm"
                  variant="outline"
                  disabled={code.trim().length === 0}
                >
                  Complete
                </Button>
              </form>
            ) : null}
          </>
        )}
      </div>
      {terminalVisible ? (
        <div className="h-48 border-t border-border-hairline">{terminal}</div>
      ) : null}
      <div className="flex items-center gap-2 border-t border-border-hairline px-3 py-2 text-xs text-muted-foreground">
        <Icon name="Spinner" aria-hidden className="size-3.5 animate-spin" />
        <span className="min-w-0 flex-1">
          {codeSubmitted
            ? "Finishing sign-in…"
            : "Omnyo continues on its own as soon as you're signed in."}
        </span>
        {alternateLabel === null ? null : (
          <button
            type="button"
            onClick={onUseAlternate}
            className="shrink-0 rounded-sm hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
          >
            {alternateLabel}
          </button>
        )}
        <button
          type="button"
          onClick={onToggleTerminal}
          className="shrink-0 rounded-sm hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
        >
          {terminalVisible ? "Hide terminal" : "Show terminal"}
        </button>
      </div>
    </div>
  );
}

export interface OnboardingRepo {
  id: string;
  name: string;
  path: string;
  lastActive: string;
  remote: string | null;
  added: boolean;
}

type ProjectsStepStatus =
  | { kind: "scanning" }
  | { kind: "error"; message: string }
  | { kind: "results"; truncated: boolean };

interface ProjectsStepProps {
  status: ProjectsStepStatus;
  repos: readonly OnboardingRepo[];
  selectedIds: ReadonlySet<string>;
  onToggle: (id: string) => void;
  onSelectAll: () => void;
  onSelectNone: () => void;
  onAddFolder: () => void;
  onRetry: () => void;
}

export function ProjectsStep({
  status,
  repos,
  selectedIds,
  onToggle,
  onSelectAll,
  onSelectNone,
  onAddFolder,
  onRetry,
}: ProjectsStepProps) {
  if (status.kind === "scanning") {
    return (
      <div className="flex flex-col gap-3">
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <Icon name="Spinner" aria-hidden className="size-3.5 animate-spin" />
          Looking for git repos you've touched recently…
        </div>
        <ul className="divide-y divide-border-hairline overflow-hidden rounded-xl border border-border bg-card shadow-xs">
          {[0, 1, 2, 3].map((index) => (
            <li key={index} className="flex items-center gap-3 px-4 py-3">
              <span className="size-4 rounded-sm bg-state-hover" />
              <span className="flex flex-1 flex-col gap-1.5">
                <span className="h-3 w-32 rounded-sm bg-state-hover" />
                <span className="h-2.5 w-56 rounded-sm bg-state-hover" />
              </span>
            </li>
          ))}
        </ul>
      </div>
    );
  }

  if (status.kind === "error" || repos.length === 0) {
    return (
      <div className="flex flex-col items-center gap-3 rounded-lg border border-dashed border-border px-6 py-10 text-center">
        <Icon
          name="FolderGit"
          aria-hidden
          className="size-6 text-muted-foreground"
        />
        <p className="text-sm text-muted-foreground">
          {status.kind === "error"
            ? status.message
            : "Omnyo didn't find a git repo you've worked in over the last 30 days."}
        </p>
        <div className="flex items-center gap-2">
          <Button size="sm" variant="outline" onClick={onRetry}>
            {status.kind === "error" ? "Try again" : "Scan again"}
          </Button>
          <Button size="sm" variant="outline" onClick={onAddFolder}>
            <Icon name="FolderPlus" aria-hidden />
            Choose a folder
          </Button>
        </div>
      </div>
    );
  }

  const selectableCount = repos.filter((repo) => !repo.added).length;

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-3 text-xs text-muted-foreground">
        <span className="min-w-0 flex-1">
          {selectedIds.size} of {selectableCount} selected
        </span>
        <button
          type="button"
          className="hover:text-foreground"
          onClick={onSelectAll}
        >
          Select all
        </button>
        <button
          type="button"
          className="hover:text-foreground"
          onClick={onSelectNone}
        >
          Select none
        </button>
      </div>
      <ul className="divide-y divide-border-hairline overflow-hidden rounded-xl border border-border bg-card shadow-xs">
        {repos.map((repo) => (
          <li key={repo.id}>
            <label
              className={cn(
                "flex items-center gap-3 px-4 py-3",
                repo.added
                  ? "text-muted-foreground"
                  : "cursor-pointer hover:bg-state-hover",
              )}
            >
              <Checkbox
                checked={repo.added || selectedIds.has(repo.id)}
                disabled={repo.added}
                onCheckedChange={() => onToggle(repo.id)}
              />
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="flex items-center gap-2">
                  <span className="truncate text-sm font-medium">
                    {repo.name}
                  </span>
                  {repo.remote ? (
                    <span className="truncate text-xs text-muted-foreground">
                      {repo.remote}
                    </span>
                  ) : null}
                </span>
                <span className="truncate font-mono text-xs text-muted-foreground">
                  {repo.path}
                </span>
              </span>
              <span className="shrink-0 text-right text-xs tabular-nums text-muted-foreground">
                {repo.added ? "Already added" : repo.lastActive}
              </span>
            </label>
          </li>
        ))}
      </ul>
      {status.truncated ? (
        <p className="text-xs text-muted-foreground">
          The scan ran out of time, so some repos may be missing.
        </p>
      ) : null}
      <button
        type="button"
        onClick={onAddFolder}
        className="flex items-center gap-2 self-start rounded-md px-2 py-1 text-xs text-muted-foreground hover:bg-state-hover hover:text-foreground"
      >
        <Icon name="FolderPlus" aria-hidden className="size-3.5" />
        Add a folder that isn't listed
      </button>
    </div>
  );
}

export interface OnboardingPluginRow {
  id: string;
  name: string;
  description: string | null;
  icon: string | null;
  enabled: boolean;
  pending: boolean;
}

export interface OnboardingPluginSection {
  id: string;
  label: string;
  plugins: readonly OnboardingPluginRow[];
}

function OnboardingPluginTile({
  plugin,
  onToggle,
}: {
  plugin: OnboardingPluginRow;
  onToggle: (id: string, enabled: boolean) => void;
}) {
  return (
    <label
      title={plugin.description ?? undefined}
      className={cn(
        "flex min-w-0 cursor-pointer items-center gap-3 rounded-xl border border-border bg-card px-3 py-2.5 shadow-xs hover:bg-state-hover",
        plugin.pending && "cursor-progress",
      )}
    >
      <span
        className={cn(
          "flex size-8 shrink-0 items-center justify-center rounded-lg border border-border-hairline bg-surface-recessed transition-opacity duration-(--motion-duration-fast) ease-standard",
          !plugin.enabled && "opacity-50",
        )}
      >
        <PluginIcon
          pluginId={plugin.id}
          icon={plugin.icon}
          className="size-4 text-subtle-foreground"
        />
      </span>
      <span
        className={cn(
          "flex min-w-0 flex-1 flex-col transition-opacity duration-(--motion-duration-fast) ease-standard",
          !plugin.enabled && "opacity-60",
        )}
      >
        <span className="truncate text-sm font-medium">{plugin.name}</span>
        {plugin.description === null ? null : (
          <span className="truncate text-xs text-muted-foreground">
            {plugin.description}
          </span>
        )}
      </span>
      {plugin.pending ? (
        <Icon
          name="Spinner"
          aria-hidden
          className="size-3.5 shrink-0 animate-spin text-muted-foreground"
        />
      ) : null}
      <Switch
        checked={plugin.enabled}
        disabled={plugin.pending}
        onCheckedChange={(next) => onToggle(plugin.id, next)}
        aria-label={`${plugin.name} on`}
      />
    </label>
  );
}

export function OnboardingPluginSections({
  sections,
  compact = false,
  onToggle,
}: {
  sections: readonly OnboardingPluginSection[] | null;
  compact?: boolean;
  onToggle: (id: string, enabled: boolean) => void;
}) {
  if (sections === null) {
    return (
      <div
        className={cn("grid gap-2", compact ? "grid-cols-1" : "grid-cols-2")}
      >
        {Array.from({ length: 8 }, (_, index) => (
          <div
            key={index}
            className="flex items-center gap-3 rounded-xl border border-border px-3 py-2.5"
          >
            <span className="size-8 rounded-lg bg-state-hover" />
            <span className="flex flex-1 flex-col gap-1.5">
              <span className="h-3 w-24 rounded-sm bg-state-hover" />
              <span className="h-2.5 w-32 rounded-sm bg-state-hover" />
            </span>
          </div>
        ))}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-6">
      {sections.map((section) => (
        <section key={section.id} className="flex flex-col gap-2">
          <h2 className="text-xs font-medium text-muted-foreground">
            {section.label}
          </h2>
          <div
            className={cn(
              "grid gap-2",
              compact ? "grid-cols-1" : "grid-cols-2",
            )}
          >
            {section.plugins.map((plugin) => (
              <OnboardingPluginTile
                key={plugin.id}
                plugin={plugin}
                onToggle={onToggle}
              />
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}

export interface OnboardingStarterCard {
  id: string;
  name: string;
  description: string;
  scheduleLabel: string;
  icon: IconName;
  enabled: boolean;
  pending: boolean;
}

export type OnboardingSentryCard =
  | { status: "hidden" }
  | {
      status: "detected";
      projectName: string;
      open: boolean;
      setup: ReactNode;
    };

interface AutomationsStepProps {
  projects: readonly { id: string; name: string }[];
  projectId: string | null;
  agentName: string | null;
  starters: readonly OnboardingStarterCard[];
  sentry: OnboardingSentryCard;
  contentFeedQueued: boolean;
  onSelectProject: (id: string) => void;
  onToggleStarter: (id: string, enabled: boolean) => void;
  onToggleSentrySetup: () => void;
  onToggleContentFeed: (queued: boolean) => void;
}

function AutomationRow({
  icon,
  title,
  badge,
  description,
  muted = false,
  action,
  children,
}: {
  icon: IconName;
  title: string;
  badge?: string;
  description: string;
  muted?: boolean;
  action: ReactNode;
  children?: ReactNode;
}) {
  return (
    <li className="px-4 py-3.5">
      <div className="flex items-center gap-3">
        <span
          className={cn(
            "flex size-10 shrink-0 items-center justify-center rounded-lg border border-border-hairline bg-surface-recessed",
            muted && "opacity-50",
          )}
        >
          <Icon
            name={icon}
            aria-hidden
            className="size-5 text-subtle-foreground"
          />
        </span>
        <div
          className={cn("flex min-w-0 flex-1 flex-col", muted && "opacity-60")}
        >
          <span className="flex min-w-0 items-center gap-2">
            <span className="truncate text-sm font-medium">{title}</span>
            {badge === undefined ? null : (
              <span className="shrink-0 truncate rounded-full border border-border-hairline px-2 py-0.5 text-2xs text-muted-foreground">
                {badge}
              </span>
            )}
          </span>
          <span className="text-xs text-muted-foreground">{description}</span>
        </div>
        {action}
      </div>
      {children}
    </li>
  );
}

export function AutomationsStep({
  projects,
  projectId,
  agentName,
  starters,
  sentry,
  contentFeedQueued,
  onSelectProject,
  onToggleStarter,
  onToggleSentrySetup,
  onToggleContentFeed,
}: AutomationsStepProps) {
  const project = projects.find((entry) => entry.id === projectId) ?? null;

  const blocked =
    project === null
      ? "Add a project to schedule these."
      : agentName === null
        ? "Connect an agent to schedule these."
        : null;

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <Icon name="Folder" aria-hidden className="size-3.5" />
        {project === null ? (
          <span>No project yet</span>
        ) : (
          <span className="flex min-w-0 items-center gap-1">
            <span>Runs in</span>
            {projects.length > 1 ? (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <button
                    type="button"
                    className="flex items-center gap-0.5 rounded-sm font-medium text-foreground hover:underline focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                  >
                    {project.name}
                    <Icon name="ChevronDown" aria-hidden className="size-3" />
                  </button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="start" className="w-56">
                  {projects.map((entry) => (
                    <DropdownMenuItem
                      key={entry.id}
                      onSelect={() => onSelectProject(entry.id)}
                    >
                      {entry.name}
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuContent>
              </DropdownMenu>
            ) : (
              <span className="font-medium text-foreground">
                {project.name}
              </span>
            )}
            {agentName === null ? null : <span>with {agentName}</span>}
          </span>
        )}
      </div>
      <ul className="divide-y divide-border-hairline overflow-hidden rounded-xl border border-border bg-card shadow-xs">
        {starters.map((starter) => (
          <AutomationRow
            key={starter.id}
            icon={starter.icon}
            title={starter.name}
            description={`${starter.description} ${starter.scheduleLabel}.`}
            muted={blocked !== null}
            action={
              <span className="flex shrink-0 items-center gap-2">
                {starter.pending ? (
                  <Icon
                    name="Spinner"
                    aria-hidden
                    className="size-3.5 animate-spin text-muted-foreground"
                  />
                ) : null}
                <Switch
                  checked={starter.enabled}
                  disabled={blocked !== null || starter.pending}
                  onCheckedChange={(next) => onToggleStarter(starter.id, next)}
                  aria-label={`Schedule ${starter.name}`}
                />
              </span>
            }
          />
        ))}
        {sentry.status === "detected" ? (
          <AutomationRow
            icon="Bug"
            title="Fix Sentry errors"
            badge={`${sentry.projectName} uses Sentry`}
            description="Investigates new errors and prepares reviewed fixes."
            action={
              <Button size="sm" variant="outline" onClick={onToggleSentrySetup}>
                {sentry.open ? "Hide" : "Connect"}
              </Button>
            }
          >
            {sentry.open ? (
              <div className="mt-3 rounded-md border border-border p-3">
                {sentry.setup}
              </div>
            ) : null}
          </AutomationRow>
        ) : null}
        <AutomationRow
          icon="News01"
          title="Weekly Content Feed"
          description={
            contentFeedQueued
              ? "Its setup opens when you finish."
              : "Seven reviewed drafts a week from your product facts."
          }
          action={
            <Switch
              checked={contentFeedQueued}
              onCheckedChange={onToggleContentFeed}
              aria-label="Set up Weekly Content Feed when setup finishes"
            />
          }
        />
      </ul>
      {blocked === null ? null : (
        <p className="text-xs text-muted-foreground">{blocked}</p>
      )}
    </div>
  );
}

function CopyableLine({
  value,
  onCopy,
}: {
  value: string;
  onCopy: (value: string) => void;
}) {
  return (
    <div className="mt-3 flex items-center gap-2 rounded-md border border-border bg-surface-recessed py-1 pl-3 pr-1">
      <code className="min-w-0 flex-1 truncate font-mono text-xs">{value}</code>
      <Button
        variant="ghost"
        size="sm"
        aria-label="Copy address"
        onClick={() => onCopy(value)}
      >
        <Icon name="Copy" aria-hidden />
      </Button>
    </div>
  );
}

interface DeviceRowProps {
  icon: IconName;
  title: string;
  description: string;
  action: ReactNode;
  children?: ReactNode;
}

function DeviceRow({
  icon,
  title,
  description,
  action,
  children,
}: DeviceRowProps) {
  return (
    <li className="px-4 py-3.5">
      <div className="flex items-center gap-3">
        <span className="flex size-10 shrink-0 items-center justify-center rounded-lg border border-border-hairline bg-surface-recessed">
          <Icon
            name={icon}
            aria-hidden
            className="size-5 text-subtle-foreground"
          />
        </span>
        <div className="flex min-w-0 flex-1 flex-col">
          <span className="text-sm font-medium">{title}</span>
          <span className="text-xs text-muted-foreground">{description}</span>
        </div>
        {action}
      </div>
      {children}
    </li>
  );
}

export type OnboardingConnectState =
  | { status: "on"; url: string }
  | { status: "off" }
  | { status: "unavailable" };

interface DevicesStepProps {
  connect: OnboardingConnectState;
  connectSetup: ReactNode;
  connectSetupOpen: boolean;
  otherMachineCount: number;
  onToggleConnectSetup: () => void;
  onCopyConnectUrl: (url: string) => void;
  onAddMachine: () => void;
}

export function DevicesStep({
  connect,
  connectSetup,
  connectSetupOpen,
  otherMachineCount,
  onToggleConnectSetup,
  onCopyConnectUrl,
  onAddMachine,
}: DevicesStepProps) {
  return (
    <ul className="divide-y divide-border-hairline overflow-hidden rounded-xl border border-border bg-card shadow-xs">
      {connect.status === "unavailable" ? null : (
        <DeviceRow
          icon="ComputerCloud"
          title="Open Omnyo from any browser"
          description="Omnyo connect gives this Omnyo a private address that only you can open."
          action={
            connect.status === "on" ? (
              <span className="flex items-center gap-1 rounded-full bg-success/12 py-1 pl-1.5 pr-2.5 text-xs font-medium text-success">
                <Icon name="CircleCheck" aria-hidden className="size-3.5" />
                On
              </span>
            ) : (
              <Button
                size="sm"
                variant="outline"
                onClick={onToggleConnectSetup}
              >
                {connectSetupOpen ? "Hide" : "Set up"}
              </Button>
            )
          }
        >
          {connect.status === "on" ? (
            <CopyableLine value={connect.url} onCopy={onCopyConnectUrl} />
          ) : connectSetupOpen ? (
            <div className="mt-3 rounded-md border border-border p-3">
              {connectSetup}
            </div>
          ) : null}
        </DeviceRow>
      )}
      <DeviceRow
        icon="Laptop"
        title="Add another machine"
        description={
          otherMachineCount > 0
            ? `${otherMachineCount} other ${otherMachineCount === 1 ? "machine is" : "machines are"} already connected. Add more to run agents on a server, a desktop, or a cloud box.`
            : "Run agents on a server, a desktop, or a cloud box and steer them all from here."
        }
        action={
          <Button size="sm" variant="outline" onClick={onAddMachine}>
            Add machine
          </Button>
        }
      />
    </ul>
  );
}

export interface BrowserLoginChoice {
  key: string;
  browserName: string;
  profileName: string;
  icon: string | null;
}

export interface BrowserStepProps {
  selected: BrowserLoginChoice | null;
  choices: readonly BrowserLoginChoice[];
  selectedIsDefault: boolean;
  connected: boolean;
  error: string | null;
  disabled: boolean;
  onSelect: (key: string) => void;
}

export function BrowserStep({
  selected,
  choices,
  selectedIsDefault,
  connected,
  error,
  disabled,
  onSelect,
}: BrowserStepProps) {
  if (selected === null)
    return (
      <p className="text-sm text-muted-foreground">
        No browser on this computer can share its logins yet.
      </p>
    );

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-3 rounded-lg border border-border px-4 py-3">
        <BrowserSourceIcon
          source={{
            name: selected.browserName,
            ...(selected.icon === null ? {} : { icon: selected.icon }),
          }}
          className="size-8 rounded-md"
        />
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium">
            {selected.browserName} · {selected.profileName}
          </p>
          <p
            className={cn(
              "text-xs",
              connected ? "text-success" : "text-muted-foreground",
            )}
          >
            {connected
              ? "Connected"
              : selectedIsDefault
                ? "Your default browser"
                : "Browser profile"}
          </p>
        </div>
        {choices.length > 1 && !connected ? (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button size="sm" variant="ghost" disabled={disabled}>
                Change
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-72">
              {choices.map((choice) => (
                <DropdownMenuItem
                  key={choice.key}
                  onSelect={() => onSelect(choice.key)}
                >
                  <span className="flex min-w-0 flex-col">
                    <span className="truncate">{choice.browserName}</span>
                    <span className="truncate text-xs text-muted-foreground">
                      {choice.profileName}
                    </span>
                  </span>
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        ) : null}
      </div>
      {error ? <p className="text-sm text-destructive-text">{error}</p> : null}
    </div>
  );
}
