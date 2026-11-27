import type { QueryClient } from "@tanstack/react-query";
import {
  buildCreateQueuedFollowUpRequest,
  type FollowUpExecutionSelection,
  type PromptDraftAttachment,
} from "@omnyo/client-core";
import type { prepareComposerAttachmentSubmission } from "../composer-attachment-submission";
import { createSubmissionId } from "./send-outbox-entry";
import {
  buildOutboxMessageInput,
  isSendOutboxAvailable,
  stageThreadMessageInOutbox,
  trackOutboxThreadMessage,
} from "./send-outbox";
import {
  addStagingFollowUp,
  removeStagingFollowUp,
} from "./staging-follow-ups";

export async function stageTimelineFollowUp({
  queryClient,
  threadId,
  projectId,
  submission,
  execution,
  sourceOf,
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
}): Promise<boolean> {
  const submissionId = createSubmissionId();

  addStagingFollowUp({
    submissionId,
    threadId,
    input: submission.input,
    createdAt: Date.now(),
  });

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
    removeStagingFollowUp(submissionId);
  }
}
