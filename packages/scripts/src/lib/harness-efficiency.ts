const arms = ["baseline", "candidate"] as const;

const buckets = ["uncachedInput", "cacheRead", "cacheWrite", "output"] as const;

const outcomeKinds = [
  "verified-pass",
  "verified-fail",
  "execution-error",
  "verification-error",
  "unavailable-verification",
  "not-started",
] as const;

const taskClasses = [
  "deterministic-code",
  "plugin-capability",
  "long-output",
] as const;

const coverageKinds = [
  "complete",
  "missing",
  "reset",
  "pruned",
  "unproven",
] as const;

type Arm = (typeof arms)[number];

type Bucket = (typeof buckets)[number];

type Outcome = (typeof outcomeKinds)[number];

type TokenBuckets = Record<Bucket, number | null>;

type Check = "passed" | "failed" | "unavailable";

interface Sample {
  id: string;
  taskId: string;
  taskClass: (typeof taskClasses)[number];
  trial: number;
  taskHash: string;
  startingFilesHash: string;
  verifierHash: string;
  firstArm: Arm;
}

interface Attempt {
  id: string;
  sampleId: string;
  arm: Arm;
  manifestId: string;
  attempt: number;
  termination: "completed" | "timeout" | "aborted";
  observerWallMs: number | null;
  usage:
    | (TokenBuckets & {
        sourceId: string;
        coverage: (typeof coverageKinds)[number];
        nativeRetries: number | null;
        summary: TokenBuckets & { count: number | null };
        resends: { full: number | null; delta: number | null };
      })
    | null;
}

interface OutcomeReceipt {
  sampleId: string;
  arm: Arm;
  manifestId: string;
  result: Outcome;
  evidenceId: string | null;
}

interface HarnessEfficiencyInput {
  manifest: {
    id: string;
    evidence: "synthetic" | "observed";
    sourceSha: string;
    provider: {
      id: string;
      adapter: string;
      model: string;
      runtimeVersion: string;
      optionsHash: string;
      usageSemanticsId: string;
    };
    cacheClass: string;
    timeoutMs: number;
    taskRetryBudget: number;
    arms: Record<Arm, { configurationHash: string; injectionHash: string }>;
    requirements: { summaryUsage: boolean; resendCounts: boolean };
    samples: Sample[];
  };
  checks: {
    guardsPreserved: Check;
    capabilityPreserved: Check;
    experimentValid: Check;
  };
  modelRates: {
    currency: string;
    sourceId: string;
    perMillion: Record<Bucket, number>;
  } | null;
  outcomes: OutcomeReceipt[];
  attempts: Attempt[];
}

interface Metric {
  status: "available" | "undefined-zero-success" | "unavailable";
  coveredAttempts: number;
  startedAttempts: number;
  total: number | null;
  perSuccess: number | null;
}

/* oxlint-disable anti-slop/no-unknown-parameters, anti-slop/no-runtime-typeof, anti-slop/no-unsafe-dictionary-type -- This parser is the external JSON boundary; all returned values have validated domain contracts. */
function object(
  value: unknown,
  fields: readonly string[],
  at: string,
): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${at}: expected an object`);
  }

  // oxlint-disable-next-line anti-slop/require-safety-comment-for-type-assertion -- SAFETY: The preceding guard excludes null, primitives and arrays before named fields are individually parsed.
  const result = value as Record<string, unknown>;

  if (Object.keys(result).some((key) => !fields.includes(key))) {
    throw new Error(`${at}: unexpected field`);
  }

  return result;
}

function list(value: unknown, at: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`${at}: expected an array`);

  return value;
}

function identity(value: unknown, at: string): string {
  if (typeof value !== "string" || !/^[\w.@:+/=-]{1,200}$/u.test(value)) {
    throw new Error(`${at}: expected a safe aggregate identity`);
  }

  return value;
}

function hash(value: unknown, at: string, commit = false): string {
  if (
    typeof value !== "string" ||
    !(commit ? /^(?:[a-f\d]{40}|[a-f\d]{64})$/u : /^[a-f\d]{64}$/u).test(value)
  ) {
    throw new Error(`${at}: expected a source hash`);
  }

  return value;
}

function count(value: unknown, at: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${at}: expected a nonnegative safe integer`);
  }

  return value;
}

function nullableCount(value: unknown, at: string): number | null {
  return value === null ? null : count(value, at);
}

