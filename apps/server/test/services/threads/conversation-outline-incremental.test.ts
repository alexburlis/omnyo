import { describe, expect, it } from "vitest";
import {
  THREAD_CONTEXT_CLEAR_OPERATION,
  parseStoredThreadEvent,
  threadScope,
  turnScope,
  type CompletedTurnDisplay,
} from "@omnyo/domain";
import {
  deleteThreadEventSuffixInTransaction,
  createThread,
  noopNotifier,
  getLatestThreadSequence,
} from "@omnyo/db";
import {
  captureConversationOutlineCheckpoint,
  restoreConversationOutlineCheckpoint,
} from "../../../src/services/threads/conversation-outline-cache.js";
import {
  buildThreadConversationOutline,
  loadThreadConversationOutline,
} from "../../../src/services/threads/timeline.js";
import {
  appendRows,
  countSelectedEventRows,
  withTestThread,
  type RowSpec,
  type TestThread,
  PROVIDER_THREAD_ID,
} from "../../helpers/timeline-cache-fixture.js";

function started(turnId: string, parentToolCallId?: string): RowSpec {
  return {
    type: "turn/started",
    turnId,
    parentToolCallId,
    data: { parentToolCallId },
  };
}

function completed(turnId: string): RowSpec {
  return { type: "turn/completed", turnId, data: { status: "completed" } };
}

function message(
  turnId: string,
  text: string,
  parentToolCallId?: string,
  itemId = `message-${turnId}`,
): RowSpec {
  return {
    type: "item/completed",
    turnId,
    itemId,
    itemKind: "agentMessage",
    parentToolCallId,
    data: {
      item: {
        id: itemId,
        type: "agentMessage",
        text,
        parentToolCallId,
      },
    },
  };
}

function delta(turnId: string, text: string): RowSpec {
  return {
    type: "item/agentMessage/delta",
    turnId,
    itemId: `message-${turnId}`,
    data: { itemId: `message-${turnId}`, delta: text },
  };
}

function request(
  requestId: string,
  expectedTurnId: string | null = null,
): RowSpec {
  return {
    type: "client/turn/requested",
    data: {
      direction: "outbound",
      requestId,
      source: "tell",
      initiator: "user",
      senderThreadId: null,
      input: [{ type: "text", text: "User request" }],
      target:
        expectedTurnId === null
          ? { kind: "new-turn" }
          : { kind: "steer", expectedTurnId },
      request: { method: "turn/start", params: {} },
      execution: {
        model: "gpt-5",
        reasoningLevel: "medium",
        permissionMode: "workspace-write",
        source: "client/turn/requested",
        serviceTier: "auto",
      },
    },
  };
}

function accepted(requestId: string, turnId: string): RowSpec {
  return {
    type: "turn/input/accepted",
    turnId,
    data: { clientRequestId: requestId },
  };
}

function seed(testThread: TestThread, count = 3): void {
  appendRows(
    testThread,
    Array.from({ length: count }, (_, i) => {
      const turnId = `turn-${i}`;
      const requestId = `creq_${i.toString(8).replaceAll("0", "a").replaceAll("1", "b").padStart(10, "a")}`;

      return [
        request(requestId),
        started(turnId),
        accepted(requestId, turnId),
        message(turnId, `Answer ${i}`),
        completed(turnId),
      ];
    }).flat(),
  );
  appendRows(testThread, [started("live"), delta("live", "Live")]);
}

function nestedTurn(index: number, includeParent = true): RowSpec[] {
  const root = `nested-root-${index}`;
  const child = `nested-child-${index}`;
  const parent = `nested-call-${index}`;

  return [
    started(root),
    ...(includeParent ? [parentCall(root, parent)] : []),
    started(child, parent),
    message(child, `Child answer ${index}`, parent),
    { ...completed(child), parentToolCallId: parent },
    message(root, `Root answer ${index}`),
    completed(root),
  ];
}

