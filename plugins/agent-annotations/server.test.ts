import { describe, expect, it } from "vitest";
import { z } from "zod";
import { createFakePluginHost } from "@omnyo/plugin-sdk/testing";
import type { AnnotationRecord } from "./annotations.js";
import plugin from "./server.js";

const record: AnnotationRecord = {
  id: "mfx12abc",
  number: 1,
  comment: "Make this green",
  url: "http://localhost:5173/checkout",
  title: "Checkout",
  viewport: { width: 1280, height: 720 },
  element: {
    tagName: "button",
    name: 'button#pay "Pay now"',
    selector: "#pay",
    text: "Pay",
    attributes: { id: "pay" },
    rect: { x: 40, y: 300, width: 120, height: 36 },
    styles: {},
  },
  components: [{ name: "SubmitButton", source: "src/SubmitButton.tsx:12" }],
};

async function setup() {
  const { api, harness } = createFakePluginHost({
    pluginId: "agent-annotations",
  });

  await plugin(api);

  const provider = harness.registrations.mentionProviders.find(
    (candidate) => candidate.id === "annotation",
  );

  if (provider === undefined) {
    throw new Error("Expected the annotation mention provider.");
  }

  return { harness, provider };
}

describe("agent annotations server", () => {
  it("rehydrates exact immutable revisions without changing their saved context", async () => {
    const { harness } = await setup();

    const saved = z
      .object({ id: z.string() })
      .parse(await harness.callRpc("saveRevision", record));

    const revised = z.object({ id: z.string() }).parse(
      await harness.callRpc("revise", {
        id: saved.id,
        comment: "Updated after remount",
      }),
    );

    expect(
      await harness.callRpc("readRevisions", { ids: [saved.id, revised.id] }),
    ).toMatchObject([
      { id: saved.id, record: { comment: "Make this green" } },
      { id: revised.id, record: { comment: "Updated after remount" } },
    ]);
    await expect(
      harness.callRpc("readRevisions", {
        ids: Array.from({ length: 25 }, () => saved.id),
      }),
    ).rejects.toThrow();
  });
  it("stores saved annotations and resolves them as agent context", async () => {
    const { harness, provider } = await setup();

    const { id } = z
      .object({ id: z.string().min(1) })
      .parse(await harness.callRpc("save", record));

    expect(id).toBe(record.id);
    await harness.callRpc("update", { id, comment: "Make this blue" });
    const resolved = await provider.resolve(id);

    expect(resolved.context).toContain("# Browser annotation 1");
    expect(resolved.context).toContain("Make this blue");
    expect(resolved.context).not.toContain("Make this green");
    expect(resolved.context).toContain(
      "SubmitButton (src/SubmitButton.tsx:12)",
    );
    await expect(provider.resolve("missing")).rejects.toThrow(
      "This browser annotation is no longer available",
    );
  });

  it("preserves resolved immutable contexts while a note is revised during submission", async () => {
    const { harness, provider } = await setup();

    const saved = z
      .object({ id: z.string() })
      .parse(await harness.callRpc("saveRevision", record));

    const resolving = provider.resolve(saved.id);

    const edited = z.object({ id: z.string() }).parse(
      await harness.callRpc("revise", {
        id: saved.id,
        comment: "Edited while sending",
      }),
    );

    expect(edited.id).not.toBe(saved.id);
    expect((await resolving).context).toContain("Make this green");
    expect((await provider.resolve(saved.id)).context).toContain(
      "Make this green",
    );
    expect((await provider.resolve(edited.id)).context).toContain(
      "Edited while sending",
    );
    await expect(
      harness.callRpc("update", { id: saved.id, comment: "Overwrite" }),
    ).rejects.toThrow();
  });

  it("rejects updates to missing annotations and blank edits", async () => {
    const { harness } = await setup();
    await expect(
      harness.callRpc("update", { id: "missing", comment: "Updated" }),
    ).rejects.toThrow();
    await harness.callRpc("save", record);
    await expect(
      harness.callRpc("update", { id: record.id, comment: " " }),
    ).rejects.toThrow();
  });

  it("rejects malformed annotations at the rpc boundary", async () => {
    const { harness } = await setup();

    await expect(
      harness.callRpc("save", { ...record, comment: "   " }),
    ).rejects.toThrow();
  });
});
