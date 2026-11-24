import {
  getThread,
  hosts,
  listQueuedThreadMessages,
  threadFailures,
  threadPluginMetadata,
  threadReceipts,
  threads,
  threadWaitConditions,
  threadWaits,
} from "@omnyo/db";
import {
  INBOX_CALLER_PLUGIN_HEADER,
  INBOX_CALLER_THREAD_HEADER,
  inboxWaitRegisterResponseSchema,
  type InboxEntry,
  type Thread,
} from "@omnyo/domain";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  insertReceipt,
  insertWait,
  markConditionsStall,
} from "../../src/services/inbox/store.js";
import { runInboxSweep } from "../../src/services/inbox/sweep.js";
import { onHostReconnected } from "../../src/services/inbox/waits.js";
import { runQueuedMessageDispatch } from "../../src/services/threads/queued-message-dispatch.js";
import { listQueuedThreadCommands } from "../helpers/commands.js";
import { withTestHarness } from "../helpers/test-app.js";
import {
  agentRequest,
  endTurn,
  entryOf,
  ownerRequest,
  ownerSend,
  pendingSubmitCount,
  seedChat,
  seedInboxWorld,
  snapshot,
  startSubmittedTurn,
  type InboxWorld,
} from "./inbox-driver.js";

const DAY = 24 * 60 * 60 * 1000;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"], shouldAdvanceTime: true });
  vi.setSystemTime(Date.UTC(2026, 9, 29, 9));
});

afterEach(() => vi.useRealTimers());

async function advance(world: InboxWorld, ms: number): Promise<void> {
  vi.setSystemTime(Date.now() + ms);
  await runInboxSweep(world.harness.deps, Date.now());
  await settle(world);
}

async function settle(world: InboxWorld): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
  await runQueuedMessageDispatch(world.harness.deps, {
    kind: "time-reached",
    now: Date.now(),
  });
  await new Promise((resolve) => setImmediate(resolve));
}

async function entry(world: InboxWorld, thread: Thread): Promise<InboxEntry> {
  const found = entryOf(await snapshot(world), thread.id);

  if (found === null) throw new Error("expected an inbox entry");

  return found;
}

