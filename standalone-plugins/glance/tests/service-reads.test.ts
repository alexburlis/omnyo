import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createFakePluginHost,
  makeThreadResponse,
  type FakePluginHost,
} from "@omnyo/plugin-sdk/testing";
import type { PluginApi } from "@omnyo/plugin-sdk";
import { cardSchema } from "../contract";
import { GlanceService } from "../lib/service";

type EventRow = Awaited<ReturnType<PluginApi["sdk"]["threads"]["events"]["list"]>>[number];

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;

  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });

  return { promise, resolve, reject };
}

function cursor(seq: number): EventRow[] {
  return [
    {
      id: `event-${seq}`,
      threadId: "thread-1",
      seq,
      scope: { kind: "turn", turnId: "turn-1" },
      type: "turn/started",
      data: { providerThreadId: "provider-1" },
      createdAt: seq,
    },
  ];
}

const hosts: FakePluginHost[] = [];

const emptyProofLookup = async (
  input: Parameters<PluginApi["sdk"]["threads"]["experimental_lookupCommandProofs"]>[0],
) => ({
  threadId: input.threadId,
  proofs: input.selectors.map(() => ({ status: "missing" })),
});

afterEach(async () => {
  for (const host of hosts.splice(0)) await host.harness.dispose();
});

describe("Glance service current reads", () => {
  it("retains every preview with its explicit source project and owning thread before saving", async () => {
    const retain = vi.fn(async () => {});
    const list = vi.fn(async (): Promise<EventRow[]> => []);

    const host = createFakePluginHost({
      pluginId: "glance",
      sdk: {
        threads: {
          get: async () => makeThreadResponse({ id: "thread-1", projectId: "project-thread" }),
          events: { list },
        },
        projects: { attachments: { experimental_retain: retain } },
      },
    });

    hosts.push(host);
    host.harness.sdk.stub("threads.experimental_lookupCommandProofs", emptyProofLookup);
    const service = new GlanceService(host.api);

    const previews = [
      { projectId: "project-a", path: "uploads/same.png" },
      { projectId: "project-b", path: "uploads/same.png" },
      { projectId: "project-a", path: "uploads/same.png" },
      { projectId: "project-a", path: "uploads/later.png" },
      { projectId: "project-b", path: "uploads/last.png" },
      { projectId: "project-b", path: "uploads/same.png" },
      { projectId: "project-a", path: "uploads/same.png" },
      { projectId: "project-b", path: "uploads/final.png" },
    ];

    await service.save(
      "thread-1",
      cardSchema.parse({
        status: "working",
        phase: "test",
        headline: "Review retained previews",
        deliverables: previews.map((preview, index) => ({
          title: `Preview ${index}`,
          href: `preview-${index}.html`,
          preview: {
            kind: "project-image",
            mimeType: "image/png",
            alt: `Preview ${index}`,
            ...preview,
          },
        })),
      }),
      "cli",
    );

    expect(retain.mock.calls).toEqual([
      [
        {
          projectId: "project-a",
          threadId: "thread-1",
          paths: ["uploads/same.png", "uploads/later.png"],
        },
      ],
      [
        {
          projectId: "project-b",
          threadId: "thread-1",
          paths: ["uploads/same.png", "uploads/last.png", "uploads/final.png"],
        },
      ],
    ]);
    expect(service.read("thread-1").view?.card.deliverables).toHaveLength(8);
    expect(list).not.toHaveBeenCalled();
    retain.mockClear();

    await service.save(
      "thread-1",
      cardSchema.parse({ status: "working", phase: "test", headline: "A plain update" }),
      "cli",
    );
    expect(retain).not.toHaveBeenCalled();
  });

  it("keeps the previous card and revisions when retaining a later source project fails", async () => {
    const retain = vi.fn(async () => {});
    const list = vi.fn(async (): Promise<EventRow[]> => []);

    const host = createFakePluginHost({
      pluginId: "glance",
      sdk: {
        threads: { get: async () => makeThreadResponse({ id: "thread-1" }), events: { list } },
        projects: { attachments: { experimental_retain: retain } },
      },
    });

    hosts.push(host);
    host.harness.sdk.stub("threads.experimental_lookupCommandProofs", emptyProofLookup);
    const service = new GlanceService(host.api);
    await service.save(
      "thread-1",
      cardSchema.parse({ status: "working", phase: "build", headline: "Previous card" }),
      "cli",
    );

    const before = service.read("thread-1").view;
    const database = host.api.storage.database();

    const revisions = database
      .prepare("SELECT * FROM card_revisions WHERE thread_id = ? ORDER BY revision")
      .all("thread-1");

    retain
      .mockImplementationOnce(async () => {})
      .mockRejectedValueOnce(new Error("Second project retention failed"));
    list.mockClear();

    await expect(
      service.save(
        "thread-1",
        cardSchema.parse({
          status: "working",
          phase: "test",
          headline: "Unretained replacement",
          deliverables: ["project-a", "project-b"].map((projectId) => ({
            title: projectId,
            href: "preview.html",
            preview: {
              kind: "project-image",
              projectId,
              path: "uploads/result.png",
              mimeType: "image/png",
              alt: "Result",
            },
          })),
          proof: [
            {
              kind: "reproduced",
              claim: "Must not read history after failed retention",
              command: "unused proof command",
            },
          ],
        }),
        "tool",
      ),
    ).rejects.toThrow("Second project retention failed");

    expect(retain).toHaveBeenCalledTimes(2);
    expect(service.read("thread-1").view).toEqual(before);
    expect(
      database
        .prepare("SELECT * FROM card_revisions WHERE thread_id = ? ORDER BY revision")
        .all("thread-1"),
    ).toEqual(revisions);
    expect(list).not.toHaveBeenCalled();
  });

  it("keeps the card absent when preview retention rejects its owner", async () => {
    const retain = vi.fn(async () => {
      throw new Error("Chat not found");
    });

    const host = createFakePluginHost({
      pluginId: "glance",
      sdk: {
        threads: { get: async () => makeThreadResponse({ id: "another-thread" }) },
        projects: { attachments: { experimental_retain: retain } },
      },
    });

    hosts.push(host);
    host.harness.sdk.stub("threads.experimental_lookupCommandProofs", async () => ({
      threadId: "another-thread",
      proofs: [],
    }));
    const service = new GlanceService(host.api);
    await expect(
      service.save(
        "thread-1",
        cardSchema.parse({
          status: "working",
          phase: "test",
          headline: "Invalid owner",
          deliverables: [
            {
              title: "Result",
              href: "preview.html",
              preview: {
                kind: "project-image",
                projectId: "project-a",
                path: "uploads/result.png",
                mimeType: "image/png",
                alt: "Result",
              },
            },
          ],
        }),
        "cli",
      ),
    ).rejects.toThrow("Chat not found");
    expect(retain).toHaveBeenCalledTimes(1);
    expect(host.harness.sdk.callsTo("threads.experimental_lookupCommandProofs")).toHaveLength(0);
    expect(service.read("thread-1").view).toBeNull();
  });

  it("projects only two durable image references without history reads or read acknowledgements", async () => {
    const get = vi.fn(async () => makeThreadResponse({ id: "thread-1" }));
    const list = vi.fn(async (): Promise<EventRow[]> => []);

    const host = createFakePluginHost({
      pluginId: "glance",
      sdk: {
        threads: { get, events: { list } },
        projects: { attachments: { experimental_retain: async () => {} } },
      },
    });

    hosts.push(host);
    host.harness.sdk.stub("threads.experimental_lookupCommandProofs", emptyProofLookup);
    const service = new GlanceService(host.api);
    await service.save(
      "thread-1",
      cardSchema.parse({
        status: "working",
        phase: "test",
        headline: "Visual review",
        deliverables: [0, 1, 2].map((index) => ({
          title: `Preview ${index}`,
          href: `preview-${index}.html`,
          preview: {
            kind: "project-image",
            projectId: `project-${index}`,
            path: `uploads/preview-${index}.png`,
            mimeType: "image/png",
            alt: `Preview ${index}`,
          },
        })),
      }),
      "cli",
    );
    get.mockClear();
    list.mockClear();
    const entry = service.index().cards[0];
    expect(entry?.visuals.map((visual) => visual.preview.projectId)).toEqual([
      "project-0",
      "project-1",
    ]);
    expect(entry?.unseen).toBe(true);
    expect(service.index().cards[0]?.unseen).toBe(true);
    expect(get).not.toHaveBeenCalled();
    expect(list).not.toHaveBeenCalled();
  });
  it("reads the stored card without waiting for thread or history APIs", async () => {
    const get = vi.fn(async () => makeThreadResponse({ id: "thread-1" }));
    const list = vi.fn(() => new Promise<EventRow[]>(() => {}));

    const host = createFakePluginHost({
      pluginId: "glance",
      sdk: { threads: { get, events: { list } } },
    });

    hosts.push(host);
    host.harness.sdk.stub("threads.experimental_lookupCommandProofs", emptyProofLookup);
    const service = new GlanceService(host.api);
    await service.save(
      "thread-1",
      cardSchema.parse({ status: "working", phase: "build", headline: "Stored outcome" }),
      "cli",
    );
    get.mockClear();
    expect(service.read("thread-1")).toMatchObject({
      view: { revision: 1, card: { headline: "Stored outcome" } },
    });
    expect(get).not.toHaveBeenCalled();
    expect(list).not.toHaveBeenCalled();
    service.remove("thread-1");
    expect(() => service.read("thread-1")).toThrow("This chat was deleted");
  });
  it.each(["thread", "cursor"] as const)(
    "starts independent reads together and waits for both when %s finishes first",
    async (first) => {
      const thread = deferred<ReturnType<typeof makeThreadResponse>>();
      const events = deferred<EventRow[]>();
      const getThread = vi.fn(() => thread.promise);
      const list = vi.fn(() => events.promise);

      const host = createFakePluginHost({
        pluginId: "glance",
        sdk: { threads: { get: getThread, events: { list } } },
      });

      hosts.push(host);
      host.harness.sdk.stub("threads.experimental_lookupCommandProofs", emptyProofLookup);
      const service = new GlanceService(host.api);
      let settled = false;

      const read = service.get("thread-1").then((value) => {
        settled = true;

        return value;
      });

      try {
        expect(getThread).toHaveBeenCalledTimes(1);
        expect(list).toHaveBeenCalledTimes(1);

        if (first === "thread") thread.resolve(makeThreadResponse({ id: "thread-1" }));
        else events.resolve(cursor(42));
        await new Promise(setImmediate);
        expect(settled).toBe(false);
      } finally {
        thread.resolve(makeThreadResponse({ id: "thread-1" }));
        events.resolve(cursor(42));
        await read;
      }

      expect(await read).toEqual({ view: null, conversationSeq: 42 });
    },
  );

  it.each(["unavailable", "mismatched", "deleted"] as const)(
    "preserves %s validation errors when the cursor already failed",
    async (failure) => {
      const thread = deferred<ReturnType<typeof makeThreadResponse>>();
      const events = deferred<EventRow[]>();

      const host = createFakePluginHost({
        pluginId: "glance",
        sdk: { threads: { get: () => thread.promise, events: { list: () => events.promise } } },
      });

      hosts.push(host);
      host.harness.sdk.stub("threads.experimental_lookupCommandProofs", emptyProofLookup);
      const service = new GlanceService(host.api);
      const validationError = new Error("Thread validation unavailable");
      const read = service.get("thread-1").catch((error) => error);

      events.reject(new Error("Cursor unavailable"));
      await new Promise(setImmediate);

      if (failure === "unavailable") thread.reject(validationError);
      else {
        if (failure === "deleted") service.remove("thread-1");
        thread.resolve(makeThreadResponse({ id: failure === "mismatched" ? "other" : "thread-1" }));
      }

      if (failure === "unavailable") expect(await read).toBe(validationError);
      else expect(await read).toEqual(new Error("Chat not found"));
    },
  );

  it("propagates cursor failure after valid thread validation", async () => {
    const cursorError = new Error("Cursor unavailable");

    const host = createFakePluginHost({
      pluginId: "glance",
      sdk: {
        threads: {
          get: async ({ threadId }) => makeThreadResponse({ id: threadId }),
          events: {
            list: async () => {
              throw cursorError;
            },
          },
        },
      },
    });

    hosts.push(host);
    host.harness.sdk.stub("threads.experimental_lookupCommandProofs", emptyProofLookup);
    await expect(new GlanceService(host.api).get("thread-1")).rejects.toBe(cursorError);
  });

  it("rejects deletion during a cursor read and never reads known-deleted chats", async () => {
    const events = deferred<EventRow[]>();

    const getThread = vi.fn(async ({ threadId }: { threadId: string }) =>
      makeThreadResponse({ id: threadId }),
    );

    const list = vi.fn(() => events.promise);

    const host = createFakePluginHost({
      pluginId: "glance",
      sdk: { threads: { get: getThread, events: { list } } },
    });

    hosts.push(host);
    host.harness.sdk.stub("threads.experimental_lookupCommandProofs", emptyProofLookup);
    const service = new GlanceService(host.api);
    const read = service.get("thread-1");
    const rejected = expect(read).rejects.toThrow("This chat was deleted");

    await new Promise(setImmediate);
    service.remove("thread-1");
    events.resolve(cursor(42));
    await rejected;
    getThread.mockClear();
    list.mockClear();
    await expect(service.get("thread-1")).rejects.toThrow("This chat was deleted");
    await expect(service.diff("thread-1")).rejects.toThrow("This chat was deleted");
    expect(getThread).not.toHaveBeenCalled();
    expect(list).not.toHaveBeenCalled();
  });

  it("shares concurrent thread reads, invalidates on mutation and never reuses a settled cursor", async () => {
    let block = false;
    const cursors: ReturnType<typeof deferred<EventRow[]>>[] = [];

    const getThread = vi.fn(async ({ threadId }: { threadId: string }) =>
      makeThreadResponse({ id: threadId }),
    );

    const host = createFakePluginHost({
      pluginId: "glance",
      sdk: {
        threads: {
          get: getThread,
          events: {
            list: async (input) => {
              if (input.types) return [];

              if (!block) return cursor(30);
              const read = deferred<EventRow[]>();
              cursors.push(read);

              return read.promise;
            },
          },
        },
      },
    });

    hosts.push(host);
    host.harness.sdk.stub("threads.experimental_lookupCommandProofs", emptyProofLookup);
    const service = new GlanceService(host.api);
    const card = cardSchema.parse({ status: "working", phase: "build", headline: "First outcome" });
    await service.save("thread-1", card, "cli");
    getThread.mockClear();
    block = true;

    const first = service.get("thread-1");
    const firstDiff = service.diff("thread-1");
    await vi.waitFor(() => expect(cursors).toHaveLength(1));
    expect(getThread).toHaveBeenCalledTimes(1);

    await service.save("thread-1", { ...card, headline: "Current outcome" }, "cli");
    const current = service.get("thread-1");
    await vi.waitFor(() => expect(cursors).toHaveLength(2));
    cursors[0]?.resolve(cursor(10));
    await Promise.all([first, firstDiff]);
    const currentDiff = service.diff("thread-1");
    expect(getThread).toHaveBeenCalledTimes(2);
    cursors[1]?.resolve(cursor(20));
    const [view, changes] = await Promise.all([current, currentDiff]);
    expect(view).toMatchObject({
      view: { revision: 2, card: { headline: "Current outcome" } },
      conversationSeq: 20,
    });
    expect(changes).toMatchObject({ revision: 2, conversationSeq: 20 });

    block = false;
    expect((await service.get("thread-1")).conversationSeq).toBe(30);
    expect(getThread).toHaveBeenCalledTimes(3);
    service.markSeen("thread-1", 2, 30);
  });
});
