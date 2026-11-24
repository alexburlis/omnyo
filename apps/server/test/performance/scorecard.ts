import { createHash } from "node:crypto";
import { z } from "zod";

export const categories = [
  "startup",
  "navigation",
  "new-chat",
  "send",
  "interactions",
  "streaming",
  "history",
  "composer",
  "discovery",
  "search",
  "files",
  "terminal",
  "pickers",
  "plugins-settings",
  "reconnect-updates",
  "background",
] as const;

export const bindingSchema = z
  .object({
    source: z
      .object({
        commit: z.string().min(1),
        treeHash: z.string().min(1),
        dirty: z.boolean(),
      })
      .strict(),
    buildHash: z.string().min(1),
    suiteHash: z.string().min(1),
  })
  .strict();

export function assertPrepared(
  prepared: z.infer<typeof bindingSchema>,
  current: z.infer<typeof bindingSchema>,
): void {
  if (
    prepared.source.treeHash !== current.source.treeHash ||
    prepared.buildHash !== current.buildHash ||
    prepared.suiteHash !== current.suiteHash
  )
    throw new Error(
      "Source, suite or built app changed since preparation; prepare again before measuring",
    );
}

export const sampleSchema = z
  .object({
    durationMs: z.number().finite().nonnegative(),
    error: z.string().nullable(),
    requests: z.number().int().nonnegative(),
    responseBytes: z.number().int().nonnegative(),
    browserTraffic: z
      .object({
        requests: z.number().int().nonnegative(),
        responseBytes: z.number().int().nonnegative(),
      })
      .strict()
      .optional(),
    domNodes: z.number().int().nonnegative().nullable(),
  })
  .strict();

export const metricSchema = z
  .object({
    id: z.string().min(1),
    category: z.enum(categories),
    boundary: z.string().min(1),
    surface: z.enum(["browser", "http"]),
    cache: z.enum(["fresh-context", "warm"]),
    warmups: z.number().int().nonnegative(),
    limits: z.array(z.string().min(1)).min(1),
    samples: z.array(sampleSchema).min(1),
  })
  .strict();

export const scorecardSchema = z
  .object({
    schema: z.literal(1),
    recordedAt: z.string().datetime(),
    source: z
      .object({
        commit: z.string().min(1),
        treeHash: z.string().min(1),
        dirty: z.boolean(),
      })
      .strict(),
    buildHash: z.string().min(1),
    contract: z
      .object({
        suiteHash: z.string().min(1),
        fixture: z.string().min(1),
        machine: z.string().min(1),
        platform: z.string().min(1),
        cpu: z.string().min(1),
        browser: z.string().min(1),
        node: z.string().min(1),
        viewport: z.string().min(1),
        samples: z.number().int().min(1),
      })
      .strict(),
    environment: z
      .object({
        node: z.string(),
        loadAverage: z.array(z.number()),
        parallelism: z.number().int().positive(),
      })
      .strict(),
    limits: z.array(z.string()).min(1),
    errors: z.array(z.string()),
    metrics: z.array(metricSchema).min(1),
  })
  .strict()
  .superRefine((report, context) => {
    const ids = report.metrics.map((metric) => metric.id);

    if (new Set(ids).size !== ids.length)
      context.addIssue({ code: "custom", message: "Duplicate metric IDs" });

    for (const category of categories)
      if (!report.metrics.some((metric) => metric.category === category))
        context.addIssue({
          code: "custom",
          message: `Missing category: ${category}`,
        });

    for (const metric of report.metrics)
      if (
        metric.samples.length !==
        (metric.cache === "fresh-context" ? 3 : report.contract.samples)
      )
        context.addIssue({
          code: "custom",
          message: `Incomplete samples: ${metric.id}`,
        });
  });

export type Scorecard = z.infer<typeof scorecardSchema>;

export type Metric = z.infer<typeof metricSchema>;

export type Sample = z.infer<typeof sampleSchema>;

export function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function summarize(metric: Metric) {
  const values = metric.samples
    .filter((sample) => sample.error === null)
    .map((sample) => sample.durationMs)
    .sort((a, b) => a - b);

  const percentile = (fraction: number) =>
    values[Math.ceil(values.length * fraction) - 1] ?? null;

  const browserTraffic = metric.samples.flatMap((sample) =>
    sample.browserTraffic ? [sample.browserTraffic] : [],
  );

  return {
    count: metric.samples.length,
    errors: metric.samples.filter((sample) => sample.error !== null).length,
    p50: percentile(0.5),
    p95: values.length >= 30 ? percentile(0.95) : null,
    max: values.at(-1) ?? null,
    requests: Math.max(...metric.samples.map((sample) => sample.requests)),
    responseBytes: Math.max(
      ...metric.samples.map((sample) => sample.responseBytes),
    ),
    browserTraffic:
      browserTraffic.length === 0
        ? null
        : {
            requests: Math.max(
              ...browserTraffic.map((traffic) => traffic.requests),
            ),
            responseBytes: Math.max(
              ...browserTraffic.map((traffic) => traffic.responseBytes),
            ),
          },
  };
}

