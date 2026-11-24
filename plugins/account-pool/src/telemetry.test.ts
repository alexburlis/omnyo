import Database from "better-sqlite3";
import { describe, it, expect } from "vitest";
import { PoolTelemetry, TELEMETRY_MIGRATION } from "./telemetry.js";
import { quotaSchema, EMPTY_FAMILY_WEEKLY } from "./contracts.js";

function setup() {
  const db = new Database(":memory:");
  db.exec(TELEMETRY_MIGRATION);
  let now = 1000;

  return {
    db,
    telemetry: new PoolTelemetry(db, () => now),
    time: (v: number) => {
      now = v;
    },
  };
}

const request = new TextEncoder().encode(
  JSON.stringify({
    model: "gpt-6.1-sol",
    service_tier: "fast",
    reasoning: { effort: "medium" },
    input: "private prompt",
  }),
);

const terminal = JSON.stringify({
  type: "response.completed",
  response: {
    service_tier: "default",
    output: [{ text: "private output" }],
    usage: {
      input_tokens: 30,
      output_tokens: 20,
      input_tokens_details: { cached_tokens: 10 },
      output_tokens_details: { reasoning_tokens: 5 },
    },
  },
});

describe("pool telemetry", () => {
  it("measures completed responses with an unknown serving tier", async () => {
    const { db, telemetry, time } = setup();
    const event = JSON.parse(terminal);
    event.response.service_tier = null;
    const observer = telemetry.start("account", request, new Headers())!;
    time(2000);
    await observer
      .wrap(
        new Response(`data: ${JSON.stringify(event)}\n\n`, {
          headers: { "content-type": "text/event-stream" },
        }),
      )
      .text();
    expect(telemetry.report(null).rows[0]).toMatchObject({
      servedTier: null,
      completed: 1,
      outputTokens: 20,
      medianTps: 20,
    });
    db.close();
  });
  it("passes fragmented SSE bytes unchanged and persists only measurements", async () => {
    const { db, telemetry, time } = setup();
    const text = `event: response.completed\r\ndata: ${terminal}\r\n\r\n`;
    let i = 0;

    const upstream = new Response(
      new ReadableStream({
        pull(c) {
          time(1200 + i);

          if (i >= text.length) {
            c.close();

            return;
          }

          c.enqueue(new TextEncoder().encode(text.slice(i, i + 7)));
          i += 7;
        },
      }),
      { headers: { "content-type": "text/event-stream" } },
    );

    const observer = telemetry.start("account", request, new Headers())!;
    expect(await observer.wrap(upstream).text()).toBe(text);
    const report = telemetry.report(null);
    expect(report.rows[0]).toMatchObject({
      requestedTier: "fast",
      servedTier: "default",
      completed: 1,
      inputTokens: 30,
      cachedInputTokens: 10,
      outputTokens: 20,
      reasoningTokens: 5,
    });

    const stored = JSON.stringify(
      db.prepare("SELECT * FROM pool_measurements").all(),
    );

    expect(stored).not.toContain("private prompt");
    expect(stored).not.toContain("private output");
    db.close();
  });
  it("reports missing terminal usage and canceled streams without success", async () => {
    const { db, telemetry } = setup();
    await telemetry
      .start("account", request, new Headers())!
      .wrap(
        new Response("data: {}\n\n", {
          headers: { "content-type": "text/event-stream" },
        }),
      )
      .text();

    const response = telemetry.start("account", request, new Headers())!.wrap(
      new Response(new ReadableStream({ cancel() {} }), {
        headers: { "content-type": "text/event-stream" },
      }),
    );

    await response.body!.cancel();
    expect(telemetry.report(null).rows[0]).toMatchObject({
      requests: 2,
      completed: 0,
      unmeasured: 2,
      medianTps: null,
    });
    db.close();
  });
  it("deduplicates carried quota and separates reset windows", () => {
    const { db, telemetry, time } = setup();

    const quota = (at: number, used: number, reset: number) =>
      quotaSchema.parse({
        accountId: "00000000-0000-4000-8000-000000000001",
        usageRestriction: null,
        extraUsage: null,
        fiveHourUtilization: null,
        fiveHourResetAt: null,
        fiveHourStatus: null,
        sevenDayUtilization: null,
        sevenDayResetAt: null,
        sevenDayStatus: null,
        representativeClaim: null,
        familyWeekly: EMPTY_FAMILY_WEEKLY,
        observedAt: null,
        heldUntil: null,
        error: null,
        limitWindows: [
          {
            slot: "primary",
            windowMinutes: 60,
            utilization: used,
            resetAt: reset,
            observedAt: at,
            source: "header",
            status: "allowed",
          },
        ],
      });

    telemetry.observeQuota(quota(1000, 0.1, 100000));
    telemetry.observeQuota(quota(1000, 0.1, 100000));
    time(2000);
    telemetry.observeQuota(quota(2000, 0.12, 101000));
    time(3000);
    telemetry.observeQuota(quota(3000, 0.01, 200000));
    const report = telemetry.report(null);
    expect(report.windows).toHaveLength(2);
    expect(report.windows[0]).toMatchObject({
      attribution: "unattributed",
      deltaPercent: 2,
    });
    expect(report.windows[1]).toMatchObject({
      attribution: "reset",
      deltaPercent: null,
    });
    db.close();
  });
  it("marks oversized events and JSON responses unmeasured without changing bytes", async () => {
    const { db, telemetry } = setup();

    for (const [body, type] of [
      [
        "data: " + "x".repeat(2 * 1024 * 1024 + 1) + "\n\n",
        "text/event-stream",
      ],
      [JSON.stringify({ usage: { output_tokens: 10 } }), "application/json"],
    ]) {
      const response = telemetry
        .start("account", request, new Headers())!
        .wrap(new Response(body, { headers: { "content-type": type! } }));

      expect(await response.text()).toBe(body);
    }

    expect(telemetry.report(null).rows[0]).toMatchObject({
      requests: 2,
      completed: 0,
      unmeasured: 2,
    });
    db.close();
  });
  it("keeps overlapping and mixed-tier quota intervals unattributed", async () => {
    const { db, telemetry, time } = setup();

    const quota = (at: number, used: number) =>
      quotaSchema.parse({
        accountId: "00000000-0000-4000-8000-000000000001",
        usageRestriction: null,
        extraUsage: null,
        fiveHourUtilization: null,
        fiveHourResetAt: null,
        fiveHourStatus: null,
        sevenDayUtilization: null,
        sevenDayResetAt: null,
        sevenDayStatus: null,
        representativeClaim: null,
        familyWeekly: EMPTY_FAMILY_WEEKLY,
        observedAt: null,
        heldUntil: null,
        error: null,
        limitWindows: [
          {
            slot: "primary",
            windowMinutes: 60,
            utilization: used,
            resetAt: 100000,
            observedAt: at,
            source: "header",
            status: "allowed",
          },
        ],
      });

    const account = "00000000-0000-4000-8000-000000000001";
    telemetry.observeQuota(quota(1000, 0.1));
    time(1100);
    const a = telemetry.start(account, request, new Headers())!;
    time(1200);
    telemetry.observeQuota(quota(1200, 0.11));
    expect(telemetry.report(null).windows[0]?.attribution).toBe("unattributed");
    time(1300);
    await a
      .wrap(
        new Response("data: " + terminal + "\n\n", {
          headers: { "content-type": "text/event-stream" },
        }),
      )
      .text();
    time(1400);

    const b = telemetry.start(
      account,
      new TextEncoder().encode(
        JSON.stringify({ model: "gpt-6.1-sol", service_tier: "ultrafast" }),
      ),
      new Headers(),
    )!;

    time(1500);
    await b
      .wrap(
        new Response("data: " + terminal + "\n\n", {
          headers: { "content-type": "text/event-stream" },
        }),
      )
      .text();
    time(1600);
    telemetry.observeQuota(quota(1600, 0.15));
    expect(telemetry.report(null).windows.at(-1)?.attribution).toBe(
      "unattributed",
    );
    db.close();
  });
  it("does not break transport when storage fails", async () => {
    const { db, telemetry } = setup();
    db.close();

    const response = telemetry.start("account", request, new Headers())!.wrap(
      new Response("data: " + terminal + "\n\n", {
        headers: { "content-type": "text/event-stream" },
      }),
    );

    expect(await response.text()).toContain(terminal);
  });
});