function flag(value: unknown, at: string): boolean {
  if (typeof value !== "boolean") throw new Error(`${at}: expected a boolean`);

  return value;
}

function choice<T extends string>(
  value: unknown,
  values: readonly T[],
  at: string,
): T {
  const result = values.find((candidate) => candidate === value);

  if (result === undefined) {
    throw new Error(`${at}: invalid value`);
  }

  return result;
}

function parseBuckets(
  value: Record<string, unknown>,
  at: string,
): TokenBuckets {
  return {
    uncachedInput: nullableCount(value.uncachedInput, `${at}.uncachedInput`),
    cacheRead: nullableCount(value.cacheRead, `${at}.cacheRead`),
    cacheWrite: nullableCount(value.cacheWrite, `${at}.cacheWrite`),
    output: nullableCount(value.output, `${at}.output`),
  };
}

function parseUsage(value: unknown, at: string): Attempt["usage"] {
  if (value === null) return null;

  const raw = object(
    value,
    [...buckets, "sourceId", "coverage", "nativeRetries", "summary", "resends"],
    at,
  );

  const summary = object(raw.summary, [...buckets, "count"], `${at}.summary`);
  const resends = object(raw.resends, ["full", "delta"], `${at}.resends`);

  const usage = {
    ...parseBuckets(raw, at),
    sourceId: identity(raw.sourceId, `${at}.sourceId`),
    coverage: choice(raw.coverage, coverageKinds, `${at}.coverage`),
    nativeRetries: nullableCount(raw.nativeRetries, `${at}.nativeRetries`),
    summary: {
      ...parseBuckets(summary, `${at}.summary`),
      count: nullableCount(summary.count, `${at}.summary.count`),
    },
    resends: {
      full: nullableCount(resends.full, `${at}.resends.full`),
      delta: nullableCount(resends.delta, `${at}.resends.delta`),
    },
  };

  for (const bucket of buckets) {
    const total = usage[bucket];
    const subset = usage.summary[bucket];

    if (total !== null && subset !== null && subset > total) {
      throw new Error(`${at}.summary: usage exceeds inclusive total`);
    }

    if (usage.summary.count === 0 && subset !== null && subset !== 0) {
      throw new Error(`${at}.summary: usage without a summary call`);
    }
  }

  return usage;
}

