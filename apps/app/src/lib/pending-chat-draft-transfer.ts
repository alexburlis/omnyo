import {
  getPromptDraftAccessor,
  movePromptDraft,
  type PromptDraftScope,
} from "@/hooks/usePromptDraftStorage";
import {
  attachmentUploadTargetKey,
  movePendingAttachmentUploads,
} from "@/components/promptbox/usePendingAttachmentUploads";

export function movePendingChatDraft(
  projectId: string,
  threadId: string,
  destination: PromptDraftScope,
): void {
  const source: PromptDraftScope = { kind: "thread", projectId, threadId };
  movePromptDraft(source, destination);
  movePendingAttachmentUploads(
    attachmentUploadTargetKey(
      projectId,
      getPromptDraftAccessor(source).storageKey,
    ),
    attachmentUploadTargetKey(
      destination.kind === "thread" ? destination.projectId : projectId,
      getPromptDraftAccessor(destination).storageKey,
    ),
  );
}
