import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  blockedByQuestionsMs,
  completionPauseArgs,
  durableQuestionIntervals,
  interactionIntervals,
  intersectIntervals,
  mergeIntervals,
  renderMarkdown,
  resolveCommand,
  runCheck,
  summarizeWindow,
  turnIntervals,
} from "./claude-question-savings.mjs";

const MINUTE = 60_000;

const HOUR = 60 * MINUTE;

const DAY = 24 * HOUR;

const T0 = Date.UTC(2026, 10, 1);

function turnEvents(turns) {
  return turns.flatMap(([turnId, start, end], index) => [
    {
      seq: index * 2 + 1,
      type: "turn/started",
      createdAt: start,
      scope: { turnId },
    },
    ...(end === null
      ? []
      : [
          {
            seq: index * 2 + 2,
            type: "turn/completed",
            createdAt: end,
            scope: { turnId },
          },
        ]),
  ]);
}

function lifecycle(
  seq,
  id,
  status,
  createdAt,
  kind = "user_question",
  providerId = "claude-code",
) {
  return {
    seq,
    type: "system/interaction/lifecycle",
    createdAt,
    data: {
      interaction: {
        id,
        status,
        payload: { kind },
        origin: { kind: "provider", providerId },
      },
    },
  };
}

test("merges and intersects intervals", () => {
  assert.deepEqual(
    mergeIntervals([
      [5, 7],
      [1, 3],
      [2, 4],
      [8, 8],
    ]),
    [
      [1, 4],
      [5, 7],
    ],
  );
  assert.deepEqual(
    intersectIntervals(
      [[0, 10]],
      [
        [2, 3],
        [8, 12],
      ],
    ),
    [
      [2, 3],
      [8, 10],
    ],
  );
});

test("builds turn spans from completed, interrupted and still-open turns", () => {
  const window = { from: T0, to: T0 + 10 * HOUR };

  const events = [
    ...turnEvents([
      ["t1", T0 - HOUR, T0 + HOUR],
      ["t2", T0 + 2 * HOUR, null],
    ]),
    { seq: 10, type: "system/thread/interrupted", createdAt: T0 + 3 * HOUR },
    {
      seq: 11,
      type: "turn/started",
      createdAt: T0 + 9 * HOUR,
      scope: { turnId: "t3" },
    },
  ];

  assert.deepEqual(turnIntervals(events, window), [
    [T0, T0 + HOUR],
    [T0 + 2 * HOUR, T0 + 3 * HOUR],
    [T0 + 9 * HOUR, T0 + 10 * HOUR],
  ]);
});

test("reads provider question and approval waits, including legacy event types", () => {
  const entries = interactionIntervals([
    lifecycle(1, "q1", "pending", T0),
    lifecycle(2, "q1", "resolving", T0 + 2 * HOUR),
    lifecycle(3, "q1", "resolved", T0 + 2 * HOUR + MINUTE),
    lifecycle(4, "late", "resolved", T0 + HOUR),
    {
      seq: 5,
      type: "system/userQuestion/lifecycle",
      createdAt: T0 + HOUR,
      data: {
        interactionId: "q2",
        status: "pending",
        payload: { kind: "user_question" },
      },
    },
    {
      seq: 6,
      type: "system/permissionGrant/lifecycle",
      createdAt: T0 + HOUR,
      data: { interactionId: "a1", status: "pending" },
    },
    {
      seq: 7,
      type: "system/permissionGrant/lifecycle",
      createdAt: T0 + 90 * MINUTE,
      data: { interactionId: "a1", status: "resolved" },
    },
  ]);

  assert.deepEqual(
    entries.map(({ id, kind, providerId, start, end }) => ({
      id,
      kind,
      providerId,
      start,
      end,
    })),
    [
      {
        id: "q1",
        kind: "user_question",
        providerId: "claude-code",
        start: T0,
        end: T0 + 2 * HOUR + MINUTE,
      },
      {
        id: "q2",
        kind: "user_question",
        providerId: null,
        start: T0 + HOUR,
        end: null,
      },
      {
        id: "a1",
        kind: "approval",
        providerId: null,
        start: T0 + HOUR,
        end: T0 + 90 * MINUTE,
      },
    ],
  );
});

