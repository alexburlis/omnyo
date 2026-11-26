import type { QueryClient } from "@tanstack/react-query";
import {
  buildCreateQueuedFollowUpRequest,
  type FollowUpExecutionSelection,
  type PromptDraftAttachment,
} from "@omnyo/client-core";
import type { prepareComposerAttachmentSubmission } from "../composer-attachment-submission";
import { buildOptimisticUserMessageRow } from "@/hooks/cache-owners/optimistic-user-message";
import {
  addPendingSentMessage,
  removePendingSentMessage,
} from "@/hooks/cache-owners/pending-sent-messages";
import { createSubmissionId } from "./send-outbox-entry";
import {
  buildOutboxMessageInput,
  isSendOutboxAvailable,
  stageThreadMessageInOutbox,
  trackOutboxThreadMessage,
} from "./send-outbox";

export async function stageTimelineFollowUp({
  queryClient,
  threadId,
  projectId,
  submission,
  execution,
  sourceOf,
  showsInChat,
}: {
  queryClient: QueryClient;
  threadId: string;
  projectId: string;
  submission: Pick<
    ReturnType<typeof prepareComposerAttachmentSubmission>,
    "input" | "getDraft" | "prepareInput"
  >;
  execution: FollowUpExecutionSelection;
  sourceOf: (attachment: PromptDraftAttachment) => File | null;
  showsInChat: boolean;
}): Promise<boolean> {
  const submissionId = createSubmissionId();

  const row = buildOptimisticUserMessageRow({
    submissionId,
    createdAt: Date.now(),
    clientRequestId: null,
    input: submission.input,
    mode: "queue-if-active",
    threadId,
    threadStatus: null,
  });

  if (showsInChat) addPendingSentMessage(queryClient, threadId, row);

  const prediction = trackOutboxThreadMessage({
    queryClient,
    threadId,
    submissionId,
  });

  let stagedInOutbox = false;

  try {
    if (!(await isSendOutboxAvailable())) return false;

    const request = buildCreateQueuedFollowUpRequest({
      threadId,
      input: submission.prepareInput
        ? await submission.prepareInput()
        : submission.input,
      execution,
    });

    if (!request) return false;
    const { id: _threadId, ...message } = request;

    const staged = await buildOutboxMessageInput({
      attachments: submission.getDraft().attachments,
      input: message.input,
      sourceOf,
    });

    stagedInOutbox =
      (await stageThreadMessageInOutbox({
        threadId,
        projectId,
        submissionId,
        attachments: staged.attachments,
        message: {
          ...message,
          input: staged.input.map((part) => ({ ...part, submissionId })),
          messageSource: { kind: "user" },
        },
      })) === "staged";

    return stagedInOutbox;
  } finally {
    if (!stagedInOutbox) prediction.discard();
    removePendingSentMessage(queryClient, threadId, row.id);
  }
}
