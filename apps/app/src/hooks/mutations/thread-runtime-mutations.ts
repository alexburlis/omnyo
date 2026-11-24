import { promptInputToDraft } from "@omnyo/client-core";
import { composerDraftFromPromptDraft } from "@/lib/plugin-composer-handle";
import { notifyComposerSubmitted } from "@/lib/composer-submissions";
import {
  reserveComposerSend,
  type ComposerSendSlot,
} from "@/lib/composer-send-queue";
import { useCallback } from "react";
import {
  useMutation,
  useQueryClient,
  type MutationOptions,
  type QueryClient,
} from "@tanstack/react-query";
import {
  CLIENT_TURN_REQUEST_ID_ALPHABET,
  CLIENT_TURN_REQUEST_ID_SUFFIX_LENGTH,
  formatClientTurnRequestIdSuffix,
  type ClientTurnRequestId,
  type PromptInput,
  type ThreadQueuedMessage,
} from "@omnyo/domain";
import { customAlphabet } from "nanoid";
import type {
  CreateQueuedMessageRequest,
  CreateThreadRequest,
  SendQueuedMessageMode,
  SendQueuedMessageRequest,
  SendQueuedMessageResponse,
  ThreadQueuedMessageListResponse,
  UpdateQueuedMessageRequest,
} from "@omnyo/server-contract";
import type { AppCreateThreadRequest } from "@omnyo/client-core";
import {
  createThreadThroughOutbox,
  type NewChatOutboxContext,
} from "@/lib/send-outbox/send-outbox";
import type { OmnyoSdkAreas } from "@omnyo/sdk";
import { isQueuedMessageNotFoundError } from "@/lib/http-error";
import { sdk } from "@/lib/sdk";
import { wsManager } from "@/lib/ws";
import type { QueuedMessageReorderRequest } from "@/lib/queued-message-reorder";
import type {
  EditMessageMutationRequest,
  SendThreadMessageMutationRequest,
} from "./mutation-request-types";
import {
  applyCreateThreadResult,
  applyEditMessageResult,
  applyQueuedMessageCreateResult,
  applyQueuedMessageDeleteResult,
  applyQueuedMessagesResult,
  applyQueuedMessageSendResult,
  applyQueuedMessageUpdateResult,
  applySendThreadMessageSuccess,
  applyThreadGoalClearResult,
  applyThreadPlanCancellationResult,
  beginCreateQueuedMessageTransaction,
  beginCreateThreadTransaction,
  beginEditMessageTransaction,
  beginRemoveQueuedMessageTransaction,
  beginReorderQueuedMessageTransaction,
  beginSetQueuedMessageGroupBoundaryTransaction,
  beginSendQueuedMessageTransaction,
  beginSendThreadMessageTransaction,
  beginStopThreadTransaction,
  beginUpdateQueuedMessageTransaction,
  prefetchThreadQueuedMessages,
  rollbackCreateQueuedMessageTransaction,
  rollbackEditMessageTransaction,
  rollbackRemoveQueuedMessageTransaction,
  settleQueuedMessageAlreadySent,
  rollbackReorderQueuedMessageTransaction,
  rollbackSendThreadMessageTransaction,
  rollbackStopThreadTransaction,
  rollbackUpdateQueuedMessageTransaction,
  settleStopThreadTransaction,
  type CreateQueuedMessageTransaction,
  type EditMessageTransaction,
  type RemoveQueuedMessageTransaction,
  type ReorderQueuedMessageTransaction,
  type SendThreadMessageTransaction,
  type StopThreadTransaction,
  type UpdateQueuedMessageTransaction,
} from "../cache-owners/thread-runtime-cache-owner";
import {
  invalidateThreadBannerQueries,
  invalidateThreadHistoryRewriteQueries,
  invalidateThreadQueueQueries,
  invalidateThreadQueuedMessageSendQueries,
} from "../cache-owners/mutation-cache-effects";

const composerTransports = new WeakMap<object, ComposerSendSlot>();

const createComposerRequestSuffix = customAlphabet(
  CLIENT_TURN_REQUEST_ID_ALPHABET,
  CLIENT_TURN_REQUEST_ID_SUFFIX_LENGTH,
);

