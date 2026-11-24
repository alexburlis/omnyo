import { createMicrophoneRecordingStream } from "@/lib/microphone-recording-stream";
import { useCallback, useEffect, useRef, useState } from "react";
import { useMicrophoneSignal } from "./useMicrophoneSignal";
import { useAudioInputDevices } from "./useAudioInputDevices";
import { appToast } from "@/components/ui/app-toast";
import { downloadBlob } from "@/lib/download-blob";
import type { VoiceDiagnostic } from "@omnyo/server-contract";
import {
  initializeVoiceDiagnostics,
  reportVoiceDiagnostic,
  voiceClientIdentity,
  voiceCaptureCause,
  voiceHttpStatus,
} from "@/lib/voice-diagnostics";
import {
  requestAudioInputStream,
  useAudioInputDevicePreferenceValue,
} from "@/lib/audio-input-device-preference";
import {
  isDocumentVisible,
  subscribeToDocumentVisibility,
} from "@/lib/document-visibility";
import {
  readVoiceSupportEnvironment,
  resolveVoiceSupport,
  voiceUnsupportedMessage,
  type VoiceUnsupportedReason,
} from "./voice-input-support";

type VoiceInputState =
  | "idle"
  | "starting"
  | "recording"
  | "transcribing"
  | "error";

interface UseVoiceInputOptions {
  backgroundTranscription?: boolean;
  onTranscript: (transcript: string) => void | Promise<void>;
  onTranscribe: (args: {
    file: File;
    promptContext?: string;
    signal?: AbortSignal;
    recordingId: string;
    attempt: number;
  }) => Promise<string>;
  getPromptContext?: () => string | undefined;
  onPrepare?: () => void;
}

interface VoiceRecording {
  snapshot(): void;
  background: boolean;
  chunks: Blob[];
  startedAtMs: number | null;
  promptContext: string | undefined;
  shouldTranscribe: boolean;
  accepted: boolean;
  onTranscript: UseVoiceInputOptions["onTranscript"];
  onTranscriptionError: (() => void) | undefined;
  onCaptureReleased: (() => void) | undefined;
  progressToast: boolean;
  previousDelivery: Promise<void>;
  releaseDelivery: (() => void) | null;
}

const MIN_RECORDING_DURATION_MS = 1_000;

const CHUNK_TIMESLICE_MS = 250;

const HTML_DOCUMENT_PATTERN = /<!doctype html|<html[\s>]/i;

function createVoiceTrace() {
  const started = Date.now();

  const report: VoiceDiagnostic = {
    recordingId: crypto.randomUUID(),
    attempt: 1,
    occurredAt: started,
    ...voiceClientIdentity(),
    outcome: "failed",
    stage: "starting",
    cause: "capture_failed",
    httpStatus: null,
    elapsedMs: 0,
    durationMs: 0,
    audioBytes: 0,
    chunkCount: 0,
    mime: "none",
    recorderState: "unknown",
    audioContextState: "unknown",
    trackState: "unknown",
    trackMuted: null,
    silent: false,
    wasHidden: !isDocumentVisible(),
  };

  return { report, started, failed: false };
}

type VoiceTrace = ReturnType<typeof createVoiceTrace>;

function emitVoiceDiagnostic(
  trace: VoiceTrace,
  stage: VoiceDiagnostic["stage"],
  cause: VoiceDiagnostic["cause"],
  error?: unknown,
): void {
  if (cause !== "recovered") trace.failed = true;
  reportVoiceDiagnostic({
    ...trace.report,
    occurredAt: Date.now(),
    stage,
    cause,
    outcome: cause === "recovered" ? "recovered" : "failed",
    httpStatus: voiceHttpStatus(error),
    elapsedMs: Math.min(86_400_000, Math.max(0, Date.now() - trace.started)),
  });
}

function normalizeTranscript(rawText: string): string {
  return rawText.replace(/\s+/g, " ").trim();
}

