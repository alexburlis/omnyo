import { threadReceipts, threadWaitConditions, threadWaits } from "@omnyo/db";
import {
  INBOX_CALLER_PLUGIN_HEADER,
  inboxEventCheckResponseSchema,
  inboxEventSourcesResponseSchema,
  type Thread,
} from "@omnyo/domain";
import type {
  PluginEventSourceDeclaration,
  PluginEventSourceFiring,
  PluginEventSourceProblem,
} from "@omnyo/plugin-sdk";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runEventSourcePoll } from "../../src/services/inbox/event-source-runner.js";
import { resetEventSourceHealth } from "../../src/services/inbox/event-sources.js";
import { setPluginEventSourceBridge } from "../../src/services/plugins/plugin-event-source-registry.js";
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

type Outcome = PluginEventSourceFiring | PluginEventSourceProblem;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"], shouldAdvanceTime: true });
  vi.setSystemTime(Date.UTC(2026, 9, 30, 9));
});

afterEach(() => {
  setPluginEventSourceBridge(undefined);
  resetEventSourceHealth();
  vi.useRealTimers();
});

function trackerSource(
  check: (targets: readonly string[]) => Promise<readonly Outcome[]>,
  overrides: Partial<PluginEventSourceDeclaration> = {},
): PluginEventSourceDeclaration {
  return {
    family: "tracker",
    label: "A tracker ticket closes",
    keyFormat: "tracker:<ticket>",
    examples: ["tracker:T-1"],
    approval: "none",
    validate: (target) =>
      /^T-[0-9]+$/.test(target) ? null : "expected T-<number>",
    describe: (target) => `Ticket ${target} closes`,
    poll: { everyMs: MINUTE, check: (targets) => check(targets) },
    proof: null,
    ...overrides,
  };
}

