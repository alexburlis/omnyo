import { describe, expect, it } from "vitest";
import { createThreadEventFilter } from "../host-policy.js";
import type { PluginThreadEventBatch } from "../host-policy.js";

function batch(from: number, to = from): PluginThreadEventBatch {
  return {
    eventTypes: ["item/agentMessage/delta"],
    coveredSequence: { from, to },
  };
}

describe("thread append subscription filters", () => {
  it("catches up once per subscription and thread before filtering continuous batches", () => {
    const filter = createThreadEventFilter(["thread/extensionState/updated"]);
    expect(filter("first", batch(1))).toBe(true);
    expect(filter("first", batch(2, 7))).toBe(false);
    expect(filter("second", batch(8))).toBe(true);
    expect(
      filter("first", {
        eventTypes: ["thread/extensionState/updated"],
        coveredSequence: { from: 8, to: 8 },
      }),
    ).toBe(true);
    expect(createThreadEventFilter([])("first", batch(9))).toBe(true);
  });

  it("delivers unknown, discontinuous and rewritten ranges conservatively", () => {
    const filter = createThreadEventFilter([]);
    expect(filter("chat", batch(1))).toBe(true);
    expect(filter("chat", batch(2))).toBe(false);
    expect(filter("chat", batch(4))).toBe(true);
    expect(filter("chat", batch(2))).toBe(true);
    expect(filter("chat", undefined)).toBe(true);
    expect(filter("chat", batch(3))).toBe(true);
    expect(filter("chat", batch(4))).toBe(false);
  });

  it("bounds observed chat metadata and catches up an evicted chat", () => {
    const filter = createThreadEventFilter([]);

    for (let index = 0; index < 512; index++) {
      expect(filter(`chat-${index}`, batch(1))).toBe(true);
    }

    expect(filter("chat-0", batch(2))).toBe(false);
    expect(filter("chat-512", batch(1))).toBe(true);
    expect(filter("chat-0", batch(3))).toBe(false);
    expect(filter("chat-1", batch(2))).toBe(true);
  });

  it("never suppresses a matching event across fixed-seed random flushes and gaps", () => {
    const filter = createThreadEventFilter(["thread/extensionState/updated"]);
    let state = 7391;
    let sequence = 0;
    let previous = 0;
    let matched = 0;

    for (let index = 0; index < 500; index++) {
      state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
      const count = 1 + (state % 7);
      const from = sequence + 1 + (state % 13 === 0 ? 1 : 0);
      sequence = from + count - 1;
      const relevant = state % 11 === 0;
      const known = state % 17 !== 0;

      const delivered = filter(
        "chat",
        known
          ? {
              eventTypes: relevant
                ? ["thread/extensionState/updated"]
                : ["item/agentMessage/delta"],
              coveredSequence: { from, to: sequence },
            }
          : undefined,
      );

      if (relevant || !known || previous === 0 || from !== previous + 1) {
        expect(delivered).toBe(true);
      }

      if (relevant && delivered) matched += 1;
      previous = known ? sequence : 0;
    }

    expect(matched).toBeGreaterThan(20);
  });
});