export function parseHarnessEfficiencyInput(
  value: unknown,
): HarnessEfficiencyInput {
  const raw = object(
    value,
    ["manifest", "checks", "modelRates", "outcomes", "attempts"],
    "input",
  );

  const manifest = object(
    raw.manifest,
    [
      "id",
      "evidence",
      "sourceSha",
      "provider",
      "cacheClass",
      "timeoutMs",
      "taskRetryBudget",
      "arms",
      "requirements",
      "samples",
    ],
    "manifest",
  );

  const provider = object(
    manifest.provider,
    [
      "id",
      "adapter",
      "model",
      "runtimeVersion",
      "optionsHash",
      "usageSemanticsId",
    ],
    "provider",
  );

  const armConfigs = object(manifest.arms, arms, "arms");

  const requirements = object(
    manifest.requirements,
    ["summaryUsage", "resendCounts"],
    "requirements",
  );

  const checks = object(
    raw.checks,
    ["guardsPreserved", "capabilityPreserved", "experimentValid"],
    "checks",
  );

  const parseArm = (arm: Arm) => {
    const config = object(
      armConfigs[arm],
      ["configurationHash", "injectionHash"],
      `arms.${arm}`,
    );

    return {
      configurationHash: hash(
        config.configurationHash,
        `arms.${arm}.configurationHash`,
      ),
      injectionHash: hash(config.injectionHash, `arms.${arm}.injectionHash`),
    };
  };

  const samples = list(manifest.samples, "samples").map(
    (value, index): Sample => {
      const at = `samples[${index}]`;

      const sample = object(
        value,
        [
          "id",
          "taskId",
          "taskClass",
          "trial",
          "taskHash",
          "startingFilesHash",
          "verifierHash",
          "firstArm",
        ],
        at,
      );

      const trial = count(sample.trial, `${at}.trial`);

      if (trial < 1 || trial > 3)
        throw new Error(`${at}: trial must be between one and three`);

      return {
        id: identity(sample.id, `${at}.id`),
        taskId: identity(sample.taskId, `${at}.taskId`),
        taskClass: choice(sample.taskClass, taskClasses, `${at}.taskClass`),
        trial,
        taskHash: hash(sample.taskHash, `${at}.taskHash`),
        startingFilesHash: hash(
          sample.startingFilesHash,
          `${at}.startingFilesHash`,
        ),
        verifierHash: hash(sample.verifierHash, `${at}.verifierHash`),
        firstArm: choice(sample.firstArm, arms, `${at}.firstArm`),
      };
    },
  );

  if (samples.length < 1 || samples.length > 9)
    throw new Error("manifest: expected one to nine scheduled samples");
  const sampleIds = new Set<string>();
  const trials = new Set<string>();
  const tasks = new Map<string, Sample>();

  for (const sample of samples) {
    const trialId = `${sample.taskId}:${sample.trial}`;

    if (sampleIds.has(sample.id) || trials.has(trialId))
      throw new Error("manifest: duplicate sample or task trial");
    sampleIds.add(sample.id);
    trials.add(trialId);
    const previous = tasks.get(sample.taskId);

    if (
      previous &&
      (previous.taskClass !== sample.taskClass ||
        previous.taskHash !== sample.taskHash ||
        previous.startingFilesHash !== sample.startingFilesHash ||
        previous.verifierHash !== sample.verifierHash)
    ) {
      throw new Error("manifest: task identity changed between trials");
    }

    tasks.set(sample.taskId, sample);
  }

  const attempts = list(raw.attempts, "attempts").map(
    (value, index): Attempt => {
      const at = `attempts[${index}]`;

      const attempt = object(
        value,
        [
          "id",
          "sampleId",
          "arm",
          "manifestId",
          "attempt",
          "termination",
          "observerWallMs",
          "usage",
        ],
        at,
      );

      const number = count(attempt.attempt, `${at}.attempt`);

      if (number < 1) throw new Error(`${at}: attempt numbering starts at one`);

      return {
        id: identity(attempt.id, `${at}.id`),
        sampleId: identity(attempt.sampleId, `${at}.sampleId`),
        arm: choice(attempt.arm, arms, `${at}.arm`),
        manifestId: identity(attempt.manifestId, `${at}.manifestId`),
        attempt: number,
        termination: choice(
          attempt.termination,
          ["completed", "timeout", "aborted"],
          `${at}.termination`,
        ),
        observerWallMs: nullableCount(
          attempt.observerWallMs,
          `${at}.observerWallMs`,
        ),
        usage: parseUsage(attempt.usage, `${at}.usage`),
      };
    },
  );

  const attemptIds = new Set<string>();
  const attemptNumbers = new Set<string>();

  for (const attempt of attempts) {
    const key = `${attempt.arm}:${attempt.sampleId}:${attempt.attempt}`;

    if (!sampleIds.has(attempt.sampleId))
      throw new Error("attempt: unscheduled sample");

    if (attemptIds.has(attempt.id) || attemptNumbers.has(key))
      throw new Error("attempt: duplicate receipt or attempt number");
    attemptIds.add(attempt.id);
    attemptNumbers.add(key);
  }

  const outcomes = list(raw.outcomes, "outcomes").map(
    (value, index): OutcomeReceipt => {
      const at = `outcomes[${index}]`;

      const outcome = object(
        value,
        ["sampleId", "arm", "manifestId", "result", "evidenceId"],
        at,
      );

      const result = choice(outcome.result, outcomeKinds, `${at}.result`);

      const evidenceId =
        outcome.evidenceId === null
          ? null
          : identity(outcome.evidenceId, `${at}.evidenceId`);

      if (
        (result === "verified-pass" || result === "verified-fail") &&
        evidenceId === null
      )
        throw new Error(
          `${at}: verified outcome requires independent evidence`,
        );

      return {
        sampleId: identity(outcome.sampleId, `${at}.sampleId`),
        arm: choice(outcome.arm, arms, `${at}.arm`),
        manifestId: identity(outcome.manifestId, `${at}.manifestId`),
        result,
        evidenceId,
      };
    },
  );

  const outcomeIds = new Set<string>();

  for (const outcome of outcomes) {
    const key = `${outcome.arm}:${outcome.sampleId}`;

    if (!sampleIds.has(outcome.sampleId))
      throw new Error("outcome: unscheduled sample");

    if (outcomeIds.has(key))
      throw new Error("outcome: duplicate sample outcome");
    outcomeIds.add(key);

    const started = attempts.some(
      (attempt) =>
        attempt.arm === outcome.arm && attempt.sampleId === outcome.sampleId,
    );

    if (outcome.result === "not-started" && started)
      throw new Error("outcome: started sample cannot be not-started");

    if (
      (outcome.result === "verified-pass" ||
        outcome.result === "verified-fail") &&
      !started
    )
      throw new Error("outcome: verified sample has no started attempt");
  }

  let modelRates: HarnessEfficiencyInput["modelRates"] = null;

  if (raw.modelRates !== null) {
    const rates = object(
      raw.modelRates,
      ["currency", "sourceId", "perMillion"],
      "modelRates",
    );

    const perMillion = object(
      rates.perMillion,
      buckets,
      "modelRates.perMillion",
    );

    const rate = (bucket: Bucket) => {
      const value = perMillion[bucket];

      if (typeof value !== "number" || !Number.isFinite(value) || value < 0)
        throw new Error("modelRates: expected nonnegative finite rates");

      return value;
    };

    const currency = identity(rates.currency, "modelRates.currency");

    if (!/^[A-Z]{3}$/u.test(currency))
      throw new Error("modelRates: expected an ISO currency code");
    modelRates = {
      currency,
      sourceId: identity(rates.sourceId, "modelRates.sourceId"),
      perMillion: {
        uncachedInput: rate("uncachedInput"),
        cacheRead: rate("cacheRead"),
        cacheWrite: rate("cacheWrite"),
        output: rate("output"),
      },
    };
  }

  return {
    manifest: {
      id: identity(manifest.id, "manifest.id"),
      evidence: choice(
        manifest.evidence,
        ["synthetic", "observed"],
        "manifest.evidence",
      ),
      sourceSha: hash(manifest.sourceSha, "manifest.sourceSha", true),
      provider: {
        id: identity(provider.id, "provider.id"),
        adapter: identity(provider.adapter, "provider.adapter"),
        model: identity(provider.model, "provider.model"),
        runtimeVersion: identity(
          provider.runtimeVersion,
          "provider.runtimeVersion",
        ),
        optionsHash: hash(provider.optionsHash, "provider.optionsHash"),
        usageSemanticsId: identity(
          provider.usageSemanticsId,
          "provider.usageSemanticsId",
        ),
      },
      cacheClass: identity(manifest.cacheClass, "manifest.cacheClass"),
      timeoutMs: count(manifest.timeoutMs, "manifest.timeoutMs"),
      taskRetryBudget: count(
        manifest.taskRetryBudget,
        "manifest.taskRetryBudget",
      ),
      arms: {
        baseline: parseArm("baseline"),
        candidate: parseArm("candidate"),
      },
      requirements: {
        summaryUsage: flag(
          requirements.summaryUsage,
          "requirements.summaryUsage",
        ),
        resendCounts: flag(
          requirements.resendCounts,
          "requirements.resendCounts",
        ),
      },
      samples,
    },
    checks: {
      guardsPreserved: choice(
        checks.guardsPreserved,
        ["passed", "failed", "unavailable"],
        "checks.guardsPreserved",
      ),
      capabilityPreserved: choice(
        checks.capabilityPreserved,
        ["passed", "failed", "unavailable"],
        "checks.capabilityPreserved",
      ),
      experimentValid: choice(
        checks.experimentValid,
        ["passed", "failed", "unavailable"],
        "checks.experimentValid",
      ),
    },
    modelRates,
    outcomes,
    attempts,
  };
}
/* oxlint-enable anti-slop/no-unknown-parameters, anti-slop/no-runtime-typeof, anti-slop/no-unsafe-dictionary-type */

