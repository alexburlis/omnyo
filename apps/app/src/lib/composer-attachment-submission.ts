import {
  promptDraftToInput,
  type PromptDraftAttachment,
  type PromptDraftState,
} from "@omnyo/client-core";
import { pendingImageAnchorPathForFile } from "@/components/promptbox/editor/prompt-image-anchor";
import { uploadedAttachmentSource } from "@/components/promptbox/usePendingAttachmentUploads";
import type { PromptInput } from "@omnyo/domain";
import type { CapturedAttachmentUploads } from "@/components/promptbox/usePendingAttachmentUploads";
import type { PromptDraftScope } from "@/hooks/usePromptDraftStorage";
import {
  addConversationInput,
  type EmbeddedConversation,
} from "./embedded-conversation";
import { beginComposerSubmission } from "./composer-submission-journal";

function bindUploadedImageAnchors(
  draft: PromptDraftState,
  attachments: readonly PromptDraftAttachment[],
): PromptDraftState {
  const bound = new Map<string, PromptDraftAttachment>();

  const uploaded = attachments.flatMap((attachment) => {
    const file = uploadedAttachmentSource(attachment);
    const pendingPath = file ? pendingImageAnchorPathForFile(file) : null;

    const anchor = draft.mentions.find(
      (mention) =>
        mention.resource.kind === "attachment" &&
        mention.resource.path === pendingPath,
    )?.resource;

    if (pendingPath === null || attachment.type !== "localImage")
      return [attachment];

    if (anchor?.kind !== "attachment") return [];
    const aliased = { ...attachment, alias: anchor.label };
    bound.set(pendingPath, aliased);

    return [aliased];
  });

  return {
    ...draft,
    mentions: draft.mentions.map((mention) => {
      if (mention.resource.kind !== "attachment") return mention;
      const attachment = bound.get(mention.resource.path);

      return attachment
        ? {
            ...mention,
            resource: { ...mention.resource, path: attachment.path },
          }
        : mention;
    }),
    attachments: [...draft.attachments, ...uploaded],
  };
}

export function appendPromptText(
  draft: PromptDraftState,
  text: string,
): PromptDraftState {
  const separator = draft.text.length > 0 && !/\s$/.test(draft.text) ? " " : "";

  return { ...draft, text: `${draft.text}${separator}${text}` };
}

export const PENDING_VOICE_TRANSCRIPT_LABEL = "Transcribing voice message…";

export function prepareComposerAttachmentSubmission({
  draft,
  scope,
  uploads,
  conversation,
  pendingTranscript,
}: {
  draft: PromptDraftState;
  scope: PromptDraftScope;
  uploads: CapturedAttachmentUploads | null;
  conversation?: EmbeddedConversation;
  pendingTranscript?: () => Promise<string>;
}) {
  let acceptedDraft = draft;
  let journal = beginComposerSubmission({ scope, draft });
  const knownInput = promptDraftToInput(draft);

  const acceptDraft = (next: PromptDraftState) => {
    acceptedDraft = next;
    const nextJournal = beginComposerSubmission({ scope, draft: next });
    journal.complete();
    journal = nextJournal;
  };

  const input: PromptInput[] = pendingTranscript
    ? addConversationInput(
        [
          ...knownInput,
          { type: "text", text: PENDING_VOICE_TRANSCRIPT_LABEL, mentions: [] },
        ],
        conversation,
      )
    : knownInput.length > 0 || uploads === null
      ? addConversationInput(knownInput, conversation)
      : [
          {
            type: "text",
            text: `Uploading ${uploads.files.map((file) => file.name).join(", ")}`,
            mentions: [],
          },
        ];

  const prepareInput =
    uploads === null && !pendingTranscript
      ? undefined
      : async () => {
          let prepared = draft;

          if (uploads !== null) {
            const result = await uploads.wait();
            prepared = bindUploadedImageAnchors(draft, result.attachments);
            acceptDraft(prepared);

            if (result.error !== null) throw new Error(result.error);
          }

          if (pendingTranscript) {
            prepared = appendPromptText(prepared, await pendingTranscript());
            acceptDraft(prepared);
          }

          const preparedInput = promptDraftToInput(prepared);

          if (preparedInput.length === 0)
            throw new Error("The attachment did not finish uploading.");

          return addConversationInput(preparedInput, conversation);
        };

  return {
    input,
    prepareInput,
    getDraft: () => acceptedDraft,
    complete: () => journal.complete(),
    restoreFailed(restore: (failedDraft: PromptDraftState) => void) {
      uploads?.restore();
      restore(acceptedDraft);
      journal.complete();
    },
  };
}
