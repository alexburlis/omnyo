import {
  listQueuedThreadMessages,
  threadWaitConditions,
  threadWaits,
} from "@omnyo/db";
import { INBOX_CALLER_THREAD_HEADER } from "@omnyo/domain";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { runQueuedMessageDispatch } from "../../src/services/threads/queued-message-dispatch.js";
import { withTestHarness } from "../helpers/test-app.js";
import {
  agentRequest,
  endTurn,
  ownerSend,
  pendingSubmitCount,
  seedChat,
  seedInboxWorld,
  startSubmittedTurn,
  type InboxWorld,
} from "./inbox-driver.js";

async function settle(world: InboxWorld, threadId: string): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
  await runQueuedMessageDispatch(world.harness.deps, {
    kind: "thread-ready",
    threadId,
  });
  await new Promise((resolve) => setImmediate(resolve));
}

describe("a waited-on sub-chat reports through its condition", () => {
  it("stores the sub-chat's completion as the result and resumes the parent once, with no child notice", async () => {
    await withTestHarness(async (harness) => {
      const world = seedInboxWorld(harness, "host-child-result");
      const parent = seedChat(world);
      const child = seedChat(world, { parentThreadId: parent.id });
      await ownerSend(world, parent.id, "Delegate the audit and wait for it");
      const parentTurn = await startSubmittedTurn(world, parent.id);

      const told = await world.harness.app.request(
        `/api/v1/threads/${child.id}/send`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            [INBOX_CALLER_THREAD_HEADER]: parent.id,
          },
          body: JSON.stringify({
            input: [{ type: "text", text: "Audit the schema", mentions: [] }],
            mode: "auto",
            senderThreadId: parent.id,
          }),
        },
      );

      expect(told.status).toBe(200);
      const childTurn = await startSubmittedTurn(world, child.id);

      const registered = await agentRequest(
        world,
        parent.id,
        `/threads/${parent.id}/waits`,
        {
          key: "audit",
          for: "the schema audit",
          chats: [child.id],
        },
      );

      expect(registered.status).toBe(200);
      await endTurn(world, parentTurn, "completed");
      expect(pendingSubmitCount(world, parent.id)).toBe(0);

      await endTurn(world, childTurn, "completed");
      await settle(world, parent.id);

      const wait = harness.db
        .select()
        .from(threadWaits)
        .where(eq(threadWaits.threadId, parent.id))
        .get();

      expect(wait?.status).toBe("dispatched");
      expect(
        harness.db
          .select()
          .from(threadWaitConditions)
          .where(eq(threadWaitConditions.waitId, wait?.id ?? ""))
          .get(),
      ).toMatchObject({
        state: "met",
        result: "Finished without a closing message.",
      });
      expect(pendingSubmitCount(world, parent.id)).toBe(1);

      await new Promise((resolve) => setTimeout(resolve, 2_300));
      await settle(world, parent.id);
      expect(pendingSubmitCount(world, parent.id)).toBe(1);
      expect(
        listQueuedThreadMessages(harness.db, parent.id).filter((row) =>
          String(row.systemNotice ?? "").includes("child-"),
        ),
      ).toEqual([]);
    });
  });
});