function parentCall(turnId: string, itemId: string): RowSpec {
  return {
    type: "item/started",
    turnId,
    itemId,
    itemKind: "toolCall",
    data: {
      item: {
        id: itemId,
        type: "toolCall",
        tool: "Agent",
        arguments: {},
        status: "pending",
      },
    },
  };
}

function load(
  testThread: TestThread,
  completedTurnDisplay: CompletedTurnDisplay = "collapse",
) {
  const threadId = testThread.thread.id;

  return loadThreadConversationOutline(testThread.db, testThread.thread, {
    completedTurnDisplay,
    includeClearedContextHistory: false,
    maxSeq: getLatestThreadSequence(testThread.db, { threadId }),
  });
}

function expectMatchesFull(
  testThread: TestThread,
  completedTurnDisplay: CompletedTurnDisplay = "collapse",
) {
  const result = load(testThread, completedTurnDisplay);
  expect(result).toEqual(
    buildThreadConversationOutline(testThread.coldDb, testThread.thread, {
      completedTurnDisplay,
      includeClearedContextHistory: false,
      maxSeq: result.maxSeq,
    }),
  );

  return result;
}

function appendValidRows(testThread: TestThread, specs: RowSpec[]): void {
  for (const spec of specs)
    parseStoredThreadEvent({
      data: spec.data ?? {},
      providerThreadId:
        spec.providerThreadId === undefined
          ? spec.turnId == null
            ? null
            : PROVIDER_THREAD_ID
          : spec.providerThreadId,
      scope: spec.turnId == null ? threadScope() : turnScope(spec.turnId),
      threadId: testThread.thread.id,
      type: spec.type,
    });
  appendRows(testThread, specs);
}

