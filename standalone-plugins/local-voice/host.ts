import { experimental_defineHostEntry, type ExperimentalHostRpcContext } from "@omnyo/plugin-sdk";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { createInterface } from "node:readline";
import { z } from "zod";
import { AudioDecodeFailure, audioDiagnostics, writeSpeechWav } from "./audio";
import { inspectEnvironment } from "./environment";
import { hostContract } from "./contract";

const loadTimeoutMs = 300_000;

const decodeTimeoutMs = 60_000;

const downloadTimeoutMs = 30 * 60_000;

// The helper fetches the dictionary model only while it has a term to score.
const downloadDictionary = ["Omnyo"];

const replySchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("ready") }),
  z.object({ kind: z.literal("transcript"), text: z.string() }),
  z.object({ kind: z.literal("error") }),
]);

function parseReply(line: string) {
  try {
    return replySchema.safeParse(JSON.parse(line));
  } catch {
    return null;
  }
}

function fetchModels(helper: string, signal: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const child = spawn(helper, [], { stdio: ["pipe", "pipe", "ignore"] });
    let settled = false;

    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      child.kill("SIGKILL");

      if (error) reject(error);
      else resolve();
    };

    const abort = () => finish(new Error("model_download_cancelled"));
    const timer = setTimeout(() => finish(new Error("model_download_timeout")), downloadTimeoutMs);
    signal.addEventListener("abort", abort, { once: true });
    child.once("error", () => finish(new Error("model_download_failed")));
    child.once("exit", () => finish(new Error("model_download_failed")));

    if (!child.stdout || !child.stdin) {
      finish(new Error("model_download_failed"));

      return;
    }

    const lines = createInterface({ input: child.stdout });
    child.once("close", () => lines.close());
    lines.on("line", (line) => {
      const reply = parseReply(line);
      finish(
        reply?.success && reply.data.kind === "ready"
          ? undefined
          : new Error("model_download_failed"),
      );
    });
    child.stdin.on("error", () => finish(new Error("model_download_failed")));
    child.stdin.write(JSON.stringify({ dictionary: downloadDictionary, prepare: true }) + "\n");
  });
}

// The engine owns the helper; a caller's abort only detaches that caller from shared work.
function untilAborted<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason);

  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    void work.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}

function settled(work: Promise<unknown>): Promise<void> {
  return work.then(
    () => undefined,
    () => undefined,
  );
}

type DecodeResult = { ok: true; text: string } | { ok: false; reason: "unready" | "decode_failed" };

type TranscribeResult = z.infer<typeof hostContract.transcribe.output>;

const unready: DecodeResult = { ok: false, reason: "unready" };

const decodeFailed: DecodeResult = { ok: false, reason: "decode_failed" };

type Target = { helper: string; dictionary: string[] };

function targetKey(target: Target): string {
  return JSON.stringify([target.helper, target.dictionary]);
}

type BootOutcome = { compileCacheMissing: boolean };

type Waiter<T> = { resolve: (value: T) => void; reject: (error: Error) => void };

type Helper = {
  readonly child: ChildProcess;
  readonly key: string;
  readonly dictionaryCount: number;
  loaded: boolean;
  boot?: Waiter<void>;
  reply?: Waiter<string>;
};

type Job = { wav: string; signal: AbortSignal } & Waiter<DecodeResult>;

class Unready extends Error {}

class SpeechEngine {
  private process?: Helper;
  private booting?: { key: string; promise: Promise<BootOutcome> };
  private decoding?: Promise<string>;
  private fetch?: Promise<void>;
  private target?: Target;
  private readonly queue: Job[] = [];
  private draining = false;
  private running = 0;
  private disposed = false;

  constructor(private readonly tempDir: string) {}

  status() {
    const helper = this.process;
    const target = this.target;

    return {
      loaded: helper?.loaded === true && target !== undefined && helper.key === targetKey(target),
      busy: this.running > 0,
      pid: helper?.child.pid ?? null,
      dictionaryCount: helper?.dictionaryCount ?? 0,
    };
  }

