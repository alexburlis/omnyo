import { type PluginApi, type PluginAiTranscribeOptions } from "@omnyo/plugin-sdk";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { type z } from "zod";
import {
  hostContract,
  rpcContract,
  type engineStatusSchema,
  type preparedSchema,
  type AudioDiagnostics,
  type VoiceStatus,
} from "./contract";
import { inspectEnvironment, type LocalEnvironment } from "./environment";

// Omnyo aborts voice transcription at 70 seconds; fail visibly before that.
const deadlineMs = 65_000;

const downloadTimeoutMs = 30 * 60_000;

const entryDirectory = dirname(fileURLToPath(import.meta.url));

const helper = join(
  basename(entryDirectory) === "dist" ? entryDirectory : join(entryDirectory, "dist"),
  "local-voice-native",
  "OmnyoLocalVoice",
);

const downloadingMessage = "Downloading the speech model. This can take a few minutes.";

type EngineStatus = z.infer<typeof engineStatusSchema>;

type Prepared = z.infer<typeof preparedSchema>;

type Timing = {
  prepareMs: number | null;
  decodeMs: number | null;
  coldStart: boolean | null;
  compileCacheMissing: boolean | null;
  audio: AudioDiagnostics | null;
};

function untimed(): Timing {
  return {
    prepareMs: null,
    decodeMs: null,
    coldStart: null,
    compileCacheMissing: null,
    audio: null,
  };
}

type DictationService = Parameters<PluginApi["experimental_aiServices"]["register"]>[0] & {
  experimental_prepare: (options: { readonly signal: AbortSignal }) => Promise<void>;
};

const stoppedEngine: EngineStatus = { loaded: false, busy: false, pid: null, dictionaryCount: 0 };

class Unavailable extends Error {}