const composerInputPreparations = new WeakMap<
  object,
  () => Promise<PromptInput[]>
>();

function prepareComposerSend<T extends { id: string }>(
  queryClient: object,
  variables: T,
  reservation?: ComposerSendSlot,
  prepareInput?: () => Promise<PromptInput[]>,
): T {
  const request = structuredClone(variables);
  composerTransports.set(
    request,
    reservation ?? reserveComposerSend(queryClient, request.id),
  );

  if (prepareInput) composerInputPreparations.set(request, prepareInput);

  return request;
}

function runComposerSend<T>(
  request: object,
  send: (preparedInput?: PromptInput[]) => Promise<T>,
): Promise<T> {
  const transport = composerTransports.get(request);

  if (transport === undefined)
    throw new Error("The message has no transport reservation.");

  const prepareInput = composerInputPreparations.get(request);
  composerInputPreparations.delete(request);

  return transport.run(async () => send(await prepareInput?.()));
}

function prepareComposerTurnSend<
  T extends { id: string; requestId?: ClientTurnRequestId },
>(
  queryClient: object,
  variables: T,
  reservation?: ComposerSendSlot,
  prepareInput?: () => Promise<PromptInput[]>,
): T & { requestId: ClientTurnRequestId } {
  return prepareComposerSend(
    queryClient,
    {
      ...variables,
      requestId:
        variables.requestId ??
        formatClientTurnRequestIdSuffix({
          suffix: createComposerRequestSuffix(),
        }),
    },
    reservation,
    prepareInput,
  );
}

interface CreateThreadQueuedMessageMutationRequest extends CreateQueuedMessageRequest {
  id: string;
  sendReservation?: ComposerSendSlot;
  prepareInput?: () => Promise<PromptInput[]>;
}

interface EditThreadMessageMutationRequest extends EditMessageMutationRequest {
  messageId: string;
}

interface UpdateThreadQueuedMessageMutationRequest extends UpdateQueuedMessageRequest {
  id: string;
  queuedMessageId: string;
}

interface SendThreadQueuedMessageMutationRequest extends SendQueuedMessageRequest {
  id: string;
  mode: SendQueuedMessageMode;
  queuedMessageId: string;
}

interface DeleteThreadQueuedMessageMutationRequest {
  id: string;
  queuedMessageId: string;
}

interface ReorderThreadQueuedMessageMutationRequest extends QueuedMessageReorderRequest {
  id: string;
}

interface SetThreadQueuedMessageGroupBoundaryMutationRequest {
  expectedGroupedPrefixQueuedMessageIds: string[];
  groupBoundaryQueuedMessageId: string;
  id: string;
}

async function deleteThreadQueuedMessageOrConfirmMissing({
  id,
  queuedMessageId,
}: DeleteThreadQueuedMessageMutationRequest): Promise<"deleted" | "missing"> {
  try {
    await sdk.threads.queuedMessages.delete({ threadId: id, queuedMessageId });

    return "deleted";
  } catch (error) {
    if (isQueuedMessageNotFoundError(error)) {
      return "missing";
    }

    throw error;
  }
}

export function useCreateThread() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationKey: ["createThread"],
    meta: {
      errorMessage: "Failed to create thread.",
      lifecycleOperation: "create_thread",
    },
    mutationFn: async ({
      outbox,
      ...request
    }: AppCreateThreadRequest & { outbox?: NewChatOutboxContext }) => {
      const thread: CreateThreadRequest = {
        ...request,
        origin: "app",
        originKind: request.originKind ?? null,
        startedOnBehalfOf: request.startedOnBehalfOf ?? null,
      };

      if (
        outbox !== undefined &&
        thread.originKind === null &&
        thread.sourceThreadId === undefined &&
        thread.pluginSubmission === undefined
      ) {
        const accepted = await createThreadThroughOutbox({
          onStaged: outbox.onStaged,
          pendingChatId: outbox.pendingChatId,
          thread,
        });

        if (accepted !== null) {
          return sdk.threads.get({ threadId: accepted.threadId });
        }
      }

      return sdk.threads.spawn(thread);
    },
    onMutate: async () => beginCreateThreadTransaction({ queryClient }),
    onSuccess: (thread, variables) => {
      notifyComposerSubmitted(
        {
          kind: "new-thread",
          projectId: variables.projectId,
        },
        composerDraftFromPromptDraft(promptInputToDraft(variables.input)),
      );

      if (thread.queuedMessageCount > 0) {
        void prefetchThreadQueuedMessages({
          queryClient,
          threadId: thread.id,
          load: (signal) =>
            sdk.threads.queuedMessages.list({
              threadId: thread.id,
              signal,
            }),
        });
      }

      applyCreateThreadResult({
        queryClient,
        request: variables,
        thread,
      });
    },
  });
}

