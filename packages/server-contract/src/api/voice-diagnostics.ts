import { z } from "zod";

export const voiceTranscriptionContextSchema = z
  .object({
    recordingId: z.uuid(),
    attempt: z.number().int().min(1).max(100),
  })
  .strict();

export type VoiceTranscriptionContext = z.infer<
  typeof voiceTranscriptionContextSchema
>;

export const voiceDiagnosticSchema = voiceTranscriptionContextSchema
  .extend({
    occurredAt: z.number().int().min(0).max(8_640_000_000_000_000),
    clientBundle: z
      .string()
      .regex(/^[a-zA-Z0-9_-]{1,96}\.js$/u)
      .nullable(),
    iosVersion: z
      .string()
      .regex(/^\d{1,3}(?:\.\d{1,3}){0,2}$/u)
      .nullable(),
    webkitVersion: z
      .string()
      .regex(/^\d{1,4}(?:\.\d{1,4}){0,3}$/u)
      .nullable(),
    outcome: z.enum(["failed", "recovered"]),
    stage: z.enum([
      "starting",
      "recording",
      "finalizing",
      "request",
      "delivery",
    ]),
    cause: z.enum([
      "permission_denied",
      "microphone_missing",
      "microphone_busy",
      "capture_aborted",
      "capture_failed",
      "recorder_failed",
      "recording_short",
      "recording_empty",
      "empty_transcript",
      "http_error",
      "transport_error",
      "delivery_failed",
      "recovered",
    ]),
    httpStatus: z.number().int().min(100).max(599).nullable(),
    elapsedMs: z.number().int().min(0).max(86_400_000),
    durationMs: z.number().int().min(0).max(86_400_000),
    audioBytes: z
      .number()
      .int()
      .min(0)
      .max(100 * 1024 * 1024),
    chunkCount: z.number().int().min(0).max(1_000_000),
    mime: z.enum(["webm", "mp4", "ogg", "other", "none"]),
    recorderState: z.enum(["inactive", "recording", "paused", "unknown"]),
    audioContextState: z.enum([
      "running",
      "suspended",
      "interrupted",
      "closed",
      "unknown",
    ]),
    trackState: z.enum(["live", "ended", "unknown"]),
    trackMuted: z.boolean().nullable(),
    silent: z.boolean(),
    wasHidden: z.boolean(),
  })
  .strict();

export type VoiceDiagnostic = z.infer<typeof voiceDiagnosticSchema>;
