import type { PromptInput } from "@omnyo/domain";
import { describe, expect, it } from "vitest";
import { conversationRow, turnRow } from "@/test/fixtures/thread-timeline-rows";
import {
  addConversationInput,
  conversationTimelineRows,
  type EmbeddedConversation,
} from "./embedded-conversation";

const conversation: EmbeddedConversation = {
  kind: "plugin",
  pluginId: "canvas",
  itemId: "conversation:region-a",
  label: "Canvas conversation",
};

describe("embedded conversation attribution", () => {
  it("adds a durable mention without changing the authored prompt or its mention offsets", () => {
    const input: PromptInput[] = [
      { type: "text", text: "Fix this", mentions: [] },
    ];

    const tagged = addConversationInput([...input], conversation);
    expect(tagged).toEqual([
      {
        type: "text",
        text: "Canvas conversation",
        mentions: [{ start: 0, end: 19, resource: conversation }],
      },
      ...input,
    ]);
    expect(input).toEqual([{ type: "text", text: "Fix this", mentions: [] }]);
    expect(addConversationInput([], conversation)).toEqual([]);
  });

  it("keeps the matching prompt and its answer without showing a different conversation", () => {
    const prompt = conversationRow({
      id: "prompt-a",
      seq: 1,
      role: "user",
      text: "prompt",
      turnId: "turn-a",
    });

    if (prompt.role !== "user") throw new Error("User fixture expected");
    prompt.mentions = [{ start: 0, end: 19, resource: conversation }];

    const answer = conversationRow({
      id: "answer-a",
      seq: 2,
      role: "assistant",
      text: "answer",
      turnId: "turn-a",
    });

    const otherPrompt = conversationRow({
      id: "prompt-b",
      seq: 3,
      role: "user",
      text: "prompt",
      turnId: "turn-b",
    });

    const otherAnswer = conversationRow({
      id: "answer-b",
      seq: 4,
      role: "assistant",
      text: "answer",
      turnId: "turn-b",
    });

    expect(
      conversationTimelineRows(
        [prompt, answer, otherPrompt, otherAnswer],
        conversation,
      ),
    ).toEqual([prompt, answer]);
    expect(
      conversationTimelineRows([otherPrompt, otherAnswer], conversation),
    ).toEqual([]);
  });

  it("finds tagged prompts inside retained turn groups", () => {
    const prompt = conversationRow({
      id: "prompt-a",
      seq: 1,
      role: "user",
      text: "prompt",
      turnId: "turn-a",
    });

    if (prompt.role !== "user") throw new Error("User fixture expected");
    prompt.mentions = [{ start: 0, end: 19, resource: conversation }];

    const turn = turnRow({
      id: "turn-a",
      turnId: "turn-a",
      children: [prompt],
    });

    expect(conversationTimelineRows([turn], conversation)).toEqual([turn]);
  });
});