export default async function plugin(api: PluginApi) {
  const settings = api.settings.define({
    dictionary: {
      type: "string",
      label: "Custom dictionary",
      description: "One English name or phrase per line.",
      experimental_multiline: true,
      default: "",
    },
  });

  const host = api.hosts.experimental_client({ contract: hostContract });
  const lifetime = new AbortController();
  let dictionary = (await settings.get()).dictionary;
  let primaryHostId: string | undefined;
  let downloadRun: Promise<void> | undefined;
  let downloadFailed = false;
  api.onDispose(() => lifetime.abort());

  function terms(): string[] {
    return [
      ...new Set(
        dictionary
          .split(/\r?\n/u)
          .map((term) => term.trim())
          .filter(Boolean),
      ),
    ];
  }

  async function mac(signal: AbortSignal): Promise<string> {
    if (primaryHostId !== undefined) return primaryHostId;
    const config = await api.sdk.system.config({ signal });

    if (config.primaryHostId === null)
      throw new Unavailable("Dictation by Paraspeech needs Omnyo running on a Mac.");

    if (config.primaryHostPlatform === null)
      throw new Unavailable("Waiting for this Mac to connect to Omnyo.");

    if (config.primaryHostPlatform !== "darwin")
      throw new Unavailable("Dictation by Paraspeech needs Omnyo running on a Mac.");
    primaryHostId = config.primaryHostId;

    return primaryHostId;
  }

  function missingModels(local: LocalEnvironment) {
    return {
      speech: !local.speechModel,
      dictionary: terms().length > 0 && !local.dictionaryModel,
    };
  }

  function describe(local: LocalEnvironment, engine: EngineStatus): VoiceStatus {
    if (local.problem !== null) return { ...engine, state: "unavailable", message: local.problem };

    if (downloadRun) return { ...engine, state: "downloading", message: downloadingMessage };
    const missing = missingModels(local);

    if (!missing.speech && !missing.dictionary)
      return {
        ...engine,
        state: "ready",
        message: "Speech model downloaded. Dictation runs on this Mac.",
      };

    if (downloadFailed)
      return {
        ...engine,
        state: "download_failed",
        message: "The download stopped. Check your connection and try again.",
      };

    const message = missing.speech
      ? `Download the English speech model (about ${local.dictionaryModel ? 450 : 550} MB) to dictate on this Mac.`
      : "Download the dictionary model (about 100 MB) to use your custom words.";

    return { ...engine, state: "download_required", message };
  }

  async function status(signal = lifetime.signal, withEngine = false): Promise<VoiceStatus> {
    let hostId: string;

    try {
      hostId = await mac(signal);
    } catch (error) {
      signal.throwIfAborted();

      if (!(error instanceof Unavailable)) api.log.warn("system_config_unavailable");

      return {
        ...stoppedEngine,
        state: "unavailable",
        message:
          error instanceof Unavailable
            ? error.message
            : "Dictation by Paraspeech can't reach this Mac right now.",
      };
    }

    const local = await inspectEnvironment(helper);

    if (!withEngine || local.problem !== null) return describe(local, stoppedEngine);

    try {
      return describe(
        local,
        await host.call("status", null, { hostId, signal, timeoutMs: 10_000 }),
      );
    } catch {
      signal.throwIfAborted();
      api.log.warn("local_host_unavailable");

      return describe(local, stoppedEngine);
    }
  }

  async function prepare(
    download: boolean,
    signal: AbortSignal,
    timeoutMs = download ? downloadTimeoutMs : deadlineMs,
  ): Promise<Prepared> {
    const hostId = await mac(signal);

    return host.call(
      "prepare",
      { helper, dictionary: terms(), download },
      { hostId, signal, timeoutMs },
    );
  }

  function startDownload(): void {
    if (downloadRun) return;
    downloadFailed = false;

    const run = prepare(true, lifetime.signal)
      .then(
        () => undefined,
        () => {
          downloadFailed = true;
          api.log.warn("model_download_failed");
        },
      )
      .finally(() => {
        if (downloadRun === run) downloadRun = undefined;
      });

    downloadRun = run;
  }

  async function refresh(): Promise<void> {
    const current = await status();

    if (current.state === "ready") await prepare(false, lifetime.signal);
    else if (
      current.state === "download_required" &&
      !missingModels(await inspectEnvironment(helper)).speech
    )
      startDownload();
  }

  async function download(): Promise<VoiceStatus> {
    const current = await status();

    if (current.state === "download_required" || current.state === "download_failed")
      startDownload();

    return status(lifetime.signal, true);
  }

  settings.onChange((next) => {
    dictionary = next.dictionary;
    void refresh().catch(() => api.log.warn("local_engine_unavailable"));
  });

  function record(
    route: "local" | "cancelled",
    phase: "start" | "prepared" | "done" | "error",
    started: number,
    timing: Timing,
    reason = "none",
  ): void {
    api.log.info(
      JSON.stringify({
        route,
        phase,
        elapsedMs: Math.round(performance.now() - started),
        reason,
        prepareMs: timing.prepareMs,
        decodeMs: timing.decodeMs,
        coldStart: timing.coldStart,
        compileCacheMissing: timing.compileCacheMissing,
        audio: timing.audio,
      }),
    );
  }

  function since(started: number): number {
    return Math.round(performance.now() - started);
  }

  function prepared(timing: Timing, result: Prepared, started: number): void {
    timing.prepareMs = since(started);
    timing.coldStart = result.coldStartMs !== null;
    timing.compileCacheMissing = result.compileCacheMissing;
  }

  async function prepareForDictation(signal: AbortSignal): Promise<void> {
    const started = performance.now();
    const current = await status(signal);
    const timing = untimed();

    if (current.state !== "ready") {
      record("local", "prepared", started, timing, "not_ready");
      throw new Error(guidance(current));
    }

    const prepareStarted = performance.now();

    prepared(
      timing,
      await prepare(false, AbortSignal.any([signal, lifetime.signal])),
      prepareStarted,
    );
    record("local", "prepared", started, timing);
  }

  function guidance(current: VoiceStatus): string {
    if (current.state === "unavailable") return current.message;

    if (current.state === "downloading") return downloadingMessage;

    return "Download the speech model in Settings → Dictation.";
  }

  async function transcribe(
    audio: File,
    { signal: callerSignal }: PluginAiTranscribeOptions,
  ): Promise<string> {
    const cancelled = AbortSignal.any([callerSignal, lifetime.signal]);
    const signal = AbortSignal.any([cancelled, AbortSignal.timeout(deadlineMs)]);
    const started = performance.now();
    const remaining = () => Math.max(1, Math.floor(deadlineMs - (performance.now() - started)));
    signal.throwIfAborted();

    if (audio.size === 0 || audio.size > 10 * 1024 * 1024)
      throw new Error("Recording is empty or too large.");

    const timing = untimed();
    record("local", "start", started, timing);
    const current = await status(signal);

    if (current.state !== "ready") {
      record("local", "error", started, timing, "not_ready");
      throw new Error(guidance(current));
    }

    const bytes = Buffer.from(await audio.arrayBuffer()).toString("base64");
    const hostId = await mac(signal);
    let reason: string;

    try {
      const prepareStarted = performance.now();
      prepared(timing, await prepare(false, signal, remaining()), prepareStarted);
      signal.throwIfAborted();
      const decodeStarted = performance.now();

      const result = await host.call(
        "transcribe",
        { audio: bytes },
        { hostId, signal, timeoutMs: remaining() },
      );

      timing.decodeMs = since(decodeStarted);
      timing.audio = result.audio;
      signal.throwIfAborted();

      if (result.ok && result.text.trim().length > 0) {
        record("local", "done", started, timing);

        return result.text.trim();
      }

      reason = result.ok ? "empty_transcript" : result.reason;
    } catch {
      if (cancelled.aborted) {
        record("cancelled", "done", started, timing, "user");
        cancelled.throwIfAborted();
      }

      reason = signal.aborted ? "timeout" : "local_failure";
    }

    record("local", "error", started, timing, reason);

    if (reason === "empty_transcript")
      throw new Error("Dictation by Paraspeech returned no text for this recording.");

    if (reason === "timeout") throw new Error("Dictation by Paraspeech took too long. Try again.");

    throw new Error("Dictation by Paraspeech couldn't transcribe this recording. Try again.");
  }

  const service: DictationService = {
    id: "local-voice",
    displayName: "Dictation by Paraspeech · English",
    transcribe,
    status: async () => {
      const current = await status();

      return current.state === "ready"
        ? { ready: true }
        : { ready: false, message: guidance(current) };
    },
    experimental_prepare: ({ signal }: { readonly signal: AbortSignal }) =>
      prepareForDictation(signal),
  };

  api.rpc.register(rpcContract, {
    status: () => status(lifetime.signal, true),
    download,
    prepare: async () => {
      await prepareForDictation(lifetime.signal);

      return status(lifetime.signal, true);
    },
  });
  api.experimental_aiServices.register(service);
}
