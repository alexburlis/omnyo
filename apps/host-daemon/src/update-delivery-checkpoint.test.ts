import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { threadScope } from "@omnyo/domain";
import { afterEach, describe, expect, it } from "vitest";
import {
  UpdateDeliveryCheckpoint,
  UPDATE_DELIVERY_CHECKPOINT_FILE,
  type PendingDeliveryEvent,
  type PendingInteractiveInterruptRequest,
} from "./update-delivery-checkpoint.js";

const roots: string[] = [];

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "omnyo-update-checkpoint-"));
  roots.push(root);

  return root;
}

function event(threadId: string, index = 1): PendingDeliveryEvent {
  return {
    instanceId: "instance-origin",
    index,
    blockedReason: null,
    envelope: {
      threadId,
      event: {
        type: "system/error",
        threadId,
        scope: threadScope(),
        message: "provider ended",
      },
    },
  };
}

function interrupt(): PendingInteractiveInterruptRequest {
  return {
    deliveryId: randomUUID(),
    providerId: "codex",
    reason: "provider exited",
    threadIds: ["thread-1"],
    requests: [
      {
        interactionId: "interaction-1",
        threadId: "thread-1",
        turnId: "turn-1",
        providerThreadId: "provider-thread-1",
        providerRequestId: "provider-request-1",
      },
    ],
  };
}

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("worker update delivery checkpoint", () => {
  it("restores both queues with their original identities and retires only acknowledged records", async () => {
    const root = await fixture();
    const first = event("thread-1");
    const second = event("thread-2", 2);
    const notice = interrupt();
    const checkpoint = new UpdateDeliveryCheckpoint(root, "host-1");
    await checkpoint.load();
    await checkpoint.capture({
      events: [first, second],
      interrupts: [notice],
      signal: new AbortController().signal,
    });

    if (process.platform !== "win32")
      expect(
        (await stat(join(root, UPDATE_DELIVERY_CHECKPOINT_FILE))).mode & 0o777,
      ).toBe(0o600);

    const restored = new UpdateDeliveryCheckpoint(root, "host-1");
    await restored.load();
    expect(restored.events).toEqual([first, second]);
    expect(restored.interrupts).toEqual([notice]);
    await Promise.all([
      restored.acknowledgeEvents([first]),
      restored.acknowledgeInterrupt(notice.deliveryId),
    ]);

    const afterProgress = new UpdateDeliveryCheckpoint(root, "host-1");
    await afterProgress.load();
    expect(afterProgress.events).toEqual([second]);
    expect(afterProgress.interrupts).toEqual([]);
    await afterProgress.acknowledgeEvents([second]);
    await expect(
      stat(join(root, UPDATE_DELIVERY_CHECKPOINT_FILE)),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("preserves an unresolved checkpoint when another update captures new pending records", async () => {
    const root = await fixture();
    const first = event("thread-1");
    const second = event("thread-1", 2);
    const checkpoint = new UpdateDeliveryCheckpoint(root, "host-1");
    const signal = new AbortController().signal;
    await checkpoint.capture({ events: [first], interrupts: [], signal });
    await checkpoint.capture({
      events: [
        {
          ...first,
          envelope: {
            threadId: "thread-1",
            event: {
              type: "system/error",
              threadId: "thread-1",
              scope: threadScope(),
              message: "changed bytes",
            },
          },
        },
        second,
      ],
      interrupts: [],
      signal,
    });
    const restored = new UpdateDeliveryCheckpoint(root, "host-1");
    await restored.load();
    expect(restored.events).toEqual([first, second]);
    await restored.recordRejectedEvents([
      { ...second, blockedReason: "invalid_request" },
    ]);
    const rejected = new UpdateDeliveryCheckpoint(root, "host-1");
    await rejected.load();
    expect(rejected.events).toEqual([
      first,
      { ...second, blockedReason: "invalid_request" },
    ]);
  });

  it("returns only active checkpoint members after saving a rejection without restarting", async () => {
    const root = await fixture();
    const captured = event("thread-1");
    const ordinary = event("thread-1", 2);
    const checkpoint = new UpdateDeliveryCheckpoint(root, "host-1");
    const rejected = { ...captured, blockedReason: "invalid_request" } as const;
    expect(await checkpoint.recordRejectedEvents([rejected])).toEqual([]);
    await checkpoint.capture({
      events: [captured],
      interrupts: [],
      signal: new AbortController().signal,
    });
    expect(
      await checkpoint.recordRejectedEvents([
        rejected,
        { ...ordinary, blockedReason: "invalid_request" },
      ]),
    ).toEqual([rejected]);
    expect(checkpoint.events).toEqual([rejected]);
    const restored = new UpdateDeliveryCheckpoint(root, "host-1");
    await restored.load();
    expect(restored.events).toEqual([rejected]);
  });

  it("keeps a checkpoint intact when its host or format cannot be loaded", async () => {
    const root = await fixture();
    const checkpoint = new UpdateDeliveryCheckpoint(root, "host-1");
    await checkpoint.capture({
      events: [event("thread-1")],
      interrupts: [],
      signal: new AbortController().signal,
    });
    const checkpointPath = join(root, UPDATE_DELIVERY_CHECKPOINT_FILE);
    const contents = await readFile(checkpointPath, "utf8");
    await expect(
      new UpdateDeliveryCheckpoint(root, "host-2").load(),
    ).rejects.toThrow("another host");
    expect(await readFile(checkpointPath, "utf8")).toBe(contents);
    await writeFile(checkpointPath, '{"version":999}');
    await expect(
      new UpdateDeliveryCheckpoint(root, "host-1").load(),
    ).rejects.toThrow();
    expect(await readFile(checkpointPath, "utf8")).toBe('{"version":999}');
    await writeFile(checkpointPath, "private conversation payload");
    await expect(
      new UpdateDeliveryCheckpoint(root, "host-1").load(),
    ).rejects.not.toThrow("private");
    expect(await readFile(checkpointPath, "utf8")).toBe(
      "private conversation payload",
    );
  });

  it("does not replace pending state when its checkpoint cannot be written", async () => {
    const root = await fixture();
    const blockedPath = join(root, "not-a-directory");
    await writeFile(blockedPath, "preserve");
    const checkpoint = new UpdateDeliveryCheckpoint(blockedPath, "host-1");
    await expect(
      checkpoint.capture({
        events: [event("thread-1")],
        interrupts: [],
        signal: new AbortController().signal,
      }),
    ).rejects.toMatchObject({ code: "ENOTDIR" });
    expect(checkpoint.events).toEqual([]);
    expect(await readFile(blockedPath, "utf8")).toBe("preserve");
  });

  it("retains an unreadable notice whose request is outside its listed threads", async () => {
    const root = await fixture();
    const checkpointPath = join(root, UPDATE_DELIVERY_CHECKPOINT_FILE);

    const contents = JSON.stringify({
      version: 1,
      hostId: "host-1",
      events: [],
      interrupts: [{ ...interrupt(), threadIds: ["another-thread"] }],
    });

    await writeFile(checkpointPath, contents);

    await expect(
      new UpdateDeliveryCheckpoint(root, "host-1").load(),
    ).rejects.toThrow("Interrupted request must belong to a listed thread");
    expect(await readFile(checkpointPath, "utf8")).toBe(contents);
  });

  it("does not begin a new checkpoint after its deadline has expired", async () => {
    const root = await fixture();
    const checkpoint = new UpdateDeliveryCheckpoint(root, "host-1");
    const abort = new AbortController();
    abort.abort(new Error("checkpoint deadline"));
    await expect(
      checkpoint.capture({
        events: [event("thread-1")],
        interrupts: [],
        signal: abort.signal,
      }),
    ).rejects.toThrow("checkpoint deadline");
    await expect(
      stat(join(root, UPDATE_DELIVERY_CHECKPOINT_FILE)),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });
});
