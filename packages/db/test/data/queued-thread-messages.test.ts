import { describe, expect, it, vi } from "vitest";
import { threadScope, type PromptInput } from "@omnyo/domain";
import { noopNotifier } from "../../src/notifier.js";
import { insertEvents } from "../../src/data/events.js";
import {
  claimNextQueuedThreadMessageGroup,
  claimQueuedThreadMessageGroup,
  clearQueuedThreadMessageWaitingOn,
  createQueuedThreadMessage,
  deleteClaimedQueuedThreadMessageBatchInTransaction,
  deleteQueuedThreadMessage,
  getQueuedThreadMessage,
  holdQueuedThreadMessageForEdit,
  listIdleThreadsWithQueuedMessages,
  listQueuedThreadMessages,
  releaseQueuedMessageClaim,
  releaseQueuedThreadMessageEditHold,
  releaseStaleQueuedMessageClaims,
  reorderQueuedThreadMessage,
  requeueClaimedQueuedThreadMessages,
  setQueuedThreadMessageGroupBoundary,
  restoreDeletedQueuedThreadMessage,
  supersedeQueuedRetriesInTransaction,
  updateQueuedThreadMessage,
} from "../../src/data/queued-thread-messages.js";
import { createProject } from "../../src/data/projects.js";
import { createThread } from "../../src/data/threads.js";
import { upsertHost } from "../../src/data/hosts.js";
import { createMigratedConnection } from "../helpers/migrated-connection.js";

function textInput(text: string): PromptInput[] {
  return [{ type: "text", text, mentions: [] }];
}

const defaultInput = textInput("hello");

const altInput = textInput("world");

function queueTurnEndMessage(
  db: ReturnType<typeof createMigratedConnection>,
  threadId: string,
  content: PromptInput[],
  wait: {
    sendAt: number | null;
    waitingOn: { kind: "thread-busy" | "time" };
  } = {
    sendAt: null,
    waitingOn: { kind: "thread-busy" },
  },
) {
  return createQueuedThreadMessage(db, noopNotifier, {
    threadId,
    content,
    model: "gpt-5",
    reasoningLevel: "medium",
    permissionMode: "full",
    serviceTier: "default",
    waitingOn: wait.waitingOn,
    sendAt: wait.sendAt,
    payload: { kind: "inline" },
    systemNotice: null,
  });
}

function setup() {
  const db = createMigratedConnection();

  const host = upsertHost(db, noopNotifier, {
    name: "test-host",
  });

  const { project } = createProject(db, noopNotifier, {
    name: "test-project",
    source: { type: "local_path", hostId: host.id, path: "/tmp/test" },
  });

  const thread = createThread(db, noopNotifier, {
    projectId: project.id,
    providerId: "codex",
  });

  return { db, project, thread };
}

