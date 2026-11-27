import { useLiveThreadSpeed } from "@/hooks/useLiveThreadSpeed";
import { isRunningThreadRuntimeDisplayStatus } from "@omnyo/client-core";
import { useQueuedMessagesExpanded } from "@/components/promptbox/banner/queued-messages-expanded";
import { createCoreComposerActions } from "@/lib/plugin-composer-handle";
import type { EmbeddedConversation } from "@/lib/embedded-conversation";
import { prepareComposerAttachmentSubmission } from "@/lib/composer-attachment-submission";
import type { CapturedAttachmentUploads } from "@/components/promptbox/usePendingAttachmentUploads";
import type { ComposerSendSlot } from "@/lib/composer-send-queue";
import {
  useCallback,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  defaultAppSettings,
  type PromptInput,
  type ThreadQueuedMessage,
} from "@omnyo/domain";
import type { SendMessageDelivery } from "@omnyo/server-contract";
import type {
  ComposerSelection,
  ComposerSubmitOptions,
  JsonValue,
} from "@omnyo/plugin-sdk";
import { readExecutionSelection } from "@/components/promptbox/composer-selection-settle";
import type { ModelPickerSelection } from "@/components/pickers/model-picker-selection";
import type {
  AttachmentsConfig,
  HistoryConfig,
} from "@/components/promptbox/PromptBoxInternal";
import type { PromptMentionLinkResolver } from "@/components/promptbox/editor/prompt-mention-link";
import { cn } from "@omnyo/shared-ui/lib/utils";
import { BottomAnchoredScrollBody } from "@/components/ui/bottom-anchored-scroll-body";
import { PageShell } from "@/components/ui/page-shell.js";
import {
  FollowUpPromptBox,
  type FollowUpComposerProps,
} from "@/components/promptbox/FollowUpPromptBox";
import {
  useComposerHostDraftNotifier,
  useComposerHostSelection,
  type PluginComposerHost,
} from "@/components/plugin/plugin-composer-host";
import { ThreadPendingInteractionBanners } from "@/components/thread/pending-interactions/ThreadPendingInteractionBanner";
import {
  LazyQueuedMessagesList,
  type QueuedMessageInlineEditor,
} from "@/components/promptbox/banner/LazyQueuedMessagesList";
import type {
  ExecutionControlsProps,
  ExecutionPermissionConfig,
} from "@/components/promptbox/ExecutionControls";
import { OverflowFade } from "@/components/ui/overflow-fade";
import {
  ThreadTimelinePanelContent,
  ThreadTimelineSurface,
  type ThreadTimelineAddToChatHandler,
  type ThreadTimelineConsumerMessageAction,
  type ThreadTimelineLinkHandler,
  type ThreadTimelineLocalFileLinkHandler,
  type ThreadTimelineSurfaceProps,
} from "@/components/thread/timeline";
import { CompactionQueuedMessagesProvider } from "@/components/thread/timeline/CompactionQueuedMessages";
import { useThreadCreationOptions } from "@/hooks/useThreadCreationOptions";
import {
  orderPendingInteractions,
  useThread,
  useThreadPendingInteractions,
  useThreadQueuedMessages,
} from "@/hooks/queries/thread-queries";
import { useThreadDefaultExecutionOptions } from "@/hooks/queries/thread-default-execution-options-query";
import { useSystemConfig } from "@/hooks/queries/system-queries";
import {
  useCreateThreadQueuedMessage,
  useSendThreadMessage,
  useStopThread,
} from "@/hooks/mutations/thread-runtime-mutations";
import { useMarkThreadRead } from "@/hooks/mutations/thread-state-mutations";
import { useThreadReadTracking } from "@/hooks/useThreadReadTracking";
import { useComposerTextEffects } from "@/lib/composer-text-effects";
import {
  getMutationErrorMessage,
  showMutationErrorToast,
} from "@/lib/mutation-errors";
import type { PromptDraftState } from "@omnyo/client-core";
import type { PromptDraftScope } from "@/hooks/usePromptDraftStorage";
import { appToast } from "@/components/ui/app-toast";
import {
  buildSideChatSubmitMode,
  canSubmitFollowUpShortcut,
  shouldQueueFollowUpMessage,
} from "@omnyo/client-core";
import {
  SHORT_LIVED_STATUS_DELAY_MS,
  useSustainedFlag,
} from "@/hooks/useSustainedFlag";
import { useActiveComposerDraft } from "./useActiveComposerDraft";
import { useComposerAttachmentUploads } from "./useComposerAttachmentUploads";
import { useLatestRef } from "@/hooks/useLatestRef";
import { useComposerTypeahead } from "./useComposerTypeahead";
import { useInlineQueuedMessageEditing } from "./useInlineQueuedMessageEditing";
import { useQueuedMessageActions } from "./useQueuedMessageActions";
import { inlineQueuedExecutionControls } from "./inline-queued-execution";

const NO_QUEUED_EDITOR_SELECTION: ComposerSelection = {};

function reportQueuedSendDelivery(delivery: SendMessageDelivery): void {
  if (delivery !== "queued") {
    return;
  }

  appToast.message(
    "Message queued until this thread can take it. It sends by itself; do not send it again.",
    { badge: false },
  );
}

let pluginComposerHostOwnershipSequence = 0;

function createPluginComposerHostIdentity(scopeIdentity: string): string {
  pluginComposerHostOwnershipSequence += 1;

  return `${scopeIdentity}:ownership:${pluginComposerHostOwnershipSequence}`;
}

interface EmbeddedThreadChatComposerProps {
  draftScope: PromptDraftScope;
  executionDefaultsThreadId: string;
  executionResetKey: string;
  executionEnvironmentId?: string;
  executionEnvironmentHostId?: string;
  permissionPolicy: "editable" | "snapshot";
  pluginComposerBottomScope?: PluginComposerHost["scope"] | null;
  composerIdentity?: string;
  focusRequestKey?: number;
  placeholder?: string;
}

interface EmbeddedThreadChatSharedProps {
  threadId: string;
  projectId: string;
  providerId: string;
  promptContextEnvironmentId: string | null;
  resolveMentionLink: PromptMentionLinkResolver;
  leadingContent?: ReactNode;
  consumerMessageActions?: readonly ThreadTimelineConsumerMessageAction[];
  includePluginMessageActions?: boolean;
  onOpenLink?: ThreadTimelineLinkHandler;
  onOpenLocalFileLink?: ThreadTimelineLocalFileLinkHandler;
  workspaceRootPath?: string;
  layout?: "contained" | "document";
  measure?: "panel" | "page";
}

