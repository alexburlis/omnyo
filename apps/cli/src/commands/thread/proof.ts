import { Command } from "commander";
import type { CommandProofSelector } from "@omnyo/server-contract";
import { action } from "../../action.js";
import { createCliOmnyoSdk } from "../../client.js";
import { outputJson, requireThreadIdOrSelf } from "../helpers.js";

function collect(value: string, previous: string[]): string[] {
  return [...previous, value];
}

export function registerProofCommand(
  parent: Command,
  getUrl: () => string,
): void {
  parent
    .command("proof [id]")
    .description(
      "Look up redacted completed command executions without loading chat history",
    )
    .option("--self", "Use the current thread")
    .option(
      "--command <command>",
      "Match a unique exact command in the latest 500 completed events; repeatable",
      collect,
      [],
    )
    .option(
      "--event-seq <sequence>",
      "Select an exact completed command event; repeatable",
      collect,
      [],
    )
    .option("--json", "Print machine-readable JSON output")
    .action(
      action(
        async (
          id: string | undefined,
          opts: {
            self?: boolean;
            command: string[];
            eventSeq: string[];
            json?: boolean;
          },
        ) => {
          const selectors: CommandProofSelector[] = opts.command.map(
            (command) => ({ kind: "command", command }),
          );

          for (const value of opts.eventSeq) {
            const eventSeq = Number(value);

            if (!Number.isSafeInteger(eventSeq) || eventSeq <= 0)
              throw new Error("--event-seq must be a positive integer");
            selectors.push({ kind: "event", eventSeq });
          }

          const result = await createCliOmnyoSdk(
            getUrl(),
          ).threads.experimental_lookupCommandProofs({
            threadId: requireThreadIdOrSelf(id, opts),
            selectors,
          });

          if (outputJson(opts, result)) return;

          if (result.proofs.length === 0) console.log("Chat exists.");

          for (const [index, proof] of result.proofs.entries()) {
            if (proof.status !== "matched") {
              console.log(
                `${index + 1}. ${proof.status === "ambiguous" ? "Ambiguous command" : "No matching completed command"}`,
              );
              continue;
            }

            const execution = proof.execution;
            console.log(
              `${index + 1}. Event ${execution.eventSeq}: ${execution.status}, exit ${execution.exitCode ?? "unknown"}`,
            );
            console.log(execution.command);

            if (execution.excerpt) console.log(execution.excerpt);
          }
        },
      ),
    );
}
