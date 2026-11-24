import { createContext, useContext } from "react";
import { cn } from "@omnyo/shared-ui/lib/utils";

export type TimelineStepState = "idle" | "running" | "failed";

export type TimelineStepLine = "none" | "from-dot" | "through" | "to-dot";

export type TimelineStepRail =
  | {
      role: "head";
      line: TimelineStepLine;
      startsRun: boolean;
      hasWork: boolean;
      state: TimelineStepState;
    }
  | { role: "work"; line: TimelineStepLine; followsHead: boolean };

export type TimelineStepLink =
  | { kind: "head"; continuesTurn: boolean }
  | { kind: "work"; continuesTurn: boolean; state: TimelineStepState }
  | { kind: "other" };

const STATE_RANK: Record<TimelineStepState, number> = {
  idle: 0,
  failed: 1,
  running: 2,
};

function strongerState(
  current: TimelineStepState,
  next: TimelineStepState,
): TimelineStepState {
  return STATE_RANK[next] > STATE_RANK[current] ? next : current;
}

export function timelineStepRails(
  links: readonly TimelineStepLink[],
): (TimelineStepRail | null)[] {
  const runIds: (number | null)[] = [];
  let runId = -1;
  let inRun = false;

  for (const link of links) {
    if (link.kind === "head") {
      if (!inRun || !link.continuesTurn) runId += 1;
      inRun = true;
      runIds.push(runId);
      continue;
    }

    if (link.kind === "work" && inRun && link.continuesTurn) {
      runIds.push(runId);
      continue;
    }

    inRun = false;
    runIds.push(null);
  }

  const headIndexesByRun = new Map<number, number[]>();
  runIds.forEach((id, index) => {
    if (id === null || links[index]?.kind !== "head") return;
    const heads = headIndexesByRun.get(id) ?? [];
    heads.push(index);
    headIndexesByRun.set(id, heads);
  });

  const lineAt = (index: number, id: number): TimelineStepLine => {
    const heads = headIndexesByRun.get(id) ?? [];
    const first = heads[0];
    const last = heads[heads.length - 1];

    if (first === undefined || last === undefined || first === last) {
      return "none";
    }

    if (index === first) return "from-dot";

    if (index === last) return "to-dot";

    return index > first && index < last ? "through" : "none";
  };

  return links.map((link, index) => {
    const id = runIds[index];

    if (id === null || id === undefined) return null;

    const line = lineAt(index, id);

    if (link.kind === "work") {
      return {
        role: "work",
        line,
        followsHead:
          links[index - 1]?.kind === "head" && runIds[index - 1] === id,
      };
    }

    if (link.kind !== "head") return null;

    let hasWork = false;
    let state: TimelineStepState = "idle";

    for (let next = index + 1; next < links.length; next += 1) {
      const nextLink = links[next];

      if (runIds[next] !== id || nextLink?.kind !== "work") break;

      hasWork = true;
      state = strongerState(state, nextLink.state);
    }

    return {
      role: "head",
      line,
      startsRun: runIds[index - 1] !== id,
      hasWork,
      state,
    };
  });
}

const STEP_LINE_CLASS_NAME: Record<TimelineStepLine, string | null> = {
  none: null,
  "from-dot": "before:top-[11px] before:bottom-0",
  through: "before:top-0 before:bottom-0",
  "to-dot": "before:top-0 before:h-[11px]",
};

const STEP_DOT_CLASS_NAME: Record<TimelineStepState, string> = {
  idle: "after:bg-subtle-foreground",
  failed: "after:bg-destructive-text",
  running: "after:bg-timeline-accent after:animate-pulse",
};

const SPACED_HEAD_LINE_CLASS_NAME: Partial<Record<TimelineStepLine, string>> = {
  through: "before:-top-4 before:bottom-0",
  "to-dot": "before:-top-4 before:h-[27px]",
};

export function timelineStepRailClassName(rail: TimelineStepRail): string {
  const line =
    rail.role === "head" && !rail.startsRun
      ? (SPACED_HEAD_LINE_CLASS_NAME[rail.line] ??
        STEP_LINE_CLASS_NAME[rail.line])
      : STEP_LINE_CLASS_NAME[rail.line];

  return cn(
    "relative pl-4",
    line !== null &&
      cn(
        "before:pointer-events-none before:absolute before:left-[3.5px] before:w-px before:bg-timeline-rail before:content-['']",
        line,
      ),
    rail.role === "head" &&
      cn(
        "after:pointer-events-none after:absolute after:left-0 after:top-[7px] after:z-10 after:size-2 after:rounded-full after:content-['']",
        STEP_DOT_CLASS_NAME[rail.state],
      ),
  );
}

export const STEP_HEAD_TIME_ROOM_CLASS_NAME = "not-pointer-coarse:pr-30";

export function reservesStepHeadTime(rail: TimelineStepRail | null): boolean {
  return rail?.role === "work" && rail.followsHead;
}

export const TimelineStepRailContext = createContext<TimelineStepRail | null>(
  null,
);

export function useTimelineStepRail(): TimelineStepRail | null {
  return useContext(TimelineStepRailContext);
}