test("counts busy time only while every running chat waits on a question", () => {
  const blocked = blockedByQuestionsMs([
    { turns: [[0, 10 * HOUR]], held: [[2 * HOUR, 10 * HOUR]] },
    {
      turns: [
        [0, 4 * HOUR],
        [8 * HOUR, 9 * HOUR],
      ],
      held: [],
    },
  ]);

  assert.equal(blocked, 2 * HOUR + 3 * HOUR);
});

test("summarizes question waits per window and counts each question once", () => {
  const before = { from: T0, to: T0 + DAY };
  const after = { from: T0 + DAY, to: T0 + 2 * DAY };

  const thread = {
    id: "thr_claude",
    providerId: "claude-code",
    visibility: "visible",
    turns: [[T0 + 20 * HOUR, T0 + 26 * HOUR]],
    interactions: [
      {
        id: "q1",
        kind: "user_question",
        providerId: "claude-code",
        seq: 3,
        start: T0 + 22 * HOUR,
        end: T0 + 26 * HOUR,
      },
    ],
    durable: durableQuestionIntervals([
      {
        id: "d1",
        state: "answered",
        createdAt: T0 + 30 * HOUR,
        updatedAt: T0 + 32 * HOUR,
      },
    ]),
  };

  const first = summarizeWindow([thread], before);
  const second = summarizeWindow([thread], after);

  assert.equal(first.nativeQuestions["claude-code"].count, 1);
  assert.equal(first.nativeQuestions["claude-code"].turnHeldHours, 2);
  assert.equal(second.nativeQuestions["claude-code"].count, 0);
  assert.equal(second.nativeQuestions["claude-code"].turnHeldHours, 2);
  assert.equal(second.durableQuestions["claude-code"].count, 1);
  assert.equal(second.durableQuestions["claude-code"].turnHeldHours, 0);
  assert.equal(second.claudeDurableShare, 1);
  assert.equal(first.claudeHeldShare, 1);
  assert.equal(first.medianClaudeQuestionTurnMinutes, 120);
  assert.equal(second.claudeHeldShare, 0);
  assert.equal(second.medianClaudeQuestionTurnMinutes, 0);
  assert.equal(second.claudeFreedHours, 2);
  assert.equal(first.blockedByQuestionsHours, 2);
  assert.equal(first.blockingQuestionTurnHours, 2);
  assert.equal(second.blockingQuestionTurnHours, 2);
  assert.equal(second.durableQuestionTurnHours, 0);
  assert.deepEqual(second.guards.answersWithoutFollowUp, [
    { threadId: "thr_claude", questionId: "d1" },
  ]);
});

test("flags Claude turns that keep running long after a durable question", () => {
  const window = { from: T0, to: T0 + DAY };

  const summary = summarizeWindow(
    [
      {
        id: "thr_wait",
        providerId: "claude-code",
        visibility: "visible",
        turns: [[T0, T0 + 2 * HOUR]],
        interactions: [],
        durable: durableQuestionIntervals([
          { id: "d2", state: "open", createdAt: T0 + 10 * MINUTE },
        ]),
      },
    ],
    window,
  );

  assert.equal(summary.guards.claudeTurnsKeptRunning.length, 1);
  assert.equal(
    summary.guards.claudeTurnsKeptRunning[0].minutesAfterAsking,
    110,
  );
});

function fakeCli({ native, finishedAt = new Date(T0).toISOString() }) {
  const calls = [];

  return {
    calls,
    cli: async (args) => {
      calls.push(args.join(" "));

      if (args[0] === "provider")
        return [
          {
            id: "claude-code",
            capabilities: { supportsNativeUserQuestion: native },
          },
        ];

      if (args[0] === "updates")
        return {
          current: { version: "0.46.210+private.1" },
          lastResult: { to: { version: "0.46.210+private.1" }, finishedAt },
        };
      throw new Error(`unexpected omnyo call ${args.join(" ")}`);
    },
  };
}

