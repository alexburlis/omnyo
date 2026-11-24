import {
  voiceDiagnosticSchema,
  type VoiceDiagnostic,
} from "@omnyo/server-contract";
import { apiClient, toRelativeUrl } from "./api-server";
import { appSurfaceRequestInit } from "./app-surface";

const STORAGE_KEY = "omnyo.voiceInput.pendingDiagnostics.v1";

const LEGACY_STORAGE_KEY = "bb.voiceInput.pendingDiagnostics.v1";

const MAX_AGE_MS = 24 * 60 * 60 * 1000;

const MAX_REPORTS = 20;

let sending: Promise<void> | null = null;

let enabled = false;

let policyGeneration = 0;

let activeRequest: AbortController | null = null;

export function setVoiceDiagnosticsEnabled(value: boolean): void {
  if (enabled === value && value) return;
  policyGeneration += 1;
  activeRequest?.abort();
  activeRequest = null;
  save([]);

  try {
    localStorage.removeItem(LEGACY_STORAGE_KEY);
  } catch {}

  enabled = value;
}

let initialized = false;

let memory: VoiceDiagnostic[] = [];

function pending(): VoiceDiagnostic[] {
  const now = Date.now();

  return memory.filter(
    (item) => item.occurredAt <= now && now - item.occurredAt < MAX_AGE_MS,
  );
}

function save(reports: VoiceDiagnostic[]): void {
  memory = reports.slice(-MAX_REPORTS);

  try {
    if (reports.length)
      localStorage.setItem(
        STORAGE_KEY,
        JSON.stringify(reports.slice(-MAX_REPORTS)),
      );
    else localStorage.removeItem(STORAGE_KEY);
  } catch {}
}

function key(report: VoiceDiagnostic): string {
  return `${report.recordingId}:${report.attempt}:${report.outcome}:${report.stage}:${report.cause}`;
}

export function flushVoiceDiagnostics(): Promise<void> {
  if (!enabled) {
    setVoiceDiagnosticsEnabled(false);

    return Promise.resolve();
  }

  if (sending) return sending;
  const generation = policyGeneration;
  sending = (async () => {
    let reports = pending();
    save(reports);

    for (let sent = 0; reports.length && sent < MAX_REPORTS; sent += 1) {
      const report = reports[0];

      if (!report || !enabled || generation !== policyGeneration) break;
      const controller = new AbortController();
      activeRequest = controller;

      try {
        const response = await fetch(
          toRelativeUrl(apiClient.system["voice-diagnostic"].$url()),
          appSurfaceRequestInit({
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(report),
            signal: AbortSignal.any([
              controller.signal,
              AbortSignal.timeout(5000),
            ]),
          }),
        );

        if (!response.ok) break;
        const acknowledgement: unknown = await response.json();

        if (
          typeof acknowledgement !== "object" ||
          acknowledgement === null ||
          !("ok" in acknowledgement) ||
          acknowledgement.ok !== true
        )
          break;
      } catch {
        break;
      }

      if (!enabled || generation !== policyGeneration) break;
      activeRequest = null;
      reports = pending().filter((item) => key(item) !== key(report));
      save(reports);
    }
  })().finally(() => {
    sending = null;
    activeRequest = null;

    if (enabled && generation !== policyGeneration && pending().length)
      void flushVoiceDiagnostics();
  });

  return sending;
}

export function initializeVoiceDiagnostics(): void {
  if (!initialized) {
    initialized = true;
    window.addEventListener("online", () => {
      void flushVoiceDiagnostics();
    });
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible") void flushVoiceDiagnostics();
    });
  }

  void flushVoiceDiagnostics();
}

export function voiceClientIdentity() {
  const asset = document.querySelector<HTMLScriptElement>(
    'script[type="module"][src]',
  )?.src;

  const basename = asset
    ? new URL(asset).pathname.split("/").at(-1)
    : undefined;

  return {
    clientBundle:
      basename && /^[a-zA-Z0-9_-]{1,96}\.js$/u.test(basename) ? basename : null,
    iosVersion:
      /(?:iPhone|iPad|iPod).*?OS (\d{1,3}(?:_\d{1,3}){0,2})/u
        .exec(navigator.userAgent)?.[1]
        ?.replaceAll("_", ".") ?? null,
    webkitVersion:
      /AppleWebKit\/(\d{1,4}(?:\.\d{1,4}){0,3})/u.exec(
        navigator.userAgent,
      )?.[1] ?? null,
  };
}

export function reportVoiceDiagnostic(report: VoiceDiagnostic): void {
  if (!enabled) return;
  const parsed = voiceDiagnosticSchema.safeParse(report);

  if (!parsed.success) return;
  save([...pending().filter((item) => key(item) !== key(report)), parsed.data]);
  void flushVoiceDiagnostics();
}

export function voiceHttpStatus(error: unknown): number | null {
  if (typeof error !== "object" || error === null || !("status" in error))
    return null;
  const status = error.status;

  return typeof status === "number" &&
    Number.isInteger(status) &&
    status >= 100 &&
    status <= 599
    ? status
    : null;
}

export function voiceCaptureCause(error: unknown): VoiceDiagnostic["cause"] {
  if (!(error instanceof DOMException)) return "capture_failed";

  switch (error.name) {
    case "NotAllowedError":
    case "SecurityError":
      return "permission_denied";
    case "NotFoundError":
    case "DevicesNotFoundError":
      return "microphone_missing";
    case "NotReadableError":
    case "TrackStartError":
      return "microphone_busy";
    case "AbortError":
      return "capture_aborted";
    default:
      return "capture_failed";
  }
}
