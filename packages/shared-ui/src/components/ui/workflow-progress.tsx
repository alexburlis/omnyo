import { useEffect, useRef, useState, type ReactNode } from "react";
import { Collapsible, CollapsibleContent } from "./collapsible";
import { FOCUS_RING_CLASS } from "./focus-ring";
import { Icon, type IconName } from "./icon";
import {
  DISCLOSURE_CHEVRON_TRANSITION,
  LIST_HOVER_TRANSITION,
  PROGRESS_FILL_TRANSITION,
} from "./motion";
import { StatusBadge, type StatusTone } from "./status-row";
import { CheckMark } from "./success-check";
import { cn } from "../../lib/utils";

export type WorkflowProgressAgentState =
  | "queued"
  | "running"
  | "done"
  | "failed"
  | "skipped"
  | "cancelled";

export interface WorkflowProgressAgent {
  id?: string;
  actionable?: boolean;
  index: number;
  label: string;
  state: WorkflowProgressAgentState;
  model: string;
  attempt: number;
  cached: boolean;
  lastProgressAt: number;
  phaseIndex?: number;
  agentType?: string;
  error?: string;
  tokens?: number;
  toolCalls?: number;
  durationMs?: number;
  metadata?: readonly string[];
}

export interface WorkflowProgressPhase {
  index: number;
  title: string;
}

export interface WorkflowProgressSnapshot {
  phases: readonly WorkflowProgressPhase[];
  agents: readonly WorkflowProgressAgent[];
}

type WorkflowAgentDisplayState = WorkflowProgressAgentState | "interrupted";

type WorkflowTerminalState = "completed" | "failed" | "cancelled";

type PhaseState = "complete" | "active" | "failed" | "pending" | "stopped";

interface WorkflowPhaseGroup {
  agents: WorkflowProgressAgent[];
  phase: WorkflowProgressPhase | null;
}

const ACTIVE_PHASE_SCROLL_OFFSET = 12;

const MAX_SEGMENTED_PHASES = 8;

function isSettledAgentState(state: WorkflowProgressAgentState): boolean {
  return (
    state === "done" ||
    state === "failed" ||
    state === "skipped" ||
    state === "cancelled"
  );
}

export function countSettledWorkflowAgents(
  agents: readonly WorkflowProgressAgent[],
): number {
  return agents.filter((agent) => isSettledAgentState(agent.state)).length;
}

function deriveAgentDisplayState(
  agent: WorkflowProgressAgent,
  workflowSettled: boolean,
): WorkflowAgentDisplayState {
  if (workflowSettled && !isSettledAgentState(agent.state)) {
    return "interrupted";
  }

  return agent.state;
}

const AGENT_STATE_GLYPH: Record<
  WorkflowAgentDisplayState,
  { name: IconName; className: string; label: string }
> = {
  done: {
    name: "Check",
    className: "text-success-foreground",
    label: "Finished",
  },
  failed: {
    name: "CircleX",
    className: "text-destructive-text",
    label: "Failed",
  },
  skipped: {
    name: "X",
    className: "text-subtle-foreground",
    label: "Skipped",
  },
  cancelled: {
    name: "Pause",
    className: "text-subtle-foreground",
    label: "Cancelled",
  },
  running: {
    name: "Spinner",
    className: "animate-spin text-foreground",
    label: "Running",
  },
  queued: {
    name: "CircleDashed",
    className: "text-subtle-foreground",
    label: "Waiting to start",
  },
  interrupted: {
    name: "Pause",
    className: "text-subtle-foreground",
    label: "Stopped",
  },
};

const AGENT_LABEL_CLASS: Record<WorkflowAgentDisplayState, string> = {
  done: "text-muted-foreground",
  failed: "text-destructive-text",
  skipped: "text-subtle-foreground",
  cancelled: "text-subtle-foreground",
  running: "font-medium text-foreground",
  queued: "text-subtle-foreground",
  interrupted: "text-subtle-foreground",
};

const AGENT_STATE_WORD: Partial<Record<WorkflowAgentDisplayState, string>> = {
  queued: "Waiting",
  interrupted: "Stopped",
  cancelled: "Cancelled",
  skipped: "Skipped",
};

