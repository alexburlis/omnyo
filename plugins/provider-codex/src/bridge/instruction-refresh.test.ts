import { expect, it } from "vitest";
import {
  digestInstructionSections,
  instructionRefreshMessage,
} from "./instruction-refresh.js";

const CANVAS_HEADER =
  'The following dynamic instructions come from the Omnyo plugin "canvas":';

const TOPICS_HEADER =
  'The following dynamic instructions come from the Omnyo plugin "chat-topics":';

it("names removed sections and replaces a changed opening section", () => {
  const delivered = [
    "Omnyo owns native questions.",
    TOPICS_HEADER,
    "Name this chat.",
    CANVAS_HEADER,
    "Prefer Canvas.",
  ].join("\n\n");

  const current = [
    "Omnyo owns native questions.\n\nNative open questions: [q1].",
    CANVAS_HEADER,
    "Prefer Canvas.",
  ].join("\n\n");

  const message = instructionRefreshMessage(
    digestInstructionSections(delivered),
    current,
  );

  expect(message).toContain("Native open questions: [q1].");
  expect(message).toContain(
    `These earlier Omnyo sections no longer apply:\n- ${TOPICS_HEADER}`,
  );
  expect(message).not.toContain("Prefer Canvas.");
  expect(
    instructionRefreshMessage(digestInstructionSections(current), current),
  ).toBeNull();
});
