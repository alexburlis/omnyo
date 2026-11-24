import type { PromptInput } from "@omnyo/domain";

interface PromptTextInputArgs {
  text: string;
}

export function promptTextInput(args: PromptTextInputArgs): PromptInput {
  return { type: "text", text: args.text, mentions: [] };
}