function sum(values: number[]): number {
  const total = values.reduce((result, value) => result + value, 0);

  if (!Number.isSafeInteger(total))
    throw new Error("aggregate exceeds safe integer range");

  return total;
}

function metric(
  attempts: Attempt[],
  successes: number,
  read: (attempt: Attempt) => number | null,
): Metric {
  const values = attempts.flatMap((attempt) => {
    const value = read(attempt);

    return value === null ? [] : [value];
  });

  const complete = values.length === attempts.length;
  const total = complete ? sum(values) : null;

  return {
    status: !complete
      ? "unavailable"
      : successes === 0
        ? "undefined-zero-success"
        : "available",
    coveredAttempts: values.length,
    startedAttempts: attempts.length,
    total,
    perSuccess: total === null || successes === 0 ? null : total / successes,
  };
}

function readUsage(attempt: Attempt) {
  return attempt.usage?.coverage === "complete" ? attempt.usage : null;
}

function armReport(input: HarnessEfficiencyInput, arm: Arm) {
  const attempts = input.attempts.filter((attempt) => attempt.arm === arm);

  const samples = input.manifest.samples.map(
    (sample): Pick<OutcomeReceipt, "sampleId" | "result" | "evidenceId"> => {
      const receipt = input.outcomes.find(
        (outcome) => outcome.arm === arm && outcome.sampleId === sample.id,
      );

      const started = attempts.some(
        (attempt) => attempt.sampleId === sample.id,
      );

      return {
        sampleId: sample.id,
        result:
          receipt?.result ??
          (started ? "unavailable-verification" : "not-started"),
        evidenceId: receipt?.evidenceId ?? null,
      };
    },
  );

  const outcomes: Record<Outcome, number> = {
    "verified-pass": 0,
    "verified-fail": 0,
    "execution-error": 0,
    "verification-error": 0,
    "unavailable-verification": 0,
    "not-started": 0,
  };

  for (const sample of samples) outcomes[sample.result] += 1;
  const successes = outcomes["verified-pass"];

  const resource = (bucket: Bucket) =>
    metric(
      attempts,
      successes,
      (attempt) => readUsage(attempt)?.[bucket] ?? null,
    );

  const resources = {
    uncachedInput: resource("uncachedInput"),
    cacheRead: resource("cacheRead"),
    cacheWrite: resource("cacheWrite"),
    output: resource("output"),
    observerWallMs: metric(
      attempts,
      successes,
      (attempt) => attempt.observerWallMs,
    ),
  };

  const summaryResource = (bucket: Bucket) =>
    metric(
      attempts,
      successes,
      (attempt) => readUsage(attempt)?.summary[bucket] ?? null,
    );

  const summary = {
    uncachedInput: summaryResource("uncachedInput"),
    cacheRead: summaryResource("cacheRead"),
    cacheWrite: summaryResource("cacheWrite"),
    output: summaryResource("output"),
  };

  const rates = input.modelRates;

  const costAvailable =
    rates !== null &&
    buckets.every((bucket) => resources[bucket].total !== null);

  const amount = costAvailable
    ? buckets.reduce(
        (total, bucket) =>
          total +
          ((resources[bucket].total ?? 0) * rates.perMillion[bucket]) /
            1_000_000,
        0,
      )
    : null;

  if (amount !== null && !Number.isFinite(amount))
    throw new Error("model-rate estimate exceeds finite range");

  return {
    scheduledSamples: samples.length,
    startedAttempts: attempts.length,
    outcomes,
    successRate: successes / samples.length,
    samples,
    resources,
    summary,
    diagnostics: {
      timeoutAttempts: attempts.filter(
        (attempt) => attempt.termination === "timeout",
      ).length,
      abortedAttempts: attempts.filter(
        (attempt) => attempt.termination === "aborted",
      ).length,
      taskRetryAttempts: attempts.filter((attempt) => attempt.attempt > 1)
        .length,
      nativeRetries: metric(
        attempts,
        successes,
        (attempt) => readUsage(attempt)?.nativeRetries ?? null,
      ),
      summaryCalls: metric(
        attempts,
        successes,
        (attempt) => readUsage(attempt)?.summary.count ?? null,
      ),
      fullResends: metric(
        attempts,
        successes,
        (attempt) => readUsage(attempt)?.resends.full ?? null,
      ),
      deltaRequests: metric(
        attempts,
        successes,
        (attempt) => readUsage(attempt)?.resends.delta ?? null,
      ),
    },
    cost: {
      kind: amount === null ? "unknown" : "model-rate-estimate",
      amount,
      perSuccess:
        amount === null || successes === 0 ? null : amount / successes,
      currency: rates?.currency ?? null,
      sourceId: rates?.sourceId ?? null,
      actualCharges: "unknown",
    },
  };
}

