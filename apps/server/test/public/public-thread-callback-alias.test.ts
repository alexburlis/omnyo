import {
  threadCallbacks,
  threadTurnMarks,
  threadWaitConditions,
  threadWaits,
} from "@omnyo/db";
import {
  INBOX_CALLER_THREAD_HEADER,
  type Thread,
  type ThreadAttentionSnapshot,
  type ThreadCallback,
} from "@omnyo/domain";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { runInboxSweep } from "../../src/services/inbox/sweep.js";
import { runQueuedMessageDispatch } from "../../src/services/threads/queued-message-dispatch.js";
import { withTestHarness } from "../helpers/test-app.js";
import {
  endTurn,
  ownerRequest,
  ownerSend,
  pendingSubmitCount,
  seedChat,
  seedInboxWorld,
  startSubmittedTurn,
  type InboxWorld,
} from "../inbox/inbox-driver.js";

async function callbackWait(
  world: InboxWorld,
  waiter: Thread,
  source: Thread,
): Promise<Response> {
  return world.harness.app.request(`/api/v1/threads/${waiter.id}/attention`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      [INBOX_CALLER_THREAD_HEADER]: waiter.id,
    },
    body: JSON.stringify({
      action: "wait",
      sourceThreadId: source.id,
      reason: "the migration report",
    }),
  });
}

async function tell(
  world: InboxWorld,
  source: Thread,
  target: Thread,
  text: string,
): Promise<Response> {
  return world.harness.app.request(`/api/v1/threads/${target.id}/send`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      [INBOX_CALLER_THREAD_HEADER]: source.id,
    },
    body: JSON.stringify({
      input: [{ type: "text", text, mentions: [] }],
      mode: "auto",
      senderThreadId: source.id,
    }),
  });
}

function waitsOf(world: InboxWorld, thread: Thread) {
  return world.harness.db
    .select()
    .from(threadWaits)
    .where(eq(threadWaits.threadId, thread.id))
    .all();
}

async function attentionOf(
  world: InboxWorld,
  thread: Thread,
): Promise<ThreadAttentionSnapshot> {
  const response = await world.harness.app.request(
    `/api/v1/threads/${thread.id}/attention`,
  );

  expect(response.status).toBe(200);

  return (await response.json()) as ThreadAttentionSnapshot;
}

function recordAttentionChanges(world: InboxWorld, thread: Thread) {
  const seen: ThreadCallback[][] = [];
  world.harness.deps.hub.onThreadChanged((id, changes, metadata) => {
    if (id === thread.id && changes.includes("interactions-changed"))
      seen.push(metadata?.attentionItems?.callbacks ?? []);
  });

  return seen;
}

function insertLegacyCallback(
  world: InboxWorld,
  waiter: Thread,
  source: Thread,
  marker: string,
): void {
  world.harness.db
    .insert(threadCallbacks)
    .values({
      threadId: waiter.id,
      id: "legacy-1",
      sourceThreadId: source.id,
      sourceTitle: "Source",
      reason: "the legacy result",
      createdAt: Date.now(),
      afterSeq: 0,
      matchText: marker,
    })
    .run();
}

