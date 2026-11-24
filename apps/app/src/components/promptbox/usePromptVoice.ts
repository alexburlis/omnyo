import { shellHaptic } from "@/lib/native-shell/native-shell";
import { useCallback, useMemo, useRef, type RefObject } from "react";
import { useVoiceInput } from "@/hooks/useVoiceInput";
import { prepareVoiceInput, transcribeVoiceInput } from "@/lib/api";
import { beginComposerSubmission } from "@/lib/composer-submission-journal";
import {
  getPromptDraftAccessor,
  restoreFailedPromptDraft,
} from "@/hooks/usePromptDraftStorage";
import { resolvePendingThreadDraftScope } from "@/lib/pending-chat-creations";
import { appToast } from "@/components/ui/app-toast";
import { appendPromptText } from "@/lib/composer-attachment-submission";
import {
  arePromptDraftStatesEqual,
  emptyPromptDraftState,
  type PromptDraftState,
} from "@omnyo/client-core";
import type { PluginComposerHost } from "@/components/plugin/plugin-composer-host";
import type { PromptBoxHandle, PromptVoiceConfig } from "./PromptBoxInternal";

type VoiceDraft = Pick<PluginComposerHost, "getCurrent" | "setDraft"> &
  Partial<
    Pick<
      PluginComposerHost,
      | "scope"
      | "draftScope"
      | "submit"
      | "submitDraft"
      | "submitVoiceDraft"
      | "reserveSubmission"
      | "captureAttachments"
    >
  >;

function currentVoiceDraft(draft: VoiceDraft) {
  if (!draft.draftScope) return draft;
  const scope = resolvePendingThreadDraftScope(draft.draftScope);

  return scope === draft.draftScope ? draft : getPromptDraftAccessor(scope);
}

type StopVoiceInput = ReturnType<typeof useVoiceInput>["stop"];

function sendWithPendingTranscript(
  originDraft: VoiceDraft,
  submitVoiceDraft: NonNullable<VoiceDraft["submitVoiceDraft"]>,
  stop: StopVoiceInput,
  onCaptureReleased: () => void,
) {
  const current = currentVoiceDraft(originDraft);
  const submittedDraft = current.getCurrent();
  const capturedUploads = originDraft.captureAttachments?.() ?? null;
  current.setDraft(emptyPromptDraftState());
  const sendReservation = originDraft.reserveSubmission?.();
  let transcriptionFailed = false;
  let resolveTranscript: (text: string) => void = () => {};

  let rejectTranscript: (error: Error) => void = () => {};

  const transcript = new Promise<string>((resolve, reject) => {
    resolveTranscript = resolve;
    rejectTranscript = reject;
  });

  transcript.catch(() => {});

  submitVoiceDraft(
    submittedDraft,
    () => transcript,
    sendReservation,
    capturedUploads,
  ).catch((error: unknown) => {
    if (transcriptionFailed) return;
    appToast.error("Voice message not sent", {
      description:
        error instanceof Error && error.message.length > 0
          ? `${error.message} The transcript is back in the composer.`
          : "The transcript is back in the composer.",
    });
  });

  stop(
    (text) => {
      if (!transcriptionFailed) {
        resolveTranscript(text);

        return;
      }

      const recovered = currentVoiceDraft(originDraft);
      recovered.setDraft(appendPromptText(recovered.getCurrent(), text));
      appToast.message("Transcript added to the recovered draft", {
        description: "Review the draft before sending.",
      });
    },
    () => {
      transcriptionFailed = true;
      rejectTranscript(new Error("Voice transcription failed."));
    },
    false,
    false,
    onCaptureReleased,
  );
}

