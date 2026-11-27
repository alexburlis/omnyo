import { continuationLabel, type ChatNode } from "../lib/grouping.ts";
import { RowChip } from "./row-rail.tsx";

export function continuationHint(node: Pick<ChatNode, "continuation" | "children">): string | null {
  const label = continuationLabel(node);

  if (label === null) return null;

  if (node.continuation) return "Earlier chat. The conversation continues in the chat above.";

  return `${label}. Show the subchats to see ${label.startsWith("Continues 1 ") ? "it" : "them"}.`;
}

export function ContinuationMark({ node }: { node: Pick<ChatNode, "continuation" | "children"> }) {
  const hint = continuationHint(node);

  if (hint === null) return null;

  return (
    <span
      className="ct-continuation"
      data-chat-continuation={node.continuation ? "earlier" : "latest"}
    >
      <RowChip
        icon={node.continuation ? "ArrowTurnBackward" : "ArrowTurnForward"}
        label={node.continuation ? "Earlier chat" : undefined}
        description={hint}
        focusable={false}
      />
    </span>
  );
}
