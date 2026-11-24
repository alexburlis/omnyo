// @vitest-environment jsdom

import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { VoiceDiagnostic } from "@omnyo/server-contract";

vi.mock("./api-server", () => ({
  apiClient: {
    system: {
      "voice-diagnostic": {
        $url: () =>
          new URL("https://omnyo.example/api/v1/system/voice-diagnostic"),
      },
    },
  },
  toRelativeUrl: (url: URL) => url.pathname,
}));

const storageKey = "omnyo.voiceInput.pendingDiagnostics.v1";

const legacyStorageKey = "bb.voiceInput.pendingDiagnostics.v1";

function report(overrides: Partial<VoiceDiagnostic> = {}): VoiceDiagnostic {
  return {
    recordingId: crypto.randomUUID(),
    attempt: 1,
    occurredAt: Date.now(),
    clientBundle: "index-old123.js",
    iosVersion: "27.0",
    webkitVersion: "605.1.15",
    outcome: "failed",
    stage: "request",
    cause: "http_error",
    httpStatus: 502,
    elapsedMs: 1500,
    durationMs: 1200,
    audioBytes: 2000,
    chunkCount: 5,
    mime: "mp4",
    recorderState: "inactive",
    audioContextState: "running",
    trackState: "live",
    trackMuted: false,
    silent: false,
    wasHidden: false,
    ...overrides,
  };
}

beforeEach(() => {
  vi.resetModules();
  localStorage.clear();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  document.head.innerHTML = "";
});

it("retires a failed upload after a fresh uploader starts with unknown choice", async () => {
  const fetcher = vi
    .fn()
    .mockRejectedValueOnce(new TypeError("private upstream detail"));

  vi.stubGlobal("fetch", fetcher);
  const first = await import("./voice-diagnostics");
  first.setVoiceDiagnosticsEnabled(true);
  const failure = report({ occurredAt: Date.now() - 1000 });
  first.reportVoiceDiagnostic(failure);
  await first.flushVoiceDiagnostics();
  expect(JSON.parse(localStorage.getItem(storageKey) ?? "[]")).toEqual([
    failure,
  ]);
  fetcher.mockImplementationOnce(
    async () => new Response("login page", { status: 200 }),
  );
  await first.flushVoiceDiagnostics();
  expect(JSON.parse(localStorage.getItem(storageKey) ?? "[]")).toEqual([
    failure,
  ]);
  vi.resetModules();
  document.head.innerHTML =
    '<script type="module" src="https://omnyo.example/assets/index-new456.js"></script>';
  fetcher.mockImplementation(async () => Response.json({ ok: true }));
  const next = await import("./voice-diagnostics");
  await next.flushVoiceDiagnostics();
  next.setVoiceDiagnosticsEnabled(true);
  await next.flushVoiceDiagnostics();
  expect(fetcher).toHaveBeenCalledTimes(2);
  expect(next.voiceClientIdentity().clientBundle).toBe("index-new456.js");
  expect(localStorage.getItem(storageKey)).toBeNull();
});

it("caps pending diagnostics, expires old reports, and rejects content-bearing extras", async () => {
  vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("offline")));
  const diagnostics = await import("./voice-diagnostics");
  diagnostics.setVoiceDiagnosticsEnabled(true);
  diagnostics.reportVoiceDiagnostic(
    report({ occurredAt: Date.now() - 86_400_001 }),
  );

  for (let index = 0; index < 25; index += 1)
    diagnostics.reportVoiceDiagnostic(report());
  await diagnostics.flushVoiceDiagnostics();
  const pending = JSON.parse(localStorage.getItem(storageKey) ?? "[]");
  expect(pending).toHaveLength(20);
  expect(
    pending.every(
      (item: VoiceDiagnostic) => Date.now() - item.occurredAt < 86_400_000,
    ),
  ).toBe(true);
  diagnostics.reportVoiceDiagnostic({
    ...report(),
    ...{ transcript: "private words" },
  });
  expect(localStorage.getItem(storageKey)).not.toContain("private words");
});

it("sends diagnostics when persistent storage is unavailable without creating recursive reports", async () => {
  const fetcher = vi
    .fn()
    .mockImplementation(async () => Response.json({ ok: true }));

  vi.stubGlobal("fetch", fetcher);
  vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
    throw new Error("blocked");
  });
  vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
    throw new Error("blocked");
  });
  const diagnostics = await import("./voice-diagnostics");
  diagnostics.setVoiceDiagnosticsEnabled(true);
  const failure = report();
  diagnostics.reportVoiceDiagnostic(failure);
  await diagnostics.flushVoiceDiagnostics();
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(JSON.parse(fetcher.mock.calls[0]?.[1].body)).toEqual(failure);
});

it("retires both persisted queues while choice is unknown", async () => {
  localStorage.setItem(legacyStorageKey, JSON.stringify([report()]));
  localStorage.setItem(storageKey, JSON.stringify([report()]));
  const fetcher = vi.fn();
  vi.stubGlobal("fetch", fetcher);
  const diagnostics = await import("./voice-diagnostics");
  diagnostics.reportVoiceDiagnostic(report());
  await diagnostics.flushVoiceDiagnostics();
  diagnostics.setVoiceDiagnosticsEnabled(true);
  await diagnostics.flushVoiceDiagnostics();
  expect(fetcher).not.toHaveBeenCalled();
  expect(localStorage.getItem(legacyStorageKey)).toBeNull();
  expect(localStorage.getItem(storageKey)).toBeNull();
});

it("aborts and retires queued reports on withdrawal without replaying them after regrant", async () => {
  let release: (() => void) | undefined;

  const fetcher = vi.fn(
    (_url: string, init: RequestInit) =>
      new Promise<Response>((resolve) => {
        release = () => resolve(Response.json({ ok: true }));
        expect(init.signal?.aborted).toBe(false);
      }),
  );

  vi.stubGlobal("fetch", fetcher);
  const diagnostics = await import("./voice-diagnostics");
  diagnostics.setVoiceDiagnosticsEnabled(true);
  diagnostics.reportVoiceDiagnostic(report());
  const draining = diagnostics.flushVoiceDiagnostics();
  const signal = fetcher.mock.calls[0]?.[1].signal;
  diagnostics.reportVoiceDiagnostic(report());
  diagnostics.setVoiceDiagnosticsEnabled(false);
  expect(signal?.aborted).toBe(true);
  expect(localStorage.getItem(storageKey)).toBeNull();
  diagnostics.reportVoiceDiagnostic(report());
  diagnostics.setVoiceDiagnosticsEnabled(true);
  release?.();
  await draining;
  await diagnostics.flushVoiceDiagnostics();
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(localStorage.getItem(storageKey)).toBeNull();
});
