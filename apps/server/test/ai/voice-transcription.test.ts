import { Buffer } from "node:buffer";
import {
  getAppSettings,
  setAppSettings,
  setAiServiceSelection,
} from "@omnyo/db";
import { describe, expect, it, vi } from "vitest";
import {
  resolveVoiceTranscriptionEnabled,
  transcribeVoiceInput,
} from "../../src/services/ai/voice-transcription.js";
import { registerFakeAiService } from "../helpers/ai-services.js";
import type { VoiceDiagnostic } from "@omnyo/server-contract";
import { withTestHarness, type TestAppHarness } from "../helpers/test-app.js";

function voiceFile(size = 5): File {
  return new File([Buffer.alloc(size, 1)], "prompt.webm", {
    type: "audio/webm",
  });
}

function registerCodexVoice(
  harness: TestAppHarness,
  transcribe: (audio: File) => Promise<string>,
) {
  return registerFakeAiService(harness.deps.aiServices, {
    id: "codex",
    pluginId: "provider-codex",
    builtin: true,
    transcribe,
  });
}

async function postVoice(
  harness: TestAppHarness,
  file: File,
  prompt?: string,
): Promise<Response> {
  const form = new FormData();
  form.set("file", file);

  if (prompt !== undefined) form.set("prompt", prompt);

  return harness.app.request("/api/v1/system/voice-transcription", {
    body: form,
    method: "POST",
  });
}

