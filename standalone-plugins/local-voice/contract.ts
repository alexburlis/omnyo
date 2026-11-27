import { defineRpcContract } from "@omnyo/plugin-sdk";
import { z } from "zod";

export const engineStatusSchema = z.object({
  loaded: z.boolean(),
  busy: z.boolean(),
  pid: z.number().nullable(),
  dictionaryCount: z.number(),
});

export const preparedSchema = engineStatusSchema.extend({
  coldStartMs: z.number().nullable(),
  compileCacheMissing: z.boolean().nullable(),
});

const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);

export const audioDiagnosticsSchema = z.object({
  encodedBytes: count,
  decodedDurationMs: count.nullable(),
  decodedSamples: count.nullable(),
  decodedSampleRate: count.nullable(),
  decodedChannels: count.nullable(),
  nonFiniteSamples: count.nullable(),
  clippedSamples: count.nullable(),
  signalLevelBucket: z.number().int().min(0).max(5).nullable(),
  opusErrorCount: count.nullable(),
});

export type AudioDiagnostics = z.infer<typeof audioDiagnosticsSchema>;

export const hostContract = defineRpcContract({
  prepare: {
    input: z.object({ helper: z.string(), dictionary: z.array(z.string()), download: z.boolean() }),
    output: preparedSchema,
  },
  status: { input: z.null(), output: engineStatusSchema },
  transcribe: {
    input: z.object({ audio: z.string() }),
    output: z.discriminatedUnion("ok", [
      z.object({ ok: z.literal(true), text: z.string(), audio: audioDiagnosticsSchema }),
      z.object({
        ok: z.literal(false),
        reason: z.enum(["unready", "audio_decode_failed", "decode_failed"]),
        audio: audioDiagnosticsSchema,
      }),
    ]),
  },
});

export const statusSchema = z.object({
  state: z.enum(["unavailable", "download_required", "downloading", "download_failed", "ready"]),
  message: z.string(),
  loaded: z.boolean(),
  busy: z.boolean(),
  pid: z.number().nullable(),
  dictionaryCount: z.number(),
});

export type VoiceStatus = z.infer<typeof statusSchema>;

export const rpcContract = defineRpcContract({
  status: {
    experimental_description:
      "Show whether the speech model is downloaded and the local speech engine is loaded.",
    input: z.null(),
    output: statusSchema,
  },
  download: {
    experimental_description:
      "Download the English speech model, and the dictionary model when the dictionary has words.",
    input: z.null(),
    output: statusSchema,
  },
  prepare: {
    experimental_description:
      "Load the downloaded speech model now so the next dictation starts quickly; fails when the model is not ready.",
    input: z.null(),
    output: statusSchema,
  },
});
