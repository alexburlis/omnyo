import { useCallback, useMemo, useRef, useState } from "react";
import type { PromptInput, ThreadQueuedMessage } from "@omnyo/domain";
import type { SendQueuedMessageMode } from "@omnyo/server-contract";
import type {
  QueuedMessageGroupBoundaryRequest,
  QueuedMessageProcessingAction,
} from "@/components/promptbox/banner/LazyQueuedMessagesList";
import { useActionHistory } from "@/components/layout/ActionHistoryProvider";
import { appToast } from "@/components/ui/app-toast";
import {
  useDeleteThreadQueuedMessage,
  useReorderThreadQueuedMessage,
  useRestoreThreadQueuedMessage,
  useSendThreadQueuedMessage,
  useSetThreadQueuedMessageGroupBoundary,
  useUpdateThreadQueuedMessage,
} from "@/hooks/mutations/thread-runtime-mutations";
import { trackActionOutcome, type HistoryEntry } from "@/lib/action-history";
import { isQueuedMessageNotFoundError } from "@/lib/http-error";
import { showMutationErrorToast } from "@/lib/mutation-errors";
import {
  collectLeadQueuedMessageGroupIds,
  type QueuedMessageReorderRequest,
} from "@/lib/queued-message-reorder";
import { OmnyoHttpError } from "@/lib/sdk";
import type { InlineQueuedMessageEditState } from "./useInlineQueuedMessageEditing";

type QueuedMessageSendGuard = "current-head" | "exists" | "none";

const QUEUED_MESSAGE_UNDO_TOAST_DURATION_MS = 10_000;

function queuedMessageNoun(queuedMessage: ThreadQueuedMessage | undefined) {
  return queuedMessage?.sendAt === null || queuedMessage === undefined
    ? "queued message"
    : "scheduled message";
}

function reorderUndoRequest(
  queuedMessages: readonly ThreadQueuedMessage[],
  request: QueuedMessageReorderRequest,
): QueuedMessageReorderRequest | null {
  const index = queuedMessages.findIndex(
    (message) => message.id === request.queuedMessageId,
  );

  if (index === -1) return null;

  const previousQueuedMessageId = queuedMessages[index - 1]?.id ?? null;
  const nextQueuedMessageId = queuedMessages[index + 1]?.id ?? null;

  if (
    request.groupBoundaryQueuedMessageId === undefined &&
    request.previousQueuedMessageId === previousQueuedMessageId &&
    request.nextQueuedMessageId === nextQueuedMessageId
  ) {
    return null;
  }

  return {
    queuedMessageId: request.queuedMessageId,
    previousQueuedMessageId,
    nextQueuedMessageId,
    groupBoundaryQueuedMessageId:
      collectLeadQueuedMessageGroupIds(queuedMessages).at(-1),
  };
}

function groupBoundaryUndoRequest(
  queuedMessages: readonly ThreadQueuedMessage[],
  request: QueuedMessageGroupBoundaryRequest,
): QueuedMessageGroupBoundaryRequest | null {
  const leadGroupIds = collectLeadQueuedMessageGroupIds(queuedMessages);
  const groupBoundaryQueuedMessageId = leadGroupIds.at(-1);

  if (
    groupBoundaryQueuedMessageId === undefined ||
    groupBoundaryQueuedMessageId === request.groupBoundaryQueuedMessageId
  ) {
    return null;
  }

  return {
    expectedGroupedPrefixQueuedMessageIds: leadGroupIds,
    groupBoundaryQueuedMessageId,
  };
}

type QueuedMessageExecution = Pick<
  ThreadQueuedMessage,
  "model" | "permissionMode" | "reasoningLevel" | "serviceTier"
>;

function queuedMessageExecution(
  message: QueuedMessageExecution,
): QueuedMessageExecution {
  return {
    model: message.model,
    permissionMode: message.permissionMode,
    reasoningLevel: message.reasoningLevel,
    serviceTier: message.serviceTier,
  };
}

function changedQueuedMessageExecution(
  previous: QueuedMessageExecution | undefined,
  edited: QueuedMessageExecution,
): Partial<QueuedMessageExecution> {
  if (
    previous !== undefined &&
    previous.model === edited.model &&
    previous.permissionMode === edited.permissionMode &&
    previous.reasoningLevel === edited.reasoningLevel &&
    previous.serviceTier === edited.serviceTier
  ) {
    return {};
  }

  return queuedMessageExecution(edited);
}