describe("omnyo callback wait as an alias of omnyo wait --chat", () => {
  it("registers a continuation, stores the source's marked reply, and resumes the waiter once", async () => {
    await withTestHarness(async (harness) => {
      const world = seedInboxWorld(harness, "host-callback-alias");
      const waiter = seedChat(world);
      const source = seedChat(world);
      await ownerSend(world, source.id, "Write the report");
      const sourceTurn = await startSubmittedTurn(world, source.id);
      await ownerSend(world, waiter.id, "Wait for the report");
      const waiterTurn = await startSubmittedTurn(world, waiter.id);

      const registered = await callbackWait(world, waiter, source);
      expect(registered.status).toBe(200);

      const { callbackMarker } = (await registered.json()) as {
        callbackMarker: string;
      };

      expect(callbackMarker).toMatch(/^\[omnyo wait [0-9a-f-]{36}\]$/);
      expect(waitsOf(world, waiter)).toHaveLength(1);
      expect(harness.db.select().from(threadCallbacks).all()).toEqual([]);
      await endTurn(world, waiterTurn, "completed");

      const delivered = await tell(
        world,
        source,
        waiter,
        `${callbackMarker} done: 12 tables`,
      );

      expect(await delivered.json()).toMatchObject({
        delivery: "stored",
        late: false,
      });
      await endTurn(world, sourceTurn, "completed");
      await new Promise((resolve) => setImmediate(resolve));
      await runQueuedMessageDispatch(harness.deps, {
        kind: "thread-ready",
        threadId: waiter.id,
      });

      expect(pendingSubmitCount(world, waiter.id)).toBe(1);
      expect(waitsOf(world, waiter)[0]?.status).toBe("dispatched");
      const resume = await startSubmittedTurn(world, waiter.id);
      expect(
        harness.db
          .select()
          .from(threadTurnMarks)
          .where(eq(threadTurnMarks.threadId, waiter.id))
          .all()
          .find((mark) => mark.turnId === resume.turnId)?.waitId,
      ).toBe(waitsOf(world, waiter)[0]?.id);
      await endTurn(world, resume, "completed");
      expect(waitsOf(world, waiter)[0]?.status).toBe("closed");
    });
  });

  it("still routes a reply carrying a wait's stored legacy bb marker", async () => {
    await withTestHarness(async (harness) => {
      const world = seedInboxWorld(harness, "host-callback-legacy-bb");
      const waiter = seedChat(world);
      const source = seedChat(world);
      await ownerSend(world, source.id, "Write the report");
      await startSubmittedTurn(world, source.id);
      await ownerSend(world, waiter.id, "Wait for the report");
      await startSubmittedTurn(world, waiter.id);
      expect((await callbackWait(world, waiter, source)).status).toBe(200);

      const marker = "[bb wait 0f0e5b9d-5a7e-4c22-9d1f-4d3a8e6b1c2a]";
      harness.db
        .update(threadWaits)
        .set({ marker })
        .where(eq(threadWaits.threadId, waiter.id))
        .run();

      const delivered = await tell(world, source, waiter, `${marker} done`);
      expect(await delivered.json()).toMatchObject({
        delivery: "stored",
        late: false,
      });
    });
  });

  it("rejects a wait that would form a cycle and a wait on a source with nothing to deliver", async () => {
    await withTestHarness(async (harness) => {
      const world = seedInboxWorld(harness, "host-callback-cycle");
      const first = seedChat(world);
      const second = seedChat(world);
      await ownerSend(world, first.id, "Work");
      const firstTurn = await startSubmittedTurn(world, first.id);
      await ownerSend(world, second.id, "Work");
      await startSubmittedTurn(world, second.id);

      expect((await callbackWait(world, first, second)).status).toBe(200);
      expect((await callbackWait(world, second, first)).status).toBe(400);
      await endTurn(world, firstTurn, "completed");

      const waiter = seedChat(world);
      const idleSource = seedChat(world);
      expect((await callbackWait(world, waiter, idleSource)).status).toBe(400);
    });
  });

  it("converts a legacy callback row and still routes its old marker as a result", async () => {
    await withTestHarness(async (harness) => {
      const world = seedInboxWorld(harness, "host-callback-legacy");
      const waiter = seedChat(world);
      const source = seedChat(world);
      const marker = "[callback-wait:0f0e5b9d-5a7e-4c22-9d1f-4d3a8e6b1c2a]";
      insertLegacyCallback(world, waiter, source, marker);

      await runInboxSweep(harness.deps, Date.now());
      const [wait] = waitsOf(world, waiter);
      expect(wait).toMatchObject({ kind: "chat", status: "live", marker });
      expect(wait?.deadline).toBeGreaterThan(Date.now());
      expect(harness.db.select().from(threadCallbacks).all()).toEqual([]);
      expect(
        harness.db
          .select()
          .from(threadWaitConditions)
          .where(eq(threadWaitConditions.waitId, wait?.id ?? ""))
          .all()[0]?.target,
      ).toBe(source.id);

      const delivered = await tell(world, source, waiter, `${marker} done`);
      expect(await delivered.json()).toMatchObject({ delivery: "stored" });
    });
  });

  it("drops a legacy row whose waiter already holds an open native wait on the same source", async () => {
    await withTestHarness(async (harness) => {
      const world = seedInboxWorld(harness, "host-callback-legacy-collision");
      const waiter = seedChat(world);
      const source = seedChat(world);
      await ownerSend(world, source.id, "Write the report");
      await startSubmittedTurn(world, source.id);
      expect((await callbackWait(world, waiter, source)).status).toBe(200);
      const [native] = waitsOf(world, waiter);
      insertLegacyCallback(world, waiter, source, "[callback-wait:legacy-1]");

      await runInboxSweep(harness.deps, Date.now());

      expect(harness.db.select().from(threadCallbacks).all()).toEqual([]);
      expect(waitsOf(world, waiter)).toEqual([native]);
    });
  });

  it("converts a legacy row into the next generation after the waiter's earlier native wait closed", async () => {
    await withTestHarness(async (harness) => {
      const world = seedInboxWorld(harness, "host-callback-legacy-generation");
      const waiter = seedChat(world);
      const source = seedChat(world);
      await ownerSend(world, source.id, "Write the report");
      await startSubmittedTurn(world, source.id);
      expect((await callbackWait(world, waiter, source)).status).toBe(200);
      const [native] = waitsOf(world, waiter);

      const cleared = await world.harness.app.request(
        `/api/v1/threads/${waiter.id}/attention`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            [INBOX_CALLER_THREAD_HEADER]: waiter.id,
          },
          body: JSON.stringify({ action: "clear", id: native?.id }),
        },
      );

      expect(await cleared.json()).toMatchObject({ cleared: true });
      const marker = "[callback-wait:legacy-1]";
      insertLegacyCallback(world, waiter, source, marker);

      await runInboxSweep(harness.deps, Date.now());

      expect(harness.db.select().from(threadCallbacks).all()).toEqual([]);
      expect(
        waitsOf(world, waiter)
          .map(({ generation, marker: stored, status }) => ({
            generation,
            marker: stored,
            status,
          }))
          .sort((left, right) => left.generation - right.generation),
      ).toEqual([
        { generation: 1, marker: native?.marker, status: "closed" },
        { generation: 2, marker, status: "live" },
      ]);
    });
  });
});

