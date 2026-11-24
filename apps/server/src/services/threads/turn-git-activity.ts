import { and, desc, eq, gt, inArray, isNull, or, sql } from "drizzle-orm";
import { unionAll } from "drizzle-orm/sqlite-core";
import path from "node:path";
import {
  events,
  environments,
  threads,
  getEnvironment,
  getSessionById,
  getThread,
  hasThreadUpdateBackgroundWork,
  listLatestOpenBackgroundTaskStateRowsForThread,
  type DbConnection,
} from "@omnyo/db";
import {
  turnScope,
  type GitActivity,
  type ThreadEventType,
} from "@omnyo/domain";
import { COMMAND_TIMEOUT_MS } from "../../constants.js";
import type { WorkSessionDeps } from "../../types.js";
import {
  requireWorkspaceCommandTarget,
  type WorkspaceCommandTarget,
} from "../environments/workspace-command-target.js";
import { callHostRetryableOnlineRpc } from "../hosts/online-rpc.js";
import { appendThreadEvent } from "./thread-events.js";

interface TurnKey {
  threadId: string;
  turnId: string;
}

interface TurnCommandEventRow {
  type: ThreadEventType;
  itemId: string | null;
  parentToolCallId: string | null;
  createdAt: number;
  command: string | null;
  cwd: string | null;
}

type CommandEventRole = "started" | "completed" | "background";

interface GitCommandSpan {
  command: string | null;
  cwd: string | null;
  started: number[];
  completed: number[];
  background: number[];
  backgroundCompleted: number[];
}

interface GitCommandWindow {
  startMs: number;
  endMs: number;
  cwd: string;
}

export const GIT_ACTIVITY_MIN_PROTOCOL_VERSION = 258;

const GIT_COMMAND_PATTERN = /\bgit\b/u;

const GIT_HISTORY_SUBCOMMAND_PATTERN =
  /\b(?:commit|push|merge|cherry-pick|revert|pull|am)\b/u;

const GIT_COMMAND_WINDOW_PADDING_MS = 2_000;

const MAX_GIT_COMMAND_WINDOWS = 200;

const MAX_GIT_ACTIVITY_COMMITS = 50;

const MAX_GIT_ACTIVITY_PUSHES = 50;

const COMMAND_ITEM_EVENT_TYPES: ThreadEventType[] = [
  "item/started",
  "item/completed",
];

const BACKGROUND_TASK_EVENT_TYPES: ThreadEventType[] = [
  "item/backgroundTask/progress",
  "item/backgroundTask/completed",
];

const COMMAND_EVENT_ROLE_BY_TYPE: Partial<
  Record<ThreadEventType, CommandEventRole>
> = {
  "item/started": "started",
  "item/completed": "completed",
  "item/backgroundTask/progress": "background",
  "item/backgroundTask/completed": "background",
};

function listTurnCommandEventRows(
  db: DbConnection,
  key: TurnKey,
): TurnCommandEventRow[] {
  const fields = {
    type: events.type,
    itemId: events.itemId,
    parentToolCallId: events.parentToolCallId,
    createdAt: events.createdAt,
    command: sql<string | null>`json_extract(${events.data}, '$.item.command')`,
    cwd: sql<string | null>`json_extract(${events.data}, '$.item.cwd')`,
  };

  const inTurn = and(
    eq(events.threadId, key.threadId),
    eq(events.turnId, key.turnId),
  );

  const commandItem = and(
    inArray(events.type, COMMAND_ITEM_EVENT_TYPES),
    eq(events.itemKind, "commandExecution"),
  );

  const turnRows = db
    .select(fields)
    .from(events)
    .where(and(inTurn, or(commandItem, eq(events.type, "turn/completed"))));

  const backgroundRows = db
    .select(fields)
    .from(events)
    .where(
      and(
        eq(events.threadId, key.threadId),
        inArray(events.type, BACKGROUND_TASK_EVENT_TYPES),
        eq(events.itemKind, "backgroundTask"),
        inArray(
          events.parentToolCallId,
          db
            .select({ itemId: events.itemId })
            .from(events)
            .where(and(inTurn, commandItem)),
        ),
      ),
    );

  return unionAll(turnRows, backgroundRows).all();
}

