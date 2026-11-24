import { threadOwnerInputs, threadProducers, threadReceipts } from "@omnyo/db";
import {
  INBOX_CALLER_PLUGIN_HEADER,
  type InboxEntry,
  type InboxProducerResponse,
  type InboxWaitDetailResponse,
  type InboxWaitRegisterResponse,
  type Thread,
} from "@omnyo/domain";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runInboxSweep } from "../../src/services/inbox/sweep.js";
import { runQueuedMessageDispatch } from "../../src/services/threads/queued-message-dispatch.js";
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

const MINUTE = 60 * 1000;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"], shouldAdvanceTime: true });
  vi.setSystemTime(Date.UTC(2026, 9, 29, 9));
});

afterEach(() => vi.useRealTimers());

async function settle(world: InboxWorld): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
  await runQueuedMessageDispatch(world.harness.deps, {
    kind: "time-reached",
    now: Date.now(),
  });
  await new Promise((resolve) => setImmediate(resolve));
}

async function advance(world: InboxWorld, ms: number): Promise<void> {
  vi.setSystemTime(Date.now() + ms);
  await runInboxSweep(world.harness.deps, Date.now());
  await settle(world);
}

async function pluginRequest(
  world: InboxWorld,
  method: "GET" | "POST",
  path: string,
  body?: unknown,
): Promise<Response> {
  return await world.harness.app.request(`/api/v1${path}`, {
    method,
    headers: {
      "content-type": "application/json",
      [INBOX_CALLER_PLUGIN_HEADER]: "pursue",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

async function startGoal(world: InboxWorld, chat: Thread): Promise<string> {
  const response = await pluginRequest(
    world,
    "POST",
    `/threads/${chat.id}/producers`,
    {
      kind: "goal",
      label: "Pursuing: the suite passes",
    },
  );

  expect(response.status).toBe(200);

  return ((await response.json()) as InboxProducerResponse).producer.id;
}

async function verdict(
  world: InboxWorld,
  chat: Thread,
  producerId: string,
  value: "unmet" | "met" | "limit" | "stopped" | "failed",
  summary: string,
): Promise<InboxProducerResponse> {
  const response = await pluginRequest(
    world,
    "POST",
    `/threads/${chat.id}/producers/${producerId}/settle`,
    { verdict: value, summary },
  );

  expect(response.status).toBe(200);

  return (await response.json()) as InboxProducerResponse;
}

async function continuation(world: InboxWorld, chat: Thread): Promise<void> {
  const response = await pluginRequest(
    world,
    "POST",
    `/threads/${chat.id}/send`,
    {
      input: [
        { type: "text", text: "[pursue] Goal not met yet.", mentions: [] },
      ],
      mode: "auto",
    },
  );

  expect(response.status).toBe(200);
}

async function entry(world: InboxWorld, chat: Thread): Promise<InboxEntry> {
  const found = entryOf(await snapshot(world), chat.id);

  if (found === null) throw new Error(`no entry for ${chat.id}`);

  return found;
}

function receiptsOf(world: InboxWorld, chat: Thread) {
  return world.harness.db
    .select()
    .from(threadReceipts)
    .where(eq(threadReceipts.rootThreadId, chat.id))
    .all();
}

function inputsOf(world: InboxWorld, chat: Thread) {
  return world.harness.db
    .select()
    .from(threadOwnerInputs)
    .where(eq(threadOwnerInputs.threadId, chat.id))
    .all();
}

describe("a pursue goal is the chat's own producer", () => {
  it("holds each iteration for the verdict: UNMET drops it, MET surfaces one card covering the request", async () => {
    await withTestHarness(async (harness) => {
      const world = seedInboxWorld(harness, "host-goal-verdict");
      const chat = seedChat(world);
      await ownerSend(world, chat.id, "Keep going until the suite passes");
      const first = await startSubmittedTurn(world, chat.id);
      const producerId = await startGoal(world, chat);
      expect(inputsOf(world, chat).map((input) => input.state)).toEqual([
        "handed-off",
      ]);

      await endTurn(world, first, "completed");
      expect(receiptsOf(world, chat)).toEqual([]);
      expect(await entry(world, chat)).toMatchObject({
        view: "running",
        running: { label: "Pursuing: the suite passes", progress: null },
      });

      await verdict(world, chat, producerId, "unmet", "Two tests still fail");
      await continuation(world, chat);
      await settle(world);
      const second = await startSubmittedTurn(world, chat.id);
      await endTurn(world, second, "completed");
      expect(receiptsOf(world, chat)).toEqual([]);
      expect((await entry(world, chat)).view).toBe("running");

      const met = await verdict(
        world,
        chat,
        producerId,
        "met",
        "Goal met: the suite passes",
      );

      expect(met.producer.status).toBe("ended");
      expect(met.receiptId).not.toBeNull();
      const card = await entry(world, chat);
      expect(card.view).toBe("inbox");
      expect(card.card?.causes.map((cause) => cause.summary)).toEqual([
        "Goal met: the suite passes",
      ]);
      expect(inputsOf(world, chat).map((input) => input.state)).toEqual([
        "covered",
      ]);
    });
  });

  it("surfaces a held iteration when no verdict arrives within 15 minutes", async () => {
    await withTestHarness(async (harness) => {
      const world = seedInboxWorld(harness, "host-goal-timeout");
      const chat = seedChat(world);
      await ownerSend(world, chat.id, "Pursue the migration");
      const turn = await startSubmittedTurn(world, chat.id);
      await startGoal(world, chat);
      await endTurn(world, turn, "completed");

      await advance(world, 14 * MINUTE);
      expect((await entry(world, chat)).view).toBe("running");
      expect(receiptsOf(world, chat)).toEqual([]);

      await advance(world, 2 * MINUTE);
      const card = await entry(world, chat);
      expect(card.view).toBe("inbox");
      expect(card.card?.causes[0]?.summary).toMatch(
        /no verdict from the goal's judge$/,
      );
      expect(inputsOf(world, chat).map((input) => input.state)).toEqual([
        "covered",
      ]);
    });
  });

  it("gives an owner message during the goal its own result, and Archive ends the goal for good", async () => {
    await withTestHarness(async (harness) => {
      const world = seedInboxWorld(harness, "host-goal-owner");
      const chat = seedChat(world);
      const producerId = await startGoal(world, chat);
      expect((await entry(world, chat)).view).toBe("running");

      await ownerSend(world, chat.id, "How far along is it?");
      const turn = await startSubmittedTurn(world, chat.id);
      await endTurn(world, turn, "completed");
      expect(receiptsOf(world, chat)).toHaveLength(1);
      expect((await entry(world, chat)).view).toBe("inbox");

      const archived = await ownerRequest(world, "/inbox/act", {
        action: "archive",
        threadId: chat.id,
        displayedReceiptIds: receiptsOf(world, chat).map(
          (receipt) => receipt.id,
        ),
        stopRunning: true,
      });

      expect(archived.status).toBe(200);

      const producer = world.harness.db
        .select()
        .from(threadProducers)
        .where(eq(threadProducers.id, producerId))
        .get();

      expect(producer).toMatchObject({
        status: "ended",
        endedReason: "archived",
      });

      const late = await verdict(world, chat, producerId, "met", "Goal met");
      expect(late.receiptId).toBeNull();
    });
  });

  it("lets only a plugin own or settle a producer", async () => {
    await withTestHarness(async (harness) => {
      const world = seedInboxWorld(harness, "host-goal-actor");
      const chat = seedChat(world);
      const body = { kind: "goal", label: "Pursuing: anything" };

      expect(
        (await ownerRequest(world, `/threads/${chat.id}/producers`, body))
          .status,
      ).toBe(403);
      expect(
        (
          await agentRequest(
            world,
            chat.id,
            `/threads/${chat.id}/producers`,
            body,
          )
        ).status,
      ).toBe(403);
    });
  });
});

describe("an automation that re-prompts a chat owns it between runs", () => {
  it("accepts its automation-run event key and rejects one with no automation", async () => {
    await withTestHarness(async (harness) => {
      const world = seedInboxWorld(harness, "host-automation-wait");
      const chat = seedChat(world);

      const register = (key: string) =>
        pluginRequest(world, "POST", `/threads/${chat.id}/waits`, {
          key,
          for: "Morning triage runs again",
          events: [key],
          by: Date.now() + 25 * 60 * MINUTE,
        });

      expect((await register("automation-run:auto_morning")).status).toBe(200);
      expect((await entry(world, chat)).view).toBe("waiting");
      expect((await register("automation-run:")).status).toBe(400);
    });
  });
});

describe("a pursue loop is a check continuation", () => {
  it("wakes once per check, closes as resumed when the iteration reports, and reopens under the same marker", async () => {
    await withTestHarness(async (harness) => {
      const world = seedInboxWorld(harness, "host-loop");
      const chat = seedChat(world);

      const registration = {
        key: "pursue-loop",
        for: "Loop: check CI",
        check: { what: "check CI", at: Date.now() + 5 * MINUTE },
        resume: "Check CI and report what changed.",
      };

      const registered = await pluginRequest(
        world,
        "POST",
        `/threads/${chat.id}/waits`,
        registration,
      );

      expect(registered.status).toBe(200);
      const { wait } = (await registered.json()) as InboxWaitRegisterResponse;
      expect((await entry(world, chat)).view).toBe("waiting");

      await advance(world, 5 * MINUTE);
      expect(pendingSubmitCount(world, chat.id)).toBe(1);
      const iteration = await startSubmittedTurn(world, chat.id);
      await endTurn(world, iteration, "completed");

      const detail = (await (
        await pluginRequest(
          world,
          "GET",
          `/threads/${chat.id}/waits/${wait.id}`,
        )
      ).json()) as InboxWaitDetailResponse;

      expect(detail).toMatchObject({
        wait: { status: "closed" },
        closedReason: "resumed",
      });
      expect((await entry(world, chat)).view).toBe("inbox");

      const reopened = (await (
        await pluginRequest(world, "POST", `/threads/${chat.id}/waits`, {
          ...registration,
          check: { what: "check CI", at: Date.now() + 5 * MINUTE },
        })
      ).json()) as InboxWaitRegisterResponse;

      expect(reopened.wait).toMatchObject({
        generation: wait.generation + 1,
        marker: wait.marker,
        status: "live",
      });
    });
  });
});
