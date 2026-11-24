import { Command } from "commander";
import { attentionCommandSchema } from "@omnyo/server-contract";
import { action } from "../action.js";
import { createCliOmnyoSdk } from "../client.js";
import { requireThreadIdOrSelf, outputJson } from "./helpers.js";
import { resolveContextThreadId } from "../context-env.js";

interface Target {
  self?: boolean;
  json?: boolean;
}

function callbackOwner(id: string | undefined, opts: Target): string {
  const target = requireThreadIdOrSelf(id, opts);
  const invoking = resolveContextThreadId();

  if (invoking !== undefined && invoking !== target)
    throw new Error("A chat can change only its own callback dependency");

  return target;
}

export function registerAttentionCommands(
  program: Command,
  getUrl: () => string,
): void {
  if (program.commands.some((command) => command.name() === "question")) return;

  const questions = program
    .command("question")
    .description("Native required answers and optional steering");

  questions
    .command("adopt")
    .description("Transfer retained legacy plugin records to native ownership")
    .requiredOption("--plugin <id>")
    .option("--json")
    .action(
      action(async (opts: Target & { plugin: string }) => {
        if (opts.plugin !== "decisions" && opts.plugin !== "needs-you")
          throw new Error("Choose decisions or needs-you");

        const result = await createCliOmnyoSdk(
          getUrl(),
        ).experimental_attention.adopt({ pluginId: opts.plugin });

        if (!outputJson(opts, result)) console.log(JSON.stringify(result));
      }),
    );

  questions
    .command("list [threadId]")
    .option("--self")
    .option("--json")
    .action(
      action(async (id: string | undefined, opts: Target) => {
        const snapshot =
          await createCliOmnyoSdk(getUrl()).experimental_attention.snapshot();

        const target = id || opts.self ? requireThreadIdOrSelf(id, opts) : null;

        const result = snapshot.questions.filter(
          (question) => target === null || question.threadId === target,
        );

        if (!outputJson(opts, result))
          for (const question of result)
            console.log(
              `${question.id} r${question.revision} ${question.question.mode}: ${question.question.prompt}`,
            );
      }),
    );
  questions
    .command("command [threadId]")
    .description(
      "Open, update, answer, skip or withdraw questions using a typed JSON command",
    )
    .requiredOption("--value <json>")
    .option("--self")
    .option("--json")
    .action(
      action(
        async (id: string | undefined, opts: Target & { value: string }) => {
          const command = attentionCommandSchema.parse(JSON.parse(opts.value));

          if (["wait", "clear"].includes(command.action))
            throw new Error("Use omnyo callback for dependencies");

          const result = await createCliOmnyoSdk(
            getUrl(),
          ).experimental_attention.command({
            threadId: requireThreadIdOrSelf(id, opts),
            command,
          });

          if (!outputJson(opts, result)) console.log(JSON.stringify(result));
        },
      ),
    );

  const callbacks = program
    .command("callback")
    .description("Durable waits for an existing chat's verified completion");

  callbacks
    .command("waiting [threadId]")
    .option("--self")
    .option("--json")
    .action(
      action(async (id: string | undefined, opts: Target) => {
        const threadId = requireThreadIdOrSelf(id, opts);

        const result = (
          await createCliOmnyoSdk(getUrl()).experimental_attention.snapshot()
        ).callbacks.filter((wait) => wait.threadId === threadId);

        if (!outputJson(opts, result)) console.log(JSON.stringify(result));
      }),
    );
  callbacks
    .command("wait [threadId]")
    .requiredOption("--from <threadId>")
    .requiredOption("--reason <text>")
    .option("--self")
    .option("--json")
    .action(
      action(
        async (
          id: string | undefined,
          opts: Target & { from: string; reason: string },
        ) => {
          const result = await createCliOmnyoSdk(
            getUrl(),
          ).experimental_attention.command({
            threadId: callbackOwner(id, opts),
            command: {
              action: "wait",
              sourceThreadId: opts.from,
              reason: opts.reason,
            },
          });

          if (!outputJson(opts, result)) console.log(JSON.stringify(result));
        },
      ),
    );
  callbacks
    .command("clear [threadId]")
    .requiredOption("--id <waitId>")
    .option("--self")
    .option("--json")
    .action(
      action(async (id: string | undefined, opts: Target & { id: string }) => {
        const result = await createCliOmnyoSdk(
          getUrl(),
        ).experimental_attention.command({
          threadId: callbackOwner(id, opts),
          command: { action: "clear", id: opts.id },
        });

        if (!outputJson(opts, result)) console.log(JSON.stringify(result));
      }),
    );
}