type ThreadSendTransport = OmnyoSdkAreas["threads"]["send"];

type ThreadQueuedMessageCreateTransport =
  OmnyoSdkAreas["threads"]["queuedMessages"]["create"];

type ThreadSendResult = Awaited<ReturnType<ThreadSendTransport>>;

type ThreadMessageSendMutationOptions = MutationOptions<
  ThreadSendResult,
  Error,
  SendThreadMessageMutationRequest,
  SendThreadMessageTransaction
>;

type ThreadQueuedMessageCreateMutationOptions = MutationOptions<
  ThreadQueuedMessage,
  Error,
  CreateThreadQueuedMessageMutationRequest,
  CreateQueuedMessageTransaction
>;

interface ThreadMessageMutationSource<Transport> {
  queryClient: QueryClient;
  transport: Transport;
  notifiesComposer: boolean;
}

function threadMessageSendMutation({
  notifiesComposer,
  queryClient,
  transport,
}: ThreadMessageMutationSource<ThreadSendTransport>): ThreadMessageSendMutationOptions {
  return {
    meta: {
      errorMessage: "Failed to send message.",
      lifecycleOperation: "send_message",
      showErrorToast: false,
    },
    mutationFn: (variables) => {
      const {
        id,
        input,
        model,
        serviceTier,
        reasoningLevel,
        permissionMode,
        mode,
        sendAt,
        sendNow,
        senderThreadId,
        messageSource,
        pluginSubmission,
        executionInputSources,
        compactFirst,
        requestId,
      } = variables;

      const request = {
        requestId,
        threadId: id,
        input,
        model,
        serviceTier,
        reasoningLevel,
        permissionMode,
        ...(sendAt === undefined ? {} : { sendAt }),
        ...(sendNow === undefined ? {} : { sendNow }),
        ...(pluginSubmission === undefined ? {} : { pluginSubmission }),
        ...(compactFirst === undefined ? {} : { compactFirst }),
        executionInputSources,
        mode,
        ...(senderThreadId !== undefined ? { senderThreadId } : {}),
        ...(messageSource === undefined ? {} : { messageSource }),
      };

      return runComposerSend(variables, (preparedInput) => {
        if (preparedInput !== undefined) variables.input = preparedInput;

        return transport({ ...request, input: variables.input });
      });
    },
    onMutate: (variables) =>
      beginSendThreadMessageTransaction({
        queryClient,
        request: variables,
      }),
    onError: (_error, variables, context) => {
      composerTransports.get(variables)?.cancel();
      composerTransports.delete(variables);
      composerInputPreparations.delete(variables);
      rollbackSendThreadMessageTransaction({
        queryClient,
        request: variables,
        transaction: context,
      });
    },
    onSuccess: (data, variables, context) => {
      composerTransports.delete(variables);

      if (notifiesComposer)
        notifyComposerSubmitted(
          { kind: "thread", threadId: variables.id },
          composerDraftFromPromptDraft(promptInputToDraft(variables.input)),
        );
      applySendThreadMessageSuccess({
        queryClient,
        realtimeConnected: wsManager.getConnectionState() === "connected",
        request: variables,
        result: data,
        transaction: context,
      });
    },
  };
}

