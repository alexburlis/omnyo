import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  parseHarnessEfficiencyInput,
  reportHarnessEfficiency,
} from "../src/lib/harness-efficiency.js";

function fixture() {
  return parseHarnessEfficiencyInput(
    JSON.parse(
      readFileSync(
        new URL(
          "./fixtures/harness-efficiency/accounting.json",
          import.meta.url,
        ),
        "utf8",
      ),
    ),
  );
}

function repeatedObservedFixture() {
  const input = fixture();
  const sourceSample = input.manifest.samples[0]!;
  const sourceAttempts = [input.attempts[0]!, input.attempts[2]!];
  const sourceOutcomes = [input.outcomes[0]!, input.outcomes[2]!];
  input.manifest.evidence = "observed";
  input.manifest.samples = [];
  input.attempts = [];
  input.outcomes = [];

  for (const taskClass of [
    "deterministic-code",
    "plugin-capability",
    "long-output",
  ] as const) {
    for (const trial of [1, 2]) {
      const sampleId = `${taskClass}-${trial}`;
      input.manifest.samples.push({
        ...sourceSample,
        id: sampleId,
        taskId: taskClass,
        taskClass,
        trial,
        firstArm: trial === 1 ? "baseline" : "candidate",
      });

      for (const source of sourceAttempts) {
        input.attempts.push({
          ...structuredClone(source),
          id: `${source.arm}-${sampleId}`,
          sampleId,
        });
      }

      for (const source of sourceOutcomes) {
        input.outcomes.push({ ...source, sampleId });
      }
    }
  }

  return input;
}

