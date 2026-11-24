import { expect, it } from "vitest";
import { prependOlderTimelineRows } from "@omnyo/client-core";
import type {
  ThreadTimelineResponse,
  TimelinePaginationCursor,
  TimelineRow,
} from "@omnyo/server-contract";
import {
  encodeClientTurnRequestIdNumber,
  threadScope,
  turnScope,
  type GitActivity,
} from "@omnyo/domain";
import {
  createConnection,
  createProject,
  createThread,
  insertEvents,
  migrate,
  noopNotifier,
  upsertHost,
} from "@omnyo/db";
import { buildThreadTimelineWithProfile } from "../../../src/services/threads/timeline.js";

const providerThreadId = "provider-root";

const activity: GitActivity = {
  commits: [
    {
      sha: "a".repeat(40),
      subject: "feat: ship the pill",
      kind: "commit",
      branch: "main",
      replacedSha: null,
      committedAt: 1_000,
      remoteRefs: ["origin/main"],
    },
  ],
  pushes: [
    {
      remote: "origin",
      branch: "main",
      oldSha: "b".repeat(40),
      newSha: "a".repeat(40),
      forced: false,
      pushedAt: 1_000,
      commitCount: 1,
    },
  ],
  remotes: [{ name: "origin", url: "git@github.com:owner/repo.git" }],
};

const options = {
  completedTurnDisplay: "collapse",
  includeClearedContextHistory: false,
  includeDiagnosticOperations: false,
  compactionOfferEnabled: false,
  includeNestedRows: true,
  maxInlineOutputChars: null,
  maxSeq: undefined,
} as const;

it("keeps a turn's git activity on every page when it lands after the next turn started", () => {
  const db = createConnection(":memory:");
  migrate(db);

  const host = upsertHost(db, noopNotifier, { name: "test-host" });

  const { project } = createProject(db, noopNotifier, {
    name: "test-project",
    source: { type: "local_path", hostId: host.id, path: "/tmp/test" },
  });

  const thread = createThread(db, noopNotifier, {
    projectId: project.id,
    providerId: "claude-code",
  });

  const events: Parameters<typeof insertEvents>[2] = [];

  const push = (
    event: Omit<Parameters<typeof insertEvents>[2][number], "sequence">,
  ): void => {
    events.push({ ...event, sequence: events.length + 1 });
  };

  const base = {
    threadId: thread.id,
    itemId: null,
    itemKind: null,
    parentToolCallId: null,
  };

  const startTurn = (turn: number): void => {
    const turnId = `turn-${turn}`;
    const clientRequestId = encodeClientTurnRequestIdNumber({ value: turn });
    push({
      ...base,
      type: "client/turn/requested",
      scope: threadScope(),
      data: JSON.stringify({
        direction: "outbound",
        source: "tell",
        initiator: "user",
        request: { method: "turn/start", params: {} },
        requestId: clientRequestId,
        senderThreadId: null,
        input: [{ type: "text", text: `User message ${turn}`, mentions: [] }],
        target: turn === 1 ? { kind: "thread-start" } : { kind: "new-turn" },
        execution: {
          model: "gpt-5",
          serviceTier: "default",
          reasoningLevel: "medium",
          permissionMode: "full",
          source: "client/turn/requested",
        },
      }),
    });
    push({
      ...base,
      type: "turn/started",
      scope: turnScope(turnId),
      providerThreadId,
      data: "{}",
    });
    push({
      ...base,
      type: "turn/input/accepted",
      scope: turnScope(turnId),
      providerThreadId,
      data: JSON.stringify({ clientRequestId }),
    });
  };

  const finishTurn = (turn: number): void => {
    const turnId = `turn-${turn}`;

    for (let item = 0; item < 4; item += 1) {
      push({
        ...base,
        type: "item/completed",
        scope: turnScope(turnId),
        providerThreadId,
        itemId: `${turnId}-item-${item}`,
        itemKind: "agentMessage",
        data: JSON.stringify({
          item: {
            type: "agentMessage",
            id: `${turnId}-item-${item}`,
            text: `Turn ${turn} item ${item}`,
          },
        }),
      });
    }

    push({
      ...base,
      type: "turn/completed",
      scope: turnScope(turnId),
      providerThreadId,
      data: JSON.stringify({ status: "completed", providerThreadId }),
    });
  };

  startTurn(1);
  finishTurn(1);
  startTurn(2);
  push({
    ...base,
    type: "system/git-activity",
    scope: turnScope("turn-1"),
    data: JSON.stringify({ workspacePath: "/tmp/test", activity }),
  });
  finishTurn(2);
  startTurn(3);
  finishTurn(3);
  insertEvents(db, noopNotifier, events);

  const canonical = buildThreadTimelineWithProfile(db, thread, {
    ...options,
    eventBudget: 1_000_000,
    page: { kind: "latest", segmentLimit: 100 },
  }).response;

  const withGit = canonical.rows.filter(
    (row) =>
      row.kind === "conversation" &&
      row.role === "assistant" &&
      row.turnGit !== null,
  );

  expect(withGit.map((row) => row.turnId)).toEqual(["turn-1"]);

  let rows: TimelineRow[] = [];
  let cursor: TimelinePaginationCursor | null = null;
  let pages = 0;

  for (let index = 0; index < 50; index += 1) {
    const response: ThreadTimelineResponse = buildThreadTimelineWithProfile(
      db,
      thread,
      {
        ...options,
        eventBudget: 3,
        page: cursor
          ? { kind: "older", beforeCursor: cursor, segmentLimit: 1 }
          : { kind: "latest", segmentLimit: 1 },
      },
    ).response;

    pages += 1;
    rows = prependOlderTimelineRows({
      loadedRows: rows,
      olderRows: response.rows,
    });
    cursor = response.timelinePage.olderCursor;

    if (cursor === null) break;
  }

  expect(pages).toBeGreaterThan(1);
  expect(rows).toEqual(canonical.rows);
  db.$client.close();
});
