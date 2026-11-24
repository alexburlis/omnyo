import { timelineAssistantConversationRowSchema } from "@omnyo/server-contract";
import { describe, expect, it } from "vitest";
import { makeThreadWorkSummary } from "@omnyo/test-helpers/domain-fixtures";
import { conversationRow, turnRow } from "@/test/fixtures/thread-timeline-rows";
import { removeCompletionReportFromDisplay } from "../completion-report";
import { selectCompletionMessageId } from "./completion-message";

const work = makeThreadWorkSummary({
  archive: { eligible: true, recommended: true, reason: "Verified" },
  assessment: {
    availability: "available",
    reason: "Verified",
    sourceSeq: 42,
    suggestion: "omitted",
    noSuggestionReason: null,
    waitingOn: null,
    ask: null,
    recap: null,
  },
});

const answer = conversationRow({
  id: "answer",
  role: "assistant",
  text: "Answer",
  sourceSeqStart: 40,
  sourceSeqEnd: 41,
});

describe("completion answer selection", () => {
  it("binds the completion event to the latest loaded settled top-level answer", () => {
    expect(
      selectCompletionMessageId(
        [
          conversationRow({
            id: "earlier",
            role: "assistant",
            text: "Answer",
            sourceSeqStart: 2,
          }),
          turnRow({
            children: [
              conversationRow({
                id: "nested",
                role: "assistant",
                text: "Answer",
                sourceSeqStart: 40,
              }),
            ],
          }),
          answer,
        ],
        work,
      ),
    ).toBe("answer");
  });

  it("skips completion report cleanup when the answer is unloaded, streaming, newer than the assessment or unassessed", () => {
    for (const rows of [
      [turnRow({ children: [answer] })],
      [answer, turnRow({ children: [answer] })],
      [
        answer,
        conversationRow({ role: "user", text: "New work", sourceSeqStart: 42 }),
      ],
    ])
      expect(selectCompletionMessageId(rows, work)).toBeNull();
    expect(
      selectCompletionMessageId(
        [
          timelineAssistantConversationRowSchema.parse({
            ...answer,
            status: "streaming",
          }),
        ],
        work,
      ),
    ).toBeNull();
    expect(
      selectCompletionMessageId(
        [
          answer,
          conversationRow({
            id: "newer",
            role: "assistant",
            text: "Answer",
            sourceSeqStart: 43,
          }),
        ],
        work,
      ),
    ).toBeNull();
    expect(
      selectCompletionMessageId([answer], {
        ...work,
        assessment: { ...work.assessment, availability: "stale" },
      }),
    ).toBeNull();
    expect(
      selectCompletionMessageId([answer], {
        ...work,
        archive: { ...work.archive, recommended: false },
      }),
    ).toBeNull();
  });
});

const report = "Completed: The fix is delivered; verified: focused checks.";

const assessmentReason = `${report} (not model-checked)`;

it("removes the assessed standalone report without removing quoted or fenced evidence", () => {
  const text = `Delivered.\n\n> ${report}\n\n\`\`\`text\n${report}\n\`\`\`\n\n${report}`;
  expect(removeCompletionReportFromDisplay({ text, assessmentReason })).toBe(
    `Delivered.\n\n> ${report}\n\n\`\`\`text\n${report}\n\`\`\``,
  );

  for (const text of [
    report.replace("focused checks", "other checks"),
    `  ${report}`,
    `${report}\n${report}`,
    `Example: ${report}`,
  ])
    expect(removeCompletionReportFromDisplay({ text, assessmentReason })).toBe(
      text,
    );
});
