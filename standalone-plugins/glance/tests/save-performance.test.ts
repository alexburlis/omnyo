import { expect, it } from "vitest";
import { createFakePluginHost } from "@omnyo/plugin-sdk/testing";
import { cardSchema } from "../contract.ts";
import { GlanceService } from "../lib/service.ts";

it("persists a plain card without full thread metadata or history reads", async () => {
  const host = createFakePluginHost({
    pluginId: "glance",
    sdk: {
      threads: {
        get: async () => {
          throw new Error("Full thread metadata is unavailable");
        },
        events: {
          list: async () => {
            throw new Error("Full history is unavailable");
          },
        },
      },
    },
  });

  host.harness.sdk.stub("threads.experimental_lookupCommandProofs", async () => ({
    threadId: "thread-1",
    proofs: [],
  }));

  try {
    const service = new GlanceService(host.api);

    const saved = await service.save(
      "thread-1",
      cardSchema.parse({
        status: "working",
        phase: "test",
        headline: "Saved without history",
      }),
      "tool",
    );

    expect(saved.view).toMatchObject({ revision: 1, card: { headline: "Saved without history" } });
    expect(service.read("thread-1").view).toEqual(saved.view);
    expect(host.harness.sdk.calls.map((call) => call.path)).toEqual([
      "threads.experimental_lookupCommandProofs",
    ]);
  } finally {
    await host.harness.dispose();
  }
});

it("keeps the previous revision when compact proof lookup fails", async () => {
  const host = createFakePluginHost({ pluginId: "glance" });
  host.harness.sdk.stub("threads.experimental_lookupCommandProofs", async () => ({
    threadId: "thread-1",
    proofs: [],
  }));

  try {
    const service = new GlanceService(host.api);

    const card = cardSchema.parse({
      status: "working",
      phase: "test",
      headline: "Original outcome",
    });

    await service.save("thread-1", card, "tool");
    const original = service.read("thread-1").view;
    host.harness.sdk.stub("threads.experimental_lookupCommandProofs", async () => {
      throw new Error("Proof lookup unavailable");
    });
    await expect(
      service.save("thread-1", { ...card, headline: "Replacement" }, "tool"),
    ).rejects.toThrow("Proof lookup unavailable");
    expect(service.read("thread-1").view).toEqual(original);
    expect(
      host.api.storage.database().prepare("SELECT COUNT(*) AS count FROM card_revisions").get(),
    ).toEqual({ count: 1 });
  } finally {
    await host.harness.dispose();
  }
});

it("does not recreate a card deleted while proof lookup is pending", async () => {
  const host = createFakePluginHost({ pluginId: "glance" });
  let release!: (result: { threadId: string; proofs: [] }) => void;
  host.harness.sdk.stub(
    "threads.experimental_lookupCommandProofs",
    () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  );

  try {
    const service = new GlanceService(host.api);

    const save = service.save(
      "thread-1",
      cardSchema.parse({ status: "working", phase: "test", headline: "Deleted during lookup" }),
      "tool",
    );

    const rejected = expect(save).rejects.toThrow("This chat was deleted");
    service.remove("thread-1");
    release({ threadId: "thread-1", proofs: [] });
    await rejected;
    expect(host.api.storage.database().prepare("SELECT COUNT(*) AS count FROM cards").get()).toEqual(
      { count: 0 },
    );
  } finally {
    await host.harness.dispose();
  }
});

it("does not commit a cancelled card after preview retention finishes", async () => {
  let release!: () => void;

  const host = createFakePluginHost({
    pluginId: "glance",
    sdk: {
      projects: {
        attachments: {
          experimental_retain: async () =>
            new Promise<void>((resolve) => {
              release = resolve;
            }),
        },
      },
    },
  });

  host.harness.sdk.stub("threads.experimental_lookupCommandProofs", async () => ({
    threadId: "thread-1",
    proofs: [],
  }));

  try {
    const service = new GlanceService(host.api);
    const controller = new AbortController();

    const save = service.save(
      "thread-1",
      cardSchema.parse({
        status: "working",
        phase: "test",
        headline: "Cancelled during retention",
        deliverables: [
          {
            title: "Preview",
            href: "preview.html",
            preview: {
              kind: "project-image",
              projectId: "project-1",
              path: "uploads/preview.png",
              mimeType: "image/png",
              alt: "Preview",
            },
          },
        ],
      }),
      "tool",
      controller.signal,
    );

    const rejected = expect(save).rejects.toThrow("Save cancelled");
    await new Promise(setImmediate);
    controller.abort(new Error("Save cancelled"));
    release();
    await rejected;
    expect(host.api.storage.database().prepare("SELECT COUNT(*) AS count FROM cards").get()).toEqual(
      { count: 0 },
    );
  } finally {
    await host.harness.dispose();
  }
});
