import { createHash } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { DatabaseSync } from "node:sqlite";
import {
  productUsageReportSchema,
  productUsageErasureSchema,
  USAGE_RAW_RETENTION_DAYS,
} from "@omnyo/domain/usage-telemetry";
import { siteUsageRequestSchema } from "@omnyo/domain/site-usage";

const DAY_MS = 86_400_000;

const MAX_BODY = 2048;

const MIN_COHORT = 10;

function utcDay(time: number): string {
  return new Date(time).toISOString().slice(0, 10);
}

function isoWeekStart(time: number): string {
  return utcDay(time - ((new Date(time).getUTCDay() + 6) % 7) * DAY_MS);
}

function digest(data: string | Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}

async function readBody(request: IncomingMessage): Promise<Buffer | undefined> {
  const chunks: Buffer[] = [];
  let length = 0;

  for await (const chunk of request.iterator({ destroyOnReturn: false })) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    length += bytes.length;

    if (length > MAX_BODY) {
      request.resume();

      return undefined;
    }

    chunks.push(bytes);
  }

  return Buffer.concat(chunks, length);
}

function jsonBody(bytes: Buffer): unknown {
  try {
    return JSON.parse(bytes.toString("utf8"));
  } catch {
    return null;
  }
}

export function createUsageCollector(
  db: DatabaseSync,
  clock: () => number = Date.now,
) {
  db.exec(`
    PRAGMA journal_mode=DELETE;
    PRAGMA secure_delete=ON;
    CREATE TABLE IF NOT EXISTS active_weeks (week_start TEXT PRIMARY KEY, count INTEGER NOT NULL) WITHOUT ROWID;
    CREATE TABLE IF NOT EXISTS site_days (day TEXT NOT NULL, event TEXT NOT NULL, count INTEGER NOT NULL, PRIMARY KEY(day,event)) WITHOUT ROWID;
    CREATE TABLE IF NOT EXISTS product_days (
      day TEXT NOT NULL, subject TEXT NOT NULL, event TEXT NOT NULL, properties TEXT NOT NULL,
      count INTEGER NOT NULL, PRIMARY KEY(day,subject,event,properties)
    ) WITHOUT ROWID;
    CREATE INDEX IF NOT EXISTS product_subject ON product_days(subject,day);
    CREATE TABLE IF NOT EXISTS erased (digest TEXT PRIMARY KEY, until_day TEXT NOT NULL) WITHOUT ROWID;
    CREATE TABLE IF NOT EXISTS product_totals (
      day TEXT NOT NULL, event TEXT NOT NULL, properties TEXT NOT NULL, subjects INTEGER NOT NULL, count INTEGER NOT NULL,
      PRIMARY KEY(day,event,properties)
    ) WITHOUT ROWID;
    CREATE TABLE IF NOT EXISTS return_cohorts (
      first_day TEXT NOT NULL, lag_days INTEGER NOT NULL, eligible INTEGER NOT NULL, returned INTEGER NOT NULL,
      PRIMARY KEY(first_day,lag_days)
    ) WITHOUT ROWID;
  `);

  const collectWeek = db.prepare(
    "INSERT INTO active_weeks VALUES(?,1) ON CONFLICT(week_start) DO UPDATE SET count=count+1",
  );

  const collectSite = db.prepare(
    "INSERT INTO site_days VALUES(?,?,1) ON CONFLICT(day,event) DO UPDATE SET count=count+1",
  );

  const collectProduct = db.prepare(`INSERT INTO product_days VALUES(?,?,?,?,?)
    ON CONFLICT(day,subject,event,properties) DO UPDATE SET count=max(count,excluded.count)`);

  const blocked = db.prepare("SELECT 1 FROM erased WHERE digest=?");
  const eraseEvents = db.prepare("DELETE FROM product_days WHERE subject=?");

  const recordErasure = db.prepare(
    "INSERT INTO erased VALUES(?,?) ON CONFLICT(digest) DO UPDATE SET until_day=max(until_day,excluded.until_day)",
  );

  const expireEvents = db.prepare("DELETE FROM product_days WHERE day<?");
  const expireErasure = db.prepare("DELETE FROM erased WHERE until_day<=?");

  const summarize = db.prepare(`INSERT OR IGNORE INTO product_totals
    SELECT day,event,properties,count(DISTINCT subject),sum(count) FROM product_days
    WHERE day<? GROUP BY day,event,properties HAVING count(DISTINCT subject)>=?`);

  const retention = db.prepare(`INSERT OR IGNORE INTO return_cohorts
    SELECT first.day, ?, count(DISTINCT first.subject), count(DISTINCT later.subject)
    FROM product_days first LEFT JOIN product_days later
      ON later.subject=first.subject AND later.event='activity' AND later.day=date(first.day,?)
    WHERE first.event='activity' AND json_extract(first.properties,'$.first')=1
      AND date(first.day,?)<?
    GROUP BY first.day HAVING count(DISTINCT first.subject)>=?`);

  let lastMaintainedDay: string | undefined;

  function transaction(work: () => void): void {
    db.exec("BEGIN IMMEDIATE");

    try {
      work();
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }

  function maintain(): void {
    const now = clock();
    const today = utcDay(now);

    if (lastMaintainedDay === today) return;
    const yesterday = utcDay(now - DAY_MS);
    transaction(() => {
      summarize.run(yesterday, MIN_COHORT);

      for (const lag of [7, 28]) {
        const offset = "+" + lag + " days";
        retention.run(lag, offset, offset, yesterday, MIN_COHORT);
      }

      expireEvents.run(utcDay(now - (USAGE_RAW_RETENTION_DAYS - 1) * DAY_MS));
      expireErasure.run(today);
    });
    lastMaintainedDay = today;
  }

  maintain();

  async function handle(request: IncomingMessage): Promise<number> {
    maintain();
    const now = clock();
    const today = utcDay(now);

    if (request.method !== "POST") return 405;

    if (
      [
        "cookie",
        "authorization",
        "referer",
        "origin",
        "forwarded",
        "x-forwarded-for",
        "x-real-ip",
        "cf-connecting-ip",
      ].some((header) => request.headers[header] !== undefined)
    )
      return 400;
    const path = request.url;

    if (
      ![
        "/metrics/active-week",
        "/metrics/site-events",
        "/metrics/product",
        "/metrics/product-erasure",
      ].includes(path ?? "")
    )
      return 404;
    const bytes = await readBody(request);

    if (!bytes) return 413;

    if (path === "/metrics/active-week") {
      if (bytes.length !== 0) return 400;
      collectWeek.run(isoWeekStart(now));

      return 204;
    }

    if (
      request.headers["content-type"]?.split(";")[0]?.trim() !==
      "application/json"
    )
      return 415;
    const body = jsonBody(bytes);

    if (path === "/metrics/site-events") {
      const parsed = siteUsageRequestSchema.safeParse(body);

      if (!parsed.success) return 400;
      collectSite.run(today, JSON.stringify(parsed.data.event));

      return 204;
    }

    if (path === "/metrics/product-erasure") {
      const parsed = productUsageErasureSchema.safeParse(body);

      if (!parsed.success) return 400;
      const subject = digest(Buffer.from(parsed.data.proof, "hex"));
      transaction(() => {
        eraseEvents.run(subject);
        recordErasure.run(
          digest("erase:" + subject),
          utcDay(now + USAGE_RAW_RETENTION_DAYS * DAY_MS),
        );
      });

      return 204;
    }

    const parsed = productUsageReportSchema.safeParse(body);

    if (!parsed.success) return 400;
    const { subject, day, event, properties, count } = parsed.data;

    if (day !== today && day !== utcDay(now - DAY_MS)) return 400;

    if (blocked.get(digest("erase:" + subject))) return 204;
    collectProduct.run(day, subject, event, JSON.stringify(properties), count);

    return 204;
  }

  return {
    maintain,
    async respond(
      request: IncomingMessage,
      response: ServerResponse,
    ): Promise<void> {
      try {
        response.statusCode = await handle(request);
      } catch {
        response.statusCode = 503;
      }

      request.resume();
      response.setHeader("cache-control", "no-store");
      response.end();
    },
  };
}