function formatCompactTokens(tokens: number): string {
  if (tokens >= 1_000_000) {
    return `${(tokens / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
  }

  if (tokens >= 1_000) {
    return `${(tokens / 1_000).toFixed(1).replace(/\.0$/, "")}k`;
  }

  return `${tokens}`;
}

function formatCompactDuration(durationMs: number): string {
  const totalSeconds = Math.max(0, Math.round(durationMs / 1_000));

  if (totalSeconds < 60) return `${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;

  return `${minutes}m ${seconds.toString().padStart(2, "0")}s`;
}

function shortModelName(model: string): string {
  const match = /^claude-([a-z]+)/.exec(model);

  return match?.[1] ?? model;
}

const TIERED_LABEL = /^(.+?):([a-z0-9][a-z0-9.-]*\/[a-z0-9-]+)$/i;

function splitAgentLabel(label: string): { name: string; tier: string | null } {
  const match = TIERED_LABEL.exec(label);

  if (match?.[1] === undefined || match[2] === undefined) {
    return { name: label, tier: null };
  }

  return { name: match[1], tier: match[2].replace("/", " · ") };
}

interface WorkflowAgentDetails {
  name: string;
  tier: string | null;
  descriptor: string | null;
  metrics: string | null;
  metricsTitle: string | null;
  stateWords: string[];
  duration: string | null;
}

function describeAgent(
  agent: WorkflowProgressAgent,
  displayState: WorkflowAgentDisplayState,
): WorkflowAgentDetails {
  const { name, tier } = splitAgentLabel(agent.label);

  const descriptorParts =
    agent.metadata === undefined
      ? [agent.agentType, shortModelName(agent.model)].filter(
          (part): part is string =>
            part !== undefined &&
            part !== "" &&
            (tier === null || !tier.startsWith(part)),
        )
      : [...agent.metadata];

  const metrics: string[] = [];
  const metricsTitle: string[] = [];

  if (agent.tokens !== undefined && agent.tokens > 0) {
    metrics.push(`${formatCompactTokens(agent.tokens)} tokens`);
    metricsTitle.push(`${agent.tokens.toLocaleString("en-US")} tokens used`);
  }

  if (agent.toolCalls !== undefined && agent.toolCalls > 0) {
    const noun = agent.toolCalls === 1 ? "tool call" : "tool calls";
    metrics.push(`${agent.toolCalls} ${noun}`);
    metricsTitle.push(`${agent.toolCalls} ${noun}`);
  }

  const stateWords: string[] = [];
  const word = AGENT_STATE_WORD[displayState];

  if (agent.attempt > 1) stateWords.push(`Attempt ${agent.attempt}`);

  if (agent.cached) stateWords.push("Cached");

  if (word !== undefined) stateWords.push(word);

  return {
    name,
    tier,
    descriptor:
      descriptorParts.length === 0 ? null : descriptorParts.join(" · "),
    metrics: metrics.length === 0 ? null : metrics.join(" · "),
    metricsTitle: metricsTitle.length === 0 ? null : metricsTitle.join(", "),
    stateWords,
    duration:
      agent.durationMs === undefined
        ? null
        : formatCompactDuration(agent.durationMs),
  };
}

function WorkflowAgentLine({
  agent,
  onActivate,
  workflowSettled,
}: {
  agent: WorkflowProgressAgent;
  onActivate?: () => void;
  workflowSettled: boolean;
}) {
  const displayState = deriveAgentDisplayState(agent, workflowSettled);
  const glyph = AGENT_STATE_GLYPH[displayState];
  const details = describeAgent(agent, displayState);
  const failedWithError = displayState === "failed" && agent.error;

  const content = (
    <>
      <span className="flex min-w-0 items-center gap-2">
        <Icon
          name={glyph.name}
          className={cn("size-3.5 shrink-0", glyph.className)}
          aria-hidden="true"
        />
        <span className="sr-only">{glyph.label}: </span>
        <span
          className={cn(
            "min-w-0 truncate text-xs",
            AGENT_LABEL_CLASS[displayState],
          )}
          title={agent.label}
        >
          {details.name}
        </span>
        {details.tier === null ? null : (
          <span className="shrink-0 whitespace-nowrap rounded bg-state-hover px-1.5 py-px text-2xs font-medium text-muted-foreground">
            {details.tier}
          </span>
        )}
        <span className="ml-auto flex shrink-0 items-center gap-2 pl-2 text-xs tabular-nums text-subtle-foreground">
          {details.descriptor === null ? null : (
            <span
              className="max-w-56 truncate whitespace-nowrap @max-[26rem]:hidden"
              title={details.descriptor}
            >
              {details.descriptor}
            </span>
          )}
          {details.metrics === null ? null : (
            <span
              className="whitespace-nowrap @max-[20rem]:hidden"
              title={details.metricsTitle ?? undefined}
            >
              {details.metrics}
            </span>
          )}
          {details.stateWords.map((stateWord) => (
            <span key={stateWord} className="whitespace-nowrap">
              {stateWord}
            </span>
          ))}
          {details.duration === null ? null : (
            <span className="min-w-10 whitespace-nowrap text-right">
              {details.duration}
            </span>
          )}
        </span>
      </span>
      {failedWithError ? (
        <span className="mt-0.5 block pl-5.5 text-left text-xs leading-5 text-destructive-text [overflow-wrap:anywhere]">
          {agent.error}
        </span>
      ) : null}
    </>
  );

  const className = cn(
    "flex min-w-0 flex-col rounded-md px-2 py-1 text-left",
    displayState === "running" && "bg-state-hover",
    onActivate && "w-full cursor-pointer hover:bg-state-active",
    onActivate && LIST_HOVER_TRANSITION,
    onActivate && FOCUS_RING_CLASS,
  );

  return onActivate ? (
    <button type="button" className={className} onClick={onActivate}>
      {content}
    </button>
  ) : (
    <div className={className}>{content}</div>
  );
}

function groupAgentsByPhase(
  phases: readonly WorkflowProgressPhase[],
  agents: readonly WorkflowProgressAgent[],
): WorkflowPhaseGroup[] {
  const groups: WorkflowPhaseGroup[] = [];
  const byIndex = new Map<number, WorkflowPhaseGroup>();

  for (const phase of phases) {
    const group: WorkflowPhaseGroup = { phase, agents: [] };
    groups.push(group);
    byIndex.set(phase.index, group);
  }

  const unphased: WorkflowProgressAgent[] = [];

  for (const agent of agents) {
    const group =
      agent.phaseIndex !== undefined ? byIndex.get(agent.phaseIndex) : null;

    if (group) group.agents.push(agent);
    else unphased.push(agent);
  }

  if (unphased.length > 0) groups.push({ phase: null, agents: unphased });

  return groups;
}

function groupKey(group: WorkflowPhaseGroup): string {
  return group.phase ? `phase-${group.phase.index}` : "unphased";
}

function activePhaseKey(
  groups: readonly WorkflowPhaseGroup[],
  currentPhaseIndex?: number,
): string | null {
  if (currentPhaseIndex !== undefined) {
    const current = groups.find(
      (group) => group.phase?.index === currentPhaseIndex,
    );

    if (current) return groupKey(current);
  }

  const running = groups.find((group) =>
    group.agents.some((agent) => agent.state === "running"),
  );

  if (running) return groupKey(running);

  const inFlight = groups.find(
    (group) =>
      group.agents.length > 0 &&
      !group.agents.every((agent) => isSettledAgentState(agent.state)),
  );

  if (inFlight) return groupKey(inFlight);

  for (let i = groups.length - 1; i >= 0; i--) {
    const group = groups[i];

    if (group && group.agents.length > 0) return groupKey(group);
  }

  return null;
}

function derivePhaseState({
  group,
  isActive,
  terminalState,
  workflowSettled,
}: {
  group: WorkflowPhaseGroup;
  isActive: boolean;
  terminalState?: WorkflowTerminalState;
  workflowSettled: boolean;
}): PhaseState {
  if (group.agents.some((agent) => agent.state === "failed")) return "failed";

  const total = group.agents.length;
  const settled = countSettledWorkflowAgents(group.agents);

  if (total === 0) {
    if (!workflowSettled) return "pending";

    return terminalState === "completed" ? "complete" : "stopped";
  }

  if (workflowSettled) {
    if (isActive && terminalState === "failed") return "failed";

    if (total > 0 && settled === total) {
      return group.agents.some((agent) => agent.state === "cancelled")
        ? "stopped"
        : "complete";
    }

    return "stopped";
  }

  if (total > 0 && settled === total && !isActive) {
    return group.agents.some((agent) => agent.state === "cancelled")
      ? "stopped"
      : "complete";
  }

  if (isActive || group.agents.some((agent) => agent.state === "running")) {
    return "active";
  }

  if (settled > 0) return "active";

  return "pending";
}

const PHASE_TITLE_CLASS: Record<PhaseState, string> = {
  complete: "text-muted-foreground",
  active: "text-foreground",
  failed: "text-destructive-text",
  pending: "text-subtle-foreground",
  stopped: "text-subtle-foreground",
};

const PHASE_FILL_CLASS: Record<PhaseState, string> = {
  complete: "bg-success",
  active: "bg-foreground",
  failed: "bg-destructive",
  pending: "bg-foreground",
  stopped: "bg-subtle-foreground",
};

const PHASE_STATE_LABEL: Record<PhaseState, string> = {
  complete: "Complete",
  active: "In progress",
  failed: "Has a failure",
  pending: "Not started",
  stopped: "Stopped",
};

function PhaseGlyph({ state }: { state: PhaseState }) {
  if (state === "complete") {
    return (
      <span
        aria-hidden="true"
        className="grid size-3.5 shrink-0 place-items-center rounded-full bg-success/15 text-success-foreground"
      >
        <CheckMark className="size-2.5" />
      </span>
    );
  }

  if (state === "active") {
    return (
      <span
        aria-hidden="true"
        className="grid size-3.5 shrink-0 place-items-center rounded-full border-[1.5px] border-foreground"
      >
        <span className="size-1.5 rounded-full bg-foreground" />
      </span>
    );
  }

  if (state === "failed") {
    return (
      <Icon
        name="AlertCircle"
        aria-hidden="true"
        className="size-3.5 shrink-0 text-destructive-text"
      />
    );
  }

  return (
    <Icon
      name={state === "stopped" ? "Circle" : "CircleDashed"}
      aria-hidden="true"
      className="size-3.5 shrink-0 text-subtle-foreground"
    />
  );
}

function phaseFraction(group: WorkflowPhaseGroup, state: PhaseState): number {
  if (state === "complete" || state === "failed") return 1;

  const total = group.agents.length;

  if (total === 0) return 0;

  return countSettledWorkflowAgents(group.agents) / total;
}

function PhaseMeter({
  group,
  state,
  className,
}: {
  group: WorkflowPhaseGroup;
  state: PhaseState;
  className?: string;
}) {
  if (group.agents.length === 0) return null;

  return (
    <span
      aria-hidden="true"
      className={cn(
        "relative h-1 w-10 shrink-0 overflow-hidden rounded-full bg-state-active @max-[22rem]:hidden",
        className,
      )}
    >
      <span
        className={cn(
          "absolute inset-0 origin-left rounded-full",
          PROGRESS_FILL_TRANSITION,
          PHASE_FILL_CLASS[state],
        )}
        style={{ transform: `scaleX(${phaseFraction(group, state)})` }}
      />
    </span>
  );
}

function PhaseCount({
  group,
  state,
}: {
  group: WorkflowPhaseGroup;
  state: PhaseState;
}) {
  if (group.agents.length === 0) {
    return (
      <span className="shrink-0 text-xs text-subtle-foreground">
        {state === "complete"
          ? "No agents"
          : state === "stopped"
            ? "Didn’t run"
            : "Not started"}
      </span>
    );
  }

  return (
    <span
      className={cn(
        "shrink-0 text-xs tabular-nums",
        state === "failed" ? "text-destructive-text" : "text-subtle-foreground",
      )}
      title={`${countSettledWorkflowAgents(group.agents)} of ${group.agents.length} agents finished`}
    >
      {countSettledWorkflowAgents(group.agents)}/{group.agents.length}
    </span>
  );
}

function PhaseHeading({
  group,
  state,
}: {
  group: WorkflowPhaseGroup & { phase: WorkflowProgressPhase };
  state: PhaseState;
}) {
  return (
    <>
      <PhaseGlyph state={state} />
      <span
        className={cn(
          "min-w-0 truncate text-xs font-medium",
          PHASE_TITLE_CLASS[state],
        )}
      >
        {group.phase.title}
      </span>
      <PhaseCount group={group} state={state} />
      <span className="sr-only">, {PHASE_STATE_LABEL[state]}</span>
      <span aria-hidden="true" className="min-w-0 flex-1" />
      <PhaseMeter group={group} state={state} />
    </>
  );
}

function AgentLines({
  agents,
  onAgentActivate,
  workflowSettled,
  nested,
}: {
  agents: readonly WorkflowProgressAgent[];
  onAgentActivate?: (agent: WorkflowProgressAgent) => void;
  workflowSettled: boolean;
  nested: boolean;
}) {
  return (
    <div
      className={cn(
        "flex min-w-0 flex-col gap-px",
        nested && "ml-3.5 border-l border-border-seam pl-1.5",
      )}
    >
      {agents.map((agent) => (
        <WorkflowAgentLine
          key={agent.id ?? agent.index}
          agent={agent}
          onActivate={
            onAgentActivate === undefined || !agent.actionable
              ? undefined
              : () => onAgentActivate(agent)
          }
          workflowSettled={workflowSettled}
        />
      ))}
    </div>
  );
}

function StaticPhaseGroup({
  group,
  isActive,
  onAgentActivate,
  terminalState,
  workflowSettled,
}: {
  group: WorkflowPhaseGroup;
  isActive: boolean;
  onAgentActivate?: (agent: WorkflowProgressAgent) => void;
  terminalState?: WorkflowTerminalState;
  workflowSettled: boolean;
}) {
  const phase = group.phase;

  if (phase === null) {
    return (
      <AgentLines
        agents={group.agents}
        onAgentActivate={onAgentActivate}
        workflowSettled={workflowSettled}
        nested={false}
      />
    );
  }

  const state = derivePhaseState({
    group,
    isActive,
    terminalState,
    workflowSettled,
  });

  return (
    <div className="flex min-w-0 flex-col gap-0.5">
      <div className="flex min-h-6 min-w-0 items-center gap-2 px-2">
        <PhaseHeading group={{ ...group, phase }} state={state} />
      </div>
      {group.agents.length === 0 ? null : (
        <AgentLines
          agents={group.agents}
          onAgentActivate={onAgentActivate}
          workflowSettled={workflowSettled}
          nested
        />
      )}
    </div>
  );
}

function CollapsiblePhaseSection({
  group,
  expanded,
  isActive,
  onAgentActivate,
  onToggle,
  terminalState,
  workflowSettled,
}: {
  group: WorkflowPhaseGroup;
  expanded: boolean;
  isActive: boolean;
  onAgentActivate?: (agent: WorkflowProgressAgent) => void;
  onToggle: () => void;
  terminalState?: WorkflowTerminalState;
  workflowSettled: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!isActive || workflowSettled) return;
    const element = ref.current;
    const scroller = element?.closest("[data-detail-scroll-area]");

    if (element && scroller instanceof HTMLElement) {
      scroller.scrollTop +=
        element.getBoundingClientRect().top -
        scroller.getBoundingClientRect().top -
        ACTIVE_PHASE_SCROLL_OFFSET;
    }
  }, [isActive, workflowSettled]);

  const phase = group.phase;

  if (phase === null) {
    return (
      <div ref={ref} className="flex min-w-0 flex-col">
        <AgentLines
          agents={group.agents}
          onAgentActivate={onAgentActivate}
          workflowSettled={workflowSettled}
          nested={false}
        />
      </div>
    );
  }

  const state = derivePhaseState({
    group,
    isActive,
    terminalState,
    workflowSettled,
  });

  if (group.agents.length === 0) {
    return (
      <div
        ref={ref}
        className="flex min-h-7 min-w-0 items-center gap-2 rounded-md px-2"
      >
        <PhaseHeading group={{ ...group, phase }} state={state} />
        <span aria-hidden="true" className="size-3.5 shrink-0" />
      </div>
    );
  }

  return (
    <Collapsible asChild open={expanded}>
      <div ref={ref} className="min-w-0">
        <button
          type="button"
          aria-expanded={expanded}
          onClick={onToggle}
          className={cn(
            "group/phase flex min-h-7 w-full min-w-0 cursor-pointer items-center gap-2 rounded-md px-2 text-left hover:bg-state-hover",
            LIST_HOVER_TRANSITION,
            FOCUS_RING_CLASS,
          )}
        >
          <PhaseHeading group={{ ...group, phase }} state={state} />
          <Icon
            name="ChevronDown"
            className={cn(
              "size-3.5 shrink-0 text-subtle-foreground group-hover/phase:text-muted-foreground",
              DISCLOSURE_CHEVRON_TRANSITION,
              !expanded && "-rotate-90",
            )}
            aria-hidden="true"
          />
        </button>
        <CollapsibleContent>
          <div className="pt-0.5 pb-1">
            <AgentLines
              agents={group.agents}
              onAgentActivate={onAgentActivate}
              workflowSettled={workflowSettled}
              nested
            />
          </div>
        </CollapsibleContent>
      </div>
    </Collapsible>
  );
}

