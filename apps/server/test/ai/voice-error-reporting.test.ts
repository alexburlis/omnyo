import { afterEach, describe, expect, it, vi } from "vitest";
import * as reporting from "@omnyo/process-utils/error-reporting";
import { setAiServiceSelection } from "@omnyo/db";
import { transcribeVoiceInput } from "../../src/services/ai/voice-transcription.js";
import { registerFakeAiService } from "../helpers/ai-services.js";
import { withTestHarness } from "../helpers/test-app.js";

afterEach(() => vi.restoreAllMocks());

describe("voice terminal error reporting", () => {
  it("captures one empty result with safe operation correlation", async () => {
    const capture = vi
      .spyOn(reporting, "captureProcessError")
      .mockImplementation(() => {});

    await withTestHarness({}, async (harness) => {
      registerFakeAiService(harness.deps.aiServices, {
        id: "voice",
        pluginId: "local-voice",
        transcribe: async () => "  ",
      });
      setAiServiceSelection(harness.deps.db, "voice", {
        mode: "service",
        pluginId: "local-voice",
        serviceId: "voice",
      });
      capture.mockClear();
      const recordingId = crypto.randomUUID();
      await expect(
        transcribeVoiceInput(harness.deps, {
          file: new File(["synthetic audio"], "private-name.webm"),
          signal: new AbortController().signal,
          diagnostic: { recordingId, attempt: 2 },
        }),
      ).rejects.toMatchObject({ status: 502 });
      expect(capture).toHaveBeenCalledTimes(1);
      expect(capture).toHaveBeenCalledWith(expect.any(Error), {
        level: "error",
        stage: "request",
        diagnostic: {
          operation: "voice-transcription",
          stage: "complete",
          failureClass: "empty-result",
          outcome: "terminal",
          dependency: "provider",
          retryable: false,
          durationMs: expect.any(Number),
          operationId: recordingId,
          attempt: 2,
        },
      });
      expect(JSON.stringify(capture.mock.calls)).not.toContain("private-name");
    });
  });

  it("does not capture successful or cancelled voice work", async () => {
    const capture = vi
      .spyOn(reporting, "captureProcessError")
      .mockImplementation(() => {});

    await withTestHarness({}, async (harness) => {
      registerFakeAiService(harness.deps.aiServices, {
        id: "voice",
        pluginId: "local-voice",
        transcribe: async () => "hello",
      });
      setAiServiceSelection(harness.deps.db, "voice", {
        mode: "service",
        pluginId: "local-voice",
        serviceId: "voice",
      });
      capture.mockClear();
      await expect(
        transcribeVoiceInput(harness.deps, {
          file: new File(["synthetic audio"], "voice.webm"),
          signal: new AbortController().signal,
        }),
      ).resolves.toBe("hello");
      const controller = new AbortController();
      controller.abort();
      await expect(
        transcribeVoiceInput(harness.deps, {
          file: new File(["synthetic audio"], "voice.webm"),
          signal: controller.signal,
        }),
      ).rejects.toMatchObject({ body: { code: "cancelled" } });
      expect(capture).not.toHaveBeenCalled();
    });
  });
});