describe("incremental conversation outlines", () => {
  it("keeps generated inputs out of the human conversation outline", () => {
    withTestThread((testThread) => {
      const human = request("creq_aaaaaaaaaa");
      const script = request("creq_bbbbbbbbbb");
      const agent = request("creq_cccccccccc");
      const automation = request("creq_dddddddddd");

      appendRows(testThread, [
        human,
        {
          ...script,
          data: {
            ...script.data,
            systemMessageKind: "external-message",
            systemMessageSubject: {
              kind: "message-source",
              source: { kind: "script", label: "Nightly check" },
            },
          },
        },
        {
          ...agent,
          data: {
            ...agent.data,
            initiator: "agent",
            senderThreadId: "thr_source",
          },
        },
        {
          ...automation,
          data: {
            ...automation.data,
            input: [
              { type: "text", text: "[bb automation due:auto_nightly] Check" },
            ],
          },
        },
      ]);

      expect(expectMatchesFull(testThread).items).toMatchObject([
        { role: "user", preview: "User request" },
      ]);
    });
  });

  it.each(["collapse", "flat"] as const)(
    "retains completed nested history while updating the live tail (%s)",
    (display) => {
      withTestThread((testThread) => {
        appendRows(testThread, [
          ...Array.from({ length: 100 }, (_, index) =>
            nestedTurn(index),
          ).flat(),
          started("live"),
          delta("live", "Live"),
        ]);
        expectMatchesFull(testThread, display);

        for (const rows of [
          [delta("live", " continued")],
          [message("live", "Finished"), completed("live")],
          nestedTurn(101),
          [started("next"), delta("next", "Next")],
        ]) {
          appendRows(testThread, rows);

          const selected = countSelectedEventRows(testThread.db, () =>
            expectMatchesFull(testThread, display),
          );

          expect(selected).toBeLessThan(25);
        }
      });
    },
  );

  it.each([
    "new child",
    "late parent",
    "reopened turn",
    "completion rewrite",
    "incomplete child",
  ] as const)(
    "preserves outlines after nested history changes: %s",
    (change) => {
      withTestThread((testThread) => {
        appendRows(testThread, [
          ...Array.from({ length: 30 }, (_, index) =>
            nestedTurn(index, change !== "late parent"),
          ).flat(),
          started("live"),
          delta("live", "Live"),
        ]);

        const removeCompletion = () =>
          testThread.coldDb.$client
            .prepare(
              "DELETE FROM events WHERE thread_id = ? AND turn_id = ? AND type = 'turn/completed'",
            )
            .run(testThread.thread.id, "nested-child-0");

        if (change === "incomplete child") removeCompletion();
        expectMatchesFull(testThread);

        switch (change) {
          case "new child":
            appendRows(testThread, [
              started("late-child", "nested-call-0"),
              message("late-child", "Late child", "nested-call-0"),
            ]);
            break;
          case "late parent":
            appendRows(testThread, [parentCall("live", "nested-call-0")]);
            break;
          case "reopened turn":
            appendRows(testThread, [
              started("nested-child-0", "nested-call-0"),
              message("nested-child-0", "Reopened", "nested-call-0"),
            ]);
            break;
          case "completion rewrite":
            removeCompletion();
            break;
          case "incomplete child":
            appendRows(testThread, [delta("live", "More")]);
            break;
        }

        const selected = countSelectedEventRows(testThread.db, () =>
          expectMatchesFull(testThread),
        );

        if (change === "completion rewrite")
          expect(selected).toBeGreaterThan(100);
        else expect(selected).toBeLessThan(25);
      });
    },
  );

  it.each(["collapse", "flat"] as const)(
    "only reads root messages while a nested child is still streaming (%s)",
    (display) => {
      withTestThread((testThread) => {
        appendRows(testThread, [
          ...nestedTurn(0).filter(
            (row) =>
              !(
                row.type === "turn/completed" && row.turnId === "nested-child-0"
              ),
          ),
          ...Array.from({ length: 99 }, (_, index) =>
            nestedTurn(index + 1),
          ).flat(),
          started("live"),
          delta("live", "Live"),
        ]);
        expectMatchesFull(testThread, display);

        for (let index = 0; index < 3; index += 1) {
          appendRows(testThread, [
            {
              ...delta("nested-child-0", "Nested update"),
              parentToolCallId: "nested-call-0",
              data: {
                itemId: "message-nested-child-0",
                delta: "Nested update",
                parentToolCallId: "nested-call-0",
              },
            },
            delta("live", " Root update"),
          ]);

          const selected = countSelectedEventRows(testThread.db, () =>
            expectMatchesFull(testThread, display),
          );

          expect(selected).toBeLessThan(25);
        }
      });
    },
  );

  it.each(["immediate", "late"] as const)(
    "keeps accepted root answers with inherited parent metadata (%s acceptance)",
    (acceptance) => {
      withTestThread((testThread) => {
        appendRows(testThread, [
          request("creq_abcdefghij"),
          started("inherited-root", "inherited-parent"),
          ...(acceptance !== "late"
            ? [accepted("creq_abcdefghij", "inherited-root")]
            : []),
          message("inherited-root", "Actual root answer", "inherited-parent"),
          completed("inherited-root"),
          started("live"),
          delta("live", "Live"),
        ]);
        expectMatchesFull(testThread);

        if (acceptance === "late") {
          appendRows(testThread, [
            accepted("creq_abcdefghij", "inherited-root"),
          ]);
        }

        const result = expectMatchesFull(testThread);
        expect(result.items.map((item) => item.preview)).toContain(
          "Actual root answer",
        );
      });
    },
  );

  it("rebuilds root fallback previews when child deltas cross the compaction threshold", () => {
    withTestThread((testThread) => {
      appendRows(testThread, [
        started("root"),
        parentCall("root", "parent"),
        started("child", "parent"),
        delta("root", "First"),
        delta("root", " second"),
        message("root", ""),
        completed("root"),
        started("live"),
        delta("live", "Live"),
      ]);
      const before = expectMatchesFull(testThread);
      expect(before.items.map((item) => item.preview)).toContain(
        "First second",
      );
      appendRows(
        testThread,
        Array.from({ length: 1_000 }, () => ({
          ...delta("child", "Nested"),
          parentToolCallId: "parent",
          data: {
            itemId: "message-child",
            delta: "Nested",
            parentToolCallId: "parent",
          },
        })),
      );
      const after = expectMatchesFull(testThread);
      expect(after.items.map((item) => item.preview)).toContain("First");
    });
  });

  it.each([950, 1050])(
    "preserves previews across delta compaction with %i historical deltas",
    (deltaCount) => {
      withTestThread((testThread) => {
        appendRows(testThread, [
          started("old"),
          ...Array.from({ length: deltaCount }, () => delta("old", "word ")),
          message("old", "Complete"),
          completed("old"),
          started("live"),
          delta("live", "First"),
          delta("live", " second"),
        ]);
        expectMatchesFull(testThread);
        appendRows(testThread, [message("live", ""), completed("live")]);
        expectMatchesFull(testThread);
        appendRows(testThread, [
          started("next"),
          ...Array.from({ length: 100 }, () => delta("next", "more ")),
        ]);
        expectMatchesFull(testThread);
      });
    },
  );

  it("rebuilds when a previously unaccepted request joins a later turn", () => {
    withTestThread((testThread) => {
      appendRows(testThread, [request("creq_abcdefghij")]);
      seed(testThread);
      expectMatchesFull(testThread);
      appendRows(testThread, [
        accepted("creq_abcdefghij", "live"),
        delta("live", " accepted"),
      ]);
      expectMatchesFull(testThread);
    });
  });

  it("only reads the live tail after a long completed history, including across turn boundaries", () => {
    withTestThread((testThread) => {
      seed(testThread, 100);
      expectMatchesFull(testThread);

      for (const rows of [
        [delta("live", " continuation")],
        [message("live", "Final answer"), completed("live")],
        [
          request("creq_abcdefghij"),
          started("next"),
          accepted("creq_abcdefghij", "next"),
          delta("next", "Next"),
        ],
        [delta("next", " update")],
      ]) {
        appendRows(testThread, rows);

        const count = countSelectedEventRows(testThread.db, () => {
          load(testThread);
        });

        expect(count).toBeGreaterThan(0);
        expect(count).toBeLessThan(20);
        expectMatchesFull(testThread);
      }
    });
  });

  it.each([{ status: "idle" }, { title: "Renamed thread" }] as const)(
    "reads only the live tail after a metadata change (%o)",
    (change) =>
      withTestThread((testThread) => {
        seed(testThread, 100);
        expectMatchesFull(testThread);
        testThread.thread = { ...testThread.thread, ...change };

        const count = countSelectedEventRows(testThread.db, () => {
          load(testThread);
        });

        expect(count).toBeLessThan(20);
        expectMatchesFull(testThread);
      }),
  );

  it.each([
    "rewind",
    "clear",
    "external rewrite",
    "metadata",
    "display",
    "late event",
    "late steer",
    "thread error",
    "nested",
  ] as const)(
    "matches a full rebuild after %s invalidates the frozen prefix",
    (change) =>
      withTestThread((testThread) => {
        seed(testThread);
        appendRows(testThread, [
          message("live", "Finished prelude"),
          completed("live"),
          ...nestedTurn(900),
          started("next-live"),
          delta("next-live", "Live"),
        ]);
        expectMatchesFull(testThread);

        switch (change) {
          case "rewind": {
            const maxSeq = getLatestThreadSequence(testThread.db, {
              threadId: testThread.thread.id,
            });

            testThread.db.transaction((tx) =>
              deleteThreadEventSuffixInTransaction(tx, {
                threadId: testThread.thread.id,
                cutoffSequence: 4,
                oldMaxSequence: maxSeq,
              }),
            );
            appendRows(testThread, [
              message("turn-0", "Replacement"),
              completed("turn-0"),
              started("replacement"),
              delta("replacement", "New"),
            ]);

            while (
              getLatestThreadSequence(testThread.db, {
                threadId: testThread.thread.id,
              }) < maxSeq
            ) {
              appendRows(testThread, [
                {
                  type: "system/manager/user_message",
                  data: { text: "Refilled history" },
                },
              ]);
            }

            break;
          }

          case "clear":
            appendRows(testThread, [
              {
                type: "system/operation",
                data: {
                  operation: THREAD_CONTEXT_CLEAR_OPERATION,
                  operationId: "clear",
                  status: "completed",
                  message: "Context cleared",
                },
              },
              started("fresh"),
              delta("fresh", "Fresh"),
            ]);
            break;
          case "external rewrite":
            testThread.coldDb.$client
              .prepare(
                "UPDATE events SET data = json_set(data, '$.item.text', 'Rewritten') WHERE thread_id = ? AND sequence = 4",
              )
              .run(testThread.thread.id);
            break;
          case "display":
            break;
          case "metadata":
            testThread.thread = {
              ...testThread.thread,
              title: "Renamed",
              status: "error",
            };
            break;
          case "late event":
            appendRows(testThread, [message("turn-0", "Late replacement")]);
            break;
          case "late steer":
            appendRows(testThread, [
              request("creq_abcdefghij", "turn-0"),
              accepted("creq_abcdefghij", "turn-0"),
            ]);
            break;
          case "thread error":
            appendRows(testThread, [
              { type: "system/error", data: { message: "Failed" } },
            ]);
            break;
          case "nested":
            appendRows(testThread, [
              {
                ...started("child"),
                parentToolCallId: "parent",
                data: { parentToolCallId: "parent" },
              },
              {
                ...message("child", "Child answer"),
                parentToolCallId: "parent",
                data: {
                  item: {
                    id: "message-child",
                    type: "agentMessage",
                    text: "Child answer",
                    parentToolCallId: "parent",
                  },
                },
              },
            ]);
            break;
        }

        expectMatchesFull(
          testThread,
          change === "display" ? "flat" : "collapse",
        );
      }),
  );

  it("evicts old checkpoints without changing their rebuilt outlines", () => {
    withTestThread((testThread) => {
      seed(testThread, 100);
      expectMatchesFull(testThread);
      const firstThread = testThread.thread;

      for (let index = 0; index < 16; index += 1) {
        testThread.thread = createThread(testThread.db, noopNotifier, {
          projectId: testThread.projectId,
          providerId: "codex",
          status: "active",
        });
        seed(testThread);
        load(testThread);
      }

      testThread.thread = firstThread;

      const count = countSelectedEventRows(testThread.db, () => {
        load(testThread);
      });

      expect(count).toBeGreaterThan(500);
      expectMatchesFull(testThread);
      appendRows(testThread, [delta("live", " after eviction")]);
      expect(
        countSelectedEventRows(testThread.db, () => {
          load(testThread);
        }),
      ).toBeLessThan(20);
      expectMatchesFull(testThread);
    });
  });

  it.each(["collapse", "flat"] as const)(
    "preserves delegation-separated responses through late lifecycle updates (%s)",
    (display) => {
      withTestThread((testThread) => {
        const delegation = (
          type: RowSpec["type"],
          finished: boolean,
          turnId: string | null,
        ): RowSpec => ({
          type,
          turnId,
          providerThreadId: PROVIDER_THREAD_ID,
          itemId: "delegation-call",
          itemKind: "delegation",
          data: {
            item: {
              type: "delegation",
              id: "delegation-call",
              childRef: "delegated-provider",
              label: "Investigate",
              status: finished ? "completed" : "pending",
              background: true,
            },
          },
        });

        appendRows(testThread, [
          started("delegation-root"),
          message("delegation-root", "A", undefined, "before-delegation"),
          delegation("item/started", false, "delegation-root"),
          message("delegation-root", "B", undefined, "after-delegation"),
          completed("delegation-root"),
          ...Array.from({ length: 50 }, (_, index) => [
            started(`settled-${index}`),
            message(`settled-${index}`, `Settled ${index}`),
            completed(`settled-${index}`),
          ]).flat(),
          started("live"),
          message("live", "Live"),
        ]);

        const expected = [
          ...(display === "collapse" ? ["B"] : ["A", "B"]),
          ...Array.from({ length: 50 }, (_, index) => `Settled ${index}`),
          "Live",
        ];

        expect(
          load(testThread, display).items.map((item) => item.preview),
        ).toEqual(expected);
        expect(
          buildThreadConversationOutline(testThread.coldDb, testThread.thread, {
            completedTurnDisplay: display,
            includeClearedContextHistory: false,
            maxSeq: getLatestThreadSequence(testThread.db, {
              threadId: testThread.thread.id,
            }),
          }).items.map((item) => item.preview),
        ).toEqual(expected);

        for (const update of [
          delegation("item/delegation/progress", false, null),
          delegation("item/delegation/completed", true, null),
        ]) {
          appendRows(testThread, [update]);

          const count = countSelectedEventRows(testThread.db, () => {
            expect(
              load(testThread, display).items.map((item) => item.preview),
            ).toEqual(expected);
          });

          expect(count).toBeGreaterThan(0);
          expect(count).toBeLessThanOrEqual(32);
        }
      });
    },
  );

  it.each(["collapse", "flat"] as const)(
    "retains implicit delegation ownership when its distinct provider starts later (%s)",
    (display) => {
      withTestThread((testThread) => {
        appendValidRows(testThread, [
          started("delegating-root"),
          {
            type: "item/started",
            turnId: "delegating-root",
            itemId: "implicit-delegation",
            itemKind: "delegation",
            data: {
              item: {
                type: "delegation",
                id: "implicit-delegation",
                childRef: "distinct-child-provider",
                label: "Investigate",
                status: "pending",
                background: true,
              },
            },
          },
          message("delegating-root", "Parent answer"),
          completed("delegating-root"),
          ...Array.from({ length: 50 }, (_, index) => [
            started(`separate-${index}`),
            message(`separate-${index}`, `Separate ${index}`),
            completed(`separate-${index}`),
          ]).flat(),
          started("live"),
        ]);

        const expected = [
          "Parent answer",
          ...Array.from({ length: 50 }, (_, index) => `Separate ${index}`),
        ];

        expect(
          load(testThread, display).items.map((item) => item.preview),
        ).toEqual(expected);
        appendValidRows(testThread, [
          {
            ...started("implicit-child"),
            providerThreadId: "distinct-child-provider",
          },
          {
            ...message("implicit-child", "Private child answer"),
            providerThreadId: "distinct-child-provider",
          },
          {
            ...completed("implicit-child"),
            providerThreadId: "distinct-child-provider",
          },
        ]);

        const canonical = buildThreadConversationOutline(
          testThread.coldDb,
          testThread.thread,
          {
            completedTurnDisplay: display,
            includeClearedContextHistory: false,
            maxSeq: getLatestThreadSequence(testThread.db, {
              threadId: testThread.thread.id,
            }),
          },
        );

        expect(canonical.items.map((item) => item.preview)).toEqual(expected);

        const count = countSelectedEventRows(testThread.db, () => {
          expect(load(testThread, display)).toEqual(canonical);
        });

        expect(count).toBeGreaterThan(0);
        expect(count).toBeLessThanOrEqual(32);
      });
    },
  );

  it.each(["collapse", "flat"] as const)(
    "retains pending same-provider delegation links across accepted roots and checkpoint restoration (%s)",
    (display) => {
      withTestThread((testThread) => {
        const settled = Array.from({ length: 50 }, (_, index) => {
          const turnId = `accepted-${index}`;
          const requestId = `creq_${(index + 100).toString(8).replaceAll("0", "a").replaceAll("1", "b").padStart(10, "a")}`;

          return [
            request(requestId),
            started(turnId),
            accepted(requestId, turnId),
            message(turnId, `Separate ${index}`),
            completed(turnId),
          ];
        }).flat();

        appendValidRows(testThread, [
          started("pending-owner"),
          {
            type: "item/started",
            turnId: "pending-owner",
            itemId: "pending-delegation",
            itemKind: "delegation",
            data: {
              item: {
                type: "delegation",
                id: "pending-delegation",
                childRef: PROVIDER_THREAD_ID,
                label: "Investigate",
                status: "pending",
                background: true,
              },
            },
          },
          message("pending-owner", "Parent answer"),
          completed("pending-owner"),
          ...settled,
          request("creq_zzzzzzzzzz"),
          started("accepted-live"),
          accepted("creq_zzzzzzzzzz", "accepted-live"),
        ]);

        const expected = [
          "Parent answer",
          ...Array.from({ length: 50 }, (_, index) => [
            "User request",
            `Separate ${index}`,
          ]).flat(),
          "User request",
        ];

        expect(
          load(testThread, display).items.map((item) => item.preview),
        ).toEqual(expected);

        const checkpoint = captureConversationOutlineCheckpoint(
          testThread.db,
          testThread.thread.id,
        );

        expect(checkpoint).not.toBeNull();
        expect(
          restoreConversationOutlineCheckpoint(
            testThread.coldDb,
            testThread.thread.id,
            JSON.parse(JSON.stringify(checkpoint)),
          ),
        ).toBe(true);
        appendValidRows(testThread, [
          started("pending-child"),
          message("pending-child", "Suppressed child answer"),
          completed("pending-child"),
        ]);

        const canonical = buildThreadConversationOutline(
          testThread.coldDb,
          testThread.thread,
          {
            completedTurnDisplay: display,
            includeClearedContextHistory: false,
            maxSeq: getLatestThreadSequence(testThread.db, {
              threadId: testThread.thread.id,
            }),
          },
        );

        expect(canonical.items.map((item) => item.preview)).toEqual(expected);
        const restoredThread = { ...testThread, db: testThread.coldDb };
        expect(load(restoredThread, display)).toEqual(canonical);
        appendValidRows(testThread, [
          started("after-consumption"),
          message("after-consumption", "Root after consumed link"),
          completed("after-consumption"),
        ]);

        const afterConsumption = buildThreadConversationOutline(
          testThread.coldDb,
          testThread.thread,
          {
            completedTurnDisplay: display,
            includeClearedContextHistory: false,
            maxSeq: getLatestThreadSequence(testThread.db, {
              threadId: testThread.thread.id,
            }),
          },
        );

        expect(afterConsumption.items.map((item) => item.preview)).toEqual([
          ...expected,
          "Root after consumed link",
        ]);

        const selected = countSelectedEventRows(restoredThread.db, () => {
          expect(load(restoredThread, display)).toEqual(afterConsumption);
        });

        expect(selected).toBeGreaterThan(0);
        expect(selected).toBeLessThanOrEqual(32);
      });
    },
  );

  it("does not retain settled rejected steers in the mutable tail", () => {
    withTestThread((testThread) => {
      appendRows(testThread, [
        ...Array.from({ length: 40 }, (_, index) => {
          const turnId = `rejected-${index}`;
          const requestId = `creq_${index.toString(8).replaceAll("0", "a").replaceAll("1", "b").padStart(10, "a")}`;

          return [
            started(turnId),
            request(requestId, turnId),
            {
              type: "client/turn/rejected" as const,
              data: {
                requestId,
                reason: "command_failed",
                message: "Rejected steer",
              },
            },
            message(turnId, `Answer ${index}`),
            completed(turnId),
          ];
        }).flat(),
        started("live"),
        message("live", "Live"),
      ]);

      const expected = [
        ...Array.from({ length: 40 }, (_, index) => [
          "User request",
          `Answer ${index}`,
        ]).flat(),
        "Live",
      ];

      expect(
        load(testThread, "flat").items.map((item) => item.preview),
      ).toEqual(expected);
      appendRows(testThread, [
        message("live", "Live continued", undefined, "continued-message"),
      ]);
      expected.push("Live continued");
      expect(
        buildThreadConversationOutline(testThread.coldDb, testThread.thread, {
          completedTurnDisplay: "flat",
          includeClearedContextHistory: false,
          maxSeq: getLatestThreadSequence(testThread.db, {
            threadId: testThread.thread.id,
          }),
        }).items.map((item) => item.preview),
      ).toEqual(expected);

      const count = countSelectedEventRows(testThread.db, () => {
        expect(
          load(testThread, "flat").items.map((item) => item.preview),
        ).toEqual(expected);
      });

      expect(count).toBeGreaterThan(0);
      expect(count).toBeLessThanOrEqual(32);
    });
  });

  it("resumes a serialized checkpoint on another connection and rejects a rewrite", () => {
    withTestThread((testThread) => {
      seed(testThread, 100);
      appendRows(testThread, [message("live", "Live")]);
      load(testThread);

      const checkpoint = captureConversationOutlineCheckpoint(
        testThread.db,
        testThread.thread.id,
      );

      expect(checkpoint).not.toBeNull();
      expect(
        restoreConversationOutlineCheckpoint(
          testThread.coldDb,
          testThread.thread.id,
          JSON.parse(JSON.stringify(checkpoint)),
        ),
      ).toBe(true);
      appendRows(testThread, [
        message("live", "Live resumed", undefined, "resumed-message"),
      ]);
      expect(
        buildThreadConversationOutline(testThread.coldDb, testThread.thread, {
          completedTurnDisplay: "collapse",
          includeClearedContextHistory: false,
          maxSeq: getLatestThreadSequence(testThread.db, {
            threadId: testThread.thread.id,
          }),
        })
          .items.slice(-2)
          .map((item) => item.preview),
      ).toEqual(["Live", "Live resumed"]);
      const resumedThread = { ...testThread, db: testThread.coldDb };

      const selected = countSelectedEventRows(resumedThread.db, () => {
        expect(load(resumedThread).items.at(-1)).toEqual(
          expect.objectContaining({
            role: "assistant",
            preview: "Live resumed",
          }),
        );
      });

      expect(selected).toBeGreaterThan(0);
      expect(selected).toBeLessThanOrEqual(32);
      testThread.db.$client
        .prepare(
          "UPDATE events SET data = json_set(data, '$.item.text', 'Rewritten answer') WHERE thread_id = ? AND sequence = 4",
        )
        .run(testThread.thread.id);
      const rewritten = load(resumedThread);
      expect(rewritten.items[1]).toEqual(
        expect.objectContaining({
          role: "assistant",
          preview: "Rewritten answer",
        }),
      );
      expect(rewritten.items.at(-1)?.preview).toBe("Live resumed");
    });
  });

  it("rejects invalid persisted checkpoint ranges and projection payloads", () => {
    withTestThread((testThread) => {
      seed(testThread);
      load(testThread);

      const checkpoint = captureConversationOutlineCheckpoint(
        testThread.db,
        testThread.thread.id,
      );

      expect(checkpoint).not.toBeNull();

      if (checkpoint === null) throw new Error("Expected checkpoint");
      const invalidRange = structuredClone(checkpoint);
      invalidRange.fragments[0]!.ranges[0]!.end = checkpoint.maxSeq + 2;
      expect(
        restoreConversationOutlineCheckpoint(
          testThread.coldDb,
          testThread.thread.id,
          invalidRange,
        ),
      ).toBe(false);
      expect(
        restoreConversationOutlineCheckpoint(
          testThread.coldDb,
          testThread.thread.id,
          { ...checkpoint, version: 2 },
        ),
      ).toBe(false);
      expect(
        restoreConversationOutlineCheckpoint(
          testThread.coldDb,
          testThread.thread.id,
          { ...checkpoint, rawEvents: [] },
        ),
      ).toBe(false);
    });
  });

  it("preserves overlapping turns and pending steers as they complete", () => {
    withTestThread((testThread) => {
      seed(testThread);
      expectMatchesFull(testThread);

      for (const rows of [
        [
          request("creq_abcdefghij", "live"),
          started("overlapping"),
          delta("overlapping", "Other"),
        ],
        [message("live", "Finished"), completed("live")],
        [
          accepted("creq_abcdefghij", "overlapping"),
          message("overlapping", "Other finished"),
          completed("overlapping"),
        ],
        [started("last"), delta("last", "Last")],
        [started("another"), delta("another", "Another")],
        [message("another", "Another done"), completed("another")],
        [message("last", "Last done"), completed("last")],
        [started("final"), delta("final", "Final")],
      ]) {
        appendRows(testThread, rows);
        expectMatchesFull(testThread);
      }
    });
  });
});
