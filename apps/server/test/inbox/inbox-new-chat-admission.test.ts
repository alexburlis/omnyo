import type { InboxSnapshot } from "@omnyo/domain";
import { afterEach, describe, expect, it } from "vitest";
import {
  invokePluginInline,
  setPluginHookProvider,
} from "../../src/services/plugins/plugin-hook-registry.js";
import { withTestHarness } from "../helpers/test-app.js";
import { entryOf, seedInboxWorld, snapshot } from "./inbox-driver.js";

afterEach(() => setPluginHookProvider(undefined));

function installSlowDispatchHook(delayMs: number): void {
  setPluginHookProvider({
    listHooks: (hook) =>
      hook === "message.dispatch"
        ? [
            {
              pluginId: "slow-dispatch-test",
              handler: async () => {
                await new Promise((resolve) => setTimeout(resolve, delayMs));

                return { action: "proceed" as const };
              },
            },
          ]
        : [],
    invokeHook: (_pluginId, _label, run) => invokePluginInline(run),
    decisionTimeoutMs: 10_000,
  });
}

function rootIds(inbox: InboxSnapshot): string[] {
  return [...inbox.inbox, ...inbox.waiting, ...inbox.running, ...inbox.shelf]
    .map((entry) => entry.threadId)
    .sort();
}

describe("new chat admission in the Inbox", () => {
  it("leaves a scheduled new chat out of the Inbox until its first message is admitted, then lists it as Scheduled", async () => {
    await withTestHarness(async (harness) => {
      installSlowDispatchHook(300);
      const world = seedInboxWorld(harness, "host-new-chat-admission");
      const seen: string[][] = [];
      let done = false;

      const poller = (async () => {
        while (!done) {
          seen.push(rootIds(await snapshot(world)));
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
      })();

      const created = await harness.app.request("/api/v1/threads", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          projectId: world.projectId,
          providerId: "codex",
          origin: "app",
          input: [{ type: "text", text: "Scheduled new chat", mentions: [] }],
          sendAt: Date.now() + 10 * 60 * 1000,
          environment: { type: "reuse", environmentId: world.environmentId },
        }),
      });

      done = true;
      await poller;
      expect(created.status).toBe(201);
      const { id } = (await created.json()) as { id: string };

      expect(seen.length).toBeGreaterThan(3);
      expect(seen.every((ids) => !ids.includes(id))).toBe(true);

      const listed = entryOf(await snapshot(world), id);
      expect(listed?.view).toBe("waiting");
      expect(listed?.waiting?.returnAt).not.toBeNull();
    });
  });
});