function hasTurnGitActivity(db: DbConnection, key: TurnKey): boolean {
  return (
    db
      .select({ id: events.id })
      .from(events)
      .where(
        and(
          eq(events.threadId, key.threadId),
          eq(events.turnId, key.turnId),
          eq(events.type, "system/git-activity"),
        ),
      )
      .limit(1)
      .get() !== undefined
  );
}

function isGitHistoryCommand(command: string): boolean {
  return (
    GIT_COMMAND_PATTERN.test(command) &&
    GIT_HISTORY_SUBCOMMAND_PATTERN.test(command)
  );
}

function groupCommandSpans(
  rows: readonly TurnCommandEventRow[],
): GitCommandSpan[] {
  const spans = new Map<string, GitCommandSpan>();

  for (const row of rows) {
    const role = COMMAND_EVENT_ROLE_BY_TYPE[row.type];
    const commandId = role === "background" ? row.parentToolCallId : row.itemId;

    if (role === undefined || commandId === null) {
      continue;
    }

    const span = spans.get(commandId) ?? {
      command: null,
      cwd: null,
      started: [],
      completed: [],
      background: [],
      backgroundCompleted: [],
    };

    span.command ??= row.command;
    span.cwd ??= row.cwd;
    span[role].push(row.createdAt);

    if (row.type === "item/backgroundTask/completed")
      span.backgroundCompleted.push(row.createdAt);
    spans.set(commandId, span);
  }

  return [...spans.values()];
}

