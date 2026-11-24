import { makeThreadWorkSummary } from "@omnyo/test-helpers/domain-fixtures";
import { useState } from "react";
import { ThreadTimelineRows } from "../ThreadTimelineRows";
import {
  commandRow,
  conversationRow,
  systemRow,
  toolRow,
  turnRow,
} from "@/test/fixtures/thread-timeline-rows";

export default { title: "thread/timeline/Activity" };

export function RunningToFinished() {
  const [step, setStep] = useState(0);
  const [startedAt, setStartedAt] = useState(Date.now);
  const finished = step === 2;

  const common = {
    threadId: "thr_activity_story",
    turnId: "turn_activity",
    startedAt,
    createdAt: startedAt,
  };

  const work = [
    commandRow({
      ...common,
      id: "activity-command",
      sourceSeqStart: 2,
      sourceSeqEnd: step === 0 ? 2 : step === 1 ? 4 : 6,
      command: "pnpm test:dev --package @omnyo/app -- timeline",
      status: finished ? "completed" : "pending",
      output:
        step === 0
          ? "Starting timeline checks…"
          : "Timeline checks\n✓ Streaming output updates\n✓ Finished work collapses\nTests 2 passed (2)",
      exitCode: finished ? 0 : null,
      durationMs: finished ? 5000 : null,
    }),
    toolRow({
      ...common,
      id: "activity-tool",
      sourceSeqStart: 3,
      sourceSeqEnd: step === 0 ? 3 : step === 1 ? 5 : 7,
      toolName: "inspect_preview",
      toolArgs: { page: "Chat timeline", width: 390 },
      status: finished ? "error" : "pending",
      output:
        step === 0
          ? "Inspecting the preview…"
          : "Preview service unavailable. The timeline checks passed.",
      durationMs: finished ? 6000 : null,
    }),
    systemRow({
      ...common,
      id: "activity-warning",
      sourceSeqStart: 8,
      operationKind: "warning",
      title: "Preview could not be checked",
      detail: "The preview service did not respond.",
    }),
  ];

  const prompt = conversationRow({
    ...common,
    id: "activity-prompt",
    sourceSeqStart: 1,
    role: "user",
    text: "Check the chat timeline.",
  });

  const rows = finished
    ? [
        prompt,
        {
          ...turnRow({
            ...common,
            id: "activity-receipt",
            sourceSeqStart: 2,
            sourceSeqEnd: 8,
            children: work,
            durationMs: 6000,
          }),
          activity: {
            commands: 1,
            files: 0,
            searches: 0,
            tools: 1,
            warnings: 1,
            failures: 1,
          },
        },
        conversationRow({
          ...common,
          id: "activity-answer",
          sourceSeqStart: 9,
          role: "assistant",
          text: "The timeline checks passed. Preview verification could not finish because the preview service was unavailable.",
        }),
      ]
    : [prompt, ...work];

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-6 p-4">
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          className="rounded-md border border-border px-3 py-1.5 text-sm"
          onClick={() => setStep(1)}
          disabled={step !== 0}
        >
          Stream output
        </button>
        <button
          type="button"
          className="rounded-md border border-border px-3 py-1.5 text-sm"
          onClick={() => setStep(2)}
          disabled={finished}
        >
          Finish turn
        </button>
        <button
          type="button"
          className="rounded-md border border-border px-3 py-1.5 text-sm"
          onClick={() => {
            setStartedAt(Date.now());
            setStep(0);
          }}
        >
          Restart
        </button>
      </div>
      <ThreadTimelineRows
        threadRuntimeDisplayStatus={finished ? "idle" : "active"}
        workspaceRootPath={undefined}
        timelineRows={rows}
      />
    </div>
  );
}

const COMPLETION_AT = Date.now() - 120_000;

export function CompletionReport() {
  const [pending, setPending] = useState(false);

  const report =
    "Completed: Handoff navigation fixed; verified: server tests, browser navigation, and update offer.";

  const reason = `${report} (not model-checked)`;

  const work = makeThreadWorkSummary({
    primary: {
      label: "ready-to-archive",
      reason: { code: "assessed-complete", text: reason },
    },
    assessment: {
      availability: "available",
      reason,
      sourceSeq: 10,
      suggestion: "omitted",
      noSuggestionReason: null,
      waitingOn: null,
      ask: null,
      recap: "Handoff navigation fixed",
    },
    archive: { eligible: !pending, recommended: !pending, reason },
  });

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-6 p-4">
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          className="rounded-md border border-border px-3 py-1.5 text-sm"
          onClick={() => setPending(!pending)}
        >
          {pending ? "Restore readiness" : "Add pending work"}
        </button>
      </div>
      <ThreadTimelineRows
        threadId="thr_completion_story"
        threadRuntimeDisplayStatus="idle"
        workspaceRootPath={undefined}
        completion={work}
        timelineRows={[
          conversationRow({
            id: "completion-answer",
            threadId: "thr_completion_story",
            startedAt: COMPLETION_AT,
            createdAt: COMPLETION_AT,
            role: "assistant",
            sourceSeqStart: 9,
            sourceSeqEnd: 9,
            text: `The original chat now links to its continuation. The fix is offered in Omnyo 1.0.62.\n\n${report}`,
          }),
        ]}
      />
    </div>
  );
}
