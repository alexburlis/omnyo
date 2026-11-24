import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openRelayDatabase, type RelayDatabase } from "./db.js";
import { createEgressCounter } from "./egress.js";
import { sourceMigrationDirectories } from "./migrations.js";
import { createTokenBucketRateLimiter } from "./rate-limit.js";

let database: RelayDatabase;

beforeEach(() => {
  database = openRelayDatabase(":memory:", sourceMigrationDirectories());
  database.sqlite
    .prepare(
      "INSERT INTO user (id, name, email, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
    )
    .run("u1", "Owner", "owner@example.com", 1, 1);
});

afterEach(() => {
  database.close();
});

function storedBytes(userId: string, month: string): number | null {
  const row = database.sqlite
    .prepare(
      "SELECT bytes FROM relay_egress_month WHERE user_id = ? AND month = ?",
    )
    .get(userId, month) as { bytes: number } | undefined;

  return row?.bytes ?? null;
}

describe("egress counter", () => {
  it("keeps a running monthly total, flushes it and reloads it at startup", () => {
    let at = Date.UTC(2026, 10, 30, 23, 59);

    const counter = createEgressCounter({
      sqlite: database.sqlite,
      capBytes: 100,
      now: () => at,
    });

    counter.add("u1", 60);
    expect(storedBytes("u1", "2026-11")).toBeNull();
    counter.flush();
    expect(storedBytes("u1", "2026-11")).toBe(60);

    const restarted = createEgressCounter({
      sqlite: database.sqlite,
      capBytes: 100,
      now: () => at,
    });

    restarted.add("u1", 41);
    expect(restarted.isOverCap("u1")).toBe(true);
    expect(restarted.usage("u1")).toEqual({
      userId: "u1",
      month: "2026-11",
      bytes: 101,
      capBytes: 100,
      resetsAt: new Date(Date.UTC(2026, 11, 1)),
    });

    at = Date.UTC(2026, 11, 1, 0, 1);
    expect(restarted.isOverCap("u1")).toBe(false);
    expect(storedBytes("u1", "2026-11")).toBe(101);
    expect(restarted.usage("u1").bytes).toBe(0);
  });

  it("skips rows for users that no longer exist", () => {
    const counter = createEgressCounter({
      sqlite: database.sqlite,
      capBytes: 100,
      now: () => 0,
    });

    counter.add("gone", 5);
    counter.flush();
    expect(storedBytes("gone", "1970-01")).toBeNull();
  });
});

describe("token bucket rate limiter", () => {
  it("allows the limit per period per key and refills over time", async () => {
    let at = 0;

    const limiter = createTokenBucketRateLimiter(
      { limit: 2, periodMs: 60_000 },
      () => at,
    );

    expect(await limiter.limit({ key: "a" })).toEqual({ success: true });
    expect(await limiter.limit({ key: "a" })).toEqual({ success: true });
    expect(await limiter.limit({ key: "a" })).toEqual({ success: false });
    expect(await limiter.limit({ key: "b" })).toEqual({ success: true });
    at = 30_000;
    expect(await limiter.limit({ key: "a" })).toEqual({ success: true });
    expect(await limiter.limit({ key: "a" })).toEqual({ success: false });
  });
});
