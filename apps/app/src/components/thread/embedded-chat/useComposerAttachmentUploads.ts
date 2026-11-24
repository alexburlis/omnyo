import { useCallback, useState } from "react";
import {
  usePendingAttachmentUploads,
  attachmentUploadFailure,
  attachmentUploadTargetKey,
  type CapturedAttachmentUploads,
  type PendingAttachmentUpload,
} from "@/components/promptbox/usePendingAttachmentUploads";
import { useUploadPromptAttachment } from "@/hooks/mutations/project-mutations";
import { getMutationErrorMessage } from "@/lib/mutation-errors";
import { OmnyoHttpError } from "@/lib/sdk";
import type { PromptDraftAttachment } from "@omnyo/client-core";
import { PROMPT_ATTACHMENT_MAX_BYTES } from "@omnyo/domain";
import type { InlineComposerDraftSession } from "./useActiveComposerDraft";

interface UseComposerAttachmentUploadsArgs {
  projectId: string;
  draftKey: string;
  addDraftAttachment: (attachment: PromptDraftAttachment) => void;
  inlineEditSessionId: number | null;
  inlineSessionRef: React.RefObject<InlineComposerDraftSession | null>;
}

interface UseComposerAttachmentUploadsResult {
  bottomAttachmentError: string | null;
  setBottomAttachmentError: (error: string | null) => void;
  handleAttachBottomFiles: (files: File[]) => Promise<PromptDraftAttachment[]>;
  isAttachingBottomFiles: boolean;
  bottomPendingUploads: readonly PendingAttachmentUpload[];
  captureBottomUploads: () => CapturedAttachmentUploads | null;
  inlineAttachmentError: string | null;
  setInlineAttachmentError: (error: string | null) => void;
  handleAttachInlineFiles: (files: File[]) => Promise<PromptDraftAttachment[]>;
  isAttachingInlineFiles: boolean;
  inlinePendingUploads: readonly PendingAttachmentUpload[];
}

interface DraftAttachmentUploadTarget {
  key: string;
  addAttachment: (attachment: PromptDraftAttachment) => void;
}

interface UseDraftAttachmentUploadsArgs {
  projectId: string;
  target: DraftAttachmentUploadTarget | null;
}

interface UseDraftAttachmentUploadsResult {
  attachmentError: string | null;
  setAttachmentError: (error: string | null) => void;
  handleAttachFiles: (files: File[]) => Promise<PromptDraftAttachment[]>;
  isAttachingFiles: boolean;
  pendingUploads: readonly PendingAttachmentUpload[];
  capturePendingUploads: () => CapturedAttachmentUploads | null;
}

function uploadRejectionReason(error: unknown): string | null {
  if (!(error instanceof OmnyoHttpError) && !(error instanceof RangeError))
    return null;
  const reason = getMutationErrorMessage({ error, fallbackMessage: "" });

  if (
    error instanceof OmnyoHttpError &&
    error.status === 413 &&
    (!reason ||
      /^(?:HTTP 413:\s*)?(413|payload too large|request entity too large|content too large|request failed(?: with status 413)?)$/iu.test(
        reason,
      ))
  ) {
    const limitMiB = PROMPT_ATTACHMENT_MAX_BYTES / (1024 * 1024);

    return `Upload rejected as too large (${limitMiB} MiB attachment limit). Trim or compress the file; a proxy may enforce a lower limit.`;
  }

  return reason || "Request failed";
}

export function useDraftAttachmentUploads({
  projectId,
  target,
}: UseDraftAttachmentUploadsArgs): UseDraftAttachmentUploadsResult {
  const uploadPromptAttachment = useUploadPromptAttachment();

  const targetKey = target?.key ?? null;

  const [localError, setLocalError] = useState<{
    targetKey: string | null;
    error: string | null;
  }>({ targetKey: null, error: null });

  const { pendingUploads, startUploads, capturePendingUploads } =
    usePendingAttachmentUploads(
      targetKey === null
        ? null
        : attachmentUploadTargetKey(projectId, targetKey),
    );

  const setAttachmentError = useCallback(
    (error: string | null) => {
      setLocalError({ targetKey, error });
    },
    [targetKey],
  );

  const handleAttachFiles = useCallback(
    async (files: File[]) => {
      const activeTarget = target;

      if (!activeTarget || files.length === 0) return [];
      setAttachmentError(null);

      const attached = await startUploads(files, {
        upload: (file, signal) =>
          uploadPromptAttachment.mutateAsync({ projectId, file, signal }),
        onUploaded: activeTarget.addAttachment,
        rejectionReason: uploadRejectionReason,
      });

      return attached;
    },
    [
      projectId,
      setAttachmentError,
      startUploads,
      target,
      uploadPromptAttachment,
    ],
  );

  const failed = pendingUploads.filter((upload) => upload.status === "failed");

  const attachmentError =
    attachmentUploadFailure(
      failed.map((upload) => ({
        file: upload.file,
        reason: upload.error ?? null,
      })),
    ) ?? (localError.targetKey === targetKey ? localError.error : null);

  return {
    attachmentError,
    setAttachmentError,
    handleAttachFiles,
    isAttachingFiles: pendingUploads.some(
      (upload) => upload.status !== "failed",
    ),
    pendingUploads,
    capturePendingUploads,
  };
}

export function useComposerAttachmentUploads({
  projectId,
  draftKey,
  addDraftAttachment,
  inlineEditSessionId,
  inlineSessionRef,
}: UseComposerAttachmentUploadsArgs): UseComposerAttachmentUploadsResult {
  const {
    attachmentError: bottomAttachmentError,
    setAttachmentError: setBottomAttachmentError,
    handleAttachFiles: handleAttachBottomFiles,
    isAttachingFiles: isAttachingBottomFiles,
    pendingUploads: bottomPendingUploads,
    capturePendingUploads: captureBottomUploads,
  } = useDraftAttachmentUploads({
    projectId,
    target: { key: draftKey, addAttachment: addDraftAttachment },
  });

  const addInlineAttachment = useCallback(
    (uploaded: PromptDraftAttachment) => {
      const current = inlineSessionRef.current;

      if (current === null || current.editSessionId !== inlineEditSessionId) {
        return;
      }

      current.setDraft((draft) =>
        draft.attachments.some((existing) => existing.path === uploaded.path)
          ? draft
          : { ...draft, attachments: [...draft.attachments, uploaded] },
      );
    },
    [inlineEditSessionId, inlineSessionRef],
  );

  const {
    attachmentError: inlineAttachmentError,
    setAttachmentError: setInlineAttachmentError,
    handleAttachFiles: handleAttachInlineFiles,
    isAttachingFiles: isAttachingInlineFiles,
    pendingUploads: inlinePendingUploads,
  } = useDraftAttachmentUploads({
    projectId,
    target:
      inlineEditSessionId !== null
        ? {
            key: `${draftKey}\0inline/${inlineEditSessionId}`,
            addAttachment: addInlineAttachment,
          }
        : null,
  });

  return {
    bottomAttachmentError,
    setBottomAttachmentError,
    handleAttachBottomFiles,
    isAttachingBottomFiles,
    bottomPendingUploads,
    captureBottomUploads,
    inlineAttachmentError,
    setInlineAttachmentError,
    handleAttachInlineFiles,
    isAttachingInlineFiles,
    inlinePendingUploads,
  };
}
