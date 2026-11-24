import type {
  ThreadListIndicatorState,
  ThreadListIndicatorKind,
  ThreadWorkLabel,
  ThreadWorkSummary,
} from "@omnyo/domain";

interface ThreadIndicatorCase {
  name: string;
  state: ThreadListIndicatorState;
  expected: ThreadListIndicatorKind;
}

function work(label: ThreadWorkLabel): ThreadWorkSummary {
  return {
    revision: "fixture-revision",
    basis: "fixture-basis",
    primary: {
      label,
      reason: { code: "fixture", text: "The server supplied this work state." },
    },
    activity:
      label === "working" || label === "needs-you"
        ? [
            {
              id: "job-one",
              kind: "plugin",
              label: "Release job running",
              phase: "running",
              actor: { kind: "agent", id: "job-one", label: "Release job" },
            },
          ]
        : [],
    requiredInput:
      label === "needs-you"
        ? [
            {
              id: "question-one",
              kind: "question",
              label: "Choose the release scope",
            },
          ]
        : [],
    optionalInput: [],
    failures:
      label === "failed"
        ? [{ code: "job-failed", text: "The job failed.", sourceId: "job-one" }]
        : [],
    waits: [],
    nextActors: [],
    assessment: {
      availability: "available",
      reason: "The server assessed this chat.",
      ask: null,
      recap: null,
      sourceSeq: 41,
      suggestion: "omitted",
      noSuggestionReason: "No reply is needed.",
      waitingOn: label === "external" ? "App Store review" : null,
    },
    postponement: null,
    archive: {
      eligible: label === "ready-to-archive",
      recommended: label === "ready-to-archive",
      reason: "The server supplied archive eligibility.",
    },
  };
}

const labels: readonly [ThreadWorkLabel, ThreadListIndicatorKind][] = [
  ["needs-you", "waiting-for-input"],
  ["working", "runtime"],
  ["blocked", "dependency-failed"],
  ["failed", "unread-error"],
  ["waiting", "callback-waiting"],
  ["open", "open"],
  ["external", "external"],
  ["ready-to-archive", "ready-to-archive"],
];

export const experimental_threadIndicatorCases: readonly ThreadIndicatorCase[] =
  [
    ...labels.map(([label, expected]) => ({
      name: `renders the server ${label} label`,
      state: { work: work(label), hasUnsubmittedDraft: false },
      expected,
    })),
    {
      name: "preserves a required answer alongside independent work",
      state: { work: work("needs-you"), hasUnsubmittedDraft: true },
      expected: "waiting-for-input",
    },
    {
      name: "decorates Working with a local draft",
      state: { work: work("working"), hasUnsubmittedDraft: true },
      expected: "working-draft",
    },
    {
      name: "shows a local draft without changing archive eligibility",
      state: { work: work("ready-to-archive"), hasUnsubmittedDraft: true },
      expected: "draft",
    },
    {
      name: "shows unavailable work as Open",
      state: { work: null, hasUnsubmittedDraft: false },
      expected: "open",
    },
  ];
