import { cleanup } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { renderSlot } from "@omnyo/plugin-sdk/testing/app";
import { CardChangeBroadcast } from "../components/broadcast";
import { CARD_CHANGED_EVENT } from "../lib/changed-event";
import { realtimeChannel } from "../contract";

afterEach(cleanup);

describe("card change broadcast", () => {
  it("announces each realtime card change to other plugins in the window", async () => {
    const seen: unknown[] = [];

    const listen = (event: Event) => seen.push(event instanceof CustomEvent ? event.detail : null);

    window.addEventListener(CARD_CHANGED_EVENT, listen);

    try {
      const slot = renderSlot({ component: CardChangeBroadcast }, {}, {});

      const entry = {
        threadId: "thr_one",
        revision: 4,
        status: "needs-you",
        phase: "build",
        goal: null,
        headline: "Select a direction",
        sidebarSummary: null,
        blocker: null,
        next: null,
        facts: [],
        visuals: [],
        stale: false,
        unseen: true,
        updatedAt: 10,
      };

      await slot.behavior.emitRealtime(realtimeChannel, {
        threadId: "thr_one",
        revision: 4,
        entry,
      });
      await slot.behavior.emitRealtime(realtimeChannel, {
        threadId: "thr_two",
        revision: 0,
        entry: null,
      });
      await slot.behavior.emitRealtime(realtimeChannel, { threadId: "thr_one", revision: 5 });
      expect(seen).toEqual([
        { threadId: "thr_one", revision: 4, entry },
        { threadId: "thr_two", revision: 0, entry: null },
      ]);
    } finally {
      window.removeEventListener(CARD_CHANGED_EVENT, listen);
    }
  });
});