function CollapsiblePhaseGroups({
  currentPhaseIndex,
  groups,
  onAgentActivate,
  terminalState,
  workflowSettled,
}: {
  currentPhaseIndex?: number;
  groups: readonly WorkflowPhaseGroup[];
  onAgentActivate?: (agent: WorkflowProgressAgent) => void;
  terminalState?: WorkflowTerminalState;
  workflowSettled: boolean;
}) {
  const activeKey = activePhaseKey(groups, currentPhaseIndex);

  const [overrides, setOverrides] = useState<ReadonlyMap<string, boolean>>(
    () => new Map(),
  );

  const defaultExpanded = (group: WorkflowPhaseGroup): boolean =>
    workflowSettled
      ? group.agents.some(
          (agent) => agent.state !== "done" && agent.state !== "skipped",
        )
      : group.agents.some(
          (agent) =>
            !isSettledAgentState(agent.state) || agent.state === "failed",
        );

  const isExpanded = (key: string, group: WorkflowPhaseGroup): boolean =>
    overrides.get(key) ?? defaultExpanded(group);

  const toggle = (key: string, group: WorkflowPhaseGroup) =>
    setOverrides((current) => {
      const wasExpanded = current.get(key) ?? defaultExpanded(group);
      const next = new Map(current);
      next.set(key, !wasExpanded);

      return next;
    });

  return groups.map((group) => {
    const key = groupKey(group);

    return (
      <CollapsiblePhaseSection
        key={key}
        group={group}
        expanded={isExpanded(key, group)}
        isActive={key === activeKey}
        onAgentActivate={onAgentActivate}
        onToggle={() => toggle(key, group)}
        terminalState={terminalState}
        workflowSettled={workflowSettled}
      />
    );
  });
}

