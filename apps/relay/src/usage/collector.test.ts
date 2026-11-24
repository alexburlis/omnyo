import { createHash, randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createUsageCollector } from "./collector.js";

const dayMillis = 86_400_000;

const initial = Date.parse("2026-01-05T12:00:00Z");

describe("first-party usage collector", () => {
  let db: DatabaseSync;
  let server: ReturnType<typeof createServer>;
  let collector: ReturnType<typeof createUsageCollector>;
  let origin: string;
  let time: number;
  beforeEach(async () => {
    time = initial;
    db = new DatabaseSync(":memory:");
    collector = createUsageCollector(db, () => time);
    server = createServer((req, res) => {
      void collector.respond(req, res);
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const address = server.address();

    if (!address || typeof address === "string")
      throw new Error("Missing loopback port");
    origin = "http://127.0.0.1:" + address.port;
  });
  afterEach(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    db.close();
  });

  function post(path: string, body?: unknown) {
    return fetch(origin + "/metrics/" + path, {
      method: "POST",
      body: body === undefined ? undefined : JSON.stringify(body),
      headers: { "content-type": "application/json" },
    });
  }

  function activity(subject: string, first: boolean) {
    return post("product", {
      subject,
      count: 1,
      day: new Date(time).toISOString().slice(0, 10),
      event: "activity",
      properties: { first },
    });
  }

  it("keeps only week and daily site counters and declines private or oversized input", async () => {
    const statuses = await Promise.all([
      post("active-week"),
      post("active-week"),
      post("site-events", { event: { name: "listing_open", kind: "skill" } }),
    ]);

    expect(statuses.map((res) => res.status)).toEqual([204, 204, 204]);
    expect(db.prepare("SELECT * FROM active_weeks").all()).toEqual([
      { week_start: "2026-01-05", count: 2 },
    ]);
    expect(db.prepare("SELECT * FROM site_days").all()).toEqual([
      {
        day: "2026-01-05",
        event: '{"name":"listing_open","kind":"skill"}',
        count: 1,
      },
    ]);
    expect((await post("active-week", { id: "marker" })).status).toBe(400);

    for (const header of [
      "forwarded",
      "x-forwarded-for",
      "x-real-ip",
      "cf-connecting-ip",
    ]) {
      const withAddress = await fetch(origin + "/metrics/active-week", {
        method: "POST",
        headers: { [header]: "192.0.2.42" },
      });

      expect(withAddress.status).toBe(400);
    }

    expect(db.prepare("SELECT count FROM active_weeks").get()).toEqual({
      count: 2,
    });

    expect(
      (
        await post("site-events", {
          event: {
            name: "listing_open",
            kind: "skill",
            query: "synthetic-private-marker",
          },
        })
      ).status,
    ).toBe(400);
    expect((await post("site-events", "x".repeat(2200))).status).toBe(413);
    expect((await post("active-week?extra=1")).status).toBe(404);
    expect(
      (
        await fetch(origin + "/metrics/active-week", {
          method: "POST",
          headers: { cookie: "id=marker" },
        })
      ).status,
    ).toBe(400);
    expect(db.prepare("SELECT count FROM active_weeks").get()).toEqual({
      count: 2,
    });
  });
  it("authenticates erasure by possession, vetoes late deliveries and expires the revocation digest", async () => {
    const proof = randomBytes(32);
    const subject = createHash("sha256").update(proof).digest("hex");
    expect((await activity(subject, true)).status).toBe(204);
    expect((await post("product-erasure", { proof: subject })).status).toBe(
      204,
    );
    expect(db.prepare("SELECT subject FROM product_days").get()).toEqual({
      subject,
    });
    expect(
      (await post("product-erasure", { proof: proof.toString("hex") })).status,
    ).toBe(204);
    expect((await activity(subject, false)).status).toBe(204);
    expect(db.prepare("SELECT subject FROM product_days").all()).toEqual([]);
    expect(
      db
        .prepare("SELECT digest FROM erased WHERE digest=? OR digest=?")
        .all(subject, proof.toString("hex")),
    ).toEqual([]);
    time += 30 * dayMillis;
    collector.maintain();
    expect(db.prepare("SELECT digest FROM erased").all()).toEqual([]);
  });
  it("freezes mature opt-in cohorts before day-level raw expiry and suppresses rare feature totals", async () => {
    const subjects = Array.from({ length: 10 }, () =>
      randomBytes(32).toString("hex"),
    );

    await Promise.all(subjects.map((subject) => activity(subject, true)));
    await post("product", {
      subject: subjects[0],
      count: 1,
      day: "2026-01-05",
      event: "feature_used",
      properties: { feature: "plugin" },
    });
    time = initial + 7 * dayMillis;
    await Promise.all(
      subjects.slice(0, 5).map((subject) => activity(subject, false)),
    );
    time = initial + 28 * dayMillis;
    await Promise.all(
      subjects.slice(0, 3).map((subject) => activity(subject, false)),
    );
    time = initial + 30 * dayMillis;
    collector.maintain();
    expect(
      db
        .prepare(
          "SELECT lag_days, eligible, returned FROM return_cohorts ORDER BY lag_days",
        )
        .all(),
    ).toEqual([
      { lag_days: 7, eligible: 10, returned: 5 },
      { lag_days: 28, eligible: 10, returned: 3 },
    ]);
    expect(
      db.prepare("SELECT * FROM product_days WHERE day='2026-01-05'").all(),
    ).toEqual([]);
    expect(
      db
        .prepare("SELECT * FROM product_totals WHERE event='feature_used'")
        .all(),
    ).toEqual([]);
    expect(
      (
        await post("product", {
          subject: subjects[0],
          count: 1,
          day: "2026-01-05",
          event: "activity",
          properties: { first: true },
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await post("product", {
          subject: subjects[0],
          count: 1,
          day: "2026-02-04",
          event: "operation",
          properties: {
            operation: "message",
            outcome: "accepted",
            provider: "acp-private-client",
            latency: "under_1s",
          },
        })
      ).status,
    ).toBe(400);
  });
});
