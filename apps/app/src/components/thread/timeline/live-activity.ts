import type { ActiveThinking } from "@omnyo/domain";
import type { TimelineRow } from "@omnyo/server-contract";
import {
  buildTimelineRowTitle,
  extractShellCommandFromString,
  fileNameFromPath,
} from "@omnyo/thread-view";

function findLiveActivity(
  rows: readonly TimelineRow[],
): Extract<TimelineRow, { kind: "conversation" | "work" }> | null {
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    const row = rows[index];

    if (row === undefined) continue;

    if (row.kind === "conversation") {
      if (row.role === "user" && row.turnRequest.status === "pending") continue;

      return row;
    }

    if (
      row.kind === "turn" &&
      row.status === "pending" &&
      row.children !== null
    ) {
      return findLiveActivity(row.children);
    }

    if (row.kind === "work" && row.status === "pending") return row;
  }

  return null;
}

const LIVE_COMMAND_WORD_LIMIT = 2;

function rowVerb(row: Extract<TimelineRow, { kind: "work" }>): string {
  const verb = buildTimelineRowTitle(row, {
    summaryStyle: "bundle",
    workStyle: "default",
  }).segments[0]?.text;

  return verb?.replace(/:$/u, "") ?? "";
}

interface LiveLabel {
  label: string;
  detail: string;
}

function liveCommandLabel(
  row: Extract<TimelineRow, { workKind: "command" }>,
): LiveLabel {
  const title = buildTimelineRowTitle(row, {
    summaryStyle: "bundle",
    workStyle: "default",
  });

  if (title.segments[0]?.text !== "Running") {
    const label = title.segments.map((segment) => segment.text).join(" ");

    return { label, detail: label };
  }

  const command = (
    extractShellCommandFromString(row.command) ?? row.command
  ).trim();

  const words = command
    .split(/\s+/u)
    .filter((word) => word.length > 0)
    .slice(0, LIVE_COMMAND_WORD_LIMIT);

  if (words.length === 0) {
    return { label: "Running command", detail: "Running command" };
  }

  return { label: `Running ${words.join(" ")}`, detail: `Running ${command}` };
}

function liveSearchLabel(
  row: Extract<TimelineRow, { workKind: "search" }>,
): string {
  const verb = rowVerb(row);

  switch (row.mode) {
    case "content":
      return `${verb} for ${row.query}`;
    case "path":
      return `${verb} for files matching ${row.query}`;
    case "list": {
      const target = row.path ?? row.query;

      return target.length > 0
        ? `${verb} in ${fileNameFromPath(target)}`
        : verb;
    }
  }
}

function liveWorkLabel(
  row: Extract<TimelineRow, { kind: "work" }> | null,
): LiveLabel | undefined {
  if (row === null) return undefined;

  if (
    "approvalStatus" in row &&
    row.approvalStatus === "waiting_for_approval"
  ) {
    return { label: "Waiting for approval", detail: "Waiting for approval" };
  }

  if (row.workKind === "command") return liveCommandLabel(row);

  const label = liveWorkSummary(row);

  return label === undefined ? undefined : { label, detail: label };
}

function liveWorkSummary(
  row: Extract<TimelineRow, { kind: "work" }>,
): string | undefined {
  switch (row.workKind) {
    case "tool":
      return `Using ${row.toolName}`;
    case "file-change":
      return `${rowVerb(row)} ${fileNameFromPath(row.change.movePath ?? row.change.path)}`;
    case "file-read":
      return `${rowVerb(row)} ${fileNameFromPath(row.path)}`;
    case "search":
      return liveSearchLabel(row);
    case "plan-steps":
      return rowVerb(row);
    case "delegation":
      return `Waiting on ${row.subagentType ?? row.description ?? "subagent"}`;
    case "image-generation":
      return "Generating image…";
    case "web-search":
      return "Searching the web…";
    default:
      return undefined;
  }
}

export interface LiveActivitySummary {
  label: string | undefined;
  detail: string | undefined;
  startedAt: number | undefined;
  isThinking: boolean;
}

export function summarizeLiveActivity({
  activeThinking,
  label,
  rows,
}: {
  activeThinking: ActiveThinking | null;
  label: string | undefined;
  rows: readonly TimelineRow[];
}): LiveActivitySummary {
  const liveActivity = findLiveActivity(rows);
  const pendingWork = liveActivity?.kind === "work" ? liveActivity : null;

  const streamingReply =
    liveActivity?.kind === "conversation" &&
    liveActivity.role === "assistant" &&
    liveActivity.status === "streaming"
      ? liveActivity
      : null;

  const isThinking =
    activeThinking !== null &&
    label === undefined &&
    pendingWork === null &&
    streamingReply === null;

  const workLabel =
    label === undefined && streamingReply === null
      ? liveWorkLabel(pendingWork)
      : undefined;

  const resolvedLabel =
    label ?? (streamingReply === null ? workLabel?.label : "Writing reply…");

  return {
    label: resolvedLabel,
    detail: workLabel?.detail ?? resolvedLabel,
    startedAt:
      streamingReply?.startedAt ??
      pendingWork?.startedAt ??
      (isThinking ? activeThinking?.startedAt : undefined),
    isThinking,
  };
}
