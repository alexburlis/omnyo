import { workflowOperations } from "./workflow-operations";
import type { WorkflowPolicy } from "./workflow-contract";

type WorkflowPath = { root: "context" | "event"; segments: string[] };

type WorkflowGuard =
  | { in: [WorkflowPath, string[]] }
  | { eq: [WorkflowPath, string | number | boolean] }
  | { all: WorkflowGuard[] }
  | { exists: WorkflowPath }
  | { lt: [WorkflowPath, number] };

type WorkflowTransition = {
  id: string;
  from: string;
  to: string;
  trigger:
    | { kind: "result"; outcome: string }
    | { kind: "timer" }
    | { kind: "always" }
    | { kind: "decision"; decisionId: string }
    | { kind: "failed" | "timed-out" | "no-result" | "cancelled" | "budget-exhausted" };
  guard: WorkflowGuard | null;
  contextPatch: { op: "set"; path: string[]; value: string | number }[];
  priority: number;
};

export function sentryWorkflowGraph(
  machineId: string,
  policy: Pick<WorkflowPolicy, "environmentId">,
) {
  const states = workflowOperations.map(([operation, title, effect, metadata]) => ({
    id: operation,
    kind: "command",
    title,
    subtitle: "One owned, evidenced step; ambiguous effects are reconciled before any retry.",
    effect,
    effectTarget: "The configured Sentry issue and its exact Omnyo repository",
    annotations: { category: metadata.category },
    deadlineMs: metadata.deadlineMs,
    maxAttempts: 1,
    action: {
      argv: [
        { literal: "omnyo" },
        { literal: "sentry" },
        { literal: "workflow-step" },
        { literal: operation },
        { literal: "--run" },
        { contextPath: "runId" },
      ],
      shell: false,
      cwd: ".",
      environmentId: policy.environmentId,
      successExitCodes: [0],
      retrySafety: "never",
    },
  }));

  const edges: [string, string, string][] = [
    ["investigate", "repair", "proven-defect"],
    ["investigate", "repair", "reporting-noise"],
    ["investigate", "repair", "needs-diagnostics"],
    ["investigate", "defer", "deferred"],
    ["investigate", "verify-delivery", "already-fixed"],
    ["repair", "verify", "fixed"],
    ["verify", "review", "verified"],
    ["review", "publish", "approved"],
    ["review", "repair", "changes-required"],
    ["publish", "merge", "published"],
    ["merge", "plan-delivery", "merged"],
    ["merge", "wait-checks", "pending"],
    ["plan-delivery", "deliver", "delivery-required"],
    ["plan-delivery", "verify-delivery", "no-delivery"],
    ["plan-delivery", "approve-release", "release-required"],
    ["release", "wait-delivery", "released"],
    ["release", "approve-release", "release-required"],
    ["deliver", "approve-release", "release-required"],
    ["deliver", "verify-delivery", "delivered"],
    ["deliver", "wait-delivery", "pending"],
    ["verify-delivery", "resolve", "verified"],
    ["verify-delivery", "defer", "awaiting-evidence"],
    ["verify-delivery", "wait-verification", "pending"],
    ["resolve", "resolved", "resolved"],
    ["defer", "open-with-reason", "recorded"],
  ];

  const transitions: WorkflowTransition[] = edges.map(([from, to, outcome], i) => ({
    id: `tr_${from}_${outcome}`,
    from,
    to,
    trigger: { kind: "result", outcome },
    guard:
      from === "review" && outcome === "changes-required"
        ? { lt: [{ root: "context", segments: ["repairAttempt"] }, 2] }
        : from === "verify-delivery" && outcome === "verified"
          ? {
              in: [
                { root: "context", segments: ["classification"] },
                ["proven-defect", "reporting-noise", "already-fixed"],
              ],
            }
          : null,
    contextPatch:
      from === "investigate"
        ? [{ op: "set", path: ["classification"], value: outcome }]
        : from === "review" && outcome === "changes-required"
          ? [{ op: "set", path: ["repairAttempt"], value: 2 }]
          : [],
    priority: i,
  }));

  transitions.push({
    id: "tr_repair_workspace_retry",
    from: "repair",
    to: "wait-workspace",
    trigger: { kind: "failed" },
    guard: {
      all: [
        { exists: { root: "event", segments: ["workspaceSetupFailed"] } },
        { eq: [{ root: "event", segments: ["workspaceSetupFailed"] }, true] },
        { eq: [{ root: "context", segments: ["workspaceRetry"] }, 0] },
      ],
    },
    contextPatch: [{ op: "set", path: ["workspaceRetry"], value: 1 }],
    priority: 100,
  });
  transitions.push({
    id: "tr_review_repair_budget",
    from: "review",
    to: "blocked",
    trigger: { kind: "result", outcome: "changes-required" },
    guard: { eq: [{ root: "context", segments: ["repairAttempt"] }, 2] },
    contextPatch: [{ op: "set", path: ["failedStep"], value: "repair" }],
    priority: 100,
  });
  transitions.push({
    id: "tr_verify-delivery_diagnostics",
    from: "verify-delivery",
    to: "defer",
    trigger: { kind: "result", outcome: "verified" },
    guard: { eq: [{ root: "context", segments: ["classification"] }, "needs-diagnostics"] },
    contextPatch: [],
    priority: 100,
  });

  const waits = [
    ["wait-workspace", "repair"],
    ["wait-checks", "merge"],
    ["wait-delivery", "deliver"],
    ["wait-verification", "verify-delivery"],
  ].map(([id, to], i) => {
    transitions.push({
      id: `tr_${id}_timer`,
      from: id,
      to,
      trigger: { kind: "timer" },
      guard: null,
      contextPatch: [],
      priority: 100 + i,
    });

    return {
      id,
      kind: "wait",
      title:
        id === "wait-workspace"
          ? "Retrying workspace setup"
          : id === "wait-checks"
            ? "Waiting for required checks"
            : id === "wait-delivery"
              ? "Waiting for publication"
              : "Waiting for installation and runtime proof",
      subtitle: "The existing owner continues; no model is running while waiting.",
      triggers: [{ kind: "check", everyMs: 60_000 }],
    };
  });

  const terminal = [
    {
      id: "resolved",
      kind: "end",
      title: "Verified and resolved",
      outcome: "success",
      reason:
        "The exact repair is verified on its affected surface and Sentry readback confirms resolution.",
    },
    {
      id: "open-with-reason",
      kind: "end",
      title: "Issue kept open with a reason",
      outcome: "success",
      reason:
        "The issue remains unresolved; its evidence gap and reconsideration condition are recorded.",
    },
    {
      id: "blocked",
      kind: "manual",
      title: "Run paused",
      subtitle: "The issue, source and effect receipts are kept.",
      prompt:
        "The step above paused the run: it didn't finish, or review still wanted changes after the second repair. Open the step chat to see why.\n\n**Try again** reruns that step; after a rejected review it starts one more repair. **End the run** leaves the Sentry issue open and keeps all evidence.",
      decisions: [
        {
          id: "retry",
          label: "Try again",
          evidenceRequired: false,
          evidencePrompt: "What changed since it paused",
        },
        {
          id: "stop",
          label: "End the run",
          evidenceRequired: false,
          evidencePrompt: "Why the issue stays open",
        },
      ],
    },
    {
      id: "approve-release",
      kind: "manual",
      title: "Release needed",
      subtitle: "The reviewed fix is merged; it reaches users only in a release.",
      prompt:
        "The reviewed fix is merged on main, but it reaches users only in a runtime release.\n\n**Release now** starts one release that ships everything on main, or joins a release already queued that will include the fix. **Ship with the next release** waits, with no model running, until a release that contains the fix is offered.",
      decisions: [
        {
          id: "release",
          label: "Release now",
          evidenceRequired: false,
          evidencePrompt: "Anything to note about this release",
        },
        {
          id: "later",
          label: "Ship with the next release",
          evidenceRequired: false,
          evidencePrompt: "Anything to note",
        },
      ],
    },
    {
      id: "retry-route",
      kind: "choice",
      title: "Retry the stopped step",
      subtitle: "Returns to the step recorded when the run stopped.",
    },
  ];

  for (const [operation] of workflowOperations)
    for (const kind of [
      "failed",
      "timed-out",
      "no-result",
      "cancelled",
      "budget-exhausted",
    ] as const)
      transitions.push({
        id: `tr_${operation}_${kind}`,
        from: operation,
        to: "blocked",
        trigger: { kind },
        guard: null,
        contextPatch: [{ op: "set", path: ["failedStep"], value: operation }],
        priority: 200,
      });
  transitions.push({
    id: "tr_blocked_stop",
    from: "blocked",
    to: "open-with-reason",
    trigger: { kind: "decision", decisionId: "stop" },
    guard: null,
    contextPatch: [],
    priority: 300,
  });
  transitions.push({
    id: "tr_approve-release_release",
    from: "approve-release",
    to: "release",
    trigger: { kind: "decision", decisionId: "release" },
    guard: null,
    contextPatch: [],
    priority: 302,
  });
  transitions.push({
    id: "tr_approve-release_later",
    from: "approve-release",
    to: "wait-delivery",
    trigger: { kind: "decision", decisionId: "later" },
    guard: null,
    contextPatch: [],
    priority: 303,
  });
  transitions.push({
    id: "tr_blocked_retry",
    from: "blocked",
    to: "retry-route",
    trigger: { kind: "decision", decisionId: "retry" },
    guard: null,
    contextPatch: [],
    priority: 301,
  });
  workflowOperations.forEach(([operation], i) =>
    transitions.push({
      id: `tr_retry-route_${operation}`,
      from: "retry-route",
      to: operation,
      trigger: { kind: "always" },
      guard: { eq: [{ root: "context", segments: ["failedStep"] }, operation] },
      contextPatch: [{ op: "set", path: ["failedStep"], value: "none" }],
      priority: 400 + i,
    }),
  );
  transitions.push({
    id: "tr_retry-route_unknown",
    from: "retry-route",
    to: "blocked",
    trigger: { kind: "always" },
    guard: null,
    contextPatch: [],
    priority: 499,
  });
  const allStates = [...states, ...waits, ...terminal];

  return {
    schemaVersion: 1,
    machineId,
    name: "Omnyo Sentry root-cause maintenance",
    description:
      "One issue generation per run. Prove, repair, review, merge, deliver and verify before resolution. Unproven issues stay open with explicit rationale.",
    initialStateId: "investigate",
    contextSchema: {
      type: "object",
      properties: {
        runId: { type: "string", minLength: 1, maxLength: 256 },
        classification: {
          type: "string",
          enum: [
            "unknown",
            "proven-defect",
            "reporting-noise",
            "needs-diagnostics",
            "deferred",
            "already-fixed",
          ],
        },
        repairAttempt: { type: "integer", minimum: 1, maximum: 2 },
        workspaceRetry: { type: "integer", minimum: 0, maximum: 1 },
        failedStep: {
          type: "string",
          enum: ["none", ...workflowOperations.map(([operation]) => operation)],
        },
      },
      required: ["runId", "classification", "repairAttempt", "workspaceRetry", "failedStep"],
      additionalProperties: false,
    },
    initialContext: {
      runId: "assigned-at-start",
      classification: "unknown",
      repairAttempt: 1,
      workspaceRetry: 0,
      failedStep: "none",
    },
    states: allStates,
    transitions,
    limits: { microstepsPerWake: 32, actionStartsPerFiveMinutes: 10, repairAttemptsPerSubject: 2 },
    layout: {
      initial: { x: 0, y: 0 },
      nodes: Object.fromEntries(
        allStates.map((state, i) => [state.id, { x: (i % 4) * 330, y: Math.floor(i / 4) * 190 }]),
      ),
      edges: {},
      edgeLabels: Object.fromEntries(
        edges.map(([from, , outcome]) => [`tr_${from}_${outcome}`, outcome]),
      ),
    },
  };
}
