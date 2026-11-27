export const workflowOperations = [
  [
    "investigate",
    "Prove the root cause",
    "external-read",
    {
      category: "repository",
      deadlineMs: 1_800_000,
      worker: {
        resultKind: "diagnosis",
        instruction:
          "Inspect the exact event, affected release and source. Trace trigger -> first faulty state -> failure. Reproduce harmlessly or prove the deterministic cause; actively test the strongest alternative. Return diagnosis. Use proven-defect only with proof; reporting-noise only when the condition is expected and incorrectly reported; needs-diagnostics only for a specific useful missing field/test; otherwise deferred with a precise reason and reconsideration condition. Already-fixed requires identified deployed repair evidence. Do not edit source.",
      },
    },
  ],
  [
    "repair",
    "Fix the cause or improve diagnostics",
    "local-edit",
    {
      category: "repository",
      deadlineMs: 1_800_000,
      worker: {
        resultKind: "repair",
        instruction:
          "Implement the smallest first-principles repair at the origin of the proven fault. For needs-diagnostics, add only the specific missing evidence and leave the original cause unproven. For reporting-noise, correct the emitting boundary and prove genuine failures still report. No blanket catches, silent fallback, broad suppression, invented success or unrelated refactors. Run the original failure proof before/after, affected checks, commit exact files, and return the standard Sentry fix-ready Completion in a repair result.",
      },
    },
  ],
  [
    "verify",
    "Reproduce and verify the repair",
    "local-read",
    {
      category: "repository",
      deadlineMs: 600_000,
      worker: null,
    },
  ],
  [
    "review",
    "Independent root-cause review",
    "external-read",
    {
      category: "repository",
      deadlineMs: 1_800_000,
      worker: {
        resultKind: "review",
        instruction:
          "Read-only independent review of the exact committed repair. Test the claimed causal chain and before/after proof, inspect failure/negative cases, and check no symptom guard masks the origin. Return review with the exact head, approve or changes-required, a summary and evidence whose first entry is only the repository-relative path of a file you inspected (later entries may add line references and notes). Do not edit or commit.",
      },
    },
  ],
  [
    "publish",
    "Create the traceability PR",
    "external-write",
    {
      category: "release",
      deadlineMs: 600_000,
      worker: null,
    },
  ],
  [
    "merge",
    "Verify checks and merge",
    "external-write",
    {
      category: "release",
      deadlineMs: 600_000,
      worker: null,
    },
  ],
  [
    "plan-delivery",
    "Choose the smallest required update",
    "external-read",
    {
      category: "release",
      deadlineMs: 600_000,
      worker: null,
    },
  ],
  [
    "release",
    "Start the release you approved",
    "external-write",
    {
      category: "release",
      deadlineMs: 600_000,
      worker: null,
    },
  ],
  [
    "deliver",
    "Publish the verified update",
    "external-write",
    {
      category: "release",
      deadlineMs: 1_800_000,
      worker: null,
    },
  ],
  [
    "verify-delivery",
    "Verify the affected running surface",
    "external-read",
    {
      category: "release",
      deadlineMs: 600_000,
      worker: {
        resultKind: "runtime",
        instruction:
          "Verify the actual affected running artifact at the recorded delivered source, then exercise the original harmless failure case or its closest exact capability proof. A merged PR, offered update, clean log interval, build or unrelated platform is not installed behavioral proof. Return runtime with passed true only when this specific defect/reporting correction is verified. For diagnostics, verify the added evidence is emitted without claiming the original issue solved. Do not modify source or deploy anything.",
      },
    },
  ],
  [
    "resolve",
    "Resolve the proven Sentry issue",
    "external-write",
    {
      category: "repository",
      deadlineMs: 600_000,
      worker: null,
    },
  ],
  [
    "defer",
    "Record why the issue stays open",
    "external-write",
    {
      category: "repository",
      deadlineMs: 600_000,
      worker: null,
    },
  ],
] as const;

export function workflowOperation(operation: (typeof workflowOperations)[number][0]) {
  const entry = workflowOperations.find(([name]) => name === operation);

  if (!entry) throw new Error("Unknown workflow operation");

  return entry[3];
}
