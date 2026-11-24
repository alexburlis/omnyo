import { randomUUID } from "node:crypto";
import { Command } from "commander";
import type { PreviewBinding, PreviewStatus } from "@omnyo/server-contract";
import { action, CliExitError } from "../action.js";
import { createCliOmnyoSdk } from "../client.js";
import { columnWidths, printBorderlessTable } from "../table.js";
import { outputJson, type JsonOutputOptions } from "./helpers.js";

interface PreviewRegisterOptions extends JsonOutputOptions {
  thread: string;
  url: string;
  cwd?: string;
  readinessPath?: string;
}

interface PreviewListOptions extends JsonOutputOptions {
  thread: string;
}

interface PreviewRestartOptions extends JsonOutputOptions {
  requestId?: string;
}

function printPreview(binding: PreviewBinding): void {
  console.log(`Preview ${binding.id}`);
  console.log(`Local: ${binding.url}`);
  console.log(`Omnyo: ${binding.remoteUrl}`);
}

function printStatus(status: PreviewStatus): void {
  console.log(
    status.detail === null ? status.state : `${status.state}: ${status.detail}`,
  );
}

export function registerPreviewCommands(
  program: Command,
  getUrl: () => string,
): void {
  const preview = program
    .command("preview")
    .description("Register preview servers and recover their recorded launch");

  preview
    .command("register <command...>")
    .description("Store an exact preview launch recipe without starting it")
    .requiredOption("--thread <id>", "Thread owning the preview environment")
    .requiredOption("--url <url>", "Original loopback HTTP(S) preview URL")
    .option("--cwd <path>", "Launch directory on the owning machine")
    .option("--readiness-path <path>", "Path and query to check for readiness")
    .option("--json", "Print machine-readable JSON output")
    .addHelpText(
      "after",
      "\nPass the executable and its exact arguments after --. Use an existing protected wrapper for credentials; never include secret values in arguments.",
    )
    .action(
      action(async (argv: string[], opts: PreviewRegisterOptions) => {
        const binding = await createCliOmnyoSdk(getUrl()).previews.register({
          threadId: opts.thread,
          url: opts.url,
          argv,
          ...(opts.cwd === undefined ? {} : { cwd: opts.cwd }),
          ...(opts.readinessPath === undefined
            ? {}
            : { readinessPath: opts.readinessPath }),
        });

        if (outputJson(opts, binding)) return;
        printPreview(binding);
      }),
    );

  preview
    .command("list")
    .description("List registered previews in a thread environment")
    .requiredOption("--thread <id>", "Source thread")
    .option("--json", "Print machine-readable JSON output")
    .action(
      action(async (opts: PreviewListOptions) => {
        const result = await createCliOmnyoSdk(getUrl()).previews.list({
          threadId: opts.thread,
        });

        if (outputJson(opts, result)) return;

        if (result.previews.length === 0) {
          console.log("No registered previews");

          return;
        }

        const rows = result.previews.map((binding) => [
          binding.id,
          binding.hostId,
          binding.url,
        ]);

        printBorderlessTable(
          {
            head: ["ID", "Machine", "Local URL"],
            colWidths: columnWidths(rows, [2, 7, 9]),
            trimTrailingWhitespace: true,
          },
          rows,
        );
      }),
    );

  preview
    .command("show <previewId>")
    .description("Show a preview binding without its private launch recipe")
    .option("--json", "Print machine-readable JSON output")
    .action(
      action(async (previewId: string, opts: JsonOutputOptions) => {
        const binding = await createCliOmnyoSdk(getUrl()).previews.get({
          previewId,
        });

        if (outputJson(opts, binding)) return;
        printPreview(binding);
      }),
    );

  preview
    .command("status <previewId>")
    .description("Check readiness and process ownership on the owning machine")
    .option("--json", "Print machine-readable JSON output")
    .action(
      action(async (previewId: string, opts: JsonOutputOptions) => {
        const result = await createCliOmnyoSdk(getUrl()).previews.status({
          previewId,
        });

        if (outputJson(opts, result)) return;
        printStatus(result);
      }),
    );

  preview
    .command("restart <previewId>")
    .description("Ensure the recorded server is ready; reuse an owned live run")
    .option("--request-id <id>", "Stable identity when retrying the same tap")
    .option("--json", "Print machine-readable JSON output")
    .action(
      action(async (previewId: string, opts: PreviewRestartOptions) => {
        const result = await createCliOmnyoSdk(getUrl()).previews.restart({
          previewId,
          requestId: opts.requestId ?? randomUUID(),
        });

        if (result.state !== "online") {
          throw new CliExitError(
            `Preview is ${result.state}${result.detail === null ? "" : `: ${result.detail}`}`,
            1,
            { code: "preview_not_ready", hint: null },
          );
        }

        if (outputJson(opts, result)) return;
        printStatus(result);
      }),
    );

  preview
    .command("remove <previewId>")
    .description("Delete a stopped preview's saved launch recipe")
    .option("--json", "Print machine-readable JSON output")
    .action(
      action(async (previewId: string, opts: JsonOutputOptions) => {
        const result = await createCliOmnyoSdk(
          getUrl(),
        ).previews.experimental_remove({
          previewId,
        });

        if (outputJson(opts, result)) return;
        console.log(`Removed preview ${previewId}`);
      }),
    );
}