async function tellFrom(
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

async function backgroundResults(
  world: InboxWorld,
  source: Thread,
  target: Thread,
  count: number,
): Promise<void> {
  for (let index = 0; index < count; index += 1) {
    expect(
      (await tellFrom(world, source, target, `note ${index}`)).status,
    ).toBe(200);
    await endTurn(
      world,
      await startSubmittedTurn(world, target.id),
      "completed",
    );
  }
}

function receiptsOf(world: InboxWorld, thread: Thread) {
  return world.harness.db
    .select()
    .from(threadReceipts)
    .where(eq(threadReceipts.rootThreadId, thread.id))
    .all();
}

function waitsOf(world: InboxWorld, thread: Thread) {
  return world.harness.db
    .select()
    .from(threadWaits)
    .where(eq(threadWaits.threadId, thread.id))
    .all();
}

function failuresOf(world: InboxWorld, thread: Thread) {
  return world.harness.db
    .select()
    .from(threadFailures)
    .where(eq(threadFailures.threadId, thread.id))
    .all();
}

function stallReceipts(world: InboxWorld, thread: Thread) {
  return receiptsOf(world, thread).filter(
    (receipt) => receipt.cause === "stall",
  );
}

function submittedTexts(world: InboxWorld, thread: Thread): string[] {
  return listQueuedThreadCommands(
    world.harness,
    "turn.submit",
    thread.id,
  ).flatMap((command) =>
    command.type === "turn.submit"
      ? command.input.flatMap((part) =>
          part.type === "text" ? [part.text] : [],
        )
      : [],
  );
}

async function stallAfterOneWake(
  world: InboxWorld,
  register: (waiter: Thread, source: Thread) => Promise<Response>,
  afterWake?: (waiter: Thread, source: Thread, waitId: string) => void,
) {
  const waiter = seedChat(world);
  const source = seedChat(world);
  await ownerSend(world, source.id, "Produce the numbers");
  const sourceTurn = await startSubmittedTurn(world, source.id);
  await ownerSend(world, waiter.id, "Wait for the numbers");
  const waiterTurn = await startSubmittedTurn(world, waiter.id);
  const registered = await register(waiter, source);
  expect(registered.status).toBe(200);

  const { wait } = inboxWaitRegisterResponseSchema.parse(
    await registered.json(),
  );

  await endTurn(world, waiterTurn, "completed");
  await endTurn(world, sourceTurn, "completed");

  await advance(world, 1_000);
  expect(submittedTexts(world, source)).toEqual([
    [
      `@thread:${waiter.id} is waiting on your result. Deliver it with:`,
      `- \`omnyo thread tell ${waiter.id} --mode auto "${wait.marker} <result>"\``,
      "If you can't deliver it yet, explain why.",
    ].join("\n"),
  ]);
  const reminderTurn = await startSubmittedTurn(world, source.id);
  await advance(world, 1_000);
  await endTurn(world, reminderTurn, "completed");
  afterWake?.(waiter, source, wait.id);
  await advance(world, 11 * 60 * 1000);
  await advance(world, 11 * 60 * 1000);

  return { waiter, source, wait };
}

async function act(world: InboxWorld, body: unknown): Promise<Response> {
  return ownerRequest(world, "/inbox/act", body);
}

async function failAndDecide(world: InboxWorld, thread: Thread, text: string) {
  await ownerSend(world, thread.id, text);
  await endTurn(world, await startSubmittedTurn(world, thread.id), "failed");
  await advance(world, 31_000);
}

async function withWorld(
  name: string,
  run: (world: InboxWorld) => Promise<void>,
) {
  await withTestHarness(async (harness) => {
    await run(seedInboxWorld(harness, `host-scenario-${name}`));
  });
}

describe("inbox scenarios on the real server", () => {
  it("handles only the three causes an unfocused card displayed (+N stays)", async () => {
    await withWorld("plus-n", async (world) => {
      const root = seedChat(world);
      const source = seedChat(world);
      await backgroundResults(world, source, root, 4);

      const card = (await entry(world, root)).card;
      expect(card?.causes).toHaveLength(4);

      const shown = (card?.causes ?? [])
        .slice(0, 3)
        .map((cause) => cause.receiptId);

      expect(
        (
          await act(world, {
            action: "wait",
            threadId: root.id,
            displayedReceiptIds: shown,
            until: Date.now() + DAY,
          })
        ).status,
      ).toBe(200);

      const handled = receiptsOf(world, root).filter(
        (receipt) => receipt.handledAt !== null,
      );

      expect(handled.map((receipt) => receipt.id).sort()).toEqual(
        [...shown].sort(),
      );
      expect(await entry(world, root)).toMatchObject({
        view: "waiting",
        state: "waiting",
        pendingResults: 1,
      });
      expect(
        receiptsOf(world, root).filter((receipt) => receipt.handledAt === null),
      ).toHaveLength(1);
    });
  });

  it("refuses to archive while a cause is hidden behind +N", async () => {
    await withWorld("archive-coverage", async (world) => {
      const root = seedChat(world);
      const source = seedChat(world);
      await backgroundResults(world, source, root, 4);

      const causes = ((await entry(world, root)).card?.causes ?? []).map(
        (cause) => cause.receiptId,
      );

      const partial = await act(world, {
        action: "archive",
        threadId: root.id,
        displayedReceiptIds: causes.slice(0, 3),
      });

      expect(partial.status).toBe(409);
      expect((await entry(world, root)).view).toBe("inbox");

      const full = await act(world, {
        action: "archive",
        threadId: root.id,
        displayedReceiptIds: causes,
      });

      expect(full.status).toBe(200);
      expect(
        receiptsOf(world, root).every((receipt) => receipt.handledAt !== null),
      ).toBe(true);
    });
  });

  it("keeps a result delivered during a failure pause past its deadline, then resumes once", async () => {
    await withWorld("deadline-delivered", async (world) => {
      const root = seedChat(world);
      const source = seedChat(world);
      await ownerSend(world, source.id, "Produce the report");
      const sourceTurn = await startSubmittedTurn(world, source.id);

      await ownerSend(world, root.id, "Wait for the report");
      const rootTurn = await startSubmittedTurn(world, root.id);

      const registered = await agentRequest(
        world,
        root.id,
        `/threads/${root.id}/waits`,
        {
          key: "report",
          for: "the report",
          chats: [source.id],
        },
      );

      expect(registered.status).toBe(200);

      const { wait } = (await registered.json()) as {
        wait: { id: string; marker: string };
      };

      await endTurn(world, rootTurn, "failed");
      await advance(world, 31_000);
      expect((await entry(world, root)).card?.kind).toBe("problem");

      expect(
        (await tellFrom(world, source, root, `${wait.marker} done: 42 pages`))
          .status,
      ).toBe(200);
      await endTurn(world, sourceTurn, "completed");
      expect(pendingSubmitCount(world, root.id)).toBe(0);

      await advance(world, 8 * DAY);
      const stored = waitsOf(world, root).find((row) => row.id === wait.id);
      expect(stored?.closedReason).not.toBe("deadline");
      expect(
        receiptsOf(world, root).some((receipt) => receipt.cause === "deadline"),
      ).toBe(false);
    });
  });

  it("never lets a scheduled message clear a failure or run on top of it", async () => {
    await withWorld("send-later", async (world) => {
      const root = seedChat(world);
      await failAndDecide(world, root, "Deploy");
      expect(failuresOf(world, root).at(-1)?.state).toBe("actionable");

      const scheduled = await world.harness.app.request(
        `/api/v1/threads/${root.id}/send`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            input: [{ type: "text", text: "later", mentions: [] }],
            mode: "queue-if-active",
            sendAt: Date.now() + 60 * 60 * 1000,
          }),
        },
      );

      expect(scheduled.status).toBe(200);

      await advance(world, 2 * 60 * 60 * 1000);
      expect(pendingSubmitCount(world, root.id)).toBe(0);
      expect(failuresOf(world, root).at(-1)?.state).toBe("actionable");
      expect((await entry(world, root)).card?.kind).toBe("problem");
    });
  });

  it("queues a tell from another chat behind a failure instead of starting a turn", async () => {
    await withWorld("tell-pause", async (world) => {
      const root = seedChat(world);
      const other = seedChat(world);
      await failAndDecide(world, root, "Deploy");
      expect(failuresOf(world, root).at(-1)?.state).toBe("actionable");

      const told = await world.harness.app.request(
        `/api/v1/threads/${root.id}/send`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            [INBOX_CALLER_THREAD_HEADER]: other.id,
          },
          body: JSON.stringify({
            input: [{ type: "text", text: "Here is the report", mentions: [] }],
            mode: "auto",
            senderThreadId: other.id,
          }),
        },
      );

      expect(told.status).toBe(200);
      await settle(world);

      expect(pendingSubmitCount(world, root.id)).toBe(0);
      expect(listQueuedThreadMessages(world.harness.db, root.id)).toHaveLength(
        1,
      );
      expect(failuresOf(world, root).at(-1)?.state).toBe("actionable");
      expect((await entry(world, root)).card?.kind).toBe("problem");
    });
  });

  it("queues a message behind a held retry and lets Send now claim the retry", async () => {
    await withWorld("held-retry", async (world) => {
      const root = seedChat(world);
      await ownerSend(world, root.id, "Build it");
      await endTurn(world, await startSubmittedTurn(world, root.id), "failed");

      const retry = await world.harness.app.request(
        `/api/v1/threads/${root.id}/retry`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            [INBOX_CALLER_PLUGIN_HEADER]: "provider-retry",
          },
          body: JSON.stringify({
            turnRequestId: null,
            sendAt: Date.now() + 60 * 60 * 1000,
            reason: "Overloaded",
          }),
        },
      );

      expect(retry.status).toBe(200);
      expect(failuresOf(world, root).at(-1)?.state).toBe("held");
      expect((await entry(world, root)).view).toBe("waiting");

      await ownerSend(world, root.id, "Also add tests");
      expect(pendingSubmitCount(world, root.id)).toBe(0);

      const queued = listQueuedThreadMessages(world.harness.db, root.id).find(
        (row) => row.payloadKind === "inline",
      );

      expect(queued).toBeDefined();

      const sendNow = await world.harness.app.request(
        `/api/v1/threads/${root.id}/queued-messages/${queued?.id}/send`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ mode: "auto" }),
        },
      );

      expect(sendNow.status).toBe(200);
      expect(pendingSubmitCount(world, root.id)).toBe(1);
      expect(
        listQueuedThreadMessages(world.harness.db, root.id).some(
          (row) => row.payloadKind === "retry",
        ),
      ).toBe(false);
    });
  });

  it("stores a late result, never runs it as a prompt, and shows one Late result card", async () => {
    await withWorld("late-result", async (world) => {
      const root = seedChat(world);
      const source = seedChat(world);
      await ownerSend(world, source.id, "Work");
      const sourceTurn = await startSubmittedTurn(world, source.id);
      await ownerSend(world, root.id, "Wait for it");
      const rootTurn = await startSubmittedTurn(world, root.id);

      const registered = await agentRequest(
        world,
        root.id,
        `/threads/${root.id}/waits`,
        {
          key: "late",
          for: "the result",
          chats: [source.id],
        },
      );

      const { wait } = (await registered.json()) as {
        wait: { id: string; marker: string };
      };

      await endTurn(world, rootTurn, "completed");

      expect(
        (
          await act(world, {
            action: "cancel-wait",
            threadId: root.id,
            waitId: wait.id,
          })
        ).status,
      ).toBe(200);
      const before = pendingSubmitCount(world, root.id);

      const delivered = await tellFrom(
        world,
        source,
        root,
        `${wait.marker} done late`,
      );

      expect(delivered.status).toBe(200);
      expect(await delivered.json()).toMatchObject({
        delivery: "stored",
        late: true,
      });
      await endTurn(world, sourceTurn, "completed");
      expect(pendingSubmitCount(world, root.id)).toBe(before);
      expect(
        receiptsOf(world, root).filter(
          (receipt) => receipt.cause === "late-result",
        ),
      ).toHaveLength(1);
    });
  });

  it("keeps a child failure with its working parent until the parent itself fails", async () => {
    await withWorld("lifted-failure", async (world) => {
      const root = seedChat(world);

      await ownerSend(world, root.id, "Coordinate the delegated task");
      const parentTurn = await startSubmittedTurn(world, root.id);

      const side = seedChat(world, {
        lifecycleOwnerThreadId: root.id,
        visibility: "hidden",
      });

      await failAndDecide(world, side, "Investigate in the side chat");

      const projected = await entry(world, root);
      expect(projected).toMatchObject({
        state: "working",
        view: "running",
        card: null,
      });
      expect(failuresOf(world, side).at(-1)?.state).toBe("actionable");

      await endTurn(world, parentTurn, "failed");
      await advance(world, 31_000);
      expect(await entry(world, root)).toMatchObject({
        state: "failed",
        card: {
          kind: "problem",
          primary: { kind: "resume", targetThreadId: root.id },
        },
      });
    });
  });

  it("restores the failure as a Problem when an archive is undone", async () => {
    await withWorld("undo-archive", async (world) => {
      const root = seedChat(world);
      await failAndDecide(world, root, "Ship");

      const causes = ((await entry(world, root)).card?.causes ?? []).map(
        (cause) => cause.receiptId,
      );

      const archived = await act(world, {
        action: "archive",
        threadId: root.id,
        displayedReceiptIds: causes,
      });

      expect(archived.status).toBe(200);
      const { moveId } = (await archived.json()) as { moveId: string };

      expect(
        (await ownerRequest(world, "/inbox/undo", { moveId })).status,
      ).toBe(200);
      const restored = await entry(world, root);
      expect(restored.view).toBe("inbox");
      expect(restored.card?.kind).toBe("problem");
      expect(failuresOf(world, root).at(-1)?.state).toBe("actionable");
    });
  });

  it("turns an agent's cancel of a wait the owner created into a proposal", async () => {
    await withWorld("owner-wait", async (world) => {
      const root = seedChat(world);

      const causes = ((await entry(world, root)).card?.causes ?? []).map(
        (cause) => cause.receiptId,
      );

      expect(
        (
          await act(world, {
            action: "wait-report",
            threadId: root.id,
            displayedReceiptIds: causes,
            event: "the overlap happens again",
          })
        ).status,
      ).toBe(200);
      const wait = waitsOf(world, root).find((row) => row.kind === "report");

      await ownerSend(world, root.id, "Anything new?");
      const turn = await startSubmittedTurn(world, root.id);

      const cancel = await agentRequest(
        world,
        root.id,
        `/threads/${root.id}/waits/${wait?.id}/cancel`,
        undefined,
      );

      expect(cancel.status).toBe(200);
      expect(await cancel.json()).toMatchObject({ proposed: true });
      await endTurn(world, turn, "completed");
      expect(
        waitsOf(world, root).find((row) => row.id === wait?.id)?.status,
      ).toBe("live");
    });
  });

  it("shows a concrete recovery decision when a dependency misses its deadline", async () => {
    await withWorld("dependency-deadline", async (world) => {
      const source = seedChat(world);
      world.harness.db
        .update(threads)
        .set({ title: "Release review" })
        .where(eq(threads.id, source.id))
        .run();
      const root = seedChat(world);
      await ownerSend(world, source.id, "Review the release");
      await startSubmittedTurn(world, source.id);
      const deadline = Date.now() + 120_000;

      const registered = await ownerRequest(
        world,
        `/threads/${root.id}/waits`,
        {
          key: "review",
          for: "release approval",
          chats: [source.id],
          by: deadline,
        },
      );

      expect(registered.status).toBe(200);
      const { wait } = await registered.json();

      expect((await entry(world, root)).waiting).toMatchObject({
        waitId: wait.id,
        waitThreadId: root.id,
        returnAt: deadline,
      });
      expect(pendingSubmitCount(world, root.id)).toBe(0);

      await advance(world, 121_000);
      const expired = await entry(world, root);
      expect(expired.state).toBe("needs-you");
      expect(expired.card?.primary).toMatchObject({
        kind: "keep-waiting",
        waitId: wait.id,
      });
      expect(expired.reason.text).toContain("Release review");
      expect(expired.reason.text).toContain("send a new direction");
      await advance(world, 1_000);
      expect(
        receiptsOf(world, root).filter((receipt) => receipt.waitId === wait.id),
      ).toHaveLength(1);
      expect(pendingSubmitCount(world, root.id)).toBe(0);
    });
  });

  it("groups chats that hit the same usage limit into one Problem, resumed together at the reset", async () => {
    await withWorld("incident", async (world) => {
      const first = seedChat(world);
      const second = seedChat(world);
      const resetAt = Date.now() + 9 * 60 * 60 * 1000;

      const decline = (chat: Thread) =>
        world.harness.app.request(`/api/v1/threads/${chat.id}/retry/decline`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            [INBOX_CALLER_PLUGIN_HEADER]: "provider-retry",
          },
          body: JSON.stringify({
            turnRequestId: null,
            reason: "beyond-maximum-wait",
            incident: {
              key: "codex:rate-limit:host:host_mac",
              label: "codex usage limit",
              resetAt,
            },
          }),
        });

      for (const chat of [first, second]) {
        await ownerSend(world, chat.id, "Keep going");
        await endTurn(
          world,
          await startSubmittedTurn(world, chat.id),
          "failed",
        );
        expect((await decline(chat)).status).toBe(200);
        expect(failuresOf(world, chat).at(-1)?.state).toBe("actionable");
      }

      const inbox = (await snapshot(world)).inbox;
      expect(inbox).toHaveLength(1);
      const group = inbox[0];
      expect(group?.card?.kind).toBe("problem");
      const both = [first.id, second.id].sort();
      const primary = group?.card?.primary;

      if (primary?.kind !== "resume-all-at-reset")
        throw new Error("expected resume-all-at-reset");
      expect(primary.resetAt).toBe(resetAt);
      expect([...primary.threadIds].sort()).toEqual(both);
      expect(
        group?.incident?.members.map((member) => member.threadId).sort(),
      ).toEqual(both);

      const resumed = await act(world, {
        action: "resume-all-at-reset",
        threadId: group?.threadId,
        threadIds: primary.threadIds,
        latch: group?.latch,
      });

      expect(resumed.status).toBe(200);

      for (const chat of [first, second]) {
        expect(failuresOf(world, chat).at(-1)?.state).toBe("held");
        expect((await entry(world, chat)).view).toBe("waiting");
      }

      expect((await snapshot(world)).inbox).toEqual([]);
    });
  });

  it("re-arms a woken check even when a newer generation of its key exists", async () => {
    await withWorld("generation-collision", async (world) => {
      const root = seedChat(world);
      await ownerSend(world, root.id, "Watch the export");
      const turn = await startSubmittedTurn(world, root.id);
      await agentRequest(world, root.id, `/threads/${root.id}/waits`, {
        key: "export",
        for: "the export",
        check: { what: "export status", at: Date.now() + DAY },
      });
      await endTurn(world, turn, "completed");
      await advance(world, DAY + 60_000);
      const woken = await startSubmittedTurn(world, root.id);
      const [wait] = waitsOf(world, root);

      if (wait === undefined) throw new Error("expected the export wait");

      world.harness.db
        .insert(threadWaits)
        .values({
          ...wait,
          id: `${wait.id}-next`,
          generation: wait.generation + 1,
          status: "closed",
          closedReason: "owner-cancel",
          dispatchKey: null,
        })
        .run();

      const rearmed = await agentRequest(
        world,
        root.id,
        `/threads/${root.id}/waits/${wait.id}/rearm`,
        undefined,
      );

      expect(rearmed.status).toBe(200);
      expect(
        waitsOf(world, root).find((row) => row.id === wait.id)?.generation,
      ).toBe(wait.generation + 2);
      await endTurn(world, woken, "completed");
    });
  });

  it("keeps a report-it wait armed through its reminder", async () => {
    await withWorld("reminder", async (world) => {
      const root = seedChat(world);

      const causes = ((await entry(world, root)).card?.causes ?? []).map(
        (cause) => cause.receiptId,
      );

      await act(world, {
        action: "wait-report",
        threadId: root.id,
        displayedReceiptIds: causes,
        event: "it recurs",
      });
      expect((await entry(world, root)).waiting?.group).toBe("on-you");

      await advance(world, 15 * DAY);
      const reminded = await entry(world, root);
      expect(reminded.card?.kind).toBe("returned");
      expect(reminded.card?.primary.kind).toBe("remind-later");
      expect(
        waitsOf(world, root).find((row) => row.kind === "report")?.status,
      ).toBe("live");

      await advance(world, 3 * DAY);
      await ownerSend(world, root.id, "Still watching it");
      const report = waitsOf(world, root).find((row) => row.kind === "report");
      expect(report?.status).toBe("live");
      expect(report?.reminderAt).toBeGreaterThan(Date.now() + 14 * DAY - 1_000);
      expect(report?.reminderAt).toBeLessThanOrEqual(Date.now() + 14 * DAY);
    });
  });

  it("restores only waits the move cancelled, and returns an expired one instead", async () => {
    await withWorld("undo-expired", async (world) => {
      const root = seedChat(world);
      await ownerSend(world, root.id, "Watch the deploy");
      const turn = await startSubmittedTurn(world, root.id);
      await agentRequest(world, root.id, `/threads/${root.id}/waits`, {
        key: "deploy",
        for: "the deploy",
        check: { what: "deploy status", at: Date.now() + 9 * DAY },
      });
      await endTurn(world, turn, "completed");
      const wait = waitsOf(world, root).find((row) => row.kind === "check");

      const cancelled = await act(world, {
        action: "cancel-wait",
        threadId: root.id,
        waitId: wait?.id,
      });

      const { moveId } = (await cancelled.json()) as { moveId: string };

      vi.setSystemTime(Date.now() + 8 * DAY);
      expect(
        (await ownerRequest(world, "/inbox/undo", { moveId })).status,
      ).toBe(200);
      expect(
        waitsOf(world, root).find((row) => row.id === wait?.id)?.status,
      ).toBe("closed");
      expect(
        receiptsOf(world, root).some(
          (receipt) =>
            receipt.cause === "deadline" && receipt.handledAt === null,
        ),
      ).toBe(true);
    });
  });

  it("refuses an agent's archive without asking the owner to archive", async () => {
    await withWorld("archive-proposal", async (world) => {
      const root = seedChat(world);

      const refused = await world.harness.app.request(
        `/api/v1/threads/${root.id}/archive-all`,
        {
          method: "POST",
          headers: { [INBOX_CALLER_THREAD_HEADER]: root.id },
        },
      );

      expect(refused.status).toBe(403);
      expect(waitsOf(world, root)).toEqual([]);
      expect(receiptsOf(world, root)).toEqual([]);
      expect(getThread(world.harness.db, root.id)?.archivedAt).toBeNull();
    });
  });

  it("keeps a real check wait visible despite an archive proposal stored by an older server", async () => {
    await withWorld("legacy-archive-proposal", async (world) => {
      const root = seedChat(world);
      const now = Date.now();
      await ownerSend(world, root.id, "Check the security table tomorrow");
      const turn = await startSubmittedTurn(world, root.id);

      const registered = await agentRequest(
        world,
        root.id,
        `/threads/${root.id}/waits`,
        {
          key: "security",
          for: "GamesLike security-table check",
          check: { what: "Check the security table", at: now + DAY },
        },
      );

      expect(registered.status).toBe(200);
      await endTurn(world, turn, "completed");

      const proposal = insertWait(world.harness.db, {
        threadId: root.id,
        key: `proposal:archive:${now}`,
        generation: 1,
        kind: "date",
        status: "proposed",
        readiness: "all",
        createdBy: "agent",
        automationId: null,
        ownerAccepted: false,
        forText: "Archive",
        resumeText: null,
        marker: "[legacy archive proposal]",
        deadline: now + DAY,
        chainStartAt: now,
        nextCheckAt: null,
        checkIntervalMs: null,
        reminderAt: null,
        questionId: null,
        questionRevision: null,
        coversReceiptIds: [],
        proposalKind: "archive",
        afterWaitId: null,
        now,
      });

      insertReceipt(world.harness.db, {
        rootThreadId: root.id,
        threadId: root.id,
        cause: "proposal",
        summary: "The agent proposes Archive",
        outcomeRef: proposal.id,
        waitId: proposal.id,
        coveredInputIds: [],
        now,
      });

      expect(await entry(world, root)).toMatchObject({
        state: "waiting",
        reason: { kind: "wait", text: "GamesLike security-table check" },
        archiveReady: false,
      });
      expect(waitsOf(world, root)).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ key: "security", status: "live" }),
        ]),
      );
    });
  });

  it("refuses an unattended archive while the chat has results to read", async () => {
    await withWorld("unattended-archive", async (world) => {
      const root = seedChat(world);
      const source = seedChat(world);
      await backgroundResults(world, source, root, 1);

      const refused = await world.harness.app.request(
        `/api/v1/threads/${root.id}/archive-all`,
        {
          method: "POST",
          headers: { [INBOX_CALLER_PLUGIN_HEADER]: "omnyo--storage-retention" },
        },
      );

      expect(refused.status).toBe(409);
      expect((await entry(world, root)).view).toBe("inbox");
    });
  });

  it("wakes a stalled source once, then hands an agent's callback back to the waiting agent", async () => {
    await withWorld("stall", async (world) => {
      const { waiter, source, wait } = await stallAfterOneWake(
        world,
        (waiter, source) =>
          agentRequest(world, waiter.id, `/threads/${waiter.id}/waits`, {
            key: "numbers",
            for: "the numbers",
            chats: [source.id],
          }),
      );

      expect(stallReceipts(world, source)).toHaveLength(0);
      expect(stallReceipts(world, waiter)).toHaveLength(0);
      const sourceEntry = await entry(world, source);
      expect(sourceEntry).toMatchObject({
        state: "waiting",
        reason: {
          kind: "deliver",
          text: `${waiter.title} is waiting on this chat`,
        },
      });
      expect(sourceEntry.card?.primary.kind).not.toBe("reply");
      expect(pendingSubmitCount(world, source.id)).toBe(0);

      const escalations = submittedTexts(world, waiter);

      expect(escalations).toHaveLength(1);
      expect(escalations[0]).toContain(
        `@thread:${source.id} went idle without delivering the result you wait on (the numbers).`,
      );
      expect(escalations[0]).toContain(
        `omnyo thread tell ${source.id} --mode auto "<what you still need>"`,
      );
      expect(escalations[0]).toContain(`omnyo wait cancel ${wait.id}`);
      expect(escalations[0]).not.toContain(wait.marker);

      await endTurn(
        world,
        await startSubmittedTurn(world, waiter.id),
        "completed",
      );
      await advance(world, 11 * 60 * 1000);
      expect(pendingSubmitCount(world, waiter.id)).toBe(0);
      expect(pendingSubmitCount(world, source.id)).toBe(0);
      expect(stallReceipts(world, source)).toHaveLength(0);
      expect((await entry(world, waiter)).waiting?.behind).toBe(
        source.title ?? null,
      );
    });
  });

  it("shows the owner one Reply card when a callback the owner created stalls, and clears it on delivery", async () => {
    await withWorld("owner-stall", async (world) => {
      const { waiter, source, wait } = await stallAfterOneWake(
        world,
        (waiter, source) =>
          ownerRequest(world, `/threads/${waiter.id}/waits`, {
            key: "numbers",
            for: "the numbers",
            chats: [source.id],
          }),
      );

      const stalls = stallReceipts(world, source);
      expect(stalls.map((receipt) => receipt.summary)).toEqual([
        `${waiter.title} is waiting on this chat's result`,
      ]);
      expect(pendingSubmitCount(world, waiter.id)).toBe(0);
      expect(await entry(world, source)).toMatchObject({
        state: "needs-you",
        reason: {
          kind: "decision",
          text: `${waiter.title} is waiting on this chat's result`,
        },
        card: { primary: { kind: "reply", waiterTitles: [waiter.title] } },
      });

      expect(
        (await tellFrom(world, source, waiter, `${wait.marker} 42`)).status,
      ).toBe(200);
      expect(
        stallReceipts(world, source).map((receipt) => receipt.handledAt),
      ).toEqual([expect.any(Number)]);
      expect((await entry(world, source)).state).not.toBe("needs-you");
    });
  });

  it.each(["cancel-wait", "archive"] as const)(
    "shows an owner callback's stall again when Undo reverses the %s that released it",
    async (action) => {
      await withWorld(`owner-stall-undo-${action}`, async (world) => {
        const { waiter, source, wait } = await stallAfterOneWake(
          world,
          (waiter, source) =>
            ownerRequest(world, `/threads/${waiter.id}/waits`, {
              key: "numbers",
              for: "the numbers",
              chats: [source.id],
            }),
        );

        expect((await entry(world, source)).state).toBe("needs-you");

        const moved = await act(
          world,
          action === "archive"
            ? {
                action,
                threadId: waiter.id,
                displayedReceiptIds: (
                  (await entry(world, waiter)).card?.causes ?? []
                ).map((cause) => cause.receiptId),
              }
            : { action, threadId: waiter.id, waitId: wait.id },
        );

        expect(moved.status).toBe(200);
        const { moveId } = (await moved.json()) as { moveId: string };
        expect((await entry(world, source)).state).not.toBe("needs-you");

        expect(
          (await ownerRequest(world, "/inbox/undo", { moveId })).status,
        ).toBe(200);
        expect(
          stallReceipts(world, source).map((receipt) => receipt.handledAt),
        ).toEqual([null]);
        expect(await entry(world, source)).toMatchObject({
          state: "needs-you",
          card: { primary: { kind: "reply", waiterTitles: [waiter.title] } },
        });
      });
    },
  );

  it("hands an agent's callback that still carries an owner stall receipt back to the waiting agent", async () => {
    await withWorld("agent-stall-receipt", async (world) => {
      let receiptId = "";

      const { waiter, source, wait } = await stallAfterOneWake(
        world,
        (waiter, source) =>
          agentRequest(world, waiter.id, `/threads/${waiter.id}/waits`, {
            key: "numbers",
            for: "the numbers",
            chats: [source.id],
          }),
        (waiter, source, waitId) => {
          const now = Date.now();

          receiptId = insertReceipt(world.harness.db, {
            rootThreadId: source.id,
            threadId: source.id,
            cause: "stall",
            summary: `Deliver to 1 chat: ${waiter.title}`,
            outcomeRef: source.id,
            waitId: null,
            coveredInputIds: [],
            now,
          }).id;
          markConditionsStall(world.harness.db, {
            sourceThreadId: source.id,
            waitIds: [waitId],
            patch: { stallReceiptId: receiptId },
          });
        },
      );

      expect(submittedTexts(world, waiter)).toEqual([
        expect.stringContaining(`@thread:${source.id} went idle`),
      ]);
      expect(
        world.harness.db
          .select({ stallReceiptId: threadWaitConditions.stallReceiptId })
          .from(threadWaitConditions)
          .where(eq(threadWaitConditions.waitId, wait.id))
          .all(),
      ).toEqual([{ stallReceiptId: "waiter" }]);
      expect(
        stallReceipts(world, source).map((receipt) => ({
          id: receipt.id,
          handled: receipt.handledAt !== null,
        })),
      ).toEqual([{ id: receiptId, handled: true }]);
      expect((await entry(world, source)).state).toBe("waiting");
    });
  });

  it("lists each stalled source's own waiters when chats wait on different sources", async () => {
    await withWorld("stall-waiters", async (world) => {
      const pairs = [
        {
          source: seedChat(world),
          waiters: [seedChat(world), seedChat(world)],
        },
        { source: seedChat(world), waiters: [seedChat(world)] },
      ];

      const markers = new Map<string, string>();

      for (const [pairIndex, { source, waiters }] of pairs.entries()) {
        await ownerSend(world, source.id, "Produce the numbers");
        const sourceTurn = await startSubmittedTurn(world, source.id);

        for (const [waiterIndex, waiter] of waiters.entries()) {
          await ownerSend(world, waiter.id, "Wait for the numbers");
          const waiterTurn = await startSubmittedTurn(world, waiter.id);

          const response = await agentRequest(
            world,
            waiter.id,
            `/threads/${waiter.id}/waits`,
            {
              key: `numbers-${pairIndex}-${waiterIndex}`,
              for: "the numbers",
              chats: [source.id],
            },
          );

          expect(response.status).toBe(200);
          markers.set(
            waiter.id,
            inboxWaitRegisterResponseSchema.parse(await response.json()).wait
              .marker,
          );
          await endTurn(world, waiterTurn, "completed");
        }

        await endTurn(world, sourceTurn, "completed");
      }

      await advance(world, 1_000);

      for (const { source, waiters } of pairs) {
        const response = await world.harness.app.request(
          `/api/v1/threads/${source.id}/waits`,
        );

        expect(response.status).toBe(200);
        expect(await response.json()).toMatchObject({
          waitingChatIds: waiters.map((waiter) => waiter.id),
        });
        expect(submittedTexts(world, source)).toEqual([
          [
            `${waiters.map((waiter) => `@thread:${waiter.id}`).join(", ")} ${waiters.length === 1 ? "is" : "are"} waiting on your result. Deliver it with:`,
            ...waiters.map(
              (waiter) =>
                `- \`omnyo thread tell ${waiter.id} --mode auto "${markers.get(waiter.id)} <result>"\``,
            ),
            "If you can't deliver it yet, explain why.",
          ].join("\n"),
        ]);
        await endTurn(
          world,
          await startSubmittedTurn(world, source.id),
          "completed",
        );
      }

      await advance(world, 11 * 60 * 1000);
      await advance(world, 11 * 60 * 1000);

      for (const { source, waiters } of pairs) {
        expect((await entry(world, source)).reason).toEqual({
          kind: "deliver",
          text: `${waiters.map((waiter) => waiter.title).join(" and ")} ${waiters.length === 1 ? "is" : "are"} waiting on this chat`,
          threadId: source.id,
        });

        for (const waiter of waiters)
          expect(submittedTexts(world, waiter)).toEqual([
            expect.stringContaining(`@thread:${source.id} went idle`),
          ]);
      }
    });
  });

  it("lets an agent archive its own sub-chat but not its top-level chat", async () => {
    await withWorld("agent-sub-archive", async (world) => {
      const root = seedChat(world);
      const child = seedChat(world, { parentThreadId: root.id });

      const childArchive = await world.harness.app.request(
        `/api/v1/threads/${child.id}/archive-all`,
        {
          method: "POST",
          headers: { [INBOX_CALLER_THREAD_HEADER]: root.id },
        },
      );

      expect(childArchive.status).toBe(200);
      expect(getThread(world.harness.db, child.id)?.archivedAt).not.toBeNull();

      const rootArchive = await world.harness.app.request(
        `/api/v1/threads/${root.id}/archive-all`,
        {
          method: "POST",
          headers: { [INBOX_CALLER_THREAD_HEADER]: root.id },
        },
      );

      expect(rootArchive.status).toBe(403);
      expect(getThread(world.harness.db, root.id)?.archivedAt).toBeNull();
    });
  });

  it("wakes on registered events and refuses unknown keys", async () => {
    await withWorld("events", async (world) => {
      const root = seedChat(world);
      await ownerSend(
        world,
        root.id,
        "Tell me when the update and the Mac are back",
      );
      const turn = await startSubmittedTurn(world, root.id);

      const unknown = await agentRequest(
        world,
        root.id,
        `/threads/${root.id}/waits`,
        {
          key: "nope",
          for: "something",
          events: ["mail:anything"],
        },
      );

      expect(unknown.status).toBe(400);

      const version = await agentRequest(
        world,
        root.id,
        `/threads/${root.id}/waits`,
        {
          key: "update",
          for: "the coordinator update",
          events: [
            `coordinator-version:${world.harness.deps.config.appVersion}`,
          ],
        },
      );

      expect(version.status).toBe(200);
      const hostId = world.harness.db.select().from(hosts).all()[0]?.id ?? "";

      const host = await agentRequest(
        world,
        root.id,
        `/threads/${root.id}/waits`,
        {
          key: "mac",
          for: "the Mac reconnects",
          events: [`host-reconnect:${hostId}`],
        },
      );

      expect(host.status).toBe(200);
      await endTurn(world, turn, "completed");

      await advance(world, 1_000);

      const byKey = (key: string) =>
        waitsOf(world, root).find((wait) => wait.key === key);

      expect(byKey("update")?.status).toBe("dispatched");
      expect(byKey("mac")?.status).toBe("live");
      await endTurn(
        world,
        await startSubmittedTurn(world, root.id),
        "completed",
      );

      await onHostReconnected(world.harness.deps, { hostId, now: Date.now() });
      expect(byKey("mac")?.status).toBe("dispatched");
    });
  });

  it("maps an agent's scheduled tells: self becomes a check, another chat shows a dated row", async () => {
    await withWorld("scheduled-tells", async (world) => {
      const root = seedChat(world);
      const other = seedChat(world);
      const at = Date.now() + 2 * DAY;

      const self = await world.harness.app.request(
        `/api/v1/threads/${root.id}/send`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            [INBOX_CALLER_THREAD_HEADER]: root.id,
          },
          body: JSON.stringify({
            input: [
              {
                type: "text",
                text: "Check whether the export finished",
                mentions: [],
              },
            ],
            mode: "queue-if-active",
            sendAt: at,
          }),
        },
      );

      expect(await self.json()).toMatchObject({ delivery: "waiting" });
      const check = waitsOf(world, root).find((wait) => wait.kind === "check");
      expect(check).toMatchObject({ createdBy: "agent", nextCheckAt: at });
      expect(listQueuedThreadMessages(world.harness.db, root.id)).toHaveLength(
        0,
      );

      const told = await world.harness.app.request(
        `/api/v1/threads/${other.id}/send`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            [INBOX_CALLER_THREAD_HEADER]: root.id,
          },
          body: JSON.stringify({
            input: [{ type: "text", text: "Ping me back", mentions: [] }],
            mode: "queue-if-active",
            sendAt: at,
            senderThreadId: root.id,
          }),
        },
      );

      expect(told.status).toBe(200);
      const target = await entry(world, other);
      expect(target.view).toBe("waiting");
      expect(target.waiting?.reason).toMatch(/^Message from /);
      expect(target.waiting?.returnAt).toBe(at);

      const archived = await act(world, {
        action: "archive",
        threadId: other.id,
        displayedReceiptIds: [],
        stopRunning: false,
        latch: target.latch,
      });

      expect(archived.status).toBe(200);
      await advance(world, 3 * DAY);
      expect(getThread(world.harness.db, other.id)?.archivedAt).not.toBeNull();
      expect(pendingSubmitCount(world, other.id)).toBe(0);
      expect(listQueuedThreadMessages(world.harness.db, other.id)).toHaveLength(
        0,
      );
      const sender = await entry(world, root);
      expect(sender.card?.causes.map((cause) => cause.summary)).toContain(
        `Couldn't post to ${getThread(world.harness.db, other.id)?.title ?? "a chat"}: archived`,
      );
    });
  });

  it("folds an automation's runs into one Runs card and archives the older ones as one move", async () => {
    await withWorld("runs", async (world) => {
      const source = seedChat(world);
      const runs = [seedChat(world), seedChat(world), seedChat(world)];

      for (const run of runs) {
        world.harness.db
          .insert(threadPluginMetadata)
          .values({
            threadId: run.id,
            pluginId: "automations",
            metadataJson: JSON.stringify({
              automationId: "auto-daily",
              runId: run.id,
            }),
          })
          .run();
        await backgroundResults(world, source, run, 1);
        vi.setSystemTime(Date.now() + 60_000);
      }

      const inbox = await snapshot(world);
      const group = inbox.inbox.filter((item) => item.card?.kind === "runs");
      expect(group).toHaveLength(1);
      expect(group[0]?.runs).toHaveLength(3);
      const primary = group[0]?.card?.primary;

      if (primary?.kind !== "archive-runs")
        throw new Error("expected archive-runs");
      expect(primary.mode).toBe("older");
      expect(primary.threadIds).toHaveLength(2);

      const archived = await act(world, {
        action: "archive-runs",
        threadId: group[0]?.threadId,
        threadIds: primary.threadIds,
        latch: group[0]?.latch,
      });

      expect(archived.status).toBe(200);
      const { moveId } = (await archived.json()) as { moveId: string };
      expect(
        runs.filter(
          (run) => getThread(world.harness.db, run.id)?.archivedAt !== null,
        ),
      ).toHaveLength(2);
      const after = await snapshot(world);
      expect(after.inbox.some((item) => item.card?.kind === "runs")).toBe(
        false,
      );

      expect(
        (await ownerRequest(world, "/inbox/undo", { moveId })).status,
      ).toBe(200);
      expect(
        runs.every(
          (run) => getThread(world.harness.db, run.id)?.archivedAt === null,
        ),
      ).toBe(true);
      expect(
        (await snapshot(world)).inbox.filter(
          (item) => item.card?.kind === "runs",
        ),
      ).toHaveLength(1);
    });
  });
});
