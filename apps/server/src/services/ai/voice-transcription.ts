import type { LoggedWorkSessionDeps } from "../../types.js";
import { ApiError } from "../../errors.js";
import { captureProcessError } from "@omnyo/process-utils/error-reporting";
import {
  AiTaskEmptyResultError,
  isAiTaskAvailable,
  runAiTask,
} from "./ai-tasks.js";
import type { VoiceTranscriptionContext } from "@omnyo/server-contract";

interface TranscribeVoiceInputArgs {
  file: File;
  prompt?: string;
  signal: AbortSignal;
  diagnostic?: VoiceTranscriptionContext;
}

const VOICE_TRANSCRIPTION_MAX_BYTES = 25 * 1024 * 1024;

export function resolveVoiceTranscriptionEnabled(
  deps: LoggedWorkSessionDeps,
): boolean {
  return isAiTaskAvailable(deps, "voice");
}

function trimPrompt(prompt: string | undefined): string | null {
  const trimmed = prompt?.trim() ?? "";

  return trimmed.length > 0 ? trimmed : null;
}

export async function transcribeVoiceInput(
  deps: LoggedWorkSessionDeps,
  args: TranscribeVoiceInputArgs,
): Promise<string> {
  if (args.file.size === 0) {
    throw new ApiError(400, "invalid_request", "Audio file must not be empty");
  }

  if (args.file.size > VOICE_TRANSCRIPTION_MAX_BYTES) {
    throw new ApiError(400, "invalid_request", "Audio file exceeds 25MB limit");
  }

  const hint = trimPrompt(args.prompt);

  const outcome = await runAiTask(deps, {
    task: "voice",
    label: "Voice transcription",
    signal: args.signal,
    logContext: args.diagnostic,
    call: (service, signal) => {
      if (service.transcribe === null) {
        throw new Error("This service does not transcribe audio");
      }

      return service.transcribe(args.file, { signal, hint });
    },
    accept: (raw) => (typeof raw === "string" ? raw.trim() || null : null),
  });

  if (outcome.ok) {
    return outcome.value;
  }

  if (outcome.reason === "failed" || outcome.reason === "timeout") {
    captureProcessError(
      outcome.error ?? new Error("Voice transcription failed"),
      {
        level: "error",
        stage: "request",
        diagnostic: {
          operation: "voice-transcription",
          stage: "complete",
          failureClass:
            outcome.reason === "timeout"
              ? "timeout"
              : outcome.error instanceof AiTaskEmptyResultError
                ? "empty-result"
                : "unknown",
          outcome: "terminal",
          dependency: "provider",
          retryable: outcome.reason === "timeout",
          durationMs: outcome.durationMs,
          ...(args.diagnostic === undefined
            ? {}
            : {
                operationId: args.diagnostic.recordingId,
                attempt: args.diagnostic.attempt,
              }),
        },
      },
    );
  }

  switch (outcome.reason) {
    case "off":
    case "unavailable":
      throw new ApiError(501, "not_configured", outcome.message);
    case "timeout":
      throw new ApiError(
        504,
        "transcription_timeout",
        "Voice transcription timed out",
        true,
      );
    case "failed":
      throw new ApiError(502, "provider_rpc_error", outcome.message);
    case "cancelled":
      throw new ApiError(400, "cancelled", "Voice transcription was cancelled");
  }
}