interface SendQueuedMessageByIdArgs {
  guard: QueuedMessageSendGuard;
  messageId: string;
  mode: SendQueuedMessageMode;
}

interface UseQueuedMessageActionsArgs {
  threadId: string;
  queuedMessages: readonly ThreadQueuedMessage[];
  sendProcessingPersistence: "clear-on-settle" | "until-left-queue";
  onSendSuccess?: () => void;
  onSaveSuccess?: () => void;
  inlineEditingQueuedMessage: InlineQueuedMessageEditState | null;
  dismissInlineQueuedMessageEditor: () => void;
  activeComposerDraftInput: PromptInput[];
}

interface UseQueuedMessageActionsResult {
  processingQueuedMessage: {
    action: QueuedMessageProcessingAction;
    id: string;
  } | null;
  queuedMessageActionPending: boolean;
  isUpdateQueuedMessagePending: boolean;
  sendQueuedMessageById: (args: SendQueuedMessageByIdArgs) => Promise<void>;
  handleSaveInlineQueuedMessage: () => Promise<void>;
  handleDeleteQueuedMessage: (queuedMessageId: string) => void;
  handleReorderQueuedMessage: (request: QueuedMessageReorderRequest) => void;
  handleSetQueuedMessageGroupBoundary: (
    request: QueuedMessageGroupBoundaryRequest,
  ) => void;
}

