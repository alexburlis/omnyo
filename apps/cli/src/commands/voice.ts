import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import { Command } from "commander";
import { action } from "../action.js";
import { createCliOmnyoSdk } from "../client.js";
import { outputJson } from "./helpers.js";
import { voiceDiagnosticSchema } from "@omnyo/server-contract";

interface VoiceTranscribeOptions {
  json?: boolean;
  prompt?: string;
  type?: string;
}

export function registerVoiceCommands(
  program: Command,
  getUrl: () => string,
): void {
  const voice = program.command("voice").description("Voice input utilities");
  voice
    .command("diagnostic <file>")
    .description(
      "Record a validated content-free voice failure report in the coordinator log",
    )
    .option("--json", "Print machine-readable JSON output")
    .action(
      action(async (path: string, opts: { json?: boolean }) => {
        const report = voiceDiagnosticSchema.parse(
          JSON.parse(await readFile(path, "utf8")),
        );

        const result =
          await createCliOmnyoSdk(
            getUrl(),
          ).system.experimental_recordVoiceDiagnostic(report);

        if (!outputJson(opts, result)) console.log("Voice diagnostic recorded");
      }),
    );
  voice
    .command("prepare")
    .description(
      "Load the selected voice service's model now so the next dictation starts quickly",
    )
    .option("--json", "Print machine-readable JSON output")
    .action(
      action(async (opts: { json?: boolean }) => {
        const result =
          await createCliOmnyoSdk(
            getUrl(),
          ).system.experimental_prepareVoiceInput();

        if (!outputJson(opts, result)) {
          console.log("Voice input preparation started");
        }
      }),
    );
  voice
    .command("transcribe <file>")
    .description(
      "Transcribe an audio file with Omnyo's configured voice service",
    )
    .option("--prompt <text>", "Optional transcription context")
    .option("--type <mime>", "Audio MIME type", "audio/webm")
    .option("--json", "Print machine-readable JSON output")
    .action(
      action(async (path: string, opts: VoiceTranscribeOptions) => {
        const bytes = await readFile(path);

        const blob = new File([bytes], basename(path), {
          type: opts.type ?? "audio/webm",
        });

        const result = await createCliOmnyoSdk(getUrl()).system.transcribeVoice(
          {
            file: blob,
            ...(opts.prompt ? { prompt: opts.prompt } : {}),
          },
        );

        if (outputJson(opts, result)) return;
        console.log(result.text);
      }),
    );
}