export function failures(report: Scorecard): string[] {
  return [
    ...report.errors,
    ...report.metrics.flatMap((metric) =>
      metric.samples.flatMap((sample, index) =>
        sample.error === null
          ? []
          : [`${metric.id}[${index}]: ${sample.error}`],
      ),
    ),
  ];
}

export function compare(
  baseline: Scorecard,
  candidate: Scorecard,
  relative = 0.3,
  absoluteMs = 20,
): string[] {
  if (
    !Number.isFinite(relative) ||
    relative < 0 ||
    !Number.isFinite(absoluteMs) ||
    absoluteMs < 0
  )
    throw new Error("Regression tolerances must be finite and nonnegative");

  const issues = [
    ...failures(candidate).map((failure) => `Candidate failure: ${failure}`),
    ...failures(baseline).map((failure) => `Invalid baseline: ${failure}`),
  ];

  if (JSON.stringify(baseline.contract) !== JSON.stringify(candidate.contract))
    issues.push("Incompatible workload or environment contract");

  const previous = new Map(
    baseline.metrics.map((metric) => [metric.id, metric]),
  );

  if (previous.size !== candidate.metrics.length)
    issues.push("Metric inventory changed");

  for (const metric of candidate.metrics) {
    const before = previous.get(metric.id);

    if (!before) {
      issues.push(`Missing baseline: ${metric.id}`);
      continue;
    }

    const identity = ({ samples: _samples, ...definition }: Metric) =>
      definition;

    if (JSON.stringify(identity(before)) !== JSON.stringify(identity(metric))) {
      issues.push(`Incompatible metric boundary: ${metric.id}`);
      continue;
    }

    const a = summarize(before);
    const b = summarize(metric);
    const oldValue = a.p95 ?? a.max;
    const newValue = b.p95 ?? b.max;

    if (
      oldValue !== null &&
      newValue !== null &&
      newValue > oldValue * (1 + relative) + absoluteMs
    )
      issues.push(
        `${metric.id}: ${newValue.toFixed(2)}ms exceeds ${(oldValue * (1 + relative) + absoluteMs).toFixed(2)}ms (${a.p95 === null ? "max" : "p95"})`,
      );

    if (b.responseBytes > a.responseBytes * 1.1 + 1024)
      issues.push(`${metric.id}: response bytes increased beyond 10% + 1KiB`);

    if (b.requests > a.requests)
      issues.push(`${metric.id}: request count increased`);
  }

  return issues;
}

export function markdown(report: Scorecard): string {
  const rows = [...report.metrics].sort(
    (a, b) =>
      (summarize(b).p95 ?? summarize(b).max ?? 0) -
      (summarize(a).p95 ?? summarize(a).max ?? 0),
  );

  const number = (value: number | null) =>
    value === null ? "—" : value.toFixed(2);

  return [
    "# Omnyo performance scorecard",
    "",
    `${report.recordedAt}; source ${report.source.commit}; dirty=${report.source.dirty}; build ${report.buildHash}.`,
    "",
    `${report.contract.machine}; ${report.contract.platform}; ${report.contract.cpu}; ${report.contract.browser}; ${report.contract.viewport}.`,
    "",
    "Milliseconds; p95 requires 30 successful samples. Failures stay in the raw result and fail the run. Browser windows include background requests and completed encoded bodies. HTTP action counts and decoded bytes cover direct fixture calls; overlapping browser traffic is reported separately. Canceled browser requests remain counted as starts. WebSocket frames are excluded.",
    "",
    "| Journey | Surface / cache | n | p50 ms | p95 ms | max ms | errors | requests max | bytes max |",
    "| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |",
    ...rows.map((metric) => {
      const stats = summarize(metric);

      return `| ${metric.id} | ${metric.surface} / ${metric.cache} | ${stats.count} | ${number(stats.p50)} | ${number(stats.p95)} | ${number(stats.max)} | ${stats.errors} | ${stats.requests} | ${stats.responseBytes} |`;
    }),
    ...(rows.some((metric) => summarize(metric).browserTraffic !== null)
      ? [
          "",
          "## Browser traffic overlapping HTTP windows",
          "",
          "Observed browser starts and completed encoded response bytes remain visible separately from direct HTTP action gates. These window totals do not establish which browser work the action caused.",
          "",
          "| Journey | browser requests max | browser bytes max |",
          "| --- | ---: | ---: |",
          ...rows.flatMap((metric) => {
            const traffic = summarize(metric).browserTraffic;

            return traffic
              ? [
                  `| ${metric.id} | ${traffic.requests} | ${traffic.responseBytes} |`,
                ]
              : [];
          }),
        ]
      : []),
    "",
    "## Boundaries",
    "",
    ...rows.map(
      (metric) =>
        `- **${metric.id}:** ${metric.boundary} Limits: ${metric.limits.join("; ")}.`,
    ),
    "",
    "## Run limits",
    "",
    ...report.limits.map((limit) => `- ${limit}`),
    ...report.errors.map((error) => `- ERROR: ${error}`),
    "",
  ].join("\n");
}
