import { getLatestThreadSequence, getThread, threadFailures } from "@omnyo/db";
import type {
  MessageDispatchHookContext,
  PluginHookName,
} from "@omnyo/plugin-sdk";
import { eq } from "drizzle-orm";
import { expect, vi } from "vitest";
import { runInboxSweep } from "../../src/services/inbox/sweep.js";
import {
  invokePluginInline,
  setPluginHookProvider,
  type PluginHookRegistration,
} from "../../src/services/plugins/plugin-hook-registry.js";
import { runQueuedMessageDispatch } from "../../src/services/threads/queued-message-dispatch.js";
import {
  endTurn,
  ownerSend,
  pendingSubmitCount,
  seedChat,
  seedInboxWorld,
  startSubmittedTurn,
} from "../inbox/inbox-driver.js";
import { seedEvent } from "./seed.js";
import type { TestAppHarness } from "./test-app.js";

export const CAPACITY_TEST_PLUGIN_ID = "capacity-test";

export const DRAFTS_TEST_PLUGIN_ID = "drafts-test";

type HookRegistry = {
  [K in PluginHookName]: PluginHookRegistration<K>[];
};

type DispatchHookHandler = (
  context: MessageDispatchHookContext,
) =>
  | { action: "proceed" }
  | { action: "wait"; reason: string }
  | { action: "reject"; message: string };

function installDispatchHooks(
  hooks: readonly { pluginId: string; handler: DispatchHookHandler }[],
): void {
  const registry: HookRegistry = { "message.dispatch": [...hooks] };

  setPluginHookProvider({
    listHooks: (hook) => registry[hook],
    invokeHook: (_pluginId, _label, run) => invokePluginInline(run),
    decisionTimeoutMs: 10_000,
  });
}

export function installDispatchHook(handler: DispatchHookHandler): void {
  installDispatchHooks([{ pluginId: CAPACITY_TEST_PLUGIN_ID, handler }]);
}

const draftsTestHook: DispatchHookHandler = (context) => {
  const submission = context.experimental_submission;

  const isNewDraft =
    submission?.pluginId === DRAFTS_TEST_PLUGIN_ID &&
    submission.data !== null &&
    typeof submission.data === "object" &&
    !Array.isArray(submission.data) &&
    submission.data.kind === "draft";

  const waitingOn = context.queuedMessages[0]?.waitingOn;

  const isQueuedDraft =
    waitingOn?.kind === "plugin" &&
    waitingOn.pluginId === DRAFTS_TEST_PLUGIN_ID;

  return isNewDraft || isQueuedDraft
    ? { action: "wait", reason: "Draft" }
    : { action: "proceed" };
};

export function installCapacityHook(
  options: { withDrafts: boolean } = { withDrafts: false },
) {
  const attempts: string[] = [];
  const capacity = { free: false };

  installDispatchHooks([
    ...(options.withDrafts
      ? [{ pluginId: DRAFTS_TEST_PLUGIN_ID, handler: draftsTestHook }]
      : []),
    {
      pluginId: CAPACITY_TEST_PLUGIN_ID,
      handler: (context) => {
        attempts.push(context.attempt);

        return capacity.free
          ? { action: "proceed" }
          : { action: "wait", reason: "14 of 14 running on host Mac Pro" };
      },
    },
  ]);

  return { attempts, capacity };
}

export async function recheckDispatchHooks(
  harness: TestAppHarness,
): Promise<void> {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(Date.now() + 1_001);
  await runQueuedMessageDispatch(harness.deps, { kind: "plugin-recheck" });
}

export function failuresOf(harness: TestAppHarness, threadId: string) {
  return harness.db
    .select({
      state: threadFailures.state,
      resolvedBy: threadFailures.resolvedBy,
    })
    .from(threadFailures)
    .where(eq(threadFailures.threadId, threadId))
    .all();
}

export async function seedFailedTurn(
  harness: TestAppHarness,
  hostId: string,
  action: "retry" | "continue",
) {
  const world = seedInboxWorld(harness, hostId);
  const chat = seedChat(world);

  await ownerSend(world, chat.id, "Run the migration");
  const turn = await startSubmittedTurn(world, chat.id);

  await endTurn(world, turn, "failed");
  await runInboxSweep(harness.deps, Date.now() + 31_000);

  if (action === "continue") {
    const providerThreadId = world.providerThreadIds.get(chat.id);

    if (providerThreadId === undefined)
      throw new Error("Expected the chat's provider thread");
    seedEvent(harness.deps, {
      threadId: chat.id,
      environmentId: world.environmentId,
      providerThreadId,
      sequence: getLatestThreadSequence(harness.db, { threadId: chat.id }) + 1,
      type: "turn/completed",
      scope: { kind: "turn", turnId: turn.turnId },
      data: { providerThreadId, status: "completed" },
    });
  }

  expect(getThread(harness.db, chat.id)?.status).toBe("error");
  expect(failuresOf(harness, chat.id)).toEqual([
    { state: "actionable", resolvedBy: null },
  ]);
  expect(pendingSubmitCount(world, chat.id)).toBe(0);

  return { world, chat };
}
