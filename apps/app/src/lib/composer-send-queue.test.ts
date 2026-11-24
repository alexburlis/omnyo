import { describe, expect, it } from "vitest";
import { createDeferredPromise } from "@omnyo/test-helpers";
import {
  aliasComposerSendThread,
  reserveComposerSend,
} from "./composer-send-queue";

describe("composer destination aliases", () => {
  it("keeps a reserved voice message ahead of typed and real-route sends without blocking another chat", async () => {
    const owner = {};
    const events: string[] = [];
    const voice = reserveComposerSend(owner, "pending_voice");
    const typed = reserveComposerSend(owner, "pending_voice");
    aliasComposerSendThread(owner, "pending_voice", "real-chat");
    const realRoute = reserveComposerSend(owner, "real-chat");
    const lateOrigin = reserveComposerSend(owner, "pending_voice");

    const typedResult = typed.run(async () => {
      events.push("typed");
    });

    const realResult = realRoute.run(async () => {
      events.push("real-route");
    });

    const originResult = lateOrigin.run(async () => {
      events.push("old-origin");
    });

    await reserveComposerSend(owner, "other-chat").run(async () => {
      events.push("other-chat");
    });
    expect(events).toEqual(["other-chat"]);

    const transport = createDeferredPromise<void>();

    const voiceResult = voice.run(async () => {
      events.push("voice");
      await transport.promise;
    });

    await Promise.resolve();
    expect(events).toEqual(["other-chat", "voice"]);
    transport.resolve();
    await Promise.all([voiceResult, typedResult, realResult, originResult]);
    expect(events).toEqual([
      "other-chat",
      "voice",
      "typed",
      "real-route",
      "old-origin",
    ]);
  });

  it("preserves an existing real destination reservation when its provisional queue is aliased", async () => {
    const owner = {};
    const pending = reserveComposerSend(owner, "pending_existing");
    const existingReal = reserveComposerSend(owner, "real-existing");
    aliasComposerSendThread(owner, "pending_existing", "real-existing");
    let delivered = false;

    const next = reserveComposerSend(owner, "real-existing").run(async () => {
      delivered = true;
    });

    pending.cancel();
    await Promise.resolve();
    expect(delivered).toBe(false);
    existingReal.cancel();
    await next;
    expect(delivered).toBe(true);
  });
});
