import { describe, expect, it } from "vitest";
import {
  projectThreadWork,
  threadWorkAssessmentSchema,
  type ThreadWorkEvidence,
} from "../src/thread-work.js";
import {
  buildInboxSnapshot,
  displayedReceiptIds,
  INBOX_WAIT_MARKER_PATTERN,
  inboxSnapshotSchema,
  projectInboxFamily,
  type InboxChatFacts,
  type InboxFamilyFacts,
  type InboxReceiptFacts,
  type InboxWaitFacts,
} from "../src/inbox.js";

function chat(overrides: Partial<InboxChatFacts> = {}): InboxChatFacts {
  return {
    threadId: "root",
    title: "Root",
    isRoot: true,
    running: false,
    working: false,
    runningLabel: null,
    runningProgress: null,
    waitingLabel: null,
    queuedOwnerWork: false,
    checkingWaitId: null,
    requiredQuestions: [],
    optionalQuestions: [],
    failure: null,
    hostEpisode: null,
    coverageGap: null,
    ...overrides,
  };
}

function family(overrides: Partial<InboxFamilyFacts> = {}): InboxFamilyFacts {
  return {
    rootId: "root",
    projectId: "project",
    title: "Root",
    createdAt: 100,
    archivedAt: null,
    shelvedAt: null,
    automationId: null,
    chats: [chat()],
    receipts: [],
    waits: [],
    waiters: [],
    assessment: {
      ask: null,
      recap: null,
      fresh: false,
      availability: "missing",
      reason: "No completion assessment is available.",
      suggestion: false,
      archiveReady: false,
      archiveEligible: true,
    },
    ...overrides,
  };
}

function receipt(
  id: string,
  seq: number,
  overrides: Partial<InboxReceiptFacts> = {},
): InboxReceiptFacts {
  return {
    id,
    seq,
    threadId: "root",
    fromTitle: null,
    cause: "result",
    summary: `Result ${id}`,
    waitId: null,
    createdAt: 1000 + seq,
    ...overrides,
  };
}

function wait(overrides: Partial<InboxWaitFacts> = {}): InboxWaitFacts {
  return {
    id: "wait-1",
    threadId: "root",
    kind: "check",
    status: "live",
    forText: "Google's final data",
    createdBy: "agent",
    ownerAccepted: false,
    deadline: 9000,
    nextCheckAt: 5000,
    checkCount: 2,
    reminderAt: null,
    readiness: "all",
    conditions: [],
    proposalKind: null,
    proposalReceiptId: null,
    questionId: null,
    behindTitle: null,
    ...overrides,
  };
}

const failure = {
  id: "failure-1",
  state: "actionable" as const,
  reason: "Provider exited",
  retryAt: null,
  decisionDeadline: null,
  attempt: null,
  maxAttempts: null,
  canResume: true,
  outwardEffectRan: false,
  queuedCount: 1,
  scheduledCount: 0,
  incident: null,
};