export function WorkflowProgress({
  collapsiblePhases = false,
  currentPhaseIndex,
  error,
  onAgentActivate,
  progress,
  settled,
  terminalState,
}: {
  collapsiblePhases?: boolean;
  currentPhaseIndex?: number;
  error?: string | null;
  onAgentActivate?: (agent: WorkflowProgressAgent) => void;
  progress: WorkflowProgressSnapshot;
  settled: boolean;
  terminalState?: WorkflowTerminalState;
}) {
  const groups = groupAgentsByPhase(progress.phases, progress.agents);
  const activeKey = activePhaseKey(groups, currentPhaseIndex);

  return (
    <div
      className={cn(
        "@container flex min-w-0 flex-col",
        collapsiblePhases ? "gap-0.5" : "gap-2 py-1",
      )}
    >
      {collapsiblePhases ? (
        <CollapsiblePhaseGroups
          currentPhaseIndex={currentPhaseIndex}
          groups={groups}
          onAgentActivate={onAgentActivate}
          terminalState={terminalState}
          workflowSettled={settled}
        />
      ) : (
        groups.map((group) => (
          <StaticPhaseGroup
            key={groupKey(group)}
            group={group}
            isActive={groupKey(group) === activeKey}
            onAgentActivate={onAgentActivate}
            terminalState={terminalState}
            workflowSettled={settled}
          />
        ))
      )}
      {error ? (
        <div className="mt-1 flex items-start gap-2 rounded-md bg-destructive/5 px-2 py-1.5 text-xs leading-5 text-destructive-text ring-1 ring-destructive/15">
          <Icon
            name="AlertCircle"
            aria-hidden="true"
            className="mt-0.5 size-3.5 shrink-0"
          />
          <span className="min-w-0 [overflow-wrap:anywhere]">{error}</span>
        </div>
      ) : null}
    </div>
  );
}

