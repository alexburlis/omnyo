import { and, eq, sql } from "drizzle-orm";
import { createEventId, events } from "@omnyo/db";
import {
  THREAD_ACTIVITY_OPERATION,
  threadScope,
  type ChildThreadActivity,
  type ChildThreadActivityState,
  type Thread,
} from "@omnyo/domain";
import type { AppDeps } from "../../types.js";
import { appendThreadEvent } from "./thread-events.js";
import { getLastThreadOutput } from "./thread-data.js";

const CHILD_ACTIVITY_SUMMARY_CHAR_LIMIT = 280;

const CHILD_ACTIVITY_LABEL: Record<ChildThreadActivityState, string> = {
  running: "is running",
  finished: "finished",
  failed: "failed",
  interrupted: "was interrupted",
};

const CHILD_ACTIVITY_RAW_STATUS: Record<ChildThreadActivityState, string> = {
  running: "running",
  finished: "completed",
  failed: "failed",
  interrupted: "completed",
};

type QuietParentDeps = Pick<AppDeps, "db" | "hub">;

export function summarizeChildOutput(text: string | null): string | null {
  if (text === null) return null;

  const paragraph = text
    .split(/\n\s*\n/u)
    .map((part) => part.replace(/\s+/gu, " ").trim())
    .find((part) => part.length > 0);

  if (paragraph === undefined) return null;

  return paragraph.length <= CHILD_ACTIVITY_SUMMARY_CHAR_LIMIT
    ? paragraph
    : `${paragraph.slice(0, CHILD_ACTIVITY_SUMMARY_CHAR_LIMIT - 1).trimEnd()}…`;
}

function childActivityOperationId(childThreadId: string): string {
  return `child-activity:${childThreadId}`;
}

function hasSettledChildActivity(
  deps: Pick<AppDeps, "db">,
  args: { parentThreadId: string; operationId: string },
): boolean {
  return (
    deps.db
      .select({ id: events.id })
      .from(events)
      .where(
        and(
          eq(events.threadId, args.parentThreadId),
          eq(events.type, "system/operation"),
          sql`json_extract(${events.data}, '$.operationId') = ${args.operationId}`,
          sql`json_extract(${events.data}, '$.status') != 'running'`,
        ),
      )
      .limit(1)
      .get() !== undefined
  );
}

export function recordQuietParentChildActivity(
  deps: QuietParentDeps,
  args: {
    parent: Pick<Thread, "id" | "environmentId">;
    child: { id: string; title: string | null };
    state: ChildThreadActivityState;
  },
): void {
  const title = args.child.title ?? "Untitled chat";

  const summary =
    args.state === "finished"
      ? summarizeChildOutput(getLastThreadOutput(deps.db, args.child.id))
      : null;

  const rowId = childActivityOperationId(args.child.id);

  const operationId =
    args.state !== "running" &&
    hasSettledChildActivity(deps, {
      parentThreadId: args.parent.id,
      operationId: rowId,
    })
      ? `${rowId}:${createEventId()}`
      : rowId;

  const activity: ChildThreadActivity = {
    activityKind: "child",
    ref: { threadId: args.child.id },
    snapshot: { title, state: args.state, summary },
  };

  appendThreadEvent(deps, {
    threadId: args.parent.id,
    environmentId: args.parent.environmentId,
    type: "system/operation",
    scope: threadScope(),
    data: {
      operation: THREAD_ACTIVITY_OPERATION,
      operationId,
      status: CHILD_ACTIVITY_RAW_STATUS[args.state],
      message: `${title} ${CHILD_ACTIVITY_LABEL[args.state]}`,
      metadata: activity,
    },
  });
}
