// @vitest-environment jsdom

import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { transcribeVoiceInput } from "@/lib/api";
import { useVoiceInput } from "@/hooks/useVoiceInput";
import type { PromptBoxHandle } from "./PromptBoxInternal";
import { usePromptVoice } from "./usePromptVoice";
import type { PromptDraftState } from "@omnyo/client-core";
import {
  getPromptDraftAccessor,
  movePromptDraft,
} from "@/hooks/usePromptDraftStorage";
import { recoverInterruptedComposerSubmissions } from "@/lib/composer-submission-journal";
import { reserveComposerSend } from "@/lib/composer-send-queue";
import {
  createPendingChat,
  resolvePendingThreadDraftScope,
} from "@/lib/pending-chat-creations";
import { makeThreadResponse } from "@/test/fixtures/thread-responses";
import { createDeferredPromise } from "@omnyo/test-helpers";
import type { ThreadResponse } from "@omnyo/server-contract";

vi.mock("@/lib/api", () => ({
  transcribeVoiceInput: vi.fn(),
  prepareVoiceInput: vi.fn(),
}));

vi.mock("@/hooks/useVoiceInput", () => ({ useVoiceInput: vi.fn() }));

vi.mock("@/components/ui/app-toast", () => ({
  appToast: { message: vi.fn(), error: vi.fn() },
}));

type TranscriptHandler = (text: string) => void | Promise<void>;

let state: "idle" | "recording";

const callbacks: TranscriptHandler[] = [];

const failures: (() => void)[] = [];

const stop = vi.fn(
  (onTranscript?: TranscriptHandler, onTranscriptionError?: () => void) => {
    if (onTranscript) callbacks.push(onTranscript);

    if (onTranscriptionError) failures.push(onTranscriptionError);
  },
);

const start = vi.fn(async () => {});

const cancel = vi.fn();

function createDraft(text: string) {
  let current: PromptDraftState = { text, mentions: [], attachments: [] };
  const submitDraft = vi.fn(async (_draft: PromptDraftState) => {});

  return {
    getCurrent: () => current,
    setDraft: (next: PromptDraftState) => {
      current = next;
    },
    submitDraft,
  };
}

function createPromptRef() {
  return {
    current: {
      captureHeightForLayoutChange: vi.fn(),
      focusEnd: vi.fn(),
      getTextBeforeCursor: vi.fn(),
      insertTextAtCursor: vi.fn(),
      insertTypedText: vi.fn(),
      sendVoiceTranscript: vi.fn(),
      playVoiceCompletionTransition: vi.fn(),
      dismissMenu: vi.fn(() => false),
      openAttachmentPicker: vi.fn(),
      applyPromptAction: vi.fn(),
    } satisfies PromptBoxHandle,
  };
}

