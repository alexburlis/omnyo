import {
  publishThreadWorkSchema,
  THREAD_WORK_LABELS,
  type ThreadWorkSummary,
} from "@omnyo/domain";
import { Command } from "commander";
import { action } from "../../action.js";
import { createCliOmnyoSdk } from "../../client.js";
import { outputJson, requireThreadIdOrSelf } from "../helpers.js";

interface WorkOptions {
  self?: boolean;
  json?: boolean;
}

function printWork(options: WorkOptions, work: ThreadWorkSummary): void {
  if (outputJson(options, work)) return;
  console.log(
    `${THREAD_WORK_LABELS[work.primary.label]}: ${work.primary.reason.text}`,
  );
  console.log(
    `Next: ${work.nextActors.map((actor) => actor.label).join(", ") || "No action required"}`,
  );
  console.log(
    `Assessment: ${work.assessment.availability}. ${work.assessment.reason}`,
  );

  if (work.assessment.noSuggestionReason !== null)
    console.log(`No suggestion: ${work.assessment.noSuggestionReason}`);
}

export function registerWorkCommands(
  parent: Command,
  getUrl: () => string,
): void {
  const work = parent
    .command("work [id]")
    .description(
      "Show the shared chat work summary, owner and prediction explanation",
    )
    .option("--self", "Use this chat")
    .option("--json", "Print the complete work snapshot as JSON")
    .action(
      action(async (id: string | undefined, options: WorkOptions) => {
        const threadId = requireThreadIdOrSelf(id, options);
        printWork(
          options,
          await createCliOmnyoSdk(getUrl()).threads.experimental_work({
            threadId,
          }),
        );
      }),
    );

  work
    .command("publish [id]")
    .description(
      "Publish a validated producer observation or source-bound assessment",
    )
    .option("--self", "Use this chat")
    .requiredOption("--plugin <id>", "Owning plugin or producer namespace")
    .requiredOption(
      "--value <json>",
      "Typed assessment or signals contribution",
    )
    .option("--json", "Print the resulting work snapshot as JSON")
    .action(
      action(
        async (
          id: string | undefined,
          options: WorkOptions & { plugin: string; value: string },
        ) => {
          const threadId = requireThreadIdOrSelf(id, options);

          const value = publishThreadWorkSchema.parse({
            pluginId: options.plugin,
            contribution: JSON.parse(options.value),
          });

          const snapshot = await createCliOmnyoSdk(
            getUrl(),
          ).threads.experimental_publishWork({ threadId, ...value });

          if (!outputJson(options, { threadId, work: snapshot }))
            printWork(options, snapshot);
        },
      ),
    );

  work
    .command("archive-ready [id]")
    .description(
      "Archive this chat only if its current assessment still recommends it",
    )
    .option("--self", "Use this chat")
    .requiredOption("--basis <revision>", "Work basis returned by thread work")
    .option("--json", "Print the archive result as JSON")
    .action(
      action(
        async (
          id: string | undefined,
          options: WorkOptions & { basis: string },
        ) => {
          const threadId = requireThreadIdOrSelf(id, options);

          const result = await createCliOmnyoSdk(
            getUrl(),
          ).threads.experimental_archiveReady({
            threadId,
            basis: options.basis,
          });

          if (!outputJson(options, result))
            console.log(`Archived ${result.archivedThreadIds.join(", ")}`);
        },
      ),
    );
}