function windowForSpan(
  span: GitCommandSpan,
  turnCompletedAt: number,
): GitCommandWindow | null {
  if (
    span.command === null ||
    span.cwd === null ||
    !isGitHistoryCommand(span.command)
  ) {
    return null;
  }

  if (
    /\b(?:cd|chdir|pushd|popd|Set-Location|Push-Location|Pop-Location)\b/iu.test(
      span.command,
    ) ||
    /(?:^|[\s'"])-C/u.test(span.command) ||
    /\bGIT_(?:DIR|WORK_TREE|COMMON_DIR)\s*=|--(?:git-dir|work-tree)(?:=|\s)/u.test(
      span.command,
    )
  )
    return null;

  const startedAt = Math.min(...span.started, ...span.completed);

  if (!Number.isFinite(startedAt)) {
    return null;
  }

  const endedAt = Math.max(
    ...(span.completed.length > 0 ? span.completed : [turnCompletedAt]),
    ...span.background,
  );

  return {
    startMs: Math.max(0, startedAt - GIT_COMMAND_WINDOW_PADDING_MS),
    endMs: endedAt + GIT_COMMAND_WINDOW_PADDING_MS,
    cwd: span.cwd,
  };
}

function mergeWindows(
  windows: readonly GitCommandWindow[],
): GitCommandWindow[] {
  const merged: GitCommandWindow[] = [];

  for (const window of [...windows].sort(
    (left, right) => left.startMs - right.startMs,
  )) {
    const previous = merged.at(-1);

    if (
      previous !== undefined &&
      previous.cwd === window.cwd &&
      window.startMs <= previous.endMs
    ) {
      previous.endMs = Math.max(previous.endMs, window.endMs);
    } else {
      merged.push({ ...window });
    }
  }

  return merged;
}

function buildGitCommandWindows(
  rows: readonly TurnCommandEventRow[],
  turnCompletedAt: number,
): GitCommandWindow[] {
  const windows = groupCommandSpans(rows).flatMap((span) => {
    const window = windowForSpan(span, turnCompletedAt);

    return window === null ? [] : [window];
  });

  return mergeWindows(windows).slice(-MAX_GIT_COMMAND_WINDOWS);
}

function hostSupportsGitActivity(
  deps: Pick<WorkSessionDeps, "db" | "hub">,
  hostId: string,
): boolean {
  const sessionId = deps.hub.getDaemonSessionIdForHost(hostId);

  const session =
    sessionId === null ? null : getSessionById(deps.db, { sessionId });

  return (
    session !== null &&
    session.protocolVersion >= GIT_ACTIVITY_MIN_PROTOCOL_VERSION
  );
}

async function readHostGitActivity(
  deps: WorkSessionDeps,
  key: TurnKey,
  target: WorkspaceCommandTarget,
  windows: GitCommandWindow[],
  repositoryPath: string,
): Promise<GitActivity | null> {
  try {
    const result = await callHostRetryableOnlineRpc(deps, {
      hostId: target.hostId,
      timeoutMs: COMMAND_TIMEOUT_MS,
      command: {
        type: "workspace.gitActivity",
        environmentId: target.environmentId,
        workspaceContext: target.workspaceContext,
        ...(repositoryPath === target.workspaceContext.workspacePath
          ? {}
          : { repositoryPath }),
        windows: windows.map(({ startMs, endMs }) => ({ startMs, endMs })),
        maxCommits: MAX_GIT_ACTIVITY_COMMITS,
        maxPushes: MAX_GIT_ACTIVITY_PUSHES,
      },
    });

    if (result.outcome === "available") {
      return result.activity;
    }

    deps.logger.warn(
      { ...key, failure: result.failure },
      "Turn git activity read was unavailable",
    );
  } catch (error) {
    deps.logger.warn({ ...key, err: error }, "Turn git activity read failed");
  }

  return null;
}

export async function recordTurnGitActivity(
  deps: WorkSessionDeps,
  key: TurnKey,
): Promise<void> {
  if (hasTurnGitActivity(deps.db, key)) {
    return;
  }

  const rows = listTurnCommandEventRows(deps.db, key);

  const turnCompletedAt = Math.max(
    ...rows.flatMap((row) =>
      row.type === "turn/completed" ? [row.createdAt] : [],
    ),
  );

  if (!Number.isFinite(turnCompletedAt)) {
    deps.logger.warn(
      key,
      "Turn git activity skipped without a stored turn completion",
    );

    return;
  }

  const windows = buildGitCommandWindows(rows, turnCompletedAt);

  if (windows.length === 0) {
    return;
  }

  const environmentId = getThread(deps.db, key.threadId)?.environmentId ?? null;

  const environment =
    environmentId === null ? null : getEnvironment(deps.db, environmentId);

  if (environment?.status !== "ready" || environment.path === null) {
    return;
  }

  const target = requireWorkspaceCommandTarget(environment);

  if (!hostSupportsGitActivity(deps, target.hostId)) {
    return;
  }

  const syntax = /^[a-z]:[\\/]|^\\\\/iu.test(environment.path)
    ? path.win32
    : path.posix;

  const grouped = new Map<string, GitCommandWindow[]>();

  for (const window of windows) {
    if (!syntax.isAbsolute(window.cwd)) continue;
    const relative = syntax.relative(environment.path, window.cwd);

    if (
      relative === ".." ||
      relative.startsWith(`..${syntax.sep}`) ||
      syntax.isAbsolute(relative)
    )
      continue;
    const cwd = syntax.normalize(window.cwd);
    grouped.set(cwd, [...(grouped.get(cwd) ?? []), window]);
  }

  const earliestWindow = Math.min(...windows.map((window) => window.startMs));

  const hostThreads = deps.db
    .select({
      id: threads.id,
      status: threads.status,
      statusChangedAt: threads.statusChangedAt,
    })
    .from(threads)
    .innerJoin(environments, eq(threads.environmentId, environments.id))
    .where(eq(environments.hostId, target.hostId))
    .all();

  for (const peer of hostThreads) {
    if (hasThreadUpdateBackgroundWork(deps.db, peer.id)) {
      if (peer.id !== key.threadId) return;

      const ownCommands = new Set(
        rows.flatMap((row) => (row.itemId === null ? [] : [row.itemId])),
      );

      if (
        listLatestOpenBackgroundTaskStateRowsForThread(deps.db, {
          threadId: peer.id,
        }).some(
          (row) =>
            row.parentToolCallId === null ||
            !ownCommands.has(row.parentToolCallId),
        )
      )
        return;
    }

    if (
      !["active", "starting", "stopping"].includes(peer.status) &&
      peer.statusChangedAt < earliestWindow
    )
      continue;

    const boundary = deps.db
      .select({ sequence: events.sequence })
      .from(events)
      .where(
        and(
          eq(events.threadId, peer.id),
          eq(events.type, "turn/completed"),
          sql`${events.createdAt} < ${earliestWindow}`,
        ),
      )
      .orderBy(desc(events.sequence))
      .limit(1)
      .get();

    const peerFields = {
      type: events.type,
      itemId: events.itemId,
      parentToolCallId: events.parentToolCallId,
      createdAt: events.createdAt,
      command: sql<
        string | null
      >`json_extract(${events.data}, '$.item.command')`,
      cwd: sql<string | null>`json_extract(${events.data}, '$.item.cwd')`,
    };

    const peerScope = and(
      eq(events.threadId, peer.id),
      gt(events.sequence, boundary?.sequence ?? 0),
      peer.id === key.threadId
        ? or(isNull(events.turnId), sql`${events.turnId} <> ${key.turnId}`)
        : undefined,
    );

    const peerCommands = deps.db
      .select(peerFields)
      .from(events)
      .where(
        and(
          peerScope,
          inArray(events.type, COMMAND_ITEM_EVENT_TYPES),
          eq(events.itemKind, "commandExecution"),
        ),
      );

    const peerBackground = deps.db
      .select(peerFields)
      .from(events)
      .where(
        and(
          peerScope,
          inArray(events.type, BACKGROUND_TASK_EVENT_TYPES),
          eq(events.itemKind, "backgroundTask"),
        ),
      );

    const otherRows = unionAll(peerCommands, peerBackground).limit(1001).all();

    if (otherRows.length === 1001) return;

    for (const span of groupCommandSpans(otherRows)) {
      if (span.command === null || !isGitHistoryCommand(span.command)) continue;

      const startMs = Math.min(...span.started, ...span.completed);

      const pendingBackground =
        span.background.length > 0 &&
        Math.max(...span.background) > Math.max(...span.backgroundCompleted);

      const endMs =
        span.completed.length === 0 || pendingBackground
          ? Number.POSITIVE_INFINITY
          : Math.max(...span.completed, ...span.background);

      if (
        windows.some(
          (window) => startMs <= window.endMs && endMs >= window.startMs,
        )
      )
        return;
    }
  }

  const results = await Promise.all(
    [...grouped]
      .sort(([left], [right]) => left.localeCompare(right))
      .slice(0, 8)
      .map(async ([cwd, ownWindows]) => ({
        cwd,
        activity: await readHostGitActivity(deps, key, target, ownWindows, cwd),
      })),
  );

  if (hasTurnGitActivity(deps.db, key)) return;

  const seenCommits = new Set<string>();
  const seenPushes = new Set<string>();

  for (const { cwd, activity } of results) {
    if (
      activity === null ||
      (activity.commits.length === 0 && activity.pushes.length === 0)
    )
      continue;

    const commits = activity.commits.filter((commit) => {
      if (seenCommits.has(commit.sha)) return false;
      seenCommits.add(commit.sha);

      return true;
    });

    const pushes = activity.pushes.filter((push) => {
      const pushKey = JSON.stringify([
        push.oldSha,
        push.newSha,
        push.pushedAt,
        push.remote,
        push.branch,
      ]);

      if (seenPushes.has(pushKey)) return false;
      seenPushes.add(pushKey);

      return true;
    });

    if (commits.length === 0 && pushes.length === 0) continue;
    appendThreadEvent(deps, {
      threadId: key.threadId,
      environmentId: target.environmentId,
      type: "system/git-activity",
      scope: turnScope(key.turnId),
      data: { workspacePath: cwd, activity: { ...activity, commits, pushes } },
    });
  }
}