beforeEach(() => {
  state = "idle";
  callbacks.length = 0;
  failures.length = 0;
  vi.mocked(useVoiceInput).mockImplementation(() => ({
    state,
    microphoneWarning: null,
    isSupported: true,
    unsupportedReason: null,
    stream: null,
    isRecording: state === "recording",
    isProcessing: false,
    isListening: state === "recording",
    start,
    stop,
    cancel,
  }));
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("usePromptVoice", () => {
  it("sends a voice message immediately and supplies its transcript when ready", async () => {
    const draft = createDraft("Context");
    const sent = createDeferredPromise<void>();
    let transcript: (() => Promise<string>) | undefined;

    const submitVoiceDraft = vi.fn(
      async (_draft: PromptDraftState, pending: () => Promise<string>) => {
        transcript = pending;
        await sent.promise;
      },
    );

    state = "recording";

    const { result } = renderHook(() =>
      usePromptVoice(createPromptRef(), { ...draft, submitVoiceDraft }),
    );

    act(() => result.current.send());

    expect(submitVoiceDraft).toHaveBeenCalledOnce();
    expect(submitVoiceDraft.mock.calls[0]?.[0].text).toBe("Context");
    expect(draft.getCurrent().text).toBe("");
    expect(draft.submitDraft).not.toHaveBeenCalled();
    expect(stop).toHaveBeenCalledWith(
      expect.any(Function),
      expect.any(Function),
      false,
      false,
      expect.any(Function),
    );

    const pending = transcript?.();
    await callbacks[0]?.("spoken words");
    await expect(pending).resolves.toBe("spoken words");
    sent.resolve();
  });

  it("restores a voice message for retry when its transcription fails after sending", async () => {
    const draft = createDraft("");
    let transcript: (() => Promise<string>) | undefined;

    const submitVoiceDraft = vi.fn(
      async (_draft: PromptDraftState, pending: () => Promise<string>) => {
        transcript = pending;
        await pending();
      },
    );

    state = "recording";

    const { result } = renderHook(() =>
      usePromptVoice(createPromptRef(), { ...draft, submitVoiceDraft }),
    );

    act(() => result.current.send());
    failures[0]?.();
    await expect(transcript?.()).rejects.toThrow();
    await callbacks[0]?.("retried words");
    expect(draft.getCurrent().text).toBe("retried words");
  });

  it.each([false, true])(
    "recovers and retries voice into the real chat after its provisional origin moves (files: %s)",
    async (hasFiles) => {
      const projectId = `voice-alias-${hasFiles}`;
      const creation = createDeferredPromise<ThreadResponse>();

      const pending = createPendingChat({
        queueOwner: {},
        request: {
          projectId,
          providerId: "codex",
          model: "original",
          reasoningLevel: "high",
          permissionMode: "full",
          environment: { type: "reuse", environmentId: "voice-environment" },
          executionInputSources: {},
          input: [{ type: "text", text: "initial", mentions: [] }],
        },
        create: () => creation.promise,
        send: async () => {},
        renderer: () => null,
        prepare: async () => {},
      });

      const draftScope = {
        kind: "thread" as const,
        projectId,
        threadId: pending.id,
      };

      const accessor = getPromptDraftAccessor(draftScope);
      accessor.setDraft({
        text: "Original typed context",
        mentions: [],
        attachments: [],
      });

      const uploaded = {
        type: "localFile" as const,
        path: "uploaded/voice-alias.txt",
        name: "voice-alias.txt",
      };

      const captured = {
        files: [new File(["file"], "voice-alias.txt")],
        wait: vi.fn(),
        restore: () =>
          getPromptDraftAccessor(
            resolvePendingThreadDraftScope(draftScope),
          ).addAttachment(uploaded),
      };

      const draft = {
        ...accessor,
        draftScope,
        submitDraft: vi.fn(async () => {}),
        captureAttachments: () => (hasFiles ? captured : null),
      };

      const { result, rerender } = renderHook(() =>
        usePromptVoice(createPromptRef(), draft),
      );

      await act(() => result.current.start());
      state = "recording";
      rerender();
      act(() => result.current.send());
      creation.resolve(
        makeThreadResponse({ id: `real-${hasFiles}`, projectId }),
      );
      await act(async () => {
        await pending.completion;
      });
      const realScope = resolvePendingThreadDraftScope(draftScope);
      movePromptDraft(draftScope, realScope);
      const real = getPromptDraftAccessor(realScope);
      real.setDraft({ text: "Later typing", mentions: [], attachments: [] });
      act(() => failures[0]?.());
      await callbacks[0]?.("retried transcript");
      expect(accessor.getCurrent().text).toBe("");

      if (hasFiles) {
        expect(draft.submitDraft).not.toHaveBeenCalled();
        expect(real.getCurrent()).toEqual({
          text: "Later typing\n\nOriginal typed context retried transcript",
          mentions: [],
          attachments: [uploaded],
        });
      } else {
        expect(draft.submitDraft).toHaveBeenCalledOnce();
        expect(real.getCurrent().text).toBe("Later typing");
      }
    },
  );
  it.each([false, true])(
    "captures original uploading files and recovers before transcription retry (failed: %s)",
    async (failed) => {
      const draftScope = {
        kind: "thread" as const,
        projectId: "voice-files",
        threadId: `voice-files-${failed}`,
      };

      const accessor = getPromptDraftAccessor(draftScope);
      accessor.setDraft({
        text: "Typed context",
        mentions: [],
        attachments: [],
      });

      const uploaded = {
        type: "localFile" as const,
        path: "uploaded/pending.txt",
        name: "pending.txt",
      };

      const capturedUploads = {
        files: [new File(["pending"], "pending.txt")],
        wait: vi.fn(),
        restore: vi.fn(() => accessor.addAttachment(uploaded)),
      };

      const draft = {
        ...accessor,
        draftScope,
        submitDraft: vi.fn(async () => {}),
        captureAttachments: vi.fn(() => capturedUploads),
      };

      const { result, rerender } = renderHook(() =>
        usePromptVoice(createPromptRef(), draft),
      );

      await act(() => result.current.start());
      state = "recording";
      rerender();
      act(() => result.current.send());
      expect(draft.captureAttachments).toHaveBeenCalledOnce();
      accessor.setDraft({
        text: "Later typing",
        mentions: [],
        attachments: [],
      });

      if (failed) {
        act(() => failures[0]?.());
        expect(capturedUploads.restore).toHaveBeenCalledOnce();
        await callbacks[0]?.("retried transcript");
        expect(draft.submitDraft).not.toHaveBeenCalled();
        expect(accessor.getCurrent()).toEqual({
          text: "Later typing\n\nTyped context retried transcript",
          mentions: [],
          attachments: [uploaded],
        });
      } else {
        await callbacks[0]?.("spoken transcript");
        expect(draft.submitDraft).toHaveBeenCalledWith(
          {
            text: "Typed context spoken transcript",
            mentions: [],
            attachments: [],
          },
          { experimental_data: null },
          undefined,
          undefined,
          capturedUploads,
        );
        expect(capturedUploads.restore).not.toHaveBeenCalled();
        expect(accessor.getCurrent().text).toBe("Later typing");
      }
    },
  );
  it.each(["reload", "transcription failure"] as const)(
    "preserves accepted typed context on %s",
    async (outcome) => {
      const draftScope = {
        kind: "thread" as const,
        projectId: "voice-project",
        threadId: `voice-${outcome}`,
      };

      const accessor = getPromptDraftAccessor(draftScope);

      const original = {
        text: "Known typed context",
        mentions: [],
        attachments: [],
      };

      accessor.setDraft(original);

      const owner = {};

      const reserveSubmission = vi.fn(() =>
        reserveComposerSend(owner, draftScope.threadId),
      );

      const draft = {
        ...accessor,
        draftScope,
        submitDraft: vi.fn(async () => {}),
        reserveSubmission,
      };

      const { result, rerender } = renderHook(() =>
        usePromptVoice(createPromptRef(), draft),
      );

      await act(() => result.current.start());
      state = "recording";
      rerender();
      act(() => result.current.send());
      expect(accessor.getCurrent().text).toBe("");
      expect(reserveSubmission).toHaveBeenCalledOnce();
      const reservedSlot = reserveSubmission.mock.results[0]?.value;

      if (!reservedSlot) throw new Error("Missing reserved send slot");
      const cancelReservation = vi.spyOn(reservedSlot, "cancel");

      if (outcome === "reload") {
        const restore = vi.fn();
        expect(recoverInterruptedComposerSubmissions(restore)).toEqual({
          recovered: 1,
          failed: 0,
        });
        expect(restore).toHaveBeenCalledWith(draftScope, original);
      } else {
        accessor.setDraft({
          text: "Newer text",
          mentions: [],
          attachments: [],
        });
        act(() => failures[0]?.());
        act(() => failures[0]?.());
        expect(cancelReservation).toHaveBeenCalledOnce();
        expect(accessor.getCurrent().text).toBe(
          "Newer text\n\nKnown typed context",
        );
        expect(recoverInterruptedComposerSubmissions(vi.fn())).toEqual({
          recovered: 0,
          failed: 0,
        });
        await callbacks[0]?.("retried transcript");
        expect(reserveSubmission).toHaveBeenCalledTimes(2);
        expect(draft.submitDraft).toHaveBeenCalledWith(
          { ...original, text: "Known typed context retried transcript" },
          { experimental_data: null },
          undefined,
          reserveSubmission.mock.results[1]?.value,
          undefined,
        );
        expect(accessor.getCurrent().text).toBe("Newer text");
      }
    },
  );
  it("keeps accepted voice snapshots separate from later typing and recordings", async () => {
    const draft = createDraft("First context");
    const promptRef = createPromptRef();

    const { result, rerender } = renderHook(() =>
      usePromptVoice(promptRef, draft),
    );

    await act(() => result.current.start());
    state = "recording";
    rerender();
    act(() => {
      result.current.send();
      result.current.send();
    });
    expect(stop).toHaveBeenCalledOnce();
    expect(draft.getCurrent().text).toBe("");

    draft.setDraft({ text: "Second context", mentions: [], attachments: [] });
    state = "idle";
    rerender();
    await act(() => result.current.start());
    state = "recording";
    rerender();
    act(() => result.current.send());
    draft.setDraft({
      text: "Next typed message",
      mentions: [],
      attachments: [],
    });

    await callbacks[0]?.("first transcript");
    await callbacks[1]?.("second transcript");
    expect(
      draft.submitDraft.mock.calls.map(([submitted]) => submitted.text),
    ).toEqual([
      "First context first transcript",
      "Second context second transcript",
    ]);
    expect(draft.getCurrent().text).toBe("Next typed message");
    expect(promptRef.current.sendVoiceTranscript).not.toHaveBeenCalled();
  });

  it.each(["send", "stop"] as const)(
    "binds %s to the recording origin across navigation and unmount",
    async (action) => {
      const origin = createDraft("Original context");
      const other = createDraft("Other chat");

      const { result, rerender, unmount } = renderHook(
        ({ draft }) => usePromptVoice(createPromptRef(), draft),
        {
          initialProps: { draft: origin },
        },
      );

      await act(() => result.current.start());
      state = "recording";
      rerender({ draft: other });
      act(() => result.current[action]());
      unmount();
      origin.setDraft({
        text: "Later origin edits",
        mentions: [],
        attachments: [],
      });
      await callbacks[0]?.("late transcript");

      expect(other.getCurrent().text).toBe("Other chat");

      if (action === "send") {
        expect(origin.submitDraft).toHaveBeenCalledWith(
          {
            text: "Original context late transcript",
            mentions: [],
            attachments: [],
          },
          { experimental_data: null },
          undefined,
          undefined,
          undefined,
        );
        expect(origin.getCurrent().text).toBe("Later origin edits");
      } else {
        expect(origin.getCurrent().text).toBe(
          "Later origin edits late transcript",
        );
        expect(origin.submitDraft).not.toHaveBeenCalled();
      }
    },
  );

  it("surfaces explicit submission failures to the recording job without altering later text", async () => {
    const draft = createDraft("Original context");
    draft.submitDraft.mockRejectedValueOnce(new Error("Submission failed"));

    const { result, rerender } = renderHook(() =>
      usePromptVoice(createPromptRef(), draft),
    );

    await act(() => result.current.start());
    state = "recording";
    rerender();
    act(() => result.current.send());
    draft.setDraft({ text: "Newer text", mentions: [], attachments: [] });

    await expect(callbacks[0]?.("spoken words")).rejects.toThrow(
      "Submission failed",
    );
    expect(draft.getCurrent().text).toBe("Newer text");
  });

  it("passes transcription through without a completion animation touching a newer recording", async () => {
    const promptRef = createPromptRef();
    vi.mocked(transcribeVoiceInput).mockResolvedValue({ text: "Transcript" });
    renderHook(() => usePromptVoice(promptRef));
    const options = vi.mocked(useVoiceInput).mock.calls[0]?.[0];
    const file = new File([], "recording.webm", { type: "audio/webm" });
    await expect(
      options?.onTranscribe({
        file,
        recordingId: crypto.randomUUID(),
        attempt: 1,
      }),
    ).resolves.toBe("Transcript");
    expect(
      promptRef.current.playVoiceCompletionTransition,
    ).not.toHaveBeenCalled();
  });
});
