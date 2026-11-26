import { setAiServiceSelection } from "@omnyo/db";
import type { PluginAiPrepareOptions } from "@omnyo/plugin-sdk";
import { describe, expect, it, vi } from "vitest";
import { installVoiceInputPrewarm } from "../../src/services/ai/voice-prepare.js";
import { registerFakeAiService } from "../helpers/ai-services.js";
import { readJson } from "../helpers/json.js";
import { createMockHubSocket } from "../helpers/mock-hub-socket.js";
import { seedHost, seedPrimaryHost } from "../helpers/seed.js";
import { withTestHarness, type TestAppHarness } from "../helpers/test-app.js";

async function postPrepare(harness: TestAppHarness): Promise<Response> {
  return harness.app.request("/api/v1/system/voice-transcription/prepare", {
    method: "POST",
  });
}

function deferredPrepare() {
  const calls: PluginAiPrepareOptions[] = [];
  let release: (() => void) | null = null;
  let fail: ((error: Error) => void) | null = null;

  const prepare = (options: PluginAiPrepareOptions) => {
    calls.push(options);

    return new Promise<void>((resolve, reject) => {
      release = resolve;
      fail = reject;
    });
  };

  return {
    calls,
    prepare,
    resolve: () => release?.(),
    reject: (error: Error) => fail?.(error),
  };
}

function registerVoice(
  harness: TestAppHarness,
  prepare: ((options: PluginAiPrepareOptions) => Promise<void>) | null,
) {
  const registration = registerFakeAiService(harness.deps.aiServices, {
    id: "local-voice",
    displayName: "Local Voice",
    pluginId: "local-voice-plugin",
    complete: null,
    transcribe: async () => "hello",
    prepare,
  });

  setAiServiceSelection(harness.deps.db, "voice", {
    mode: "service",
    pluginId: "local-voice-plugin",
    serviceId: "local-voice",
  });

  return registration;
}