function install(...sources: PluginEventSourceDeclaration[]): void {
  const records = sources.map((source) => ({
    pluginId: "tracker-plugin",
    source,
  }));

  setPluginEventSourceBridge({
    list: () => records,
    invoke: async (record, _label, run) => {
      expect(records).toContain(record);

      try {
        return { ok: true, value: await run() };
      } catch (error) {
        return {
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    },
  });
}

async function settle(world: InboxWorld): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
  await runQueuedMessageDispatch(world.harness.deps, {
    kind: "time-reached",
    now: Date.now(),
  });
  await new Promise((resolve) => setImmediate(resolve));
}

async function poll(world: InboxWorld, afterMs = 0): Promise<void> {
  vi.setSystemTime(Date.now() + afterMs);
  await runEventSourcePoll(world.harness.deps, Date.now());
  await settle(world);
}

function waitsOf(world: InboxWorld, thread: Thread) {
  return world.harness.db
    .select()
    .from(threadWaits)
    .where(eq(threadWaits.threadId, thread.id))
    .all();
}

function stallMarks(world: InboxWorld, thread: Thread) {
  return world.harness.db
    .select({ mark: threadWaitConditions.stallReceiptId })
    .from(threadWaitConditions)
    .innerJoin(threadWaits, eq(threadWaits.id, threadWaitConditions.waitId))
    .where(eq(threadWaits.threadId, thread.id))
    .all()
    .map((row) => row.mark);
}

function stallsOf(world: InboxWorld, thread: Thread) {
  return world.harness.db
    .select()
    .from(threadReceipts)
    .where(eq(threadReceipts.threadId, thread.id))
    .all()
    .filter((receipt) => receipt.cause === "stall")
    .map((receipt) => receipt.summary);
}

async function agentWait(
  world: InboxWorld,
  chat: Thread,
  key: string,
  events: string[],
): Promise<Response> {
  return agentRequest(world, chat.id, `/threads/${chat.id}/waits`, {
    key,
    for: "the ticket closes",
    events,
  });
}

async function waitingChat(
  world: InboxWorld,
  events: string[],
): Promise<Thread> {
  const chat = seedChat(world);

  await ownerSend(world, chat.id, "Tell me when the ticket closes");

  const turn = await startSubmittedTurn(world, chat.id);
  const response = await agentWait(world, chat, "ticket", events);

  expect(response.status).toBe(200);
  await endTurn(world, turn, "completed");

  return chat;
}

describe("event sources registered by plugins", () => {
  it("validates keys against the source and explains the format", async () => {
    await withTestHarness(async (harness) => {
      install(trackerSource(async () => []));

      const world = seedInboxWorld(harness, "host-es-validate");
      const chat = seedChat(world);
      const unknown = await agentWait(world, chat, "a", ["mail:inbox"]);

      expect(unknown.status).toBe(400);
      expect(JSON.stringify(await unknown.json())).toContain(
        "Installed: host-reconnect, coordinator-version, automation-run, tracker",
      );

      const malformed = await agentWait(world, chat, "b", ["tracker:42"]);

      expect(malformed.status).toBe(400);
      expect(JSON.stringify(await malformed.json())).toContain(
        "tracker:42: expected T-<number>. Format: tracker:<ticket>, for example tracker:T-1.",
      );
      expect((await agentWait(world, chat, "c", ["tracker:T-7"])).status).toBe(
        200,
      );
    });
  });

  it("polls pending targets on the source's cadence and resumes the waiter when one fires", async () => {
    await withTestHarness(async (harness) => {
      const closed = new Set<string>();

      const check = vi.fn(async (targets: readonly string[]) =>
        targets
          .filter((target) => closed.has(target))
          .map((target) => ({ target, result: `${target} closed.` })),
      );

      install(trackerSource(check));

      const world = seedInboxWorld(harness, "host-es-poll");
      const chat = await waitingChat(world, ["tracker:T-1"]);

      await poll(world);
      expect(check).toHaveBeenCalledWith(["T-1"]);
      expect(waitsOf(world, chat)[0]?.status).toBe("live");

      closed.add("T-1");
      await poll(world, 30_000);
      expect(check).toHaveBeenCalledTimes(1);

      await poll(world, 31_000);
      expect(check).toHaveBeenCalledTimes(2);
      expect(waitsOf(world, chat)[0]?.status).toBe("dispatched");
      expect(pendingSubmitCount(world, chat.id)).toBe(1);
    });
  });

  it("backs off a failing source and tells the waiting chat once after three failures", async () => {
    await withTestHarness(async (harness) => {
      let failing = true;

      const check = vi.fn(async () => {
        if (failing) throw new Error("tracker is offline");

        return [];
      });

      install(trackerSource(check));

      const world = seedInboxWorld(harness, "host-es-failing");
      const chat = await waitingChat(world, ["tracker:T-2"]);

      await poll(world);
      await poll(world, 2 * MINUTE);
      expect(stallsOf(world, chat)).toEqual([]);
      await poll(world, 3 * MINUTE);
      expect(check).toHaveBeenCalledTimes(2);
      await poll(world, 2 * MINUTE);
      expect(check).toHaveBeenCalledTimes(3);
      expect(stallsOf(world, chat)).toEqual([
        'Can\'t check "Ticket T-2 closes": tracker is offline',
      ]);
      expect(entryOf(await snapshot(world), chat.id)).toMatchObject({
        state: "needs-you",
        reason: {
          kind: "decision",
          text: 'Can\'t check "Ticket T-2 closes": tracker is offline',
        },
      });

      const sources = inboxEventSourcesResponseSchema.parse(
        await (
          await harness.app.request("/api/v1/inbox/events/sources")
        ).json(),
      ).sources;

      expect(
        sources.find((source) => source.family === "tracker"),
      ).toMatchObject({
        owner: "tracker-plugin",
        kind: "poll",
        pendingKeys: 1,
        health: {
          state: "failing",
          consecutiveFailures: 3,
          lastError: "tracker is offline",
        },
      });

      await poll(world, 8 * MINUTE);
      expect(stallsOf(world, chat)).toHaveLength(1);
      expect(stallMarks(world, chat)).toEqual([expect.any(String)]);

      failing = false;
      await poll(world, 16 * MINUTE);
      expect(waitsOf(world, chat)[0]?.status).toBe("live");
      expect(stallMarks(world, chat)).toEqual([null]);
      expect(
        inboxEventSourcesResponseSchema
          .parse(
            await (
              await harness.app.request("/api/v1/inbox/events/sources")
            ).json(),
          )
          .sources.find((source) => source.family === "tracker")?.health.state,
      ).toBe("ok");
    });
  });

  it("reports a target the source cannot check on that wait alone", async () => {
    await withTestHarness(async (harness) => {
      install(
        trackerSource(async (targets) =>
          targets
            .filter((target) => target === "T-404")
            .map((target) => ({ target, problem: "no such ticket" })),
        ),
      );

      const world = seedInboxWorld(harness, "host-es-problem");
      const missing = await waitingChat(world, ["tracker:T-404"]);
      const fine = await waitingChat(world, ["tracker:T-5"]);

      for (let round = 0; round < 3; round += 1) await poll(world, MINUTE);

      expect(stallsOf(world, missing)).toEqual([
        'Can\'t check "Ticket T-404 closes": no such ticket',
      ]);
      expect(stallsOf(world, fine)).toEqual([]);
    });
  });

  it("treats a malformed check result as a failure", async () => {
    await withTestHarness(async (harness) => {
      install(
        trackerSource(async () => [{ target: "T-1" } as unknown as Outcome]),
      );

      const world = seedInboxWorld(harness, "host-es-malformed");

      await waitingChat(world, ["tracker:T-1"]);
      await poll(world);

      const tracker = inboxEventSourcesResponseSchema
        .parse(
          await (
            await harness.app.request("/api/v1/inbox/events/sources")
          ).json(),
        )
        .sources.find((source) => source.family === "tracker");

      expect(tracker?.health.lastError).toContain("{ target, result }");
    });
  });

  it("lets only the owning plugin report a push source's event", async () => {
    await withTestHarness(async (harness) => {
      install(trackerSource(async () => [], { poll: null }));

      const world = seedInboxWorld(harness, "host-es-push");
      const chat = await waitingChat(world, ["tracker:T-3"]);

      const report = (pluginId: string) =>
        harness.app.request("/api/v1/inbox/events", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            [INBOX_CALLER_PLUGIN_HEADER]: pluginId,
          },
          body: JSON.stringify({ key: "tracker:T-3", result: "T-3 closed." }),
        });

      expect((await report("someone-else")).status).toBe(403);

      const reported = await report("tracker-plugin");

      expect(await reported.json()).toEqual({ resumed: 1 });
      await settle(world);
      expect(pendingSubmitCount(world, chat.id)).toBe(1);
    });
  });
});

