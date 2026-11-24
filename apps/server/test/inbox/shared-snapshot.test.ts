import { describe, expect, it } from "vitest";
import { buildInboxSnapshot, type InboxSnapshot } from "@omnyo/domain";
import {
  createSharedInboxSnapshot,
  SHARED_INBOX_SNAPSHOT_MAX_AGE_MS,
} from "../../src/services/inbox/shared-snapshot.js";
import { NotificationHub } from "../../src/ws/hub.js";

function fixture() {
  const hub = new NotificationHub();
  let now = 1_000;
  const computedAt: number[] = [];

  const read = createSharedInboxSnapshot({
    hub,
    now: () => now,
    collect: (at): InboxSnapshot => {
      computedAt.push(at);

      return buildInboxSnapshot({
        entries: [],
        now: at,
        revision: String(computedAt.length),
        lastMove: null,
      });
    },
  });

  return {
    hub,
    read,
    computedAt,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

describe("shared inbox snapshot", () => {
  it("serves every reader one computation until a list change arrives", () => {
    const world = fixture();

    const first = world.read();
    world.advance(100);

    expect(world.read()).toBe(first);
    expect(world.computedAt).toEqual([1_000]);

    world.hub.notifyThread("thr_moved", ["shelf-state-changed"]);

    expect(world.read().revision).toBe("2");
    expect(world.computedAt).toEqual([1_000, 1_100]);
  });

  it("keeps streaming output from recomputing but caps its age", () => {
    const world = fixture();

    world.read();
    world.hub.notifyThread("thr_streaming", ["events-appended"]);
    world.advance(SHARED_INBOX_SNAPSHOT_MAX_AGE_MS - 1);
    world.read();

    expect(world.computedAt).toHaveLength(1);

    world.advance(1);
    world.read();

    expect(world.computedAt).toHaveLength(2);
  });
});
