import { useState, useSyncExternalStore, type ReactNode } from "react";
import { onlineManager, useQuery } from "@tanstack/react-query";
import { z } from "zod";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@omnyo/shared-ui/dropdown-menu";
import { Icon } from "@omnyo/shared-ui/icon";
import { FOCUS_RING_CLASS } from "@omnyo/shared-ui/focus-ring";
import { cn } from "@omnyo/shared-ui/lib/utils";
import {
  CONTROL_PRESS_FEEDBACK,
  CONTROL_PRESS_TRANSITION,
} from "@omnyo/shared-ui/motion";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@omnyo/shared-ui/tooltip";
import { sdk } from "@/lib/sdk";

const gpuStateSchema = z.enum([
  "unconfigured",
  "checking",
  "busy",
  "unavailable",
  "ready",
]);

const overviewSchema = z.object({
  machines: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      connected: z.boolean(),
      observedAt: z.number().nullable(),
      error: z.string().nullable(),
      snapshot: z
        .object({
          cpu: z.number().nonnegative(),
          paused: z.boolean(),
          blocked: z.boolean(),
          gpu: z.object({ state: gpuStateSchema }).optional(),
          jobs: z.array(
            z.object({
              state: z.enum([
                "queued",
                "starting",
                "running",
                "stopping",
                "blocked",
                "succeeded",
                "failed",
                "cancelled",
                "timed_out",
                "interrupted",
              ]),
              cpu: z.number().nonnegative(),
              gpu: z.boolean(),
            }),
          ),
        })
        .nullable(),
    }),
  ),
});

const terminalStates = new Set([
  "succeeded",
  "failed",
  "cancelled",
  "timed_out",
  "interrupted",
]);

type GpuState = z.infer<typeof gpuStateSchema>;

type ResourcesOverview = z.infer<typeof overviewSchema>;

type ResourcesMachine = ResourcesOverview["machines"][number];

type TooltipSide = "right" | "top";

const gpuStatus: Record<
  Exclude<GpuState, "unconfigured" | "checking">,
  { label: string; dot: string; hint: string }
> = {
  ready: {
    label: "free",
    dot: "bg-success",
    hint: "The GPU is free, so a GPU job can start now",
  },
  busy: {
    label: "busy",
    dot: "bg-warning",
    hint: "The GPU is in use. GPU jobs wait until it frees up",
  },
  unavailable: {
    label: "N/A",
    dot: "bg-destructive",
    hint: "The GPU is unavailable, so GPU jobs cannot start",
  },
};

const RESOURCES_STATUS_TEXT = {
  Offline: "Offline",
  Unavailable: "No data",
  Loading: "Loading…",
  "No hosts": "No machines connected",
} as const;

type ResourcesStatus = keyof typeof RESOURCES_STATUS_TEXT;

function jobCountText(
  count: number,
  kind: "running" | "queued",
  machineName: string,
): string {
  const jobs = count === 1 ? "job" : "jobs";

  return kind === "running"
    ? `${count} ${jobs} running on ${machineName}, counting any that are starting, stopping or blocked`
    : `${count} ${jobs} on ${machineName} waiting to start`;
}

function PlayGlyph() {
  return (
    <svg
      viewBox="0 0 10 10"
      aria-hidden="true"
      className="size-2.5 shrink-0 text-subtle-foreground"
    >
      <path d="M2.75 1.75v6.5L8.25 5z" fill="currentColor" />
    </svg>
  );
}

function ClockGlyph() {
  return (
    <svg
      viewBox="0 0 10 10"
      fill="none"
      aria-hidden="true"
      data-icon-root=""
      className="size-2.5 shrink-0 text-subtle-foreground"
    >
      <circle cx="5" cy="5" r="3.9" stroke="currentColor" strokeWidth="1.2" />
      <path
        d="M5 2.9V5l1.4 1"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinecap="round"
      />
    </svg>
  );
}

function PauseGlyph() {
  return (
    <svg viewBox="0 0 10 10" aria-hidden="true" className="size-2.5 shrink-0">
      <path d="M2.75 2h1.5v6h-1.5zM5.75 2h1.5v6h-1.5z" fill="currentColor" />
    </svg>
  );
}

function JobCount({
  glyph,
  count,
  word,
  label,
  hint,
  tooltipSide,
  className,
}: {
  glyph: ReactNode;
  count: number;
  word: string;
  label: string;
  hint: string;
  tooltipSide: TooltipSide;
  className?: string;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          tabIndex={0}
          role="img"
          aria-label={label}
          className={cn(
            "-mx-1 flex h-5 cursor-default items-center gap-1 rounded-sm px-1",
            count === 0 ? "text-subtle-foreground" : "text-sidebar-foreground",
            FOCUS_RING_CLASS,
            className,
          )}
        >
          {glyph}
          <span className={count === 0 ? undefined : "font-semibold"}>
            {count}
          </span>
          <span className="font-normal text-muted-foreground @max-[52rem]/app-footer:hidden">
            {word}
          </span>
        </span>
      </TooltipTrigger>
      <TooltipContent side={tooltipSide}>{hint}</TooltipContent>
    </Tooltip>
  );
}