interface EmbeddedThreadChatComposerModeProps extends EmbeddedThreadChatSharedProps {
  variant: "compact";
  surfaceTone?: "background" | "sidebar";
  composer: EmbeddedThreadChatComposerProps;
  conversation?: EmbeddedConversation;
  footer?: never;
}

interface EmbeddedThreadChatHostedFooterProps {
  variant: "hosted-footer";
  footer: ReactNode;
  scrollOverlay?: ReactNode;
  surface: ThreadTimelineSurfaceProps;
  composer?: never;
}

type EmbeddedThreadChatProps =
  | EmbeddedThreadChatComposerModeProps
  | EmbeddedThreadChatHostedFooterProps;

export function EmbeddedThreadChat(props: EmbeddedThreadChatProps) {
  if (props.variant === "hosted-footer") {
    return <EmbeddedThreadChatHostedFooter {...props} />;
  }

  return <EmbeddedThreadChatWithComposer {...props} />;
}

function EmbeddedThreadChatHostedFooter({
  footer,
  scrollOverlay,
  surface,
}: EmbeddedThreadChatHostedFooterProps) {
  return (
    <CompactionQueuedMessagesProvider
      runtimeStatus={surface.threadRuntimeDisplayStatus}
      threadId={surface.threadId}
      timelineRows={surface.timelineRows}
    >
      <div
        data-thread-window=""
        className="flex h-full min-h-0 min-w-0 flex-col overflow-clip"
      >
        <PageShell
          key={surface.threadId}
          scrollBehavior="bottom-anchor"
          animateFollowLatest={
            surface.showOngoingIndicator || surface.activeThinking !== null
          }
          shellClassName="!mx-0 !mt-0 md:!mx-0 md:!mt-0"
          scrollAreaClassName="scroll-pt-4"
          contentClassName="gap-2 pt-4"
          footerClassName="chat-prompt-box"
          footer={footer}
          scrollOverlay={scrollOverlay}
        >
          <ThreadTimelineSurface {...surface} unreadDividerAutoScroll={false} />
        </PageShell>
      </div>
    </CompactionQueuedMessagesProvider>
  );
}

const EMPTY_QUEUED_MESSAGES: readonly ThreadQueuedMessage[] = [];

