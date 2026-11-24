import "./onboarding-brand.css";

import { useRef, type ReactNode } from "react";
import type { ExperimentalProviderIconProps } from "@omnyo/plugin-sdk/app";
import { Icon, type IconName } from "@omnyo/shared-ui/icon";
import { cn } from "@omnyo/shared-ui/lib/utils";
import { PluginIcon } from "@/components/plugin/PluginIcon";
import { ProviderIcon } from "@/components/plugin/ProviderIcon";
import type { OnboardingStepId } from "./onboarding-model";
import { OnboardingMark } from "./OnboardingMark";

const STAGE_PROJECT_LIMIT = 5;

const STAGE_CHAT_LIMIT = 2;

const STAGE_PLUGIN_LIMIT = 11;

export interface OnboardingStageAgent {
  id: string;
  name: string;
  provider: ExperimentalProviderIconProps["provider"];
}

export interface OnboardingStageChat {
  id: string;
  title: string;
}

export interface OnboardingStageProject {
  id: string;
  name: string;
  chats: readonly OnboardingStageChat[];
}

export interface OnboardingStagePlugin {
  id: string;
  name: string;
  icon: string | null;
}

export interface OnboardingStageAutomation {
  id: string;
  name: string;
  scheduleLabel: string;
}

export interface OnboardingStageProps {
  step: OnboardingStepId;
  machineName: string | null;
  agents: readonly OnboardingStageAgent[];
  projects: readonly OnboardingStageProject[];
  browserConnected: boolean;
  plugins: readonly OnboardingStagePlugin[];
  scheduled: readonly OnboardingStageAutomation[];
  remoteAccess: boolean;
  otherMachineCount: number;
  className?: string;
}

type StageRegion =
  | "composer"
  | "sidebar"
  | "browser"
  | "rail"
  | "automations"
  | "devices";

const STEP_REGION: Record<OnboardingStepId, StageRegion> = {
  agent: "composer",
  projects: "sidebar",
  chats: "sidebar",
  browser: "browser",
  plugins: "rail",
  skills: "composer",
  automations: "automations",
  devices: "devices",
};

const ARRIVAL_CLASS =
  "animate-in fade-in-0 slide-in-from-bottom-1 duration-(--motion-duration-base) ease-out";

function useArrivals(keys: readonly string[]): (key: string) => string {
  const seen = useRef<ReadonlySet<string> | null>(null);
  seen.current ??= new Set(keys);
  const initial = seen.current;

  return (key) => (initial.has(key) ? "" : ARRIVAL_CLASS);
}

function Region({
  region,
  focus,
  className,
  children,
}: {
  region: StageRegion;
  focus: StageRegion;
  className?: string;
  children: ReactNode;
}) {
  const active = region === focus;

  return (
    <div
      data-stage-region={region}
      data-active={active || undefined}
      className={cn(
        "relative transition-opacity duration-(--motion-duration-slow) ease-standard motion-reduce:transition-none",
        active ? "opacity-100" : "opacity-35",
        className,
      )}
    >
      {children}
      <span
        aria-hidden
        className={cn(
          "omnyo-onboarding-stage-focus pointer-events-none absolute inset-0 rounded-[inherit] ring-1 ring-inset ring-foreground/40 transition-opacity duration-(--motion-duration-slow) ease-standard motion-reduce:transition-none",
          active ? "opacity-100" : "opacity-0",
        )}
      />
    </div>
  );
}

function Placeholder({ className }: { className?: string }) {
  return (
    <span
      aria-hidden
      className={cn(
        "block rounded-sm border border-dashed border-border",
        className,
      )}
    />
  );
}

function StageSidebar({
  projects,
}: {
  projects: readonly OnboardingStageProject[];
}) {
  const visible = projects.slice(0, STAGE_PROJECT_LIMIT);
  const hidden = projects.length - visible.length;

  const arrival = useArrivals(
    projects.flatMap((project) => [
      project.id,
      ...project.chats.map((chat) => chat.id),
    ]),
  );

  return (
    <div className="flex h-full flex-col gap-1 overflow-hidden px-2 py-2.5">
      <span className="px-1.5 pb-1 text-2xs font-medium text-muted-foreground">
        Projects
      </span>
      {visible.length === 0 ? (
        <div className="flex flex-col gap-1.5 px-1.5">
          <Placeholder className="h-4 w-4/5" />
          <Placeholder className="h-4 w-3/5" />
          <Placeholder className="h-4 w-2/3" />
        </div>
      ) : (
        visible.map((project) => (
          <div
            key={project.id}
            className={cn("flex flex-col", arrival(project.id))}
          >
            <span className="flex h-6 items-center gap-1.5 rounded-sm px-1.5 text-xs text-sidebar-foreground">
              <Icon
                name="Folder"
                aria-hidden
                className="size-3 shrink-0 text-muted-foreground"
              />
              <span className="truncate font-medium">{project.name}</span>
            </span>
            {project.chats.slice(0, STAGE_CHAT_LIMIT).map((chat) => (
              <span
                key={chat.id}
                className={cn(
                  "flex h-5 items-center gap-1.5 truncate pl-6 pr-1.5 text-2xs text-muted-foreground",
                  arrival(chat.id),
                )}
              >
                <span className="truncate">{chat.title}</span>
              </span>
            ))}
          </div>
        ))
      )}
      {hidden > 0 ? (
        <span className="px-1.5 pt-0.5 text-2xs text-muted-foreground tabular-nums">
          +{hidden} more
        </span>
      ) : null}
    </div>
  );
}