describe("callback waits in the attention view", () => {
  it("lists an open callback wait under its wait id and clears it by that id", async () => {
    await withTestHarness(async (harness) => {
      const world = seedInboxWorld(harness, "host-callback-view");
      const waiter = seedChat(world);
      const source = seedChat(world);
      await ownerSend(world, source.id, "Write the report");
      await startSubmittedTurn(world, source.id);

      const registered = await callbackWait(world, waiter, source);

      const { callbackMarker } = (await registered.json()) as {
        callbackMarker: string;
      };

      const [wait] = waitsOf(world, waiter);

      const view = await attentionOf(world, waiter);
      expect(view.callbacks).toEqual([
        {
          id: wait?.id,
          threadId: waiter.id,
          sourceThreadId: source.id,
          sourceTitle: expect.any(String),
          reason: "the migration report",
          createdAt: wait?.createdAt,
          afterSeq: expect.any(Number),
          matchText: callbackMarker,
          sourceState: "working",
        },
      ]);

      const snapshot = await harness.app.request("/api/v1/thread-attention");
      expect(
        ((await snapshot.json()) as ThreadAttentionSnapshot).callbacks.map(
          (callback) => callback.id,
        ),
      ).toEqual([wait?.id]);

      const cleared = await harness.app.request(
        `/api/v1/threads/${waiter.id}/attention`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            [INBOX_CALLER_THREAD_HEADER]: waiter.id,
          },
          body: JSON.stringify({ action: "clear", id: wait?.id }),
        },
      );

      expect(await cleared.json()).toMatchObject({
        cleared: true,
        callbacks: [],
      });
      expect((await attentionOf(world, waiter)).callbacks).toEqual([]);
    });
  });

  it("tells the waiter once when its source stops working, and again when the wait ends", async () => {
    await withTestHarness(async (harness) => {
      const world = seedInboxWorld(harness, "host-callback-forward");
      const waiter = seedChat(world);
      const source = seedChat(world);
      await ownerSend(world, source.id, "Write the report");
      const sourceTurn = await startSubmittedTurn(world, source.id);
      await ownerSend(world, waiter.id, "Wait for the report");
      const waiterTurn = await startSubmittedTurn(world, waiter.id);
      const registered = await callbackWait(world, waiter, source);

      const { callbackMarker } = (await registered.json()) as {
        callbackMarker: string;
      };

      await endTurn(world, waiterTurn, "completed");
      const seen = recordAttentionChanges(world, waiter);

      await endTurn(world, sourceTurn, "completed");
      await new Promise((resolve) => setImmediate(resolve));

      expect(
        seen.map((callbacks) => callbacks.map((c) => c.sourceState)),
      ).toEqual([["idle"]]);

      await tell(world, source, waiter, `${callbackMarker} done: 12 tables`);
      await new Promise((resolve) => setImmediate(resolve));

      expect(seen.at(-1)).toEqual([]);
      expect((await attentionOf(world, waiter)).callbacks).toEqual([]);
    });
  });

  it("updates a sub-chat's callbacks when the owner cancels its wait from the root's Inbox card", async () => {
    await withTestHarness(async (harness) => {
      const world = seedInboxWorld(harness, "host-callback-family");
      const root = seedChat(world);
      const child = seedChat(world, { parentThreadId: root.id });
      const source = seedChat(world);
      await ownerSend(world, source.id, "Write the report");
      await startSubmittedTurn(world, source.id);
      expect((await callbackWait(world, child, source)).status).toBe(200);
      const [wait] = waitsOf(world, child);
      const seen = recordAttentionChanges(world, child);

      const cancelled = await ownerRequest(world, "/inbox/act", {
        action: "cancel-wait",
        threadId: root.id,
        waitId: wait?.id,
      });

      expect(cancelled.status).toBe(200);
      await new Promise((resolve) => setImmediate(resolve));

      expect(waitsOf(world, child)[0]?.status).toBe("closed");
      expect(seen.at(-1)).toEqual([]);
    });
  });
});
