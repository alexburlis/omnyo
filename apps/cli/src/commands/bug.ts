import { Command } from "commander";
import {
  bugReportRequestSchema,
  type BugReportUnavailableReason,
} from "@omnyo/server-contract";
import { action, CliExitError, CliUsageError } from "../action.js";
import { createCliOmnyoSdk } from "../client.js";
import { requireTextInput, TEXT_FILE_HELP_SUFFIX } from "../text-input.js";
import { outputJson, type JsonOutputOptions } from "./helpers.js";

interface BugReportCommandOptions extends JsonOutputOptions {
  email?: string;
  messageFile?: string;
}

const UNAVAILABLE_COPY: Record<
  BugReportUnavailableReason,
  { message: string; hint: string }
> = {
  "crash-reports-off": {
    message: "Bug reports are off because Crash reports is off.",
    hint: "Turn it on with `omnyo settings general crashReportsEnabled true`, then try again.",
  },
  "not-configured": {
    message: "This Omnyo server isn't set up to send bug reports.",
    hint: "Bug reports need a production server with OMNYO_SENTRY_DSN set.",
  },
};

export function registerBugCommands(
  program: Command,
  getUrl: () => string,
): void {
  const bug = program.command("bug").description("Report problems with Omnyo");

  bug
    .command("report [message]")
    .description(
      "Send a bug report to the Omnyo team through the server's Sentry project, linked to the running release. Sends only the text you write and the optional email; no logs, screenshots or chat content",
    )
    .option(
      "--message-file <path>",
      `Read the report from a file instead of the message argument; ${TEXT_FILE_HELP_SUFFIX}`,
    )
    .option("--email <address>", "Email address for follow-up questions")
    .option("--json", "Print machine-readable JSON output")
    .action(
      action(
        async (
          inlineMessage: string | undefined,
          opts: BugReportCommandOptions,
        ) => {
          const message = await requireTextInput({
            file: opts.messageFile,
            fileLabel: "--message-file",
            inline: inlineMessage,
            inlineLabel: "message",
          });

          const parsed = bugReportRequestSchema.safeParse({
            message,
            ...(opts.email === undefined ? {} : { email: opts.email }),
          });

          if (!parsed.success) {
            const field = parsed.error.issues[0]?.path[0];

            throw new CliUsageError({
              code: "invalid_value",
              hint: null,
              message:
                field === "email"
                  ? `'${opts.email}' is not a valid email address.`
                  : "The report must be between 1 and 4,000 characters.",
            });
          }

          const result = await createCliOmnyoSdk(
            getUrl(),
          ).system.experimental_reportBug(parsed.data);

          if (result.status === "unavailable") {
            const copy = UNAVAILABLE_COPY[result.reason];

            throw new CliExitError(copy.message, 1, {
              code: "bug_reports_unavailable",
              hint: copy.hint,
            });
          }

          if (outputJson(opts, result)) return;
          console.log(`Bug report sent. Reference: ${result.reportId}`);
        },
      ),
    );
}
