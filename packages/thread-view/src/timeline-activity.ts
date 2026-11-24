import type { ChildThreadActivityState, ThreadActivity } from "@omnyo/domain";
import type {
  TimelineActivityRef,
  TimelineChildActivityRef,
  TimelinePreviewActivityRef,
  TimelineCommandWorkRow,
  TimelineGenericOperationSystemRow,
  TimelineRow,
} from "@omnyo/server-contract";
import type { ThreadTimelineViewRow } from "./timeline-view.js";

export type TimelineActivitySystemRow<
  TRef extends TimelineActivityRef = TimelineActivityRef,
> = TimelineGenericOperationSystemRow & {
  activityRef: TRef;
};

export function isPreviewActivityRow(
  row: TimelineActivitySystemRow,
): row is TimelineActivitySystemRow<TimelinePreviewActivityRef> {
  return row.activityRef.kind === "preview";
}

export function isChildActivityRow(
  row: TimelineActivitySystemRow,
): row is TimelineActivitySystemRow<TimelineChildActivityRef> {
  return row.activityRef.kind === "child";
}

export function previewActivityDisplayUrl(href: string): string {
  if (!URL.canParse(href)) return href;
  const url = new URL(href);

  if (url.hostname === "127.0.0.1") url.hostname = "localhost";

  return `${url.host}${url.pathname === "/" ? "" : url.pathname}${url.search}${url.hash}`;
}

const CHILD_ACTIVITY_VERB: Record<ChildThreadActivityState, string> = {
  running: "is running",
  finished: "finished",
  failed: "failed",
  interrupted: "was interrupted",
};

export function childActivityVerb(state: ChildThreadActivityState): string {
  return CHILD_ACTIVITY_VERB[state];
}

export function threadActivityTitle(activity: ThreadActivity): string {
  switch (activity.activityKind) {
    case "preview":
      return `Started ${previewActivityDisplayUrl(activity.snapshot.url)}`;
    case "child":
      return `${activity.snapshot.title} ${childActivityVerb(activity.snapshot.state)}`;
  }
}

export function threadActivityDetail(activity: ThreadActivity): string {
  switch (activity.activityKind) {
    case "preview":
      return activity.snapshot.hostName.length > 0
        ? `Dev server on ${activity.snapshot.hostName}`
        : "Dev server";
    case "child":
      return activity.snapshot.summary ?? "";
  }
}

export function toTimelineActivityRef(
  activity: ThreadActivity,
): TimelineActivityRef {
  switch (activity.activityKind) {
    case "preview":
      return {
        kind: "preview",
        previewId: activity.ref.previewId,
        url: activity.snapshot.url,
        hostName: activity.snapshot.hostName,
      };
    case "child":
      return {
        kind: "child",
        threadId: activity.ref.threadId,
        title: activity.snapshot.title,
        state: activity.snapshot.state,
        summary: activity.snapshot.summary,
      };
  }
}

export function isTimelineActivityRow(
  row: TimelineRow | ThreadTimelineViewRow,
): row is TimelineActivitySystemRow {
  return (
    row.kind === "system" &&
    row.systemKind === "operation" &&
    row.operationKind !== "parent-change" &&
    row.activityRef !== undefined
  );
}

const SHELL_WRAPPER_PATTERN =
  /^(?:\S*\/)?(?:bash|zsh|sh)\s+(?:-[A-Za-z]+\s+)*(['"])([\s\S]*)\1$/;

const SHELL_WORD = String.raw`(?:"[^"]*"|'[^']*'|[^\s;&|()'"]+)`;

const LEADING_CD_PATTERN = new RegExp(String.raw`^cd\s+${SHELL_WORD}\s*&&\s*`);

const LEADING_ENV_PATTERN = new RegExp(
  String.raw`^[A-Za-z_][A-Za-z0-9_]*=${SHELL_WORD}?\s+`,
);

const TRAILING_REDIRECT_PATTERN =
  /\s+(?:[0-9]?>{1,2}|&>)\s*(?:&[0-9]|\/dev\/null)$/;

const CLI_PATTERN = /^(?:\S*\/)?(?:omnyo|bb)$/;

const SHELL_CONTROL_PATTERN = /[;&|()<>`$\n]/;

function unquote(token: string): string {
  return /^(['"]).*\1$/.test(token) ? token.slice(1, -1) : token;
}

function stripRepeatedly(text: string, pattern: RegExp): string {
  let current = text;

  let next = current.replace(pattern, "").trim();

  while (next !== current) {
    current = next;
    next = current.replace(pattern, "").trim();
  }

  return current;
}

export function previewIdRestartedByWholeCommand(
  command: string,
): string | null {
  let text = command.trim();

  for (let match = SHELL_WRAPPER_PATTERN.exec(text); match !== null;) {
    text = (match[2] ?? "").trim();
    match = SHELL_WRAPPER_PATTERN.exec(text);
  }

  text = stripRepeatedly(text, LEADING_CD_PATTERN);
  text = stripRepeatedly(text, LEADING_ENV_PATTERN);
  text = stripRepeatedly(text, TRAILING_REDIRECT_PATTERN);

  if (SHELL_CONTROL_PATTERN.test(text)) return null;

  const tokens = text.split(/\s+/).map(unquote);
  const [cli, area, verb, ...rest] = tokens;

  if (
    cli === undefined ||
    !CLI_PATTERN.test(cli) ||
    area !== "preview" ||
    verb !== "restart"
  )
    return null;

  let previewId: string | null = null;

  for (let index = 0; index < rest.length; index += 1) {
    const token = rest[index]!;

    if (token === "--json" || token.startsWith("--request-id=")) continue;

    if (token === "--request-id") {
      if (rest[index + 1] === undefined) return null;
      index += 1;
      continue;
    }

    if (token.startsWith("-") || previewId !== null || token.length === 0)
      return null;
    previewId = token;
  }

  return previewId;
}

function isSuccessfulCommandRow(row: TimelineCommandWorkRow): boolean {
  return (
    row.status === "completed" && (row.exitCode === null || row.exitCode === 0)
  );
}

function isFoldedPreviewRestartCommand(
  row: TimelineRow,
  activities: readonly TimelineActivitySystemRow[],
): boolean {
  if (
    row.kind !== "work" ||
    row.workKind !== "command" ||
    row.turnId === null ||
    !isSuccessfulCommandRow(row)
  )
    return false;

  const previewId = previewIdRestartedByWholeCommand(row.command);

  if (previewId === null) return false;

  return activities.some(
    (activity) =>
      activity.activityRef.kind === "preview" &&
      activity.activityRef.previewId === previewId &&
      activity.turnId === row.turnId &&
      activity.createdAt >= row.startedAt,
  );
}

export function foldActivityCommandRows(
  rows: readonly TimelineRow[],
): readonly TimelineRow[] {
  const activities = rows.filter(isTimelineActivityRow);

  if (activities.length === 0) return rows;

  return rows.filter((row) => !isFoldedPreviewRestartCommand(row, activities));
}
