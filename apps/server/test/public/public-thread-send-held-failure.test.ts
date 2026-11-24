import { getThread, listQueuedThreadMessages } from "@omnyo/db";
import { INBOX_CALLER_THREAD_HEADER } from "@omnyo/domain";
import { z } from "zod";
import { afterEach, describe, expect, it, vi } from "vitest";
import { setPluginHookProvider } from "../../src/services/plugins/plugin-hook-registry.js";
import { parseStoredQueuedThreadMessageWaitingOn } from "../../src/services/threads/thread-queued-messages.js";
import {
  CAPACITY_TEST_PLUGIN_ID,
  DRAFTS_TEST_PLUGIN_ID,
  failuresOf,
  installCapacityHook,
  installDispatchHook,
  recheckDispatchHooks,
  seedFailedTurn,
} from "../helpers/dispatch-capacity.js";
import { listQueuedThreadCommands } from "../helpers/commands.js";
import { withTestHarness } from "../helpers/test-app.js";
import {
  ownerSend,
  pendingSubmitCount,
  seedChat,
  type InboxWorld,
} from "../inbox/inbox-driver.js";

const queuedSendSchema = z.object({
  ok: z.literal(true),
  delivery: z.literal("queued"),
  queuedMessage: z.object({ id: z.string() }),
});

afterEach(() => {
  setPluginHookProvider(undefined);
  vi.useRealTimers();
});

function submittedTexts(world: InboxWorld, threadId: string): string[] {
  return listQueuedThreadCommands(
    world.harness,
    "turn.submit",
    threadId,
  ).flatMap((command) =>
    command.type === "turn.submit"
      ? [
          command.input
            .flatMap((part) => (part.type === "text" ? [part.text] : []))
            .join("\n"),
        ]
      : [],
  );
}

function queuedIds(world: InboxWorld, threadId: string): string[] {
  return listQueuedThreadMessages(world.harness.db, threadId).map(
    (row) => row.id,
  );
}

async function ownerPost(
  world: InboxWorld,
  threadId: string,
  body: Record<string, unknown>,
): Promise<string> {
  const response = await world.harness.app.request(
    `/api/v1/threads/${threadId}/send`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    },
  );

  expect(response.status).toBe(200);

  return queuedSendSchema.parse(await response.json()).queuedMessage.id;
}

async function sendAsNonOwner(
  world: InboxWorld,
  targetId: string,
  sender: "agent" | "script",
): Promise<Response> {
  const source = seedChat(world);

  return world.harness.app.request(`/api/v1/threads/${targetId}/send`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(sender === "agent"
        ? { [INBOX_CALLER_THREAD_HEADER]: source.id }
        : {}),
    },
    body: JSON.stringify({
      input: [{ type: "text", text: "Here is the report", mentions: [] }],
      mode: "auto",
      ...(sender === "agent"
        ? { senderThreadId: source.id }
        : { messageSource: { kind: "script", label: "Nightly report" } }),
    }),
  });
}