describe("harness efficiency accounting", () => {
  it("recommends promotion only for complete repeated matched observed samples", () => {
    const report = reportHarnessEfficiency(repeatedObservedFixture());

    expect(report.valid).toBe(true);
    expect(report.arms.baseline.scheduledSamples).toBe(6);
    expect(report.decision).toEqual({
      status: "promote",
      reasons: ["lower-uncached-input-per-success-in-every-matched-task"],
    });
  });

  it.each([
    "guardsPreserved",
    "capabilityPreserved",
    "experimentValid",
  ] as const)("cannot promote without the %s acceptance check", (check) => {
    const input = repeatedObservedFixture();
    input.checks[check] = "failed";

    expect(reportHarnessEfficiency(input).decision.status).toBe("discard");
  });

  it("does not promote total savings that conceal a matched-task regression", () => {
    const input = repeatedObservedFixture();
    input.attempts.find(
      (attempt) => attempt.arm === "candidate",
    )!.usage!.uncachedInput = 90;

    expect(reportHarnessEfficiency(input).decision.reasons).toContain(
      "candidate:inconsistent-matched-task-reduction",
    );
  });

  it.each(["cache-read", "cache-write", "full-resend", "elapsed"] as const)(
    "discards an unresolved increased %s tradeoff",
    (tradeoff) => {
      const input = repeatedObservedFixture();

      const attempt = input.attempts.find(
        (value) => value.arm === "candidate",
      )!;

      if (tradeoff === "cache-read") attempt.usage!.cacheRead = 100000;
      else if (tradeoff === "cache-write") attempt.usage!.cacheWrite = 100;
      else if (tradeoff === "full-resend") attempt.usage!.resends.full = 2;
      else attempt.observerWallMs = 2000;

      expect(reportHarnessEfficiency(input).decision.status).toBe("discard");
    },
  );

  it("uses every started attempt over verified-success samples, with four disjoint token buckets", () => {
    const report = reportHarnessEfficiency(fixture());

    expect(report.arms.baseline.outcomes).toEqual({
      "verified-pass": 1,
      "verified-fail": 1,
      "execution-error": 0,
      "verification-error": 0,
      "unavailable-verification": 0,
      "not-started": 0,
    });
    expect(report.arms.baseline.successRate).toBe(0.5);
    expect(report.arms.candidate.successRate).toBe(0.5);
    expect(report.arms.baseline.resources.uncachedInput).toEqual({
      status: "available",
      coveredAttempts: 2,
      startedAttempts: 2,
      total: 130,
      perSuccess: 130,
    });
    expect(report.arms.candidate.resources.uncachedInput.total).toBe(100);
    expect(report.arms.candidate.resources.uncachedInput.perSuccess).toBe(100);
    expect(report.arms.baseline.resources.cacheRead.total).toBe(20);
    expect(report.arms.baseline.resources.cacheWrite.total).toBe(10);
    expect(report.arms.baseline.resources.output.total).toBe(40);
    expect(report.decision.status).toBe("discard");
    expect(report.decision.reasons).toContain("synthetic-feasibility-only");
  });

  it("keeps unstarted and unverified scheduled samples in distinct outcome categories", () => {
    const input = fixture();
    input.attempts = input.attempts.filter(
      (attempt) => attempt.id !== "candidate-2",
    );
    input.outcomes = input.outcomes.filter(
      (outcome) => outcome.arm !== "candidate",
    );

    const arm = reportHarnessEfficiency(input).arms.candidate;

    expect(arm.scheduledSamples).toBe(2);
    expect(arm.outcomes["not-started"]).toBe(1);
    expect(arm.outcomes["unavailable-verification"]).toBe(1);
    expect(arm.successRate).toBe(0);
    expect(arm.resources.uncachedInput.total).toBe(60);
    expect(arm.resources.uncachedInput.perSuccess).toBeNull();
    expect(arm.resources.uncachedInput.status).toBe("undefined-zero-success");
  });

  it.each(["missing", "reset", "pruned", "unproven"] as const)(
    "makes incomplete %s resource coverage unavailable rather than a complete-case subtotal",
    (coverage) => {
      const input = fixture();
      input.attempts[3]!.usage!.coverage = coverage;

      const report = reportHarnessEfficiency(input);

      expect(report.arms.candidate.resources.uncachedInput).toEqual({
        status: "unavailable",
        coveredAttempts: 1,
        startedAttempts: 2,
        total: null,
        perSuccess: null,
      });
      expect(report.decision.status).toBe("discard");
    },
  );

  it("does not hide a missing cache-write bucket behind complete uncached input", () => {
    const input = fixture();
    input.attempts[3]!.usage!.cacheWrite = null;

    const report = reportHarnessEfficiency(input);

    expect(report.arms.candidate.resources.uncachedInput.total).toBe(100);
    expect(report.arms.candidate.resources.cacheWrite.status).toBe(
      "unavailable",
    );
    expect(report.decision.reasons).toContain(
      "candidate:incomplete-cacheWrite",
    );
  });

  it("keeps zero-success ratios undefined even with complete resource totals", () => {
    const input = fixture();

    for (const outcome of input.outcomes) outcome.result = "verified-fail";

    const report = reportHarnessEfficiency(input);

    expect(report.arms.baseline.resources.uncachedInput).toMatchObject({
      status: "undefined-zero-success",
      total: 130,
      perSuccess: null,
    });
    expect(report.decision.status).toBe("discard");
  });

  it("includes aborted task retries and native retries without adding successes", () => {
    const input = fixture();
    const retry = structuredClone(input.attempts[2]!);
    retry.id = "candidate-aborted-retry";
    retry.attempt = 2;
    retry.termination = "aborted";
    retry.usage!.uncachedInput = 25;
    retry.usage!.nativeRetries = 2;
    input.attempts.push(retry);

    const report = reportHarnessEfficiency(input);

    expect(report.arms.candidate.outcomes["verified-pass"]).toBe(1);
    expect(report.arms.candidate.resources.uncachedInput.perSuccess).toBe(125);
    expect(report.arms.candidate.diagnostics.nativeRetries.total).toBe(2);
    expect(report.arms.candidate.diagnostics.abortedAttempts).toBe(1);
    expect(report.valid).toBe(false);
    expect(report.decision.reasons).toContain(
      "candidate:task-retry-budget-exceeded",
    );
  });

  it("retains timeout/error resources while outcomes remain independent", () => {
    const input = fixture();
    input.attempts[3]!.termination = "timeout";
    input.attempts[3]!.observerWallMs = 600000;
    input.outcomes[3]!.result = "execution-error";
    input.outcomes[3]!.evidenceId = null;

    const arm = reportHarnessEfficiency(input).arms.candidate;

    expect(arm.outcomes["execution-error"]).toBe(1);
    expect(arm.resources.uncachedInput.perSuccess).toBe(100);
    expect(arm.resources.observerWallMs.total).toBe(601000);
    expect(arm.diagnostics.timeoutAttempts).toBe(1);
  });

  it("reports compaction usage as an included subset and resends separately", () => {
    const input = fixture();
    input.attempts[2]!.usage!.summary = {
      count: 1,
      uncachedInput: 20,
      cacheRead: 2,
      cacheWrite: 1,
      output: 5,
    };
    input.attempts[2]!.usage!.resends = { full: 2, delta: 3 };

    const arm = reportHarnessEfficiency(input).arms.candidate;

    expect(arm.resources.uncachedInput.total).toBe(100);
    expect(arm.summary.uncachedInput.total).toBe(20);
    expect(arm.diagnostics.summaryCalls.total).toBe(1);
    expect(arm.diagnostics.fullResends.total).toBe(2);
    expect(arm.diagnostics.deltaRequests.total).toBe(4);
  });

  it.each(["summary", "resends"] as const)(
    "rejects promotion with unavailable required %s accounting",
    (field) => {
      const input = fixture();

      if (field === "summary") input.attempts[2]!.usage!.summary.output = null;
      else input.attempts[2]!.usage!.resends.full = null;

      expect(reportHarnessEfficiency(input).decision.reasons).toContain(
        `candidate:incomplete-${field}`,
      );
    },
  );

  it("labels rate arithmetic as an estimate and never invents actual charges", () => {
    const input = fixture();
    input.modelRates = {
      currency: "USD",
      sourceId: "synthetic-rate-card",
      perMillion: { uncachedInput: 2, cacheRead: 1, cacheWrite: 3, output: 4 },
    };

    const cost = reportHarnessEfficiency(input).arms.baseline.cost;

    expect(cost.kind).toBe("model-rate-estimate");
    expect(cost.amount).toBeCloseTo(0.00047);
    expect(cost.currency).toBe("USD");
    expect(cost.actualCharges).toBe("unknown");
  });

  it("marks receipts bound to another manifest invalid while retaining their resources", () => {
    const input = fixture();
    input.attempts[2]!.manifestId = "different-frozen-manifest";

    const report = reportHarnessEfficiency(input);

    expect(report.valid).toBe(false);
    expect(report.arms.candidate.resources.uncachedInput.total).toBe(100);
    expect(report.decision.reasons).toContain("candidate:manifest-mismatch");
  });

  it("cannot promote a candidate that loses a baseline success", () => {
    const input = fixture();
    input.outcomes[2]!.result = "verified-fail";

    expect(reportHarnessEfficiency(input).decision.reasons).toContain(
      "candidate:lost-baseline-success",
    );
  });

  it("reports no started workload as not applicable", () => {
    const input = fixture();
    input.attempts = [];
    input.outcomes = [];

    const report = reportHarnessEfficiency(input);

    expect(report.arms.baseline.outcomes["not-started"]).toBe(2);
    expect(report.decision.status).toBe("not-applicable");
  });

  it.each([
    [
      "duplicate attempt receipt",
      (input: ReturnType<typeof fixture>) =>
        input.attempts.push(structuredClone(input.attempts[0]!)),
    ],
    [
      "duplicate sample outcome",
      (input: ReturnType<typeof fixture>) =>
        input.outcomes.push(structuredClone(input.outcomes[0]!)),
    ],
    [
      "unknown scheduled sample",
      (input: ReturnType<typeof fixture>) => {
        input.attempts[0]!.sampleId = "unscheduled";
      },
    ],
    [
      "negative token value",
      (input: ReturnType<typeof fixture>) => {
        input.attempts[0]!.usage!.output = -1;
      },
    ],
    [
      "summary outside total",
      (input: ReturnType<typeof fixture>) => {
        input.attempts[0]!.usage!.summary.output = 21;
      },
    ],
    [
      "unbound verifier outcome",
      (input: ReturnType<typeof fixture>) => {
        input.outcomes[0]!.evidenceId = null;
      },
    ],
  ] as const)("rejects malformed accounting: %s", (_name, mutate) => {
    const input = fixture();
    mutate(input);

    expect(() => parseHarnessEfficiencyInput(input)).toThrow();
  });

  it("rejects unallowlisted transcript-bearing fields at the JSON boundary", () => {
    const input = fixture();

    expect(() =>
      parseHarnessEfficiencyInput({ ...input, messages: [] }),
    ).toThrow(/unexpected field/u);
    expect(() =>
      parseHarnessEfficiencyInput({
        ...input,
        attempts: [
          { ...input.attempts[0], sessionFile: "private-session.jsonl" },
        ],
      }),
    ).toThrow(/unexpected field/u);
  });
});