function threadQueuedMessageCreateMutation({
  notifiesComposer,
  queryClient,
  transport,
}: ThreadMessageMutationSource<ThreadQueuedMessageCreateTransport>): ThreadQueuedMessageCreateMutationOptions {
  return {
    meta: {
      errorMessage: "Failed to queue message.",
      lifecycleOperation: "queue_message",
      showErrorToast: false,
    },
    mutationFn: (variables) => {
      const {
        id,
        input,
        model,
        serviceTier,
        reasoningLevel,
        permissionMode,
        senderThreadId,
        messageSource,
        executionInputSources,
      } = variables;

      const request = {
        threadId: id,
        input,
        model,
        serviceTier,
        reasoningLevel,
        permissionMode,
        executionInputSources,
        ...(senderThreadId !== undefined ? { senderThreadId } : {}),
        ...(messageSource === undefined ? {} : { messageSource }),
      };

      return runComposerSend(variables, (preparedInput) => {
        if (preparedInput !== undefined) variables.input = preparedInput;

        return transport({ ...request, input: variables.input });
      });
    },
    onMutate: (variables) =>
      beginCreateQueuedMessageTransaction({
        queryClient,
        request: variables,
      }),
    onError: (_error, variables, context) => {
      composerTransports.get(variables)?.cancel();
      composerTransports.delete(variables);
      composerInputPreparations.delete(variables);
      rollbackCreateQueuedMessageTransaction({
        queryClient,
        request: variables,
        transaction: context,
      });
    },
    onSuccess: (queuedMessage, variables, context) => {
      composerTransports.delete(variables);

      if (notifiesComposer)
        notifyComposerSubmitted(
          { kind: "thread", threadId: variables.id },
          composerDraftFromPromptDraft(promptInputToDraft(variables.input)),
        );
      applyQueuedMessageCreateResult({
        queryClient,
        queuedMessage,
        threadId: variables.id,
        transaction: context,
      });
    },
  };
}

function executeMutation<Data, Variables, Context>(
  queryClient: QueryClient,
  options: MutationOptions<Data, Error, Variables, Context>,
  variables: Variables,
): Promise<Data> {
  return queryClient
    .getMutationCache()
    .build(queryClient, options)
    .execute(variables);
}

export function runThreadMessageSend({
  queryClient,
  request,
  transport,
}: {
  queryClient: QueryClient;
  request: SendThreadMessageMutationRequest;
  transport: ThreadSendTransport;
}): Promise<ThreadSendResult> {
  const { sendReservation, prepareInput, ...variables } = request;

  return executeMutation(
    queryClient,
    threadMessageSendMutation({
      notifiesComposer: false,
      queryClient,
      transport,
    }),
    prepareComposerTurnSend(
      queryClient,
      variables,
      sendReservation,
      prepareInput,
    ),
  );
}

export function runThreadQueuedMessageCreate({
  queryClient,
  request,
  transport,
}: {
  queryClient: QueryClient;
  request: CreateThreadQueuedMessageMutationRequest;
  transport: ThreadQueuedMessageCreateTransport;
}): Promise<ThreadQueuedMessage> {
  const { sendReservation, prepareInput, ...variables } = request;

  return executeMutation(
    queryClient,
    threadQueuedMessageCreateMutation({
      notifiesComposer: false,
      queryClient,
      transport,
    }),
    prepareComposerSend(queryClient, variables, sendReservation, prepareInput),
  );
}

export function useSendThreadMessage() {
  const queryClient = useQueryClient();

  const mutation = useMutation(
    threadMessageSendMutation({
      notifiesComposer: true,
      queryClient,
      transport: (args) => sdk.threads.send(args),
    }),
  );

  const sendAsync = mutation.mutateAsync;
  const send = mutation.mutate;

  const mutateAsync = useCallback(
    (
      variables: SendThreadMessageMutationRequest,
      options?: Parameters<typeof sendAsync>[1],
    ) => {
      const { sendReservation, prepareInput, ...request } = variables;

      return sendAsync(
        prepareComposerTurnSend(
          queryClient,
          request,
          sendReservation,
          prepareInput,
        ),
        options,
      );
    },
    [sendAsync, queryClient],
  );

  const mutate = useCallback(
    (
      variables: SendThreadMessageMutationRequest,
      options?: Parameters<typeof send>[1],
    ) => {
      const { sendReservation, prepareInput, ...request } = variables;

      return send(
        prepareComposerTurnSend(
          queryClient,
          request,
          sendReservation,
          prepareInput,
        ),
        options,
      );
    },
    [send, queryClient],
  );

  const reserve = useCallback(
    (threadId: string) => reserveComposerSend(queryClient, threadId),
    [queryClient],
  );

  return { ...mutation, mutate, mutateAsync, reserve };
}

