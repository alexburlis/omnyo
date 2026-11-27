import assert from "node:assert/strict";
import { describe, it } from "node:test";
import * as glance from "../../glance/lib/changed-event.ts";
import type { GlanceCard } from "../lib/feed.ts";
import {
  CARD_CHANGED_EVENT,
  mergeIndex,
  missingGlanceSchema,
  onCardChange,
} from "../lib/glance-changes.ts";

const entry = {
  threadId: "thr_one",
  revision: 4,
  status: "needs-you" as const,
  phase: "build" as const,
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

const inbox: GlanceCard = {
  threadId: "thr_one",
  status: "needs-you",
  phase: "build",
  headline: "Select a direction",
  sidebarSummary: null,
  blocker: null,
  next: null,
  stale: false,
  unseen: true,
  updatedAt: 10,
};

describe("Glance card changes", () => {
  it("reads the card Glance announces, until stopped", () => {
    const window = new EventTarget();
    const heard: unknown[] = [];

    const stop = onCardChange(window, (change) => heard.push(change));

    assert.equal(CARD_CHANGED_EVENT, glance.CARD_CHANGED_EVENT);
    glance.announceCardChange(window, { threadId: "thr_one", revision: 4, entry });
    glance.announceCardChange(window, { threadId: "thr_two", revision: 0, entry: null });
    window.dispatchEvent(new CustomEvent(CARD_CHANGED_EVENT, { detail: { threadId: 3 } }));
    stop();
    glance.announceCardChange(window, { threadId: "thr_one", revision: 5, entry });
    assert.deepEqual(heard, [
      { threadId: "thr_one", card: inbox },
      { threadId: "thr_two", card: null },
      null,
    ]);
  });

  it("keeps changes newer than an index request over that request's result", () => {
    const older = { ...inbox, status: "working" as const };

    const index = new Map([
      ["thr_one", older],
      ["thr_two", older],
    ]);

    const patches = new Map([
      ["thr_one", { card: inbox, at: 200 }],
      ["thr_two", { card: null, at: 200 }],
      ["thr_three", { card: inbox, at: 50 }],
    ]);

    assert.deepEqual(mergeIndex(index, patches, 100), new Map([["thr_one", inbox]]));
    assert.deepEqual(mergeIndex(index, patches, 300), index);
  });

  it("stops asking when Glance is not installed, and keeps asking after other failures", () => {
    assert.equal(missingGlanceSchema.safeParse({ status: 404, code: null }).success, true);
    assert.equal(missingGlanceSchema.safeParse({ status: 503, code: null }).success, false);
    assert.equal(missingGlanceSchema.safeParse(new Error("Network unavailable")).success, false);
  });
});
