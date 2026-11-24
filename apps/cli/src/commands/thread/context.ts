import { Command } from "commander";
import type { ThreadAutoCompaction } from "@omnyo/server-contract";
import { action } from "../../action.js";
import { createCliOmnyoSdk } from "../../client.js";
import { outputJson, requireThreadIdOrSelf } from "../helpers.js";

export function registerContextCommand(
  parent: Command,
  getUrl: () => string,
): void {
  parent
    .command("context [id]")
    .description(
      "Show the latest recorded context window usage and available breakdown",
    )
    .option("--self", "Use the current thread")
    .option("--json", "Print machine-readable JSON output")
    .action(
      action(
        async (
          id: string | undefined,
          opts: { self?: boolean; json?: boolean },
        ) => {
          const threadId = requireThreadIdOrSelf(id, opts);

          const result = await createCliOmnyoSdk(getUrl()).threads.context({
            threadId,
          });

          if (outputJson(opts, result)) return;
          const usage = result.usage;
          const autoCompaction = formatAutoCompaction(result.autoCompaction);

          if (!usage) {
            console.log("Context usage is not available yet.");
            console.log(autoCompaction);

            return;
          }

          const count = (value: number) => value.toLocaleString("en-US");
          console.log(
            `${usage.estimated ? "Estimated context" : "Context window"}: ${count(usage.usedTokens)} / ${count(usage.modelContextWindow)} tokens`,
          );

          if (usage.cost) {
            console.log(
              `Session cost: ${usage.cost.amount} ${usage.cost.currency}`,
            );
          }

          console.log(autoCompaction);

          if (!usage.snapshot) return;
          console.log(`Captured: ${usage.snapshot.capturedAt}`);

          for (const category of usage.snapshot.categories) {
            const kind = category.kind === "used" ? "" : ` (${category.kind})`;
            console.log(`${category.label}${kind}: ${count(category.tokens)}`);

            for (const entry of category.entries)
              console.log(`  ${entry.label}: ${count(entry.tokens)}`);
          }
        },
      ),
    );
}

function formatAutoCompaction(autoCompaction: ThreadAutoCompaction): string {
  const reason =
    autoCompaction.reason === null ? "" : ` (${autoCompaction.reason})`;

  const at = autoCompaction.at === null ? "" : ` at ${autoCompaction.at}`;

  const share =
    autoCompaction.state !== "done"
      ? ""
      : autoCompaction.cacheReadShare === null
        ? ", cache-read share unknown"
        : `, cache-read share ${autoCompaction.cacheReadShare.toFixed(2)}`;

  const label =
    autoCompaction.state === "disabled" ? "off" : autoCompaction.state;

  return `Automatic compaction: ${label}${at}${reason}${share}`;
}
