import { zstdDecompressSync } from "node:zlib";
import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import { defineRpcContract } from "@omnyo/plugin-sdk";
import { z } from "zod";
import type { AccountQuota } from "./contracts.js";

const nullableNumber = z.number().nullable();

export const telemetryReportSchema = z.object({
  from: z.number(),
  to: z.number(),
  collectionErrors: z.number(),
  truncated: z.boolean(),
  rows: z.array(
    z.object({
      accountId: z.string(),
      model: z.string(),
      requestedTier: z.string(),
      servedTier: z.string().nullable(),
      effort: z.string().nullable(),
      requests: z.number(),
      completed: z.number(),
      failed: z.number(),
      unmeasured: z.number(),
      inputTokens: z.number(),
      cachedInputTokens: z.number(),
      outputTokens: z.number(),
      reasoningTokens: z.number(),
      medianTps: nullableNumber,
      medianFirstEventMs: nullableNumber,
    }),
  ),
  windows: z.array(
    z.object({
      model: z.string().nullable(),
      requestedTier: z.string().nullable(),
      servedTier: z.string().nullable(),
      effort: z.string().nullable(),
      outputTokens: nullableNumber,
      accountId: z.string(),
      slot: z.string(),
      windowMinutes: nullableNumber,
      resetAt: nullableNumber,
      from: z.number(),
      to: z.number(),
      deltaPercent: nullableNumber,
      attribution: z.enum([
        "observed-account",
        "mixed",
        "reset",
        "unattributed",
      ]),
      requests: z.number(),
    }),
  ),
});

export type TelemetryReport = z.infer<typeof telemetryReportSchema>;

export const telemetryRpcContract = defineRpcContract({
  "experimental_telemetry.v1.report": {
    input: z.object({ accountId: z.string().nullable() }),
    output: telemetryReportSchema,
  },
});

const terminalSchema = z.object({
  type: z.enum([
    "response.completed",
    "response.done",
    "response.failed",
    "response.incomplete",
  ]),
  response: z.object({
    model: z.string().max(200).optional(),
    service_tier: z.string().max(80).nullish(),
    usage: z
      .object({
        input_tokens: z.number().nonnegative(),
        output_tokens: z.number().nonnegative(),
        input_tokens_details: z
          .object({ cached_tokens: z.number().nonnegative().optional() })
          .optional(),
        output_tokens_details: z
          .object({ reasoning_tokens: z.number().nonnegative().optional() })
          .optional(),
      })
      .nullish(),
  }),
});

const requestSchema = z.object({
  model: z.string().max(200),
  service_tier: z.string().max(80).optional(),
  reasoning: z.object({ effort: z.string().max(80).optional() }).optional(),
});

const resultSchema = z.object({
  status: z.string(),
  reportedModel: z.string().max(200).nullable(),
  servedTier: z.string().max(80).nullable(),
  input: z.number(),
  cached: z.number(),
  output: z.number(),
  reasoning: z.number(),
  first: z.number().nullable(),
  duration: z.number(),
  measured: z.boolean(),
});

const measurementRowSchema = z.object({
  account: z.string(),
  started: z.number(),
  ended: z.number().nullable(),
  metadata: z.string(),
  result: z.string().nullable(),
});

const observationRowSchema = z.object({
  account: z.string(),
  slot: z.string(),
  at: z.number(),
  minutes: z.number().nullable(),
  reset: z.number().nullable(),
  used: z.number(),
});

const DAYS = 30 * 86400000;

export const TELEMETRY_MIGRATION = `CREATE TABLE pool_measurements(id TEXT PRIMARY KEY,account TEXT NOT NULL,started INTEGER NOT NULL,ended INTEGER,metadata TEXT NOT NULL,result TEXT); CREATE INDEX pool_measurements_time ON pool_measurements(started); CREATE TABLE pool_quota_observations(account TEXT NOT NULL,slot TEXT NOT NULL,at INTEGER NOT NULL,minutes INTEGER,reset INTEGER,used REAL,PRIMARY KEY(account,slot,at)); CREATE INDEX pool_quota_time ON pool_quota_observations(at);`;