describe("queued thread messages", () => {
  it.each([false, true])(
    "overtaken retry preserves unsent input or drops accepted chain input (%s)",
    (accepted) => {
      const { db, thread } = setup();

      try {
        insertEvents(db, noopNotifier, [
          {
            threadId: thread.id,
            sequence: 1,
            type: "client/turn/requested",
            scope: threadScope(),
            itemId: null,
            itemKind: null,
            parentToolCallId: null,
            data: JSON.stringify({ requestId: "creq_aaaaaaaaaa" }),
          },
          {
            threadId: thread.id,
            sequence: 2,
            type: "client/turn/requested",
            scope: threadScope(),
            itemId: null,
            itemKind: null,
            parentToolCallId: null,
            data: JSON.stringify({
              requestId: "creq_bbbbbbbbbb",
              retryOfRequestId: "creq_aaaaaaaaaa",
            }),
          },
          ...(accepted
            ? [
                {
                  threadId: thread.id,
                  sequence: 3,
                  type: "turn/input/accepted" as const,
                  scope: threadScope(),
                  itemId: null,
                  itemKind: null,
                  parentToolCallId: null,
                  data: JSON.stringify({ clientRequestId: "creq_bbbbbbbbbb" }),
                },
              ]
            : []),
        ]);

        const row = createQueuedThreadMessage(db, noopNotifier, {
          threadId: thread.id,
          content: defaultInput,
          model: "gpt-5",
          reasoningLevel: "medium",
          permissionMode: "full",
          serviceTier: "default",
          waitingOn: { kind: "time" },
          sendAt: Date.now() + 60_000,
          payload: {
            kind: "retry",
            retryOfTurnRequestId: "creq_aaaaaaaaaa",
            attempt: 3,
            reason: "Rate limited",
          },
          systemNotice: null,
        });

        expect(
          db.transaction((tx) =>
            supersedeQueuedRetriesInTransaction(tx, {
              threadId: thread.id,
              retryOfTurnRequestId: null,
            }),
          ),
        ).toBe(1);
        const remaining = getQueuedThreadMessage(db, row.id);

        if (accepted) expect(remaining).toBeNull();
        else {
          expect(remaining?.content).toBe(row.content);
          expect(remaining?.waitingOn).toBe(
            JSON.stringify({ kind: "superseded" }),
          );
          expect(remaining?.sendAt).toBeNull();
        }
      } finally {
        db.$client.close();
      }
    },
  );

  it("does not supersede a claimed retry, its own chain, or continuation recovery", () => {
    const { db, thread } = setup();

    try {
      const own = createQueuedThreadMessage(db, noopNotifier, {
        threadId: thread.id,
        content: defaultInput,
        model: "gpt-5",
        reasoningLevel: "medium",
        permissionMode: "full",
        serviceTier: "default",
        waitingOn: { kind: "time" },
        sendAt: Date.now() + 60_000,
        payload: {
          kind: "retry",
          retryOfTurnRequestId: "creq_aaaaaaaaaa",
          attempt: 2,
          reason: "Rate limited",
        },
        systemNotice: null,
      });

      const claimed = createQueuedThreadMessage(db, noopNotifier, {
        threadId: thread.id,
        content: altInput,
        model: "gpt-5",
        reasoningLevel: "medium",
        permissionMode: "full",
        serviceTier: "default",
        waitingOn: null,
        sendAt: null,
        payload: {
          kind: "retry",
          retryOfTurnRequestId: "creq_bbbbbbbbbb",
          attempt: 2,
          reason: "Rate limited",
        },
        systemNotice: null,
      });

      expect(
        claimQueuedThreadMessageGroup(db, noopNotifier, claimed.id, {
          kind: "explicit-send",
        }),
      ).toHaveLength(1);

      const continuation = createQueuedThreadMessage(db, noopNotifier, {
        threadId: thread.id,
        content: altInput,
        model: "gpt-5",
        reasoningLevel: "medium",
        permissionMode: "full",
        serviceTier: "default",
        waitingOn: { kind: "thread-busy" },
        sendAt: null,
        payload: { kind: "continuation" },
        systemNotice: null,
      });

      expect(
        db.transaction((tx) =>
          supersedeQueuedRetriesInTransaction(tx, {
            threadId: thread.id,
            retryOfTurnRequestId: "creq_aaaaaaaaaa",
          }),
        ),
      ).toBe(0);
      expect(getQueuedThreadMessage(db, own.id)?.sendAt).toBe(own.sendAt);
      expect(getQueuedThreadMessage(db, claimed.id)?.claimToken).not.toBeNull();
      expect(getQueuedThreadMessage(db, continuation.id)?.waitingOn).toBe(
        continuation.waitingOn,
      );
    } finally {
      db.$client.close();
    }
  });
  it("lists an idle thread waiting for its turn to start", () => {
    const { db, project } = setup();

    const thread = createThread(db, noopNotifier, {
      projectId: project.id,
      providerId: "codex",
      status: "idle",
    });

    createQueuedThreadMessage(db, noopNotifier, {
      threadId: thread.id,
      content: defaultInput,
      model: "gpt-5",
      reasoningLevel: "medium",
      permissionMode: "full",
      serviceTier: "default",
      waitingOn: { kind: "turn-starting" },
      sendAt: null,
      payload: { kind: "inline" },
      systemNotice: null,
    });

    expect(
      listIdleThreadsWithQueuedMessages(db).map((row) => row.threadId),
    ).toContain(thread.id);
  });

  it("updates queued message content without changing its identity or position", () => {
    const { db, thread } = setup();

    const first = createQueuedThreadMessage(db, noopNotifier, {
      threadId: thread.id,
      content: defaultInput,
      model: "gpt-5",
      reasoningLevel: "medium",
      permissionMode: "full",
      serviceTier: "default",
      waitingOn: null,
      sendAt: null,
      payload: { kind: "inline" },
      systemNotice: null,
    });

    const second = createQueuedThreadMessage(db, noopNotifier, {
      threadId: thread.id,
      content: altInput,
      model: "gpt-5",
      reasoningLevel: "medium",
      permissionMode: "full",
      serviceTier: "default",
      waitingOn: null,
      sendAt: null,
      payload: { kind: "inline" },
      systemNotice: null,
    });

    setQueuedThreadMessageGroupBoundary({
      db,
      expectedGroupedPrefixQueuedMessageIds: [first.id, second.id],
      groupBoundaryQueuedMessageId: second.id,
      notifier: noopNotifier,
      threadId: thread.id,
    });
    const before = getQueuedThreadMessage(db, first.id);

    const result = updateQueuedThreadMessage(db, noopNotifier, {
      execution: null,
      content: textInput("edited in place"),
      expectedUpdatedAt: before?.updatedAt ?? -1,
      id: first.id,
      threadId: thread.id,
    });

    expect(result.kind).toBe("updated");
    expect(
      listQueuedThreadMessages(db, thread.id).map((row) => row.id),
    ).toEqual([first.id, second.id]);
    expect(getQueuedThreadMessage(db, first.id)).toMatchObject({
      content: JSON.stringify(textInput("edited in place")),
      createdAt: before?.createdAt,
      groupWithNext: true,
      id: first.id,
      model: before?.model,
      permissionMode: before?.permissionMode,
      reasoningLevel: before?.reasoningLevel,
      serviceTier: before?.serviceTier,
      sortKey: before?.sortKey,
    });
  });

  it("saves an edited model, reasoning, tier and permission with the content", () => {
    const { db, thread } = setup();

    const queuedMessage = createQueuedThreadMessage(db, noopNotifier, {
      threadId: thread.id,
      content: defaultInput,
      model: "gpt-5",
      reasoningLevel: "medium",
      permissionMode: "full",
      serviceTier: "default",
      waitingOn: null,
      sendAt: null,
      payload: { kind: "inline" },
      systemNotice: null,
    });

    const result = updateQueuedThreadMessage(db, noopNotifier, {
      execution: {
        model: "gpt-5-mini",
        permissionMode: "accept-edits",
        reasoningLevel: "high",
        serviceTier: "fast",
      },
      content: textInput("edited with a new model"),
      expectedUpdatedAt: queuedMessage.updatedAt,
      id: queuedMessage.id,
      threadId: thread.id,
    });

    expect(result.kind).toBe("updated");
    expect(getQueuedThreadMessage(db, queuedMessage.id)).toMatchObject({
      content: JSON.stringify(textInput("edited with a new model")),
      model: "gpt-5-mini",
      permissionMode: "accept-edits",
      reasoningLevel: "high",
      serviceTier: "fast",
    });
  });

  it("rejects a second update based on the same queued message version", () => {
    const { db, thread } = setup();

    const queuedMessage = createQueuedThreadMessage(db, noopNotifier, {
      threadId: thread.id,
      content: defaultInput,
      model: "gpt-5",
      reasoningLevel: "medium",
      permissionMode: "full",
      serviceTier: "default",
      waitingOn: null,
      sendAt: null,
      payload: { kind: "inline" },
      systemNotice: null,
    });

    expect(
      updateQueuedThreadMessage(db, noopNotifier, {
        execution: null,
        content: textInput("first edit"),
        expectedUpdatedAt: queuedMessage.updatedAt,
        id: queuedMessage.id,
        threadId: thread.id,
      }).kind,
    ).toBe("updated");
    expect(
      updateQueuedThreadMessage(db, noopNotifier, {
        execution: null,
        content: textInput("stale edit"),
        expectedUpdatedAt: queuedMessage.updatedAt,
        id: queuedMessage.id,
        threadId: thread.id,
      }),
    ).toEqual({ kind: "stale" });
    expect(getQueuedThreadMessage(db, queuedMessage.id)?.content).toBe(
      JSON.stringify(textInput("first edit")),
    );
  });

  it("advances updatedAt when an update occurs within the same millisecond", () => {
    const fixedNow = Date.now();
    const dateNow = vi.spyOn(Date, "now").mockReturnValue(fixedNow);

    try {
      const { db, thread } = setup();

      const queuedMessage = createQueuedThreadMessage(db, noopNotifier, {
        threadId: thread.id,
        content: defaultInput,
        model: "gpt-5",
        reasoningLevel: "medium",
        permissionMode: "full",
        serviceTier: "default",
        waitingOn: null,
        sendAt: null,
        payload: { kind: "inline" },
        systemNotice: null,
      });

      const result = updateQueuedThreadMessage(db, noopNotifier, {
        execution: null,
        content: altInput,
        expectedUpdatedAt: queuedMessage.updatedAt,
        id: queuedMessage.id,
        threadId: thread.id,
      });

      expect(result).toMatchObject({
        kind: "updated",
        queuedMessage: { updatedAt: fixedNow + 1 },
      });
    } finally {
      dateNow.mockRestore();
    }
  });

  it("does not update a queued message that is already claimed for sending", () => {
    const { db, thread } = setup();

    const queuedMessage = createQueuedThreadMessage(db, noopNotifier, {
      threadId: thread.id,
      content: defaultInput,
      model: "gpt-5",
      reasoningLevel: "medium",
      permissionMode: "full",
      serviceTier: "default",
      waitingOn: null,
      sendAt: null,
      payload: { kind: "inline" },
      systemNotice: null,
    });

    claimQueuedThreadMessageGroup(db, noopNotifier, queuedMessage.id, {
      kind: "explicit-send",
    });

    expect(
      updateQueuedThreadMessage(db, noopNotifier, {
        execution: null,
        content: altInput,
        expectedUpdatedAt: queuedMessage.updatedAt,
        id: queuedMessage.id,
        threadId: thread.id,
      }),
    ).toEqual({ kind: "claimed" });
    expect(getQueuedThreadMessage(db, queuedMessage.id)?.content).toBe(
      JSON.stringify(defaultInput),
    );
  });

  it("deletes a queued message", () => {
    const { db, thread } = setup();

    const queuedMessage = createQueuedThreadMessage(db, noopNotifier, {
      threadId: thread.id,
      content: defaultInput,
      model: "gpt-5",
      reasoningLevel: "medium",
      permissionMode: "full",
      serviceTier: "default",
      waitingOn: null,
      sendAt: null,
      payload: { kind: "inline" },
      systemNotice: null,
    });

    expect(
      deleteQueuedThreadMessage(db, noopNotifier, queuedMessage.id)?.row.id,
    ).toBe(queuedMessage.id);
    expect(listQueuedThreadMessages(db, thread.id)).toHaveLength(0);
    expect(
      deleteQueuedThreadMessage(db, noopNotifier, queuedMessage.id),
    ).toBeNull();
  });

  it("restores a deleted scheduled message in place with its schedule", () => {
    const { db, thread } = setup();
    const sendAt = Date.now() + 60_000;
    const first = queueTurnEndMessage(db, thread.id, defaultInput);

    const scheduled = queueTurnEndMessage(db, thread.id, altInput, {
      sendAt,
      waitingOn: { kind: "time" },
    });

    const last = queueTurnEndMessage(db, thread.id, textInput("last"));
    const deleted = deleteQueuedThreadMessage(db, noopNotifier, scheduled.id);

    if (deleted === null) throw new Error("expected a deletion");

    const restored = restoreDeletedQueuedThreadMessage(
      db,
      noopNotifier,
      deleted,
    );

    expect(restored.kind).toBe("restored");
    expect(
      listQueuedThreadMessages(db, thread.id).map((row) => row.id),
    ).toEqual([first.id, scheduled.id, last.id]);
    expect(getQueuedThreadMessage(db, scheduled.id)).toMatchObject({
      content: JSON.stringify(altInput),
      sendAt,
      waitingOn: JSON.stringify({ kind: "time" }),
      createdAt: scheduled.createdAt,
    });
    expect(
      restoreDeletedQueuedThreadMessage(db, noopNotifier, deleted),
    ).toEqual({ kind: "exists" });
  });

  it("claims a queued message and hides it from the queue until the claim is released", () => {
    const { db, thread } = setup();

    const queuedMessage = createQueuedThreadMessage(db, noopNotifier, {
      threadId: thread.id,
      content: defaultInput,
      model: "gpt-5",
      reasoningLevel: "medium",
      permissionMode: "full",
      serviceTier: "default",
      waitingOn: null,
      sendAt: null,
      payload: { kind: "inline" },
      systemNotice: null,
    });

    const claimedQueuedMessage = claimQueuedThreadMessageGroup(
      db,
      noopNotifier,
      queuedMessage.id,
      { kind: "explicit-send" },
    )?.[0];

    expect(claimedQueuedMessage?.id).toBe(queuedMessage.id);
    expect(claimedQueuedMessage?.claimToken).toMatch(/^qclaim_/);
    expect(listQueuedThreadMessages(db, thread.id)).toHaveLength(0);

    if (!claimedQueuedMessage) {
      throw new Error("Expected queued message claim");
    }

    expect(
      releaseQueuedMessageClaim(db, noopNotifier, {
        id: queuedMessage.id,
        claimToken: claimedQueuedMessage.claimToken,
      }),
    ).toBe(true);
    expect(listQueuedThreadMessages(db, thread.id)).toHaveLength(1);
  });

  it("does not release or consume a queued message claimed by another owner", () => {
    const { db, thread } = setup();

    const queuedMessage = createQueuedThreadMessage(db, noopNotifier, {
      threadId: thread.id,
      content: defaultInput,
      model: "gpt-5",
      reasoningLevel: "medium",
      permissionMode: "full",
      serviceTier: "default",
      waitingOn: null,
      sendAt: null,
      payload: { kind: "inline" },
      systemNotice: null,
    });

    const firstClaim = claimQueuedThreadMessageGroup(
      db,
      noopNotifier,
      queuedMessage.id,
      { kind: "explicit-send" },
    )?.[0];

    if (!firstClaim) {
      throw new Error("Expected first queued message claim");
    }

    expect(
      releaseQueuedMessageClaim(db, noopNotifier, {
        id: queuedMessage.id,
        claimToken: "qclaim_staleowner",
      }),
    ).toBe(false);
    expect(getQueuedThreadMessage(db, queuedMessage.id)?.claimToken).toBe(
      firstClaim.claimToken,
    );
    expect(
      db.transaction((tx) =>
        deleteClaimedQueuedThreadMessageBatchInTransaction(tx, {
          queuedMessages: [
            { id: queuedMessage.id, claimToken: "qclaim_staleowner" },
          ],
        }),
      ),
    ).toBe(false);

    expect(
      releaseQueuedMessageClaim(db, noopNotifier, {
        id: queuedMessage.id,
        claimToken: firstClaim.claimToken,
      }),
    ).toBe(true);

    const secondClaim = claimQueuedThreadMessageGroup(
      db,
      noopNotifier,
      queuedMessage.id,
      { kind: "explicit-send" },
    )?.[0];

    if (!secondClaim) {
      throw new Error("Expected second queued message claim");
    }

    expect(secondClaim.claimToken).not.toBe(firstClaim.claimToken);
    expect(
      db.transaction((tx) =>
        deleteClaimedQueuedThreadMessageBatchInTransaction(tx, {
          queuedMessages: [
            { id: queuedMessage.id, claimToken: firstClaim.claimToken },
          ],
        }),
      ),
    ).toBe(false);
    expect(getQueuedThreadMessage(db, queuedMessage.id)?.claimToken).toBe(
      secondClaim.claimToken,
    );
    expect(
      db.transaction((tx) =>
        deleteClaimedQueuedThreadMessageBatchInTransaction(tx, {
          queuedMessages: [
            { id: queuedMessage.id, claimToken: secondClaim.claimToken },
          ],
        }),
      ),
    ).toBe(true);
    expect(getQueuedThreadMessage(db, queuedMessage.id)).toBeNull();
  });

  it("releases stale queued message claims", () => {
    const { db, thread } = setup();
    const nowSpy = vi.spyOn(Date, "now");

    try {
      nowSpy.mockReturnValue(1_000);

      const queuedMessage = createQueuedThreadMessage(db, noopNotifier, {
        threadId: thread.id,
        content: defaultInput,
        model: "gpt-5",
        reasoningLevel: "medium",
        permissionMode: "full",
        serviceTier: "default",
        waitingOn: null,
        sendAt: null,
        payload: { kind: "inline" },
        systemNotice: null,
      });

      const claimedQueuedMessage = claimQueuedThreadMessageGroup(
        db,
        noopNotifier,
        queuedMessage.id,
        { kind: "explicit-send" },
      )?.[0];

      expect(claimedQueuedMessage?.claimedAt).toBe(1_000);
      expect(claimedQueuedMessage?.claimToken).toMatch(/^qclaim_/);
      expect(listQueuedThreadMessages(db, thread.id)).toHaveLength(0);

      nowSpy.mockReturnValue(10_000);
      expect(
        releaseStaleQueuedMessageClaims(db, noopNotifier, {
          claimedBefore: 5_000,
          protectedClaimTokens: [],
        }),
      ).toBe(1);
      expect(
        listQueuedThreadMessages(db, thread.id).map((row) => row.id),
      ).toEqual([queuedMessage.id]);
      expect(
        getQueuedThreadMessage(db, queuedMessage.id)?.claimToken,
      ).toBeNull();
    } finally {
      nowSpy.mockRestore();
    }
  });

  it("does not release stale queued message claims protected by a live owner", () => {
    const { db, thread } = setup();
    const nowSpy = vi.spyOn(Date, "now");

    try {
      nowSpy.mockReturnValue(1_000);

      const protectedQueuedMessage = createQueuedThreadMessage(
        db,
        noopNotifier,
        {
          threadId: thread.id,
          content: defaultInput,
          model: "gpt-5",
          reasoningLevel: "medium",
          permissionMode: "full",
          serviceTier: "default",
          waitingOn: null,
          sendAt: null,
          payload: { kind: "inline" },
          systemNotice: null,
        },
      );

      const releasableQueuedMessage = createQueuedThreadMessage(
        db,
        noopNotifier,
        {
          threadId: thread.id,
          content: altInput,
          model: "gpt-5",
          reasoningLevel: "medium",
          permissionMode: "full",
          serviceTier: "default",
          waitingOn: null,
          sendAt: null,
          payload: { kind: "inline" },
          systemNotice: null,
        },
      );

      const protectedClaim = claimQueuedThreadMessageGroup(
        db,
        noopNotifier,
        protectedQueuedMessage.id,
        { kind: "explicit-send" },
      )?.[0];

      const releasableClaim = claimQueuedThreadMessageGroup(
        db,
        noopNotifier,
        releasableQueuedMessage.id,
        { kind: "explicit-send" },
      )?.[0];

      if (!protectedClaim || !releasableClaim) {
        throw new Error("Expected queued message claims");
      }

      nowSpy.mockReturnValue(10_000);
      expect(
        releaseStaleQueuedMessageClaims(db, noopNotifier, {
          claimedBefore: 5_000,
          protectedClaimTokens: [protectedClaim.claimToken],
        }),
      ).toBe(1);

      expect(
        getQueuedThreadMessage(db, protectedQueuedMessage.id)?.claimToken,
      ).toBe(protectedClaim.claimToken);
      expect(
        getQueuedThreadMessage(db, releasableQueuedMessage.id)?.claimToken,
      ).toBeNull();
      expect(
        listQueuedThreadMessages(db, thread.id).map((row) => row.id),
      ).toEqual([releasableQueuedMessage.id]);
    } finally {
      nowSpy.mockRestore();
    }
  });

  it("claims the oldest queued message first", () => {
    const { db, thread } = setup();
    const nowSpy = vi.spyOn(Date, "now");

    try {
      nowSpy.mockReturnValueOnce(1_000);

      const firstQueuedMessage = createQueuedThreadMessage(db, noopNotifier, {
        threadId: thread.id,
        content: defaultInput,
        model: "gpt-5",
        reasoningLevel: "medium",
        permissionMode: "full",
        serviceTier: "default",
        waitingOn: { kind: "turn-starting" },
        sendAt: null,
        payload: { kind: "inline" },
        systemNotice: null,
      });

      nowSpy.mockReturnValueOnce(2_000);

      const secondQueuedMessage = createQueuedThreadMessage(db, noopNotifier, {
        threadId: thread.id,
        content: altInput,
        model: "gpt-5",
        reasoningLevel: "high",
        permissionMode: "full",
        serviceTier: "default",
        waitingOn: null,
        sendAt: null,
        payload: { kind: "inline" },
        systemNotice: null,
      });

      const claimedQueuedMessage = claimNextQueuedThreadMessageGroup(
        db,
        noopNotifier,
        thread.id,
        () => true,
      )?.[0];

      expect(claimedQueuedMessage?.id).toBe(firstQueuedMessage.id);
      expect(
        listQueuedThreadMessages(db, thread.id).map(
          (queuedMessage) => queuedMessage.id,
        ),
      ).toEqual([secondQueuedMessage.id]);
    } finally {
      nowSpy.mockRestore();
    }
  });

  it("persists the contiguous lead group boundary", () => {
    const { db, thread } = setup();

    const firstQueuedMessage = createQueuedThreadMessage(db, noopNotifier, {
      threadId: thread.id,
      content: defaultInput,
      model: "gpt-5",
      reasoningLevel: "medium",
      permissionMode: "full",
      serviceTier: "default",
      waitingOn: null,
      sendAt: null,
      payload: { kind: "inline" },
      systemNotice: null,
    });

    const secondQueuedMessage = createQueuedThreadMessage(db, noopNotifier, {
      threadId: thread.id,
      content: altInput,
      model: "gpt-5",
      reasoningLevel: "medium",
      permissionMode: "full",
      serviceTier: "default",
      waitingOn: null,
      sendAt: null,
      payload: { kind: "inline" },
      systemNotice: null,
    });

    const thirdQueuedMessage = createQueuedThreadMessage(db, noopNotifier, {
      threadId: thread.id,
      content: textInput("third"),
      model: "gpt-5",
      reasoningLevel: "medium",
      permissionMode: "full",
      serviceTier: "default",
      waitingOn: null,
      sendAt: null,
      payload: { kind: "inline" },
      systemNotice: null,
    });

    const result = setQueuedThreadMessageGroupBoundary({
      db,
      notifier: noopNotifier,
      threadId: thread.id,
      expectedGroupedPrefixQueuedMessageIds: [
        firstQueuedMessage.id,
        secondQueuedMessage.id,
      ],
      groupBoundaryQueuedMessageId: secondQueuedMessage.id,
    });

    expect(result.kind).toBe("updated");
    expect(
      listQueuedThreadMessages(db, thread.id).map((queuedMessage) => ({
        id: queuedMessage.id,
        groupWithNext: queuedMessage.groupWithNext,
      })),
    ).toEqual([
      { id: firstQueuedMessage.id, groupWithNext: true },
      { id: secondQueuedMessage.id, groupWithNext: false },
      { id: thirdQueuedMessage.id, groupWithNext: false },
    ]);
  });

  it("rejects a group boundary when the expected prefix is stale", () => {
    const { db, thread } = setup();

    const firstQueuedMessage = createQueuedThreadMessage(db, noopNotifier, {
      threadId: thread.id,
      content: defaultInput,
      model: "gpt-5",
      reasoningLevel: "medium",
      permissionMode: "full",
      serviceTier: "default",
      waitingOn: null,
      sendAt: null,
      payload: { kind: "inline" },
      systemNotice: null,
    });

    const secondQueuedMessage = createQueuedThreadMessage(db, noopNotifier, {
      threadId: thread.id,
      content: altInput,
      model: "gpt-5",
      reasoningLevel: "medium",
      permissionMode: "full",
      serviceTier: "default",
      waitingOn: null,
      sendAt: null,
      payload: { kind: "inline" },
      systemNotice: null,
    });

    const thirdQueuedMessage = createQueuedThreadMessage(db, noopNotifier, {
      threadId: thread.id,
      content: textInput("third"),
      model: "gpt-5",
      reasoningLevel: "medium",
      permissionMode: "full",
      serviceTier: "default",
      waitingOn: null,
      sendAt: null,
      payload: { kind: "inline" },
      systemNotice: null,
    });

    expect(
      reorderQueuedThreadMessage({
        db,
        notifier: noopNotifier,
        threadId: thread.id,
        queuedMessageId: thirdQueuedMessage.id,
        previousQueuedMessageId: firstQueuedMessage.id,
        nextQueuedMessageId: secondQueuedMessage.id,
      }).kind,
    ).toBe("reordered");

    const result = setQueuedThreadMessageGroupBoundary({
      db,
      notifier: noopNotifier,
      threadId: thread.id,
      expectedGroupedPrefixQueuedMessageIds: [
        firstQueuedMessage.id,
        secondQueuedMessage.id,
      ],
      groupBoundaryQueuedMessageId: secondQueuedMessage.id,
    });

    expect(result.kind).toBe("stale_neighbor");
    expect(
      listQueuedThreadMessages(db, thread.id).map((queuedMessage) => ({
        id: queuedMessage.id,
        groupWithNext: queuedMessage.groupWithNext,
      })),
    ).toEqual([
      { id: firstQueuedMessage.id, groupWithNext: false },
      { id: thirdQueuedMessage.id, groupWithNext: false },
      { id: secondQueuedMessage.id, groupWithNext: false },
    ]);
  });

  it("claims the contiguous lead group together", () => {
    const { db, thread } = setup();

    const firstQueuedMessage = createQueuedThreadMessage(db, noopNotifier, {
      threadId: thread.id,
      content: defaultInput,
      model: "gpt-5",
      reasoningLevel: "medium",
      permissionMode: "full",
      serviceTier: "default",
      waitingOn: null,
      sendAt: null,
      payload: { kind: "inline" },
      systemNotice: null,
    });

    const secondQueuedMessage = createQueuedThreadMessage(db, noopNotifier, {
      threadId: thread.id,
      content: altInput,
      model: "gpt-5",
      reasoningLevel: "medium",
      permissionMode: "full",
      serviceTier: "default",
      waitingOn: null,
      sendAt: null,
      payload: { kind: "inline" },
      systemNotice: null,
    });

    const thirdQueuedMessage = createQueuedThreadMessage(db, noopNotifier, {
      threadId: thread.id,
      content: textInput("third"),
      model: "gpt-5",
      reasoningLevel: "medium",
      permissionMode: "full",
      serviceTier: "default",
      waitingOn: null,
      sendAt: null,
      payload: { kind: "inline" },
      systemNotice: null,
    });

    setQueuedThreadMessageGroupBoundary({
      db,
      notifier: noopNotifier,
      threadId: thread.id,
      expectedGroupedPrefixQueuedMessageIds: [
        firstQueuedMessage.id,
        secondQueuedMessage.id,
      ],
      groupBoundaryQueuedMessageId: secondQueuedMessage.id,
    });

    const claimedQueuedMessages = claimNextQueuedThreadMessageGroup(
      db,
      noopNotifier,
      thread.id,
      () => true,
    );

    expect(
      claimedQueuedMessages?.map((queuedMessage) => queuedMessage.id),
    ).toEqual([firstQueuedMessage.id, secondQueuedMessage.id]);
    expect(
      listQueuedThreadMessages(db, thread.id).map(
        (queuedMessage) => queuedMessage.id,
      ),
    ).toEqual([thirdQueuedMessage.id]);
  });

  it("keeps script messages behind a manual-stop pause and apart from other sources", () => {
    const { db, project } = setup();

    const thread = createThread(db, noopNotifier, {
      projectId: project.id,
      providerId: "codex",
      status: "idle",
    });

    const first = createQueuedThreadMessage(db, noopNotifier, {
      threadId: thread.id,
      content: defaultInput,
      model: "gpt-5",
      reasoningLevel: "medium",
      permissionMode: "full",
      serviceTier: "default",
      waitingOn: { kind: "thread-busy" },
      sendAt: null,
      payload: { kind: "inline" },
      systemNotice: {
        kind: "external-message",
        subject: {
          kind: "message-source",
          source: { kind: "script", label: "Runner" },
        },
      },
    });

    const second = queueTurnEndMessage(db, thread.id, altInput);
    expect(
      setQueuedThreadMessageGroupBoundary({
        db,
        notifier: noopNotifier,
        threadId: thread.id,
        expectedGroupedPrefixQueuedMessageIds: [first.id, second.id],
        groupBoundaryQueuedMessageId: second.id,
      }).kind,
    ).toBe("invalid_sender");
    insertEvents(db, noopNotifier, [
      {
        threadId: thread.id,
        sequence: 1,
        type: "system/thread/interrupted",
        scope: threadScope(),
        itemId: null,
        itemKind: null,
        parentToolCallId: null,
        data: JSON.stringify({ reason: "manual-stop" }),
      },
    ]);
    expect(
      listIdleThreadsWithQueuedMessages(db).map((row) => row.threadId),
    ).not.toContain(thread.id);
    expect(
      claimQueuedThreadMessageGroup(db, noopNotifier, first.id, {
        kind: "automatic",
        isGroupEligible: () => true,
        retryingFailure: false,
      }),
    ).toBeNull();
  });

  it.each(["inline", "continuation"] as const)(
    "pauses ordinary turn-end rows without pausing %s system notices",
    (noticePayloadKind) => {
      const { db, project } = setup();

      const thread = createThread(db, noopNotifier, {
        projectId: project.id,
        providerId: "codex",
        status: "idle",
      });

      const ordinary = createQueuedThreadMessage(db, noopNotifier, {
        threadId: thread.id,
        content: defaultInput,
        model: "gpt-5",
        reasoningLevel: "medium",
        permissionMode: "full",
        serviceTier: "default",
        waitingOn: { kind: "thread-busy" },
        sendAt: null,
        payload: { kind: "inline" },
        systemNotice: null,
      });

      const notice = createQueuedThreadMessage(db, noopNotifier, {
        threadId: thread.id,
        content: altInput,
        model: "gpt-5",
        reasoningLevel: "medium",
        permissionMode: "full",
        serviceTier: "default",
        waitingOn: { kind: "thread-busy" },
        sendAt: null,
        payload: { kind: noticePayloadKind },
        systemNotice: {
          kind: "child-completed",
          subject: {
            kind: "thread",
            threadId: "thr_child",
            threadName: "Child",
          },
        },
      });

      insertEvents(db, noopNotifier, [
        {
          threadId: thread.id,
          sequence: 1,
          type: "system/thread/interrupted",
          scope: threadScope(),
          itemId: null,
          itemKind: null,
          parentToolCallId: null,
          data: JSON.stringify({ reason: "manual-stop" }),
        },
      ]);

      expect(
        listIdleThreadsWithQueuedMessages(db).map((row) => row.threadId),
      ).toContain(thread.id);
      expect(
        claimQueuedThreadMessageGroup(db, noopNotifier, ordinary.id, {
          kind: "automatic",
          isGroupEligible: () => true,
          retryingFailure: false,
        }),
      ).toBeNull();
      expect(
        claimNextQueuedThreadMessageGroup(
          db,
          noopNotifier,
          thread.id,
          () => true,
        )?.map((row) => row.id),
      ).toEqual([notice.id]);
      expect(
        listQueuedThreadMessages(db, thread.id).map((row) => row.id),
      ).toEqual([ordinary.id]);
    },
  );

  it("lets a row the user asked for during the stop out of the manual-stop pause", () => {
    const { db, project } = setup();

    const thread = createThread(db, noopNotifier, {
      projectId: project.id,
      providerId: "codex",
      status: "idle",
    });

    const heldBack = createQueuedThreadMessage(db, noopNotifier, {
      threadId: thread.id,
      content: defaultInput,
      model: "gpt-5",
      reasoningLevel: "medium",
      permissionMode: "full",
      serviceTier: "default",
      waitingOn: { kind: "thread-busy" },
      sendAt: null,
      payload: { kind: "inline" },
      systemNotice: null,
    });

    const askedForDuringStop = createQueuedThreadMessage(db, noopNotifier, {
      threadId: thread.id,
      content: altInput,
      model: "gpt-5",
      reasoningLevel: "medium",
      permissionMode: "full",
      serviceTier: "default",
      waitingOn: { kind: "stopping" },
      sendAt: null,
      payload: { kind: "inline" },
      systemNotice: null,
    });

    insertEvents(db, noopNotifier, [
      {
        threadId: thread.id,
        sequence: 1,
        type: "system/thread/interrupted",
        scope: threadScope(),
        itemId: null,
        itemKind: null,
        parentToolCallId: null,
        data: JSON.stringify({ reason: "manual-stop" }),
      },
    ]);

    expect(
      listIdleThreadsWithQueuedMessages(db).map((row) => row.threadId),
    ).toContain(thread.id);
    expect(
      claimQueuedThreadMessageGroup(db, noopNotifier, heldBack.id, {
        kind: "automatic",
        isGroupEligible: () => true,
        retryingFailure: false,
      }),
    ).toBeNull();
    expect(
      claimNextQueuedThreadMessageGroup(
        db,
        noopNotifier,
        thread.id,
        () => true,
      )?.map((row) => row.id),
    ).toEqual([askedForDuringStop.id]);
    expect(
      listQueuedThreadMessages(db, thread.id).map((row) => row.id),
    ).toEqual([heldBack.id]);
  });

  it("keeps a paused thread off the idle drain when every row is an ordinary turn-end wait", () => {
    const { db, project } = setup();

    const thread = createThread(db, noopNotifier, {
      projectId: project.id,
      providerId: "codex",
      status: "idle",
    });

    createQueuedThreadMessage(db, noopNotifier, {
      threadId: thread.id,
      content: defaultInput,
      model: "gpt-5",
      reasoningLevel: "medium",
      permissionMode: "full",
      serviceTier: "default",
      waitingOn: { kind: "thread-busy" },
      sendAt: null,
      payload: { kind: "inline" },
      systemNotice: null,
    });
    insertEvents(db, noopNotifier, [
      {
        threadId: thread.id,
        sequence: 1,
        type: "system/thread/interrupted",
        scope: threadScope(),
        itemId: null,
        itemKind: null,
        parentToolCallId: null,
        data: JSON.stringify({ reason: "manual-stop" }),
      },
    ]);

    expect(
      listIdleThreadsWithQueuedMessages(db).map((row) => row.threadId),
    ).not.toContain(thread.id);
  });

  it("does not split a requeued group: the tail waits with its blocked lead", () => {
    const { db, thread } = setup();

    const lead = createQueuedThreadMessage(db, noopNotifier, {
      threadId: thread.id,
      content: defaultInput,
      model: "gpt-5",
      reasoningLevel: "medium",
      permissionMode: "full",
      serviceTier: "default",
      waitingOn: null,
      sendAt: null,
      payload: { kind: "inline" },
      systemNotice: null,
    });

    const tail = createQueuedThreadMessage(db, noopNotifier, {
      threadId: thread.id,
      content: altInput,
      model: "gpt-5",
      reasoningLevel: "medium",
      permissionMode: "full",
      serviceTier: "default",
      waitingOn: null,
      sendAt: null,
      payload: { kind: "inline" },
      systemNotice: null,
    });

    setQueuedThreadMessageGroupBoundary({
      db,
      notifier: noopNotifier,
      threadId: thread.id,
      expectedGroupedPrefixQueuedMessageIds: [lead.id, tail.id],
      groupBoundaryQueuedMessageId: tail.id,
    });

    const claimed = claimNextQueuedThreadMessageGroup(
      db,
      noopNotifier,
      thread.id,
      () => true,
    );

    expect(claimed?.map((queuedMessage) => queuedMessage.id)).toEqual([
      lead.id,
      tail.id,
    ]);
    requeueClaimedQueuedThreadMessages(db, noopNotifier, {
      claims: claimed!.map(({ id, claimToken }) => ({ id, claimToken })),
      threadId: thread.id,
      waitingOn: { kind: "plugin", pluginId: "limits", reason: "At capacity" },
      sendAt: null,
    });

    expect(
      claimNextQueuedThreadMessageGroup(
        db,
        noopNotifier,
        thread.id,
        () => true,
      ),
    ).toBeNull();

    const independent = createQueuedThreadMessage(db, noopNotifier, {
      threadId: thread.id,
      content: textInput("independent"),
      model: "gpt-5",
      reasoningLevel: "medium",
      permissionMode: "full",
      serviceTier: "default",
      waitingOn: null,
      sendAt: null,
      payload: { kind: "inline" },
      systemNotice: null,
    });

    expect(
      claimNextQueuedThreadMessageGroup(
        db,
        noopNotifier,
        thread.id,
        () => true,
      )?.map((queuedMessage) => queuedMessage.id),
    ).toEqual([independent.id]);
  });

  it("claiming a cleared lead takes its still-grouped tail with it", () => {
    const { db, thread } = setup();

    const lead = createQueuedThreadMessage(db, noopNotifier, {
      threadId: thread.id,
      content: defaultInput,
      model: "gpt-5",
      reasoningLevel: "medium",
      permissionMode: "full",
      serviceTier: "default",
      waitingOn: null,
      sendAt: null,
      payload: { kind: "inline" },
      systemNotice: null,
    });

    const tail = createQueuedThreadMessage(db, noopNotifier, {
      threadId: thread.id,
      content: altInput,
      model: "gpt-5",
      reasoningLevel: "medium",
      permissionMode: "full",
      serviceTier: "default",
      waitingOn: null,
      sendAt: null,
      payload: { kind: "inline" },
      systemNotice: null,
    });

    setQueuedThreadMessageGroupBoundary({
      db,
      notifier: noopNotifier,
      threadId: thread.id,
      expectedGroupedPrefixQueuedMessageIds: [lead.id, tail.id],
      groupBoundaryQueuedMessageId: tail.id,
    });

    const claimed = claimNextQueuedThreadMessageGroup(
      db,
      noopNotifier,
      thread.id,
      () => true,
    );

    requeueClaimedQueuedThreadMessages(db, noopNotifier, {
      claims: claimed!.map(({ id, claimToken }) => ({ id, claimToken })),
      threadId: thread.id,
      waitingOn: { kind: "plugin", pluginId: "limits", reason: "At capacity" },
      sendAt: null,
    });
    clearQueuedThreadMessageWaitingOn(db, noopNotifier, {
      id: lead.id,
      threadId: thread.id,
    });

    expect(
      claimQueuedThreadMessageGroup(db, noopNotifier, lead.id, {
        kind: "explicit-send",
      })?.map((queuedMessage) => queuedMessage.id),
    ).toEqual([lead.id, tail.id]);
  });

  it("claims only the selected message when sending outside the lead group", () => {
    const { db, thread } = setup();

    const firstQueuedMessage = createQueuedThreadMessage(db, noopNotifier, {
      threadId: thread.id,
      content: defaultInput,
      model: "gpt-5",
      reasoningLevel: "medium",
      permissionMode: "full",
      serviceTier: "default",
      waitingOn: null,
      sendAt: null,
      payload: { kind: "inline" },
      systemNotice: null,
    });

    const secondQueuedMessage = createQueuedThreadMessage(db, noopNotifier, {
      threadId: thread.id,
      content: altInput,
      model: "gpt-5",
      reasoningLevel: "medium",
      permissionMode: "full",
      serviceTier: "default",
      waitingOn: null,
      sendAt: null,
      payload: { kind: "inline" },
      systemNotice: null,
    });

    const thirdQueuedMessage = createQueuedThreadMessage(db, noopNotifier, {
      threadId: thread.id,
      content: textInput("third"),
      model: "gpt-5",
      reasoningLevel: "medium",
      permissionMode: "full",
      serviceTier: "default",
      waitingOn: null,
      sendAt: null,
      payload: { kind: "inline" },
      systemNotice: null,
    });

    setQueuedThreadMessageGroupBoundary({
      db,
      notifier: noopNotifier,
      threadId: thread.id,
      expectedGroupedPrefixQueuedMessageIds: [
        firstQueuedMessage.id,
        secondQueuedMessage.id,
      ],
      groupBoundaryQueuedMessageId: secondQueuedMessage.id,
    });

    const claimedQueuedMessages = claimQueuedThreadMessageGroup(
      db,
      noopNotifier,
      thirdQueuedMessage.id,
      { kind: "explicit-send" },
    );

    expect(
      claimedQueuedMessages?.map((queuedMessage) => queuedMessage.id),
    ).toEqual([thirdQueuedMessage.id]);
    expect(
      listQueuedThreadMessages(db, thread.id).map(
        (queuedMessage) => queuedMessage.id,
      ),
    ).toEqual([firstQueuedMessage.id, secondQueuedMessage.id]);
  });

  it("clears the previous group edge when deleting a grouped follower", () => {
    const { db, thread } = setup();

    const firstQueuedMessage = createQueuedThreadMessage(db, noopNotifier, {
      threadId: thread.id,
      content: defaultInput,
      model: "gpt-5",
      reasoningLevel: "medium",
      permissionMode: "full",
      serviceTier: "default",
      waitingOn: null,
      sendAt: null,
      payload: { kind: "inline" },
      systemNotice: null,
    });

    const secondQueuedMessage = createQueuedThreadMessage(db, noopNotifier, {
      threadId: thread.id,
      content: altInput,
      model: "gpt-5",
      reasoningLevel: "medium",
      permissionMode: "full",
      serviceTier: "default",
      waitingOn: null,
      sendAt: null,
      payload: { kind: "inline" },
      systemNotice: null,
    });

    const thirdQueuedMessage = createQueuedThreadMessage(db, noopNotifier, {
      threadId: thread.id,
      content: textInput("third"),
      model: "gpt-5",
      reasoningLevel: "medium",
      permissionMode: "full",
      serviceTier: "default",
      waitingOn: null,
      sendAt: null,
      payload: { kind: "inline" },
      systemNotice: null,
    });

    setQueuedThreadMessageGroupBoundary({
      db,
      notifier: noopNotifier,
      threadId: thread.id,
      expectedGroupedPrefixQueuedMessageIds: [
        firstQueuedMessage.id,
        secondQueuedMessage.id,
      ],
      groupBoundaryQueuedMessageId: secondQueuedMessage.id,
    });

    const deleted = deleteQueuedThreadMessage(
      db,
      noopNotifier,
      secondQueuedMessage.id,
    );

    expect(deleted?.previousGroupedQueuedMessageId).toBe(firstQueuedMessage.id);

    expect(
      listQueuedThreadMessages(db, thread.id).map((queuedMessage) => ({
        id: queuedMessage.id,
        groupWithNext: queuedMessage.groupWithNext,
      })),
    ).toEqual([
      { id: firstQueuedMessage.id, groupWithNext: false },
      { id: thirdQueuedMessage.id, groupWithNext: false },
    ]);
    expect(
      claimNextQueuedThreadMessageGroup(
        db,
        noopNotifier,
        thread.id,
        () => true,
      )?.map((queuedMessage) => queuedMessage.id),
    ).toEqual([firstQueuedMessage.id]);
  });

  it("restores a deleted grouped message into its group", () => {
    const { db, thread } = setup();
    const first = queueTurnEndMessage(db, thread.id, defaultInput);
    const second = queueTurnEndMessage(db, thread.id, altInput);
    const third = queueTurnEndMessage(db, thread.id, textInput("third"));
    const fourth = queueTurnEndMessage(db, thread.id, textInput("fourth"));

    setQueuedThreadMessageGroupBoundary({
      db,
      notifier: noopNotifier,
      threadId: thread.id,
      expectedGroupedPrefixQueuedMessageIds: [first.id, second.id, third.id],
      groupBoundaryQueuedMessageId: third.id,
    });

    const deleted = deleteQueuedThreadMessage(db, noopNotifier, second.id);

    if (deleted === null) throw new Error("expected a deletion");
    restoreDeletedQueuedThreadMessage(db, noopNotifier, deleted);

    expect(
      listQueuedThreadMessages(db, thread.id).map((row) => ({
        id: row.id,
        groupWithNext: row.groupWithNext,
      })),
    ).toEqual([
      { id: first.id, groupWithNext: true },
      { id: second.id, groupWithNext: true },
      { id: third.id, groupWithNext: false },
      { id: fourth.id, groupWithNext: false },
    ]);
  });

  it("clears the previous group edge when claiming a grouped follower", () => {
    const { db, thread } = setup();

    const firstQueuedMessage = createQueuedThreadMessage(db, noopNotifier, {
      threadId: thread.id,
      content: defaultInput,
      model: "gpt-5",
      reasoningLevel: "medium",
      permissionMode: "full",
      serviceTier: "default",
      waitingOn: null,
      sendAt: null,
      payload: { kind: "inline" },
      systemNotice: null,
    });

    const secondQueuedMessage = createQueuedThreadMessage(db, noopNotifier, {
      threadId: thread.id,
      content: altInput,
      model: "gpt-5",
      reasoningLevel: "high",
      permissionMode: "full",
      serviceTier: "default",
      waitingOn: null,
      sendAt: null,
      payload: { kind: "inline" },
      systemNotice: null,
    });

    const thirdQueuedMessage = createQueuedThreadMessage(db, noopNotifier, {
      threadId: thread.id,
      content: textInput("third"),
      model: "gpt-5",
      reasoningLevel: "medium",
      permissionMode: "full",
      serviceTier: "default",
      waitingOn: null,
      sendAt: null,
      payload: { kind: "inline" },
      systemNotice: null,
    });

    setQueuedThreadMessageGroupBoundary({
      db,
      notifier: noopNotifier,
      threadId: thread.id,
      expectedGroupedPrefixQueuedMessageIds: [
        firstQueuedMessage.id,
        secondQueuedMessage.id,
      ],
      groupBoundaryQueuedMessageId: secondQueuedMessage.id,
    });

    expect(
      claimQueuedThreadMessageGroup(db, noopNotifier, secondQueuedMessage.id, {
        kind: "explicit-send",
      })?.map((queuedMessage) => queuedMessage.id),
    ).toEqual([secondQueuedMessage.id]);

    expect(
      listQueuedThreadMessages(db, thread.id).map((queuedMessage) => ({
        id: queuedMessage.id,
        groupWithNext: queuedMessage.groupWithNext,
      })),
    ).toEqual([
      { id: firstQueuedMessage.id, groupWithNext: false },
      { id: thirdQueuedMessage.id, groupWithNext: false },
    ]);
  });

  it("clears the claimed follower group edge when releasing a failed direct send", () => {
    const { db, thread } = setup();

    const firstQueuedMessage = createQueuedThreadMessage(db, noopNotifier, {
      threadId: thread.id,
      content: defaultInput,
      model: "gpt-5",
      reasoningLevel: "medium",
      permissionMode: "full",
      serviceTier: "default",
      waitingOn: null,
      sendAt: null,
      payload: { kind: "inline" },
      systemNotice: null,
    });

    const secondQueuedMessage = createQueuedThreadMessage(db, noopNotifier, {
      threadId: thread.id,
      content: altInput,
      model: "gpt-5",
      reasoningLevel: "medium",
      permissionMode: "full",
      serviceTier: "default",
      waitingOn: null,
      sendAt: null,
      payload: { kind: "inline" },
      systemNotice: null,
    });

    const thirdQueuedMessage = createQueuedThreadMessage(db, noopNotifier, {
      threadId: thread.id,
      content: textInput("third"),
      model: "gpt-5",
      reasoningLevel: "medium",
      permissionMode: "full",
      serviceTier: "default",
      waitingOn: null,
      sendAt: null,
      payload: { kind: "inline" },
      systemNotice: null,
    });

    setQueuedThreadMessageGroupBoundary({
      db,
      notifier: noopNotifier,
      threadId: thread.id,
      expectedGroupedPrefixQueuedMessageIds: [
        firstQueuedMessage.id,
        secondQueuedMessage.id,
        thirdQueuedMessage.id,
      ],
      groupBoundaryQueuedMessageId: thirdQueuedMessage.id,
    });

    const claimed = claimQueuedThreadMessageGroup(
      db,
      noopNotifier,
      secondQueuedMessage.id,
      { kind: "explicit-send" },
    );

    expect(claimed?.map((queuedMessage) => queuedMessage.id)).toEqual([
      secondQueuedMessage.id,
    ]);
    expect(claimed?.[0]).toBeDefined();

    if (!claimed?.[0]) return;

    releaseQueuedMessageClaim(db, noopNotifier, {
      id: claimed[0].id,
      claimToken: claimed[0].claimToken,
    });

    expect(
      listQueuedThreadMessages(db, thread.id).map((queuedMessage) => ({
        id: queuedMessage.id,
        groupWithNext: queuedMessage.groupWithNext,
      })),
    ).toEqual([
      { id: firstQueuedMessage.id, groupWithNext: false },
      { id: secondQueuedMessage.id, groupWithNext: false },
      { id: thirdQueuedMessage.id, groupWithNext: false },
    ]);
  });

  it("rejects grouped prefixes that mix sender attribution", () => {
    const { db, thread } = setup();

    const firstQueuedMessage = createQueuedThreadMessage(db, noopNotifier, {
      threadId: thread.id,
      content: defaultInput,
      model: "gpt-5",
      reasoningLevel: "medium",
      permissionMode: "full",
      serviceTier: "default",
      waitingOn: null,
      sendAt: null,
      payload: { kind: "inline" },
      systemNotice: null,
    });

    const secondQueuedMessage = createQueuedThreadMessage(db, noopNotifier, {
      threadId: thread.id,
      content: altInput,
      senderThreadId: "thr_sender",
      model: "gpt-5",
      reasoningLevel: "high",
      permissionMode: "full",
      serviceTier: "default",
      waitingOn: null,
      sendAt: null,
      payload: { kind: "inline" },
      systemNotice: null,
    });

    const result = setQueuedThreadMessageGroupBoundary({
      db,
      notifier: noopNotifier,
      threadId: thread.id,
      expectedGroupedPrefixQueuedMessageIds: [
        firstQueuedMessage.id,
        secondQueuedMessage.id,
      ],
      groupBoundaryQueuedMessageId: secondQueuedMessage.id,
    });

    expect(result.kind).toBe("invalid_sender");
    expect(
      listQueuedThreadMessages(db, thread.id).map((queuedMessage) => ({
        id: queuedMessage.id,
        groupWithNext: queuedMessage.groupWithNext,
      })),
    ).toEqual([
      { id: firstQueuedMessage.id, groupWithNext: false },
      { id: secondQueuedMessage.id, groupWithNext: false },
    ]);
  });

  it("rejects grouped prefixes that mix execution options", () => {
    const { db, thread } = setup();

    const firstQueuedMessage = createQueuedThreadMessage(db, noopNotifier, {
      threadId: thread.id,
      content: defaultInput,
      model: "gpt-5",
      reasoningLevel: "medium",
      permissionMode: "full",
      serviceTier: "default",
      waitingOn: null,
      sendAt: null,
      payload: { kind: "inline" },
      systemNotice: null,
    });

    const secondQueuedMessage = createQueuedThreadMessage(db, noopNotifier, {
      threadId: thread.id,
      content: altInput,
      model: "gpt-5.5",
      reasoningLevel: "medium",
      permissionMode: "full",
      serviceTier: "default",
      waitingOn: null,
      sendAt: null,
      payload: { kind: "inline" },
      systemNotice: null,
    });

    const result = setQueuedThreadMessageGroupBoundary({
      db,
      notifier: noopNotifier,
      threadId: thread.id,
      expectedGroupedPrefixQueuedMessageIds: [
        firstQueuedMessage.id,
        secondQueuedMessage.id,
      ],
      groupBoundaryQueuedMessageId: secondQueuedMessage.id,
    });

    expect(result.kind).toBe("invalid_execution_options");
    expect(
      listQueuedThreadMessages(db, thread.id).map((queuedMessage) => ({
        id: queuedMessage.id,
        groupWithNext: queuedMessage.groupWithNext,
      })),
    ).toEqual([
      { id: firstQueuedMessage.id, groupWithNext: false },
      { id: secondQueuedMessage.id, groupWithNext: false },
    ]);
  });

  it("does not consume any grouped claim when batch deletion is stale", () => {
    const { db, thread } = setup();

    const firstQueuedMessage = createQueuedThreadMessage(db, noopNotifier, {
      threadId: thread.id,
      content: defaultInput,
      model: "gpt-5",
      reasoningLevel: "medium",
      permissionMode: "full",
      serviceTier: "default",
      waitingOn: null,
      sendAt: null,
      payload: { kind: "inline" },
      systemNotice: null,
    });

    const secondQueuedMessage = createQueuedThreadMessage(db, noopNotifier, {
      threadId: thread.id,
      content: altInput,
      model: "gpt-5",
      reasoningLevel: "medium",
      permissionMode: "full",
      serviceTier: "default",
      waitingOn: null,
      sendAt: null,
      payload: { kind: "inline" },
      systemNotice: null,
    });

    setQueuedThreadMessageGroupBoundary({
      db,
      notifier: noopNotifier,
      threadId: thread.id,
      expectedGroupedPrefixQueuedMessageIds: [
        firstQueuedMessage.id,
        secondQueuedMessage.id,
      ],
      groupBoundaryQueuedMessageId: secondQueuedMessage.id,
    });

    const claimedQueuedMessages = claimNextQueuedThreadMessageGroup(
      db,
      noopNotifier,
      thread.id,
      () => true,
    );

    if (!claimedQueuedMessages) {
      throw new Error("Expected grouped claim");
    }

    const staleClaim = [
      claimedQueuedMessages[0]!,
      { ...claimedQueuedMessages[1]!, claimToken: "qclaim_stale" },
    ];

    expect(
      db.transaction((tx) =>
        deleteClaimedQueuedThreadMessageBatchInTransaction(tx, {
          queuedMessages: staleClaim,
        }),
      ),
    ).toBe(false);

    expect(getQueuedThreadMessage(db, firstQueuedMessage.id)?.claimToken).toBe(
      claimedQueuedMessages[0]!.claimToken,
    );
    expect(getQueuedThreadMessage(db, secondQueuedMessage.id)?.claimToken).toBe(
      claimedQueuedMessages[1]!.claimToken,
    );
  });

  it("reorders queued messages to the front, middle, and end", () => {
    const { db, thread } = setup();

    const firstQueuedMessage = createQueuedThreadMessage(db, noopNotifier, {
      threadId: thread.id,
      content: defaultInput,
      model: "gpt-5",
      reasoningLevel: "medium",
      permissionMode: "full",
      serviceTier: "default",
      waitingOn: null,
      sendAt: null,
      payload: { kind: "inline" },
      systemNotice: null,
    });

    const secondQueuedMessage = createQueuedThreadMessage(db, noopNotifier, {
      threadId: thread.id,
      content: altInput,
      model: "gpt-5",
      reasoningLevel: "high",
      permissionMode: "full",
      serviceTier: "default",
      waitingOn: null,
      sendAt: null,
      payload: { kind: "inline" },
      systemNotice: null,
    });

    const thirdQueuedMessage = createQueuedThreadMessage(db, noopNotifier, {
      threadId: thread.id,
      content: textInput("third"),
      model: "gpt-5",
      reasoningLevel: "medium",
      permissionMode: "full",
      serviceTier: "default",
      waitingOn: null,
      sendAt: null,
      payload: { kind: "inline" },
      systemNotice: null,
    });

    const moveToFront = reorderQueuedThreadMessage({
      db,
      notifier: noopNotifier,
      threadId: thread.id,
      queuedMessageId: thirdQueuedMessage.id,
      previousQueuedMessageId: null,
      nextQueuedMessageId: firstQueuedMessage.id,
    });

    expect(moveToFront.kind).toBe("reordered");
    expect(
      listQueuedThreadMessages(db, thread.id).map((row) => row.id),
    ).toEqual([
      thirdQueuedMessage.id,
      firstQueuedMessage.id,
      secondQueuedMessage.id,
    ]);

    const moveToMiddle = reorderQueuedThreadMessage({
      db,
      notifier: noopNotifier,
      threadId: thread.id,
      queuedMessageId: secondQueuedMessage.id,
      previousQueuedMessageId: thirdQueuedMessage.id,
      nextQueuedMessageId: firstQueuedMessage.id,
    });

    expect(moveToMiddle.kind).toBe("reordered");
    expect(
      listQueuedThreadMessages(db, thread.id).map((row) => row.id),
    ).toEqual([
      thirdQueuedMessage.id,
      secondQueuedMessage.id,
      firstQueuedMessage.id,
    ]);

    const moveToEnd = reorderQueuedThreadMessage({
      db,
      notifier: noopNotifier,
      threadId: thread.id,
      queuedMessageId: thirdQueuedMessage.id,
      previousQueuedMessageId: firstQueuedMessage.id,
      nextQueuedMessageId: null,
    });

    expect(moveToEnd.kind).toBe("reordered");
    expect(
      listQueuedThreadMessages(db, thread.id).map((row) => row.id),
    ).toEqual([
      secondQueuedMessage.id,
      firstQueuedMessage.id,
      thirdQueuedMessage.id,
    ]);
  });

  it("claims the reordered first queued message", () => {
    const { db, thread } = setup();

    const firstQueuedMessage = createQueuedThreadMessage(db, noopNotifier, {
      threadId: thread.id,
      content: defaultInput,
      model: "gpt-5",
      reasoningLevel: "medium",
      permissionMode: "full",
      serviceTier: "default",
      waitingOn: null,
      sendAt: null,
      payload: { kind: "inline" },
      systemNotice: null,
    });

    const secondQueuedMessage = createQueuedThreadMessage(db, noopNotifier, {
      threadId: thread.id,
      content: altInput,
      model: "gpt-5",
      reasoningLevel: "high",
      permissionMode: "full",
      serviceTier: "default",
      waitingOn: null,
      sendAt: null,
      payload: { kind: "inline" },
      systemNotice: null,
    });

    expect(
      reorderQueuedThreadMessage({
        db,
        notifier: noopNotifier,
        threadId: thread.id,
        queuedMessageId: secondQueuedMessage.id,
        previousQueuedMessageId: null,
        nextQueuedMessageId: firstQueuedMessage.id,
      }).kind,
    ).toBe("reordered");

    const claimedQueuedMessage = claimNextQueuedThreadMessageGroup(
      db,
      noopNotifier,
      thread.id,
      () => true,
    )?.[0];

    expect(claimedQueuedMessage?.id).toBe(secondQueuedMessage.id);
    expect(
      listQueuedThreadMessages(db, thread.id).map((row) => row.id),
    ).toEqual([firstQueuedMessage.id]);
  });

  it("rolls back a reorder when the requested group boundary is invalid", () => {
    const { db, thread } = setup();

    const firstQueuedMessage = createQueuedThreadMessage(db, noopNotifier, {
      threadId: thread.id,
      content: defaultInput,
      model: "gpt-5",
      reasoningLevel: "medium",
      permissionMode: "full",
      serviceTier: "default",
      waitingOn: null,
      sendAt: null,
      payload: { kind: "inline" },
      systemNotice: null,
    });

    const secondQueuedMessage = createQueuedThreadMessage(db, noopNotifier, {
      threadId: thread.id,
      content: altInput,
      senderThreadId: "thr_sender",
      model: "gpt-5",
      reasoningLevel: "medium",
      permissionMode: "full",
      serviceTier: "default",
      waitingOn: null,
      sendAt: null,
      payload: { kind: "inline" },
      systemNotice: null,
    });

    const thirdQueuedMessage = createQueuedThreadMessage(db, noopNotifier, {
      threadId: thread.id,
      content: textInput("third"),
      model: "gpt-5",
      reasoningLevel: "medium",
      permissionMode: "full",
      serviceTier: "default",
      waitingOn: null,
      sendAt: null,
      payload: { kind: "inline" },
      systemNotice: null,
    });

    expect(
      reorderQueuedThreadMessage({
        db,
        notifier: noopNotifier,
        threadId: thread.id,
        queuedMessageId: thirdQueuedMessage.id,
        previousQueuedMessageId: null,
        nextQueuedMessageId: firstQueuedMessage.id,
        groupBoundaryQueuedMessageId: secondQueuedMessage.id,
      }).kind,
    ).toBe("invalid_sender");

    expect(
      listQueuedThreadMessages(db, thread.id).map((queuedMessage) => ({
        id: queuedMessage.id,
        groupWithNext: queuedMessage.groupWithNext,
      })),
    ).toEqual([
      { id: firstQueuedMessage.id, groupWithNext: false },
      { id: secondQueuedMessage.id, groupWithNext: false },
      { id: thirdQueuedMessage.id, groupWithNext: false },
    ]);
  });

  it("clears grouping when reorder-only would regroup different messages", () => {
    const { db, thread } = setup();

    const firstQueuedMessage = createQueuedThreadMessage(db, noopNotifier, {
      threadId: thread.id,
      content: defaultInput,
      model: "gpt-5",
      reasoningLevel: "medium",
      permissionMode: "full",
      serviceTier: "default",
      waitingOn: null,
      sendAt: null,
      payload: { kind: "inline" },
      systemNotice: null,
    });

    const secondQueuedMessage = createQueuedThreadMessage(db, noopNotifier, {
      threadId: thread.id,
      content: altInput,
      model: "gpt-5",
      reasoningLevel: "medium",
      permissionMode: "full",
      serviceTier: "default",
      waitingOn: null,
      sendAt: null,
      payload: { kind: "inline" },
      systemNotice: null,
    });

    const thirdQueuedMessage = createQueuedThreadMessage(db, noopNotifier, {
      threadId: thread.id,
      content: textInput("third"),
      model: "gpt-5",
      reasoningLevel: "medium",
      permissionMode: "full",
      serviceTier: "default",
      waitingOn: null,
      sendAt: null,
      payload: { kind: "inline" },
      systemNotice: null,
    });

    setQueuedThreadMessageGroupBoundary({
      db,
      notifier: noopNotifier,
      threadId: thread.id,
      expectedGroupedPrefixQueuedMessageIds: [
        firstQueuedMessage.id,
        secondQueuedMessage.id,
      ],
      groupBoundaryQueuedMessageId: secondQueuedMessage.id,
    });

    expect(
      reorderQueuedThreadMessage({
        db,
        notifier: noopNotifier,
        threadId: thread.id,
        queuedMessageId: thirdQueuedMessage.id,
        previousQueuedMessageId: firstQueuedMessage.id,
        nextQueuedMessageId: secondQueuedMessage.id,
      }).kind,
    ).toBe("reordered");

    expect(
      listQueuedThreadMessages(db, thread.id).map((queuedMessage) => ({
        id: queuedMessage.id,
        groupWithNext: queuedMessage.groupWithNext,
      })),
    ).toEqual([
      { id: firstQueuedMessage.id, groupWithNext: false },
      { id: thirdQueuedMessage.id, groupWithNext: false },
      { id: secondQueuedMessage.id, groupWithNext: false },
    ]);
    expect(
      claimNextQueuedThreadMessageGroup(
        db,
        noopNotifier,
        thread.id,
        () => true,
      )?.map((queuedMessage) => queuedMessage.id),
    ).toEqual([firstQueuedMessage.id]);
  });

  it("rejects reordering claimed, missing, cross-thread, and inverted neighbors", () => {
    const { db, thread } = setup();

    const otherThread = createThread(db, noopNotifier, {
      projectId: thread.projectId,
      providerId: "codex",
    });

    const firstQueuedMessage = createQueuedThreadMessage(db, noopNotifier, {
      threadId: thread.id,
      content: defaultInput,
      model: "gpt-5",
      reasoningLevel: "medium",
      permissionMode: "full",
      serviceTier: "default",
      waitingOn: null,
      sendAt: null,
      payload: { kind: "inline" },
      systemNotice: null,
    });

    const secondQueuedMessage = createQueuedThreadMessage(db, noopNotifier, {
      threadId: thread.id,
      content: altInput,
      model: "gpt-5",
      reasoningLevel: "high",
      permissionMode: "full",
      serviceTier: "default",
      waitingOn: null,
      sendAt: null,
      payload: { kind: "inline" },
      systemNotice: null,
    });

    const thirdQueuedMessage = createQueuedThreadMessage(db, noopNotifier, {
      threadId: thread.id,
      content: textInput("third"),
      model: "gpt-5",
      reasoningLevel: "medium",
      permissionMode: "full",
      serviceTier: "default",
      waitingOn: null,
      sendAt: null,
      payload: { kind: "inline" },
      systemNotice: null,
    });

    const otherQueuedMessage = createQueuedThreadMessage(db, noopNotifier, {
      threadId: otherThread.id,
      content: defaultInput,
      model: "gpt-5",
      reasoningLevel: "medium",
      permissionMode: "full",
      serviceTier: "default",
      waitingOn: null,
      sendAt: null,
      payload: { kind: "inline" },
      systemNotice: null,
    });

    expect(
      reorderQueuedThreadMessage({
        db,
        notifier: noopNotifier,
        threadId: thread.id,
        queuedMessageId: "qmsg_missing",
        previousQueuedMessageId: null,
        nextQueuedMessageId: firstQueuedMessage.id,
      }).kind,
    ).toBe("not_found");
    expect(
      reorderQueuedThreadMessage({
        db,
        notifier: noopNotifier,
        threadId: thread.id,
        queuedMessageId: thirdQueuedMessage.id,
        previousQueuedMessageId: otherQueuedMessage.id,
        nextQueuedMessageId: null,
      }).kind,
    ).toBe("stale_neighbor");
    expect(
      reorderQueuedThreadMessage({
        db,
        notifier: noopNotifier,
        threadId: thread.id,
        queuedMessageId: firstQueuedMessage.id,
        previousQueuedMessageId: thirdQueuedMessage.id,
        nextQueuedMessageId: secondQueuedMessage.id,
      }).kind,
    ).toBe("invalid_neighbor_order");

    const claimedQueuedMessage = claimQueuedThreadMessageGroup(
      db,
      noopNotifier,
      secondQueuedMessage.id,
      { kind: "explicit-send" },
    )?.[0];

    if (!claimedQueuedMessage) {
      throw new Error("Expected queued message claim");
    }

    expect(
      reorderQueuedThreadMessage({
        db,
        notifier: noopNotifier,
        threadId: thread.id,
        queuedMessageId: secondQueuedMessage.id,
        previousQueuedMessageId: null,
        nextQueuedMessageId: firstQueuedMessage.id,
      }).kind,
    ).toBe("claimed");
    expect(
      reorderQueuedThreadMessage({
        db,
        notifier: noopNotifier,
        threadId: thread.id,
        queuedMessageId: thirdQueuedMessage.id,
        previousQueuedMessageId: null,
        nextQueuedMessageId: secondQueuedMessage.id,
      }).kind,
    ).toBe("stale_neighbor");
  });

  describe("edit holds", () => {
    it("keeps an edited row and the rows behind it from automatic dispatch until the save", () => {
      const { db, thread } = setup();
      const edited = queueTurnEndMessage(db, thread.id, textInput("ORIGINAL"));
      const behind = queueTurnEndMessage(db, thread.id, altInput);

      expect(
        holdQueuedThreadMessageForEdit(db, {
          heldUntil: Date.now() + 60_000,
          id: edited.id,
          threadId: thread.id,
        }),
      ).toEqual({ kind: "held" });

      expect(
        claimNextQueuedThreadMessageGroup(
          db,
          noopNotifier,
          thread.id,
          () => true,
        ),
      ).toBeNull();
      expect(
        claimQueuedThreadMessageGroup(db, noopNotifier, edited.id, {
          kind: "automatic",
          isGroupEligible: () => true,
          retryingFailure: false,
        }),
      ).toBeNull();
      expect(getQueuedThreadMessage(db, edited.id)?.updatedAt).toBe(
        edited.updatedAt,
      );

      const saved = updateQueuedThreadMessage(db, noopNotifier, {
        execution: null,
        content: textInput("SAVED EDIT"),
        expectedUpdatedAt: edited.updatedAt,
        id: edited.id,
        threadId: thread.id,
      });

      expect(saved).toMatchObject({ kind: "updated", releasedEditHold: true });

      const claimed = claimNextQueuedThreadMessageGroup(
        db,
        noopNotifier,
        thread.id,
        () => true,
      );

      expect(claimed?.map((row) => [row.id, row.content])).toEqual([
        [edited.id, JSON.stringify(textInput("SAVED EDIT"))],
      ]);
      expect(
        listQueuedThreadMessages(db, thread.id).map((row) => row.id),
      ).toEqual([behind.id]);
    });

    it("lets a row dispatch once its hold is released or lapses", () => {
      const { db, thread } = setup();
      const released = queueTurnEndMessage(db, thread.id, defaultInput);
      const lapsed = queueTurnEndMessage(db, thread.id, altInput);
      holdQueuedThreadMessageForEdit(db, {
        heldUntil: Date.now() + 60_000,
        id: released.id,
        threadId: thread.id,
      });
      holdQueuedThreadMessageForEdit(db, {
        heldUntil: Date.now() - 1,
        id: lapsed.id,
        threadId: thread.id,
      });

      expect(
        releaseQueuedThreadMessageEditHold(db, {
          id: released.id,
          threadId: thread.id,
        }),
      ).toBe(true);
      expect(
        releaseQueuedThreadMessageEditHold(db, {
          id: released.id,
          threadId: thread.id,
        }),
      ).toBe(false);

      const claimed = claimNextQueuedThreadMessageGroup(
        db,
        noopNotifier,
        thread.id,
        () => true,
      );

      expect(claimed?.map((row) => row.id)).toEqual([released.id]);

      if (!claimed) throw new Error("Expected the released row to be claimed");
      db.transaction((tx) =>
        deleteClaimedQueuedThreadMessageBatchInTransaction(tx, {
          queuedMessages: claimed,
        }),
      );
      expect(
        claimNextQueuedThreadMessageGroup(
          db,
          noopNotifier,
          thread.id,
          () => true,
        )?.map((row) => row.id),
      ).toEqual([lapsed.id]);
    });

    it("does not hold back idle-drain rows behind an edited row that waits on something else", () => {
      const { db, thread } = setup();

      const scheduled = queueTurnEndMessage(db, thread.id, defaultInput, {
        sendAt: Date.now() + 60_000,
        waitingOn: { kind: "time" },
      });

      const plain = queueTurnEndMessage(db, thread.id, altInput);
      holdQueuedThreadMessageForEdit(db, {
        heldUntil: Date.now() + 60_000,
        id: scheduled.id,
        threadId: thread.id,
      });

      expect(
        claimNextQueuedThreadMessageGroup(
          db,
          noopNotifier,
          thread.id,
          () => true,
        )?.map((row) => row.id),
      ).toEqual([plain.id]);
    });

    it("refuses to hold a row a dispatch already claimed or another thread owns", () => {
      const { db, project, thread } = setup();

      const otherThread = createThread(db, noopNotifier, {
        projectId: project.id,
        providerId: "codex",
      });

      const queued = queueTurnEndMessage(db, thread.id, defaultInput);

      expect(
        holdQueuedThreadMessageForEdit(db, {
          heldUntil: Date.now() + 60_000,
          id: queued.id,
          threadId: otherThread.id,
        }),
      ).toEqual({ kind: "not_found" });

      claimNextQueuedThreadMessageGroup(
        db,
        noopNotifier,
        thread.id,
        () => true,
      );
      expect(
        holdQueuedThreadMessageForEdit(db, {
          heldUntil: Date.now() + 60_000,
          id: queued.id,
          threadId: thread.id,
        }),
      ).toEqual({ kind: "claimed" });
    });
  });
});
