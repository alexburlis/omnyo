import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import { chromium, expect, test, type Page } from "@playwright/test";
import { z } from "zod";
import { audioDiagnosticsSchema } from "../contract";

test.describe.configure({ mode: "serial" });

function normalized(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, " ")
    .trim();
}

const run = promisify(execFile);

const fixtureRoot = resolve("e2e/fixtures");

const baseURL = process.env.OMNYO_SERVER_URL ?? "http://127.0.0.1:38886";

const statusSchema = z.object({
  state: z.enum(["unavailable", "download_required", "downloading", "download_failed", "ready"]),
  message: z.string(),
  loaded: z.boolean(),
  busy: z.boolean(),
  pid: z.number().nullable(),
  dictionaryCount: z.number(),
});

const eventSchema = z.object({
  route: z.enum(["local", "cancelled"]),
  phase: z.enum(["start", "prepared", "done", "error"]),
  elapsedMs: z.number(),
  reason: z.string(),
  prepareMs: z.number().nullable(),
  decodeMs: z.number().nullable(),
  coldStart: z.boolean().nullable(),
  compileCacheMissing: z.boolean().nullable(),
  audio: audioDiagnosticsSchema.nullable(),
});

type RouteEvent = z.infer<typeof eventSchema>;

type RunEvidence = { fixture: string; text: string; elapsedMs: number; events: RouteEvent[] };

const evidence: { fixture: string; sha256: string }[] = [];

const results: { case: string; runs: RunEvidence[]; detail: string }[] = [];

const observations: RunEvidence[] = [];

let originalDictionary = "";

async function api(...args: string[]): Promise<string> {
  return (await run("omnyo", args, { timeout: 60_000 })).stdout.trim();
}

async function status() {
  return statusSchema.parse(
    JSON.parse(await api("plugin", "rpc", "call", "local-voice", "status", "--json")),
  );
}

async function ready(): Promise<void> {
  await api("plugin", "rpc", "call", "local-voice", "prepare", "--json");
  await expect.poll(async () => (await status()).loaded, { timeout: 90_000 }).toBe(true);
}

async function idleWorkerCacheReleased(): Promise<number> {
  const warm = await status();
  expect(warm.loaded).toBe(true);

  if (warm.pid === null) throw new Error("Warm helper unavailable");
  const pid = warm.pid;
  const started = performance.now();

  await expect
    .poll(
      () => {
        try {
          process.kill(pid, 0);

          return false;
        } catch (error) {
          if (error instanceof Error && "code" in error && error.code === "ESRCH") return true;

          throw error;
        }
      },
      { timeout: 330_000, intervals: [1_000] },
    )
    .toBe(true);
  const elapsedMs = Math.round(performance.now() - started);
  expect(elapsedMs).toBeGreaterThanOrEqual(295_000);
  expect(await status()).toMatchObject({ state: "ready", loaded: false, busy: false, pid: null });

  return elapsedMs;
}

async function dictionary(value: string): Promise<void> {
  await api("plugin", "config", "local-voice", "set", "dictionary", value);
  await expect
    .poll(async () => (await status()).dictionaryCount, { timeout: 90_000 })
    .toBe(value ? value.split("\n").length : 0);
  await ready();
}

async function events(): Promise<RouteEvent[]> {
  const output: RouteEvent[] = [];
  const wrapper = z.object({ message: z.string() });

  for (const line of (await api("plugin", "logs", "local-voice", "--lines", "2000")).split("\n")) {
    if (!line) continue;
    const { message } = wrapper.parse(JSON.parse(line));

    if (!message.startsWith('{"route":')) continue;
    const parsed = eventSchema.safeParse(JSON.parse(message));

    if (parsed.success) output.push(parsed.data);
  }

  return output;
}

