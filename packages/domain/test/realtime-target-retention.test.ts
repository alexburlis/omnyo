import assert from "node:assert/strict";
import { describe, expect, it } from "vitest";
import {
  realtimeSubscriptionTargetKey,
  type RealtimeSubscriptionTarget,
} from "../src/change-kinds.js";
import { RealtimeTargetRetention } from "../src/realtime-target-retention.js";

const thread = { kind: "thread-detail", threadId: "t1" } as const;

const equalThread = { ...thread };

const project = { kind: "project-list" } as const;

describe("RealtimeTargetRetention", () => {
  it("retains the first object per key and changes state only on the first and final holder", () => {
    const retention = new RealtimeTargetRetention();
    expect(retention.release(thread)).toBe(false);
    expect(retention.retain(thread)).toBe(true);
    expect(retention.retain(equalThread)).toBe(false);
    expect(retention.size).toBe(1);
    expect([...retention.values()][0]).toBe(thread);
    expect(retention.release(equalThread)).toBe(false);
    expect([...retention.values()][0]).toBe(thread);
    expect(retention.release(thread)).toBe(true);
    expect(retention.release(thread)).toBe(false);
    expect(retention.size).toBe(0);
  });

  it("preserves insertion order through replay, removal, re-retain and clear", () => {
    const retention = new RealtimeTargetRetention();
    retention.retain(thread);
    retention.retain(project);
    expect([...retention.values()]).toEqual([thread, project]);
    retention.release(thread);
    retention.retain(equalThread);
    expect([...retention.values()]).toEqual([project, equalThread]);
    expect([...retention.values()][1]).toBe(equalThread);
    retention.retain(equalThread);
    retention.clear();
    expect([...retention.values()]).toEqual([]);
    expect(retention.size).toBe(0);
    expect(retention.release(equalThread)).toBe(false);
    expect(retention.retain(equalThread)).toBe(true);
    expect(retention.release(equalThread)).toBe(true);
  });

  it("matches a holder-list model for all 7,776 five-operation traces", () => {
    type Operation =
      | { kind: "retain" | "release"; target: RealtimeSubscriptionTarget }
      | { kind: "clear" };

    const operations: Operation[] = [
      { kind: "retain", target: thread },
      { kind: "retain", target: equalThread },
      { kind: "release", target: equalThread },
      { kind: "retain", target: project },
      { kind: "release", target: project },
      { kind: "clear" },
    ];

    for (let trace = 0; trace < operations.length ** 5; trace += 1) {
      const retention = new RealtimeTargetRetention();
      let holders: RealtimeSubscriptionTarget[] = [];
      const firstTargets = new Map<string, RealtimeSubscriptionTarget>();
      let encoded = trace;

      for (let step = 0; step < 5; step += 1) {
        const operation = operations[encoded % operations.length];
        encoded = Math.floor(encoded / operations.length);

        if (!operation) throw new Error("Expected operation");

        if (operation.kind === "clear") {
          holders = [];
          firstTargets.clear();
          retention.clear();
        } else {
          const key = realtimeSubscriptionTargetKey(operation.target);

          const matches = (target: RealtimeSubscriptionTarget) =>
            realtimeSubscriptionTargetKey(target) === key;

          if (operation.kind === "retain") {
            const first = !holders.some(matches);
            holders.push(operation.target);

            if (first) firstTargets.set(key, operation.target);
            assert.equal(retention.retain(operation.target), first);
          } else {
            const index = holders.findIndex(matches);

            if (index >= 0) holders.splice(index, 1);
            const final = index >= 0 && !holders.some(matches);

            if (final) firstTargets.delete(key);
            assert.equal(retention.release(operation.target), final);
          }
        }

        assert.equal(retention.size, firstTargets.size);
        const expected = [...firstTargets.values()];
        const actual = [...retention.values()];
        assert.equal(actual.length, expected.length);
        actual.forEach((target, index) =>
          assert.equal(target, expected[index]),
        );
      }
    }
  });
});
