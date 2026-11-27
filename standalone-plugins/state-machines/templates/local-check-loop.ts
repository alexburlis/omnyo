import { type MachineDefinition, type TransitionDefinition } from "../src/contracts/definition.js";
import { createEmptyDraft } from "../src/definition/draft.js";
import { parseDefinition } from "../src/definition/validate.js";

export function createLocalCheckLoop(input: {
  machineId: string;
  environmentId: string;
  name?: string;
}): MachineDefinition {
  const draft = createEmptyDraft({
    machineId: input.machineId,
    name: input.name ?? "Local check loop",
    description:
      "Checks that the bound workspace directory remains readable, then waits durably. No provider or external effects.",
  });

  const transitions: TransitionDefinition[] = [
    {
      id: "tr_check_tick",
      from: "waiting",
      to: "check",
      trigger: { kind: "timer" },
      guard: null,
      contextPatch: [],
      priority: 0,
    },
    {
      id: "tr_check_signal",
      from: "waiting",
      to: "check",
      trigger: { kind: "event", eventType: "check.requested" },
      guard: null,
      contextPatch: [],
      priority: 1,
    },
    {
      id: "tr_check_ok",
      from: "check",
      to: "waiting",
      trigger: { kind: "succeeded" },
      guard: null,
      contextPatch: [],
      priority: 0,
    },
    {
      id: "tr_check_failed",
      from: "check",
      to: "needs-person",
      trigger: { kind: "failed" },
      guard: null,
      contextPatch: [],
      priority: 1,
    },
    {
      id: "tr_check_timeout",
      from: "check",
      to: "needs-person",
      trigger: { kind: "timed-out" },
      guard: null,
      contextPatch: [],
      priority: 2,
    },
    {
      id: "tr_check_cancelled",
      from: "check",
      to: "needs-person",
      trigger: { kind: "cancelled" },
      guard: null,
      contextPatch: [],
      priority: 3,
    },
    {
      id: "tr_check_retry",
      from: "needs-person",
      to: "check",
      trigger: { kind: "decision", decisionId: "retry-check" },
      guard: null,
      contextPatch: [],
      priority: 0,
    },
    {
      id: "tr_check_wait",
      from: "needs-person",
      to: "waiting",
      trigger: { kind: "decision", decisionId: "resume-waiting" },
      guard: null,
      contextPatch: [],
      priority: 1,
    },
  ];

  return parseDefinition({
    ...draft,
    initialStateId: "waiting",
    states: [
      {
        id: "waiting",
        kind: "wait",
        title: "Waiting for the next check",
        subtitle: "between ticks",
        triggers: [
          { kind: "check", everyMs: 300000 },
          { kind: "event", eventType: "check.requested", filter: {} },
        ],
      },
      {
        id: "check",
        kind: "command",
        title: "Check workspace",
        subtitle: "read the bound directory",
        action: {
          argv: [{ literal: "ls" }, { literal: "-A" }],
          shell: false,
          cwd: ".",
          environmentId: input.environmentId,
          successExitCodes: [0],
          retrySafety: "never",
        },
        deadlineMs: 600000,
        maxAttempts: 1,
        effect: "local-read",
        effectTarget: input.environmentId,
        annotations: { category: "repository" },
      },
      {
        id: "needs-person",
        kind: "manual",
        title: "Needs a person",
        subtitle: "check needs attention",
        prompt: "Inspect the exact check receipt. Retrying does not erase the earlier failure.",
        decisions: [
          {
            id: "retry-check",
            label: "Retry check",
            evidenceRequired: true,
            evidencePrompt: "What confirms the previous step ended?",
          },
          {
            id: "resume-waiting",
            label: "Resume waiting",
            evidenceRequired: true,
            evidencePrompt: "Why can this failure be left for the next check?",
          },
        ],
      },
    ],
    transitions,
    layout: {
      initial: { x: 64, y: 0 },
      nodes: {
        waiting: { x: 64, y: 80 },
        check: { x: 464, y: 80 },
        "needs-person": { x: 464, y: 320 },
      },
      edges: {},
      edgeLabels: {
        tr_check_tick: "next check",
        tr_check_signal: "check requested",
        tr_check_ok: "directory read",
        tr_check_failed: "failed",
        tr_check_timeout: "timed out",
        tr_check_cancelled: "cancelled",
        tr_check_retry: "retry",
        tr_check_wait: "resume waiting",
      },
    },
  });
}
