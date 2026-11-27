import { type Trigger, type TransitionDefinition } from "../src/contracts/definition.js";
import {
  createEmptyDraft,
  DEFAULT_AGENT_PERMISSION_MODE,
  type EditorDraft,
} from "../src/definition/draft.js";

export function createReleaseLoopDraft(input: {
  machineId: string;
  name?: string;
  environmentId?: string;
}): EditorDraft {
  const draft = createEmptyDraft({
    machineId: input.machineId,
    name: input.name ?? "Release loop",
    description:
      "Pins each source, checks it, verifies an internal release and pauses for repair or a decision. Configure exact commands, model and existing authority before publishing.",
  });

  const environmentId = input.environmentId ?? null;

  const edges: [string, string, string, Trigger, string][] = [
    [
      "new_source",
      "waiting",
      "gate",
      { kind: "event", eventType: "source.new-sha" },
      "new commit on main",
    ],
    [
      "promote",
      "waiting",
      "production-promotion",
      { kind: "event", eventType: "person.promote" },
      "promote · manual",
    ],
    ["gate_ok", "gate", "testflight-build", { kind: "succeeded" }, "green · dispatch"],
    ["gate_red", "gate", "fixer-agent", { kind: "failed" }, "red"],
    ["gate_timeout", "gate", "needs-person", { kind: "timed-out" }, "timed out"],
    [
      "build_ok",
      "testflight-build",
      "waiting",
      { kind: "succeeded" },
      "released to internal TestFlight",
    ],
    [
      "build_failed",
      "testflight-build",
      "fixer-agent",
      { kind: "failed" },
      "build or tests failed",
    ],
    [
      "build_timeout",
      "testflight-build",
      "needs-person",
      { kind: "timed-out" },
      "stalled or infra failure",
    ],
    ["repair_pr", "fixer-agent", "land-fix", { kind: "result", outcome: "pr-opened" }, "PR opened"],
    ["repair_missing", "fixer-agent", "needs-person", { kind: "no-result" }, "no repair"],
    ["repair_budget", "fixer-agent", "needs-person", { kind: "budget-exhausted" }, "fixer limit"],
    ["repair_failed", "fixer-agent", "needs-person", { kind: "failed" }, "fixer failed"],
    ["repair_timeout", "fixer-agent", "needs-person", { kind: "timed-out" }, "fixer timed out"],
    ["land_ok", "land-fix", "gate", { kind: "succeeded" }, "merged · main moved"],
    ["land_failed", "land-fix", "needs-person", { kind: "failed" }, "needs review or red"],
    ["land_timeout", "land-fix", "needs-person", { kind: "timed-out" }, "timed out"],
    [
      "resume",
      "needs-person",
      "waiting",
      { kind: "decision", decisionId: "resume-waiting" },
      "resume waiting",
    ],
    [
      "retry_gate",
      "needs-person",
      "gate",
      { kind: "decision", decisionId: "retry-gate" },
      "retry gate",
    ],
    [
      "promotion_verified",
      "production-promotion",
      "waiting",
      { kind: "decision", decisionId: "verified" },
      "verified",
    ],
    [
      "promotion_rejected",
      "production-promotion",
      "waiting",
      { kind: "decision", decisionId: "rejected" },
      "rejected",
    ],
    [
      "promotion_unknown",
      "production-promotion",
      "needs-person",
      { kind: "decision", decisionId: "unknown" },
      "unknown",
    ],
  ];

  const transitions: TransitionDefinition[] = edges.map(([id, from, to, trigger], priority) => ({
    id: `tr_${id}`,
    from,
    to,
    trigger,
    guard: null,
    contextPatch:
      id === "new_source"
        ? [{ op: "set", path: ["sourceSha"], value: { root: "event", segments: ["sourceSha"] } }]
        : id === "repair_pr"
          ? [
              { op: "set", path: ["prNumber"], value: { root: "result", segments: ["prNumber"] } },
              { op: "set", path: ["headSha"], value: { root: "result", segments: ["headSha"] } },
            ]
          : [],
    priority,
  }));

  const command = (
    id: string,
    title: string,
    subtitle: string,
    effect: "local-read" | "external-read" | "external-write",
    argv: { literal: string }[],
  ): EditorDraft["states"][number] => ({
    id,
    kind: "command",
    title,
    subtitle,
    action: {
      argv,
      shell: false,
      cwd: ".",
      environmentId,
      successExitCodes: [0],
      retrySafety: "never",
    },
    deadlineMs: 600000,
    maxAttempts: 1,
    effect,
    effectTarget: "Configure the exact repository, artifact and release audience",
    annotations: { category: effect === "local-read" ? "repository" : "release" },
  });

  return {
    ...draft,
    initialStateId: "waiting",
    contextSchema: {
      type: "object",
      properties: {
        sourceSha: { type: "string", maxLength: 64 },
        prNumber: { type: "integer", minimum: 0 },
        headSha: { type: "string", maxLength: 64 },
      },
      required: ["sourceSha", "prNumber", "headSha"],
      additionalProperties: false,
    },
    initialContext: { sourceSha: "", prNumber: 0, headSha: "" },
    states: [
      {
        id: "waiting",
        kind: "wait",
        title: "Waiting for new commits",
        subtitle: "between ticks",
        triggers: [
          { kind: "event", eventType: "source.new-sha", filter: {} },
          { kind: "event", eventType: "person.promote", filter: {} },
          { kind: "check", everyMs: 300000 },
        ],
      },
      command("gate", "Gate", "pnpm check", "local-read", [
        { literal: "pnpm" },
        { literal: "check" },
      ]),
      command("testflight-build", "TestFlight build", "internal build", "external-write", []),
      {
        id: "fixer-agent",
        kind: "agent",
        title: "Fixer agent",
        subtitle: "opens a PR",
        action: {
          prompt:
            "Inspect the exact pinned source and failed check receipt. Make the smallest local repair and verify it. Preserve concurrent changes. Never create accounts, add provider spend, bypass safety checks, push, publish, merge or release without exact existing authority. A PR result requires independent verification of its exact number and head SHA through an already authorized route; prose alone is not evidence. If that route or authority is unavailable, request a person. Submit the declared structured result once, then finish without background work.",
          execution: null,
          permissionMode: DEFAULT_AGENT_PERMISSION_MODE,
          environmentId,
          result: {
            outcomes: [
              {
                name: "pr-opened",
                fields: [
                  { name: "prNumber", schema: { type: "integer", minimum: 1 }, required: true },
                  {
                    name: "headSha",
                    schema: { type: "string", minLength: 40, maxLength: 64 },
                    required: true,
                  },
                ],
              },
            ],
          },
        },
        deadlineMs: 1800000,
        maxAttempts: 1,
        effect: "local-edit",
        effectTarget: "Configure the exact repository and pinned source",
        annotations: { category: "repository" },
      },
      command("land-fix", "Land fix", "CI + runner gate", "external-read", []),
      {
        id: "needs-person",
        kind: "manual",
        title: "Needs a person",
        subtitle: "loop paused",
        prompt:
          "Inspect the exact source, action receipt and outstanding ownership before choosing the next state. This decision grants no external effect authority.",
        decisions: [
          {
            id: "resume-waiting",
            label: "Resume waiting",
            evidenceRequired: true,
            evidencePrompt: "Why can this source be left unresolved?",
          },
          {
            id: "retry-gate",
            label: "Retry gate",
            evidenceRequired: true,
            evidencePrompt: "What confirms quiescence and the exact source to retry?",
          },
        ],
      },
      {
        id: "production-promotion",
        kind: "manual",
        title: "Production promotion",
        subtitle: "manual",
        prompt:
          "Verify the exact artifact, version, channel and audience through the existing authorized release process. This gate cannot grant publication authority or execute a release.",
        decisions: [
          {
            id: "verified",
            label: "Promotion verified",
            evidenceRequired: true,
            evidencePrompt: "Link the exact independently verified promotion receipt.",
          },
          { id: "rejected", label: "Rejected", evidenceRequired: false, evidencePrompt: "" },
          {
            id: "unknown",
            label: "Unknown",
            evidenceRequired: true,
            evidencePrompt: "What remains unverified?",
          },
        ],
      },
    ],
    transitions,
    layout: {
      initial: { x: 64, y: 0 },
      nodes: {
        waiting: { x: 64, y: 80 },
        gate: { x: 464, y: 80 },
        "testflight-build": { x: 864, y: 80 },
        "fixer-agent": { x: 864, y: 400 },
        "land-fix": { x: 464, y: 400 },
        "needs-person": { x: 664, y: 560 },
        "production-promotion": { x: 64, y: 400 },
      },
      edges: {},
      edgeLabels: Object.fromEntries(edges.map(([id, , , , label]) => [`tr_${id}`, label])),
    },
  };
}