function isOnline() {
  return onlineManager.isOnline();
}

function useResourcesReading() {
  const online = useSyncExternalStore(
    onlineManager.subscribe,
    isOnline,
    isOnline,
  );

  const [selectedId, setSelectedId] = useState<string | null>(null);

  const query = useQuery({
    queryKey: ["plugins", "resources", "rail-overview"],
    queryFn: ({ signal }) =>
      sdk.plugins.callRpc({
        pluginId: "resources",
        method: "overview",
        input: null,
        outputSchema: overviewSchema,
        signal: AbortSignal.any([signal, AbortSignal.timeout(6000)]),
      }),
    refetchInterval: 5000,
    retry: false,
    gcTime: 0,
  });

  const machines = query.data?.machines ?? [];

  const picker = machines.length > 1;

  const machine =
    selectedId === null || !picker
      ? (machines.find((item) => item.connected && !item.error) ?? machines[0])
      : machines.find((item) => item.id === selectedId);

  const snapshot = machine?.snapshot;

  const status: ResourcesStatus | null = !online
    ? "Offline"
    : query.isError
      ? "Unavailable"
      : query.isPending
        ? "Loading"
        : machines.length === 0
          ? "No hosts"
          : !machine
            ? "Unavailable"
            : !machine.connected
              ? "Offline"
              : machine.error || !snapshot || machine.observedAt === null
                ? "Unavailable"
                : null;

  const active = snapshot?.jobs.filter(
    (job) => job.state !== "queued" && !terminalStates.has(job.state),
  );

  const queued =
    snapshot?.jobs.filter((job) => job.state === "queued").length ?? 0;

  const used = snapshot
    ? Math.min(
        snapshot.cpu,
        (active ?? []).reduce((sum, job) => sum + job.cpu, 0),
      )
    : 0;

  const gpuState = snapshot?.gpu?.state;

  return {
    machines,
    picker,
    machine,
    snapshot,
    status,
    active,
    queued,
    used,
    gpuState,
    selectMachine: setSelectedId,
  };
}

export function ResourcesRailWidget() {
  return <ResourcesFooterReading reading={useResourcesReading()} />;
}

type ResourcesReading = ReturnType<typeof useResourcesReading>;

function FooterCpuBar({ used, total }: { used: number; total: number }) {
  const fill =
    total > 0 && used >= total ? "bg-warning" : "bg-sidebar-foreground/55";

  return (
    <span
      aria-hidden="true"
      className="h-1 w-8 shrink-0 overflow-hidden rounded-full bg-sidebar-foreground/15 @max-[52rem]/app-footer:hidden"
    >
      <span
        className={cn("block h-full rounded-full", fill)}
        style={{ width: `${total > 0 ? (used / total) * 100 : 0}%` }}
      />
    </span>
  );
}