describe("inbox projection", () => {
  it("puts an archived chat in Archive whatever else it holds", () => {
    const view = projectInboxFamily(
      family({ archivedAt: 5, receipts: [receipt("r1", 1)] }),
    ).view;

    expect(view).toBe("archive");
  });

  it("shows a pending required question before a failure or a receipt", () => {
    const projected = projectInboxFamily(
      family({
        chats: [
          chat({
            failure,
            requiredQuestions: [
              {
                id: "q1",
                revision: 1,
                label: "Which build?",
                permission: false,
                snoozedUntil: null,
              },
            ],
          }),
        ],
        receipts: [receipt("r1", 1)],
      }),
    );

    expect(projected.view).toBe("inbox");
    expect(projected.state).toBe("needs-you");
    expect(projected.card?.kind).toBe("question");
    expect(projected.card?.questionMode).toBe("required");
    expect(projected.card?.primary).toEqual({ kind: "answer" });
    expect(projected.card?.actions).toEqual([]);
  });

  it("surfaces optional questions in the Inbox while preserving running activity", () => {
    const projected = projectInboxFamily(
      family({
        chats: [
          chat({
            running: true,
            runningLabel: "Building the app",
            optionalQuestions: [
              {
                id: "optional",
                revision: 1,
                label: "Which direction?",
                permission: false,
                snoozedUntil: null,
              },
            ],
          }),
        ],
      }),
    );

    expect(projected.view).toBe("inbox");
    expect(projected.card).toMatchObject({
      kind: "question",
      questionMode: "optional",
      questionIds: ["optional"],
      primary: { kind: "answer" },
      actions: ["archive", "wait", "reply", "shelf"],
    });
    expect(projected.running).toEqual({
      label: "Building the app",
      progress: null,
    });

    const snapshot = buildInboxSnapshot({
      entries: [projected],
      now: 5000,
      revision: "optional",
      lastMove: null,
    });

    expect(snapshot.inbox).toEqual([projected]);
    expect(snapshot.running).toEqual([]);
    expect(snapshot.counts).toMatchObject({
      inbox: 1,
      questions: 1,
      running: 0,
    });
  });

  it("keeps mixed question cards required and changes the latch when their mode changes", () => {
    const question = {
      id: "same-question",
      revision: 1,
      label: "Which direction?",
      permission: false,
      snoozedUntil: null,
    };

    const optional = projectInboxFamily(
      family({ chats: [chat({ optionalQuestions: [question] })] }),
    );

    const required = projectInboxFamily(
      family({ chats: [chat({ requiredQuestions: [question] })] }),
    );

    const mixed = projectInboxFamily(
      family({
        chats: [
          chat({
            requiredQuestions: [question],
            optionalQuestions: [{ ...question, id: "optional" }],
            failure,
          }),
        ],
      }),
    );

    expect(optional.latch).not.toBe(required.latch);
    expect(mixed.card).toMatchObject({
      kind: "question",
      questionMode: "required",
      questionIds: ["same-question", "optional"],
      actions: [],
    });
  });

  it("keeps actionable failure precedence over an optional question", () => {
    const projected = projectInboxFamily(
      family({
        chats: [
          chat({
            running: true,
            failure,
            optionalQuestions: [
              {
                id: "optional",
                revision: 1,
                label: "Which direction?",
                permission: false,
                snoozedUntil: null,
              },
            ],
          }),
        ],
      }),
    );

    expect(projected.state).toBe("failed");
    expect(projected.reason.text.trim()).not.toBe("");
    expect(projected.card?.kind).toBe("problem");
    expect(projected.card?.questionMode).toBeNull();
    expect(projected.card?.primary).toMatchObject({ kind: "resume" });
  });

  it("keeps a snoozed optional question from replacing running work with Waiting", () => {
    const optional = {
      id: "optional",
      revision: 2,
      label: "Which direction?",
      permission: false,
      snoozedUntil: 8000,
    };

    const running = projectInboxFamily(
      family({
        chats: [
          chat({
            running: true,
            runningLabel: "Building the app",
            optionalQuestions: [optional],
          }),
        ],
      }),
    );

    const idle = projectInboxFamily(
      family({ chats: [chat({ optionalQuestions: [optional] })] }),
    );

    expect(running.view).toBe("running");
    expect(running.running).toEqual({
      label: "Building the app",
      progress: null,
    });
    expect(idle.view).toBe("waiting");
    expect(idle.waiting).toMatchObject({
      questionId: "optional",
      returnAt: 8000,
    });
  });

  it.each(["working", "waiting", "idle"])(
    "keeps child failures with a %s parent",
    (state) => {
      const projected = projectInboxFamily(
        family({
          chats: [
            chat({
              running: state === "working",
              working: state === "working",
            }),
            chat({
              threadId: "side",
              title: "Side chat",
              isRoot: false,
              failure,
            }),
          ],
          waits: state === "waiting" ? [wait()] : [],
          receipts: [
            receipt("child-failure", 1, {
              cause: "problem",
              threadId: "side",
              summary: "Child failed",
            }),
          ],
        }),
      );

      expect(projected.state).toBe(state === "idle" ? "finished" : state);
      expect(projected.card?.kind).not.toBe("problem");
      expect(projected.card?.causes ?? []).toEqual([]);
      expect(projected.reason.threadId).toBe("root");
    },
  );

  it("still surfaces the parent's own failure while a child works", () => {
    const projected = projectInboxFamily(
      family({
        chats: [
          chat({ failure }),
          chat({
            threadId: "child",
            isRoot: false,
            working: true,
            running: true,
          }),
        ],
      }),
    );

    expect(projected.state).toBe("failed");
    expect(projected.card?.primary).toMatchObject({
      kind: "resume",
      targetThreadId: "root",
    });
  });

  it("shows a held provider retry in Waiting, not as a Problem", () => {
    const projected = projectInboxFamily(
      family({
        chats: [
          chat({
            failure: {
              ...failure,
              state: "held",
              retryAt: 7000,
              attempt: 1,
              maxAttempts: 4,
            },
          }),
        ],
      }),
    );

    expect(projected.view).toBe("waiting");
    expect(projected.state).toBe("waiting");
    expect(projected.waiting?.retry).toEqual({
      at: 7000,
      attempt: 1,
      maxAttempts: 4,
    });
  });

  it("keeps a negative-check turn in Waiting as Checking", () => {
    const projected = projectInboxFamily(
      family({
        chats: [chat({ running: true, checkingWaitId: "wait-1" })],
        waits: [wait({ status: "evaluating" })],
      }),
    );

    expect(projected.view).toBe("waiting");
    expect(projected.waiting?.checking).toBe(true);
  });

  it("shows Running while a descendant runs even when the root checks", () => {
    const projected = projectInboxFamily(
      family({
        chats: [
          chat({ running: true, checkingWaitId: "wait-1" }),
          chat({ threadId: "side", isRoot: false, running: true }),
        ],
        waits: [wait({ status: "evaluating" })],
      }),
    );

    expect(projected.view).toBe("running");
  });

  it("keeps working chats in Running until the work stops, then shows their results", () => {
    const results = [
      receipt("r1", 1, { cause: "problem" }),
      receipt("r2", 2),
      receipt("r3", 3, { cause: "question" }),
    ];

    const rootRuns = projectInboxFamily(
      family({
        chats: [
          chat({
            running: true,
            working: true,
            runningLabel: "Building the app",
            runningProgress: { done: 2, total: 5 },
          }),
        ],
        receipts: results,
      }),
    );

    const childRuns = projectInboxFamily(
      family({
        chats: [
          chat(),
          chat({
            threadId: "side",
            isRoot: false,
            running: true,
            working: true,
          }),
        ],
        receipts: results,
      }),
    );

    const stopped = projectInboxFamily(family({ receipts: results }));

    expect(rootRuns).toMatchObject({
      view: "running",
      card: null,
      running: { label: "Building the app", progress: { done: 2, total: 5 } },
    });
    expect(childRuns).toMatchObject({ view: "running", card: null });
    expect(stopped.view).toBe("inbox");
    expect(stopped.card?.causes.map((cause) => cause.receiptId)).toEqual([
      "r1",
      "r2",
      "r3",
    ]);

    const snapshot = buildInboxSnapshot({
      entries: [rootRuns],
      now: 5000,
      revision: "running",
      lastMove: null,
    });

    expect(snapshot.inbox).toEqual([]);
    expect(snapshot.running).toEqual([rootRuns]);
  });

  it("keeps automatic progress in Waiting through the chat's own silent check", () => {
    const projected = projectInboxFamily(
      family({
        chats: [
          chat({ running: true, working: true, checkingWaitId: "wait-1" }),
        ],
        receipts: [receipt("r1", 1)],
        waits: [wait({ status: "evaluating" })],
      }),
    );

    expect(projected.view).toBe("waiting");
    expect(projected.card).toBeNull();
    expect(projected.waiting?.checking).toBe(true);
  });

  it("still surfaces decisions while work runs, and a goal's own results between iterations", () => {
    const decision = projectInboxFamily(
      family({
        chats: [chat({ running: true, working: true })],
        receipts: [
          receipt("r1", 1),
          receipt("r2", 2, { cause: "post-failed" }),
        ],
      }),
    );

    const goal = projectInboxFamily(
      family({
        chats: [chat({ running: true, runningLabel: "Goal" })],
        receipts: [receipt("r1", 1)],
      }),
    );

    expect(decision.view).toBe("inbox");
    expect(decision.card?.primary.kind).toBe("ok");
    expect(goal.view).toBe("inbox");
    expect(goal.card?.causes.map((cause) => cause.receiptId)).toEqual(["r1"]);
  });

  it.each(["chat", "check", "event", "date", "join"] as const)(
    "keeps routine progress in Waiting while an automatic %s wait continues",
    (kind) => {
      const facts = family({
        receipts: [receipt("r1", 1), receipt("r2", 2)],
        waits: [wait({ kind })],
      });

      const before = structuredClone(facts);
      const projected = projectInboxFamily(facts);

      expect(projected).toMatchObject({
        view: "waiting",
        card: null,
        waiting: { group: "comes-back", waitId: "wait-1" },
      });
      expect(facts).toEqual(before);
    },
  );

  it.each([
    "problem",
    "question",
    "post-failed",
    "deadline",
    "partial",
  ] as const)(
    "keeps a %s receipt actionable alongside automatic work",
    (cause) => {
      const projected = projectInboxFamily(
        family({
          receipts: [receipt("r1", 1, { cause, waitId: "wait-1" })],
          waits: [wait({ kind: "event" })],
        }),
      );

      expect(projected.view).toBe("inbox");
      expect(projected.card?.causes[0]?.cause).toBe(cause);
    },
  );

  it("keeps an owner report wait actionable after a result", () => {
    const projected = projectInboxFamily(
      family({
        receipts: [receipt("r1", 1)],
        waits: [wait({ kind: "report" })],
      }),
    );

    expect(projected.view).toBe("inbox");
    expect(projected.card?.primary).toEqual({
      kind: "ok",
      thenWaits: "Google's final data",
    });
  });

  it("leads with a pending agent proposal phrased as its effect", () => {
    const projected = projectInboxFamily(
      family({
        receipts: [receipt("r1", 1, { cause: "proposal" })],
        waits: [
          wait({
            id: "wait-2",
            kind: "report",
            status: "proposed",
            forText: "the overlap happens again",
            proposalKind: "report",
          }),
        ],
      }),
    );

    expect(projected.card?.primary).toMatchObject({
      kind: "accept-proposal",
      label: "On you: the overlap happens again?",
    });
  });

  it("asks the owner to reply when an owner-facing stall is open", () => {
    const projected = projectInboxFamily(
      family({
        receipts: [
          receipt("r1", 1, {
            cause: "stall",
            summary: "You stopped this chat · Waiter is waiting on its result",
          }),
        ],
        waiters: [{ threadId: "w1", title: "Waiter", createdBy: "agent" }],
      }),
    );

    expect(projected).toMatchObject({
      state: "needs-you",
      reason: {
        kind: "decision",
        text: "You stopped this chat · Waiter is waiting on its result",
      },
    });
    expect(projected.card?.primary).toEqual({
      kind: "reply",
      waiterTitles: ["Waiter"],
    });
  });

  it("asks the owner to reply only for callbacks the owner created", () => {
    const results = [receipt("r1", 1)];

    const owned = projectInboxFamily(
      family({
        receipts: results,
        waiters: [
          { threadId: "w1", title: "Mine", createdBy: "owner" },
          { threadId: "w1", title: "Mine", createdBy: "owner" },
          { threadId: "w2", title: "Agent", createdBy: "agent" },
        ],
      }),
    );

    expect(owned.card?.primary).toEqual({
      kind: "reply",
      waiterTitles: ["Mine"],
    });

    const agentOnly = projectInboxFamily(
      family({
        receipts: results,
        waiters: [{ threadId: "w2", title: "Agent", createdBy: "agent" }],
        assessment: {
          ask: null,
          recap: "Delivered the numbers",
          fresh: true,
          availability: "available",
          reason: "Done",
          suggestion: false,
          archiveReady: true,
          archiveEligible: true,
        },
      }),
    );

    expect(agentOnly).toMatchObject({
      state: "waiting",
      reason: { kind: "deliver", text: "Agent is waiting on this chat" },
      archiveReady: false,
    });
    expect(agentOnly.card?.primary).toEqual({ kind: "your-call" });
  });

  it("keeps an event-source stall a decision", () => {
    const projected = projectInboxFamily(
      family({
        receipts: [
          receipt("r1", 1, {
            cause: "stall",
            waitId: "event-wait",
            summary: 'Can\'t check "tracker:1": offline',
          }),
        ],
      }),
    );

    expect(projected).toMatchObject({
      state: "needs-you",
      reason: { kind: "decision", text: 'Can\'t check "tracker:1": offline' },
    });
    expect(projected.card?.primary).toEqual({ kind: "your-call" });
  });

  it("keeps a recovered agent event deadline stored while its owner works", () => {
    const deadline = receipt("deadline", 1, {
      cause: "deadline",
      waitId: "expired-event",
      agentEventDeadline: true,
    });

    const facts = family({
      receipts: [deadline, receipt("result", 2)],
      chats: [
        chat({ running: true, working: true, runningLabel: "Compiling" }),
      ],
    });

    const resumed = projectInboxFamily(facts);
    expect(resumed).toMatchObject({
      state: "working",
      view: "running",
      reason: { kind: "activity", text: "Compiling" },
      card: null,
      pendingResults: 1,
    });
    expect(facts.receipts).toEqual([deadline, receipt("result", 2)]);

    const stopped = projectInboxFamily({ ...facts, chats: [chat()] });
    expect(stopped).toMatchObject({ state: "needs-you", view: "inbox" });
    expect(stopped.card?.primary.kind).toBe("keep-waiting");
    expect(stopped.card?.causes.map((cause) => cause.receiptId)).toContain(
      "deadline",
    );
  });

  it.each(["another-chat", "checking-turn"])(
    "keeps an automatic deadline actionable during %s work",
    (scenario) => {
      const projected = projectInboxFamily(
        family({
          receipts: [
            receipt("deadline", 1, {
              cause: "deadline",
              waitId: "expired-event",
              agentEventDeadline: true,
            }),
          ],
          chats:
            scenario === "another-chat"
              ? [
                  chat(),
                  chat({
                    threadId: "child",
                    isRoot: false,
                    running: true,
                    working: true,
                  }),
                ]
              : [
                  chat({
                    running: true,
                    working: true,
                    checkingWaitId: "check",
                  }),
                ],
        }),
      );

      expect(projected.state).toBe("needs-you");
      expect(projected.card?.primary.kind).toBe("keep-waiting");
    },
  );

  it("keeps a deadline actionable when only a producer is running", () => {
    const projected = projectInboxFamily(
      family({
        chats: [chat({ running: true, working: false })],
        receipts: [
          receipt("deadline", 1, {
            cause: "deadline",
            waitId: "expired-event",
            agentEventDeadline: true,
          }),
        ],
      }),
    );

    expect(projected).toMatchObject({ state: "needs-you", view: "inbox" });
    expect(projected.card?.primary.kind).toBe("keep-waiting");
  });

  it("keeps other decisions actionable alongside a resumed agent deadline", () => {
    const projected = projectInboxFamily(
      family({
        chats: [chat({ working: true, running: true })],
        receipts: [
          receipt("owner-deadline", 1, {
            cause: "deadline",
            waitId: "owner-wait",
            summary: "Owner deadline",
          }),
          receipt("agent-deadline", 2, {
            cause: "deadline",
            waitId: "agent-wait",
            agentEventDeadline: true,
          }),
        ],
      }),
    );

    expect(projected).toMatchObject({
      state: "needs-you",
      reason: { text: "Owner deadline" },
    });
    expect(projected.card?.primary).toMatchObject({
      kind: "keep-waiting",
      waitId: "owner-wait",
    });
  });

  it("returns a deadline with Keep waiting and a reminder with Remind me", () => {
    const deadline = projectInboxFamily(
      family({
        receipts: [receipt("r1", 1, { cause: "deadline", waitId: "w" })],
      }),
    );

    expect(deadline.card?.kind).toBe("returned");
    expect(deadline.card?.primary.kind).toBe("keep-waiting");

    const reminder = projectInboxFamily(
      family({
        receipts: [receipt("r1", 1, { cause: "reminder", waitId: "w" })],
        waits: [wait({ id: "w", kind: "report", reminderAt: null })],
      }),
    );

    expect(reminder.card?.primary).toEqual({
      kind: "remind-later",
      waitId: "w",
    });
    expect(reminder.card?.stillOnYou).toBe("Google's final data");
  });

  it("puts a report-it wait in the On you group", () => {
    const projected = projectInboxFamily(
      family({ waits: [wait({ kind: "report", reminderAt: 4000 })] }),
    );

    expect(projected.view).toBe("waiting");
    expect(projected.waiting?.group).toBe("on-you");
    expect(projected.waiting?.returnAt).toBe(4000);
  });

  it("waits on your scheduled message instead of asking for your call", () => {
    const projected = projectInboxFamily(
      family({
        waits: [
          wait({
            kind: "send-later",
            createdBy: "owner",
            ownerAccepted: true,
            forText: "Your message sends",
            deadline: 7000,
            nextCheckAt: null,
            checkCount: 0,
          }),
        ],
      }),
    );

    expect(projected.view).toBe("waiting");
    expect(projected.waiting).toMatchObject({
      group: "comes-back",
      reason: "Your message sends",
      returnAt: 7000,
      guaranteed: true,
    });

    const alongside = projectInboxFamily(
      family({
        waits: [
          wait({
            id: "send",
            kind: "send-later",
            createdBy: "owner",
            forText: "Your message sends",
            deadline: 3000,
          }),
          wait({
            id: "deploy",
            forText: "the deploy finishes",
            deadline: 9000,
          }),
        ],
      }),
    );

    expect(alongside.waiting).toMatchObject({
      reason: "the deploy finishes",
      waitId: "deploy",
      returnAt: 3000,
    });
  });

  it("rests an idle Shelf chat and gives an idle unshelved chat Your call", () => {
    expect(projectInboxFamily(family({ shelvedAt: 5 })).view).toBe("resting");
    const idle = projectInboxFamily(family());
    expect(idle.view).toBe("inbox");
    expect(idle.card?.primary).toEqual({ kind: "your-call" });
  });

  it("shows OK on a Shelf chat's result so the chat stays in the Shelf", () => {
    const projected = projectInboxFamily(
      family({ shelvedAt: 5, receipts: [receipt("r1", 1)] }),
    );

    expect(projected.card?.primary).toEqual({ kind: "ok", thenWaits: null });
  });

  it("picks Archive only for a fresh archive-ready assessment", () => {
    const ready = {
      ask: null,
      recap: null,
      fresh: true,
      availability: "available" as const,
      reason: "Done",
      suggestion: false,
      archiveReady: true,
      archiveEligible: true,
    };

    expect(
      projectInboxFamily(
        family({ receipts: [receipt("r1", 1)], assessment: ready }),
      ).card?.primary,
    ).toEqual({ kind: "archive" });
    expect(
      projectInboxFamily(
        family({
          receipts: [receipt("r1", 1)],
          assessment: { ...ready, fresh: false },
        }),
      ).card?.primary,
    ).toEqual({ kind: "your-call" });
  });

  it("shows a snoozed question in Waiting even while other work runs", () => {
    const projected = projectInboxFamily(
      family({
        chats: [
          chat({
            running: true,
            requiredQuestions: [
              {
                id: "q1",
                revision: 2,
                label: "Pick one",
                permission: false,
                snoozedUntil: 8000,
              },
            ],
          }),
        ],
      }),
    );

    expect(projected.view).toBe("waiting");
    expect(projected.waiting?.questionId).toBe("q1");
    expect(projected.waiting?.returnAt).toBe(8000);
  });

  it("orders questions first, then oldest first, and pins On you waits", () => {
    const question = projectInboxFamily(
      family({
        rootId: "c",
        createdAt: 900,
        chats: [
          chat({
            threadId: "c",
            requiredQuestions: [
              {
                id: "q",
                revision: 1,
                label: "Q",
                permission: true,
                snoozedUntil: null,
              },
            ],
          }),
        ],
      }),
    );

    const older = projectInboxFamily(
      family({ rootId: "a", receipts: [receipt("ra", 1)] }),
    );

    const newer = projectInboxFamily(
      family({ rootId: "b", receipts: [receipt("rb", 50)] }),
    );

    const onYou = projectInboxFamily(
      family({
        rootId: "d",
        waits: [wait({ kind: "report", reminderAt: 99999 })],
      }),
    );

    const back = projectInboxFamily(family({ rootId: "e", waits: [wait()] }));

    const snapshot = buildInboxSnapshot({
      entries: [newer, back, onYou, older, question],
      now: 1,
      revision: "r",
      lastMove: null,
    });

    expect(snapshot.inbox.map((item) => item.threadId)).toEqual([
      "c",
      "a",
      "b",
    ]);
    expect(snapshot.waiting.map((item) => item.threadId)).toEqual(["d", "e"]);
    expect(snapshot.counts).toMatchObject({
      inbox: 3,
      questions: 1,
      waiting: 2,
      nextBackAt: 9000,
    });
    expect(() => inboxSnapshotSchema.parse(snapshot)).not.toThrow();
  });

  it("hides causes beyond three on an unfocused card only", () => {
    const projected = projectInboxFamily(
      family({
        receipts: [1, 2, 3, 4, 5].map((seq) => receipt(`r${seq}`, seq)),
      }),
    );

    const card = projected.card;

    if (card === null) throw new Error("expected a card");
    expect(displayedReceiptIds(card, false)).toEqual(["r1", "r2", "r3"]);
    expect(displayedReceiptIds(card, true)).toHaveLength(5);
  });

  it("changes the latch when the displayed receipts change", () => {
    const one = projectInboxFamily(family({ receipts: [receipt("r1", 1)] }));

    const two = projectInboxFamily(
      family({ receipts: [receipt("r1", 1), receipt("r2", 2)] }),
    );

    expect(one.latch).not.toBe(two.latch);
  });
});

