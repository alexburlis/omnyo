import {
  archiveThread,
  claimQueuedThreadMessageGroup,
  createQueuedThreadMessage,
  deleteThread,
  getQueuedThreadMessage,
  listQueuedThreadMessages,
} from "@omnyo/db";
import type { ResolvedThreadExecutionOptions } from "@omnyo/domain";
import { describe, expect, it, vi } from "vitest";
import { postCoalescedSystemNotice } from "../../src/services/threads/coalesced-system-notices.js";
import { recordQueuedMessageWait } from "../../src/services/threads/queue-waits.js";
import { seedThreadFixture } from "../helpers/seed.js";
import { textInput } from "../helpers/prompt-input.js";
import { withTestHarness, type TestAppHarness } from "../helpers/test-app.js";

const execution: ResolvedThreadExecutionOptions = {
  model: "gpt-5",
  permissionMode: "full",
  reasoningLevel: "medium",
  serviceTier: "default",
  source: "client/turn/requested",
};

function retireThread(
  harness: TestAppHarness,
  threadId: string,
  reason: "archived" | "deleted" | "missing",
): void {
  if (reason === "archived") archiveThread(harness.db, harness.hub, threadId);
  else if (reason === "deleted")
    harness.db.$client
      .prepare("UPDATE threads SET deleted_at = ? WHERE id = ?")
      .run(Date.now(), threadId);
  else deleteThread(harness.db, harness.hub, threadId);
}

describe("delayed queue lifecycle admission", () => {
  it.each(["archived", "deleted", "missing"] as const)(
    "rejects a delayed wait after its thread becomes %s",
    async (reason) => {
      await withTestHarness(async (harness) => {
        const { thread } = seedThreadFixture(harness);

        retireThread(harness, thread.id, reason);
        const notifyThread = vi.spyOn(harness.hub, "notifyThread");
        expect(() =>
          recordQueuedMessageWait(
            { db: harness.db, hub: harness.hub },
            {
              thread,
              message: {
                input: textInput("delayed input"),
                execution,
                senderThreadId: null,
                origin: null,
                originPluginId: null,
                requestedBy: null,
                payload: { kind: "inline" },
                systemNotice: null,
                deliveryMode: "queue",
              },
              waitingOn: { kind: "time" },
              sendAt: Date.now() + 60_000,
              claimed: null,
            },
          ),
        ).toThrow(
          expect.objectContaining({
            status: 409,
            body: expect.objectContaining({ code: "thread_not_writable" }),
          }),
        );
        expect(listQueuedThreadMessages(harness.db, thread.id)).toEqual([]);
        expect(notifyThread).not.toHaveBeenCalled();
      });
    },
  );

  it.each(["archived", "deleted", "missing"] as const)(
    "does not requeue a claim after its thread becomes %s",
    async (reason) => {
      await withTestHarness(async (harness) => {
        const { thread } = seedThreadFixture(harness);
        const input = textInput("claimed input");

        const row = createQueuedThreadMessage(harness.db, harness.hub, {
          threadId: thread.id,
          content: input,
          ...execution,
          waitingOn: null,
          sendAt: null,
          payload: { kind: "inline" },
          systemNotice: null,
        });

        const claimed = claimQueuedThreadMessageGroup(
          harness.db,
          harness.hub,
          row.id,
          { kind: "explicit-send" },
        );

        if (claimed === null) throw new Error("Expected a claimed queue row");
        retireThread(harness, thread.id, reason);
        const before = getQueuedThreadMessage(harness.db, row.id);
        const notifyThread = vi.spyOn(harness.hub, "notifyThread");
        expect(() =>
          recordQueuedMessageWait(harness.deps, {
            thread,
            claimed,
            waitingOn: { kind: "time" },
            sendAt: Date.now() + 60_000,
            message: {
              input,
              execution,
              senderThreadId: null,
              origin: null,
              originPluginId: null,
              requestedBy: null,
              payload: { kind: "inline" },
              systemNotice: null,
              deliveryMode: "queue",
            },
          }),
        ).toThrow(
          expect.objectContaining({
            status: 409,
            body: expect.objectContaining({ code: "thread_not_writable" }),
          }),
        );
        expect(getQueuedThreadMessage(harness.db, row.id)).toEqual(before);
        expect(notifyThread).not.toHaveBeenCalled();
      });
    },
  );

  it.each(["archived", "deleted", "missing"] as const)(
    "quietly skips new and coalesced notices after a thread becomes %s",
    async (reason) => {
      await withTestHarness(async (harness) => {
        const { thread } = seedThreadFixture(harness);

        const merge = vi.fn(() => ({
          input: textInput("notice"),
          notice: { kind: "child-completed" as const, subject: null },
          state: 1,
        }));

        const args = {
          threadId: thread.id,
          coalesceKey: "child-outcomes",
          windowMs: 60_000,
          execution,
          merge,
          parseState: Number,
        };

        const original = postCoalescedSystemNotice(harness.deps, args);
        expect(original).not.toBeNull();

        retireThread(harness, thread.id, reason);
        merge.mockClear();

        const before =
          original === null
            ? null
            : getQueuedThreadMessage(harness.db, original.id);

        const notifyThread = vi.spyOn(harness.hub, "notifyThread");
        expect(postCoalescedSystemNotice(harness.deps, args)).toBeNull();
        expect(
          postCoalescedSystemNotice(harness.deps, {
            ...args,
            coalesceKey: "new-notice",
          }),
        ).toBeNull();
        expect(
          original === null
            ? null
            : getQueuedThreadMessage(harness.db, original.id),
        ).toEqual(before);
        expect(merge).not.toHaveBeenCalled();
        expect(notifyThread).not.toHaveBeenCalled();
      });
    },
  );
});