function StageScheduled({
  scheduled,
}: {
  scheduled: readonly OnboardingStageAutomation[];
}) {
  const arrival = useArrivals(scheduled.map((entry) => entry.id));

  return (
    <div className="flex flex-col gap-1 px-2 py-2.5">
      <span className="px-1.5 pb-1 text-2xs font-medium text-muted-foreground">
        Scheduled
      </span>
      {scheduled.length === 0 ? (
        <div className="flex flex-col gap-1.5 px-1.5">
          <Placeholder className="h-4 w-3/4" />
          <Placeholder className="h-4 w-1/2" />
        </div>
      ) : (
        scheduled.map((entry) => (
          <span
            key={entry.id}
            className={cn(
              "flex h-6 items-center gap-1.5 rounded-sm px-1.5 text-xs text-sidebar-foreground",
              arrival(entry.id),
            )}
          >
            <Icon
              name="Clock"
              aria-hidden
              className="size-3 shrink-0 text-muted-foreground"
            />
            <span className="truncate font-medium">{entry.name}</span>
            <span className="ml-auto shrink-0 text-2xs text-muted-foreground">
              {entry.scheduleLabel.replace(/^.* at /u, "")}
            </span>
          </span>
        ))
      )}
    </div>
  );
}

function StageComposer({
  agents,
}: {
  agents: readonly OnboardingStageAgent[];
}) {
  const lead = agents[0];
  const arrival = useArrivals(agents.map((agent) => agent.id));

  return (
    <div className="flex flex-col gap-2 rounded-lg border border-border bg-background p-2 shadow-xs">
      <span className="truncate px-0.5 text-xs text-muted-foreground">
        {lead === undefined
          ? "Connect an agent to start"
          : `Ask ${lead.name} to…`}
      </span>
      <div className="flex items-center gap-1">
        {agents.length === 0 ? (
          <Placeholder className="h-5 w-20 rounded-full" />
        ) : (
          agents.map((agent) => (
            <span
              key={agent.id}
              className={cn(
                "flex h-5 items-center gap-1 rounded-full border border-border-hairline bg-surface-recessed pl-1 pr-1.5 text-2xs font-medium",
                arrival(agent.id),
              )}
            >
              <ProviderIcon
                providerKind="agent"
                provider={agent.provider}
                className="size-3"
              />
              {agent.name}
            </span>
          ))
        )}
        <span
          className={cn(
            "ml-auto flex size-5 items-center justify-center rounded-full",
            lead === undefined
              ? "bg-state-active text-muted-foreground"
              : "bg-foreground text-background",
          )}
        >
          <Icon name="ArrowUp" aria-hidden className="size-3" />
        </span>
      </div>
    </div>
  );
}

function StageRail({ plugins }: { plugins: readonly OnboardingStagePlugin[] }) {
  const visible = plugins.slice(0, STAGE_PLUGIN_LIMIT);
  const hidden = plugins.length - visible.length;
  const arrival = useArrivals(plugins.map((plugin) => plugin.id));

  return (
    <div className="flex h-full flex-col items-center gap-1.5 py-2.5">
      {visible.length === 0
        ? [0, 1, 2].map((index) => (
            <Placeholder key={index} className="size-5 rounded" />
          ))
        : visible.map((plugin) => (
            <span
              key={plugin.id}
              title={plugin.name}
              className={cn(
                "flex size-5 items-center justify-center rounded border border-border-hairline bg-surface-recessed",
                arrival(plugin.id),
              )}
            >
              <PluginIcon
                pluginId={plugin.id}
                icon={plugin.icon}
                className="size-3 text-subtle-foreground"
              />
            </span>
          ))}
      {hidden > 0 ? (
        <span className="text-2xs text-muted-foreground tabular-nums">
          +{hidden}
        </span>
      ) : null}
    </div>
  );
}

