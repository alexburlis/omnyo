import type {
  InboxCard,
  InboxCause,
  InboxEntry,
  InboxSnapshot,
  InboxWaitingRow,
} from "@omnyo/domain";
import { describe, expect, it, vi } from "vitest";
import {
  collectLogLines,
  runCommand,
  setupCommandOutputTestEnvironment,
  stubServerApi,
} from "../helpers/command-output-harness.js";
import type { CommandRegistrar } from "../helpers/command-output-harness.js";
import { registerInboxCommands } from "../../commands/inbox.js";

const NOW = Date.parse("2026-10-29T12:00:00Z");

function localTime(at: number): string {
  return new Date(at).toLocaleString(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  });
}

const HOUR = 3_600_000;

const DAY = 24 * HOUR;

function cause(
  receiptId: string,
  summary: string,
  fromTitle: string | null = null,
): InboxCause {
  return {
    receiptId,
    cause: "result",
    threadId: "thr_x",
    fromTitle,
    summary,
    at: NOW - DAY,
  };
}

function card(overrides: Partial<InboxCard>): InboxCard {
  return {
    kind: "result",
    causes: [],
    primary: { kind: "your-call" },
    actions: ["archive", "wait", "reply", "shelf"],
    questionIds: [],
    questionMode: null,
    questionFrom: null,
    snoozedQuestionUntil: null,
    stillOnYou: null,
    notAssessed: null,
    failure: null,
    since: NOW - DAY,
    ...overrides,
  };
}

function entry(overrides: Partial<InboxEntry>): InboxEntry {
  return {
    threadId: "thr_x",
    projectId: "proj-1",
    state: "finished",
    reason: {
      kind: "unassessed",
      text: "Finished, not assessed",
      threadId: "thr_x",
    },
    recap: null,
    archiveReady: false,
    optionalQuestion: null,
    pendingResults: 0,
    title: "Chat",
    shelved: false,
    automationId: null,
    view: "inbox",
    card: null,
    waiting: null,
    running: null,
    runs: null,
    incident: null,
    sortAt: NOW - DAY,
    latch: "latch-x",
    ...overrides,
  };
}

function row(overrides: Partial<InboxWaitingRow>): InboxWaitingRow {
  return {
    group: "comes-back",
    kind: "event",
    reason: "Waiting",
    waitId: null,
    returnAt: null,
    checkAt: null,
    checkCount: 0,
    checking: false,
    guaranteed: false,
    behind: null,
    retry: null,
    questionId: null,
    ...overrides,
  };
}

const question = entry({
  state: "needs-you",
  reason: {
    kind: "question",
    text: "Sub chat: Which branch?",
    threadId: "thr_q",
  },
  threadId: "thr_q",
  title: "Pick a branch",
  latch: "latch-q",
  card: card({
    kind: "question",
    questionMode: "required",
    primary: { kind: "answer" },
    actions: [],
    questionIds: ["q-1"],
    questionFrom: "Sub chat",
    causes: [cause("q1", "Needs your answer: which branch?")],
  }),
});

const problem = entry({
  state: "failed",
  reason: {
    kind: "failure",
    text: "Failed: Provider exited",
    threadId: "thr_p",
  },
  threadId: "thr_p",
  title: "Build",
  latch: "latch-p",
  card: card({
    kind: "problem",
    primary: {
      kind: "resume",
      targetThreadId: "thr_p_step",
      targetTitle: "Build step",
    },
    actions: ["archive", "reply", "shelf"],
    causes: [cause("p1", "The build step stopped")],
    failure: {
      threadId: "thr_p_step",
      reason: "Provider exited",
      queuedCount: 1,
      scheduledCount: 0,
    },
  }),
});

const result = entry({
  state: "waiting",
  reason: { kind: "wait", text: "CI on main", threadId: "thr_r" },
  threadId: "thr_r",
  title: "Release notes",
  shelved: true,
  latch: "latch-r",
  card: card({
    primary: { kind: "ok", thenWaits: "CI on main" },
    causes: [
      cause("r1", "Drafted the notes"),
      cause("r2", "Fixed the changelog"),
      cause("r3", "Answered your question", "Docs chat"),
      cause("r4", "Pushed the branch"),
    ],
  }),
});