const emptyCollect = async () => ({
  threads: [],
  listed: 0,
  eligible: 0,
  fetchErrors: [],
});

test("waits quietly until the coordinator stops declaring Claude's own question tool", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "question-savings-"));

  try {
    const { cli } = fakeCli({ native: true });

    const result = await runCheck({
      stateDir,
      now: T0,
      cli,
      collect: emptyCollect,
      publish: async () => {},
    });

    assert.equal(result.status, "waiting");
    await assert.rejects(
      readFile(join(stateDir, "claude-question-savings-state.json")),
      { code: "ENOENT" },
    );
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});

test("records the fix time once and publishes each milestone report once", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "question-savings-"));
  const published = [];
  const publish = async (report) => published.push(report);

  try {
    const { cli } = fakeCli({ native: false });

    const detected = await runCheck({
      stateDir,
      now: T0 + HOUR,
      cli,
      collect: emptyCollect,
      publish,
    });

    assert.equal(detected.status, "measuring");

    const state = JSON.parse(
      await readFile(
        join(stateDir, "claude-question-savings-state.json"),
        "utf8",
      ),
    );

    assert.equal(state.fixAt, T0);
    assert.equal(
      state.fixAtSource,
      "coordinator update to 0.46.210+private.1 finished",
    );

    await runCheck({
      stateDir,
      now: T0 + 3 * DAY,
      cli,
      collect: emptyCollect,
      publish,
    });
    await runCheck({
      stateDir,
      now: T0 + 3 * DAY + HOUR,
      cli,
      collect: emptyCollect,
      publish,
    });
    assert.deepEqual(
      published.map(({ day, final }) => ({ day, final })),
      [{ day: 3, final: false }],
    );
    assert.match(
      published[0].markdown,
      /# Claude question savings: day 3 after the fix/,
    );

    const done = await runCheck({
      stateDir,
      now: T0 + 8 * DAY,
      cli,
      collect: emptyCollect,
      publish,
    });

    assert.equal(done.status, "complete");
    assert.deepEqual(
      published.map(({ day, final }) => ({ day, final })),
      [
        { day: 3, final: false },
        { day: 7, final: true },
      ],
    );
    assert.ok(
      (await readFile(join(stateDir, "report-day7.json"), "utf8")).includes(
        '"reportDay": 7',
      ),
    );
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});

test("renders the comparison table with per-day rows and guard counts", () => {
  const window = { from: T0, to: T0 + DAY };
  const summary = summarizeWindow([], window);

  const markdown = renderMarkdown({
    fixCommit: "24323a8d0f",
    fixAt: new Date(T0).toISOString(),
    fixAtSource: "test",
    reportDay: 3,
    listed: 0,
    eligible: 0,
    fetchErrors: [],
    before: summary,
    after: summary,
  });

  assert.match(
    markdown,
    /\| Turn hours blocked by Codex questions, per day \(control\) \| 0\.0 \| 0\.0 \| 0% \|/,
  );
  assert.match(markdown, /Durable answers with no turn within 15 minutes: 0/);
});

test("runs the check when an Omnyo automation starts the script without arguments", () => {
  assert.deepEqual(resolveCommand([], { OMNYO_AUTOMATION_ID: "auto_x" }), [
    "check",
  ]);
  assert.deepEqual(resolveCommand([], {}), []);
  assert.deepEqual(
    resolveCommand(["measure", "--from", "x"], {
      OMNYO_AUTOMATION_ID: "auto_x",
    }),
    ["measure", "--from", "x"],
  );
});

test("pauses the finished automation in its own project", () => {
  assert.deepEqual(
    completionPauseArgs({
      OMNYO_AUTOMATION_ID: "auto_x",
      OMNYO_PROJECT_ID: "proj_x",
    }),
    ["automation", "pause", "auto_x", "--project", "proj_x"],
  );
  assert.throws(
    () => completionPauseArgs({ OMNYO_AUTOMATION_ID: "auto_x" }),
    /OMNYO_PROJECT_ID is required to pause the automation/,
  );
});