describe("voice input prepare", () => {
  it("prepares local dictation for a saved Codex voice selection", async () => {
    await withTestHarness({}, async (harness) => {
      const prepare = vi.fn(async () => {});
      registerFakeAiService(harness.deps.aiServices, {
        id: "local-voice",
        pluginId: "local-voice",
        displayName: "Dictation by Paraspeech",
        transcribe: async () => "Local transcript",
        prepare,
      });
      setAiServiceSelection(harness.db, "voice", {
        mode: "service",
        pluginId: "provider-codex",
        serviceId: "codex",
      });

      const response = await postPrepare(harness);
      expect(response.status).toBe(200);
      await vi.waitFor(() => expect(prepare).toHaveBeenCalledTimes(1));
    });
  });

  it("starts the selected service's prepare once and answers without waiting", async () => {
    await withTestHarness({}, async (harness) => {
      const info = vi.spyOn(harness.deps.logger, "info");
      const pending = deferredPrepare();
      registerVoice(harness, pending.prepare);

      const first = await postPrepare(harness);
      expect(first.status).toBe(200);
      expect(await readJson(first)).toEqual({ ok: true });
      await vi.waitFor(() => expect(pending.calls).toHaveLength(1));
      expect(pending.calls[0]?.signal.aborted).toBe(false);

      expect((await postPrepare(harness)).status).toBe(200);
      expect(pending.calls).toHaveLength(1);

      pending.resolve();
      await vi.waitFor(() =>
        expect(info).toHaveBeenCalledWith(
          expect.objectContaining({
            task: "voice",
            pluginId: "local-voice-plugin",
            serviceId: "local-voice",
            reason: "requested",
          }),
          "Voice input prepared",
        ),
      );

      expect((await postPrepare(harness)).status).toBe(200);
      await vi.waitFor(() => expect(pending.calls).toHaveLength(2));
    });
  });

  it("does nothing for a service without the hook or when voice input is off", async () => {
    await withTestHarness({}, async (harness) => {
      const pending = deferredPrepare();
      registerVoice(harness, pending.prepare);
      setAiServiceSelection(harness.deps.db, "voice", { mode: "off" });

      expect((await postPrepare(harness)).status).toBe(200);
      expect(pending.calls).toHaveLength(0);
    });

    await withTestHarness({}, async (harness) => {
      registerVoice(harness, null);
      const response = await postPrepare(harness);
      expect(response.status).toBe(200);
      expect(await readJson(response)).toEqual({ ok: true });
    });
  });

  it("logs a failed prepare and still answers ok", async () => {
    await withTestHarness({}, async (harness) => {
      const warn = vi.spyOn(harness.deps.logger, "warn");
      const pending = deferredPrepare();
      registerVoice(harness, pending.prepare);

      const response = await postPrepare(harness);
      expect(response.status).toBe(200);
      expect(await readJson(response)).toEqual({ ok: true });

      pending.reject(new Error("model missing"));
      await vi.waitFor(() =>
        expect(warn).toHaveBeenCalledWith(
          expect.objectContaining({
            pluginId: "local-voice-plugin",
            serviceId: "local-voice",
            reason: "requested",
          }),
          "Voice input prepare failed",
        ),
      );
    });
  });

  it("prepares once for each new daemon session of the primary host", async () => {
    await withTestHarness({}, async (harness) => {
      const calls: PluginAiPrepareOptions[] = [];

      registerVoice(harness, async (options) => {
        calls.push(options);
      });

      const { hub } = harness.deps;
      const primary = seedHost(harness.deps, { name: "Mac" });
      const other = seedHost(harness.deps, { name: "Other" });
      seedPrimaryHost(harness.deps, primary.id);
      const prewarm = installVoiceInputPrewarm(harness.deps);

      try {
        expect(calls).toHaveLength(0);

        hub.notifyHost(primary.id, ["host-connected"]);
        await Promise.resolve();
        expect(calls).toHaveLength(0);

        hub.registerDaemon("other-session", other.id, createMockHubSocket());
        await Promise.resolve();
        expect(calls).toHaveLength(0);

        hub.registerDaemon("mac-session-1", primary.id, createMockHubSocket());
        await vi.waitFor(() => expect(calls).toHaveLength(1));

        hub.notifyHost(primary.id, ["host-connected"]);
        await Promise.resolve();
        expect(calls).toHaveLength(1);

        hub.registerDaemon("mac-session-2", primary.id, createMockHubSocket());
        await vi.waitFor(() => expect(calls).toHaveLength(2));
      } finally {
        prewarm.stop();
      }

      hub.registerDaemon("mac-session-3", primary.id, createMockHubSocket());
      await Promise.resolve();
      expect(calls).toHaveLength(2);
    });
  });

  it("prepares at install when the primary host is already connected", async () => {
    await withTestHarness({}, async (harness) => {
      const calls: PluginAiPrepareOptions[] = [];

      registerVoice(harness, async (options) => {
        calls.push(options);
      });

      const primary = seedHost(harness.deps, { name: "Mac" });
      seedPrimaryHost(harness.deps, primary.id);
      harness.deps.hub.registerDaemon(
        "mac-session",
        primary.id,
        createMockHubSocket(),
      );

      const prewarm = installVoiceInputPrewarm(harness.deps);

      try {
        await vi.waitFor(() => expect(calls).toHaveLength(1));
        harness.deps.hub.notifyHost(primary.id, ["host-connected"]);
        await Promise.resolve();
        expect(calls).toHaveLength(1);
      } finally {
        prewarm.stop();
      }
    });
  });

  it("aborts a prepare it started when stopped", async () => {
    await withTestHarness({}, async (harness) => {
      const pending = deferredPrepare();
      registerVoice(harness, pending.prepare);
      const primary = seedHost(harness.deps, { name: "Mac" });
      seedPrimaryHost(harness.deps, primary.id);
      const prewarm = installVoiceInputPrewarm(harness.deps);

      harness.deps.hub.registerDaemon(
        "mac-session",
        primary.id,
        createMockHubSocket(),
      );
      await vi.waitFor(() => expect(pending.calls).toHaveLength(1));
      prewarm.stop();
      expect(pending.calls[0]?.signal.aborted).toBe(true);
    });
  });
});
