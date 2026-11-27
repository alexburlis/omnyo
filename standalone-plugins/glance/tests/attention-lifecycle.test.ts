import { expect, it } from "vitest";
import { createFakePluginHost, makeThreadResponse } from "@omnyo/plugin-sdk/testing";
import type { PluginApi } from "@omnyo/plugin-sdk";
import { cardSchema } from "../contract";
import { GlanceService } from "../lib/service";

const emptyProofLookup = async (
  input: Parameters<PluginApi["sdk"]["threads"]["experimental_lookupCommandProofs"]>[0],
) => ({
  threadId: input.threadId,
  proofs: input.selectors.map(() => ({ status: "missing" as const })),
});

it("retires an old Needs you card when the thread becomes active before its turn start is recorded, while preserving a fresh status", async () => {
  const host = createFakePluginHost({
    pluginId: "glance",
    sdk: {
      threads: {
        get: async ({ threadId }) => makeThreadResponse({ id: threadId }),
        events: { list: async () => [] },
        experimental_lookupCommandProofs: emptyProofLookup,
      },
    },
  });

  try {
    const service = new GlanceService(host.api);

    const card = cardSchema.parse({
      status: "needs-you",
      phase: "build",
      headline: "Select a direction",
    });

    const saved = await service.save("thr_one", card, "tool");
    const activeAt = (saved.view?.updatedAt ?? 0) + 1;
    expect(
      (
        await host.harness.emitThreadEvent("thread.active", {
          thread: makeThreadResponse({ id: "thr_one", status: "active", updatedAt: activeAt }),
        })
      ).errors,
    ).toEqual([]);
    expect(service.read("thr_one").view?.staleSince).toBe(activeAt);
    await service.save("thr_one", card, "tool");
    await host.harness.emitThreadEvent("thread.active", {
      thread: makeThreadResponse({ id: "thr_one", status: "active", updatedAt: 0 }),
    });
    expect(service.read("thr_one").view?.staleSince).toBeNull();
  } finally {
    await host.harness.dispose();
  }
});

it("sends each changed card's index entry with its realtime signal", async () => {
  const host = createFakePluginHost({
    pluginId: "glance",
    sdk: {
      threads: {
        get: async ({ threadId }) => makeThreadResponse({ id: threadId }),
        events: { list: async () => [] },
        experimental_lookupCommandProofs: emptyProofLookup,
      },
    },
  });

  try {
    const service = new GlanceService(host.api);

    const saved = await service.save(
      "thr_one",
      cardSchema.parse({ status: "needs-you", phase: "build", headline: "Select a direction" }),
      "tool",
    );

    await new Promise((resolve) => setTimeout(resolve, 70));
    expect(host.harness.realtimeSignals.at(-1)?.payload).toEqual({
      threadId: "thr_one",
      revision: 1,
      entry: service.index().cards[0],
    });
    expect(service.index().cards[0]).toMatchObject({ status: "needs-you", stale: false });
    await host.harness.emitThreadEvent("thread.active", {
      thread: makeThreadResponse({
        id: "thr_one",
        status: "active",
        updatedAt: (saved.view?.updatedAt ?? 0) + 1,
      }),
    });
    await new Promise((resolve) => setTimeout(resolve, 70));
    expect(host.harness.realtimeSignals.at(-1)?.payload).toMatchObject({
      threadId: "thr_one",
      entry: { status: "needs-you", stale: true },
    });
  } finally {
    await host.harness.dispose();
  }
});