export function reportHarnessEfficiency(input: HarnessEfficiencyInput) {
  const reports = {
    baseline: armReport(input, "baseline"),
    candidate: armReport(input, "candidate"),
  };

  const invalid = new Set<string>();
  const reasons = new Set<string>();

  if (
    input.manifest.timeoutMs !== 600000 ||
    input.manifest.taskRetryBudget !== 0
  )
    invalid.add("frozen-attempt-policy-changed");

  for (const [check, result] of Object.entries(input.checks)) {
    if (result !== "passed") invalid.add(`${check}:${result}`);
  }

  for (const arm of arms) {
    const report = reports[arm];
    const attempts = input.attempts.filter((attempt) => attempt.arm === arm);

    if (
      attempts.some((attempt) => attempt.manifestId !== input.manifest.id) ||
      input.outcomes.some(
        (outcome) =>
          outcome.arm === arm && outcome.manifestId !== input.manifest.id,
      )
    )
      invalid.add(`${arm}:manifest-mismatch`);

    if (attempts.some((attempt) => attempt.attempt > 1))
      invalid.add(`${arm}:task-retry-budget-exceeded`);

    if (attempts.some((attempt) => attempt.termination !== "completed"))
      reasons.add(`${arm}:attempt-did-not-complete`);

    if (
      attempts.some((attempt) => attempt.attempt !== 1) ||
      input.manifest.samples.some(
        (sample) =>
          attempts.filter((attempt) => attempt.sampleId === sample.id).length >
          1,
      )
    )
      invalid.add(`${arm}:non-independent-attempts`);

    for (const bucket of buckets)
      if (report.resources[bucket].total === null)
        reasons.add(`${arm}:incomplete-${bucket}`);

    if (report.resources.observerWallMs.total === null)
      reasons.add(`${arm}:incomplete-observer-wall-time`);

    if (report.diagnostics.nativeRetries.total === null)
      reasons.add(`${arm}:incomplete-native-retries`);

    if (
      input.manifest.requirements.summaryUsage &&
      (report.diagnostics.summaryCalls.total === null ||
        buckets.some((bucket) => report.summary[bucket].total === null))
    )
      reasons.add(`${arm}:incomplete-summary`);

    if (
      input.manifest.requirements.resendCounts &&
      (report.diagnostics.fullResends.total === null ||
        report.diagnostics.deltaRequests.total === null)
    )
      reasons.add(`${arm}:incomplete-resends`);

    if (report.outcomes["verified-pass"] === 0)
      reasons.add(`${arm}:zero-verified-successes`);

    if (
      outcomeKinds.some(
        (kind) =>
          kind !== "verified-pass" &&
          kind !== "verified-fail" &&
          report.outcomes[kind] > 0,
      )
    )
      reasons.add(`${arm}:incomplete-verified-outcomes`);
  }

  for (const sample of input.manifest.samples) {
    const baseline = reports.baseline.samples.find(
      (value) => value.sampleId === sample.id,
    )!;

    const candidate = reports.candidate.samples.find(
      (value) => value.sampleId === sample.id,
    )!;

    if (
      baseline.result === "verified-pass" &&
      candidate.result !== "verified-pass"
    )
      reasons.add("candidate:lost-baseline-success");

    const pairedInput = arms.map((arm) => {
      let total = 0;

      for (const attempt of input.attempts) {
        if (attempt.arm !== arm || attempt.sampleId !== sample.id) continue;
        const value = readUsage(attempt)?.uncachedInput ?? null;

        if (value === null) return null;
        total = sum([total, value]);
      }

      return total;
    });

    if (
      pairedInput[0] !== null &&
      pairedInput[1] !== null &&
      pairedInput[1]! >= pairedInput[0]!
    ) {
      reasons.add("candidate:inconsistent-matched-task-reduction");
    }
  }

  if (input.manifest.evidence === "synthetic")
    reasons.add("synthetic-feasibility-only");

  if (
    taskClasses.some(
      (taskClass) =>
        !input.manifest.samples.some(
          (sample) => sample.taskClass === taskClass,
        ),
    )
  )
    reasons.add("incomplete-task-classes");

  const taskIds = [
    ...new Set(input.manifest.samples.map((sample) => sample.taskId)),
  ];

  for (const taskId of taskIds) {
    const samples = input.manifest.samples
      .filter((sample) => sample.taskId === taskId)
      .sort((left, right) => left.trial - right.trial);

    if (samples.length < 2) reasons.add("insufficient-paired-repetitions");

    if (
      samples.some(
        (sample, index) =>
          sample.trial !== index + 1 ||
          (index > 0 && sample.firstArm === samples[index - 1]!.firstArm),
      )
    )
      invalid.add("paired-order-or-trial-policy-changed");

    const taskReports = arms.map((arm) => {
      const successes = reports[arm].samples.filter(
        (sample) =>
          samples.some((planned) => planned.id === sample.sampleId) &&
          sample.result === "verified-pass",
      ).length;

      return metric(
        input.attempts.filter(
          (attempt) =>
            attempt.arm === arm &&
            samples.some((sample) => sample.id === attempt.sampleId),
        ),
        successes,
        (attempt) => readUsage(attempt)?.uncachedInput ?? null,
      );
    });

    if (
      taskReports[0]!.perSuccess === null ||
      taskReports[1]!.perSuccess === null ||
      taskReports[1]!.perSuccess >= taskReports[0]!.perSuccess
    )
      reasons.add("candidate:inconsistent-matched-task-reduction");
  }

  const baseline = reports.baseline;
  const candidate = reports.candidate;

  if (
    baseline.resources.uncachedInput.perSuccess === null ||
    candidate.resources.uncachedInput.perSuccess === null ||
    candidate.resources.uncachedInput.perSuccess >=
      baseline.resources.uncachedInput.perSuccess
  )
    reasons.add("candidate:no-uncached-input-per-success-reduction");

  if (
    baseline.resources.observerWallMs.perSuccess !== null &&
    candidate.resources.observerWallMs.perSuccess !== null &&
    candidate.resources.observerWallMs.perSuccess >
      baseline.resources.observerWallMs.perSuccess
  )
    reasons.add("candidate:increased-observed-elapsed-time");

  if (
    baseline.diagnostics.fullResends.perSuccess !== null &&
    candidate.diagnostics.fullResends.perSuccess !== null &&
    candidate.diagnostics.fullResends.perSuccess >
      baseline.diagnostics.fullResends.perSuccess
  )
    reasons.add("candidate:increased-full-resends");

  const increasedBucket = (["cacheRead", "cacheWrite", "output"] as const).some(
    (key) => {
      const before = baseline.resources[key].perSuccess;
      const after = candidate.resources[key].perSuccess;

      return before !== null && after !== null && after > before;
    },
  );

  if (
    increasedBucket &&
    (baseline.cost.perSuccess === null ||
      candidate.cost.perSuccess === null ||
      candidate.cost.perSuccess >= baseline.cost.perSuccess)
  )
    reasons.add("candidate:unresolved-cache-or-output-tradeoff");

  if (
    baseline.cost.perSuccess !== null &&
    candidate.cost.perSuccess !== null &&
    candidate.cost.perSuccess >= baseline.cost.perSuccess
  )
    reasons.add("candidate:no-model-rate-cost-reduction");
  const allReasons = [...new Set([...invalid, ...reasons])];

  const status =
    input.attempts.length === 0
      ? "not-applicable"
      : allReasons.length === 0
        ? "promote"
        : "discard";

  return {
    schemaVersion: 1,
    manifest: input.manifest,
    checks: input.checks,
    modelRates: input.modelRates,
    inputIdentities: {
      attempts: input.attempts.map((attempt) => ({
        id: attempt.id,
        sampleId: attempt.sampleId,
        arm: attempt.arm,
        manifestId: attempt.manifestId,
        usageSourceId: attempt.usage?.sourceId ?? null,
        coverage: attempt.usage?.coverage ?? "missing",
      })),
      outcomes: input.outcomes.map((outcome) => ({
        sampleId: outcome.sampleId,
        arm: outcome.arm,
        manifestId: outcome.manifestId,
        evidenceId: outcome.evidenceId,
      })),
    },
    valid: invalid.size === 0,
    arms: reports,
    decision: {
      status,
      reasons:
        status === "promote"
          ? ["lower-uncached-input-per-success-in-every-matched-task"]
          : allReasons,
    },
    limits: [
      "Aggregate completeness and verifier evidence are supplied attestations, not independently collected by this offline report.",
      "Summary usage is included in the four token totals and is not added again.",
      "Observer wall time includes queue and human waits; no unmeasured wait is subtracted.",
      "Model-rate estimates are not invoice evidence or measured subscription savings.",
      "Decisions apply only to the supplied paired workload; promotion does not enable or release a product change.",
    ],
  };
}