export function useEditThreadMessage() {
  const queryClient = useQueryClient();

  return useMutation({
    meta: {
      errorMessage: "Failed to edit the message.",
      lifecycleOperation: "edit_message",
      showErrorToast: false,
    },
    mutationFn: ({
      id,
      messageId: _messageId,
      ...request
    }: EditThreadMessageMutationRequest) =>
      sdk.threads.editMessage({ threadId: id, ...request }),
    onMutate: (variables): EditMessageTransaction =>
      beginEditMessageTransaction({ queryClient, request: variables }),
    onError: (_error, variables, context) => {
      rollbackEditMessageTransaction({
        queryClient,
        threadId: variables.id,
        transaction: context,
      });
    },
    onSuccess: (_result, variables, context) => {
      applyEditMessageResult({
        queryClient,
        threadId: variables.id,
        transaction: context,
      });

      if (wsManager.getConnectionState() === "connected") {
        return;
      }

      invalidateThreadHistoryRewriteQueries({
        queryClient,
        threadId: variables.id,
      });
    },
  });
}

export function useCreateThreadQueuedMessage() {
  const queryClient = useQueryClient();

  const mutation = useMutation(
    threadQueuedMessageCreateMutation({
      notifiesComposer: true,
      queryClient,
      transport: (args) => sdk.threads.queuedMessages.create(args),
    }),
  );

  const sendAsync = mutation.mutateAsync;
  const send = mutation.mutate;

  const mutateAsync = useCallback(
    (
      variables: CreateThreadQueuedMessageMutationRequest,
      options?: Parameters<typeof sendAsync>[1],
    ) => {
      const { sendReservation, prepareInput, ...request } = variables;

      return sendAsync(
        prepareComposerSend(
          queryClient,
          request,
          sendReservation,
          prepareInput,
        ),
        options,
      );
    },
    [sendAsync, queryClient],
  );

  const mutate = useCallback(
    (
      variables: CreateThreadQueuedMessageMutationRequest,
      options?: Parameters<typeof send>[1],
    ) => {
      const { sendReservation, prepareInput, ...request } = variables;

      return send(
        prepareComposerSend(
          queryClient,
          request,
          sendReservation,
          prepareInput,
        ),
        options,
      );
    },
    [send, queryClient],
  );

  const reserve = useCallback(
    (threadId: string) => reserveComposerSend(queryClient, threadId),
    [queryClient],
  );

  return { ...mutation, mutate, mutateAsync, reserve };
}

export function useUpdateThreadQueuedMessage() {
  const queryClient = useQueryClient();

  return useMutation({
    meta: {
      errorMessage: "Failed to update queued message.",
      lifecycleOperation: "update_queued_message",
      showErrorToast: false,
    },
    mutationFn: ({
      id,
      ...request
    }: UpdateThreadQueuedMessageMutationRequest): Promise<ThreadQueuedMessage> =>
      sdk.threads.queuedMessages.update({ ...request, threadId: id }),
    onMutate: async (variables): Promise<UpdateQueuedMessageTransaction> =>
      beginUpdateQueuedMessageTransaction({
        queryClient,
        request: variables,
      }),
    onError: (_error, variables, context) => {
      rollbackUpdateQueuedMessageTransaction({
        queryClient,
        request: variables,
        transaction: context,
      });
    },
    onSuccess: (queuedMessage, variables) => {
      applyQueuedMessageUpdateResult({
        queryClient,
        queuedMessage,
        threadId: variables.id,
      });
    },
  });
}