async function openMicrophone(fixture: string) {
  const browser = await chromium.launch({
    channel: "chrome",
    headless: true,
    args: [
      "--use-fake-ui-for-media-stream",
      "--use-fake-device-for-media-stream",
      `--use-file-for-fake-audio-capture=${resolve(fixtureRoot, fixture)}`,
    ],
  });

  const context = await browser.newContext({
    permissions: ["microphone"],
    viewport: { width: 1100, height: 850 },
  });

  const page = await context.newPage();
  await page.goto(baseURL);
  // Omnyo's interface can take several seconds to load on a busy Mac.
  await expect(page.getByRole("button", { name: "Start voice input", exact: true })).toBeVisible({
    timeout: 90_000,
  });

  return { browser, page };
}

async function capture(page: Page, durationMs: number, shortcut = false): Promise<void> {
  const stop = page.getByRole("button", { name: "Stop and add to draft", exact: true });

  if (shortcut) {
    // Plugin frontends register Control+D after Omnyo renders the composer; a loaded Mac takes seconds.
    await expect(async () => {
      if ((await page.locator("form[data-promptbox][data-promptbox-voice-active]").count()) === 0) {
        await page.locator('[contenteditable="true"]').last().focus();
        await page.keyboard.press("Control+d");
      }

      await expect(stop).toBeVisible({ timeout: 2_000 });
    }).toPass({ timeout: 30_000 });
  } else {
    await page.getByRole("button", { name: "Start voice input", exact: true }).click();
    await expect(stop).toBeVisible({ timeout: 15_000 });
  }

  await delay(durationMs);
}

async function transcribe(
  fixture: string,
  durationMs: number,
  shortcut = false,
): Promise<RunEvidence> {
  const before = (await events()).length;
  const { browser, page } = await openMicrophone(fixture);

  try {
    await capture(page, durationMs, shortcut);

    const response = page.waitForResponse(
      (response) => response.url().endsWith("/api/v1/system/voice-transcription"),
      { timeout: 60_000 },
    );

    const started = performance.now();

    if (shortcut) {
      await page.keyboard.press("Control+d");
      await expect(
        page.getByRole("button", { name: "Stop and add to draft", exact: true }),
      ).not.toBeVisible();
    } else {
      await page.getByRole("button", { name: "Stop and add to draft", exact: true }).click();
    }

    const reply = await response;
    expect(reply.ok()).toBe(true);
    const { text } = z.object({ text: z.string().min(1) }).parse(await reply.json());
    await expect(page.locator('[contenteditable="true"]').last()).toContainText(text);

    const result = {
      fixture,
      text,
      elapsedMs: Math.round(performance.now() - started),
      events: (await events()).slice(before),
    };

    const completed = result.events.find(
      (event) => event.route === "local" && event.phase === "done",
    );

    expect(completed?.audio).toMatchObject({
      decodedSampleRate: 16_000,
      decodedChannels: 1,
      nonFiniteSamples: 0,
      opusErrorCount: 0,
    });
    expect(completed?.audio?.encodedBytes).toBeGreaterThan(0);
    expect(completed?.audio?.decodedDurationMs).toBeGreaterThan(0);
    expect(completed?.audio?.decodedSamples).toBeGreaterThan(0);

    observations.push(result);

    await page.locator('[contenteditable="true"]').last().fill("");

    return result;
  } finally {
    await browser.close();
  }
}

test.beforeAll(async () => {
  const config = z
    .object({ values: z.object({ dictionary: z.string() }) })
    .parse(JSON.parse(await api("plugin", "config", "local-voice", "--json")));

  originalDictionary = config.values.dictionary;

  expect(await status()).toMatchObject({ state: "ready" });

  for (const fixture of ["english.wav", "dictionary.wav"]) {
    evidence.push({
      fixture,
      sha256: createHash("sha256")
        .update(await readFile(resolve(fixtureRoot, fixture)))
        .digest("hex"),
    });
  }

  await api("settings", "ai-services", "set", "voice", "local-voice");
  await dictionary("");
});