const returned = entry({
  state: "needs-you",
  reason: {
    kind: "decision",
    text: "No deploy by 28 Oct · checked 3×",
    threadId: "thr_k",
  },
  threadId: "thr_k",
  title: "Deploy check",
  latch: "latch-k",
  card: card({
    kind: "returned",
    primary: { kind: "keep-waiting", waitId: "wait-k", until: NOW + 7 * DAY },
    causes: [cause("k1", "No deploy by 28 Oct · checked 3×")],
  }),
});

const onYou = entry({
  state: "waiting",
  reason: { kind: "wait", text: "overlap recurs", threadId: "thr_y" },
  threadId: "thr_y",
  title: "Thread list overlap",
  view: "waiting",
  latch: "waiting",
  waiting: row({
    group: "on-you",
    reason: "overlap recurs",
    waitId: "wait-report",
    returnAt: NOW + 14 * DAY,
    guaranteed: true,
  }),
});

const comesBack = entry({
  state: "waiting",
  reason: { kind: "wait", text: "Rankings settle", threadId: "thr_c" },
  threadId: "thr_c",
  title: "SEO checkpoint",
  view: "waiting",
  latch: "waiting",
  waiting: row({
    reason: "Rankings settle",
    waitId: "wait-seo",
    returnAt: NOW + 7 * DAY,
    checkAt: NOW + 2 * HOUR,
    checkCount: 3,
    guaranteed: true,
  }),
});

const running = entry({
  state: "working",
  reason: { kind: "activity", text: "Working", threadId: "thr_run" },
  threadId: "thr_run",
  title: "Build the inbox",
  view: "running",
  latch: "running",
  running: { label: "Working", progress: null },
});

function snapshot(overrides: Partial<InboxSnapshot> = {}): InboxSnapshot {
  return {
    revision: "rev-1",
    generatedAt: NOW,
    inbox: [question, problem, result, returned],
    waiting: [onYou, comesBack],
    running: [running],
    shelf: [result],
    counts: {
      needsYou: 2,
      inbox: 4,
      questions: 1,
      running: 1,
      waiting: 2,
      onYou: ["overlap recurs"],
      nextBackAt: NOW + 7 * DAY,
    },
    lastMove: {
      moveId: "move-9",
      kind: "archive",
      threadId: "thr_old",
      at: NOW - HOUR,
    },
    ...overrides,
  };
}

function logLines(): string[] {
  return collectLogLines(vi.mocked(console.log));
}

function errorLines(): string[] {
  return collectLogLines(vi.mocked(console.error));
}