describe("INBOX_WAIT_MARKER_PATTERN", () => {
  const id = "11111111-2222-3333-4444-555555555555";

  it("finds current, legacy bb and legacy callback wait markers in a reply", () => {
    for (const marker of [
      `[omnyo wait ${id}]`,
      `[bb wait ${id}]`,
      `[callback-wait:${id}]`,
    ])
      expect(
        INBOX_WAIT_MARKER_PATTERN.exec(`done ${marker} 12 tables`)?.[0],
      ).toBe(marker);
  });

  it("ignores owner and proposal markers and other products", () => {
    expect(INBOX_WAIT_MARKER_PATTERN.test(`[omnyo wait owner thr_1 1]`)).toBe(
      false,
    );
    expect(INBOX_WAIT_MARKER_PATTERN.test(`[omnyo proposal thr_1 1]`)).toBe(
      false,
    );
    expect(INBOX_WAIT_MARKER_PATTERN.test(`[other wait ${id}]`)).toBe(false);
  });
});

describe("server-owned family state", () => {
  const question = {
    id: "q",
    revision: 1,
    label: "Pick the build",
    permission: false,
    snoozedUntil: null,
  };

  const available = {
    ...family().assessment,
    fresh: true,
    availability: "available" as const,
    reason: "Build delivered",
    ask: null,
    recap: null,
  };

  const results = [receipt("r", 1, { summary: "Turn finished" })];

  const cases: {
    name: string;
    facts: InboxFamilyFacts;
    state: string;
    kind: string;
    text: string;
  }[] = [
    {
      name: "1 archived overrides blockers",
      facts: family({ archivedAt: 1, chats: [chat({ failure })] }),
      state: "archive",
      kind: "none",
      text: "",
    },
    {
      name: "2 required child question overrides running",
      facts: family({
        chats: [
          chat({ working: true }),
          chat({
            threadId: "child",
            title: "Child",
            isRoot: false,
            requiredQuestions: [question],
          }),
        ],
      }),
      state: "needs-you",
      kind: "question",
      text: "Child: Pick the build",
    },
    {
      name: "3 actionable failure",
      facts: family({ chats: [chat({ failure, working: true })] }),
      state: "failed",
      kind: "failure",
      text: "Failed: Provider exited",
    },
    {
      name: "4 coverage gap",
      facts: family({
        chats: [chat({ coverageGap: "Owner unknown", working: true })],
      }),
      state: "needs-you",
      kind: "unverified",
      text: "Owner unknown",
    },
    {
      name: "5 decision receipt while running",
      facts: family({
        chats: [chat({ working: true })],
        receipts: [
          receipt("d", 2, { cause: "deadline", summary: "Deadline reached" }),
        ],
      }),
      state: "needs-you",
      kind: "decision",
      text: "Deadline reached",
    },
    {
      name: "5 proposed wait label",
      facts: family({
        receipts: [receipt("p", 1, { cause: "proposal" })],
        waits: [wait({ status: "proposed", proposalKind: "shelve" })],
      }),
      state: "needs-you",
      kind: "decision",
      text: "Shelve?",
    },
    {
      name: "6 snoozed required question while another chat works",
      facts: family({
        chats: [
          chat({ requiredQuestions: [{ ...question, snoozedUntil: 9000 }] }),
          chat({
            threadId: "child",
            isRoot: false,
            working: true,
            running: true,
          }),
        ],
      }),
      state: "waiting",
      kind: "wait",
      text: "Pick the build",
    },
    {
      name: "7 working with optional question",
      facts: family({
        chats: [
          chat({
            working: true,
            running: true,
            runningLabel: "Building",
            optionalQuestions: [question],
          }),
        ],
      }),
      state: "working",
      kind: "activity",
      text: "Building",
    },
    {
      name: "8 idle optional question preserves the idle lifecycle",
      facts: family({ chats: [chat({ optionalQuestions: [question] })] }),
      state: "finished",
      kind: "unassessed",
      text: "Finished, not assessed",
    },
    {
      name: "8 checking with optional question",
      facts: family({
        chats: [
          chat({
            working: true,
            running: true,
            checkingWaitId: "wait-1",
            optionalQuestions: [question],
          }),
        ],
        waits: [wait({ status: "evaluating" })],
      }),
      state: "waiting",
      kind: "wait",
      text: "Google's final data",
    },
    {
      name: "9 assessed ask puts the result in Needs you",
      facts: family({
        receipts: results,
        assessment: { ...available, ask: "Choose a build" },
      }),
      state: "needs-you",
      kind: "ask",
      text: "Choose a build",
    },
    {
      name: "10 deliver results to waiters",
      facts: family({
        receipts: results,
        waiters: [{ threadId: "w", title: "Parent", createdBy: "agent" }],
      }),
      state: "waiting",
      kind: "deliver",
      text: "Parent is waiting on this chat",
    },
    {
      name: "11 waiters with live wait",
      facts: family({
        receipts: results,
        waits: [wait()],
        waiters: [{ threadId: "w", title: "Parent", createdBy: "agent" }],
      }),
      state: "waiting",
      kind: "wait",
      text: "Google's final data",
    },
    {
      name: "11 running goal keeps result card",
      facts: family({
        receipts: results,
        chats: [chat({ running: true, runningLabel: "Goal" })],
      }),
      state: "working",
      kind: "activity",
      text: "Goal",
    },
    {
      name: "12 idle results without ask",
      facts: family({ receipts: results, assessment: available }),
      state: "finished",
      kind: "recap",
      text: "Build delivered",
    },
    {
      name: "12 assessment recap",
      facts: family({
        receipts: results,
        assessment: { ...available, recap: "Delivered the build." },
      }),
      state: "finished",
      kind: "recap",
      text: "Delivered the build.",
    },
    {
      name: "12 shelved results ignore ask",
      facts: family({
        shelvedAt: 1,
        receipts: results,
        assessment: { ...available, ask: "Choose a build", archiveReady: true },
      }),
      state: "finished",
      kind: "recap",
      text: "Build delivered",
    },
    {
      name: "12 held failure does not delay results",
      facts: family({
        receipts: results,
        chats: [chat({ failure: { ...failure, state: "held" } })],
      }),
      state: "finished",
      kind: "unassessed",
      text: "Finished, not assessed",
    },
    {
      name: "12 scheduled send does not delay results",
      facts: family({
        receipts: results,
        waits: [wait({ kind: "send-later" })],
      }),
      state: "finished",
      kind: "unassessed",
      text: "Finished, not assessed",
    },
    {
      name: "13 checking without results",
      facts: family({
        chats: [
          chat({ running: true, working: true, checkingWaitId: "wait-1" }),
        ],
        waits: [wait({ status: "evaluating" })],
      }),
      state: "waiting",
      kind: "wait",
      text: "Google's final data",
    },
    {
      name: "13 snoozed optional",
      facts: family({
        chats: [
          chat({ optionalQuestions: [{ ...question, snoozedUntil: 9000 }] }),
        ],
      }),
      state: "waiting",
      kind: "wait",
      text: "Pick the build",
    },
    {
      name: "13 running producer without receipts",
      facts: family({ chats: [chat({ running: true })] }),
      state: "working",
      kind: "activity",
      text: "Working",
    },
    {
      name: "13 idle live wait",
      facts: family({ waits: [wait()] }),
      state: "waiting",
      kind: "wait",
      text: "Google's final data",
    },
    {
      name: "14 shelved with waiters but no receipts",
      facts: family({
        shelvedAt: 1,
        waiters: [{ threadId: "w", title: "Parent", createdBy: "agent" }],
      }),
      state: "resting",
      kind: "none",
      text: "",
    },
    {
      name: "14 idle source still owes its waiters without receipts",
      facts: family({
        waiters: [
          {
            threadId: "a",
            title: "COORDINATOR PARASPEECH",
            createdBy: "agent",
          },
          {
            threadId: "a",
            title: "COORDINATOR PARASPEECH",
            createdBy: "agent",
          },
          { threadId: "b", title: "Review", createdBy: "owner" },
          { threadId: "c", title: "Release", createdBy: "agent" },
        ],
      }),
      state: "waiting",
      kind: "deliver",
      text: "COORDINATOR PARASPEECH, Review and Release are waiting on this chat",
    },
    {
      name: "15 idle without assessment",
      facts: family(),
      state: "finished",
      kind: "unassessed",
      text: "Finished, not assessed",
    },
    {
      name: "8 optional child question preserves the idle lifecycle",
      facts: family({
        chats: [
          chat(),
          chat({
            threadId: "child",
            title: "Child",
            isRoot: false,
            optionalQuestions: [question],
          }),
        ],
      }),
      state: "finished",
      kind: "unassessed",
      text: "Finished, not assessed",
    },
    {
      name: "12 stale ask cannot request an answer",
      facts: family({
        receipts: results,
        assessment: {
          ...available,
          fresh: false,
          ask: "Pick a build",
          recap: "Old result",
        },
      }),
      state: "finished",
      kind: "unassessed",
      text: "Finished, not assessed: the chat changed since its assessment",
    },
    {
      name: "9 assessed ask needs the owner without receipts",
      facts: family({ assessment: { ...available, ask: "Choose a build" } }),
      state: "needs-you",
      kind: "ask",
      text: "Choose a build",
    },
    {
      name: "9 assessed ask outranks a predicted outside wait",
      facts: family({
        receipts: results,
        chats: [
          chat({ waitingLabel: "Waiting on Push permission for the fix" }),
        ],
        assessment: { ...available, ask: "Run the push yourself." },
      }),
      state: "needs-you",
      kind: "ask",
      text: "Run the push yourself.",
    },
    {
      name: "9 assessed ask outranks a delivery owed to waiters",
      facts: family({
        receipts: results,
        waiters: [{ threadId: "w", title: "Parent", createdBy: "agent" }],
        assessment: { ...available, ask: "Choose a build" },
      }),
      state: "needs-you",
      kind: "ask",
      text: "Choose a build",
    },
    {
      name: "9 an agent wait with a return route outranks an ask",
      facts: family({
        receipts: results,
        waits: [wait()],
        assessment: { ...available, ask: "Choose a build" },
      }),
      state: "waiting",
      kind: "wait",
      text: "Google's final data",
    },
    {
      name: "9 running work outranks an ask",
      facts: family({
        chats: [chat({ running: true, runningLabel: "Building" })],
        assessment: { ...available, ask: "Choose a build" },
      }),
      state: "working",
      kind: "activity",
      text: "Building",
    },
    {
      name: "9 a held automatic retry outranks an ask",
      facts: family({
        chats: [chat({ failure: { ...failure, state: "held" } })],
        assessment: { ...available, ask: "Choose a build" },
      }),
      state: "waiting",
      kind: "wait",
      text: "Retrying: Provider exited",
    },
  ];

  it.each(cases)("$name", ({ facts, state, kind, text }) => {
    const projected = projectInboxFamily(facts);
    expect(projected).toMatchObject({ state, reason: { kind, text } });
    expect(projected.pendingResults).toBe(
      facts.receipts.filter((r) => r.cause === "result").length,
    );
    expect(projected.archiveReady).toBe(false);
  });

  it("keeps optional questions answerable without changing the underlying lifecycle", () => {
    for (const facts of [cases[8]!.facts, cases[9]!.facts]) {
      const withOptional = projectInboxFamily(facts);

      const withoutOptional = projectInboxFamily({
        ...facts,
        chats: facts.chats.map((member) => ({
          ...member,
          optionalQuestions: [],
        })),
      });

      expect(withOptional.state).toBe(withoutOptional.state);
      expect(withOptional.optionalQuestion).toEqual({
        id: "q",
        label: "Pick the build",
        threadId: "root",
      });
      expect(withOptional.card).toMatchObject({
        primary: { kind: "answer" },
        questionMode: "optional",
        questionIds: ["q"],
      });
    }
  });

  it("keeps an advisory suggestion available without inventing an owner decision", () => {
    const projected = projectInboxFamily(
      family({
        receipts: results,
        assessment: { ...available, suggestion: true },
      }),
    );

    expect(projected).toMatchObject({
      state: "finished",
      reason: { kind: "recap", text: "Build delivered" },
      card: { primary: { kind: "reply", waiterTitles: [] } },
    });
  });

  it("shows an owner ask as an Inbox card that keeps the suggested reply", () => {
    const projected = projectInboxFamily(
      family({
        receipts: results,
        assessment: { ...available, ask: "Choose a build", suggestion: true },
      }),
    );

    expect(projected).toMatchObject({
      state: "needs-you",
      reason: { kind: "ask", text: "Choose a build" },
      view: "inbox",
      card: { kind: "result", primary: { kind: "reply", waiterTitles: [] } },
    });
  });

  it("puts an owner ask in an Inbox card instead of the Waiting list", () => {
    for (const facts of [
      family({
        chats: [chat({ waitingLabel: "Waiting on Push permission" })],
        assessment: { ...available, ask: "Run the push yourself." },
      }),
      family({
        receipts: results,
        chats: [chat({ waitingLabel: "Waiting on Push permission" })],
        assessment: { ...available, ask: "Run the push yourself." },
      }),
      family({
        waits: [wait({ kind: "send-later" })],
        assessment: { ...available, ask: "Run the push yourself." },
      }),
      family({
        assessment: {
          ...available,
          ask: "Run the push yourself.",
          archiveReady: true,
        },
      }),
    ]) {
      const projected = projectInboxFamily(facts);

      expect(projected.state).toBe("needs-you");
      expect(projected.view).toBe("inbox");
      expect(projected.waiting).toBeNull();
      expect(projected.card).not.toBeNull();
      expect(projected.card?.primary.kind).not.toBe("archive");
      expect(projected.archiveReady).toBe(false);

      const snapshot = buildInboxSnapshot({
        entries: [projected],
        now: 10,
        revision: "r",
        lastMove: null,
      });

      expect(snapshot.counts.needsYou).toBe(1);
      expect(snapshot.waiting).toHaveLength(0);
    }
  });

  it("keeps a shelved chat with an ask resting", () => {
    const projected = projectInboxFamily(
      family({
        shelvedAt: 1,
        assessment: { ...available, ask: "Choose a build" },
      }),
    );

    expect(projected).toMatchObject({ state: "resting", view: "resting" });
  });

  it("keeps the question badge and result actions on working rows", () => {
    const optional = projectInboxFamily(cases[7]!.facts);
    expect(optional.optionalQuestion).toEqual({
      id: "q",
      label: "Pick the build",
      threadId: "root",
    });
    expect(optional.card?.primary).toEqual({ kind: "answer" });
    const goal = projectInboxFamily(cases[13]!.facts);
    expect(goal.card?.primary).toEqual({ kind: "ok", thenWaits: "Goal" });
    expect(goal.card?.causes).toHaveLength(1);
  });

  it("takes the strongest run member state without changing its group primary", () => {
    const done = projectInboxFamily(
      family({
        rootId: "done",
        automationId: "a",
        receipts: [receipt("r3", 3)],
        assessment: available,
      }),
    );

    const decision = projectInboxFamily(
      family({
        rootId: "decision",
        automationId: "a",
        receipts: [
          receipt("d", 2, {
            threadId: "decision",
            cause: "deadline",
            summary: "Deadline reached",
          }),
        ],
      }),
    );

    const snapshot = buildInboxSnapshot({
      entries: [decision, done],
      now: 10,
      revision: "r",
      lastMove: null,
    });

    expect(snapshot.inbox[0]).toMatchObject({
      state: "needs-you",
      reason: { text: "Deadline reached", threadId: "decision" },
      card: { primary: { kind: "archive-runs", mode: "older" } },
    });
    expect(snapshot.counts.needsYou).toBe(1);
  });
});