function EmbeddedThreadChatWithComposer({
  threadId,
  projectId,
  providerId,
  promptContextEnvironmentId,
  resolveMentionLink,
  leadingContent,
  consumerMessageActions,
  includePluginMessageActions,
  onOpenLink,
  onOpenLocalFileLink,
  workspaceRootPath,
  layout = "contained",
  measure = "panel",
  surfaceTone = "background",
  composer,
  conversation,
}: EmbeddedThreadChatComposerModeProps) {
  const systemConfigQuery = useSystemConfig();

  const steerActiveThreadOnEnter =
    systemConfigQuery.data?.generalSettings.steerActiveThreadOnEnter ??
    defaultAppSettings.steerActiveThreadOnEnter;

  const surfaceKey = threadId;
  const markThreadRead = useMarkThreadRead();
  const stopThread = useStopThread();
  const sendThreadMessage = useSendThreadMessage();
  const sendThreadMessageAsync = sendThreadMessage.mutateAsync;
  const reserveMessageSend = sendThreadMessage.reserve;
  const createQueuedMessage = useCreateThreadQueuedMessage();
  const threadQuery = useThread(threadId);
  const pendingInteractionsQuery = useThreadPendingInteractions(threadId);

  const composerBlockingPendingInteractions = orderPendingInteractions(
    pendingInteractionsQuery.data,
  ).filter((interaction) => interaction.payload.kind !== "plugin");

  const hasComposerBlockingPendingInteraction =
    composerBlockingPendingInteractions.length > 0;

  useThreadReadTracking({
    markThreadRead,
    thread: threadQuery.data,
  });
  const { data: queuedMessagesData } = useThreadQueuedMessages(threadId);
  const queuedMessages = queuedMessagesData ?? EMPTY_QUEUED_MESSAGES;

  const executionOptionsQuery = useThreadDefaultExecutionOptions(
    composer.executionDefaultsThreadId,
    { enabled: true },
  );

  const defaultExecutionOptions = executionOptionsQuery.data;

  const threadCreationOptions = useThreadCreationOptions({
    enabled: true,
    scope: "component-local",
    environmentId: composer.executionEnvironmentId,
    environmentHostId: composer.executionEnvironmentHostId,
    resetKey: composer.executionResetKey,
    initialProviderId: providerId,
    initialModel: defaultExecutionOptions?.model,
    initialServiceTier: defaultExecutionOptions?.serviceTier,
    initialReasoningLevel: defaultExecutionOptions?.reasoningLevel,
    initialPermissionMode: defaultExecutionOptions?.permissionMode,
  });

  const {
    executionOptionsRouting,
    selectedProviderId,
    setProviderModelReasoning,
    providerOptions,
    hasMultipleProviders,
    selectedProviderComposerActions,
    selectedModel,
    setSelectedModel,
    serviceTier,
    setServiceTier,
    reasoningLevel,
    setReasoningLevel,
    permissionMode,
    setPermissionMode,
    activeModel,
    modelOptions,
    moreModelOptions,
    catalogModelOptions,
    modelCatalogIsVerified,
    providers: executionProviders,
    modelLoadFailed,
    modelLoadError,
    modelNotice,
    reasoningOptions,
    isLoadingReasoning,
    permissionModeOptions,
    supportsPermissionModeSelection,
    supportsServiceTier,
    serviceTierOptions,
    isLoadingModels,
    executionInputSources,
  } = threadCreationOptions;

  const changeSessionSpeed = useLiveThreadSpeed({
    threadId,
    value: serviceTier,
    onChange: setServiceTier,
  });

  const selectedExecutionModel = activeModel?.model ?? selectedModel;

  const selectedExecutionServiceTier = supportsServiceTier
    ? serviceTier
    : undefined;

  const snapshotPermissionMode = defaultExecutionOptions?.permissionMode;

  const effectivePermissionMode =
    composer.permissionPolicy === "snapshot"
      ? snapshotPermissionMode
      : permissionMode;

  const displayStatus = threadQuery.data?.runtime.displayStatus ?? "idle";

  const executionRequestFields = useMemo(
    () => ({
      executionInputSources: {
        ...executionInputSources,
        ...(composer.permissionPolicy === "snapshot" &&
        snapshotPermissionMode !== undefined
          ? { permissionMode: "explicit" as const }
          : {}),
      },
      ...(selectedExecutionModel.length > 0
        ? {
            model: selectedExecutionModel,
            reasoningLevel,
            ...(selectedExecutionServiceTier
              ? { serviceTier: selectedExecutionServiceTier }
              : {}),
          }
        : {}),
      ...(effectivePermissionMode !== undefined
        ? { permissionMode: effectivePermissionMode }
        : {}),
    }),
    [
      composer.permissionPolicy,
      effectivePermissionMode,
      executionInputSources,
      reasoningLevel,
      selectedExecutionModel,
      selectedExecutionServiceTier,
      snapshotPermissionMode,
    ],
  );

  const [composerFocusNonce, setComposerFocusNonce] = useState(0);
  const [inlineComposerFocusNonce, setInlineComposerFocusNonce] = useState(0);

  const isTurnSubmitting =
    sendThreadMessage.isPending || createQueuedMessage.isPending;

  const [queueExpanded, setQueueExpanded] = useQueuedMessagesExpanded({
    threadId,
    queuedMessages: queuedMessagesData ?? null,
  });

  const clearInlineAttachmentErrorRef = useRef<() => void>(() => {});

  const {
    inlineEditingQueuedMessage,
    inlineEditingQueuedMessageRef,
    updateInlineQueuedMessage,
    dismissInlineQueuedMessageEditor,
    beginEditQueuedMessage,
    queuedMessageDraftSession,
  } = useInlineQueuedMessageEditing({
    ownerThreadId: threadId,
    queuedMessages,
    onBeginEdit: () => {
      clearInlineAttachmentErrorRef.current();
      setInlineComposerFocusNonce((nonce) => nonce + 1);
    },
  });

  const inlineDraftSessionRef = useLatestRef(queuedMessageDraftSession);

  const {
    promptDraft,
    currentPromptDraft,
    currentPromptDraftInput,
    activeComposerDraft,
    activeComposerDraftInput,
    handleChangeMessage,
    updateActiveComposerAttachments,
  } = useActiveComposerDraft({
    draftScope: composer.draftScope,
    inlineDraft: inlineEditingQueuedMessage?.draft ?? null,
    inlineSessionRef: inlineDraftSessionRef,
  });

  const {
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
  } = useComposerAttachmentUploads({
    projectId,
    draftKey: promptDraft.storageKey,
    addDraftAttachment: promptDraft.addAttachment,
    inlineEditSessionId: queuedMessageDraftSession?.editSessionId ?? null,
    inlineSessionRef: inlineDraftSessionRef,
  });

  clearInlineAttachmentErrorRef.current = () => setInlineAttachmentError(null);

  const { typeaheadConfig, promptActions } = useComposerTypeahead({
    projectId,
    providerId,
    environmentId: promptContextEnvironmentId,
    currentThreadId: threadId,
    selectedProviderComposerActions,
    resolveMentionLink,
  });

  const isStopRequested =
    threadQuery.data?.status === "stopping" ||
    (stopThread.isPending && stopThread.variables === threadId);

  const handleStopThread = useCallback(() => {
    stopThread.mutate(threadId);
  }, [stopThread, threadId]);

  const isProvisioning =
    displayStatus === "provisioning" || displayStatus === "starting";

  const isDefaultExecutionOptionsLoading =
    executionOptionsQuery.isPlaceholderData ||
    (defaultExecutionOptions === undefined && executionOptionsQuery.isLoading);

  const {
    processingQueuedMessage,
    queuedMessageActionPending,
    isUpdateQueuedMessagePending,
    sendQueuedMessageById,
    handleSaveInlineQueuedMessage,
    handleDeleteQueuedMessage,
    handleReorderQueuedMessage,
    handleSetQueuedMessageGroupBoundary,
  } = useQueuedMessageActions({
    threadId,
    queuedMessages,
    sendProcessingPersistence: "clear-on-settle",
    onSaveSuccess: () => setInlineAttachmentError(null),
    inlineEditingQueuedMessage,
    dismissInlineQueuedMessageEditor,
    activeComposerDraftInput,
  });

  const clearSubmittedDraft = promptDraft.clearIfCurrentMatches;
  const restoreFailedDraft = promptDraft.restoreFailedDraft;

  const submitMode = useMemo<FollowUpComposerProps["submitMode"]>(
    () =>
      buildSideChatSubmitMode({
        childThreadId: threadId,
        hasPendingInteraction: hasComposerBlockingPendingInteraction,
        isDefaultExecutionOptionsLoading: false,
        isStopRequested,
        onStop: handleStopThread,
        runtimeDisplayStatus: displayStatus,
      }),
    [
      displayStatus,
      hasComposerBlockingPendingInteraction,
      handleStopThread,
      isStopRequested,
      threadId,
    ],
  );

  const defaultSendOrQueueInput = useCallback(
    async (
      input: PromptInput[],
      prepareInput?: () => Promise<PromptInput[]>,
      options?: { sendNow?: true },
    ) => {
      if (shouldQueueFollowUpMessage(displayStatus) && !options?.sendNow) {
        await createQueuedMessage.mutateAsync({
          id: threadId,
          input,
          prepareInput,
          ...executionRequestFields,
        });

        return;
      }

      const result = await sendThreadMessage.mutateAsync({
        id: threadId,
        input,
        prepareInput,
        mode: "queue-if-active",
        ...options,
        ...executionRequestFields,
      });

      reportQueuedSendDelivery(
        result.delivery === "stored" || result.delivery === "waiting"
          ? "sent"
          : result.delivery,
      );
    },
    [
      createQueuedMessage,
      displayStatus,
      executionRequestFields,
      sendThreadMessage,
      threadId,
    ],
  );

  const submitDraftProgrammatically = useCallback(
    async (
      submittedDraft: PromptDraftState,
      options: ComposerSubmitOptions,
      pluginSubmission: { pluginId: string; data: JsonValue } | undefined,
      sendReservation?: ComposerSendSlot,
      capturedUploads: CapturedAttachmentUploads | null = null,
      clearCurrentDraft = false,
      pendingTranscript?: () => Promise<string>,
    ) => {
      const submission = prepareComposerAttachmentSubmission({
        scope: composer.draftScope,
        conversation,
        draft: submittedDraft,
        uploads: capturedUploads,
        pendingTranscript,
      });

      if (submission.input.length === 0) {
        sendReservation?.cancel();
        capturedUploads?.restore();
        submission.complete();
        throw new Error("Type a message before submitting it.");
      }

      if (clearCurrentDraft) clearSubmittedDraft(submittedDraft);
      setBottomAttachmentError(null);

      try {
        const result = await sendThreadMessageAsync({
          id: threadId,
          ...(sendReservation === undefined ? {} : { sendReservation }),
          input: submission.input,
          prepareInput: submission.prepareInput,
          mode: "queue-if-active",
          ...executionRequestFields,
          ...(options.sendAt === undefined ? {} : { sendAt: options.sendAt }),
          ...(pluginSubmission === undefined ? {} : { pluginSubmission }),
        });

        reportQueuedSendDelivery(
          result.delivery === "stored" || result.delivery === "waiting"
            ? "sent"
            : result.delivery,
        );
        submission.complete();
      } catch (error) {
        sendReservation?.cancel();
        submission.restoreFailed(restoreFailedDraft);

        throw new Error(
          getMutationErrorMessage({
            error,
            fallbackMessage: "Failed to submit message",
            lifecycleOperation: "send_message",
          }),
        );
      }
    },
    [
      composer.draftScope,
      conversation,
      executionRequestFields,
      clearSubmittedDraft,
      restoreFailedDraft,
      sendThreadMessageAsync,
      setBottomAttachmentError,
      threadId,
    ],
  );

  const submitProgrammatically = useCallback(
    (
      options: ComposerSubmitOptions,
      pluginSubmission: { pluginId: string; data: JsonValue } | undefined,
    ) =>
      submitDraftProgrammatically(
        promptDraft.getCurrent(),
        options,
        pluginSubmission,
        undefined,
        captureBottomUploads(),
        true,
      ),
    [captureBottomUploads, promptDraft, submitDraftProgrammatically],
  );

  const submitProgrammaticallyRef = useLatestRef(submitProgrammatically);

  const handleSubmit = useCallback(
    (options?: { sendNow?: true }) => {
      const submittedDraft = promptDraft.getCurrent();
      const capturedUploads = captureBottomUploads();

      const submission = prepareComposerAttachmentSubmission({
        scope: composer.draftScope,
        conversation,
        draft: submittedDraft,
        uploads: capturedUploads,
      });

      if (submission.input.length === 0) {
        submission.complete();

        return;
      }

      if (!promptDraft.clearIfCurrentMatches(submittedDraft)) {
        capturedUploads?.restore();
        submission.complete();

        return;
      }

      setBottomAttachmentError(null);
      void defaultSendOrQueueInput(
        submission.input,
        submission.prepareInput,
        options,
      )
        .then(() => submission.complete())
        .catch((error) => {
          submission.restoreFailed(promptDraft.restoreFailedDraft);
          showMutationErrorToast({
            error,
            fallbackMessage: "Failed to send message",
            lifecycleOperation: shouldQueueFollowUpMessage(displayStatus)
              ? "queue_message"
              : "send_message",
          });
        });
    },
    [
      composer.draftScope,
      conversation,
      captureBottomUploads,
      defaultSendOrQueueInput,
      displayStatus,
      promptDraft,
      setBottomAttachmentError,
    ],
  );

  const isQueueMutationPending =
    queuedMessageActionPending || createQueuedMessage.isPending;

  const handleSendQueuedMessage = useCallback(
    (queuedMessageId: string) => {
      void sendQueuedMessageById({
        guard: "exists",
        messageId: queuedMessageId,
        mode: isProvisioning ? "steer" : "auto",
      });
    },
    [isProvisioning, sendQueuedMessageById],
  );

  const hasPromptDraftInput =
    currentPromptDraftInput.length > 0 || bottomPendingUploads.length > 0;

  const canSubmitModifierShortcut = canSubmitFollowUpShortcut({
    hasPromptDraftInput,
    isFollowUpSubmitting: false,
    isQueueMutationPending: hasPromptDraftInput
      ? false
      : isQueueMutationPending,
    queuedMessageCount: queuedMessages.length,
    runtimeDisplayStatus: displayStatus,
    submitModeKind: submitMode.kind,
  });

  const handleModifierSubmit = useCallback(
    (options?: { sendNow?: true }) => {
      if (!canSubmitModifierShortcut) {
        return;
      }

      const submittedDraft = promptDraft.getCurrent();
      const capturedUploads = captureBottomUploads();

      const submission = prepareComposerAttachmentSubmission({
        scope: composer.draftScope,
        conversation,
        draft: submittedDraft,
        uploads: capturedUploads,
      });

      if (submission.input.length === 0) {
        submission.complete();
        const nextQueuedMessage = queuedMessages[0];

        if (nextQueuedMessage) {
          void sendQueuedMessageById({
            guard: "current-head",
            messageId: nextQueuedMessage.id,
            mode: "steer",
          });
        }

        return;
      }

      if (!promptDraft.clearIfCurrentMatches(submittedDraft)) {
        capturedUploads?.restore();
        submission.complete();

        return;
      }

      setBottomAttachmentError(null);
      void sendThreadMessage
        .mutateAsync({
          id: threadId,
          input: submission.input,
          prepareInput: submission.prepareInput,
          mode: "steer-if-active",
          ...options,
          ...executionRequestFields,
        })
        .then((result) => {
          reportQueuedSendDelivery(
            result.delivery === "stored" || result.delivery === "waiting"
              ? "sent"
              : result.delivery,
          );
          submission.complete();
        })
        .catch((error) => {
          submission.restoreFailed(promptDraft.restoreFailedDraft);
          showMutationErrorToast({
            error,
            fallbackMessage: "Failed to send message",
            lifecycleOperation: "send_message",
          });
        });
    },
    [
      composer.draftScope,
      conversation,
      captureBottomUploads,
      canSubmitModifierShortcut,
      executionRequestFields,
      promptDraft,
      queuedMessages,
      sendQueuedMessageById,
      sendThreadMessage,
      setBottomAttachmentError,
      threadId,
    ],
  );

  const handleInlineComposerSubmit = useCallback(() => {
    void handleSaveInlineQueuedMessage();
  }, [handleSaveInlineQueuedMessage]);

  const composerActions = useMemo(
    () =>
      createCoreComposerActions({
        getCurrent: promptDraft.getCurrent,
        setDraft: promptDraft.setDraft,
        focus: () => setComposerFocusNonce((nonce) => nonce + 1),
      }),
    [promptDraft.getCurrent, promptDraft.setDraft],
  );

  const handleAddToChat = useCallback<ThreadTimelineAddToChatHandler>(
    (text, attachments, mentions) => {
      composerActions.addQuote(text, attachments, mentions);
      composerActions.focus();
    },
    [composerActions],
  );

  const restoreHistoryDraft = composerActions.restoreDraft;

  const queuedEditSessionId = inlineEditingQueuedMessage?.editSessionId ?? null;

  const queuedEditOwnerThreadId =
    inlineEditingQueuedMessage?.ownerThreadId ?? null;

  const queuedEditMessageId =
    inlineEditingQueuedMessage?.queuedMessageId ?? null;

  const queuedComposerIdentity = useMemo(
    () =>
      queuedEditSessionId === null ||
      queuedEditOwnerThreadId === null ||
      queuedEditMessageId === null
        ? null
        : {
            editSessionId: queuedEditSessionId,
            ownerThreadId: queuedEditOwnerThreadId,
            queuedMessageId: queuedEditMessageId,
          },
    [queuedEditMessageId, queuedEditOwnerThreadId, queuedEditSessionId],
  );

  const bottomScope = composer.pluginComposerBottomScope ?? null;

  const bottomComposerHostIdentity = useMemo(
    () =>
      createPluginComposerHostIdentity(
        `${composer.composerIdentity ?? surfaceKey}:bottom:active`,
      ),
    [composer.composerIdentity, surfaceKey],
  );

  const queuedComposerHostIdentity = useMemo(
    () =>
      queuedComposerIdentity
        ? createPluginComposerHostIdentity(
            `queued-message:${queuedComposerIdentity.ownerThreadId}:${queuedComposerIdentity.queuedMessageId}:${queuedComposerIdentity.editSessionId}:active`,
          )
        : null,
    [queuedComposerIdentity],
  );

  const activeBottomComposerIdentityRef = useRef<string | null>(null);
  const activeQueuedComposerIdentityRef = useRef<string | null>(null);
  const currentPromptDraftRef = useRef(currentPromptDraft);
  const committedInlineEditRef = useRef(inlineEditingQueuedMessage);
  useLayoutEffect(() => {
    currentPromptDraftRef.current = currentPromptDraft;
    committedInlineEditRef.current = inlineEditingQueuedMessage;
  }, [currentPromptDraft, inlineEditingQueuedMessage]);
  useLayoutEffect(() => {
    activeBottomComposerIdentityRef.current = bottomComposerHostIdentity;

    return () => {
      if (
        activeBottomComposerIdentityRef.current === bottomComposerHostIdentity
      ) {
        activeBottomComposerIdentityRef.current = null;
      }
    };
  }, [bottomComposerHostIdentity]);
  useLayoutEffect(() => {
    activeQueuedComposerIdentityRef.current =
      queuedComposerHostIdentity ?? null;

    return () => {
      if (
        activeQueuedComposerIdentityRef.current === queuedComposerHostIdentity
      ) {
        activeQueuedComposerIdentityRef.current = null;
      }
    };
  }, [queuedComposerHostIdentity]);
  const subscribeBottomDraft = useComposerHostDraftNotifier(currentPromptDraft);

  const subscribeQueuedDraft = useComposerHostDraftNotifier(
    inlineEditingQueuedMessage?.draft ?? null,
  );

  const bottomSelection = useMemo(
    () => ({
      ...(selectedProviderId ? { providerId: selectedProviderId } : {}),
      ...(selectedExecutionModel ? { model: selectedExecutionModel } : {}),
      reasoningLevel,
      ...(selectedExecutionServiceTier !== undefined
        ? { serviceTier: selectedExecutionServiceTier }
        : {}),
      ...(effectivePermissionMode !== undefined
        ? { permissionMode: effectivePermissionMode }
        : {}),
    }),
    [
      effectivePermissionMode,
      reasoningLevel,
      selectedExecutionModel,
      selectedExecutionServiceTier,
      selectedProviderId,
    ],
  );

  const { getSelection, subscribeSelection } = useComposerHostSelection(
    bottomComposerHostIdentity,
    bottomSelection,
  );

  const queuedSelection = useMemo(
    () =>
      inlineEditingQueuedMessage
        ? readExecutionSelection({
            selectedProviderId,
            selectedThreadModel: inlineEditingQueuedMessage.model,
            reasoningLevel: inlineEditingQueuedMessage.reasoningLevel,
            serviceTier: inlineEditingQueuedMessage.serviceTier,
            supportsServiceTier,
            permissionMode: inlineEditingQueuedMessage.permissionMode,
          })
        : NO_QUEUED_EDITOR_SELECTION,
    [inlineEditingQueuedMessage, selectedProviderId, supportsServiceTier],
  );

  const queuedComposerSelection = useComposerHostSelection(
    queuedComposerHostIdentity ?? "",
    queuedSelection,
  );

  const setStoredPromptDraft = promptDraft.setDraft;
  const getStoredPromptDraft = promptDraft.getCurrent;
  const storedPromptDraftKey = promptDraft.storageKey;

  const bottomPluginComposerHost = useMemo<PluginComposerHost | null>(() => {
    if (bottomScope === null) return null;
    const identity = bottomComposerHostIdentity;

    return {
      scope: bottomScope,
      draftScope: composer.draftScope,
      textEffectKey: storedPromptDraftKey,
      getCurrent: () =>
        activeBottomComposerIdentityRef.current === identity
          ? currentPromptDraftRef.current
          : getStoredPromptDraft(),
      subscribeDraft: subscribeBottomDraft,
      getSelection,
      subscribeSelection,
      setDraft: setStoredPromptDraft,
      submit: (options, pluginSubmission) =>
        submitProgrammaticallyRef.current(options, pluginSubmission),
      submitDraft: submitDraftProgrammatically,
      submitVoiceDraft: (draft, transcript, sendReservation, capturedUploads) =>
        submitDraftProgrammatically(
          draft,
          { experimental_data: null },
          undefined,
          sendReservation,
          capturedUploads ?? null,
          false,
          transcript,
        ),
      captureAttachments: captureBottomUploads,
      reserveSubmission: () => reserveMessageSend(threadId),
      focus: () => {
        if (activeBottomComposerIdentityRef.current === identity) {
          setComposerFocusNonce((nonce) => nonce + 1);
        }
      },
    };
  }, [
    composer.draftScope,
    captureBottomUploads,
    bottomComposerHostIdentity,
    bottomScope,
    getStoredPromptDraft,
    getSelection,
    setStoredPromptDraft,
    storedPromptDraftKey,
    submitProgrammaticallyRef,
    submitDraftProgrammatically,
    reserveMessageSend,
    threadId,
    subscribeBottomDraft,
    subscribeSelection,
  ]);

  const queuedPluginComposerHost = useMemo<PluginComposerHost | null>(() => {
    if (
      queuedComposerIdentity === null ||
      queuedComposerHostIdentity === null
    ) {
      return null;
    }

    const identity = queuedComposerHostIdentity;

    const initialDraft = inlineEditingQueuedMessageRef.current?.draft ?? {
      attachments: [],
      mentions: [],
      text: "",
    };

    const queuedEdit = queuedComposerIdentity;

    const isCurrentQueuedEdit = (
      current: typeof inlineEditingQueuedMessageRef.current,
    ): current is NonNullable<typeof current> =>
      queuedEdit !== null &&
      current?.editSessionId === queuedEdit.editSessionId &&
      current.ownerThreadId === queuedEdit.ownerThreadId &&
      current.queuedMessageId === queuedEdit.queuedMessageId;

    return {
      scope: {
        kind: "queued-message",
        threadId: queuedEdit.ownerThreadId,
        queuedMessageId: queuedEdit.queuedMessageId,
      },
      textEffectKey: identity,
      getCurrent: () => {
        if (activeQueuedComposerIdentityRef.current !== identity) {
          return initialDraft;
        }

        const currentQueuedEdit = committedInlineEditRef.current;

        return isCurrentQueuedEdit(currentQueuedEdit)
          ? currentQueuedEdit.draft
          : initialDraft;
      },
      subscribeDraft: subscribeQueuedDraft,
      getSelection: queuedComposerSelection.getSelection,
      subscribeSelection: queuedComposerSelection.subscribeSelection,
      setDraft: (draft) => {
        if (activeQueuedComposerIdentityRef.current !== identity) {
          return;
        }

        updateInlineQueuedMessage((current) =>
          isCurrentQueuedEdit(current) ? { ...current, draft } : current,
        );
      },
      isAvailable: () =>
        activeQueuedComposerIdentityRef.current === identity &&
        isCurrentQueuedEdit(committedInlineEditRef.current),
      focus: () => {
        if (activeQueuedComposerIdentityRef.current === identity) {
          setInlineComposerFocusNonce((nonce) => nonce + 1);
        }
      },
    };
  }, [
    inlineEditingQueuedMessageRef,
    queuedComposerIdentity,
    queuedComposerHostIdentity,
    queuedComposerSelection,
    subscribeQueuedDraft,
    updateInlineQueuedMessage,
  ]);

  const bottomComposerTextEffects = useComposerTextEffects(
    bottomPluginComposerHost?.textEffectKey ?? null,
  );

  const queuedComposerTextEffects = useComposerTextEffects(
    queuedPluginComposerHost?.textEffectKey ?? null,
  );

  const isProvisioningSustained = useSustainedFlag(
    isProvisioning,
    SHORT_LIVED_STATUS_DELAY_MS,
  );

  const composerPlaceholder = isStopRequested
    ? "Stopping thread..."
    : isProvisioningSustained
      ? "Provisioning thread..."
      : (composer.placeholder ?? "Reply…");

  const bottomComposerConfig = useMemo<FollowUpComposerProps>(
    () => ({
      history: {
        currentDraft: currentPromptDraft,
        entries: [],
        onSelectEntry: restoreHistoryDraft,
      } satisfies HistoryConfig,
      isFollowUpSubmitting: false,
      message: currentPromptDraft.text,
      mentionRanges: currentPromptDraft.mentions,
      onChangeMessage: promptDraft.setTextAndMentions,
      onModifierSubmit: handleModifierSubmit,
      onSubmit: handleSubmit,
      compactPromptPlaceholder: composerPlaceholder,
      promptPlaceholder: composerPlaceholder,
      canModifierSubmit: canSubmitModifierShortcut,
      steerActiveThreadOnEnter,
      submitMode,
      threadRuntimeDisplayStatus: displayStatus,
    }),
    [
      canSubmitModifierShortcut,
      composerPlaceholder,
      currentPromptDraft,
      displayStatus,
      handleModifierSubmit,
      handleSubmit,
      restoreHistoryDraft,
      promptDraft.setTextAndMentions,
      steerActiveThreadOnEnter,
      submitMode,
    ],
  );

  const restoreQueuedHistoryDraft = useCallback(
    (draft: PromptDraftState) => {
      if (queuedPluginComposerHost === null)
        throw new Error("This composer is no longer available.");
      createCoreComposerActions(queuedPluginComposerHost).restoreDraft(draft);
    },
    [queuedPluginComposerHost],
  );

  const inlineComposerConfig = useMemo<FollowUpComposerProps | null>(
    () =>
      inlineEditingQueuedMessage
        ? {
            history: {
              currentDraft: activeComposerDraft,
              entries: [],
              onSelectEntry: restoreQueuedHistoryDraft,
            } satisfies HistoryConfig,
            isFollowUpSubmitting: isUpdateQueuedMessagePending,
            message: activeComposerDraft.text,
            mentionRanges: activeComposerDraft.mentions,
            onChangeMessage: handleChangeMessage,
            onModifierSubmit: handleInlineComposerSubmit,
            onSubmit: handleInlineComposerSubmit,
            compactPromptPlaceholder: composerPlaceholder,
            promptPlaceholder: composerPlaceholder,
            canModifierSubmit:
              activeComposerDraftInput.length > 0 &&
              !isUpdateQueuedMessagePending,
            steerActiveThreadOnEnter: false,
            submitMode: { kind: "ready" },
            threadRuntimeDisplayStatus: displayStatus,
          }
        : null,
    [
      activeComposerDraft,
      activeComposerDraftInput.length,
      composerPlaceholder,
      displayStatus,
      handleChangeMessage,
      handleInlineComposerSubmit,
      inlineEditingQueuedMessage,
      restoreQueuedHistoryDraft,
      isUpdateQueuedMessagePending,
    ],
  );

  const bottomAttachmentsConfig = useMemo<AttachmentsConfig>(
    () => ({
      acceptWhileUploading: true,
      items: currentPromptDraft.attachments,
      targetHostId: composer.executionEnvironmentHostId,
      projectId,
      isAttaching: isAttachingBottomFiles,
      pendingUploads: bottomPendingUploads,
      error: bottomAttachmentError,
      onAttachFiles: handleAttachBottomFiles,
      onUpdate: promptDraft.updateAttachments,
    }),
    [
      bottomAttachmentError,
      composer.executionEnvironmentHostId,
      currentPromptDraft.attachments,
      handleAttachBottomFiles,
      isAttachingBottomFiles,
      bottomPendingUploads,
      projectId,
      promptDraft.updateAttachments,
    ],
  );

  const inlineAttachmentsConfig = useMemo<AttachmentsConfig>(
    () => ({
      items: activeComposerDraft.attachments,
      targetHostId: composer.executionEnvironmentHostId,
      projectId,
      isAttaching: isAttachingInlineFiles,
      pendingUploads: inlinePendingUploads,
      error: inlineAttachmentError,
      onAttachFiles: handleAttachInlineFiles,
      onUpdate: updateActiveComposerAttachments,
    }),
    [
      activeComposerDraft.attachments,
      composer.executionEnvironmentHostId,
      inlineAttachmentError,
      handleAttachInlineFiles,
      isAttachingInlineFiles,
      inlinePendingUploads,
      projectId,
      updateActiveComposerAttachments,
    ],
  );

  const applySameProviderTuple = useCallback(
    (selection: ModelPickerSelection) => {
      if (selection.providerId !== selectedProviderId) return;
      setProviderModelReasoning(selection);
    },
    [selectedProviderId, setProviderModelReasoning],
  );

  const bottomExecutionConfig = useMemo<ExecutionControlsProps>(
    () => ({
      providerRouting: executionOptionsRouting,
      catalog: {
        providers: executionProviders,
        verified: modelCatalogIsVerified,
        modelOptions: catalogModelOptions,
      },
      selection: { onChange: applySameProviderTuple },
      provider: {
        options: providerOptions,
        selectedId: selectedProviderId,
        hasMultiple: hasMultipleProviders,
      },
      model: {
        active: activeModel,
        selected: selectedModel,
        options: modelOptions,
        moreOptions: moreModelOptions,
        loadError: modelLoadError,
        notice: modelNotice,
        isLoading: isLoadingModels || isDefaultExecutionOptionsLoading,
        loadFailed: modelLoadFailed,
        onChange: setSelectedModel,
      },
      serviceTier: {
        value: serviceTier,
        onChange: changeSessionSpeed,
        supported: supportsServiceTier,
        options: serviceTierOptions,
      },
      reasoning: {
        value: reasoningLevel,
        options: reasoningOptions,
        isLoading: isLoadingReasoning,
        onChange: setReasoningLevel,
      },
    }),
    [
      activeModel,
      applySameProviderTuple,
      catalogModelOptions,
      executionOptionsRouting,
      executionProviders,
      hasMultipleProviders,
      isDefaultExecutionOptionsLoading,
      isLoadingModels,
      modelCatalogIsVerified,
      modelLoadFailed,
      modelLoadError,
      modelNotice,
      modelOptions,
      moreModelOptions,
      providerOptions,
      reasoningLevel,
      reasoningOptions,
      isLoadingReasoning,
      selectedModel,
      selectedProviderId,
      serviceTier,
      setReasoningLevel,
      setSelectedModel,
      changeSessionSpeed,
      supportsServiceTier,
      serviceTierOptions,
    ],
  );

  const bottomPermissionConfig = useMemo<ExecutionPermissionConfig>(
    () =>
      composer.permissionPolicy === "snapshot"
        ? {
            value: snapshotPermissionMode,
            options: permissionModeOptions,
            onChange: () => {},
            supported: supportsPermissionModeSelection,
          }
        : {
            value: permissionMode,
            options: permissionModeOptions,
            onChange: setPermissionMode,
            supported: supportsPermissionModeSelection,
          },
    [
      composer.permissionPolicy,
      permissionMode,
      permissionModeOptions,
      setPermissionMode,
      snapshotPermissionMode,
      supportsPermissionModeSelection,
    ],
  );

  const inlineQueuedControls = useMemo(
    () =>
      inlineEditingQueuedMessage
        ? inlineQueuedExecutionControls({
            edit: inlineEditingQueuedMessage,
            execution: bottomExecutionConfig,
            permission: bottomPermissionConfig,
            permissionLocked: composer.permissionPolicy === "snapshot",
            providerId: selectedProviderId,
            update: updateInlineQueuedMessage,
          })
        : null,
    [
      bottomExecutionConfig,
      bottomPermissionConfig,
      composer.permissionPolicy,
      inlineEditingQueuedMessage,
      selectedProviderId,
      updateInlineQueuedMessage,
    ],
  );

  const inlineExecutionConfig = inlineQueuedControls?.execution ?? null;
  const inlinePermissionConfig = inlineQueuedControls?.permission ?? null;

  const inlineEditor = useMemo<QueuedMessageInlineEditor | undefined>(() => {
    if (
      !inlineEditingQueuedMessage ||
      !inlineComposerConfig ||
      !inlineExecutionConfig ||
      !inlinePermissionConfig
    ) {
      return undefined;
    }

    return {
      queuedMessageId: inlineEditingQueuedMessage.queuedMessageId,
      queuedMessageIndex: inlineEditingQueuedMessage.queuedMessageIndex,
      onDismiss: dismissInlineQueuedMessageEditor,
      content: (
        <FollowUpPromptBox
          attachments={inlineAttachmentsConfig}
          attention={null}
          stack={null}
          queuedMessageCount={0}
          composer={inlineComposerConfig}
          pluginComposerHost={queuedPluginComposerHost}
          pluginComposerScope={queuedPluginComposerHost?.scope ?? null}
          textEffects={queuedComposerTextEffects}
          contextWindowUsage={null}
          execution={inlineExecutionConfig}
          executionReadOnly
          permission={inlinePermissionConfig}
          permissionReadOnly
          typeahead={typeaheadConfig}
          promptActions={promptActions}
          collapseResetKey={`${surfaceKey}:queued-message:${inlineEditingQueuedMessage.queuedMessageId}`}
          focusEndKey={`${inlineEditingQueuedMessage.editSessionId}:${inlineComposerFocusNonce}`}
          isPrimaryComposer={false}
          showScrollToBottomButton={false}
        />
      ),
    };
  }, [
    dismissInlineQueuedMessageEditor,
    inlineAttachmentsConfig,
    inlineComposerConfig,
    inlineComposerFocusNonce,
    inlineEditingQueuedMessage,
    inlineExecutionConfig,
    inlinePermissionConfig,
    promptActions,
    queuedComposerTextEffects,
    queuedPluginComposerHost,
    surfaceKey,
    typeaheadConfig,
  ]);

  const queuedMessagesStack = useMemo(
    () =>
      queuedMessages.length > 0 && !hasComposerBlockingPendingInteraction ? (
        <LazyQueuedMessagesList
          attachedToComposer
          queuedMessages={queuedMessages}
          resolveMentionLink={resolveMentionLink}
          inlineEditor={inlineEditor}
          sendAction={isProvisioning ? "steer-when-ready" : "send-now"}
          sendDisabled={
            submitMode.kind === "blocked" || queuedMessageActionPending
          }
          actionDisabled={queuedMessageActionPending}
          processingMessageId={processingQueuedMessage?.id ?? null}
          processingAction={processingQueuedMessage?.action ?? null}
          onSend={handleSendQueuedMessage}
          onReorder={handleReorderQueuedMessage}
          onSetGroupBoundary={handleSetQueuedMessageGroupBoundary}
          onEdit={beginEditQueuedMessage}
          onDelete={handleDeleteQueuedMessage}
          expanded={queueExpanded}
          onExpandedChange={setQueueExpanded}
          waitingStartThreadId={
            threadQuery.data?.status === "pending" ? threadId : undefined
          }
        />
      ) : null,
    [
      beginEditQueuedMessage,
      handleDeleteQueuedMessage,
      queueExpanded,
      setQueueExpanded,
      handleReorderQueuedMessage,
      handleSendQueuedMessage,
      handleSetQueuedMessageGroupBoundary,
      inlineEditor,
      isProvisioning,
      processingQueuedMessage?.action,
      processingQueuedMessage?.id,
      hasComposerBlockingPendingInteraction,
      queuedMessageActionPending,
      queuedMessages,
      resolveMentionLink,
      submitMode.kind,
      threadId,
      threadQuery.data?.status,
    ],
  );

  const surfaceClassName =
    surfaceTone === "sidebar" ? "bg-sidebar" : "bg-background";

  const pendingInteractionBanner = hasComposerBlockingPendingInteraction ? (
    <ThreadPendingInteractionBanners
      interactions={composerBlockingPendingInteractions}
      threadId={threadId}
    />
  ) : null;

  const footer = (
    <div className={cn("relative", surfaceClassName)}>
      <OverflowFade placement="above" tone={surfaceTone} />
      <div className="px-4 pb-4 pt-2">
        <FollowUpPromptBox
          attachments={bottomAttachmentsConfig}
          attention={null}
          stack={null}
          queue={queuedMessagesStack}
          queuedMessageCount={
            hasComposerBlockingPendingInteraction ? 0 : queuedMessages.length
          }
          pendingInteraction={pendingInteractionBanner}
          composer={bottomComposerConfig}
          pluginComposerHost={bottomPluginComposerHost}
          voiceDraft={promptDraft}
          pluginComposerScope={bottomPluginComposerHost?.scope ?? null}
          textEffects={bottomComposerTextEffects}
          contextWindowUsage={null}
          execution={bottomExecutionConfig}
          permission={bottomPermissionConfig}
          permissionReadOnly={composer.permissionPolicy === "snapshot"}
          typeahead={typeaheadConfig}
          promptActions={promptActions}
          collapseResetKey={surfaceKey}
          focusEndKey={
            composer.focusRequestKey === undefined
              ? composerFocusNonce
              : `${composerFocusNonce}:${composer.focusRequestKey}`
          }
          isPrimaryComposer={false}
        />
      </div>
    </div>
  );

  const maxWidthClassName = measure === "page" ? "max-w-[760px]" : "max-w-none";

  const timelineBody = (
    <ThreadTimelinePanelContent
      isTurnSubmitting={isTurnSubmitting}
      leadingContent={leadingContent}
      consumerMessageActions={consumerMessageActions}
      includePluginMessageActions={includePluginMessageActions}
      onOpenLink={onOpenLink}
      onOpenLocalFileLink={onOpenLocalFileLink}
      onMessageAddToChat={handleAddToChat}
      onSelectionAddToChat={handleAddToChat}
      projectId={projectId}
      resolveMentionLink={resolveMentionLink}
      threadId={threadId}
      conversation={conversation}
      workspaceRootPath={workspaceRootPath}
    />
  );

  if (layout === "document") {
    return (
      <div
        key={surfaceKey}
        data-thread-window=""
        data-surface-tone={surfaceTone}
        className={cn("flex min-w-0 flex-col", surfaceClassName)}
      >
        <div
          className={cn(
            "mx-auto flex w-full min-w-0 flex-col",
            measure === "page" ? "px-4 pb-3 pt-3" : "px-2 pb-3 pt-3",
            maxWidthClassName,
          )}
        >
          {timelineBody}
        </div>
        <div className="sticky bottom-0 z-20">{footer}</div>
      </div>
    );
  }

  return (
    <div
      data-thread-window=""
      data-surface-tone={surfaceTone}
      className="flex min-h-0 flex-1 flex-col"
    >
      <BottomAnchoredScrollBody
        key={surfaceKey}
        scrollAreaClassName={cn(surfaceClassName, "scroll-pt-4")}
        contentClassName={
          measure === "page" ? "pb-3 !pt-4" : "!px-2 pb-3 !pt-4"
        }
        maxWidthClassName={maxWidthClassName}
        footer={footer}
        animateFollowLatest={
          isTurnSubmitting || isRunningThreadRuntimeDisplayStatus(displayStatus)
        }
      >
        {timelineBody}
      </BottomAnchoredScrollBody>
    </div>
  );
}
