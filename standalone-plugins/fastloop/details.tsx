import { z } from "zod";

const evidenceViewSchema = z.object({
  id: z.string().min(1).max(128),
  kind: z.string().max(64),
  relativePath: z.string().min(1).max(1024),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  runId: z.string().min(1).max(128),
  redacted: z.boolean(),
  identity: z.object({ buildGeneration: z.number().int().nonnegative() }).optional(),
});

export const jobViewSchema = z.object({
  runId: z.string().min(1).max(128),
  state: z.enum(["accepted", "running", "completed", "cancelled", "interrupted"]),
  lastEventSequence: z.number().int().nonnegative(),
  result: z
    .object({
      sessionId: z.string().min(1).max(128),
      verdict: z.enum(["PASSED", "FAILED", "INCONCLUSIVE", "BLOCKED", "CANCELLED"]),
      completion: z.enum(["objective_completed", "exploration_completed", "not_completed"]),
      scope: z.array(z.string().max(8192)).max(128),
      checks: z
        .array(
          z.object({
            checkId: z.string().max(128),
            status: z.enum(["PASS", "FAIL", "UNKNOWN", "NOT_RUN"]),
            assessment: z.enum(["deterministic", "model_assessed"]),
            reasonCode: z.string().max(128),
            evidenceIds: z.array(z.string().max(128)).max(256),
          }),
        )
        .max(128),
      evidence: z.array(evidenceViewSchema).max(1000),
      observations: z.array(z.string().max(8192)).max(128),
      limitations: z.array(z.string().max(8192)).max(128),
      requirementsHash: z.string().regex(/^[a-f0-9]{64}$/),
      checksHash: z.string().regex(/^[a-f0-9]{64}$/),
    })
    .optional(),
});

export type JobView = z.infer<typeof jobViewSchema>;

export type EvidenceView = z.infer<typeof evidenceViewSchema>;

const verdictLabels = {
  PASSED: "Passed",
  FAILED: "Failed",
  INCONCLUSIVE: "Inconclusive",
  BLOCKED: "Blocked",
  CANCELLED: "Cancelled",
};

function resultMessage(text: string): string {
  switch (text) {
    case "MODEL_RATE_LIMITED":
      return "The model provider rate limited this run. Try again when access is available.";
    case "DECISIONS_UNAVAILABLE":
      return "The configured model is unavailable. Check the provider settings.";
    case "MODEL_CONNECTION_FAILED":
      return "The model provider could not be reached. Try again when connected.";
    case "CANCELLED":
      return "The run was cancelled.";
    default:
      return /^[A-Z][A-Z0-9_]+$/.test(text)
        ? "Verification could not finish. Open the report for details."
        : text;
  }
}

export function RunDetailsView({
  job,
  busy,
  onCancel,
  onEvidence,
}: {
  job: JobView;
  busy: boolean;
  onCancel(): void;
  onEvidence(evidence: EvidenceView): void;
}) {
  const result = job.result;
  const active = job.state === "accepted" || job.state === "running";
  const limitations = [...new Set(result?.limitations ?? [])];

  const observations = [...new Set(result?.observations ?? [])].filter(
    (text) => !limitations.includes(text),
  );

  const heading = active
    ? "Verification in progress"
    : result?.completion === "exploration_completed" && result.verdict === "INCONCLUSIVE"
      ? "Exploration completed"
      : result
        ? verdictLabels[result.verdict]
        : "Interrupted";

  const primary = result?.checks.find(
    (check) => check.status === "FAIL" || check.status === "UNKNOWN",
  );

  const evidence = result?.evidence ?? [];
  const primaryIds = new Set(primary?.evidenceIds ?? []);

  const ordered = [...evidence].sort(
    (left, right) => Number(primaryIds.has(right.id)) - Number(primaryIds.has(left.id)),
  );

  return (
    <section className="fastloop-details" aria-label="FastLoop run" data-run-id={job.runId}>
      <header className="fastloop-heading">
        <h3>{heading}</h3>
        {active ? (
          <button type="button" disabled={busy} onClick={onCancel}>
            Cancel run
          </button>
        ) : null}
      </header>
      {result ? (
        <>
          {result.completion === "exploration_completed" ? (
            <p>Coverage is partial. Required behavior has not been verified.</p>
          ) : null}
          {result.scope.length ? (
            <section aria-label="Tested scope">
              <h4>Tested scope</h4>
              <ul>
                {result.scope.map((text, index) => (
                  <li key={index}>{text}</li>
                ))}
              </ul>
            </section>
          ) : null}
          {result.checks.length ? (
            <section aria-label="Checks">
              <h4>Checks</h4>
              <ul className="fastloop-checks">
                {result.checks.map((check) => (
                  <li key={check.checkId} data-check-status={check.status}>
                    <strong>{check.status === "NOT_RUN" ? "Not run" : check.status}</strong>
                    <span>{check.checkId}</span>
                    {check.assessment === "model_assessed" ? (
                      <span className="fastloop-muted">Visual model assessment</span>
                    ) : (
                      <span className="fastloop-muted">Deterministic</span>
                    )}
                    {check.status !== "PASS" ? (
                      <span>{check.reasonCode.replaceAll("_", " ").toLowerCase()}</span>
                    ) : null}
                  </li>
                ))}
              </ul>
            </section>
          ) : null}
          {ordered.length ? (
            <section aria-label="Evidence">
              <h4>Evidence</h4>
              <ul className="fastloop-evidence">
                {ordered.map((entry) => (
                  <li key={entry.id}>
                    <button
                      type="button"
                      disabled={!entry.redacted}
                      onClick={() => onEvidence(entry)}
                    >
                      {entry.kind === "screenshot" ? "View screenshot" : entry.relativePath}
                    </button>
                    {entry.identity ? (
                      <span className="fastloop-muted">
                        Build generation {entry.identity.buildGeneration}
                      </span>
                    ) : null}
                  </li>
                ))}
              </ul>
            </section>
          ) : null}
          {observations.length ? (
            <section aria-label="Observations">
              <h4>Observations</h4>
              <ul>
                {observations.map((text, index) => (
                  <li key={index}>{resultMessage(text)}</li>
                ))}
              </ul>
            </section>
          ) : null}
          {limitations.length ? (
            <section aria-label="Limitations">
              <h4>Limitations</h4>
              <ul>
                {limitations.map((text, index) => (
                  <li key={index}>{resultMessage(text)}</li>
                ))}
              </ul>
            </section>
          ) : null}
          <details>
            <summary>Verification identity</summary>
            <dl className="fastloop-identity">
              <dt>Requirements</dt>
              <dd>{result.requirementsHash}</dd>
              <dt>Checks</dt>
              <dd>{result.checksHash}</dd>
            </dl>
          </details>
        </>
      ) : (
        <p role="status">Waiting for the next result.</p>
      )}
    </section>
  );
}
