import type { PluginApi } from "@omnyo/plugin-sdk";
import { toolInputSchema } from "./contracts.js";
import { TOOL_DESCRIPTION } from "./tool-definition.js";
import { defineNeedsYouSettings } from "./sidebar/settings-contract.js";
import {
  validateToolInput,
  buildInteractionPayload,
  assertInteractionPayloadFits,
} from "./translate.js";

export const TOOL_NAME = "AskUserQuestion";

export default async function plugin(api: PluginApi) {
  defineNeedsYouSettings(api);
  api.agents.registerTool({
    name: TOOL_NAME,
    description: `${TOOL_DESCRIPTION}\nQuestions use Omnyo's native question panel. In a chat that another chat started or parents, the question goes to that chat instead of the owner, and its answer arrives as a message in this chat. This call returns immediately. Answers steer the running turn or resume an idle chat. A required question blocks only the dependent action; keep doing independent authorized work. Optional questions permit a reversible default. Withdraw unanswered questions that are no longer needed with omnyo question command --self using the returned id and revision. Dismissal supplies no answer or approval. Set delegable on a question only when it is a reversible choice within authority you already hold, so a rule the owner adopted may answer it; never when it asks the owner to approve pushing, publishing, deploying, releasing, submitting, sending, purchasing, deleting data, changing an external service, creating an account, or saving anything that outlives the chat.`,
    presentation: {
      label: { pending: "Asking a question", completed: "Question opened" },
      icon: { glyph: "MessageQuestion" },
      suppress: true,
    },
    parameters: toolInputSchema,
    async execute(input, ctx) {
      const invalid = validateToolInput(input);

      if (invalid !== null)
        return {
          content: [{ type: "text" as const, text: invalid }],
          isError: true,
        };

      try {
        assertInteractionPayloadFits(buildInteractionPayload(input));
      } catch (cause) {
        return {
          content: [
            {
              type: "text" as const,
              text: cause instanceof Error ? cause.message : String(cause),
            },
          ],
          isError: true,
        };
      }

      const result = await api.sdk.experimental_attention.command({
        threadId: ctx.threadId,
        command: {
          action: "open",
          questions: input.questions.map((question) => ({
            key: null,
            prompt: question.question,
            context: null,
            shortLabel: question.header,
            mode: input.mode,
            multiSelect: question.multiSelect,
            allowFreeText: true,
            additiveNotes: true,
            delegable: question.delegable,
            options: question.options.map((option, index) => ({
              value: String.fromCharCode(97 + index),
              label: option.label.replace(/\s*\(Recommended\)\s*$/u, ""),
              description: option.description,
              preview: option.preview ?? null,
              recommended: option.label.includes("(Recommended)"),
            })),
          })),
        },
      });

      const parentThreadId: unknown = result.routedToThreadId;

      if (typeof parentThreadId === "string")
        return JSON.stringify({
          questions: [],
          delivery: "parent-chat",
          parentThreadId,
          instruction: [
            `This chat reports to ${parentThreadId}. The question went to that chat, not the owner. Its answer arrives as a message in this chat.`,
            input.mode === "required"
              ? "Do not assume an answer before the dependent action. Continue independent work, or end the turn when nothing else can proceed."
              : "Continue with your stated reversible default. A later answer from that chat steers this task.",
            "Do not ask the owner or tell anyone to use a question panel.",
          ].join(" "),
        });

      return JSON.stringify({
        questions: result.questions,
        delivery: "asynchronous",
        instruction: [
          input.mode === "required"
            ? "Wait for an answer before the dependent action. Continue independent authorized work; do not assume an answer or approval."
            : "Continue with your stated reversible default. A later answer steers this task.",
          `If an unanswered question is no longer needed, withdraw it with omnyo question command --self --value '{"action":"withdraw","id":"<id>","revision":1}' --json, replacing id and revision with that question's returned values.`,
        ].join(" "),
      });
    },
  });
  api.agents.configure((context) => ({
    tools:
      context.provider.capabilities.supportsNativeUserQuestion ||
      (context.thread.experimental_visibility === "hidden" &&
        (context.thread.parentThreadId === null ||
          context.origin.kind !== null))
        ? []
        : [TOOL_NAME],
    skills: [],
  }));

  await api.sdk.experimental_attention.adopt({ pluginId: "needs-you" });
}