function sanitizeErrorMessage(raw: string): string | null {
  let normalized = raw.replace(/\s+/g, " ").trim();

  if (normalized.length === 0) {
    return null;
  }

  const htmlDocumentMatch = normalized.search(HTML_DOCUMENT_PATTERN);

  if (htmlDocumentMatch >= 0) {
    normalized = normalized.slice(0, htmlDocumentMatch).trim();
  }

  if (normalized.length === 0) {
    return null;
  }

  normalized = normalized.replace(/^HTTP\s+\d{3}:\s*/i, "").trim();

  if (normalized.length === 0) {
    return null;
  }

  return normalized;
}

function resolveRecordingErrorMessage(
  error: unknown,
  hasPreferredAudioInput = false,
): string {
  if (error instanceof DOMException) {
    switch (error.name) {
      case "NotAllowedError":
      case "SecurityError":
        return "Microphone permission denied";
      case "NotFoundError":
      case "DevicesNotFoundError":
        return hasPreferredAudioInput
          ? "Selected microphone was not found"
          : "No microphone was found";
      case "NotReadableError":
      case "TrackStartError":
        return "Microphone is unavailable or already in use";
      case "AbortError":
        return "Voice capture was aborted";
      default:
        return "Failed to start voice recording";
    }
  }

  if (error instanceof Error && error.message.trim().length > 0) {
    const message = sanitizeErrorMessage(error.message);

    if (message) {
      return message;
    }
  }

  return "Voice input failed";
}

function resolvePreferredAudioMimeType(): string | null {
  if (typeof MediaRecorder === "undefined") return null;
  const candidates = ["audio/webm", "audio/mp4", "audio/ogg"];

  for (const candidate of candidates) {
    if (MediaRecorder.isTypeSupported(candidate)) {
      return candidate;
    }
  }

  return null;
}

function createRecordingFile(audioBlob: Blob, mimeType: string): File {
  const extension = mimeType.includes("ogg")
    ? "ogg"
    : mimeType.includes("mp4")
      ? "mp4"
      : "webm";

  return new File([audioBlob], `recording.${extension}`, {
    type: mimeType,
  });
}