async function emptyTranscription(): Promise<void> {
  const recording = await readFile(resolve(fixtureRoot, "english.wav"));
  let silenced = false;

  for (let offset = 12; offset + 8 <= recording.length;) {
    const length = recording.readUInt32LE(offset + 4);
    const start = offset + 8;
    const end = start + length;
    expect(end).toBeLessThanOrEqual(recording.length);

    if (recording.toString("ascii", offset, offset + 4) === "data") {
      recording.fill(0, start, end);
      silenced = true;
    }

    offset = end + (length % 2);
  }

  expect(silenced).toBe(true);
  const before = (await events()).length;
  const { browser, page } = await openMicrophone("english.wav");

  try {
    const result = await page.evaluate(async (audio) => {
      const bytes = Uint8Array.from(atob(audio), (character) => character.charCodeAt(0));
      const form = new FormData();
      form.set("file", new File([bytes], "fixture.wav", { type: "audio/wav" }));

      const response = await fetch("/api/v1/system/voice-transcription", {
        method: "POST",
        body: form,
      });

      return { ok: response.ok, body: await response.text() };
    }, recording.toString("base64"));

    expect(result.ok).toBe(false);
    expect(result.body).toContain("Dictation by Paraspeech returned no text for this recording.");
    expect(result.body).not.toContain("heard no speech");

    const failed = (await events())
      .slice(before)
      .find((event) => event.route === "local" && event.phase === "error");

    expect(failed?.reason).toBe("empty_transcript");
    expect(failed?.audio).toMatchObject({
      decodedSampleRate: 16_000,
      decodedChannels: 1,
      nonFiniteSamples: 0,
      clippedSamples: 0,
      signalLevelBucket: 0,
      opusErrorCount: null,
    });
    expect(failed?.audio?.decodedSamples).toBeGreaterThan(0);
  } finally {
    await browser.close();
  }
}

test.afterAll(async () => {
  await dictionary(originalDictionary);
  await api("settings", "ai-services", "set", "voice", "local-voice");
  await writeFile(
    "artifacts/e2e.json",
    JSON.stringify(
      {
        time: new Date().toISOString(),
        surface: "Omnyo microphone UI, Chrome human WAV capture, real local Parakeet",
        fixtures: evidence,
        results,
        observations,
      },
      null,
      2,
    ) + "\n",
  );
});

test("1. Ctrl+D restores cold English dictation after idle eviction", async () => {
  test.setTimeout(450_000);
  const cacheReleasedMs = await idleWorkerCacheReleased();
  const local: RunEvidence[] = [];

  for (let index = 0; index < 2; index++) {
    const result = await transcribe("english.wav", 17_100, true);
    expect(normalized(result.text)).toContain("in that difference");
    expect(result.events.some((event) => event.route === "local" && event.phase === "done")).toBe(
      true,
    );

    const localStart = result.events.find(
      (event) => event.route === "local" && event.phase === "start",
    );

    const localDone = result.events.find(
      (event) => event.route === "local" && event.phase === "done",
    );

    if (!localStart || !localDone) throw new Error("Local transcription timing is missing");
    expect(localDone.elapsedMs - localStart.elapsedMs).toBeLessThanOrEqual(10_000);
    local.push(result);
  }

  const [cold, warm] = local;

  if (!cold || !warm) throw new Error("Cold and warm local results are required");
  results.push({
    case: "Cold and warm English with latency",
    runs: local,
    detail: `Idle cache released after ${cacheReleasedMs}ms; cold local ${cold.elapsedMs}ms; warm local ${warm.elapsedMs}ms`,
  });
});