describe("messages to a failed chat held by a dispatch hook", () => {
  it("sends the owner's message exactly once after capacity frees and resolves the failure for the owner", async () => {
    await withTestHarness(async (harness) => {
      const { world, chat } = await seedFailedTurn(
        harness,
        "host-send-capacity",
        "retry",
      );

      const { attempts, capacity } = installCapacityHook();

      const queued = queuedSendSchema.parse(
        await ownerSend(world, chat.id, "Try the smaller batch"),
      );

      expect(attempts).toEqual(["start-turn"]);
      const held = listQueuedThreadMessages(harness.db, chat.id);

      expect(held.map((row) => row.id)).toEqual([queued.queuedMessage.id]);
      expect(held[0]!.payloadKind).toBe("inline");
      expect(parseStoredQueuedThreadMessageWaitingOn(held[0]!)).toMatchObject({
        kind: "plugin",
        pluginId: CAPACITY_TEST_PLUGIN_ID,
      });
      expect(failuresOf(harness, chat.id)).toEqual([
        { state: "actionable", resolvedBy: null },
      ]);

      await recheckDispatchHooks(harness);

      expect(attempts).toEqual(["start-turn", "start-turn"]);
      expect(pendingSubmitCount(world, chat.id)).toBe(0);
      expect(
        listQueuedThreadMessages(harness.db, chat.id).map((row) => row.id),
      ).toEqual([queued.queuedMessage.id]);

      capacity.free = true;
      await recheckDispatchHooks(harness);

      expect(attempts).toEqual(["start-turn", "start-turn", "start-turn"]);
      expect(listQueuedThreadMessages(harness.db, chat.id)).toHaveLength(0);
      expect(submittedTexts(world, chat.id)).toEqual(["Try the smaller batch"]);
      expect(failuresOf(harness, chat.id)).toEqual([
        { state: "resolved", resolvedBy: "owner" },
      ]);

      await recheckDispatchHooks(harness);

      expect(submittedTexts(world, chat.id)).toEqual(["Try the smaller batch"]);
    });
  });

  it("sends the owner's message before an agent report that was held earlier", async () => {
    await withTestHarness(async (harness) => {
      const { world, chat } = await seedFailedTurn(
        harness,
        "host-send-capacity-order",
        "retry",
      );

      const { capacity } = installCapacityHook();
      const told = await sendAsNonOwner(world, chat.id, "agent");

      expect(told.status).toBe(200);
      const report = queuedSendSchema.parse(await told.json());

      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(Date.now() + 5);

      const owner = queuedSendSchema.parse(
        await ownerSend(world, chat.id, "Try the smaller batch"),
      );

      expect(queuedIds(world, chat.id)).toEqual([
        report.queuedMessage.id,
        owner.queuedMessage.id,
      ]);

      capacity.free = true;
      await recheckDispatchHooks(harness);

      expect(submittedTexts(world, chat.id)).toEqual(["Try the smaller batch"]);
      expect(queuedIds(world, chat.id)).toEqual([report.queuedMessage.id]);
      expect(failuresOf(harness, chat.id)).toEqual([
        { state: "resolved", resolvedBy: "owner" },
      ]);
    });
  });

  it("keeps the failure when the owner saves a draft, and sends nothing after capacity frees", async () => {
    await withTestHarness(async (harness) => {
      const { world, chat } = await seedFailedTurn(
        harness,
        "host-send-capacity-draft",
        "retry",
      );

      const { capacity } = installCapacityHook({ withDrafts: true });
      const told = await sendAsNonOwner(world, chat.id, "agent");

      expect(told.status).toBe(200);
      const report = queuedSendSchema.parse(await told.json());

      const draftId = await ownerPost(world, chat.id, {
        input: [{ type: "text", text: "Half-written idea", mentions: [] }],
        mode: "auto",
        pluginSubmission: {
          pluginId: DRAFTS_TEST_PLUGIN_ID,
          data: { kind: "draft" },
        },
      });

      const draft = listQueuedThreadMessages(harness.db, chat.id).find(
        (row) => row.id === draftId,
      );

      expect(
        draft === undefined
          ? null
          : parseStoredQueuedThreadMessageWaitingOn(draft),
      ).toMatchObject({ kind: "plugin", pluginId: DRAFTS_TEST_PLUGIN_ID });
      expect(failuresOf(harness, chat.id)).toEqual([
        { state: "actionable", resolvedBy: null },
      ]);

      capacity.free = true;
      await recheckDispatchHooks(harness);
      await recheckDispatchHooks(harness);

      expect(pendingSubmitCount(world, chat.id)).toBe(0);
      expect(queuedIds(world, chat.id).sort()).toEqual(
        [report.queuedMessage.id, draftId].sort(),
      );
      expect(getThread(harness.db, chat.id)?.status).toBe("error");
      expect(failuresOf(harness, chat.id)).toEqual([
        { state: "actionable", resolvedBy: null },
      ]);
    });
  });

  it("keeps the failure when the owner deletes the held message before it sends", async () => {
    await withTestHarness(async (harness) => {
      const { world, chat } = await seedFailedTurn(
        harness,
        "host-send-capacity-deleted",
        "retry",
      );

      const { capacity } = installCapacityHook();

      const owner = queuedSendSchema.parse(
        await ownerSend(world, chat.id, "Try the smaller batch"),
      );

      const deleted = await harness.app.request(
        `/api/v1/threads/${chat.id}/queued-messages/${owner.queuedMessage.id}`,
        { method: "DELETE" },
      );

      expect(deleted.status).toBe(200);
      expect(queuedIds(world, chat.id)).toEqual([]);

      capacity.free = true;
      await recheckDispatchHooks(harness);

      expect(pendingSubmitCount(world, chat.id)).toBe(0);
      expect(getThread(harness.db, chat.id)?.status).toBe("error");
      expect(failuresOf(harness, chat.id)).toEqual([
        { state: "actionable", resolvedBy: null },
      ]);
    });
  });

  it("keeps the failure when a dispatch hook holds a message the owner scheduled for later", async () => {
    await withTestHarness(async (harness) => {
      const { world, chat } = await seedFailedTurn(
        harness,
        "host-send-capacity-scheduled",
        "retry",
      );

      const { capacity } = installCapacityHook();

      const scheduledId = await ownerPost(world, chat.id, {
        input: [{ type: "text", text: "later", mentions: [] }],
        mode: "queue-if-active",
        sendAt: Date.now() + 60 * 60 * 1000,
      });

      expect(queuedIds(world, chat.id)).toEqual([scheduledId]);
      expect(failuresOf(harness, chat.id)).toEqual([
        { state: "actionable", resolvedBy: null },
      ]);

      capacity.free = true;
      await recheckDispatchHooks(harness);

      expect(pendingSubmitCount(world, chat.id)).toBe(0);
      expect(failuresOf(harness, chat.id)).toEqual([
        { state: "actionable", resolvedBy: null },
      ]);
    });
  });

  it.each(["agent", "script"] as const)(
    "keeps a held %s message behind the failure after capacity frees",
    async (sender) => {
      await withTestHarness(async (harness) => {
        const { world, chat } = await seedFailedTurn(
          harness,
          `host-send-capacity-${sender}`,
          "retry",
        );

        const { attempts, capacity } = installCapacityHook();
        const told = await sendAsNonOwner(world, chat.id, sender);

        expect(told.status).toBe(200);
        const queued = queuedSendSchema.parse(await told.json());

        expect(attempts).toEqual(["start-turn"]);
        expect(failuresOf(harness, chat.id)).toEqual([
          { state: "actionable", resolvedBy: null },
        ]);

        capacity.free = true;
        await recheckDispatchHooks(harness);

        expect(pendingSubmitCount(world, chat.id)).toBe(0);
        expect(
          listQueuedThreadMessages(harness.db, chat.id).map((row) => row.id),
        ).toEqual([queued.queuedMessage.id]);
        expect(getThread(harness.db, chat.id)?.status).toBe("error");
        expect(failuresOf(harness, chat.id)).toEqual([
          { state: "actionable", resolvedBy: null },
        ]);
      });
    },
  );

  it("keeps the failure when a dispatch hook rejects the owner's message", async () => {
    await withTestHarness(async (harness) => {
      const { world, chat } = await seedFailedTurn(
        harness,
        "host-send-capacity-rejected",
        "retry",
      );

      installDispatchHook(() => ({
        action: "reject",
        message: "Capacity is closed",
      }));

      const refused = await harness.app.request(
        `/api/v1/threads/${chat.id}/send`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            input: [{ type: "text", text: "Try again", mentions: [] }],
            mode: "auto",
          }),
        },
      );

      expect(refused.status).not.toBe(200);
      expect(listQueuedThreadMessages(harness.db, chat.id)).toHaveLength(0);
      expect(pendingSubmitCount(world, chat.id)).toBe(0);
      expect(failuresOf(harness, chat.id)).toEqual([
        { state: "actionable", resolvedBy: null },
      ]);
    });
  });
});
