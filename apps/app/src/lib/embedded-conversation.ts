import type { PromptInput, PromptMentionResource } from "@omnyo/domain";
import type { TimelineRow } from "@omnyo/server-contract";

export type EmbeddedConversation = Extract<
  PromptMentionResource,
  { kind: "plugin" }
>;

export function addConversationInput(
  input: PromptInput[],
  conversation: EmbeddedConversation | undefined,
): PromptInput[] {
  if (conversation === undefined || input.length === 0) return input;
  const text = conversation.label;

  return [
    {
      type: "text",
      text,
      mentions: [{ start: 0, end: text.length, resource: conversation }],
    },
    ...input,
  ];
}

export function conversationTimelineRows(
  rows: TimelineRow[],
  conversation: Pick<EmbeddedConversation, "pluginId" | "itemId">,
): TimelineRow[] {
  const turns = new Set<string>();
  const prompts = new Set<string>();

  function visit(items: TimelineRow[]): void {
    for (const row of items) {
      if (
        row.kind === "conversation" &&
        row.role === "user" &&
        row.mentions.some(
          ({ resource }) =>
            resource.kind === "plugin" &&
            resource.pluginId === conversation.pluginId &&
            resource.itemId === conversation.itemId,
        )
      ) {
        prompts.add(row.id);

        if (row.turnId !== null) turns.add(row.turnId);
      }

      if (row.kind === "turn" && row.children !== null) visit(row.children);
    }
  }

  visit(rows);

  return rows.filter((row) => {
    if (row.kind === "conversation" && row.role === "user")
      return prompts.has(row.id);

    if (row.turnId !== null && turns.has(row.turnId)) return true;

    return false;
  });
}
