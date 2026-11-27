import type { ChatNode, GroupThread } from "./grouping.ts";
import type { PluginSidebarThread } from "@omnyo/plugin-sdk/app";
import { z } from "zod";

const activitySchema = z.object({ experimental_subagents: z.number().int().nonnegative() });

export function runningSubagents(
  thread: Pick<PluginSidebarThread, "activity"> | Pick<GroupThread, "activity">,
): number {
  const parsed = activitySchema.safeParse(thread.activity);

  return parsed.success ? parsed.data.experimental_subagents : 0;
}

export function familyChildCount(node: ChatNode): number {
  return (
    runningSubagents(node.thread) +
    node.children.reduce(
      (count, child) => count + (child.continuation ? 0 : 1) + familyChildCount(child),
      0,
    )
  );
}