export type WorkflowStatusPillState =
  | "queued"
  | "completed"
  | "failed"
  | "cancelled";

const STATUS_PILL: Record<
  WorkflowStatusPillState,
  { label: string; tone: StatusTone; icon: IconName | null }
> = {
  queued: { label: "Queued", tone: "pending", icon: null },
  completed: { label: "Complete", tone: "success", icon: "Check" },
  failed: { label: "Failed", tone: "error", icon: "X" },
  cancelled: { label: "Cancelled", tone: "neutral", icon: "Pause" },
};

export function WorkflowStatusPill({
  state,
  className,
}: {
  state: WorkflowStatusPillState;
  className?: string;
}) {
  const entry = STATUS_PILL[state];

  return (
    <StatusBadge tone={entry.tone} className={cn("gap-1", className)}>
      {entry.icon === null ? (
        <span
          className="size-1.5 shrink-0 rounded-full bg-muted-foreground"
          aria-hidden="true"
        />
      ) : (
        <Icon
          name={entry.icon}
          className="size-3 shrink-0"
          aria-hidden="true"
        />
      )}
      {entry.label}
    </StatusBadge>
  );
}

function stripPhaseStates(
  progress: WorkflowProgressSnapshot,
  currentPhaseIndex: number | undefined,
  settled: boolean,
) {
  const groups = groupAgentsByPhase(progress.phases, progress.agents).filter(
    (group): group is WorkflowPhaseGroup & { phase: WorkflowProgressPhase } =>
      group.phase !== null,
  );

  const activeKey = activePhaseKey(groups, currentPhaseIndex);

  return groups.map((group) => {
    const state = derivePhaseState({
      group,
      isActive: groupKey(group) === activeKey,
      workflowSettled: settled,
    });

    return {
      group,
      state,
      isCurrent: groupKey(group) === activeKey,
      fraction:
        state === "active"
          ? Math.max(0.12, phaseFraction(group, state))
          : phaseFraction(group, state),
    };
  });
}

