// @vitest-environment jsdom

import {
  act,
  cleanup,
  fireEvent,
  render,
  renderHook,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { appToast } from "@/components/ui/app-toast";
import { useAudioInputDevicePreferenceValue } from "@/lib/audio-input-device-preference";
import { useVoiceInput } from "./useVoiceInput";
import { reportVoiceDiagnostic } from "@/lib/voice-diagnostics";

vi.mock("@/lib/voice-diagnostics", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/voice-diagnostics")>()),
  initializeVoiceDiagnostics: vi.fn(),
  reportVoiceDiagnostic: vi.fn(),
}));

vi.mock("@/components/ui/app-toast", () => ({
  appToast: { error: vi.fn(), loading: vi.fn(), dismiss: vi.fn() },
}));

vi.mock("@/lib/audio-input-device-preference", () => ({
  useAudioInputDevicePreferenceValue: vi.fn(() => null),
  requestAudioInputStream: (mediaDevices: MediaDevices) =>
    mediaDevices.getUserMedia({ audio: true }),
}));

class Recorder {
  static isTypeSupported = () => true;
  mimeType = "audio/webm";
  state = "inactive";
  onstart = () => {};
  ondataavailable = (_event: { data: Blob }) => {};
  onstop = async () => {};
  start() {
    this.state = "recording";
    this.onstart();
  }
  stop() {
    this.state = "inactive";
    this.ondataavailable({ data: new Blob(["recorded audio"]) });

    return this.onstop();
  }
}

class DeferredRecorder extends Recorder {
  static current: DeferredRecorder;

  constructor() {
    super();
    DeferredRecorder.current = this;
  }

  stop() {
    this.state = "inactive";

    return Promise.resolve();
  }

  finish() {
    this.ondataavailable({ data: new Blob(["recorded audio"]) });

    return this.onstop();
  }
}

class CaptureStream {
  readonly track = { stop: vi.fn() };

  getTracks() {
    return [this.track];
  }

  getAudioTracks() {
    return [];
  }
}