export function useVoiceInput(options: UseVoiceInputOptions) {
  const preferredAudioInputDeviceId = useAudioInputDevicePreferenceValue();

  const {
    devices,
    hasDeviceAccess,
    refresh: refreshDevices,
  } = useAudioInputDevices();

  const [captureError, setCaptureError] = useState<string | null>(null);
  const traceRef = useRef<VoiceTrace | null>(null);

  const recordingStreamRef = useRef<ReturnType<
    typeof createMicrophoneRecordingStream
  > | null>(null);

  const deviceRequestRef = useRef(0);
  const startingRef = useRef(false);
  const recordingPreferenceRef = useRef(preferredAudioInputDeviceId);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const recordingRef = useRef<VoiceRecording | null>(null);
  const stoppedRecordingRef = useRef<VoiceRecording | null>(null);
  const deliveryTailRef = useRef(Promise.resolve());
  const transcriptionAbortRef = useRef<AbortController | null>(null);
  const wakeLockSentinelRef = useRef<WakeLockSentinel | null>(null);
  const wakeLockRequestRef = useRef<Promise<void> | null>(null);
  const shouldHoldWakeLockRef = useRef(false);

  const [state, setState] = useState<VoiceInputState>("idle");
  const [isSupported, setIsSupported] = useState(false);

  const [unsupportedReason, setUnsupportedReason] =
    useState<VoiceUnsupportedReason | null>("unsupported-browser");

  const [stream, setStream] = useState<MediaStream | null>(null);

  const { silent } = useMicrophoneSignal(stream, false);
  const silentRef = useRef(silent);
  silentRef.current = silent;

  useEffect(() => {
    initializeVoiceDiagnostics();
  }, []);

  useEffect(() => {
    setCaptureError(null);
  }, [preferredAudioInputDeviceId]);

  useEffect(() => {
    if (!stream) return;
    const tracks = stream.getAudioTracks();

    const update = () => {
      setCaptureError(
        tracks.some((track) => track.readyState === "ended")
          ? "Microphone disconnected during recording. Choose another microphone."
          : tracks.some((track) => track.muted)
            ? "Microphone is not providing audio. Check your microphone or choose another."
            : null,
      );
    };

    update();

    for (const track of tracks) {
      track.addEventListener("mute", update);
      track.addEventListener("unmute", update);
      track.addEventListener("ended", update);
    }

    return () => {
      for (const track of tracks) {
        track.removeEventListener("mute", update);
        track.removeEventListener("unmute", update);
        track.removeEventListener("ended", update);
      }
    };
  }, [stream]);

  const showError = useCallback((message: string) => {
    setState("error");
    appToast.error("Voice input failed", { description: message });
  }, []);

  const stopMediaStream = useCallback(() => {
    deviceRequestRef.current += 1;
    recordingStreamRef.current?.close();
    recordingStreamRef.current = null;
    const stream = streamRef.current;

    if (!stream) return;
    stream.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    setStream(null);
  }, []);

  const switchMicrophone = useCallback(
    async (deviceId: string | null) => {
      const recordingStream = recordingStreamRef.current;

      if (!recordingStream) return;
      const request = ++deviceRequestRef.current;

      try {
        const next = await requestAudioInputStream(
          navigator.mediaDevices,
          deviceId,
        );

        if (
          deviceRequestRef.current !== request ||
          recordingStreamRef.current !== recordingStream
        ) {
          next.getTracks().forEach((track) => track.stop());

          return;
        }

        try {
          recordingStream.replace(next);
        } catch (error) {
          next.getTracks().forEach((track) => track.stop());
          throw error;
        }

        const previous = streamRef.current;
        streamRef.current = next;
        setStream(next);
        previous?.getTracks().forEach((track) => track.stop());
        setCaptureError(null);
        void refreshDevices();
      } catch (error) {
        if (
          deviceRequestRef.current === request &&
          recordingStreamRef.current === recordingStream
        ) {
          setCaptureError(resolveRecordingErrorMessage(error));
        }
      }
    },
    [refreshDevices],
  );

  useEffect(() => {
    if (state !== "recording" || !stream) return;

    const recover = () => {
      if (!recordingStreamRef.current) return;
      setCaptureError(
        "Microphone disconnected. Switching to an available microphone…",
      );
      void switchMicrophone(null);
    };

    const tracks = stream.getAudioTracks();

    for (const track of tracks) track.addEventListener("ended", recover);

    return () => {
      for (const track of tracks) track.removeEventListener("ended", recover);
    };
  }, [state, stream, switchMicrophone]);

  useEffect(() => {
    if (
      state === "recording" &&
      recordingPreferenceRef.current !== preferredAudioInputDeviceId
    ) {
      recordingPreferenceRef.current = preferredAudioInputDeviceId;
      void switchMicrophone(preferredAudioInputDeviceId);
    }
  }, [state, preferredAudioInputDeviceId, switchMicrophone]);

  const requestRecordingWakeLock = useCallback(() => {
    if (
      typeof window === "undefined" ||
      typeof navigator === "undefined" ||
      typeof document === "undefined" ||
      !("wakeLock" in navigator) ||
      window.isSecureContext === false ||
      document.visibilityState !== "visible"
    ) {
      return;
    }

    const wakeLock = navigator.wakeLock;

    if (!wakeLock) {
      return;
    }

    const currentSentinel = wakeLockSentinelRef.current;

    if (currentSentinel && !currentSentinel.released) {
      return;
    }

    if (wakeLockRequestRef.current) {
      return;
    }

    wakeLockRequestRef.current = wakeLock
      .request("screen")
      .then((sentinel) => {
        if (!shouldHoldWakeLockRef.current) {
          if (!sentinel.released) {
            void sentinel.release().catch(() => {});
          }

          return;
        }

        wakeLockSentinelRef.current = sentinel;
        sentinel.addEventListener("release", () => {
          if (wakeLockSentinelRef.current === sentinel) {
            wakeLockSentinelRef.current = null;
          }
        });
      })
      .catch(() => {})
      .finally(() => {
        wakeLockRequestRef.current = null;
      });
  }, []);

  const releaseRecordingWakeLock = useCallback(() => {
    shouldHoldWakeLockRef.current = false;

    const sentinel = wakeLockSentinelRef.current;
    wakeLockSentinelRef.current = null;

    if (!sentinel || sentinel.released) {
      return;
    }

    void sentinel.release().catch(() => {});
  }, []);

  useEffect(() => {
    const support = resolveVoiceSupport(readVoiceSupportEnvironment());
    setIsSupported(support.isSupported);
    setUnsupportedReason(support.reason);
  }, []);

  useEffect(() => {
    return () => {
      const recorder = mediaRecorderRef.current;
      const recording = recordingRef.current;

      if (recorder && recorder.state === "recording") {
        if (recording?.background) {
          recording.shouldTranscribe = true;
          recording.accepted = true;
          recording.previousDelivery = deliveryTailRef.current;
          deliveryTailRef.current = new Promise<void>((resolve) => {
            recording.releaseDelivery = resolve;
          });
          recording.snapshot();
        } else if (recording) recording.shouldTranscribe = false;

        try {
          recorder.stop();
        } catch {
          recording?.releaseDelivery?.();
        }
      }

      mediaRecorderRef.current = null;

      releaseRecordingWakeLock();
      stopMediaStream();
    };
  }, [releaseRecordingWakeLock, stopMediaStream]);

  useEffect(() => {
    return subscribeToDocumentVisibility(() => {
      if (!isDocumentVisible() && traceRef.current)
        traceRef.current.report.wasHidden = true;

      if (isDocumentVisible() && shouldHoldWakeLockRef.current) {
        requestRecordingWakeLock();
      }
    });
  }, [requestRecordingWakeLock]);

  const start = useCallback(async () => {
    if (!isSupported) {
      showError(voiceUnsupportedMessage(unsupportedReason));

      return;
    }

    if (
      startingRef.current ||
      state === "starting" ||
      state === "recording" ||
      (!options.backgroundTranscription && state === "transcribing") ||
      mediaRecorderRef.current?.state === "recording"
    ) {
      return;
    }

    startingRef.current = true;
    setState("starting");
    options.onPrepare?.();
    const request = ++deviceRequestRef.current;
    const promptContext = options.getPromptContext?.();
    const trace = createVoiceTrace();
    traceRef.current = trace;

    const snapshot = () => {
      const track = streamRef.current?.getAudioTracks()[0];
      trace.report.trackState = track?.readyState ?? "unknown";
      trace.report.trackMuted = track?.muted ?? null;
      trace.report.silent = silentRef.current;
      trace.report.recorderState = mediaRecorderRef.current?.state ?? "unknown";

      const contextState: string | undefined =
        recordingStreamRef.current?.state();

      trace.report.audioContextState =
        contextState === "running" ||
        contextState === "suspended" ||
        contextState === "interrupted" ||
        contextState === "closed"
          ? contextState
          : "unknown";
    };

    try {
      const stream = await requestAudioInputStream(
        navigator.mediaDevices,
        preferredAudioInputDeviceId,
      ).catch((error: unknown) => {
        if (request === deviceRequestRef.current) {
          setCaptureError(
            resolveRecordingErrorMessage(
              error,
              preferredAudioInputDeviceId !== null,
            ),
          );
        }

        throw error;
      });

      if (request !== deviceRequestRef.current) {
        stream.getTracks().forEach((track) => track.stop());

        return;
      }

      setCaptureError(null);
      void refreshDevices();
      recordingPreferenceRef.current = preferredAudioInputDeviceId;
      streamRef.current = stream;
      setStream(stream);
      shouldHoldWakeLockRef.current = true;
      requestRecordingWakeLock();

      const recordingStream =
        typeof AudioContext === "undefined"
          ? null
          : createMicrophoneRecordingStream(stream);

      recordingStreamRef.current = recordingStream;

      if (recordingStream) await recordingStream.resume();

      if (request !== deviceRequestRef.current) return;
      const recorderInput = recordingStream?.stream ?? stream;
      const preferredMimeType = resolvePreferredAudioMimeType();

      const recorder = preferredMimeType
        ? new MediaRecorder(recorderInput, { mimeType: preferredMimeType })
        : new MediaRecorder(recorderInput);

      mediaRecorderRef.current = recorder;

      const recording: VoiceRecording = {
        snapshot,
        background: options.backgroundTranscription === true,
        chunks: [],
        startedAtMs: null,
        promptContext,
        shouldTranscribe: true,
        accepted: false,
        onTranscript: options.onTranscript,
        onTranscriptionError: undefined,
        onCaptureReleased: undefined,
        progressToast: true,
        previousDelivery: Promise.resolve(),
        releaseDelivery: null,
      };

      recordingRef.current = recording;

      recorder.onstart = () => {
        if (request !== deviceRequestRef.current) return;
        recording.startedAtMs = Date.now();
        setState("recording");
      };

      recorder.ondataavailable = (event: BlobEvent) => {
        if (event.data.size > 0) {
          recording.chunks.push(event.data);
          trace.report.chunkCount = Math.min(
            1_000_000,
            trace.report.chunkCount + 1,
          );
          trace.report.audioBytes = Math.min(
            100 * 1024 * 1024,
            trace.report.audioBytes + event.data.size,
          );
        }
      };

      recorder.onerror = () => {
        snapshot();
        emitVoiceDiagnostic(trace, "recording", "recorder_failed");

        if (mediaRecorderRef.current === recorder)
          showError("Voice recording failed");
        else
          appToast.error("Voice input failed", {
            description: "Voice recording failed",
          });
      };

      recorder.onstop = async () => {
        if (mediaRecorderRef.current === recorder) snapshot();

        if (stoppedRecordingRef.current === recording) {
          stoppedRecordingRef.current = null;
        }

        if (mediaRecorderRef.current === recorder) {
          mediaRecorderRef.current = null;
          recordingRef.current = null;
          releaseRecordingWakeLock();
          stopMediaStream();
        }

        if (streamRef.current === null) recording.onCaptureReleased?.();

        const background = recording.background;

        if (background && !recording.accepted) setState("idle");

        const reportError = (
          message: string,
          cause: VoiceDiagnostic["cause"],
        ) => {
          emitVoiceDiagnostic(trace, "finalizing", cause);
          recording.onTranscriptionError?.();

          if (!background) setState("error");
          appToast.error("Voice input failed", { description: message });
        };

        if (!recording.shouldTranscribe) {
          recording.releaseDelivery?.();

          if (!background || !recording.accepted) setState("idle");

          return;
        }

        const startedAtMs = recording.startedAtMs ?? Date.now();
        const durationMs = Date.now() - startedAtMs;
        trace.report.durationMs = Math.min(86_400_000, Math.max(0, durationMs));

        if (durationMs < MIN_RECORDING_DURATION_MS) {
          reportError(
            "Recording too short (minimum 1 second)",
            "recording_short",
          );
          recording.releaseDelivery?.();

          return;
        }

        const chunks = recording.chunks;
        recording.chunks = [];

        if (chunks.length === 0) {
          reportError("No audio was captured", "recording_empty");
          recording.releaseDelivery?.();

          return;
        }

        const recordedMimeType =
          recorder.mimeType || preferredMimeType || "audio/webm";

        trace.report.mime = recordedMimeType.includes("webm")
          ? "webm"
          : recordedMimeType.includes("mp4")
            ? "mp4"
            : recordedMimeType.includes("ogg")
              ? "ogg"
              : "other";

        const audioBlob = new Blob(chunks, { type: recordedMimeType });
        const audioFile = createRecordingFile(audioBlob, recordedMimeType);
        const promptContext = recording.promptContext;
        let pending = false;
        let completedTranscript: string | null = null;
        let attempt = 0;

        const transcribeRecording = async () => {
          if (pending) return;
          pending = true;
          trace.report.attempt = Math.min(100, ++attempt);
          let emptyTranscript = false;

          if (!background) setState("transcribing");

          const toastId =
            background && recording.progressToast
              ? appToast.loading("Transcribing voice input")
              : undefined;

          const abortController = new AbortController();

          if (!background) transcriptionAbortRef.current = abortController;

          try {
            const transcript =
              completedTranscript ??
              (await options.onTranscribe({
                file: audioFile,
                promptContext,
                signal: abortController.signal,
                recordingId: trace.report.recordingId,
                attempt: trace.report.attempt,
              }));

            if (abortController.signal.aborted) return;
            const normalized = normalizeTranscript(transcript);

            if (normalized.length === 0) {
              emptyTranscript = true;
              throw new Error("Voice transcription returned an empty result.");
            }

            completedTranscript = normalized;
            await recording.previousDelivery;

            if (abortController.signal.aborted) return;
            await recording.onTranscript(normalized);

            if (trace.failed)
              emitVoiceDiagnostic(trace, "delivery", "recovered");

            if (!background) setState("idle");
          } catch (error) {
            if (abortController.signal.aborted) return;

            if (
              !background &&
              error instanceof DOMException &&
              error.name === "AbortError"
            ) {
              if (!background) setState("idle");

              return;
            }

            emitVoiceDiagnostic(
              trace,
              completedTranscript !== null ? "delivery" : "request",
              completedTranscript !== null
                ? "delivery_failed"
                : emptyTranscript
                  ? "empty_transcript"
                  : voiceHttpStatus(error) !== null
                    ? "http_error"
                    : "transport_error",
              error,
            );

            if (completedTranscript === null)
              recording.onTranscriptionError?.();

            if (!background) setState("error");

            const deliveryNeedsReview =
              background && completedTranscript !== null;

            appToast.error(
              deliveryNeedsReview
                ? "Voice message needs review"
                : "Voice input failed",
              {
                description: deliveryNeedsReview
                  ? "Check the conversation before resending the restored draft."
                  : resolveRecordingErrorMessage(error),
                duration: Infinity,
                action: deliveryNeedsReview
                  ? undefined
                  : {
                      label: "Retry",
                      onClick: (event) => {
                        if (pending) {
                          event.preventDefault();

                          return;
                        }

                        void transcribeRecording();
                      },
                    },
                cancel: {
                  label: "Download recording",
                  onClick: () => downloadBlob(audioFile, audioFile.name),
                },
              },
            );
          } finally {
            pending = false;

            if (toastId !== undefined) appToast.dismiss(toastId);
            recording.releaseDelivery?.();

            if (transcriptionAbortRef.current === abortController) {
              transcriptionAbortRef.current = null;
            }
          }
        };

        await transcribeRecording();
      };

      recorder.start(CHUNK_TIMESLICE_MS);
    } catch (error) {
      if (request !== deviceRequestRef.current) return;
      snapshot();
      emitVoiceDiagnostic(trace, "starting", voiceCaptureCause(error));
      startingRef.current = false;
      stopMediaStream();
      mediaRecorderRef.current = null;
      recordingRef.current = null;
      transcriptionAbortRef.current = null;
      releaseRecordingWakeLock();
      showError(
        resolveRecordingErrorMessage(
          error,
          preferredAudioInputDeviceId !== null,
        ),
      );
    } finally {
      if (request === deviceRequestRef.current) startingRef.current = false;
    }
  }, [
    isSupported,
    options,
    unsupportedReason,
    preferredAudioInputDeviceId,
    releaseRecordingWakeLock,
    refreshDevices,
    requestRecordingWakeLock,
    showError,
    state,
    stopMediaStream,
  ]);

  const stop = useCallback(
    (
      onTranscript?: UseVoiceInputOptions["onTranscript"],
      onTranscriptionError?: () => void,
      orderedDelivery = true,
      progressToast = true,
      onCaptureReleased?: () => void,
    ) => {
      if (state !== "recording") {
        return;
      }

      const recorder = mediaRecorderRef.current;
      const recording = recordingRef.current;

      if (!recorder || !recording || recorder.state !== "recording") {
        return;
      }

      recording.shouldTranscribe = true;
      recording.accepted = true;
      recording.onTranscript = onTranscript ?? recording.onTranscript;
      recording.onTranscriptionError = onTranscriptionError;
      recording.onCaptureReleased = onCaptureReleased;
      recording.progressToast = progressToast;

      if (orderedDelivery) {
        recording.previousDelivery = deliveryTailRef.current;
        deliveryTailRef.current = new Promise<void>((resolve) => {
          recording.releaseDelivery = resolve;
        });
      }

      stoppedRecordingRef.current = recording.background ? null : recording;
      setState(recording.background ? "idle" : "transcribing");

      try {
        recording.snapshot();
        recorder.stop();

        if (recording.background && mediaRecorderRef.current === recorder) {
          mediaRecorderRef.current = null;
          recordingRef.current = null;
          releaseRecordingWakeLock();
          stopMediaStream();
        }
      } catch (error) {
        const trace = traceRef.current;

        if (trace) emitVoiceDiagnostic(trace, "finalizing", "recorder_failed");
        recording.onTranscriptionError?.();
        recording.releaseDelivery?.();
        showError(resolveRecordingErrorMessage(error));
      }
    },
    [releaseRecordingWakeLock, showError, state, stopMediaStream],
  );

  const cancel = useCallback(() => {
    const recorder = mediaRecorderRef.current;
    const recording = recordingRef.current ?? stoppedRecordingRef.current;

    if (
      recorder?.state === "inactive" &&
      (state === "recording" || state === "transcribing")
    ) {
      if (recording) recording.shouldTranscribe = false;

      return;
    }

    if (startingRef.current || state === "starting" || state === "recording") {
      startingRef.current = false;

      if (recorder && recorder.state === "recording") {
        if (recording) recording.shouldTranscribe = false;

        try {
          recorder.stop();
        } catch (error) {
          showError(resolveRecordingErrorMessage(error));
        }
      } else {
        if (recording) recording.shouldTranscribe = false;
        transcriptionAbortRef.current?.abort();
        stopMediaStream();
        releaseRecordingWakeLock();
        setState("idle");
      }

      return;
    }

    if (state === "transcribing") {
      const abortController = transcriptionAbortRef.current;

      if (abortController) {
        abortController.abort();
        transcriptionAbortRef.current = null;
      }

      setState("idle");
    }
  }, [releaseRecordingWakeLock, showError, state, stopMediaStream]);

  return {
    state,
    microphoneWarning:
      captureError ??
      (state === "recording" && silent
        ? "No audio detected. Check your microphone or choose another."
        : null) ??
      (hasDeviceAccess && devices.length === 0
        ? "No microphones are available. Connect a microphone or check microphone access."
        : null),
    isSupported,
    unsupportedReason,
    stream,
    isRecording: state === "recording",
    isProcessing: state === "transcribing",
    isListening:
      state === "starting" || state === "recording" || state === "transcribing",
    start,
    stop,
    cancel,
  };
}