export function WorkflowPhaseStrip({
  progress,
  currentPhaseIndex,
  settled,
  showLabels = false,
  className,
}: {
  progress: WorkflowProgressSnapshot;
  currentPhaseIndex?: number;
  settled: boolean;
  showLabels?: boolean;
  className?: string;
}) {
  const phases = stripPhaseStates(progress, currentPhaseIndex, settled);

  if (phases.length === 0) return null;

  const currentOrdinal = phases.findIndex((phase) => phase.isCurrent);
  const complete = phases.filter((phase) => phase.state === "complete").length;
  const current = phases[currentOrdinal];

  const label =
    current === undefined
      ? `${complete} of ${phases.length} phases complete`
      : `Phase ${currentOrdinal + 1} of ${phases.length}: ${current.group.phase.title}. ${complete} of ${phases.length} phases complete`;

  if (phases.length > MAX_SEGMENTED_PHASES) {
    const failed = phases.some((phase) => phase.state === "failed");

    const overall =
      phases.reduce(
        (total, phase) =>
          total + (phase.state === "complete" ? 1 : phase.fraction),
        0,
      ) / phases.length;

    const condensedState: PhaseState = failed
      ? "failed"
      : complete === phases.length
        ? "complete"
        : "active";

    return (
      <div
        role="img"
        aria-label={label}
        className={cn("flex min-w-0 flex-col gap-1.5", className)}
      >
        <span className="relative h-1.5 min-w-0 overflow-hidden rounded-full bg-state-active">
          <span
            className={cn(
              "absolute inset-0 origin-left rounded-full",
              PROGRESS_FILL_TRANSITION,
              PHASE_FILL_CLASS[condensedState],
            )}
            style={{ transform: `scaleX(${overall})` }}
          />
        </span>
        {showLabels ? (
          <span
            aria-hidden="true"
            className="truncate text-2xs text-subtle-foreground"
          >
            {current === undefined
              ? `${complete} of ${phases.length} phases complete`
              : `Phase ${currentOrdinal + 1} of ${phases.length} · ${current.group.phase.title}`}
          </span>
        ) : null}
      </div>
    );
  }

  return (
    <div
      role="img"
      aria-label={label}
      className={cn("flex min-w-0 gap-1 overflow-hidden", className)}
    >
      {phases.map(({ group, state, fraction, isCurrent }) => (
        <span
          key={group.phase.index}
          className="flex min-w-0 flex-1 flex-col gap-1.5"
        >
          <span className="relative h-1.5 min-w-0 overflow-hidden rounded-full bg-state-active">
            <span
              className={cn(
                "absolute inset-0 origin-left rounded-full",
                PROGRESS_FILL_TRANSITION,
                PHASE_FILL_CLASS[state],
              )}
              style={{ transform: `scaleX(${fraction})` }}
            />
          </span>
          {showLabels ? (
            <span
              aria-hidden="true"
              className={cn(
                "truncate text-2xs",
                isCurrent && !settled
                  ? "font-medium text-foreground"
                  : "text-subtle-foreground",
              )}
            >
              {group.phase.title}
            </span>
          ) : null}
        </span>
      ))}
    </div>
  );
}

