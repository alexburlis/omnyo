import type { ClientTurnRequestId, ThreadWithRuntime } from "@omnyo/domain";
import type {
  TimelineConversationAttachments,
  TimelineUserConversationRow,
} from "@omnyo/server-contract";
import type { SendThreadMessageMutationRequest } from "../mutations/mutation-request-types";
import { collectPromptAttachments } from "@/lib/prompt-attachments";
import { nanoid } from "nanoid";

interface BuildOptimisticUserMessageRowParams {
  submissionId?: string;
  createdAt: number;
  clientRequestId: ClientTurnRequestId | null;
  input: SendThreadMessageMutationRequest["input"];
  mode: SendThreadMessageMutationRequest["mode"];
  threadId: string;
  threadStatus: ThreadWithRuntime["status"] | null;
}

type OptimisticTurnRequestKind = "message" | "steer";

interface OptimisticTurnRequestKindArgs {
  mode: SendThreadMessageMutationRequest["mode"];
  threadStatus: ThreadWithRuntime["status"] | null;
}

function optimisticTurnRequestKind({
  mode,
  threadStatus,
}: OptimisticTurnRequestKindArgs): OptimisticTurnRequestKind {
  if (mode === "steer" || mode === "steer-if-active") {
    return "steer";
  }

  if (mode === "auto" && threadStatus === "active") {
    return "steer";
  }

  return "message";
}

export function buildOptimisticUserMessageRow({
  submissionId,
  clientRequestId,
  createdAt,
  input,
  mode,
  threadId,
  threadStatus,
}: BuildOptimisticUserMessageRowParams): TimelineUserConversationRow {
  const id = `optimistic-user-${submissionId ?? nanoid()}`;

  const text = input
    .filter(
      (entry): entry is Extract<typeof entry, { type: "text" }> =>
        entry.type === "text" && entry.visibility !== "agent-only",
    )
    .map((entry) => entry.text)
    .join("\n\n");

  const attachments = collectPromptAttachments(
    input.filter((part) => part.visibility !== "agent-only"),
  );

  const timelineAttachments: TimelineConversationAttachments | null =
    attachments
      ? {
          webImages: attachments.webImages,
          localImages: attachments.localImages,
          localFiles: attachments.localFiles,
          imageUrls: attachments.imageUrls ?? [],
          localImagePaths: attachments.localImagePaths ?? [],
          localFilePaths: attachments.localFilePaths ?? [],
          localFileDetails: attachments.localFileDetails ?? [],
        }
      : null;

  return {
    id,
    kind: "conversation",
    role: "user",
    threadId,
    turnId: null,
    messageSeq: 0,
    sourceSeqStart: 0,
    sourceSeqEnd: 0,
    startedAt: createdAt,
    createdAt,
    text,
    mentions: [],
    attachments: timelineAttachments,
    initiator: "user",
    senderThreadId: null,
    systemMessageKind: "unlabeled",
    systemMessageSubject: null,
    turnRequest: {
      ...(submissionId ? { submissionId } : {}),
      clientRequestId,
      isGrouped: false,
      kind: optimisticTurnRequestKind({ mode, threadStatus }),
      status: "pending",
    },
  };
}