describe("voice transcription", () => {
  it("logs allowlisted client failures and rejects content-bearing or invalid diagnostic fields", async () => {
    await withTestHarness({}, async (harness) => {
      const warn = vi.spyOn(harness.deps.logger, "warn");

      const diagnostic: VoiceDiagnostic = {
        recordingId: crypto.randomUUID(),
        attempt: 2,
        occurredAt: Date.now() - 1000,
        clientBundle: "index-old123.js",
        iosVersion: "27.0",
        webkitVersion: "605.1.15",
        outcome: "failed",
        stage: "request",
        cause: "http_error",
        httpStatus: 502,
        elapsedMs: 2000,
        durationMs: 1400,
        audioBytes: 3000,
        chunkCount: 6,
        mime: "mp4",
        recorderState: "inactive",
        audioContextState: "interrupted",
        trackState: "live",
        trackMuted: false,
        silent: false,
        wasHidden: true,
      };

      const post = (body: unknown) =>
        harness.app.request("/api/v1/system/voice-diagnostic", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-omnyo-app-surface": "mobile",
          },
          body: JSON.stringify(body),
        });

      expect((await post(diagnostic)).status).toBe(200);
      expect(warn).toHaveBeenCalledWith(
        expect.objectContaining(diagnostic),
        "Voice input diagnostic",
      );
      warn.mockClear();
      setAppSettings(harness.db, {
        ...getAppSettings(harness.db),
        crashReportsEnabled: false,
      });
      expect((await post(diagnostic)).status).toBe(200);
      expect(warn).not.toHaveBeenCalled();

      registerFakeAiService(harness.deps.aiServices, {
        id: "local-choice-test",
        pluginId: "local-voice",
        transcribe: async () => "Local recording still works",
      });

      setAiServiceSelection(harness.db, "voice", {
        mode: "service",
        pluginId: "local-voice",
        serviceId: "local-choice-test",
      });
      const transcription = await postVoice(harness, voiceFile());
      expect(transcription.status).toBe(200);
      expect(await transcription.json()).toMatchObject({
        text: "Local recording still works",
      });

      for (const field of [
        "audio",
        "transcript",
        "prompt",
        "errorMessage",
        "deviceId",
        "url",
        "userAgent",
      ]) {
        expect(
          (await post({ ...diagnostic, [field]: "private content" })).status,
        ).toBe(400);
      }

      expect(
        (await post({ ...diagnostic, cause: "arbitrary provider text" }))
          .status,
      ).toBe(400);
      expect(
        (
          await post({
            ...diagnostic,
            clientBundle: "https://private.example/path",
          })
        ).status,
      ).toBe(400);
      expect(warn).not.toHaveBeenCalledWith(
        expect.anything(),
        "Voice input diagnostic",
      );
    });
  });

  it("executes voice despite advisory not-ready status, including an immediate retry", async () => {
    await withTestHarness({}, async (harness) => {
      const service = registerFakeAiService(harness.deps.aiServices, {
        id: "local-voice",
        pluginId: "local-voice",
        status: async () => ({ ready: false, message: "Not responding" }),
        transcribe: async () => "Recovered speech",
      });

      setAiServiceSelection(harness.deps.db, "voice", {
        mode: "service",
        pluginId: "local-voice",
        serviceId: "local-voice",
      });
      await harness.deps.aiServices.status({
        pluginId: "local-voice",
        serviceId: "local-voice",
      });

      for (let attempt = 0; attempt < 2; attempt += 1) {
        const response = await postVoice(harness, voiceFile());
        expect(response.status).toBe(200);
        await expect(response.json()).resolves.toEqual({
          text: "Recovered speech",
        });
      }

      expect(service.transcribeCalls).toHaveLength(2);
    });
  });

  it("rejects whitespace-only service results instead of returning empty success", async () => {
    await withTestHarness({}, async (harness) => {
      registerCodexVoice(harness, async () => "  \n ");
      const response = await postVoice(harness, voiceFile());
      expect(response.status).toBe(502);
      await expect(response.json()).resolves.toMatchObject({
        code: "provider_rpc_error",
      });
    });
  });

  it("correlates provider failures with the recording attempt and rejects invalid correlation input", async () => {
    await withTestHarness({}, async (harness) => {
      const warn = vi.spyOn(harness.deps.logger, "warn");

      const service = registerCodexVoice(harness, async () => {
        throw new Error("Decode unavailable");
      });

      const recordingId = crypto.randomUUID();
      const body = new FormData();
      body.set("file", voiceFile());
      body.set("recordingId", recordingId);
      body.set("attempt", "2");

      const response = await harness.app.request(
        "/api/v1/system/voice-transcription",
        { method: "POST", body },
      );

      expect(response.status).toBe(502);
      expect(warn).toHaveBeenCalledWith(
        expect.objectContaining({ recordingId, attempt: 2 }),
        "Voice transcription failed",
      );
      body.set("recordingId", "private arbitrary text");
      expect(
        (
          await harness.app.request("/api/v1/system/voice-transcription", {
            method: "POST",
            body,
          })
        ).status,
      ).toBe(400);
      expect(service.transcribeCalls).toHaveLength(1);
    });
  });

  it("rejects empty and oversized audio before calling a service", async () => {
    await withTestHarness({}, async (harness) => {
      const codex = registerCodexVoice(harness, async () => "unused");

      const empty = await postVoice(harness, voiceFile(0));
      expect(empty.status).toBe(400);
      await expect(empty.json()).resolves.toMatchObject({
        code: "invalid_request",
        message: "Audio file must not be empty",
      });
      const huge = await postVoice(harness, voiceFile(25 * 1024 * 1024 + 1));
      expect(huge.status).toBe(400);
      expect(codex.transcribeCalls).toHaveLength(0);
    });
  });

  it("passes the audio file and trimmed hint to the selected service", async () => {
    await withTestHarness({}, async (harness) => {
      const codex = registerCodexVoice(harness, async () => "  hello there \n");

      const response = await postVoice(
        harness,
        voiceFile(),
        "  Omnyo, Codex  ",
      );

      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toEqual({ text: "hello there" });
      expect(codex.transcribeCalls).toHaveLength(1);
      expect(codex.transcribeCalls[0]?.audio.name).toBe("prompt.webm");
      expect(codex.transcribeCalls[0]?.options.hint).toBe("Omnyo, Codex");
    });
  });

  it("maps outcomes to API errors", async () => {
    await withTestHarness({}, async (harness) => {
      await expect(
        transcribeVoiceInput(harness.deps, {
          file: voiceFile(),
          signal: new AbortController().signal,
        }),
      ).rejects.toMatchObject({
        status: 501,
        body: { code: "not_configured" },
      });

      registerCodexVoice(harness, async () => {
        throw new Error("Codex rejected the audio");
      });
      await expect(
        transcribeVoiceInput(harness.deps, {
          file: voiceFile(),
          signal: new AbortController().signal,
        }),
      ).rejects.toMatchObject({
        status: 502,
        body: { code: "provider_rpc_error" },
      });

      setAiServiceSelection(harness.deps.db, "voice", { mode: "off" });
      await expect(
        transcribeVoiceInput(harness.deps, {
          file: voiceFile(),
          signal: new AbortController().signal,
        }),
      ).rejects.toMatchObject({ status: 501 });
    });
  });

  it("aborts the service's signal when the request is cancelled", async () => {
    await withTestHarness({}, async (harness) => {
      const controller = new AbortController();
      let serviceSignal: AbortSignal | undefined;
      registerFakeAiService(harness.deps.aiServices, {
        id: "codex",
        pluginId: "provider-codex",
        builtin: true,
        transcribe: (_audio, { signal }) => {
          serviceSignal = signal;

          return new Promise<string>(() => undefined);
        },
      });

      const pending = transcribeVoiceInput(harness.deps, {
        file: voiceFile(),
        signal: controller.signal,
      });

      await vi.waitFor(() => expect(serviceSignal).toBeDefined());
      controller.abort();

      await expect(pending).rejects.toMatchObject({
        status: 400,
        body: { code: "cancelled" },
      });
      expect(serviceSignal?.aborted).toBe(true);
    });
  });

  it("enables the microphone only when the voice task has a ready service", async () => {
    await withTestHarness({}, async (harness) => {
      expect(resolveVoiceTranscriptionEnabled(harness.deps)).toBe(false);
      registerCodexVoice(harness, async () => "hi");
      await harness.deps.aiServices.status({
        pluginId: "provider-codex",
        serviceId: "codex",
      });
      expect(resolveVoiceTranscriptionEnabled(harness.deps)).toBe(true);
      setAiServiceSelection(harness.deps.db, "voice", { mode: "off" });
      expect(resolveVoiceTranscriptionEnabled(harness.deps)).toBe(false);
    });
  });
});
