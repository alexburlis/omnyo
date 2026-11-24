import { Command } from "commander";
import { action } from "../../action.js";
import { createCliOmnyoSdk } from "../../client.js";
import { CliUsageError } from "../../cli-usage-error.js";
import { outputJson, requireThreadIdOrSelf } from "../helpers.js";

interface AutoCompactionCommandOptions {
  self?: boolean;
  json?: boolean;
  on?: boolean;
  off?: boolean;
}

function requestedEnabled(opts: AutoCompactionCommandOptions): boolean {
  if (opts.on === true && opts.off !== true) return true;

  if (opts.off === true && opts.on !== true) return false;

  throw new CliUsageError({
    code: opts.on === true ? "conflicting_options" : "missing_required",
    hint: "`omnyo thread auto-compaction THREAD_ID --off` keeps the chat's full history.",
    message: "Pass exactly one of --on or --off.",
  });
}

export function registerAutoCompactionCommand(
  parent: Command,
  getUrl: () => string,
): void {
  parent
    .command("auto-compaction [id]")
    .description(
      "Turn automatic compaction before the prompt cache expires on or off for a chat",
    )
    .option("--on", "Compact the chat automatically while its cache is warm")
    .option("--off", "Keep the chat's full history")
    .option("--self", "Use the current thread")
    .option("--json", "Print machine-readable JSON output")
    .action(
      action(
        async (id: string | undefined, opts: AutoCompactionCommandOptions) => {
          const enabled = requestedEnabled(opts);
          const threadId = requireThreadIdOrSelf(id, opts);

          const result = await createCliOmnyoSdk(
            getUrl(),
          ).threads.experimental_setAutoCompaction({ threadId, enabled });

          if (outputJson(opts, result)) return;
          console.log(
            result.enabled
              ? "Automatic compaction is on for this chat."
              : "Automatic compaction is off. The chat keeps its full history.",
          );
        },
      ),
    );
}