describe("source proofs and owner approval", () => {
  it("refuses keys while the proof fails and re-tests it on a dry run", async () => {
    await withTestHarness(async (harness) => {
      let signedIn = false;

      install(
        trackerSource(async () => [], {
          proof: async () => {
            if (!signedIn) throw new Error("not signed in");

            return "signed in as alex";
          },
        }),
      );

      const world = seedInboxWorld(harness, "host-es-proof");
      const chat = seedChat(world);

      const dryRun = async () =>
        inboxEventCheckResponseSchema.parse(
          await (
            await ownerRequest(world, "/inbox/events/check", {
              key: "tracker:T-9",
            })
          ).json(),
        );

      expect(await dryRun()).toMatchObject({
        valid: false,
        error: "The tracker source cannot check keys: not signed in",
      });

      const refused = await agentWait(world, chat, "proof", ["tracker:T-9"]);

      expect(refused.status).toBe(400);
      expect(JSON.stringify(await refused.json())).toContain(
        "Fix that, then run omnyo wait check tracker:T-9 to test it again.",
      );

      signedIn = true;
      expect(await dryRun()).toMatchObject({
        valid: true,
        error: null,
        describe: "Ticket T-9 closes",
        kind: "poll",
        fired: false,
      });
      expect(
        (await agentWait(world, chat, "proof", ["tracker:T-9"])).status,
      ).toBe(200);
    });
  });

  it("turns an agent's wait on an owner-approved source into a watch proposal", async () => {
    await withTestHarness(async (harness) => {
      const check = vi.fn(async (targets: readonly string[]) =>
        targets.map((target) => ({ target, result: `${target} closed.` })),
      );

      install(trackerSource(check, { approval: "owner" }));

      const world = seedInboxWorld(harness, "host-es-approval");
      const chat = await waitingChat(world, ["tracker:T-4"]);

      expect(waitsOf(world, chat)[0]).toMatchObject({
        status: "proposed",
        proposalKind: "watch",
      });
      expect(
        world.harness.db
          .select()
          .from(threadReceipts)
          .where(eq(threadReceipts.threadId, chat.id))
          .all()
          .filter((receipt) => receipt.cause === "proposal")
          .map((receipt) => receipt.summary),
      ).toEqual([
        "The agent proposes watching: the ticket closes · Omnyo will check tracker:T-4",
      ]);

      await poll(world);
      expect(check).not.toHaveBeenCalled();

      const agentDryRun = inboxEventCheckResponseSchema.parse(
        await (
          await agentRequest(world, chat.id, "/inbox/events/check", {
            key: "tracker:T-4",
          })
        ).json(),
      );

      expect(agentDryRun).toMatchObject({
        valid: true,
        approval: "owner",
        fired: null,
      });
      expect(agentDryRun.error).toContain(
        "Only the owner can dry-run tracker keys.",
      );
      expect(check).not.toHaveBeenCalled();

      const ownerDryRun = inboxEventCheckResponseSchema.parse(
        await (
          await ownerRequest(world, "/inbox/events/check", {
            key: "tracker:T-4",
          })
        ).json(),
      );

      expect(ownerDryRun).toMatchObject({ fired: true, result: "T-4 closed." });

      const owned = await ownerRequest(world, `/threads/${chat.id}/waits`, {
        key: "owner-ticket",
        for: "the ticket closes",
        events: ["tracker:T-4"],
      });

      expect(owned.status).toBe(200);
      expect(
        waitsOf(world, chat).find((wait) => wait.key === "owner-ticket")
          ?.status,
      ).toBe("live");
    });
  });
});