export function useSendThreadQueuedMessage() {
  const queryClient = useQueryClient();

  const mutation = useMutation({
    meta: {
      errorMessage: "Failed to send queued message.",
      lifecycleOperation: "send_queued_message",
      showErrorToast: false,
    },
    mutationFn: (
      variables: SendThreadQueuedMessageMutationRequest,
    ): Promise<SendQueuedMessageResponse> => {
      const { id, mode, queuedMessageId, requestId } = variables;

      return runComposerSend(variables, () =>
        sdk.threads.queuedMessages.send({
          threadId: id,
          queuedMessageId,
          mode,
          requestId,
        }),
      );
    },
    onMutate: async (variables): Promise<RemoveQueuedMessageTransaction> =>
      beginSendQueuedMessageTransaction({
        queryClient,
        request: variables,
      }),
    onError: (error, variables, context) => {
      composerTransports.get(variables)?.cancel();
      composerTransports.delete(variables);
      rollbackRemoveQueuedMessageTransaction({
        queryClient,
        request: variables,
        transaction: context,
      });

      if (isQueuedMessageNotFoundError(error)) {
        invalidateThreadQueuedMessageSendQueries({
          queryClient,
          threadId: variables.id,
        });
      }
    },
    onSuccess: (data, variables, transaction) => {
      composerTransports.delete(variables);

      if (data.delivery === "already-sent") {
        settleQueuedMessageAlreadySent({
          queryClient,
          request: variables,
          transaction,
        });

        return;
      }

      applyQueuedMessageSendResult({
        queryClient,
        request: variables,
        result: data,
        transaction,
      });
    },
  });

  const sendAsync = mutation.mutateAsync;
  const send = mutation.mutate;

  const mutateAsync = useCallback(
    (
      variables: SendThreadQueuedMessageMutationRequest,
      options?: Parameters<typeof sendAsync>[1],
    ) => sendAsync(prepareComposerTurnSend(queryClient, variables), options),
    [queryClient, sendAsync],
  );

  const mutate = useCallback(
    (
      variables: SendThreadQueuedMessageMutationRequest,
      options?: Parameters<typeof send>[1],
    ) => send(prepareComposerTurnSend(queryClient, variables), options),
    [queryClient, send],
  );

  return { ...mutation, mutate, mutateAsync };
}

export function useReorderThreadQueuedMessage() {
  const queryClient = useQueryClient();

  return useMutation({
    meta: {
      errorMessage: "Failed to reorder queued message.",
      lifecycleOperation: "reorder_queued_message",
      showErrorToast: false,
    },
    mutationFn: ({
      id,
      nextQueuedMessageId,
      previousQueuedMessageId,
      groupBoundaryQueuedMessageId,
      queuedMessageId,
    }: ReorderThreadQueuedMessageMutationRequest): Promise<ThreadQueuedMessageListResponse> =>
      sdk.threads.queuedMessages.reorder({
        threadId: id,
        queuedMessageId,
        previousQueuedMessageId,
        nextQueuedMessageId,
        groupBoundaryQueuedMessageId,
      }),
    onMutate: async (variables): Promise<ReorderQueuedMessageTransaction> =>
      beginReorderQueuedMessageTransaction({
        queryClient,
        request: variables,
      }),
    onError: (_error, variables, context) => {
      rollbackReorderQueuedMessageTransaction({
        queryClient,
        request: variables,
        transaction: context,
      });
    },
    onSuccess: (queuedMessages, variables) => {
      applyQueuedMessagesResult({
        queryClient,
        queuedMessages,
        request: variables,
      });
    },
  });
}