export function WorkflowRunSummary({
  name,
  progress,
  currentPhaseIndex,
  elapsed,
  icon,
  className,
}: {
  name: string;
  progress: WorkflowProgressSnapshot | null;
  currentPhaseIndex?: number;
  elapsed?: ReactNode;
  icon?: ReactNode;
  className?: string;
}) {
  const agents = progress?.agents ?? [];
  const settledAgents = countSettledWorkflowAgents(agents);

  const phases =
    progress === null
      ? []
      : stripPhaseStates(progress, currentPhaseIndex, false);

  const current = phases.find((phase) => phase.isCurrent);

  return (
    <span
      className={cn(
        "@container flex min-w-0 flex-1 items-center gap-2 text-left",
        className,
      )}
    >
      {icon}
      <span className="flex min-w-0 flex-1 items-baseline gap-2">
        <span
          className="min-w-0 truncate font-medium text-foreground"
          title={name}
        >
          {name}
        </span>
        {current === undefined || phases.length < 2 ? null : (
          <span className="min-w-0 shrink truncate text-xs text-muted-foreground @max-[24rem]:hidden">
            {current.group.phase.title}
          </span>
        )}
      </span>
      <span className="flex shrink-0 items-center gap-2.5 text-xs tabular-nums text-subtle-foreground">
        {progress === null ? null : (
          <WorkflowPhaseStrip
            progress={progress}
            currentPhaseIndex={currentPhaseIndex}
            settled={false}
            className="w-14 @max-[18rem]:hidden"
          />
        )}
        {agents.length === 0 ? null : (
          <span
            className="whitespace-nowrap"
            title={`${settledAgents} of ${agents.length} agents finished`}
          >
            {settledAgents}/{agents.length} agents
          </span>
        )}
        {elapsed === undefined || elapsed === null ? null : (
          <span className="inline-flex items-center gap-1 whitespace-nowrap">
            <Icon name="Clock" aria-hidden="true" className="size-3 shrink-0" />
            {elapsed}
          </span>
        )}
      </span>
    </span>
  );
}
