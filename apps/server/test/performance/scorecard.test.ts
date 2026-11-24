import { describe, expect, it } from "vitest";
import {
  assertPrepared,
  categories,
  compare,
  failures,
  markdown,
  scorecardSchema,
  summarize,
  type Scorecard,
} from "./scorecard.js";

function fixture(): Scorecard {
  return scorecardSchema.parse({
    schema: 1,
    recordedAt: "2026-10-20T00:00:00.000Z",
    source: { commit: "baseline", treeHash: "tree", dirty: false },
    buildHash: "build",
    contract: {
      suiteHash: "suite",
      fixture: "fixture-v1",
      machine: "test",
      platform: "test",
      cpu: "test",
      browser: "Chrome test",
      node: "test",
      viewport: "1440x1000",
      samples: 30,
    },
    environment: { node: "test", loadAverage: [0, 0, 0], parallelism: 2 },
    limits: ["Local test"],
    errors: [],
    metrics: categories.map((category) => ({
      id: category,
      category,
      boundary: "request to verified response",
      surface: "http",
      cache: "warm",
      warmups: 2,
      limits: ["No physical paint"],
      samples: Array.from({ length: 30 }, (_, index) => ({
        durationMs: index + 1,
        error: null,
        requests: 1,
        responseBytes: 100,
        domNodes: null,
      })),
    })),
  });
}

describe("performance evidence and regression comparison", () => {
  it("refuses stale source, suite or built bytes while allowing the same content to be committed", () => {
    const prepared = {
      source: { commit: "before", treeHash: "content", dirty: true },
      buildHash: "built",
      suiteHash: "fixture",
    };

    expect(() =>
      assertPrepared(prepared, {
        ...prepared,
        source: { ...prepared.source, commit: "after", dirty: false },
      }),
    ).not.toThrow();

    for (const current of [
      { ...prepared, buildHash: "stale" },
      { ...prepared, suiteHash: "changed" },
      { ...prepared, source: { ...prepared.source, treeHash: "changed" } },
    ])
      expect(() => assertPrepared(prepared, current)).toThrow("prepare again");
  });
  it("uses nearest-rank p95, keeps failures and refuses to invent small-sample tails", () => {
    const report = fixture();
    const metric = report.metrics[0]!;
    expect(summarize(metric)).toMatchObject({
      p50: 15,
      p95: 29,
      max: 30,
      count: 30,
      errors: 0,
    });
    metric.samples[0]!.error = "timeout";
    expect(summarize(metric)).toMatchObject({
      p95: null,
      max: 30,
      count: 30,
      errors: 1,
    });
    expect(failures(report)).toEqual(["startup[0]: timeout"]);
    metric.samples = metric.samples.slice(0, 3);
    expect(summarize(metric).p95).toBeNull();
  });

  it("accepts different source/builds but rejects different workload, browser or boundaries", () => {
    const baseline = fixture();
    const candidate = fixture();
    candidate.source.commit = "candidate";
    candidate.buildHash = "changed";
    expect(compare(baseline, candidate)).toEqual([]);
    candidate.contract.browser = "another Chrome";
    expect(compare(baseline, candidate)).toContain(
      "Incompatible workload or environment contract",
    );
    candidate.contract.browser = baseline.contract.browser;
    candidate.metrics[0]!.cache = "fresh-context";
    expect(compare(baseline, candidate)).toContain(
      "Incompatible metric boundary: startup",
    );
  });

  it("fails real latency, bytes and request regressions without mutating the baseline", () => {
    const baseline = fixture();
    const before = JSON.stringify(baseline);
    const candidate = fixture();

    for (const sample of candidate.metrics[0]!.samples) {
      sample.durationMs += 100;
      sample.requests++;
      sample.responseBytes += 2048;
    }

    expect(compare(baseline, candidate)).toEqual([
      "startup: 129.00ms exceeds 57.70ms (p95)",
      "startup: response bytes increased beyond 10% + 1KiB",
      "startup: request count increased",
    ]);
    expect(JSON.stringify(baseline)).toBe(before);
    expect(() => compare(baseline, candidate, NaN)).toThrow(
      "finite and nonnegative",
    );
  });

  it("retains overlapping browser traffic separately from direct HTTP action gates", () => {
    const baseline = fixture();
    const candidate = fixture();

    for (const sample of baseline.metrics[0]!.samples)
      sample.browserTraffic = { requests: 0, responseBytes: 0 };

    for (const sample of candidate.metrics[0]!.samples)
      sample.browserTraffic = { requests: 12, responseBytes: 4096 };

    const parsed = scorecardSchema.parse(candidate);
    expect(compare(baseline, parsed)).toEqual([]);
    expect(summarize(parsed.metrics[0]!).browserTraffic).toEqual({
      requests: 12,
      responseBytes: 4096,
    });
    expect(markdown(parsed)).toContain("| startup | 12 | 4096 |");
    parsed.metrics[0]!.samples[0]!.requests = 2;
    expect(compare(baseline, parsed)).toContain(
      "startup: request count increased",
    );
  });

  it("rejects failed baselines and candidates even when surviving durations improve", () => {
    const baseline = fixture();
    const candidate = fixture();
    baseline.errors.push("failed warmup");
    candidate.metrics[0]!.samples[0]!.error = "wrong content";
    candidate.errors.push("browser error");
    expect(compare(baseline, candidate)).toEqual(
      expect.arrayContaining([
        "Invalid baseline: failed warmup",
        "Candidate failure: browser error",
        "Candidate failure: startup[0]: wrong content",
      ]),
    );
  });

  it("rejects missing categories, duplicate journeys and truncated samples", () => {
    for (const diagnostic of ["history-navigation", "browser-actions"])
      expect(
        scorecardSchema.safeParse({
          ...fixture(),
          diagnostic,
        }).success,
      ).toBe(false);
    const report = fixture();
    report.metrics.pop();
    expect(scorecardSchema.safeParse(report).success).toBe(false);
    report.metrics.push(report.metrics[0]!);
    expect(scorecardSchema.safeParse(report).success).toBe(false);
    const incomplete = fixture();
    incomplete.metrics[0]!.samples.pop();
    expect(scorecardSchema.safeParse(incomplete).success).toBe(false);
    const cold = fixture();
    cold.metrics[0]!.cache = "fresh-context";
    cold.metrics[0]!.samples = cold.metrics[0]!.samples.slice(0, 3);
    expect(scorecardSchema.safeParse(cold).success).toBe(true);
    cold.metrics[0]!.samples.pop();
    expect(scorecardSchema.safeParse(cold).success).toBe(false);
  });

  it("renders measurement boundaries and limits beside the ranked values", () => {
    const report = fixture();
    const rendered = markdown(report);
    expect(rendered).toContain(
      "| startup | http / warm | 30 | 15.00 | 29.00 | 30.00 | 0 |",
    );
    expect(rendered).toContain(
      "request to verified response Limits: No physical paint",
    );
    expect(rendered).toContain("dirty=false");
  });
});