export function useSetThreadQueuedMessageGroupBoundary() {
  const queryClient = useQueryClient();

  return useMutation({
    meta: {
      errorMessage: "Failed to group queued messages.",
      lifecycleOperation: "set_queued_message_group_boundary",
      showErrorToast: false,
    },
    mutationFn: ({
      expectedGroupedPrefixQueuedMessageIds,
      groupBoundaryQueuedMessageId,
      id,
    }: SetThreadQueuedMessageGroupBoundaryMutationRequest): Promise<ThreadQueuedMessageListResponse> =>
      sdk.threads.queuedMessages.setGroupBoundary({
        threadId: id,
        expectedGroupedPrefixQueuedMessageIds,
        groupBoundaryQueuedMessageId,
      }),
    onMutate: async (variables): Promise<ReorderQueuedMessageTransaction> =>
      beginSetQueuedMessageGroupBoundaryTransaction({
        queryClient,
        request: variables,
      }),
    onError: (_error, variables, context) => {
      rollbackReorderQueuedMessageTransaction({
        queryClient,
        request: {
          ...variables,
          queuedMessageId: variables.groupBoundaryQueuedMessageId,
          previousQueuedMessageId: null,
          nextQueuedMessageId: null,
        },
        transaction: context,
      });
    },
    onSuccess: (queuedMessages, variables) => {
      applyQueuedMessagesResult({
        queryClient,
        queuedMessages,
        request: variables,
      });
    },
  });
}

export function useDeleteThreadQueuedMessage() {
  const queryClient = useQueryClient();

  return useMutation({
    meta: {
      errorMessage: "Failed to delete queued message.",
      showErrorToast: false,
    },
    mutationFn: deleteThreadQueuedMessageOrConfirmMissing,
    onMutate: async (variables): Promise<RemoveQueuedMessageTransaction> =>
      beginRemoveQueuedMessageTransaction({
        queryClient,
        request: variables,
      }),
    onError: (_error, variables, context) => {
      rollbackRemoveQueuedMessageTransaction({
        queryClient,
        request: variables,
        transaction: context,
      });
    },
    onSuccess: (_data, variables) => {
      applyQueuedMessageDeleteResult({
        queryClient,
        threadId: variables.id,
      });
    },
  });
}

export function useRestoreThreadQueuedMessage() {
  const queryClient = useQueryClient();

  return useMutation({
    meta: {
      errorMessage: "Failed to restore queued message.",
      showErrorToast: false,
    },
    mutationFn: ({
      id,
      queuedMessageId,
    }: DeleteThreadQueuedMessageMutationRequest): Promise<ThreadQueuedMessage> =>
      sdk.threads.queuedMessages.experimental_restore({
        threadId: id,
        queuedMessageId,
      }),
    onSuccess: (_queuedMessage, variables) => {
      invalidateThreadQueueQueries({
        queryClient,
        threadId: variables.id,
      });
    },
  });
}

export function useStopThread() {
  const queryClient = useQueryClient();

  return useMutation({
    meta: {
      errorMessage: "Failed to stop thread.",
      lifecycleOperation: "stop_thread",
    },
    mutationFn: async (threadId: string) => {
      await sdk.threads.stop({ threadId });
    },
    onMutate: async (threadId): Promise<StopThreadTransaction> =>
      beginStopThreadTransaction({
        queryClient,
        threadId,
      }),
    onError: (_error, threadId, context) => {
      rollbackStopThreadTransaction({
        queryClient,
        threadId,
        transaction: context,
      });
    },
    onSettled: (_data, _error, threadId, context) => {
      settleStopThreadTransaction({
        queryClient,
        threadId,
        transaction: context,
      });
    },
  });
}

export function useCancelThreadPlan() {
  const queryClient = useQueryClient();

  return useMutation({
    meta: { errorMessage: "Failed to exit Plan mode." },
    mutationFn: async (threadId: string) => {
      await sdk.threads.cancelPlan({ threadId });
    },
    onSuccess: (_data, threadId) => {
      applyThreadPlanCancellationResult({ queryClient, threadId });
      invalidateThreadBannerQueries({ queryClient, threadId });
    },
  });
}

export function useClearThreadGoal() {
  const queryClient = useQueryClient();

  return useMutation({
    meta: { errorMessage: "Failed to clear Goal." },
    mutationFn: async (threadId: string) => {
      await sdk.threads.clearGoal({ threadId });
    },
    onSuccess: (_data, threadId) => {
      applyThreadGoalClearResult({ queryClient, threadId });
      invalidateThreadBannerQueries({ queryClient, threadId });
    },
  });
}