export function useQueuedMessageActions({
  threadId,
  queuedMessages,
  sendProcessingPersistence,
  onSendSuccess,
  onSaveSuccess,
  inlineEditingQueuedMessage,
  dismissInlineQueuedMessageEditor,
  activeComposerDraftInput,
}: UseQueuedMessageActionsArgs): UseQueuedMessageActionsResult {
  const inlineEditingRef = useRef(inlineEditingQueuedMessage);
  inlineEditingRef.current = inlineEditingQueuedMessage;
  const history = useActionHistory();
  const updateQueuedMessage = useUpdateThreadQueuedMessage();
  const sendQueuedMessage = useSendThreadQueuedMessage();
  const deleteQueuedMessage = useDeleteThreadQueuedMessage();
  const restoreQueuedMessage = useRestoreThreadQueuedMessage();
  const reorderQueuedMessage = useReorderThreadQueuedMessage();

  const setQueuedMessageGroupBoundary =
    useSetThreadQueuedMessageGroupBoundary();

  const [processingQueuedMessage, setProcessingQueuedMessage] = useState<{
    action: QueuedMessageProcessingAction;
    id: string;
  } | null>(null);

  const queuedMessagesRef = useRef<readonly ThreadQueuedMessage[]>([]);
  queuedMessagesRef.current = queuedMessages;

  const displayedProcessingQueuedMessage = useMemo(
    () =>
      sendProcessingPersistence === "until-left-queue"
        ? processingQueuedMessage &&
          queuedMessages.some(
            (message) => message.id === processingQueuedMessage.id,
          )
          ? processingQueuedMessage
          : null
        : processingQueuedMessage,
    [processingQueuedMessage, queuedMessages, sendProcessingPersistence],
  );

  const sendQueuedMessageById = useCallback(
    async ({ guard, messageId, mode }: SendQueuedMessageByIdArgs) => {
      if (messageId.startsWith("optimistic-queued-")) return;

      if (
        guard !== "none" &&
        !queuedMessagesRef.current.some((message) => message.id === messageId)
      ) {
        return;
      }

      if (
        guard === "current-head" &&
        queuedMessagesRef.current[0]?.id !== messageId
      ) {
        return;
      }

      setProcessingQueuedMessage({ id: messageId, action: "send" });

      try {
        await sendQueuedMessage.mutateAsync({
          id: threadId,
          mode,
          queuedMessageId: messageId,
        });
        onSendSuccess?.();

        if (
          mode === "steer" ||
          sendProcessingPersistence === "clear-on-settle"
        ) {
          setProcessingQueuedMessage((current) =>
            current?.id === messageId ? null : current,
          );
        }
      } catch (error) {
        if (!isQueuedMessageNotFoundError(error))
          showMutationErrorToast({
            error,
            fallbackMessage: "Failed to send queued message",
            lifecycleOperation: "send_queued_message",
          });
        setProcessingQueuedMessage((current) =>
          current?.id === messageId ? null : current,
        );
      }
    },
    [onSendSuccess, sendProcessingPersistence, sendQueuedMessage, threadId],
  );

  const handleSaveInlineQueuedMessage = useCallback(async () => {
    if (
      !inlineEditingQueuedMessage ||
      inlineEditingQueuedMessage.queuedMessageId.startsWith(
        "optimistic-queued-",
      ) ||
      activeComposerDraftInput.length === 0 ||
      updateQueuedMessage.isPending
    ) {
      return;
    }

    if (
      inlineEditingQueuedMessage.ownerThreadId !== threadId ||
      !queuedMessagesRef.current.some(
        (message) => message.id === inlineEditingQueuedMessage.queuedMessageId,
      )
    ) {
      dismissInlineQueuedMessageEditor();

      return;
    }

    const { editSessionId, expectedUpdatedAt, ownerThreadId, queuedMessageId } =
      inlineEditingQueuedMessage;

    const keyboardRevision = history.keyboardRevision;

    const previous = queuedMessagesRef.current.find(
      (message) => message.id === queuedMessageId,
    );

    setProcessingQueuedMessage({ id: queuedMessageId, action: "edit" });

    try {
      const updated = await updateQueuedMessage.mutateAsync({
        ...changedQueuedMessageExecution(previous, inlineEditingQueuedMessage),
        expectedUpdatedAt,
        id: ownerThreadId,
        input: activeComposerDraftInput,
        queuedMessageId,
      });

      if (previous !== undefined) {
        let latestUpdatedAt = updated.updatedAt;

        const applyVersion = async (version: ThreadQueuedMessage) => {
          const result = await updateQueuedMessage.mutateAsync({
            ...queuedMessageExecution(version),
            expectedUpdatedAt: latestUpdatedAt,
            id: ownerThreadId,
            input: version.content,
            queuedMessageId,
          });

          latestUpdatedAt = result.updatedAt;
        };

        history.record(
          {
            label: `Edit ${queuedMessageNoun(previous)}`,
            undo: () => applyVersion(previous),
            redo: () => applyVersion(updated),
          },
          keyboardRevision,
        );
      }

      if (inlineEditingRef.current?.editSessionId === editSessionId) {
        onSaveSuccess?.();
        dismissInlineQueuedMessageEditor();
      }
    } catch (error) {
      if (
        error instanceof OmnyoHttpError &&
        error.status === 404 &&
        inlineEditingRef.current?.editSessionId === editSessionId
      ) {
        dismissInlineQueuedMessageEditor();
      }

      showMutationErrorToast({
        error,
        fallbackMessage: "Failed to update queued message",
        lifecycleOperation: "update_queued_message",
      });
    } finally {
      setProcessingQueuedMessage((current) =>
        current?.id === queuedMessageId ? null : current,
      );
    }
  }, [
    activeComposerDraftInput,
    dismissInlineQueuedMessageEditor,
    history,
    inlineEditingQueuedMessage,
    onSaveSuccess,
    threadId,
    updateQueuedMessage,
  ]);

  const handleDeleteQueuedMessage = useCallback(
    (queuedMessageId: string) => {
      if (queuedMessageId.startsWith("optimistic-queued-")) return;

      const keyboardRevision = history.keyboardRevision;
      const target = { id: threadId, queuedMessageId };
      const toastId = `queued-message-deleted-${queuedMessageId}`;

      const noun = queuedMessageNoun(
        queuedMessagesRef.current.find(
          (message) => message.id === queuedMessageId,
        ),
      );

      setProcessingQueuedMessage({ id: queuedMessageId, action: "delete" });

      const deletion = deleteQueuedMessage.mutateAsync(target);
      const deletionOutcome = trackActionOutcome(deletion);

      const entry: HistoryEntry = {
        label: `Delete ${noun}`,
        undo: async () => {
          if ((await deletionOutcome.settled) !== "deleted") return;
          await restoreQueuedMessage.mutateAsync(target);
        },
        redo: async () => {
          await deleteQueuedMessage.mutateAsync(target);
        },
      };

      const withdraw = () => {
        history.forget(entry);
        appToast.dismiss(toastId);
      };

      void deletion
        .then(
          (outcome) => {
            if (outcome !== "deleted") withdraw();
          },
          (error: unknown) => {
            withdraw();
            showMutationErrorToast({
              error,
              fallbackMessage: "Failed to delete queued message",
              lifecycleOperation: "queue_message",
            });
          },
        )
        .finally(() => {
          setProcessingQueuedMessage((current) =>
            current?.id === queuedMessageId ? null : current,
          );
        });

      history.record(entry, keyboardRevision);
      appToast.success(
        `${noun.charAt(0).toUpperCase()}${noun.slice(1)} deleted`,
        {
          undo: () => {
            history.undoEntry(entry).catch((error: unknown) => {
              showMutationErrorToast({
                error,
                fallbackMessage: `Failed to restore ${noun}`,
              });
            });
          },
          duration: QUEUED_MESSAGE_UNDO_TOAST_DURATION_MS,
          id: toastId,
        },
      );
    },
    [deleteQueuedMessage, history, restoreQueuedMessage, threadId],
  );

  const handleReorderQueuedMessage = useCallback(
    (request: QueuedMessageReorderRequest) => {
      if (
        [
          request.queuedMessageId,
          request.previousQueuedMessageId,
          request.nextQueuedMessageId,
          request.groupBoundaryQueuedMessageId,
        ].some((id) => id?.startsWith("optimistic-queued-"))
      )
        return;
      const keyboardRevision = history.keyboardRevision;

      const undoRequest = reorderUndoRequest(
        queuedMessagesRef.current,
        request,
      );

      void reorderQueuedMessage
        .mutateAsync({
          ...request,
          id: threadId,
        })
        .then(() => {
          if (undoRequest === null) return;
          history.record(
            {
              label: "Reorder queued messages",
              undo: async () => {
                await reorderQueuedMessage.mutateAsync({
                  ...undoRequest,
                  id: threadId,
                });
              },
              redo: async () => {
                await reorderQueuedMessage.mutateAsync({
                  ...request,
                  id: threadId,
                });
              },
            },
            keyboardRevision,
          );
        })
        .catch((error) => {
          showMutationErrorToast({
            error,
            fallbackMessage: "Failed to reorder queued message",
            lifecycleOperation: "reorder_queued_message",
          });
        });
    },
    [history, reorderQueuedMessage, threadId],
  );

  const handleSetQueuedMessageGroupBoundary = useCallback(
    (request: QueuedMessageGroupBoundaryRequest) => {
      if (
        [
          request.groupBoundaryQueuedMessageId,
          ...request.expectedGroupedPrefixQueuedMessageIds,
        ].some((id) => id.startsWith("optimistic-queued-"))
      )
        return;
      const keyboardRevision = history.keyboardRevision;

      const undoRequest = groupBoundaryUndoRequest(
        queuedMessagesRef.current,
        request,
      );

      void setQueuedMessageGroupBoundary
        .mutateAsync({
          id: threadId,
          ...request,
        })
        .then(() => {
          if (undoRequest === null) return;
          history.record(
            {
              label:
                request.expectedGroupedPrefixQueuedMessageIds.length >
                undoRequest.expectedGroupedPrefixQueuedMessageIds.length
                  ? "Group queued messages"
                  : "Ungroup queued messages",
              undo: async () => {
                await setQueuedMessageGroupBoundary.mutateAsync({
                  id: threadId,
                  ...undoRequest,
                });
              },
              redo: async () => {
                await setQueuedMessageGroupBoundary.mutateAsync({
                  id: threadId,
                  ...request,
                });
              },
            },
            keyboardRevision,
          );
        })
        .catch((error) => {
          showMutationErrorToast({
            error,
            fallbackMessage: "Failed to group queued messages",
            lifecycleOperation: "set_queued_message_group_boundary",
          });
        });
    },
    [history, setQueuedMessageGroupBoundary, threadId],
  );

  const queuedMessageActionPending =
    deleteQueuedMessage.isPending ||
    restoreQueuedMessage.isPending ||
    reorderQueuedMessage.isPending ||
    setQueuedMessageGroupBoundary.isPending ||
    sendQueuedMessage.isPending ||
    updateQueuedMessage.isPending;

  return {
    processingQueuedMessage: displayedProcessingQueuedMessage,
    queuedMessageActionPending,
    isUpdateQueuedMessagePending: updateQueuedMessage.isPending,
    sendQueuedMessageById,
    handleSaveInlineQueuedMessage,
    handleDeleteQueuedMessage,
    handleReorderQueuedMessage,
    handleSetQueuedMessageGroupBoundary,
  };
}