function FooterHostPicker({
  machines,
  machine,
  onSelect,
}: {
  machines: readonly ResourcesMachine[];
  machine: ResourcesMachine | undefined;
  onSelect: (machineId: string) => void;
}) {
  const name = machine?.name ?? "Host";

  return (
    <DropdownMenu>
      <Tooltip>
        <DropdownMenuTrigger asChild>
          <TooltipTrigger asChild>
            <button
              type="button"
              aria-label={`Resources machine: ${name}`}
              className={cn(
                "-mx-1.5 flex h-6 min-w-0 shrink items-center gap-1.5 rounded-md px-1.5 font-medium text-sidebar-foreground outline-none hover:bg-state-hover focus-visible:ring-1 focus-visible:ring-sidebar-ring data-[state=open]:bg-state-active",
                CONTROL_PRESS_TRANSITION,
                CONTROL_PRESS_FEEDBACK,
              )}
            >
              <Icon
                name="Laptop"
                className="size-3.5 shrink-0 text-muted-foreground"
                aria-hidden="true"
              />
              <span className="min-w-0 truncate @max-[30rem]/app-footer:hidden">
                {name}
              </span>
              <Icon
                name="ChevronDown"
                className="size-3 shrink-0 text-subtle-foreground @max-[30rem]/app-footer:hidden"
                aria-hidden="true"
              />
            </button>
          </TooltipTrigger>
        </DropdownMenuTrigger>
        <TooltipContent side="top">Choose the Resources machine</TooltipContent>
      </Tooltip>
      <DropdownMenuContent
        side="top"
        align="start"
        mobileTitle="Resources machine"
      >
        <DropdownMenuLabel>Resources machine</DropdownMenuLabel>
        <DropdownMenuRadioGroup
          value={machine?.id ?? ""}
          onValueChange={onSelect}
        >
          {machines.map((item) => (
            <DropdownMenuRadioItem key={item.id} value={item.id}>
              {item.name}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function ResourcesFooterReading({ reading }: { reading: ResourcesReading }) {
  const {
    machines,
    picker,
    machine,
    snapshot,
    status,
    active,
    queued,
    used,
    gpuState,
    selectMachine,
  } = reading;

  return (
    <section
      aria-label="Resources"
      data-resources-rail={status === null ? "live" : undefined}
      className="flex h-full min-w-0 shrink items-center gap-4 whitespace-nowrap @max-[30rem]/app-footer:gap-2 text-xs leading-none font-medium text-muted-foreground tabular-nums"
    >
      {machines.length === 0 ? null : picker ? (
        <FooterHostPicker
          machines={machines}
          machine={machine}
          onSelect={selectMachine}
        />
      ) : (
        <span className="min-w-0 truncate font-medium text-sidebar-foreground @max-[30rem]/app-footer:max-w-20">
          {machine?.name ?? "Host"}
        </span>
      )}
      {status !== null ? (
        <span
          role="status"
          aria-label={status}
          className="text-subtle-foreground"
        >
          {RESOURCES_STATUS_TEXT[status]}
        </span>
      ) : machine && snapshot ? (
        <>
          <Tooltip>
            <TooltipTrigger asChild>
              <div
                role="meter"
                tabIndex={0}
                aria-label={`${machine.name}: CPU units in use`}
                aria-valuemin={0}
                aria-valuemax={snapshot.cpu}
                aria-valuenow={used}
                aria-valuetext={`${used} of ${snapshot.cpu} CPU units in use`}
                className={cn(
                  "-mx-1 flex h-5 shrink-0 cursor-default items-center gap-1.5 rounded-sm px-1",
                  FOCUS_RING_CLASS,
                )}
              >
                <span className="text-subtle-foreground @max-[30rem]/app-footer:hidden">
                  CPU
                </span>
                <FooterCpuBar used={used} total={snapshot.cpu} />
                <span>
                  <span
                    className={
                      used > 0
                        ? "text-sidebar-foreground"
                        : "text-muted-foreground"
                    }
                  >
                    {used}
                  </span>
                  <span className="text-subtle-foreground">
                    /{snapshot.cpu}
                  </span>
                </span>
              </div>
            </TooltipTrigger>
            <TooltipContent side="top">
              {`Running jobs have reserved ${used} of the ${snapshot.cpu} CPU units on ${machine.name}`}
            </TooltipContent>
          </Tooltip>
          <span className="flex shrink-0 items-center gap-2.5">
            <JobCount
              glyph={<PlayGlyph />}
              count={active?.length ?? 0}
              word="running"
              label={`${machine.name}: ${active?.length ?? 0} running jobs`}
              hint={jobCountText(active?.length ?? 0, "running", machine.name)}
              tooltipSide="top"
            />
            <JobCount
              glyph={<ClockGlyph />}
              count={queued}
              word="queued"
              label={`${machine.name}: ${queued} queued ${queued === 1 ? "job" : "jobs"}`}
              hint={jobCountText(queued, "queued", machine.name)}
              tooltipSide="top"
              className="@max-[30rem]/app-footer:hidden"
            />
          </span>
          {gpuState === undefined || gpuState === "unconfigured" ? null : (
            <Tooltip>
              <TooltipTrigger asChild>
                <div
                  tabIndex={0}
                  role="img"
                  aria-label={`${machine.name}: GPU ${gpuState === "checking" ? "checking" : gpuStatus[gpuState].label}`}
                  className={cn(
                    "-mx-1 flex h-5 shrink-0 cursor-default items-center gap-1 rounded-sm px-1 @max-[60rem]/app-footer:hidden",
                    FOCUS_RING_CLASS,
                  )}
                >
                  {gpuState === "checking" ? (
                    <Icon
                      name="Spinner"
                      className="size-2.5 shrink-0 animate-spin text-subtle-foreground"
                      aria-hidden="true"
                    />
                  ) : (
                    <span
                      aria-hidden="true"
                      className={`size-1.5 shrink-0 rounded-full ${gpuStatus[gpuState].dot}`}
                    />
                  )}
                  <span className="text-subtle-foreground">GPU</span>
                  {gpuState === "checking" ? null : (
                    <span className="font-medium text-sidebar-foreground">
                      {gpuStatus[gpuState].label}
                    </span>
                  )}
                </div>
              </TooltipTrigger>
              <TooltipContent side="top">
                {gpuState === "checking"
                  ? `Checking whether the GPU on ${machine.name} is free`
                  : `${gpuStatus[gpuState].hint} on ${machine.name}`}
              </TooltipContent>
            </Tooltip>
          )}
          {snapshot.paused || snapshot.blocked ? (
            <span className="flex shrink-0 items-center gap-1 font-medium text-warning-text">
              <PauseGlyph />
              {snapshot.blocked ? "Held" : "Paused"}
            </span>
          ) : null}
        </>
      ) : null}
    </section>
  );
}