  private download(helper: string, signal: AbortSignal): Promise<void> {
    if (this.fetch) return this.fetch;

    const download = fetchModels(helper, signal).finally(() => {
      if (this.fetch === download) this.fetch = undefined;
    });

    this.fetch = download;

    return download;
  }

  async prepare(helper: string, dictionary: string[], download: boolean, signal: AbortSignal) {
    if (this.disposed) throw new Error("local_engine_disposed");

    const environment = await inspectEnvironment(helper);

    if (environment.problem !== null) throw new Error("local_engine_unsupported");

    if (download && (!environment.speechModel || !environment.dictionaryModel))
      await this.download(helper, signal);
    else if (this.fetch) await untilAborted(this.fetch, signal);

    signal.throwIfAborted();
    this.target = { helper, dictionary };
    const started = performance.now();
    const boot = await untilAborted(this.ensureLoaded(), signal);

    return {
      coldStartMs: boot === null ? null : Math.round(performance.now() - started),
      compileCacheMissing: boot === null ? null : boot.compileCacheMissing,
    };
  }

  transcribe(audio: string, signal: AbortSignal): Promise<TranscribeResult> {
    signal.throwIfAborted();

    return untilAborted(this.run(audio, signal), signal);
  }

  async dispose(): Promise<void> {
    this.disposed = true;

    for (const job of this.queue.splice(0)) job.reject(new Error("local_engine_disposed"));
    const helper = this.process;

    if (!helper) return;
    const closed = new Promise<void>((resolve) => helper.child.once("close", () => resolve()));
    this.fail(helper, new Error("local_engine_disposed"));
    await closed;
  }

  private async ensureLoaded(): Promise<BootOutcome | null> {
    for (;;) {
      if (this.disposed) throw new Error("local_engine_disposed");

      const target = this.target;

      if (target === undefined) throw new Unready();
      const key = targetKey(target);

      if (this.booting) {
        if (this.booting.key === key) return this.booting.promise;
        await settled(this.booting.promise);
        continue;
      }

      if (this.process?.loaded && this.process.key === key) return null;

      // A dictionary or helper change waits for the in-flight decode's reply.
      if (this.decoding) {
        await settled(this.decoding);
        continue;
      }

      return this.spawnHelper(target, key);
    }
  }