export function usePromptVoice(
  promptBoxRef: RefObject<PromptBoxHandle | null>,
  draft?: VoiceDraft,
): PromptVoiceConfig {
  const stoppedRef = useRef(false);

  const originRef = useRef<{
    draft: VoiceDraft | undefined;
    editor: PromptBoxHandle | null;
  } | null>(null);

  const voiceInput = useVoiceInput({
    backgroundTranscription: draft?.submitDraft !== undefined,
    onTranscript: (text) => {
      if (draft) {
        const current = currentVoiceDraft(draft);
        current.setDraft(appendPromptText(current.getCurrent(), text));
      } else promptBoxRef.current?.insertTextAtCursor(text);
    },
    onTranscribe: async ({
      file,
      promptContext,
      signal,
      recordingId,
      attempt,
    }) => {
      const result = await transcribeVoiceInput(file, promptContext, signal, {
        recordingId,
        attempt,
      });

      return result.text;
    },
    getPromptContext: () => promptBoxRef.current?.getTextBeforeCursor(),
    onPrepare: () => {
      shellHaptic("impact-light");
      prepareVoiceInput();
    },
  });

  const start = useCallback(() => {
    if (voiceInput.state === "starting" || voiceInput.state === "recording")
      return;
    stoppedRef.current = false;
    originRef.current = { draft, editor: promptBoxRef.current };

    return voiceInput.start();
  }, [draft, promptBoxRef, voiceInput]);

  const accept = useCallback(
    (send: boolean) => {
      if (voiceInput.state !== "recording" || stoppedRef.current) return;
      stoppedRef.current = true;

      const origin = originRef.current ?? {
        draft,
        editor: promptBoxRef.current,
      };

      const originDraft = origin.draft;

      if (send && originDraft?.submitVoiceDraft) {
        sendWithPendingTranscript(
          originDraft,
          originDraft.submitVoiceDraft,
          voiceInput.stop,
          () => shellHaptic("impact-light"),
        );

        return;
      }

      const submittedDraft =
        send && originDraft?.submitDraft
          ? currentVoiceDraft(originDraft).getCurrent()
          : null;

      let capturedUploads = submittedDraft
        ? originDraft?.captureAttachments?.()
        : null;

      let recoverToDraft = false;

      const prefixRecovery =
        submittedDraft && originDraft?.draftScope
          ? beginComposerSubmission({
              scope: originDraft.draftScope,
              draft: submittedDraft,
            })
          : null;

      let restoredPrefix: {
        previous: PromptDraftState;
        restored: PromptDraftState;
      } | null = null;

      if (submittedDraft && originDraft)
        currentVoiceDraft(originDraft).setDraft(emptyPromptDraftState());

      let sendReservation = submittedDraft
        ? originDraft?.reserveSubmission?.()
        : undefined;

      voiceInput.stop(
        async (text) => {
          if (recoverToDraft && originDraft) {
            const current = currentVoiceDraft(originDraft);
            current.setDraft(appendPromptText(current.getCurrent(), text));
            appToast.message("Transcript added to the recovered draft", {
              description: "Review the draft before sending.",
            });

            return;
          }

          if (submittedDraft && originDraft?.submitDraft) {
            const completedDraft = appendPromptText(submittedDraft, text);

            if (
              restoredPrefix &&
              arePromptDraftStatesEqual(
                currentVoiceDraft(originDraft).getCurrent(),
                restoredPrefix.restored,
              )
            ) {
              currentVoiceDraft(originDraft).setDraft(restoredPrefix.previous);
            }

            sendReservation ??= originDraft.reserveSubmission?.();

            try {
              const submission = originDraft.submitDraft(
                completedDraft,
                { experimental_data: null },
                undefined,
                sendReservation,
                capturedUploads,
              );

              prefixRecovery?.complete();
              await submission;
            } finally {
              sendReservation?.cancel();
              sendReservation = undefined;
              capturedUploads = null;
            }

            return;
          }

          if (originDraft) {
            const current = currentVoiceDraft(originDraft);
            current.setDraft(appendPromptText(current.getCurrent(), text));

            if (send)
              await originDraft.submit?.(
                { experimental_data: null },
                undefined,
              );
          } else if (send) {
            origin.editor?.sendVoiceTranscript(text);
          } else {
            origin.editor?.insertTextAtCursor(text);
          }
        },
        () => {
          sendReservation?.cancel();
          sendReservation = undefined;

          if (capturedUploads) {
            capturedUploads.restore();
            capturedUploads = null;
            recoverToDraft = true;
          }

          if (restoredPrefix || !submittedDraft || !originDraft?.draftScope)
            return;
          const previous = currentVoiceDraft(originDraft).getCurrent();
          restoreFailedPromptDraft(
            resolvePendingThreadDraftScope(originDraft.draftScope),
            submittedDraft,
          );
          restoredPrefix = {
            previous,
            restored: currentVoiceDraft(originDraft).getCurrent(),
          };
          prefixRecovery?.complete();
        },
        submittedDraft === null,
        true,
        !send
          ? () => shellHaptic("selection")
          : originDraft?.submitDraft || originDraft?.submit
            ? () => shellHaptic("impact-light")
            : undefined,
      );
    },
    [draft, promptBoxRef, voiceInput],
  );

  const stop = useCallback(() => accept(false), [accept]);
  const send = useCallback(() => accept(true), [accept]);

  const cancel = useCallback(() => {
    stoppedRef.current = false;
    voiceInput.cancel();
  }, [voiceInput]);

  return useMemo<PromptVoiceConfig>(
    () => ({
      state: voiceInput.state,
      microphoneWarning: voiceInput.microphoneWarning,
      isSupported: voiceInput.isSupported,
      stream: voiceInput.stream,
      start,
      stop,
      send,
      cancel,
    }),
    [
      voiceInput.state,
      voiceInput.microphoneWarning,
      voiceInput.isSupported,
      voiceInput.stream,
      start,
      stop,
      send,
      cancel,
    ],
  );
}