describe("omnyo inbox command output", () => {
  setupCommandOutputTestEnvironment();

  const register: CommandRegistrar = (program) =>
    registerInboxCommands(
      program.enablePositionalOptions(),
      () => "http://server",
    );

  it("lists retained failure identities without selecting a failure", async () => {
    const result = {
      failures: [
        {
          id: "failure-1",
          threadId: "thr_child",
          turnId: "turn_old",
          requestId: null,
          state: "actionable",
          reason: "Interrupted",
          resolvedBy: null,
        },
      ],
    };

    const list = vi.fn(async () => result);
    stubServerApi({ "v1.threads.:id.failures.$get": list });
    await runCommand(["inbox", "failures", "thr_child", "--json"], register);
    expect(list).toHaveBeenCalledWith(
      expect.objectContaining({ param: { id: "thr_child" } }),
    );
    expect(JSON.parse(logLines()[0] ?? "")).toEqual(result);
  });

  it("acknowledges only explicit identities and preserves the caller environment", async () => {
    vi.stubEnv("OMNYO_THREAD_ID", "thr_parent");

    const result = {
      failure: {
        id: "failure-1",
        threadId: "thr_child",
        turnId: "turn_old",
        requestId: null,
        state: "resolved",
        reason: "Interrupted",
        resolvedBy: "acknowledged",
      },
      acknowledged: true,
    };

    const acknowledge = vi.fn(async () => result);
    stubServerApi({
      "v1.threads.:id.failures.:failureId.acknowledge.$post": acknowledge,
    });
    await runCommand(
      [
        "inbox",
        "acknowledge-failure",
        "thr_child",
        "--failure",
        "failure-1",
        "--turn",
        "turn_old",
        "--reason",
        "Completed elsewhere",
        "--json",
      ],
      register,
    );
    expect(acknowledge).toHaveBeenCalledWith(
      expect.objectContaining({
        param: { id: "thr_child", failureId: "failure-1" },
        json: { turnId: "turn_old", reason: "Completed elsewhere" },
      }),
    );
    expect(process.env.OMNYO_THREAD_ID).toBe("thr_parent");
    expect(JSON.parse(logLines()[0] ?? "")).toEqual(result);
  });

  it.each(["--failure", "--turn", "--reason"])(
    "requires %s without making a request",
    async (missing) => {
      const acknowledge = vi.fn();
      stubServerApi({
        "v1.threads.:id.failures.:failureId.acknowledge.$post": acknowledge,
      });

      const flags = [
        ["--failure", "failure-1"],
        ["--turn", "turn_old"],
        ["--reason", "Completed elsewhere"],
      ]
        .filter(([flag]) => flag !== missing)
        .flat();

      await expect(
        runCommand(
          ["inbox", "acknowledge-failure", "thr_child", ...flags],
          register,
        ),
      ).rejects.toThrow();
      expect(acknowledge).not.toHaveBeenCalled();
    },
  );

  it.each(["--failure", "--turn", "--reason"])(
    "rejects an empty %s before sending a request",
    async (empty) => {
      const acknowledge = vi.fn();
      stubServerApi({
        "v1.threads.:id.failures.:failureId.acknowledge.$post": acknowledge,
      });

      const flags = [
        ["--failure", "failure-1"],
        ["--turn", "turn_old"],
        ["--reason", "Completed elsewhere"],
      ].flatMap(([flag, value]) => [flag, flag === empty ? " " : value]);

      await expect(
        runCommand(
          ["inbox", "acknowledge-failure", "thr_child", ...flags],
          register,
        ),
      ).rejects.toThrow("process.exit:1");
      expect(acknowledge).not.toHaveBeenCalled();
    },
  );

  it("requires an explicit target even inside a caller chat", async () => {
    vi.stubEnv("OMNYO_THREAD_ID", "thr_parent");
    const acknowledge = vi.fn();
    stubServerApi({
      "v1.threads.:id.failures.:failureId.acknowledge.$post": acknowledge,
    });
    await expect(
      runCommand(
        [
          "inbox",
          "acknowledge-failure",
          "--failure",
          "failure-1",
          "--turn",
          "turn_old",
          "--reason",
          "Completed elsewhere",
        ],
        register,
      ),
    ).rejects.toThrow();
    expect(acknowledge).not.toHaveBeenCalled();
  });

  it("reports a server acknowledgment refusal without falling back to an Inbox action", async () => {
    const acknowledge = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            code: "inbox_failure_active",
            message: "Target has active work",
          }),
          { status: 409, headers: { "Content-Type": "application/json" } },
        ),
    );

    stubServerApi({
      "v1.threads.:id.failures.:failureId.acknowledge.$post": acknowledge,
    });
    await expect(
      runCommand(
        [
          "inbox",
          "acknowledge-failure",
          "thr_child",
          "--failure",
          "failure-1",
          "--turn",
          "turn_old",
          "--reason",
          "Completed elsewhere",
        ],
        register,
      ),
    ).rejects.toThrow("process.exit:1");
    expect(acknowledge).toHaveBeenCalledTimes(1);
    expect(errorLines()[0]).toContain("Target has active work");
  });

  it("--json prints the snapshot exactly as the server ordered it", async () => {
    stubServerApi({ "v1.inbox.$get": async () => snapshot() });

    await runCommand(["inbox", "--json"], register);

    expect(JSON.parse(logLines()[0] ?? "")).toEqual(snapshot());
  });

  it("prints the header, the cards in server order, then Waiting and Running", async () => {
    stubServerApi({ "v1.inbox.$get": async () => snapshot() });

    await runCommand(["inbox"], register);

    expect(logLines()).toEqual([
      "Inbox 4 · 1 question",
      `1 running · 2 waiting · next back ${localTime(NOW + 7 * DAY)}`,
      "On you: overlap recurs",
      "",
      "Inbox",
      "  Question · Pick a branch (thr_q) · from Sub chat",
      "    State: needs-you · Sub chat: Which branch?",
      "    Needs your answer: which branch?",
      "    Primary: Answer",
      "  Failed · Build (thr_p)",
      "    State: failed · Failed: Provider exited",
      "    The build step stopped",
      "    Failed: Provider exited · 1 queued message waiting",
      "    Primary: Resume Build step",
      "  Result · Release notes (thr_r) · Shelf",
      "    State: waiting · CI on main",
      "    Drafted the notes",
      "    Fixed the changelog",
      "    Answered your question · from Docs chat",
      "    Pushed the branch",
      "    Primary: OK · Then waits: CI on main",
      "  Returned · Deploy check (thr_k)",
      "    State: needs-you · No deploy by 28 Oct · checked 3×",
      "    No deploy by 28 Oct · checked 3×",
      `    Primary: Keep waiting until ${localTime(NOW + 7 * DAY)}`,
      "",
      "Waiting · On you",
      `  Thread list overlap (thr_y) · waiting · overlap recurs · reminder ${localTime(NOW + 14 * DAY)}`,
      "",
      "Waiting · Comes back by itself",
      `  SEO checkpoint (thr_c) · waiting · Rankings settle · checked 3× · checks ${localTime(NOW + 2 * HOUR)} · back by ${localTime(NOW + 7 * DAY)}`,
      "",
      "Running",
      "  Build the inbox (thr_run) · working · Working",
    ]);
  });

  it("says All clear when nothing needs you", async () => {
    stubServerApi({
      "v1.inbox.$get": async () =>
        snapshot({
          inbox: [],
          waiting: [],
          running: [],
          shelf: [],
          counts: {
            needsYou: 0,
            inbox: 0,
            questions: 0,
            running: 0,
            waiting: 0,
            onYou: [],
            nextBackAt: null,
          },
        }),
    });

    await runCommand(["inbox"], register);

    expect(logLines()).toEqual(["All clear", "0 running · 0 waiting"]);
  });

  it("names the chats still waiting on a stalled source's result", async () => {
    const stalled = entry({
      state: "needs-you",
      reason: {
        kind: "decision",
        text: "Release and Review are waiting on this chat's result",
        threadId: "thr_s",
      },
      threadId: "thr_s",
      title: "Numbers",
      latch: "latch-s",
      card: card({
        primary: { kind: "reply", waiterTitles: ["Release", "Review"] },
      }),
    });

    stubServerApi({
      "v1.inbox.$get": async () =>
        snapshot({ inbox: [stalled], waiting: [], running: [], shelf: [] }),
    });

    await runCommand(["inbox"], register);

    expect(logLines()).toContain(
      "    Primary: Reply · Release and Review are waiting on this chat's result",
    );
  });

  it("acts with the card's latch and every cause it shows, then offers Undo", async () => {
    const act = vi.fn(async (_request: { json: unknown }) => ({
      moveId: "move-10",
      entry: entry({
        threadId: "thr_r",
        title: "Release notes",
        view: "archive",
      }),
    }));

    stubServerApi({
      "v1.inbox.$get": async () => snapshot(),
      "v1.inbox.act.$post": act,
    });

    await runCommand(["inbox", "act", "thr_r", "archive"], register);

    expect(act).toHaveBeenCalledWith(
      expect.objectContaining({
        json: {
          action: "archive",
          threadId: "thr_r",
          displayedReceiptIds: ["r1", "r2", "r3", "r4"],
          latch: "latch-r",
          stopRunning: false,
        },
      }),
    );
    expect(logLines()).toEqual([
      "archive · Release notes (thr_r)",
      "Now: Archive",
      "Undo: omnyo inbox undo move-10",
    ]);
  });

  it("keep-waiting takes the card's wait and date unless told otherwise", async () => {
    const act = vi.fn(async (_request: { json: unknown }) => ({
      moveId: "move-11",
      entry: null,
    }));

    stubServerApi({
      "v1.inbox.$get": async () => snapshot(),
      "v1.inbox.act.$post": act,
    });

    await runCommand(
      ["inbox", "act", "thr_k", "keep-waiting", "--json"],
      register,
    );

    expect(act).toHaveBeenCalledWith(
      expect.objectContaining({
        json: {
          action: "keep-waiting",
          threadId: "thr_k",
          displayedReceiptIds: ["k1"],
          latch: "latch-k",
          waitId: "wait-k",
          until: NOW + 7 * DAY,
        },
      }),
    );
    expect(JSON.parse(logLines()[0] ?? "")).toEqual({
      moveId: "move-11",
      entry: null,
    });
  });

  it("happened reports the On you row's wait with the owner's note", async () => {
    const act = vi.fn(async (_request: { json: unknown }) => ({
      moveId: null,
      entry: entry({
        threadId: "thr_y",
        view: "running",
        running: { label: "Working", progress: null },
      }),
    }));

    stubServerApi({
      "v1.inbox.$get": async () => snapshot(),
      "v1.inbox.act.$post": act,
    });

    await runCommand(
      ["inbox", "act", "thr_y", "happened", "--note", "Saw it again"],
      register,
    );

    expect(act).toHaveBeenCalledWith(
      expect.objectContaining({
        json: {
          action: "happened",
          threadId: "thr_y",
          waitId: "wait-report",
          note: "Saw it again",
        },
      }),
    );
    expect(logLines()).toEqual([
      "happened · Thread list overlap (thr_y)",
      "Now: Running · Working",
    ]);
  });

  it.each([
    [
      ["thr_r", "ok", "--until", "2h"],
      ["Error: --until does not apply to ok.", "ok takes no options."],
    ],
    [
      ["thr_r", "snooze"],
      [
        "Error: Unknown inbox action 'snooze'.",
        "Actions: ok, archive, wait, wait-report, accept-proposal, keep-waiting, remind-later, happened, shelf, unshelf, snooze-question, cancel-wait, resume, continue-with-result.",
      ],
    ],
    [
      ["thr_r", "wait"],
      [
        "Error: Missing --until.",
        "Pass --until <when>: an ISO 8601 timestamp (2026-08-25T09:00) or a duration from now (30s, 10m, 2h, 7d).",
      ],
    ],
    [
      ["thr_missing", "ok"],
      [
        "Error: thr_missing is not in the Inbox snapshot.",
        "Pass a top-level chat's ID; `omnyo inbox` lists them.",
      ],
    ],
  ])("refuses %j without acting", async (args, expected) => {
    const act = vi.fn();

    stubServerApi({
      "v1.inbox.$get": async () => snapshot(),
      "v1.inbox.act.$post": act,
    });

    await expect(
      runCommand(["inbox", "act", ...args], register),
    ).rejects.toThrow("process.exit:1");

    expect(errorLines()).toEqual(expected);
    expect(act).not.toHaveBeenCalled();
  });

  it("explains a card that changed before the action arrived", async () => {
    stubServerApi({
      "v1.inbox.$get": async () => snapshot(),
      "v1.inbox.act.$post": async () =>
        new Response(
          JSON.stringify({ code: "inbox_updated", message: "Updated" }),
          { status: 409, headers: { "Content-Type": "application/json" } },
        ),
    });

    await expect(
      runCommand(["inbox", "act", "thr_r", "ok"], register),
    ).rejects.toThrow("process.exit:1");

    expect(errorLines()).toEqual([
      "Error: The card changed before the action reached the server.",
      "Run `omnyo inbox` to see the current card, then act again.",
    ]);
  });

  it("undo defaults to the most recent move", async () => {
    const undo = vi.fn(async (_request: { json: unknown }) => ({
      moveId: null,
      entry: entry({
        threadId: "thr_old",
        title: "Old chat",
        card: card({ primary: { kind: "archive" } }),
      }),
    }));

    stubServerApi({
      "v1.inbox.$get": async () => snapshot(),
      "v1.inbox.undo.$post": undo,
    });

    await runCommand(["inbox", "undo"], register);

    expect(undo).toHaveBeenCalledWith(
      expect.objectContaining({ json: { moveId: "move-9" } }),
    );
    expect(logLines()).toEqual([
      "Undid archive on thr_old (move-9).",
      "Now: Old chat (thr_old) · Inbox · Result · Archive",
    ]);
  });

  it("undo says when there is nothing to undo", async () => {
    const undo = vi.fn();

    stubServerApi({
      "v1.inbox.$get": async () => snapshot({ lastMove: null }),
      "v1.inbox.undo.$post": undo,
    });

    await expect(runCommand(["inbox", "undo"], register)).rejects.toThrow(
      "process.exit:1",
    );

    expect(errorLines()[0]).toBe(
      "Error: Nothing to undo: the Inbox has no recent move.",
    );
    expect(undo).not.toHaveBeenCalled();
  });
});