describe("assessment state compatibility", () => {
  const stored = {
    basis: "current",
    contractVersion: 1,
    availability: "available",
    reason: "Delivered",
    sourceSeq: 1,
    text: null,
    noSuggestionReason: null,
    archiveReady: true,
  };

  it("defaults old stored assessments and forwards new ask and recap only while fresh", () => {
    expect(threadWorkAssessmentSchema.parse(stored)).toMatchObject({
      ask: null,
      recap: null,
    });

    const assessment = threadWorkAssessmentSchema.parse({
      ...stored,
      ask: "Pick a build",
      recap: "The build passed.",
    });

    const evidence: ThreadWorkEvidence = {
      revision: "current",
      basis: "current",
      activity: [],
      requiredInput: [],
      optionalInput: [],
      failures: [],
      waits: [],
      coverageComplete: true,
      unknownReason: null,
      assessment,
      postponement: null,
      closed: false,
    };

    expect(projectThreadWork(evidence).assessment).toMatchObject({
      ask: "Pick a build",
      recap: "The build passed.",
    });
    expect(
      projectThreadWork({ ...evidence, basis: "changed" }).assessment,
    ).toMatchObject({ ask: null, recap: null });
    expect(
      threadWorkAssessmentSchema.safeParse({ ...stored, ask: "x".repeat(201) })
        .success,
    ).toBe(false);
    expect(
      threadWorkAssessmentSchema.safeParse({
        ...stored,
        recap: "x".repeat(401),
      }).success,
    ).toBe(false);
  });
  it.each(["needs-you", "working", "ready-to-archive"] as const)(
    "keeps the single-chat %s work indicator compatible",
    (label) => {
      const required = {
        id: "q",
        label: "Pick one",
        threadId: "root",
        kind: "question" as const,
      };

      const activity: ThreadWorkEvidence["activity"][number] = {
        id: "a",
        kind: "plugin",
        label: "Building",
        phase: "running",
        actor: { kind: "agent", id: "a", label: "Agent" },
      };

      const evidence: ThreadWorkEvidence = {
        revision: "current",
        basis: "current",
        activity: label === "working" ? [activity] : [],
        requiredInput: label === "needs-you" ? [required] : [],
        optionalInput: [],
        failures: [],
        waits: [],
        coverageComplete: true,
        unknownReason: null,
        assessment: threadWorkAssessmentSchema.parse(stored),
        postponement: null,
        closed: false,
      };

      expect(projectThreadWork(evidence).primary.label).toBe(label);

      const facts = family({
        chats: [
          chat({
            working: label === "working",
            requiredQuestions:
              label === "needs-you"
                ? [
                    {
                      id: "q",
                      revision: 1,
                      label: "Pick one",
                      permission: false,
                      snoozedUntil: null,
                    },
                  ]
                : [],
          }),
        ],
        assessment: {
          ...family().assessment,
          fresh: true,
          availability: "available",
          reason: "Delivered",
          archiveReady: true,
        },
      });

      const entry = projectInboxFamily(facts);
      expect(entry.state).toBe(
        label === "ready-to-archive" ? "finished" : label,
      );
      expect(entry.archiveReady).toBe(label === "ready-to-archive");
    },
  );
});

it("keeps an automatic-wait family waiting with every unhandled result counted", () => {
  const projected = projectInboxFamily(
    family({ receipts: [receipt("r1", 1), receipt("r2", 2)], waits: [wait()] }),
  );

  expect(projected).toMatchObject({
    view: "waiting",
    state: "waiting",
    card: null,
    pendingResults: 2,
    reason: { kind: "wait", text: "Google's final data" },
  });
});