  private spawnHelper(target: Target, key: string): Promise<BootOutcome> {
    if (this.process) this.fail(this.process, new Error("local_engine_replaced"));

    // Core ML keys its compiled-model cache by executable name.
    const compileCacheMissing = !existsSync(
      join(homedir(), "Library", "Caches", basename(target.helper)),
    );

    const child = spawn(target.helper, [], { stdio: ["pipe", "pipe", "ignore"] });

    const helper: Helper = {
      child,
      key,
      dictionaryCount: target.dictionary.length,
      loaded: false,
    };

    this.process = helper;

    const promise = new Promise<BootOutcome>((resolve, reject) => {
      const timer = setTimeout(
        () => this.fail(helper, new Error("local_engine_timeout")),
        loadTimeoutMs,
      );

      helper.boot = {
        resolve: () => {
          clearTimeout(timer);
          resolve({ compileCacheMissing });
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      };
    });

    const clear = () => {
      if (this.booting?.promise === promise) this.booting = undefined;
    };

    this.booting = { key, promise };
    promise.then(clear, clear);

    const unavailable = () => this.fail(helper, new Error("local_engine_unavailable"));
    child.once("error", unavailable);
    child.once("exit", unavailable);

    if (!child.stdout || !child.stdin) {
      unavailable();

      return promise;
    }

    const lines = createInterface({ input: child.stdout });
    child.once("close", () => lines.close());
    lines.on("line", (line) => this.receive(helper, line));
    child.stdin.on("error", unavailable);
    child.stdin.write(JSON.stringify({ dictionary: target.dictionary, prepare: false }) + "\n");

    return promise;
  }

  private receive(helper: Helper, line: string): void {
    const parsed = parseReply(line);

    if (!parsed?.success) {
      this.fail(helper, new Error("local_engine_protocol"));

      return;
    }

    const message = parsed.data;

    if (!helper.loaded) {
      if (message.kind !== "ready") {
        this.fail(helper, new Error("local_engine_unavailable"));

        return;
      }

      helper.loaded = true;
      const boot = helper.boot;
      helper.boot = undefined;
      boot?.resolve();

      return;
    }

    const reply = helper.reply;

    if (message.kind === "ready" || !reply) {
      this.fail(helper, new Error("local_engine_protocol"));

      return;
    }

    helper.reply = undefined;

    if (message.kind === "transcript") reply.resolve(message.text);
    else reply.reject(new Error("decode_failed"));
  }

  private fail(helper: Helper, error: Error): void {
    if (this.process === helper) this.process = undefined;
    helper.loaded = false;
    const { boot, reply } = helper;
    helper.boot = undefined;
    helper.reply = undefined;
    boot?.reject(error);
    reply?.reject(error);
    helper.child.kill("SIGKILL");
  }

  private async run(audio: string, signal: AbortSignal): Promise<TranscribeResult> {
    let temporary: string | undefined;
    const bytes = Buffer.from(audio, "base64");
    let diagnostics = audioDiagnostics(bytes.length);
    this.running += 1;

    try {
      temporary = await mkdtemp(join(this.tempDir, "audio-"));
      const input = join(temporary, "recording");
      const wav = join(temporary, "recording.wav");
      await writeFile(input, bytes, { mode: 0o600 });
      diagnostics = await writeSpeechWav(input, wav, signal);

      const result = await new Promise<DecodeResult>((resolve, reject) => {
        if (this.disposed) {
          reject(new Error("local_engine_disposed"));

          return;
        }

        this.queue.push({ wav, signal, resolve, reject });
        void this.drain();
      });

      return { ...result, audio: diagnostics };
    } catch (error) {
      return {
        ok: false,
        reason: error instanceof AudioDecodeFailure ? "audio_decode_failed" : "decode_failed",
        audio: error instanceof AudioDecodeFailure ? error.audio : diagnostics,
      };
    } finally {
      if (temporary) await rm(temporary, { recursive: true, force: true });
      this.running -= 1;
    }
  }

  private async drain(): Promise<void> {
    if (this.draining) return;
    this.draining = true;

    try {
      for (let job = this.queue.shift(); job; job = this.queue.shift()) {
        if (job.signal.aborted) job.resolve(decodeFailed);
        else job.resolve(await this.decode(job));
      }
    } finally {
      this.draining = false;
    }
  }

  private async decode(job: Job): Promise<DecodeResult> {
    try {
      await this.ensureLoaded();
    } catch (error) {
      return error instanceof Unready ? unready : decodeFailed;
    }

    const helper = this.process;
    const stdin = helper?.child.stdin;

    if (job.signal.aborted || !helper?.loaded || !stdin) return decodeFailed;

    const reply = new Promise<string>((resolve, reject) => {
      const watchdog = setTimeout(
        () => this.fail(helper, new Error("decode_timeout")),
        decodeTimeoutMs,
      );

      helper.reply = {
        resolve: (text) => {
          clearTimeout(watchdog);
          resolve(text);
        },
        reject: (error) => {
          clearTimeout(watchdog);
          reject(error);
        },
      };
      stdin.write(JSON.stringify({ wav: job.wav }) + "\n");
    });

    this.decoding = reply;

    try {
      return { ok: true, text: await reply };
    } catch {
      return decodeFailed;
    } finally {
      if (this.decoding === reply) this.decoding = undefined;
    }
  }
}

let engine: SpeechEngine | undefined;

function getEngine(context: ExperimentalHostRpcContext): SpeechEngine {
  if (!engine) {
    engine = new SpeechEngine(context.experimental_paths.tempDir);
    context.lifecycle.signal.addEventListener("abort", () => engine?.dispose(), { once: true });
  }

  return engine;
}

export default experimental_defineHostEntry({
  contract: hostContract,
  handlers: {
    prepare: async ({ helper, dictionary, download }, context) => {
      const local = getEngine(context);
      const outcome = await local.prepare(helper, dictionary, download, context.signal);

      return { ...local.status(), ...outcome };
    },
    status: (_input, context) => getEngine(context).status(),
    transcribe: ({ audio }, context) => getEngine(context).transcribe(audio, context.signal),
  },
  dispose: async () => {
    await engine?.dispose();
  },
});