function median(values: number[]): number | null {
  if (!values.length) return null;
  values.sort((a, b) => a - b);
  const i = Math.floor(values.length / 2);

  return values.length % 2 ? values[i]! : (values[i - 1]! + values[i]!) / 2;
}

export class PoolTelemetry {
  private errors = 0;
  private lastPrune = 0;
  constructor(
    private db: Database.Database,
    private now: () => number = Date.now,
  ) {}
  private safe(action: () => void): void {
    try {
      action();
    } catch {
      this.errors++;
    }
  }
  observeQuota(quota: AccountQuota): void {
    this.safe(() => {
      for (const w of quota.limitWindows) {
        if (
          w.utilization === null ||
          (w.source !== "header" && w.source !== "usage")
        )
          continue;
        this.db
          .prepare(
            "INSERT OR IGNORE INTO pool_quota_observations VALUES(?,?,?,?,?,?)",
          )
          .run(
            quota.accountId,
            w.slot,
            w.observedAt,
            w.windowMinutes,
            w.resetAt,
            w.utilization * 100,
          );
      }

      this.prune();
    });
  }
  private prune(): void {
    const now = this.now();

    if (now - this.lastPrune < 60_000) return;
    this.lastPrune = now;
    const cutoff = now - DAYS;
    this.db
      .prepare("DELETE FROM pool_measurements WHERE started < ?")
      .run(cutoff);
    this.db
      .prepare("DELETE FROM pool_quota_observations WHERE at < ?")
      .run(cutoff);
  }
  start(
    account: string,
    body: Uint8Array,
    headers: Headers,
  ): { wrap: (response: Response) => Response; failed: () => void } | null {
    let metadata: z.infer<typeof requestSchema>;

    try {
      metadata = requestSchema.parse(
        JSON.parse(
          new TextDecoder().decode(
            headers.get("content-encoding") === "zstd"
              ? zstdDecompressSync(body, { maxOutputLength: 64 * 1024 * 1024 })
              : body,
          ),
        ),
      );
    } catch {
      return null;
    }

    const id = randomUUID(),
      started = this.now();

    let first: number | null = null,
      done = false,
      buffer = "",
      oversized = false;

    this.safe(() =>
      this.db
        .prepare("INSERT INTO pool_measurements VALUES(?,?,?,?,?,NULL)")
        .run(id, account, started, null, JSON.stringify(metadata)),
    );

    const finish = (status: string, event?: z.infer<typeof terminalSchema>) => {
      if (done) return;
      done = true;
      const ended = this.now();
      const usage = event?.response.usage;

      const result = {
        status,
        reportedModel: event?.response.model ?? null,
        servedTier: event?.response.service_tier ?? null,
        input: usage?.input_tokens ?? 0,
        cached: usage?.input_tokens_details?.cached_tokens ?? 0,
        output: usage?.output_tokens ?? 0,
        reasoning: usage?.output_tokens_details?.reasoning_tokens ?? 0,
        first,
        duration: Math.max(0, ended - started),
        measured: usage != null,
      };

      this.safe(() => {
        this.db
          .prepare("UPDATE pool_measurements SET ended=?,result=? WHERE id=?")
          .run(ended, JSON.stringify(result), id);
        this.prune();
      });
    };

    const parse = (data: string) => {
      if (data.length > 2 * 1024 * 1024) {
        oversized = true;

        return;
      }

      try {
        const result = terminalSchema.safeParse(JSON.parse(data));

        if (result.success)
          finish(
            result.data.type === "response.completed" ||
              result.data.type === "response.done"
              ? "completed"
              : "failed",
            result.data,
          );
      } catch {}
    };

    return {
      failed: () => finish("failed"),
      wrap: (response) => {
        if (!response.ok || !response.body) {
          finish("failed");

          return response;
        }

        const sse =
          response.headers
            .get("content-type")
            ?.includes("text/event-stream") === true;

        const reader = response.body.getReader(),
          decoder = new TextDecoder();

        return new Response(
          new ReadableStream<Uint8Array>({
            pull: async (controller) => {
              try {
                const chunk = await reader.read();

                if (chunk.done) {
                  buffer += decoder.decode();

                  if (!sse && !oversized) parse(buffer);
                  finish(oversized ? "oversized" : "unmeasured");
                  controller.close();

                  return;
                }

                first ??= this.now() - started;

                if (!oversized) {
                  buffer += decoder.decode(chunk.value, { stream: true });

                  if (sse) {
                    let match;

                    while ((match = /\r?\n\r?\n/u.exec(buffer)) !== null) {
                      const block = buffer.slice(0, match.index);
                      buffer = buffer.slice(match.index + match[0].length);

                      if (block.length > 2 * 1024 * 1024) {
                        oversized = true;
                        continue;
                      }

                      parse(
                        block
                          .split(/\r?\n/u)
                          .filter((l) => l.startsWith("data:"))
                          .map((l) => l.slice(5).trimStart())
                          .join("\n"),
                      );
                    }
                  }

                  if (buffer.length > 2 * 1024 * 1024) {
                    oversized = true;
                    buffer = "";
                  }
                }

                controller.enqueue(chunk.value);
              } catch (error) {
                finish("failed");
                controller.error(error);
              }
            },
            cancel: async (reason) => {
              finish("cancelled");
              await reader.cancel(reason);
            },
          }),
          {
            status: response.status,
            statusText: response.statusText,
            headers: response.headers,
          },
        );
      },
    };
  }
  report(accountId: string | null): TelemetryReport {
    const to = this.now(),
      from = to - DAYS;

    const measurements = z
      .array(measurementRowSchema)
      .parse(
        this.db
          .prepare(
            "SELECT account,started,ended,metadata,result FROM pool_measurements WHERE started>=? AND (? IS NULL OR account=?) ORDER BY started DESC LIMIT 50001",
          )
          .all(from, accountId, accountId),
      );

    const groups = new Map<
      string,
      TelemetryReport["rows"][number] & { speeds: number[]; firsts: number[] }
    >();

    for (const m of measurements) {
      const meta = requestSchema.parse(JSON.parse(m.metadata));

      const r =
        m.result === null ? null : resultSchema.parse(JSON.parse(m.result));

      const key = JSON.stringify([
        m.account,
        r?.reportedModel ?? meta.model,
        meta.service_tier ?? "default",
        r?.servedTier ?? null,
        meta.reasoning?.effort ?? null,
      ]);

      let g = groups.get(key);

      if (!g) {
        g = {
          accountId: m.account,
          model: r?.reportedModel ?? meta.model,
          requestedTier: meta.service_tier ?? "default",
          servedTier: r?.servedTier ?? null,
          effort: meta.reasoning?.effort ?? null,
          requests: 0,
          completed: 0,
          failed: 0,
          unmeasured: 0,
          inputTokens: 0,
          cachedInputTokens: 0,
          outputTokens: 0,
          reasoningTokens: 0,
          medianTps: null,
          medianFirstEventMs: null,
          speeds: [],
          firsts: [],
        };
        groups.set(key, g);
      }

      g.requests++;

      if (r?.status === "completed") g.completed++;
      else if (r?.status === "failed") g.failed++;
      else g.unmeasured++;

      if (r) {
        g.inputTokens += r.input;
        g.cachedInputTokens += r.cached;
        g.outputTokens += r.output;
        g.reasoningTokens += r.reasoning;

        if (r.status === "completed" && r.measured && r.duration > 0)
          g.speeds.push((r.output * 1000) / r.duration);

        if (r.first !== null) g.firsts.push(r.first);
      }
    }

    const rows = [...groups.values()]
      .slice(0, 300)
      .map(({ speeds, firsts, ...g }) => ({
        ...g,
        medianTps: median(speeds),
        medianFirstEventMs: median(firsts),
      }));

    const observations = z
      .array(observationRowSchema)
      .parse(
        this.db
          .prepare(
            "SELECT account,slot,at,minutes,reset,used FROM pool_quota_observations WHERE at>=? AND (? IS NULL OR account=?) ORDER BY at DESC LIMIT 50001",
          )
          .all(from, accountId, accountId),
      );

    observations.sort((a, b) => a.at - b.at);

    const recent = observations.slice(-600);
    const relevantAccounts = new Set(recent.map((o) => o.account));
    const byAccount = new Map<string, typeof measurements>();

    for (const m of measurements) {
      if (!relevantAccounts.has(m.account)) continue;
      const entries = byAccount.get(m.account) ?? [];
      entries.push(m);
      byAccount.set(m.account, entries);
    }

    const maxEnds = new Map<string, number[]>();

    for (const [account, entries] of byAccount) {
      entries.sort((a, b) => a.started - b.started);
      let maximum = 0;
      maxEnds.set(
        account,
        entries.map((m) => {
          maximum = Math.max(maximum, m.ended ?? Infinity);

          return maximum;
        }),
      );
    }

    const previous = new Map<string, (typeof observations)[number]>(),
      windows: TelemetryReport["windows"] = [];

    for (const o of recent) {
      const key = o.account + o.slot,
        p = previous.get(key);

      previous.set(key, o);

      if (!p) continue;

      const entries = byAccount.get(o.account) ?? [];

      let left = 0,
        right = entries.length;

      while (left < right) {
        const mid = (left + right) >>> 1;

        if (entries[mid]!.started < o.at) left = mid + 1;
        else right = mid;
      }

      const matches: typeof measurements = [];

      for (let i = left - 1; i >= 0; i--) {
        if ((maxEnds.get(o.account)?.[i] ?? 0) <= p.at) break;
        const m = entries[i]!;

        if (m.started < p.at && m.ended !== null && m.ended <= p.at) continue;

        if (m.ended === null || m.ended > p.at) matches.push(m);
      }

      const kinds = new Set(
        matches.map((m) => {
          const x = requestSchema.parse(JSON.parse(m.metadata));

          const result =
            m.result === null ? null : resultSchema.parse(JSON.parse(m.result));

          return JSON.stringify([
            result?.reportedModel ?? x.model,
            x.service_tier,
            x.reasoning,
            result?.servedTier ?? null,
          ]);
        }),
      );

      const resetChanged =
        o.reset === null || p.reset === null
          ? o.reset !== p.reset
          : Math.abs(o.reset - p.reset) > 2000;

      const reset = resetChanged || o.minutes !== p.minutes || o.used < p.used;

      const homogeneous =
        !reset &&
        kinds.size === 1 &&
        matches.every(
          (m) => m.ended !== null && m.started >= p.at && m.ended <= o.at,
        );

      const firstMatch = homogeneous ? matches[0] : undefined;

      const metadata = firstMatch
        ? requestSchema.parse(JSON.parse(firstMatch.metadata))
        : null;

      const results = homogeneous
        ? matches.map((m) =>
            m.result === null ? null : resultSchema.parse(JSON.parse(m.result)),
          )
        : [];

      const tiers = new Set(results.map((r) => r?.servedTier ?? null));
      windows.push({
        model: metadata?.model ?? null,
        requestedTier:
          metadata === null ? null : (metadata.service_tier ?? "default"),
        servedTier: tiers.size === 1 ? [...tiers][0] : null,
        effort: metadata?.reasoning?.effort ?? null,
        outputTokens:
          homogeneous && results.every((r) => r?.measured)
            ? results.reduce((sum, r) => sum + (r?.output ?? 0), 0)
            : null,
        accountId: o.account,
        slot: o.slot,
        windowMinutes: o.minutes,
        resetAt: o.reset,
        from: p.at,
        to: o.at,
        deltaPercent: reset ? null : o.used - p.used,
        attribution: reset
          ? "reset"
          : matches.length === 0 ||
              matches.some(
                (m) => m.ended === null || m.started < p.at || m.ended > o.at,
              )
            ? "unattributed"
            : kinds.size > 1
              ? "mixed"
              : "observed-account",
        requests: matches.length,
      });
    }

    return telemetryReportSchema.parse({
      from,
      to,
      collectionErrors: this.errors,
      truncated:
        measurements.length >= 50001 ||
        observations.length > 600 ||
        groups.size > 300 ||
        windows.length > 300,
      rows,
      windows: windows.slice(-300),
    });
  }
}