test("2. dictionary changes a canonical word without adding it to ordinary speech", async () => {
  const baseline = await transcribe("dictionary.wav", 21_600);
  expect(baseline.text).toContain("Codex");
  expect(baseline.text).not.toContain("Kodex");
  await dictionary("Kodex");
  const corrected = await transcribe("dictionary.wav", 21_600);
  expect(corrected.text).toContain("Kodex");
  expect(corrected.text).not.toBe(baseline.text);
  expect(corrected.events.some((event) => event.route === "local" && event.phase === "done")).toBe(
    true,
  );
  const negative = await transcribe("english.wav", 17_100);
  expect(normalized(negative.text)).not.toContain("kodex");
  expect(normalized(negative.text)).toContain("in that difference");
  results.push({
    case: "Dictionary and ordinary speech",
    runs: [baseline, corrected, negative],
    detail: "Real empty/populated comparison and negative phrase",
  });
  await dictionary("");
});

test("3. recording and caller cancellation return promptly; the loaded helper transcribes warm", async () => {
  type CheckpointData = {
    pid?: number | null;
    elapsedMs?: number;
    events?: RouteEvent[];
    requestCount?: number;
    requestStarted?: boolean;
    engineBusy?: boolean;
    browserAborted?: boolean;
    outcome?: string;
    abortMs?: number;
  };

  const started = performance.now();
  const checkpoints: { phase: string; elapsedMs: number; data: CheckpointData | null }[] = [];
  const browserEvents: { phase: string; elapsedMs: number; aborted?: boolean }[] = [];

  const checkpoint = async (phase: string, data: CheckpointData | null = null) => {
    checkpoints.push({ phase, elapsedMs: Math.round(performance.now() - started), data });
    await writeFile(
      "artifacts/cancellation.json",
      JSON.stringify({ checkpoints, browserEvents }, null, 2) + "\n",
    );
  };

  const running = await status();
  expect(running.pid).not.toBeNull();
  await checkpoint("helper-ready", { pid: running.pid });

  if (running.pid === null) throw new Error("Helper unavailable");
  const pid = running.pid;
  let paused = false;

  try {
    await checkpoint("browser-open-start");
    const { browser, page } = await openMicrophone("english.wav");
    await checkpoint("browser-open");
    const isTranscription = (url: string) => url.endsWith("/api/v1/system/voice-transcription");
    page.on("request", (request) => {
      if (isTranscription(request.url()))
        browserEvents.push({
          phase: "request",
          elapsedMs: Math.round(performance.now() - started),
        });
    });
    page.on("requestfailed", (request) => {
      if (isTranscription(request.url()))
        browserEvents.push({
          phase: "request-failed",
          elapsedMs: Math.round(performance.now() - started),
          aborted: request.failure()?.errorText === "net::ERR_ABORTED",
        });
    });
    page.on("requestfinished", (request) => {
      if (isTranscription(request.url()))
        browserEvents.push({
          phase: "request-finished",
          elapsedMs: Math.round(performance.now() - started),
        });
    });
    const before = (await events()).length;
    let cancelled: RouteEvent[] = [];
    let abortMs = 0;

    try {
      await capture(page, 1_200);
      await page
        .getByRole("button", { name: "Cancel recording", exact: true })
        .click({ timeout: 5_000 });
      await expect(
        page.getByRole("button", { name: "Start voice input", exact: true }),
      ).toBeVisible({ timeout: 5_000 });
      await delay(500);
      await checkpoint("recording-cancelled", { requestCount: browserEvents.length });
      expect(browserEvents).toEqual([]);
      expect((await events()).slice(before).filter((event) => event.phase !== "prepared")).toEqual(
        [],
      );
      expect(await status()).toMatchObject({ loaded: true, pid });

      // A paused helper holds the decode in flight while the caller aborts.
      process.kill(pid, "SIGSTOP");
      paused = true;
      const publicAudio = (await readFile(resolve(fixtureRoot, "english.wav"))).toString("base64");

      const failed = page
        .waitForEvent("requestfailed", {
          predicate: (request) => isTranscription(request.url()),
          timeout: 60_000,
        })
        .then((request) => request.failure()?.errorText === "net::ERR_ABORTED")
        .catch(() => false);

      const upload = page
        .evaluate(async (audio) => {
          const bytes = Uint8Array.from(atob(audio), (character) => character.charCodeAt(0));
          const form = new FormData();
          form.set("file", new File([bytes], "public-english.wav", { type: "audio/wav" }));
          const controller = new AbortController();
          window.addEventListener("local-voice-abort", () => controller.abort(), { once: true });

          try {
            await fetch("/api/v1/system/voice-transcription", {
              method: "POST",
              body: form,
              signal: controller.signal,
            });

            return "response";
          } catch (error) {
            return error instanceof DOMException && error.name === "AbortError"
              ? "aborted"
              : "failed";
          }
        }, publicAudio)
        .catch(() => "browser-evaluation-failed");

      await expect
        .poll(
          async () =>
            (await events())
              .slice(before)
              .some((event) => event.route === "local" && event.phase === "start"),
          { timeout: 45_000, intervals: [25, 50] },
        )
        .toBe(true);
      await expect
        .poll(async () => (await status()).busy, { timeout: 30_000, intervals: [50, 100] })
        .toBe(true);
      await checkpoint("caller-local-start-observed", {
        requestStarted: browserEvents.some((event) => event.phase === "request"),
        engineBusy: true,
      });
      // Abort only after the plugin has started, so the server must detach from local work it began.
      const abortStarted = performance.now();
      await page.evaluate(() => window.dispatchEvent(new Event("local-voice-abort")));
      const outcome = await upload;
      const browserAborted = await failed;
      await checkpoint("browser-caller-aborted", { outcome, browserAborted });
      expect(outcome).toBe("aborted");
      expect(browserAborted).toBe(true);
      await expect
        .poll(
          async () => (await events()).slice(before).some((event) => event.route === "cancelled"),
          { timeout: 5_000, intervals: [100, 250] },
        )
        .toBe(true);
      abortMs = Math.round(performance.now() - abortStarted);
      cancelled = (await events()).slice(before);
      await checkpoint("caller-cancellation-observed", { events: cancelled, abortMs });
      expect(abortMs).toBeLessThan(5_000);
    } finally {
      if (paused) process.kill(pid, "SIGCONT");
      paused = false;
      await checkpoint("browser-close-start");
      await browser.close();
      await checkpoint("browser-closed");
    }

    await expect
      .poll(async () => (await status()).busy, { timeout: 60_000, intervals: [250, 500] })
      .toBe(false);
    const kept = await status();
    await checkpoint("helper-kept", { pid: kept.pid });
    expect(kept).toMatchObject({ loaded: true, pid });
    const recovered = await transcribe("english.wav", 17_100);
    await checkpoint("recovery-complete", {
      elapsedMs: recovered.elapsedMs,
      events: recovered.events,
    });
    expect(normalized(recovered.text)).toContain("in that difference");
    expect(
      recovered.events.some(
        (event) => event.route === "local" && event.phase === "done" && event.coldStart === false,
      ),
    ).toBe(true);
    expect(await status()).toMatchObject({ loaded: true, pid });
    await emptyTranscription();
    expect(await status()).toMatchObject({ loaded: true, pid });
    results.push({
      case: "Recording cancellation, caller abort and warm recovery",
      runs: [
        { fixture: "english.wav", text: "", elapsedMs: abortMs, events: cancelled },
        recovered,
      ],
      detail:
        "Recording Cancel sends no request; a browser caller abort during a decode yields ERR_ABORTED and a prompt server cancellation; the same helper stays loaded and transcribes the next recording warm",
    });
  } finally {
    if (paused) process.kill(pid, "SIGCONT");
    await checkpoint("plugin-reload-start");
    await api("plugin", "reload", "local-voice");
    await ready();
    await checkpoint("plugin-reloaded-ready");
  }
});