function DeviceNode({
  icon,
  label,
  on,
}: {
  icon: IconName;
  label: string;
  on: boolean;
}) {
  return (
    <span className="flex min-w-0 flex-col items-center gap-1.5">
      <span
        className={cn(
          "flex size-9 items-center justify-center rounded-xl border",
          on
            ? "border-border bg-background text-foreground shadow-xs"
            : "border-dashed border-border text-muted-foreground",
        )}
      >
        <Icon name={icon} aria-hidden className="size-4" />
      </span>
      <span
        className={cn(
          "max-w-28 truncate text-2xs",
          on ? "text-foreground" : "text-muted-foreground",
        )}
      >
        {label}
      </span>
    </span>
  );
}

function DeviceLink({ on }: { on: boolean }) {
  return (
    <span
      aria-hidden
      className={cn(
        "mb-5 h-px w-10 shrink-0",
        on ? "bg-foreground/40" : "border-t border-dashed border-border",
      )}
    />
  );
}

export function OnboardingStage({
  step,
  machineName,
  agents,
  projects,
  browserConnected,
  plugins,
  scheduled,
  remoteAccess,
  otherMachineCount,
  className,
}: OnboardingStageProps) {
  const focus = STEP_REGION[step];

  return (
    <aside
      aria-hidden
      className={cn(
        "omnyo-onboarding-stage relative flex min-h-0 flex-col items-center justify-center overflow-hidden border-l border-border-hairline bg-sidebar",
        className,
      )}
    >
      <div className="omnyo-onboarding-stage-glow pointer-events-none absolute inset-0" />
      <div className="omnyo-onboarding-stage-grid pointer-events-none absolute inset-0" />
      <div className="relative flex w-full max-w-[40rem] flex-col items-center gap-8 px-10">
        <div className="flex h-[27rem] w-full flex-col overflow-hidden rounded-xl border border-border bg-background shadow-xl">
          <div className="flex h-8 shrink-0 items-center gap-1.5 border-b border-border-hairline px-3">
            <span className="size-2.5 rounded-full bg-state-active" />
            <span className="size-2.5 rounded-full bg-state-active" />
            <span className="size-2.5 rounded-full bg-state-active" />
            <span className="flex-1 text-center text-2xs font-medium text-muted-foreground">
              Omnyo
            </span>
            <span className="w-11" />
          </div>
          <div className="flex min-h-0 flex-1">
            <div className="flex w-[38%] shrink-0 flex-col border-r border-border-hairline bg-sidebar">
              <Region region="sidebar" focus={focus} className="min-h-0 flex-1">
                <StageSidebar projects={projects} />
              </Region>
              <Region
                region="automations"
                focus={focus}
                className="border-t border-border-hairline"
              >
                <StageScheduled scheduled={scheduled} />
              </Region>
            </div>
            <div className="flex min-w-0 flex-1 flex-col">
              <Region
                region="browser"
                focus={focus}
                className="mx-3 mt-3 rounded-lg"
              >
                <span className="flex h-7 items-center gap-1.5 rounded-lg border border-border-hairline bg-surface-recessed px-2 text-2xs text-muted-foreground">
                  <Icon
                    name={browserConnected ? "Lock" : "Globe"}
                    aria-hidden
                    className="size-3 shrink-0"
                  />
                  <span className="truncate">
                    {browserConnected ? "Signed in to your sites" : "Browser"}
                  </span>
                </span>
              </Region>
              <div className="flex flex-1 flex-col items-center justify-center gap-2 px-4">
                <OnboardingMark className="size-7 text-foreground" />
                <span className="text-sm font-medium">
                  What should we build?
                </span>
              </div>
              <Region
                region="composer"
                focus={focus}
                className="m-3 rounded-lg"
              >
                <StageComposer agents={agents} />
              </Region>
            </div>
            <Region
              region="rail"
              focus={focus}
              className="w-9 shrink-0 border-l border-border-hairline"
            >
              <StageRail plugins={plugins} />
            </Region>
          </div>
        </div>
        <Region
          region="devices"
          focus={focus}
          className="rounded-2xl px-4 py-3"
        >
          <div className="flex items-center gap-2">
            <DeviceNode
              icon="Laptop"
              label={machineName ?? "This computer"}
              on
            />
            <DeviceLink on={remoteAccess} />
            <DeviceNode
              icon="Smartphone"
              label="Phone and browser"
              on={remoteAccess}
            />
            <DeviceLink on={otherMachineCount > 0} />
            <DeviceNode
              icon="ComputerCloud"
              label={
                otherMachineCount > 0
                  ? `${otherMachineCount} more ${otherMachineCount === 1 ? "machine" : "machines"}`
                  : "More machines"
              }
              on={otherMachineCount > 0}
            />
          </div>
        </Region>
      </div>
    </aside>
  );
}