beforeEach(() => {
  vi.mocked(useAudioInputDevicePreferenceValue).mockReturnValue(null);
  vi.useFakeTimers();
  vi.stubGlobal("MediaRecorder", Recorder);
  vi.stubGlobal("MediaStream", CaptureStream);
  vi.stubGlobal("navigator", {
    mediaDevices: {
      getUserMedia: vi.fn().mockResolvedValue(new MediaStream()),
    },
  });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

it("acknowledges microphone startup immediately and ignores repeated taps", async () => {
  let finishStartup: ((stream: MediaStream) => void) | undefined;
  vi.mocked(navigator.mediaDevices.getUserMedia).mockImplementation(
    () =>
      new Promise<MediaStream>((resolve) => {
        finishStartup = resolve;
      }),
  );

  const { result } = renderHook(() =>
    useVoiceInput({ onTranscribe: vi.fn(), onTranscript: vi.fn() }),
  );

  act(() => {
    void result.current.start();
    void result.current.start();
  });
  expect(navigator.mediaDevices.getUserMedia).toHaveBeenCalledOnce();
  expect(result.current.state).toBe("starting");
  expect(result.current.isRecording).toBe(false);
  await act(async () => finishStartup?.(new MediaStream()));
  expect(result.current.state).toBe("recording");
});

it("prepares transcription once per accepted start, before the microphone is granted", async () => {
  const order: string[] = [];
  let finishStartup: ((stream: MediaStream) => void) | undefined;
  vi.mocked(navigator.mediaDevices.getUserMedia).mockImplementation(() => {
    order.push("getUserMedia");

    return new Promise<MediaStream>((resolve) => {
      finishStartup = resolve;
    });
  });
  const onPrepare = vi.fn(() => order.push("onPrepare"));

  const { result } = renderHook(() =>
    useVoiceInput({
      onTranscribe: vi.fn(),
      onTranscript: vi.fn(),
      onPrepare,
    }),
  );

  act(() => {
    void result.current.start();
    void result.current.start();
  });
  expect(onPrepare).toHaveBeenCalledOnce();
  expect(order).toEqual(["onPrepare", "getUserMedia"]);
  await act(async () => finishStartup?.(new MediaStream()));
  expect(result.current.state).toBe("recording");
  await act(() => result.current.start());
  expect(onPrepare).toHaveBeenCalledOnce();
});

it("does not prepare transcription when voice input is unsupported", async () => {
  vi.stubGlobal("navigator", {});
  const onPrepare = vi.fn();

  const { result } = renderHook(() =>
    useVoiceInput({
      onTranscribe: vi.fn(),
      onTranscript: vi.fn(),
      onPrepare,
    }),
  );

  await act(() => result.current.start());
  expect(result.current.state).toBe("error");
  expect(onPrepare).not.toHaveBeenCalled();
});

it.each(["cancel", "unmount"] as const)(
  "releases a late microphone stream after %s during startup",
  async (action) => {
    let finishStartup: ((stream: MediaStream) => void) | undefined;
    vi.mocked(navigator.mediaDevices.getUserMedia).mockImplementation(
      () =>
        new Promise<MediaStream>((resolve) => {
          finishStartup = resolve;
        }),
    );
    const startRecorder = vi.spyOn(Recorder.prototype, "start");
    const stream = new MediaStream();
    const track = stream.getTracks()[0];

    if (!track) throw new Error("Missing fixture microphone track");

    const { result, unmount } = renderHook(() =>
      useVoiceInput({ onTranscribe: vi.fn(), onTranscript: vi.fn() }),
    );

    act(() => void result.current.start());

    if (action === "cancel") {
      act(() => result.current.cancel());
      expect(result.current.state).toBe("idle");
    } else unmount();
    await act(async () => finishStartup?.(stream));
    expect(track.stop).toHaveBeenCalledOnce();
    expect(startRecorder).not.toHaveBeenCalled();
    expect(appToast.error).not.toHaveBeenCalled();
  },
);

it("keeps a newer microphone request pending when a cancelled startup fails late", async () => {
  let failPrevious: ((error: Error) => void) | undefined;
  let finishCurrent: ((stream: MediaStream) => void) | undefined;
  vi.mocked(navigator.mediaDevices.getUserMedia)
    .mockImplementationOnce(
      () =>
        new Promise<MediaStream>((_resolve, reject) => {
          failPrevious = reject;
        }),
    )
    .mockImplementationOnce(
      () =>
        new Promise<MediaStream>((resolve) => {
          finishCurrent = resolve;
        }),
    );

  const { result } = renderHook(() =>
    useVoiceInput({ onTranscribe: vi.fn(), onTranscript: vi.fn() }),
  );

  act(() => void result.current.start());
  act(() => result.current.cancel());
  act(() => void result.current.start());
  await act(async () =>
    failPrevious?.(new Error("Previous microphone failed")),
  );
  expect(result.current.state).toBe("starting");
  expect(result.current.microphoneWarning).toBeNull();
  expect(appToast.error).not.toHaveBeenCalled();
  act(() => void result.current.start());
  expect(navigator.mediaDevices.getUserMedia).toHaveBeenCalledTimes(2);
  await act(async () => finishCurrent?.(new MediaStream()));
  expect(result.current.state).toBe("recording");
});

it("measures minimum recording duration from the recorder start event", async () => {
  class DelayedStartRecorder extends DeferredRecorder {
    start() {
      this.state = "recording";
    }
  }

  vi.stubGlobal("MediaRecorder", DelayedStartRecorder);
  const onTranscribe = vi.fn();

  const { result } = renderHook(() =>
    useVoiceInput({ onTranscribe, onTranscript: vi.fn() }),
  );

  await act(() => result.current.start());
  act(() => vi.advanceTimersByTime(5_000));
  act(() => DeferredRecorder.current.onstart());
  act(() => vi.advanceTimersByTime(100));
  act(() => result.current.stop());
  await act(async () => DeferredRecorder.current.finish());
  expect(onTranscribe).not.toHaveBeenCalled();
  expect(appToast.error).toHaveBeenCalledWith("Voice input failed", {
    description: "Recording too short (minimum 1 second)",
  });
});

it.each([false, true])(
  "calls capture feedback after releasing the microphone (background: %s)",
  async (backgroundTranscription) => {
    vi.stubGlobal("MediaRecorder", DeferredRecorder);
    const stream = new CaptureStream();
    vi.stubGlobal("navigator", {
      mediaDevices: { getUserMedia: vi.fn().mockResolvedValue(stream) },
    });

    const onCaptureReleased = vi.fn(() =>
      expect(stream.track.stop).toHaveBeenCalledOnce(),
    );

    const { result } = renderHook(() =>
      useVoiceInput({
        backgroundTranscription,
        onTranscribe: vi.fn().mockResolvedValue("transcript"),
        onTranscript: vi.fn(),
      }),
    );

    await act(() => result.current.start());
    act(() => vi.advanceTimersByTime(1_500));
    act(() =>
      result.current.stop(undefined, undefined, true, false, onCaptureReleased),
    );
    expect(onCaptureReleased).not.toHaveBeenCalled();
    await act(async () => DeferredRecorder.current.finish());
    expect(onCaptureReleased).toHaveBeenCalledOnce();
  },
);

it("ignores a late transcription failure after cancellation", async () => {
  let failTranscription: ((error: Error) => void) | undefined;

  const onTranscribe = vi.fn(
    () =>
      new Promise<string>((_resolve, reject) => {
        failTranscription = reject;
      }),
  );

  const { result } = renderHook(() =>
    useVoiceInput({ onTranscribe, onTranscript: vi.fn() }),
  );

  await act(() => result.current.start());
  act(() => vi.advanceTimersByTime(1_500));
  await act(async () => result.current.stop());
  act(() => result.current.cancel());
  await act(async () => failTranscription?.(new Error("Upload failed")));
  expect(result.current.state).toBe("idle");
  expect(appToast.error).not.toHaveBeenCalled();
});

it.each([true, false])(
  "accepts overlapping background recordings and preserves requested ordering (ordered: %s)",
  async (orderedDelivery) => {
    const completions: ((text: string) => void)[] = [];
    const onTranscript = vi.fn();

    const onTranscribe = vi.fn(
      () =>
        new Promise<string>((resolve) => {
          completions.push(resolve);
        }),
    );

    const { result, unmount } = renderHook(() =>
      useVoiceInput({
        backgroundTranscription: true,
        onTranscribe,
        onTranscript,
      }),
    );

    await act(() => result.current.start());
    vi.advanceTimersByTime(1_500);
    act(() => result.current.stop(undefined, undefined, orderedDelivery));
    expect(result.current.state).toBe("idle");

    await act(() => result.current.start());
    vi.advanceTimersByTime(1_500);
    act(() => result.current.stop(undefined, undefined, orderedDelivery));
    expect(onTranscribe).toHaveBeenCalledTimes(2);
    unmount();

    await act(async () => completions[1]?.("second recording"));

    if (orderedDelivery) expect(onTranscript).not.toHaveBeenCalled();
    else expect(onTranscript).toHaveBeenCalledWith("second recording");
    await act(async () => completions[0]?.("first recording"));
    expect(onTranscript.mock.calls.map(([transcript]) => transcript)).toEqual(
      orderedDelivery
        ? ["first recording", "second recording"]
        : ["second recording", "first recording"],
    );
    expect(result.current.state).toBe("idle");
  },
);

it("requires conversation review after a background submission fails and accepts a newer recording", async () => {
  const onTranscribe = vi.fn().mockResolvedValue("spoken words");

  const onTranscript = vi
    .fn()
    .mockRejectedValueOnce(new Error("Send failed"))
    .mockResolvedValueOnce(undefined);

  const { result } = renderHook(() =>
    useVoiceInput({
      backgroundTranscription: true,
      onTranscribe,
      onTranscript,
    }),
  );

  await act(() => result.current.start());
  vi.advanceTimersByTime(1_500);
  await act(async () => result.current.stop());
  const options = vi.mocked(appToast.error).mock.calls[0]?.[1];

  expect(options?.action).toBeUndefined();
  expect(options?.cancel?.label).toBe("Download recording");
  expect(options?.description).toBe(
    "Check the conversation before resending the restored draft.",
  );
  await act(() => result.current.start());
  expect(onTranscript).toHaveBeenCalledOnce();
  expect(onTranscribe).toHaveBeenCalledOnce();
  expect(result.current.state).toBe("recording");
});

it("keeps a newer microphone alive when an accepted recorder stops late", async () => {
  vi.stubGlobal("MediaRecorder", DeferredRecorder);
  const firstStream = new MediaStream();
  const secondStream = new MediaStream();
  vi.mocked(navigator.mediaDevices.getUserMedia)
    .mockResolvedValueOnce(firstStream)
    .mockResolvedValueOnce(secondStream);
  const onTranscript = vi.fn();

  const { result } = renderHook(() =>
    useVoiceInput({
      backgroundTranscription: true,
      onTranscribe: async () => "first transcript",
      onTranscript,
    }),
  );

  await act(() => result.current.start());
  const firstRecorder = DeferredRecorder.current;
  vi.advanceTimersByTime(1_500);
  act(() => result.current.stop());
  await act(() => result.current.start());
  await act(async () => firstRecorder.finish());

  expect(onTranscript).toHaveBeenCalledWith("first transcript");
  expect(result.current.state).toBe("recording");
  expect(secondStream.getTracks()[0]?.stop).not.toHaveBeenCalled();
  act(() => result.current.cancel());
  await act(async () => DeferredRecorder.current.finish());
});

it("preserves audio when background capture ends before an explicit stop", async () => {
  vi.stubGlobal("MediaRecorder", DeferredRecorder);
  const onTranscript = vi.fn();

  const { result } = renderHook(() =>
    useVoiceInput({
      backgroundTranscription: true,
      onTranscribe: async () => "recovered recording",
      onTranscript,
    }),
  );

  await act(() => result.current.start());
  vi.advanceTimersByTime(1_500);
  await act(async () => {
    await DeferredRecorder.current.stop();
    await DeferredRecorder.current.finish();
  });

  expect(result.current.state).toBe("idle");
  expect(onTranscript).toHaveBeenCalledWith("recovered recording");
});

it.each([
  new Error("Upload failed"),
  new Error("Audio file exceeds the 20MB limit"),
])("keeps failed audio downloadable after unmount: %s", async (error) => {
  const transcribe = vi.fn().mockRejectedValue(error);
  const transcript = vi.fn();

  const { result, unmount } = renderHook(() =>
    useVoiceInput({
      onTranscribe: transcribe,
      onTranscript: transcript,
    }),
  );

  await act(() => result.current.start());
  vi.advanceTimersByTime(1500);
  await act(async () => result.current.stop());
  expect(result.current.state).toBe("error");
  expect(result.current.microphoneWarning).toBeNull();
  expect(transcript).not.toHaveBeenCalled();
  const options = vi.mocked(appToast.error).mock.calls[0]?.[1];
  expect(options?.duration).toBe(Infinity);
  expect(options?.cancel?.label).toBe("Download recording");
  unmount();
  const createObjectURL = vi.fn(() => "blob:recording");
  const revokeObjectURL = vi.fn();
  vi.stubGlobal("URL", { createObjectURL, revokeObjectURL });
  let downloadedName = "";
  vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(
    function (this: HTMLAnchorElement) {
      downloadedName = this.download;
      expect(this.href).toBe("blob:recording");
      expect(this.isConnected).toBe(true);
    },
  );

  if (!options?.cancel) throw new Error("Missing download action");

  const button = render(
    <button onClick={options.cancel.onClick}>Download recording</button>,
  );

  fireEvent.click(button.getByRole("button"));
  expect(createObjectURL).toHaveBeenCalledWith(
    transcribe.mock.calls[0]?.[0].file,
  );
  expect(downloadedName).toBe("recording.webm");
  expect(revokeObjectURL).not.toHaveBeenCalled();
  vi.advanceTimersByTime(60_000);
  expect(revokeObjectURL).toHaveBeenCalledWith("blob:recording");
});

it.each([false, true])(
  "retries a failed transcription with the same recording (background: %s)",
  async (backgroundTranscription) => {
    const transcribe = vi
      .fn()
      .mockRejectedValueOnce(new Error("the model did not answer in time"))
      .mockResolvedValueOnce(" Retried words ");

    const onTranscript = vi.fn();

    const { result } = renderHook(() =>
      useVoiceInput({
        backgroundTranscription,
        onTranscribe: transcribe,
        onTranscript,
        getPromptContext: () => "draft context",
      }),
    );

    await act(() => result.current.start());
    vi.advanceTimersByTime(1500);
    await act(async () => result.current.stop());
    expect(result.current.state).toBe(
      backgroundTranscription ? "idle" : "error",
    );
    const options = vi.mocked(appToast.error).mock.calls[0]?.[1];
    expect(options?.action?.label).toBe("Retry");

    if (!options?.action) throw new Error("Missing retry action");

    const button = render(
      <button onClick={options.action.onClick}>Retry</button>,
    );

    await act(async () => fireEvent.click(button.getByRole("button")));
    expect(transcribe).toHaveBeenCalledTimes(2);
    expect(transcribe.mock.calls[1]?.[0].file).toBe(
      transcribe.mock.calls[0]?.[0].file,
    );
    expect(transcribe.mock.calls[1]?.[0].promptContext).toBe("draft context");
    expect(onTranscript).toHaveBeenCalledWith("Retried words");
    const failed = vi.mocked(reportVoiceDiagnostic).mock.calls[0]?.[0];
    const recovered = vi.mocked(reportVoiceDiagnostic).mock.calls[1]?.[0];
    expect(failed).toMatchObject({
      attempt: 1,
      outcome: "failed",
      stage: "request",
      cause: "transport_error",
    });
    expect(recovered).toMatchObject({
      recordingId: failed?.recordingId,
      attempt: 2,
      outcome: "recovered",
    });
    expect(transcribe.mock.calls[1]?.[0]).toMatchObject({
      recordingId: failed?.recordingId,
      attempt: 2,
    });
    expect(JSON.stringify(failed)).not.toContain("the model did not answer");
    expect(result.current.state).toBe("idle");
  },
);

it("does not offer a download after explicit cancellation", async () => {
  const { result } = renderHook(() =>
    useVoiceInput({
      onTranscribe: vi
        .fn()
        .mockRejectedValue(new DOMException("Cancelled", "AbortError")),
      onTranscript: vi.fn(),
    }),
  );

  await act(() => result.current.start());
  vi.advanceTimersByTime(1500);
  await act(async () => result.current.stop());
  expect(result.current.state).toBe("idle");
  expect(appToast.error).not.toHaveBeenCalled();
});

it("keeps an accepted transcription running after unmount", async () => {
  let finishTranscription: ((text: string) => void) | undefined;

  const transcribe = vi.fn(
    (_args: { file: File; promptContext?: string; signal?: AbortSignal }) =>
      new Promise<string>((resolve) => {
        finishTranscription = resolve;
      }),
  );

  const onTranscript = vi.fn();

  const { result, unmount } = renderHook(() =>
    useVoiceInput({ onTranscribe: transcribe, onTranscript }),
  );

  await act(() => result.current.start());
  vi.advanceTimersByTime(1500);
  await act(async () => result.current.stop());
  const signal = transcribe.mock.calls[0]?.[0].signal;
  expect(signal?.aborted).toBe(false);

  unmount();
  expect(signal?.aborted).toBe(false);
  await act(async () => finishTranscription?.(" Spoken words "));
  expect(onTranscript).toHaveBeenCalledWith("Spoken words");
});

it("surfaces a failed asynchronous transcript submission after unmount", async () => {
  let finishSubmission: (() => void) | undefined;

  const onTranscript = vi.fn(
    () =>
      new Promise<void>((_resolve, reject) => {
        finishSubmission = () => reject(new Error("Submission failed"));
      }),
  );

  const { result, unmount } = renderHook(() =>
    useVoiceInput({ onTranscribe: async () => "Spoken words", onTranscript }),
  );

  await act(() => result.current.start());
  vi.advanceTimersByTime(1500);
  act(() => {
    result.current.stop();
  });
  await act(async () => {
    await Promise.resolve();
  });
  expect(onTranscript).toHaveBeenCalledWith("Spoken words");
  unmount();
  await act(async () => {
    finishSubmission?.();
  });
  expect(appToast.error).toHaveBeenCalledWith(
    "Voice input failed",
    expect.objectContaining({ description: "Submission failed" }),
  );
});

it("discards a stopped recording cancelled before the recorder's stop event", async () => {
  vi.stubGlobal("MediaRecorder", DeferredRecorder);
  const onTranscribe = vi.fn();
  const onTranscript = vi.fn();

  const { result } = renderHook(() =>
    useVoiceInput({ onTranscribe, onTranscript }),
  );

  await act(() => result.current.start());
  vi.advanceTimersByTime(1500);
  act(() => result.current.stop());
  expect(result.current.state).toBe("transcribing");
  act(() => result.current.cancel());
  await act(async () => DeferredRecorder.current.finish());
  expect(result.current.state).toBe("idle");
  expect(onTranscribe).not.toHaveBeenCalled();
  expect(onTranscript).not.toHaveBeenCalled();
});

it("transcribes an accepted recording when the recorder stops after unmount", async () => {
  vi.stubGlobal("MediaRecorder", DeferredRecorder);
  const onTranscribe = vi.fn().mockResolvedValue("Delayed words");
  const onTranscript = vi.fn();

  const { result, unmount } = renderHook(() =>
    useVoiceInput({ onTranscribe, onTranscript }),
  );

  await act(() => result.current.start());
  vi.advanceTimersByTime(1500);
  act(() => result.current.stop());
  unmount();

  await act(async () => DeferredRecorder.current.finish());
  expect(onTranscribe).toHaveBeenCalledOnce();
  expect(onTranscript).toHaveBeenCalledWith("Delayed words");
  expect(appToast.error).not.toHaveBeenCalled();
});

it("transcribes a recording into its draft when its composer unmounts mid-recording", async () => {
  vi.stubGlobal("MediaRecorder", DeferredRecorder);
  const onTranscribe = vi.fn().mockResolvedValue("Dictated words");
  const onTranscript = vi.fn();

  const { result, unmount } = renderHook(() =>
    useVoiceInput({
      backgroundTranscription: true,
      onTranscribe,
      onTranscript,
    }),
  );

  await act(() => result.current.start());
  vi.advanceTimersByTime(180_000);
  act(() => {
    DeferredRecorder.current.ondataavailable({
      data: new Blob(["audio before navigation"]),
    });
  });
  unmount();

  await act(async () => DeferredRecorder.current.finish());
  expect(onTranscribe).toHaveBeenCalledOnce();
  expect(await onTranscribe.mock.calls[0]?.[0].file.text()).toBe(
    "audio before navigationrecorded audio",
  );
  expect(onTranscript).toHaveBeenCalledExactlyOnceWith("Dictated words");
  expect(appToast.error).not.toHaveBeenCalled();
});

it("discards a recording without a draft when its field unmounts before acceptance", async () => {
  vi.stubGlobal("MediaRecorder", DeferredRecorder);
  const onTranscribe = vi.fn();

  const { result, unmount } = renderHook(() =>
    useVoiceInput({ onTranscribe, onTranscript: vi.fn() }),
  );

  await act(() => result.current.start());
  vi.advanceTimersByTime(1500);
  unmount();
  await act(async () => DeferredRecorder.current.finish());
  expect(onTranscribe).not.toHaveBeenCalled();
});

it("aborts transcription when the user cancels it", async () => {
  let finishTranscription: ((text: string) => void) | undefined;

  const onTranscribe = vi.fn(
    (_args: { file: File; promptContext?: string; signal?: AbortSignal }) =>
      new Promise<string>((resolve) => {
        finishTranscription = resolve;
      }),
  );

  const onTranscript = vi.fn();

  const { result } = renderHook(() =>
    useVoiceInput({ onTranscribe, onTranscript }),
  );

  await act(() => result.current.start());
  vi.advanceTimersByTime(1500);
  await act(async () => result.current.stop());
  const signal = onTranscribe.mock.calls[0]?.[0].signal;
  act(() => result.current.cancel());
  expect(signal?.aborted).toBe(true);
  await act(async () => finishTranscription?.("Cancelled words"));
  expect(onTranscript).not.toHaveBeenCalled();
});

it("warns when microphone access fails and clears the warning after a successful retry", async () => {
  vi.mocked(navigator.mediaDevices.getUserMedia).mockRejectedValueOnce(
    new DOMException("Unavailable", "NotReadableError"),
  );

  const { result } = renderHook(() =>
    useVoiceInput({ onTranscribe: vi.fn(), onTranscript: vi.fn() }),
  );

  await act(() => result.current.start());
  expect(result.current.microphoneWarning).toBe(
    "Microphone is unavailable or already in use",
  );
  await act(() => result.current.start());
  expect(result.current.state).toBe("recording");
  expect(result.current.microphoneWarning).toBeNull();
});

it("tracks interrupted audio and retains a disconnect warning after recording stops", async () => {
  const track = Object.assign(new EventTarget(), {
    muted: false,
    readyState: "live",
    stop: vi.fn(),
  });

  vi.mocked(navigator.mediaDevices.getUserMedia).mockResolvedValue({
    getTracks: () => [track],
    getAudioTracks: () => [track],
  } as unknown as MediaStream);

  const { result } = renderHook(() =>
    useVoiceInput({
      onTranscribe: vi.fn().mockResolvedValue("hello"),
      onTranscript: vi.fn(),
    }),
  );

  await act(() => result.current.start());
  act(() => {
    track.muted = true;
    track.dispatchEvent(new Event("mute"));
  });
  expect(result.current.microphoneWarning).toContain("not providing audio");
  act(() => {
    track.muted = false;
    track.dispatchEvent(new Event("unmute"));
  });
  expect(result.current.microphoneWarning).toBeNull();
  act(() => {
    track.readyState = "ended";
    track.dispatchEvent(new Event("ended"));
  });
  vi.advanceTimersByTime(1500);
  await act(async () => result.current.stop());
  expect(result.current.microphoneWarning).toContain(
    "disconnected during recording",
  );
});

it("does not block recording for a missing preference when fallback devices exist", async () => {
  vi.mocked(useAudioInputDevicePreferenceValue).mockReturnValue("built-in");

  const enumerateDevices = vi
    .fn()
    .mockResolvedValue([{ kind: "audioinput", deviceId: "masked", label: "" }]);

  const mediaDevices = Object.assign(new EventTarget(), {
    enumerateDevices,
    getUserMedia: vi.fn(),
  });

  vi.stubGlobal("navigator", { mediaDevices });

  const { result } = renderHook(() =>
    useVoiceInput({ onTranscribe: vi.fn(), onTranscript: vi.fn() }),
  );

  await act(async () => {});
  expect(result.current.microphoneWarning).toBeNull();
  enumerateDevices.mockResolvedValue([
    { kind: "audioinput", deviceId: "external", label: "Display microphone" },
  ]);
  await act(async () => mediaDevices.dispatchEvent(new Event("devicechange")));
  expect(result.current.microphoneWarning).toBeNull();
  enumerateDevices.mockResolvedValue([
    { kind: "audioinput", deviceId: "built-in", label: "Built-in microphone" },
  ]);
  await act(async () => window.dispatchEvent(new Event("focus")));
  expect(result.current.microphoneWarning).toBeNull();
  enumerateDevices.mockResolvedValue([]);
  await act(async () => mediaDevices.dispatchEvent(new Event("devicechange")));
  expect(result.current.microphoneWarning).not.toBeNull();
});

function installAudioContext() {
  const audio = { amplitude: 0, closed: vi.fn() };

  class TestAudioContext {
    state = "running";
    resume = async () => {};
    close = async () => {
      audio.closed();
    };
    createMediaStreamSource = () => ({ connect: vi.fn(), disconnect: vi.fn() });
    createMediaStreamDestination = () => ({
      stream: { getTracks: () => [{ stop: vi.fn() }] },
    });
    createAnalyser = () => ({
      fftSize: 2048,
      disconnect: vi.fn(),
      getFloatTimeDomainData: (samples: Float32Array) =>
        samples.fill(audio.amplitude),
    });
  }

  vi.stubGlobal("AudioContext", TestAudioContext);

  return audio;
}

it("warns about sustained silence without stopping and clears the warning as soon as sound returns", async () => {
  const audio = installAudioContext();

  const { result } = renderHook(() =>
    useVoiceInput({ onTranscribe: vi.fn(), onTranscript: vi.fn() }),
  );

  await act(() => result.current.start());
  act(() => vi.advanceTimersByTime(4900));
  expect(result.current.microphoneWarning).toBeNull();
  act(() => vi.advanceTimersByTime(200));
  expect(result.current.microphoneWarning).toContain("No audio detected");
  expect(result.current.state).toBe("recording");
  audio.amplitude = 0.02;
  act(() => vi.advanceTimersByTime(100));
  expect(result.current.microphoneWarning).toBeNull();
});

it("keeps the same recorder and captured audio when a microphone disconnects, and releases a late replacement after stop", async () => {
  installAudioContext();

  const firstTrack = Object.assign(new EventTarget(), {
    muted: false,
    readyState: "live",
    stop: vi.fn(),
  });

  const secondTrack = Object.assign(new EventTarget(), {
    muted: false,
    readyState: "live",
    stop: vi.fn(),
  });

  const first = {
    getTracks: () => [firstTrack],
    getAudioTracks: () => [firstTrack],
  };

  const second = {
    getTracks: () => [secondTrack],
    getAudioTracks: () => [secondTrack],
  };

  const recorders: Recorder[] = [];

  class CountingRecorder extends Recorder {
    constructor() {
      super();
      recorders.push(this);
    }
  }

  vi.stubGlobal("MediaRecorder", CountingRecorder);

  const capture = vi
    .fn()
    .mockResolvedValueOnce(first)
    .mockResolvedValueOnce(second);

  vi.stubGlobal("navigator", { mediaDevices: { getUserMedia: capture } });
  const transcribe = vi.fn().mockResolvedValue("Kept my dictation");

  const { result } = renderHook(() =>
    useVoiceInput({ onTranscribe: transcribe, onTranscript: vi.fn() }),
  );

  await act(() => result.current.start());
  await act(async () => {
    firstTrack.readyState = "ended";
    firstTrack.dispatchEvent(new Event("ended"));
  });
  expect(result.current.stream).toBe(second);
  expect(result.current.state).toBe("recording");
  expect(recorders).toHaveLength(1);
  expect(firstTrack.stop).toHaveBeenCalledOnce();
  let finish: (stream: object) => void = () => {};

  capture.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  await act(async () => {
    secondTrack.readyState = "ended";
    secondTrack.dispatchEvent(new Event("ended"));
  });
  act(() => vi.advanceTimersByTime(1500));
  await act(async () => result.current.stop());
  const lateStop = vi.fn();
  await act(async () => finish({ getTracks: () => [{ stop: lateStop }] }));
  expect(lateStop).toHaveBeenCalledOnce();
  expect(transcribe).toHaveBeenCalledOnce();
  expect(result.current.stream).toBeNull();
});
