import { adoptLegacyThreadAttention } from "@omnyo/db";
import type { AppDeps } from "../../types.js";
import { notifyThreadAttentionChanged } from "./thread-attention.js";

export function adoptLegacyAttention(
  deps: Pick<AppDeps, "db" | "hub" | "config">,
  pluginId: "decisions" | "needs-you",
): boolean {
  const result = adoptLegacyThreadAttention(deps.db, {
    dataDir: deps.config.dataDir,
    pluginId,
  });

  for (const threadId of result.threadIds)
    notifyThreadAttentionChanged(deps, threadId);

  return result.imported;
}
