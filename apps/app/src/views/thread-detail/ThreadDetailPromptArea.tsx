import { stageTimelineFollowUp } from "@/lib/send-outbox/stage-timeline-follow-up";
import {
  outboxEntryPlacement,
  queuedMessageShowsInChat,
} from "@/lib/send-outbox/timeline-submissions";
import { usePendingQueueFollowUps } from "@/hooks/usePendingQueueFollowUps";
import { useLiveThreadSpeed } from "@/hooks/useLiveThreadSpeed";
import { ThreadInboxReason } from "@/components/thread/ThreadInboxReason";
import { useThreadInitialLoadPending } from "@/components/thread/ThreadInitialLoad";
import { createCoreComposerActions } from "@/lib/plugin-composer-handle";
import { prepareComposerAttachmentSubmission } from "@/lib/composer-attachment-submission";
import {
  uploadedAttachmentSource,
  type CapturedAttachmentUploads,
} from "@/components/promptbox/usePendingAttachmentUploads";
import {
  useWaitingToSendEntries,
  WaitingToSendCard,
} from "@/components/promptbox/banner/WaitingToSendCard";
import type { ComposerSendSlot } from "@/lib/composer-send-queue";
import { useQueryClient } from "@tanstack/react-query";
import {
  createPendingChat,
  isRecentPendingChatHandoff,
  pendingChatHandoffComposerHeight,
  takePendingChatHandoff,
} from "@/lib/pending-chat-creations";
import { finishTypeAhead } from "@/lib/typed-ahead";
import { movePendingChatDraft } from "@/lib/pending-chat-draft-transfer";
import { PendingThreadChat } from "./PendingThreadChat";
import { prefetchThreadOpen } from "@/hooks/queries/thread-queries";
import { useAppUpdateStatus } from "@/hooks/queries/app-update-queries";
import {
  threadDetailBootstrapQueryKey,
  threadTimelineQueryKey,
} from "@/hooks/queries/query-keys";
import { projectQueuedMessagesForUpdate } from "@/lib/queued-message-wait";
import { withoutQueuedMessages } from "@/lib/compaction-queued-messages";
import { useQueuedMessagesAwaitingCompaction } from "@/components/thread/timeline/CompactionQueuedMessages";
import { LazyThreadDetailView } from "./LazyThreadDetailView";
import { useQueuedMessagesExpanded } from "@/components/promptbox/banner/queued-messages-expanded";
import type { MachineRemovalStatus } from "@/lib/machine-removal-display";
import { ThreadMachineStatus } from "@/components/promptbox/banner/ThreadMachineStatus";
import {
  type ReactNode,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type RefObject,
} from "react";
import { createPortal } from "react-dom";
import { useImmediateRouteNavigate } from "@/components/ui/app-route-anchor";
import type { PromptMentionLinkResolver } from "@/components/promptbox/editor/prompt-mention-link";
import {
  getFollowUpPromptPlaceholder,
  getCompactFollowUpPromptPlaceholder,
} from "@/components/promptbox/follow-up-placeholder";
import type {
  PermissionMode,
  ServiceTier,
  PendingInteraction,
  PromptInput,
  ThreadQueuedMessage,
  ThreadTimelineActivePromptMode,
  ThreadTimelineModelFallback,
  ThreadTimelinePendingTodos,
  ThreadWithRuntime,
} from "@omnyo/domain";
import type {
  ProviderCommand,
  ThreadTimelineSessionOption,
  SendMessageRequest,
  ThreadTimelineResponse,
  TimelineWorkflowWorkRow,
} from "@omnyo/server-contract";
import type {
  ExperimentalComposerSelection,
  ExperimentalComposerSubmitOptions,
} from "@omnyo/plugin-sdk";
import type { ChildThreadPendingAttention } from "@/hooks/queries/child-thread-pending-interactions";
import {
  readExecutionSelection,
  applyComposerExecutionSelection,
  useCommittedComposerState,
  useQueuedComposerSelection,
  type CommittedExecutionSelectionState,
} from "@/components/promptbox/composer-selection-settle";
import { ThreadPendingInteractionBanners } from "@/components/thread/pending-interactions/ThreadPendingInteractionBanner";
import { blocksTurn } from "@/components/thread/pending-interactions/interaction-request";
import { NativeThreadAttention } from "@/components/thread/user-questions/NativeThreadAttention";
import { useThreadAttention } from "@/hooks/queries/thread-attention";
import {
  type PluginComposerHost,
  useComposerHostDraftNotifier,
  useComposerHostSelection,
  usePublishPluginComposerHost,
} from "@/components/plugin/plugin-composer-host";
import {
  ThreadPromptContextBanner,
  type ThreadPromptContextBannerExpandedSection,
  type ThreadPromptParentThreadSection,
  type ThreadPromptChildThreadsSection,
} from "@/components/promptbox/banner/ThreadPromptContextBanner";
import { ThreadContinueControl } from "@/components/thread/ThreadContinueControl";
import { ExecutionControls } from "@/components/promptbox/ExecutionControls";
import { ThreadTodoCard } from "@/components/promptbox/banner/ThreadTodoCard";
import { ThreadPromptModeCard } from "@/components/promptbox/banner/ThreadPromptModeCard";
import { ThreadWorkflowStack } from "@/components/promptbox/banner/ThreadWorkflowStack";
import { ThreadCompanionInlineSlot } from "@/components/thread-companion/ThreadCompanions";
import { ThreadBackgroundCommandsCard } from "@/components/promptbox/banner/ThreadBackgroundCommandsCard";
import { ThreadModelFallbackCard } from "@/components/promptbox/banner/ThreadModelFallbackCard";
import { InlineMessageEditorFrame } from "@/components/promptbox/InlineMessageEditorFrame";
import type { ModelPickerSelection } from "@/components/pickers/model-picker-selection";
import {
  buildSessionOptionMenuSections,
  sessionOptionViewSelections,
  SessionOptionsMenu,
  splitSessionOptionsByPlacement,
  type SessionOptionChoices,
} from "@/components/pickers/SessionOptionsMenu";
import { useThreadSessionOptionChoices } from "./useThreadSessionOptionChoices";
import {
  LazyQueuedMessagesList,
  QueuedMessagesPendingCard,
  type QueuedMessageInlineEditor,
} from "@/components/promptbox/banner/LazyQueuedMessagesList";
import { useComposerTextEffects } from "@/lib/composer-text-effects";
import { useLatestRef } from "@/hooks/useLatestRef";
import type { ClaudeProfileSelection } from "@/hooks/useClaudeAccounts";
import { useThreadCreationOptions } from "@/hooks/useThreadCreationOptions";
import {
  useActiveComposerDraft,
  useComposerAttachmentUploads,
  useDraftAttachmentUploads,
  useComposerTypeahead,
  inlineQueuedExecutionControls,
  useInlineQueuedMessageEditing,
  useQueuedMessageActions,
  type InlineQueuedMessageEditState,
} from "@/components/thread/embedded-chat";
import {
  useCreateThread,
  useCreateThreadQueuedMessage,
  useCancelThreadPlan,
  useStopThread,
} from "@/hooks/mutations/thread-runtime-mutations";
import {
  useRestoreThreadEnvironment,
  useUnarchiveThread,
} from "@/hooks/mutations/thread-state-mutations";
import {
  orderPendingInteractions,
  useThreadQueuedMessages,
  useThreadPromptHistory,
} from "@/hooks/queries/thread-queries";
import { useThreadDefaultExecutionOptions } from "@/hooks/queries/thread-default-execution-options-query";
import { usePredictedSendWait } from "@/hooks/usePredictedSendWait";
import {
  getMutationErrorMessage,
  showMutationErrorToast,
} from "@/lib/mutation-errors";
import { promptHistoryEntriesToDrafts } from "@/lib/prompt-history";
import { usePromptHistoryEnabled } from "@/hooks/usePromptHistoryEnabled";
import { getThreadRoutePath } from "@/lib/route-paths";
import { getThreadDisplayTitle } from "@/lib/thread-title";
import {
  buildThreadHandoffCreateRequest,
  buildThreadHandoffFollowUpDraft,
  stripThreadHandoffPrefix,
  type ThreadHandoffCreateSeed,
} from "@omnyo/client-core";
import {
  emptyPromptDraftState,
  promptDraftToInput,
  type PromptDraftAttachment,
  type PromptDraftState,
} from "@omnyo/client-core";
import {
  FollowUpPromptBox,
  type FollowUpComposerProps,
  type FollowUpPromptBoxProps,
  type FollowUpSubmitMode,
} from "@/components/promptbox/FollowUpPromptBox";
import {
  ComposerWorkingQueueHost,
  type ComposerWorkingState,
} from "@/components/promptbox/ComposerWorkingTab";
import type { SendMessageMutationLike } from "./threadDetailMutationTypes";
import {
  expectedPluginWait,
  type ExpectedPluginWait,
} from "@/lib/expected-plugin-wait";
import { useTimeHasPassed } from "@/hooks/useTimeHasPassed";
import { useAutoCompactionOffer } from "./useAutoCompactionOffer";
import {
  buildAutoFollowUpRequest,
  buildCreateQueuedFollowUpRequest,
  buildFollowUpSubmitMode,
  buildFollowUpShortcutRequest,
  canCompactBeforeSend,
  canSubmitFollowUpShortcut,
  resolveDefaultExecutionOptionsState,
  shouldQueueFollowUpMessage,
  type FollowUpExecutionSelection,
} from "@omnyo/client-core";

const ignoreToastedCreateThreadError = () => {};

export interface ThreadDetailSentMessageEdit {
  draft: PromptDraftState;
  hostElement: HTMLDivElement | null;
  isSubmitting: boolean;
  operationId: string;
  onCancel: () => void;
  onSubmit: (target: {
    execution: FollowUpExecutionSelection;
    input: PromptInput[];
  }) => void;
  updateDraft: (
    update: (current: PromptDraftState) => PromptDraftState,
  ) => void;
}

const THREAD_DETAIL_COMPOSER_TEXTAREA_ID = "thread-detail-follow-up-composer";

const NO_SESSION_OPTION_SELECTIONS: SessionOptionChoices = {};

const EMPTY_QUEUED_MESSAGES: readonly ThreadQueuedMessage[] = [];

const NO_INLINE_EDITOR_SELECTION: ExperimentalComposerSelection = {};

interface ThreadDetailPromptAreaProps {
  ownerRecovery?: ReactNode;
  activeBackgroundAgentCount: number;
  canRestoreEnvironment: boolean;
  contextWindowUsage?: ThreadTimelineResponse["contextWindowUsage"];
  environmentGoneStatus: "destroyed" | MachineRemovalStatus | null;
  environmentHostId?: string;
  pendingInteractions: readonly PendingInteraction[];
  queuedMessageCount: number;
  projectId: string;
  resolveMentionLink: PromptMentionLinkResolver;
  pendingTodos: ThreadTimelinePendingTodos | null;
  activePromptMode: ThreadTimelineActivePromptMode | null;
  providerCommands: readonly ProviderCommand[] | null;
  sessionOptions: readonly ThreadTimelineSessionOption[] | null;
  modelFallback: ThreadTimelineModelFallback | null;
  activeWorkflows: TimelineWorkflowWorkRow[];
  activeBackgroundCommands: TimelineWorkflowWorkRow[];
  parentThreadSection: ThreadPromptParentThreadSection | null;
  childPendingInteractions: readonly ChildThreadPendingAttention[];
  childThreadsSection: ThreadPromptChildThreadsSection | null;
  sendMessage: SendMessageMutationLike;
  sentMessageEdit?: ThreadDetailSentMessageEdit;
  steerActiveThreadOnEnter: boolean;
  composerFocusRequestNonce: number;
  thread: ThreadWithRuntime;
  working: ComposerWorkingState | null;
}

interface InlineDraftComposerOptions {
  attachments: FollowUpPromptBoxProps["attachments"];
  canModifierSubmit: boolean;
  compactPromptPlaceholder: string;
  composerId: string;
  draft: PromptDraftState;
  editFocusNonce: number;
  execution: FollowUpPromptBoxProps["execution"];
  focusSessionKey: string | number;
  historyResetKey: string;
  isSubmitting: boolean;
  onChangeMessage: FollowUpComposerProps["onChangeMessage"];
  onEscape?: FollowUpComposerProps["onEscape"];
  onSelectHistoryEntry: (draft: PromptDraftState) => void;
  permission: FollowUpPromptBoxProps["permission"];
  pluginComposerHost: PluginComposerHost;
  promptActions: FollowUpPromptBoxProps["promptActions"];
  promptPlaceholder: string;
  submit: () => void;
  submitMode: FollowUpSubmitMode;
  submitTitle?: string;
  suppressPluginComposerCustomizations?: boolean;
  textEffects: FollowUpPromptBoxProps["textEffects"];
  threadRuntimeDisplayStatus: FollowUpComposerProps["threadRuntimeDisplayStatus"];
  typeahead: FollowUpPromptBoxProps["typeahead"];
  collapseResetKey: string;
}

function buildInlineDraftComposer(options: InlineDraftComposerOptions) {
  return (
    <FollowUpPromptBox
      id={options.composerId}
      attachments={options.attachments}
      attention={null}
      stack={null}
      queuedMessageCount={0}
      composer={{
        history: {
          currentDraft: options.draft,
          entries: [],
          onSelectEntry: options.onSelectHistoryEntry,
          resetKey: options.historyResetKey,
        },
        isFollowUpSubmitting: options.isSubmitting,
        message: options.draft.text,
        mentionRanges: options.draft.mentions,
        onChangeMessage: options.onChangeMessage,
        onModifierSubmit: options.submit,
        onSubmit: options.submit,
        onEscape: options.onEscape,
        submitTitle: options.submitTitle,
        compactPromptPlaceholder: options.compactPromptPlaceholder,
        promptPlaceholder: options.promptPlaceholder,
        canModifierSubmit: options.canModifierSubmit,
        steerActiveThreadOnEnter: false,
        submitMode: options.submitMode,
        threadRuntimeDisplayStatus: options.threadRuntimeDisplayStatus,
      }}
      pluginComposerHost={options.pluginComposerHost}
      pluginComposerScope={options.pluginComposerHost.scope}
      suppressPluginComposerCustomizations={
        options.suppressPluginComposerCustomizations
      }
      textEffects={options.textEffects}
      contextWindowUsage={null}
      execution={options.execution}
      executionReadOnly
      permission={options.permission}
      permissionReadOnly
      typeahead={options.typeahead}
      promptActions={options.promptActions}
      collapseResetKey={options.collapseResetKey}
      focusEndKey={`${options.focusSessionKey}:${options.editFocusNonce}`}
      isPrimaryComposer={false}
      showScrollToBottomButton={false}
    />
  );
}

interface ThreadComposerSelectionState extends CommittedExecutionSelectionState {
  isHandoffSelection: boolean;
  handoffSelect: (selection: ModelPickerSelection) => void;
}

type InlineQueuedMessageEditSession = Pick<
  InlineQueuedMessageEditState,
  "editSessionId" | "queuedMessageId"
>;

function isInlineQueuedMessageEditSession(
  current: InlineQueuedMessageEditState | null,
  session: InlineQueuedMessageEditSession,
): current is InlineQueuedMessageEditState {
  return (
    current?.editSessionId === session.editSessionId &&
    current.queuedMessageId === session.queuedMessageId
  );
}

const ENDED_EDIT_SESSION_DRAFT = emptyPromptDraftState();

function readInlineQueuedMessageDraft(
  editStateRef: RefObject<InlineQueuedMessageEditState | null>,
  session: InlineQueuedMessageEditSession,
  fallback: PromptDraftState,
): PromptDraftState {
  const current = editStateRef.current;

  return isInlineQueuedMessageEditSession(current, session)
    ? current.draft
    : fallback;
}

function writeInlineQueuedMessageDraft(
  editStateRef: RefObject<InlineQueuedMessageEditState | null>,
  session: InlineQueuedMessageEditSession,
  draft: PromptDraftState,
  commit: (next: InlineQueuedMessageEditState) => void,
): void {
  const current = editStateRef.current;

  if (isInlineQueuedMessageEditSession(current, session)) {
    commit({ ...current, draft });
  }
}

function readSentMessageEditDraft(
  sentMessageEditRef: RefObject<ThreadDetailSentMessageEdit | undefined>,
  operationId: string,
  fallback: PromptDraftState,
): PromptDraftState {
  const current = sentMessageEditRef.current;

  return current?.operationId === operationId ? current.draft : fallback;
}

function writeSentMessageEditDraft(
  sentMessageEditRef: RefObject<ThreadDetailSentMessageEdit | undefined>,
  operationId: string,
  nextDraft: PromptDraftState,
): void {
  const current = sentMessageEditRef.current;

  if (current?.operationId === operationId) {
    current.updateDraft(() => nextDraft);
  }
}

async function runWhileFollowUpShortcutSending(
  setSending: (sending: boolean) => void,
  task: () => Promise<void>,
): Promise<void> {
  setSending(true);

  try {
    await task();
  } finally {
    setSending(false);
  }
}

export function ThreadDetailPromptArea({
  ownerRecovery,
  activeBackgroundAgentCount,
  canRestoreEnvironment,
  contextWindowUsage,
  environmentGoneStatus,
  environmentHostId,
  pendingInteractions,
  queuedMessageCount,
  projectId,
  resolveMentionLink,
  pendingTodos,
  activePromptMode,
  providerCommands,
  sessionOptions,
  modelFallback,
  activeWorkflows,
  activeBackgroundCommands,
  parentThreadSection,
  childPendingInteractions,
  childThreadsSection,
  sendMessage,
  sentMessageEdit,
  steerActiveThreadOnEnter,
  composerFocusRequestNonce,
  thread,
  working,
}: ThreadDetailPromptAreaProps) {
  const nativeAttention = useThreadAttention();

  const hasNativeAttention =
    nativeAttention.error !== null ||
    nativeAttention.data?.questions.some(
      (question) => question.threadId === thread.id,
    ) === true ||
    nativeAttention.data?.callbacks.some(
      (wait) =>
        wait.threadId === thread.id || wait.sourceThreadId === thread.id,
    ) === true;

  const hasRequiredNativeQuestion =
    nativeAttention.data?.questions.some(
      (question) =>
        question.threadId === thread.id &&
        question.question.mode === "required",
    ) === true;

  const navigate = useImmediateRouteNavigate();

  const defaultExecutionOptionsQuery = useThreadDefaultExecutionOptions(
    thread.id,
    {
      enabled: true,
    },
  );

  const defaultExecutionOptions = defaultExecutionOptionsQuery.data;

  const verifiedDefaultExecutionOptions = defaultExecutionOptions;

  const hasResolvedDefaultExecutionOptions =
    verifiedDefaultExecutionOptions !== undefined;

  const hasConcreteDefaultExecutionOptions =
    verifiedDefaultExecutionOptions !== undefined &&
    verifiedDefaultExecutionOptions !== null;

  const defaultExecutionOptionsState = resolveDefaultExecutionOptionsState({
    hasConcreteDefaultExecutionOptions,
    hasResolvedDefaultExecutionOptions,
    isError: defaultExecutionOptionsQuery.isError,
  });

  const isDefaultExecutionOptionsLoading =
    defaultExecutionOptionsState === "loading";

  const queuedMessagesQuery = useThreadQueuedMessages(thread.id, {
    enabled: true,
  });

  useThreadInitialLoadPending(
    defaultExecutionOptionsQuery.isLoading || queuedMessagesQuery.isLoading,
  );

  const { data: appUpdateStatus } = useAppUpdateStatus({
    enabled: false,
  });

  const queuedMessages = useMemo(
    () =>
      projectQueuedMessagesForUpdate({
        queuedMessages: queuedMessagesQuery.data ?? EMPTY_QUEUED_MESSAGES,
        threadStatus: thread.status,
        newTurnsPausedForUpdate:
          appUpdateStatus?.newTurnsPausedForUpdate ?? false,
      }),
    [
      queuedMessagesQuery.data,
      thread.status,
      appUpdateStatus?.newTurnsPausedForUpdate,
    ],
  );

  const queuedMessagesPending =
    queuedMessagesQuery.data === undefined && queuedMessageCount > 0;

  const queuedMessagesRef =
    useLatestRef<readonly ThreadQueuedMessage[]>(queuedMessages);

  const [bottomPluginFocusNonce, setBottomPluginFocusNonce] = useState(0);
  const [editFocusNonce, setEditFocusNonce] = useState(0);

  const focusBottomPluginComposer = useCallback(() => {
    setBottomPluginFocusNonce((nonce) => nonce + 1);
  }, []);

  const focusInlinePluginComposer = useCallback(() => {
    setEditFocusNonce((nonce) => nonce + 1);
  }, []);

  const sentMessageEditRef = useLatestRef(sentMessageEdit);
  const clearInlineAttachmentErrorRef = useRef<() => void>(() => {});

  const {
    inlineEditingQueuedMessage,
    inlineEditingQueuedMessageRef,
    commitInlineQueuedMessage,
    updateInlineQueuedMessage,
    dismissInlineQueuedMessageEditor,
    beginEditQueuedMessage,
    queuedMessageDraftSession,
  } = useInlineQueuedMessageEditing({
    ownerThreadId: thread.id,
    queuedMessages,
    onBeginEdit: () => {
      clearInlineAttachmentErrorRef.current();
      setEditFocusNonce((nonce) => nonce + 1);
    },
  });

  const inlineDraftSession = queuedMessageDraftSession;
  const inlineDraftSessionRef = useLatestRef(inlineDraftSession);
  const promptHistoryEnabled = usePromptHistoryEnabled();

  const { data: promptHistoryEntries = [] } = useThreadPromptHistory(
    thread.id,
    {
      enabled: promptHistoryEnabled,
    },
  );

  const createQueuedMessage = useCreateThreadQueuedMessage();
  const stopThread = useStopThread();
  const cancelThreadPlan = useCancelThreadPlan();
  const unarchiveThread = useUnarchiveThread();
  const restoreThreadEnvironment = useRestoreThreadEnvironment();
  const createThread = useCreateThread();
  const createThreadAsync = createThread.mutateAsync;
  const sendMessageAsync = sendMessage.mutateAsync;
  const reserveMessageSend = sendMessage.reserve;
  const queryClient = useQueryClient();

  const {
    promptDraft,
    currentPromptDraft,
    currentPromptDraftInput,
    activeComposerDraft,
    activeComposerDraftInput,
    handleChangeMessage: handleComposerMessageChange,
    updateActiveComposerAttachments,
  } = useActiveComposerDraft({
    draftScope: {
      kind: "thread",
      projectId,
      threadId: thread.id,
    },
    inlineDraft: inlineEditingQueuedMessage?.draft ?? null,
    inlineSessionRef: inlineDraftSessionRef,
  });

  const clearSubmittedDraft = promptDraft.clearIfCurrentMatches;
  const restoreFailedDraft = promptDraft.restoreFailedDraft;

  const subscribeInlineQueuedDraft = useComposerHostDraftNotifier(
    inlineEditingQueuedMessage?.draft ?? null,
  );

  const subscribeSentMessageEditDraft = useComposerHostDraftNotifier(
    sentMessageEdit?.draft ?? null,
  );

  const updateSentMessageEditDraft = sentMessageEdit?.updateDraft;

  const addSentMessageEditAttachment = useCallback(
    (attachment: PromptDraftAttachment) => {
      updateSentMessageEditDraft?.((current) =>
        current.attachments.some(
          (existing) => existing.path === attachment.path,
        )
          ? current
          : {
              ...current,
              attachments: [...current.attachments, attachment],
            },
      );
    },
    [updateSentMessageEditDraft],
  );

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
    inlineEditSessionId: inlineDraftSession?.editSessionId ?? null,
    inlineSessionRef: inlineDraftSessionRef,
  });

  const {
    attachmentError: sentMessageAttachmentError,
    handleAttachFiles: handleAttachSentMessageFiles,
    isAttachingFiles: isAttachingSentMessageFiles,
    pendingUploads: sentMessagePendingUploads,
  } = useDraftAttachmentUploads({
    projectId,
    target: sentMessageEdit
      ? {
          key: sentMessageEdit.operationId,
          addAttachment: addSentMessageEditAttachment,
        }
      : null,
  });

  useLayoutEffect(() => {
    clearInlineAttachmentErrorRef.current = () =>
      setInlineAttachmentError(null);
  }, [setInlineAttachmentError]);
  const promptTextEffects = useComposerTextEffects(promptDraft.storageKey);

  const queuedComposerTextEffects = useComposerTextEffects(
    inlineEditingQueuedMessage
      ? `queued-message:${thread.id}:${inlineEditingQueuedMessage.queuedMessageId}:${inlineEditingQueuedMessage.editSessionId}`
      : null,
  );

  const sentMessageComposerTextEffects = useComposerTextEffects(
    sentMessageEdit
      ? `sent-message:${thread.id}:${sentMessageEdit.operationId}`
      : null,
  );

  const [expandedBannerSection, setExpandedBannerSection] =
    useState<ThreadPromptContextBannerExpandedSection | null>(null);

  const [isTodoExpanded, setIsTodoExpanded] = useState(false);
  const [isPromptModeExpanded, setIsPromptModeExpanded] = useState(false);

  const [expandedWorkflowIds, setExpandedWorkflowIds] = useState<
    ReadonlySet<string>
  >(() => new Set());

  const toggleWorkflowExpanded = useCallback((workflowId: string) => {
    setExpandedWorkflowIds((current) => {
      const next = new Set(current);

      if (!next.delete(workflowId)) {
        next.add(workflowId);
      }

      return next;
    });
  }, []);

  const [workflowStackExpandedThreadId, setWorkflowStackExpandedThreadId] =
    useState<string | null>(null);

  const runningWorkflowCount = activeWorkflows.filter(
    (workflow) => workflow.status === "pending",
  ).length;

  if (workflowStackExpandedThreadId !== null && runningWorkflowCount < 2) {
    setWorkflowStackExpandedThreadId(null);
  }

  const isWorkflowStackExpanded = workflowStackExpandedThreadId === thread.id;

  const [queueExpanded, setQueueExpanded] = useQueuedMessagesExpanded({
    threadId: thread.id,
    queuedMessages: queuedMessagesQuery.data ?? null,
  });

  const [isBackgroundCommandsExpanded, setIsBackgroundCommandsExpanded] =
    useState(false);

  const [isFollowUpShortcutSending, setIsFollowUpShortcutSending] =
    useState(false);

  const promptHistoryDrafts = useMemo(
    () => promptHistoryEntriesToDrafts(promptHistoryEntries),
    [promptHistoryEntries],
  );

  const [handoffSourceSelection, setHandoffSourceSelection] = useState<{
    threadId: string;
    execution: ModelPickerSelection;
    serviceTier: ServiceTier | undefined;
    permissionMode: PermissionMode;
  } | null>(null);

  const isHandoffSelection = handoffSourceSelection?.threadId === thread.id;

  const threadClaudeProfile: ClaudeProfileSelection | undefined =
    isHandoffSelection
      ? undefined
      : thread.claudeProfileBinding
        ? { kind: "profile", profileId: thread.claudeProfileBinding.profileId }
        : { kind: "unprofiled" };

  const sessionOptionChoices = useThreadSessionOptionChoices({
    threadId: thread.id,
    options: sessionOptions,
  });

  const placedSessionOptions = useMemo(
    () => splitSessionOptionsByPlacement(sessionOptions ?? []),
    [sessionOptions],
  );

  const liveSessionOptionSelections = useMemo(
    () =>
      isHandoffSelection
        ? NO_SESSION_OPTION_SELECTIONS
        : sessionOptionViewSelections(
            sessionOptions ?? [],
            sessionOptionChoices.choices,
          ),
    [isHandoffSelection, sessionOptionChoices.choices, sessionOptions],
  );

  const pickerSessionOptionSections = useMemo(
    () =>
      buildSessionOptionMenuSections(
        placedSessionOptions.picker,
        sessionOptionChoices.choices,
      ),
    [placedSessionOptions.picker, sessionOptionChoices.choices],
  );

  const {
    executionOptionsRouting,
    selectedProviderId,
    setSelectedProviderId,
    setProviderModelReasoning,
    providers,
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
    isLoadingModels,
    modelCatalogIsSettled,
    modelCatalogIsVerified,
    modelLoadFailed,
    modelLoadError,
    modelNotice,
    reasoningOptions,
    isLoadingReasoning,
    permissionModeOptions,
    supportsPermissionModeSelection,
    supportsServiceTier,
    serviceTierOptions,
    executionInputSources,
  } = useThreadCreationOptions({
    claudeProfile: threadClaudeProfile,
    automaticClaudeProfile: isHandoffSelection,
    claudeProjectId: thread.projectId,
    enabled: thread.archivedAt === null,
    environmentId: thread.environmentId ?? undefined,
    environmentHostId,
    scope: "component-local",
    resetKey: thread.id,
    sessionOptionSelections: liveSessionOptionSelections,
    initialProviderId: thread.providerId,
    initialModel: defaultExecutionOptions?.model,
    initialServiceTier: defaultExecutionOptions?.serviceTier,
    initialReasoningLevel: defaultExecutionOptions?.reasoningLevel,
    initialPermissionMode: defaultExecutionOptions?.permissionMode,
    initialEnvironmentSelectionValue: thread.environmentId ?? undefined,
  });

  const changeSessionSpeed = useLiveThreadSpeed({
    threadId: isHandoffSelection ? null : thread.id,
    value: serviceTier,
    onChange: setServiceTier,
  });

  const effectiveSelectedModel = activeModel?.model ?? selectedModel;

  const sourceThreadDisplayTitle = getThreadDisplayTitle({
    id: thread.id,
    title: thread.title,
    titleFallback: thread.titleFallback,
  });

  const handoffSeed = useMemo<ThreadHandoffCreateSeed>(
    () => ({
      environmentId: thread.environmentId,
      projectId: thread.projectId,
      sourceThreadId: thread.id,
      sourceThreadTitle: sourceThreadDisplayTitle,
    }),
    [
      sourceThreadDisplayTitle,
      thread.environmentId,
      thread.id,
      thread.projectId,
    ],
  );

  const beginHandoff = useCallback(() => {
    setHandoffSourceSelection((current) =>
      current?.threadId === thread.id
        ? current
        : {
            threadId: thread.id,
            execution: {
              providerId: thread.providerId,
              model: effectiveSelectedModel,
              reasoningLevel,
            },
            serviceTier,
            permissionMode,
          },
    );
    const currentDraft = promptDraft.getCurrent();

    const seededDraft = buildThreadHandoffFollowUpDraft(
      handoffSeed,
      currentDraft,
    );

    if (seededDraft !== currentDraft) {
      promptDraft.setDraft(seededDraft);
    }
  }, [
    effectiveSelectedModel,
    handoffSeed,
    permissionMode,
    promptDraft,
    reasoningLevel,
    serviceTier,
    thread.id,
    thread.providerId,
  ]);

  const exitHandoff = useCallback(() => {
    if (handoffSourceSelection?.threadId !== thread.id) return;
    setProviderModelReasoning(handoffSourceSelection.execution);
    setServiceTier(handoffSourceSelection.serviceTier);
    setPermissionMode(handoffSourceSelection.permissionMode);
    setHandoffSourceSelection(null);

    const restoredDraft = stripThreadHandoffPrefix(
      handoffSeed,
      promptDraft.getCurrent(),
    );

    if (restoredDraft !== null) {
      promptDraft.setDraft(restoredDraft);
    }
  }, [
    handoffSeed,
    handoffSourceSelection,
    promptDraft,
    setPermissionMode,
    setProviderModelReasoning,
    setServiceTier,
    thread.id,
  ]);

  const handleProviderChange = useCallback(
    (providerId: string) => {
      if (providerId === selectedProviderId) {
        return;
      }

      beginHandoff();
      setSelectedProviderId(providerId);
    },
    [selectedProviderId, setSelectedProviderId, beginHandoff],
  );

  const handleHandoffSelect = useCallback(
    (selection: ModelPickerSelection) => {
      beginHandoff();
      setProviderModelReasoning(selection);
    },
    [beginHandoff, setProviderModelReasoning],
  );

  const applyExecutionTuple = useCallback(
    (selection: ModelPickerSelection) => {
      if (isHandoffSelection || selection.providerId !== thread.providerId) {
        handleHandoffSelect(selection);

        return;
      }

      setProviderModelReasoning(selection);
    },
    [
      handleHandoffSelect,
      isHandoffSelection,
      setProviderModelReasoning,
      thread.providerId,
    ],
  );

  const applySourceProviderTuple = useCallback(
    (selection: ModelPickerSelection) => {
      if (selection.providerId !== thread.providerId) return;
      applyExecutionTuple(selection);
    },
    [applyExecutionTuple, thread.providerId],
  );

  useEffect(() => {
    if (isHandoffSelection) {
      return;
    }

    const restoredDraft = stripThreadHandoffPrefix(
      handoffSeed,
      promptDraft.getCurrent(),
    );

    if (restoredDraft !== null) {
      promptDraft.setDraft(restoredDraft);
    }
  }, [handoffSeed, isHandoffSelection, promptDraft]);
  const hasSentMessageEdit = sentMessageEdit !== undefined;
  useEffect(() => {
    if (hasSentMessageEdit && isHandoffSelection) {
      exitHandoff();
    }
  }, [hasSentMessageEdit, isHandoffSelection, exitHandoff]);

  const { typeaheadConfig, promptActions } = useComposerTypeahead({
    projectId: thread.projectId,
    mentionsProjectId: projectId,
    providerId: selectedProviderId,
    commandScope: isHandoffSelection ? "new-thread" : "thread",
    environmentId: thread.environmentId,
    currentThreadId: thread.id,
    selectedProviderComposerActions,
    threadProviderCommands:
      selectedProviderId === thread.providerId ? providerCommands : null,
    resolveMentionLink,
  });

  const {
    typeaheadConfig: inlineTypeaheadConfig,
    promptActions: inlinePromptActions,
  } = useComposerTypeahead({
    projectId: thread.projectId,
    mentionsProjectId: projectId,
    providerId: thread.providerId,
    environmentId: thread.environmentId,
    currentThreadId: thread.id,
    selectedProviderComposerActions: providers.find(
      (provider) => provider.id === thread.providerId,
    )?.composerActions,
    threadProviderCommands: providerCommands,
    resolveMentionLink,
  });

  const runtimeDisplayStatus = thread.runtime.displayStatus;
  const compactionOfferAt = contextWindowUsage?.compactionOfferAt;

  const compactionOfferDue = useTimeHasPassed(
    compactionOfferAt === undefined ? null : Date.parse(compactionOfferAt),
  );

  const [fullHistoryThreadId, setFullHistoryThreadId] = useState<string | null>(
    null,
  );

  const compactBeforeSendTokens =
    compactionOfferDue &&
    contextWindowUsage &&
    canCompactBeforeSend(runtimeDisplayStatus)
      ? contextWindowUsage.usedTokens
      : null;

  const compactFirst =
    compactBeforeSendTokens !== null && fullHistoryThreadId !== thread.id;

  const autoCompactionOffer = useAutoCompactionOffer({
    autoCompactionAt: contextWindowUsage?.autoCompactionAt,
    autoCompactionOptedOut: contextWindowUsage?.autoCompactionOptedOut === true,
    runtimeDisplayStatus,
    threadId: thread.id,
  });

  const shouldSteerWhenReady =
    runtimeDisplayStatus === "provisioning" ||
    runtimeDisplayStatus === "starting";

  const isStopRequested =
    thread.status === "stopping" ||
    (stopThread.isPending && stopThread.variables === thread.id);

  const orderedPendingInteractions =
    orderPendingInteractions(pendingInteractions);

  const blockingPendingInteractions =
    orderedPendingInteractions.filter(blocksTurn);

  const pinnedPendingInteractions = orderedPendingInteractions.filter(
    (interaction) => !blocksTurn(interaction),
  );

  const hasPendingInteraction = blockingPendingInteractions.length > 0;

  const shouldHideComposer =
    environmentGoneStatus !== null || thread.archivedAt !== null;

  const {
    processingQueuedMessage: displayedProcessingQueuedMessage,
    queuedMessageActionPending,
    isUpdateQueuedMessagePending,
    sendQueuedMessageById,
    handleSaveInlineQueuedMessage,
    handleDeleteQueuedMessage,
    handleReorderQueuedMessage,
    handleSetQueuedMessageGroupBoundary,
  } = useQueuedMessageActions({
    threadId: thread.id,
    queuedMessages,
    sendProcessingPersistence: "until-left-queue",
    onSendSuccess: () => setInlineAttachmentError(null),
    onSaveSuccess: () => setInlineAttachmentError(null),
    inlineEditingQueuedMessage,
    dismissInlineQueuedMessageEditor,
    activeComposerDraftInput,
  });

  const isQueueMutationPending =
    createQueuedMessage.isPending ||
    queuedMessageActionPending ||
    isFollowUpShortcutSending;

  const isFollowUpSubmitting =
    createThread.isPending || isFollowUpShortcutSending;

  const handleStopThread = useCallback(() => {
    stopThread.mutate(thread.id);
  }, [stopThread, thread.id]);

  const handleCancelPlan = useCallback(() => {
    cancelThreadPlan.mutate(thread.id);
  }, [cancelThreadPlan, thread.id]);

  const submitMode = useMemo<FollowUpSubmitMode>(() => {
    if (isHandoffSelection && !isStopRequested) {
      if (effectiveSelectedModel.length > 0) {
        return { kind: "ready" };
      }

      return {
        kind: "blocked",
        reason: modelLoadFailed ? "unavailable" : "loading-execution-options",
      };
    }

    return buildFollowUpSubmitMode({
      hasPendingInteraction: hasPendingInteraction || hasRequiredNativeQuestion,
      isDefaultExecutionOptionsLoading: false,
      isStopRequested,
      onStop: handleStopThread,
      runtimeDisplayStatus,
    });
  }, [
    effectiveSelectedModel,
    handleStopThread,
    hasPendingInteraction,
    hasRequiredNativeQuestion,
    isHandoffSelection,
    modelLoadFailed,
    isStopRequested,
    runtimeDisplayStatus,
  ]);

  const promptPlaceholder = getFollowUpPromptPlaceholder(
    isStopRequested ? "stopping" : runtimeDisplayStatus,
  );

  const compactPromptPlaceholder = getCompactFollowUpPromptPlaceholder(
    isStopRequested ? "stopping" : runtimeDisplayStatus,
  );

  const submitProgrammaticallyRef = useRef<
    (
      options: ExperimentalComposerSubmitOptions,
      pluginSubmission: SendMessageRequest["pluginSubmission"],
    ) => Promise<void>
  >(async () => {});

  const submitProgrammaticallyThroughRef = useCallback(
    (
      options: ExperimentalComposerSubmitOptions,
      pluginSubmission: SendMessageRequest["pluginSubmission"],
    ) => submitProgrammaticallyRef.current(options, pluginSubmission),
    [],
  );

  const providerIds = useMemo(
    () => providerOptions.map((option) => option.value),
    [providerOptions],
  );

  const selectionState =
    useCommittedComposerState<ThreadComposerSelectionState>((version) => ({
      version,
      isSettled: modelCatalogIsSettled,
      selectedProviderId,
      selectedThreadModel: effectiveSelectedModel,
      reasoningLevel,
      serviceTier,
      supportsServiceTier,
      permissionMode,
      providerIds,
      isHandoffSelection,
      changeProvider: handleProviderChange,
      changeModel: setSelectedModel,
      handoffSelect: handleHandoffSelect,
      changeReasoning: setReasoningLevel,
      changeServiceTier: changeSessionSpeed,
      changeExecution: applyExecutionTuple,
      changePermissionMode: setPermissionMode,
    }));

  const composerSelection = useMemo(
    () =>
      readExecutionSelection({
        selectedProviderId,
        selectedThreadModel: effectiveSelectedModel,
        reasoningLevel,
        serviceTier,
        supportsServiceTier,
        permissionMode,
      }),
    [
      effectiveSelectedModel,
      permissionMode,
      reasoningLevel,
      selectedProviderId,
      serviceTier,
      supportsServiceTier,
    ],
  );

  const { getSelection, subscribeSelection } = useComposerHostSelection(
    promptDraft.storageKey,
    composerSelection,
  );

  const applySelection = useCallback(
    async (selection: ExperimentalComposerSelection, deadline: number) => {
      const state = await selectionState.observer.waitUntil(
        () => true,
        deadline,
      );

      const applied = await applyComposerExecutionSelection(
        selectionState,
        state,
        deadline,
        selection,
        {
          changeModel(current, model) {
            if (current.isHandoffSelection) {
              current.handoffSelect({
                providerId: current.selectedProviderId,
                model,
                reasoningLevel:
                  selection.reasoningLevel ?? current.reasoningLevel,
              });
            } else {
              current.changeModel(model);
            }
          },
        },
      );

      return readExecutionSelection(applied);
    },
    [selectionState],
  );

  const setSelection = useQueuedComposerSelection(applySelection);

  const hasPromptDraftInput =
    currentPromptDraftInput.length > 0 || bottomPendingUploads.length > 0;

  const predictedSendWait = usePredictedSendWait({
    enabled:
      (submitMode.kind === "ready" ||
        submitMode.kind === "queue" ||
        submitMode.kind === "queue-while-stopping") &&
      !isHandoffSelection &&
      !shouldHideComposer,
    mode: "queue-if-active",
    threadId: thread.id,
  });

  const sendWouldQueue = predictedSendWait !== null;

  useEffect(() => {
    if (sendWouldQueue) void LazyQueuedMessagesList.preload();
  }, [sendWouldQueue]);

  const queuedSendForecast = useMemo(
    () =>
      predictedSendWait === null || !hasPromptDraftInput
        ? null
        : { waitingOn: predictedSendWait, sendAt: null },
    [hasPromptDraftInput, predictedSendWait],
  );

  const canSubmitModifierShortcut =
    !shouldHideComposer &&
    canSubmitFollowUpShortcut({
      hasPromptDraftInput,
      isFollowUpSubmitting: false,
      isQueueMutationPending: hasPromptDraftInput
        ? false
        : isQueueMutationPending,
      queuedMessageCount: queuedMessages.length,
      runtimeDisplayStatus,
      submitModeKind: submitMode.kind,
    });

  const followUpExecutionSelection = useMemo<FollowUpExecutionSelection>(() => {
    if (effectiveSelectedModel.length === 0) {
      return null;
    }

    return {
      model: effectiveSelectedModel,
      supportsServiceTier,
      serviceTier,
      reasoningLevel,
      permissionMode,
      executionInputSources,
    };
  }, [
    effectiveSelectedModel,
    executionInputSources,
    permissionMode,
    reasoningLevel,
    serviceTier,
    supportsServiceTier,
  ]);

  const createHandoffThread = useCallback(
    async (
      submittedDraft: PromptDraftState,
      sendAt?: number,
      pluginSubmission?: SendMessageRequest["pluginSubmission"],
      capturedUploads: CapturedAttachmentUploads | null = null,
      heldWait?: ExpectedPluginWait,
    ) => {
      if (
        promptDraftToInput(submittedDraft).length === 0 &&
        capturedUploads === null
      )
        return false;

      const submission = prepareComposerAttachmentSubmission({
        scope: { kind: "thread", projectId, threadId: thread.id },
        draft: submittedDraft,
        uploads: capturedUploads,
      });

      clearSubmittedDraft(submittedDraft);
      const sourcePathname = window.location.pathname;
      setBottomAttachmentError(null);
      let pendingThreadId: string | undefined;

      try {
        const baseRequest = buildThreadHandoffCreateRequest({
          execution: {
            providerId: selectedProviderId,
            model: effectiveSelectedModel,
            reasoningLevel,
            serviceTier,
            supportsServiceTier,
            permissionMode,
          },
          draft:
            submission.input.length > 0 &&
            promptDraftToInput(submittedDraft).length === 0
              ? { ...submittedDraft, text: "Uploading attachments" }
              : submittedDraft,
          seed: handoffSeed,
          ...(sendAt === undefined ? {} : { sendAt }),
        });

        if (baseRequest === null) {
          throw new Error("Type a message before submitting it.");
        }

        const request = {
          ...baseRequest,
          providerId: selectedProviderId,
          model: effectiveSelectedModel,
          reasoningLevel,
          permissionMode,
          executionInputSources: {
            providerId: "explicit" as const,
            model: "explicit" as const,
            reasoningLevel: "explicit" as const,
            permissionMode: "explicit" as const,
            ...(supportsServiceTier && serviceTier
              ? { serviceTier: "explicit" as const }
              : {}),
          },
          input: submission.input,
          ...(pluginSubmission === undefined ? {} : { pluginSubmission }),
          ...(heldWait === undefined ? {} : { expectedPluginWait: heldWait }),
        };

        const pending = createPendingChat({
          request: {
            ...request,
            ...(capturedUploads === null ? {} : { capturedUploads }),
            ...(submission.prepareInput === undefined
              ? {}
              : { prepareInput: submission.prepareInput }),
          },
          queueOwner: queryClient,
          create: (preparedRequest, context) =>
            createThreadAsync({
              ...preparedRequest,
              outbox: context,
            }),
          send: sendMessageAsync,
          renderer: PendingThreadChat,
          prepare: async (threadId) => {
            await Promise.all([
              prefetchThreadOpen(queryClient, threadId, true),
              LazyThreadDetailView.preload(),
            ]);

            if (
              queryClient.getQueryState(threadDetailBootstrapQueryKey(threadId))
                ?.status !== "success" ||
              queryClient.getQueryState(threadTimelineQueryKey(threadId))
                ?.status !== "success"
            ) {
              throw new Error("The new chat could not load yet.");
            }
          },
        });

        pendingThreadId = pending.id;

        if (window.location.pathname === sourcePathname) {
          navigate(
            getThreadRoutePath({
              projectId: request.projectId,
              threadId: pending.id,
            }),
          );
        }

        await pending.completion;
        submission.complete();
      } catch (error) {
        if (pendingThreadId !== undefined) {
          movePendingChatDraft(handoffSeed.projectId, pendingThreadId, {
            kind: "new-thread",
          });
        }

        submission.restoreFailed(restoreFailedDraft);

        throw error;
      }

      return true;
    },
    [
      projectId,
      queryClient,
      thread.id,
      createThreadAsync,
      sendMessageAsync,
      effectiveSelectedModel,
      handoffSeed,
      navigate,
      permissionMode,
      clearSubmittedDraft,
      restoreFailedDraft,
      reasoningLevel,
      selectedProviderId,
      serviceTier,
      setBottomAttachmentError,
      supportsServiceTier,
    ],
  );

  const handleSend = useCallback(
    async (options?: { sendNow?: true }) => {
      const submittedDraft = promptDraft.getCurrent();
      const capturedUploads = captureBottomUploads();

      if (isHandoffSelection) {
        await createHandoffThread(
          submittedDraft,
          undefined,
          undefined,
          capturedUploads,
        ).catch(ignoreToastedCreateThreadError);

        return;
      }

      const isQueuingMessage =
        shouldQueueFollowUpMessage(runtimeDisplayStatus) && !options?.sendNow;

      const submission = prepareComposerAttachmentSubmission({
        scope: { kind: "thread", projectId, threadId: thread.id },
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

      try {
        if (
          !options?.sendNow &&
          !compactFirst &&
          (await stageTimelineFollowUp({
            queryClient,
            threadId: thread.id,
            projectId,
            submission,
            execution: followUpExecutionSelection,
            sourceOf: uploadedAttachmentSource,
          }))
        ) {
          setFullHistoryThreadId(null);
          submission.complete();

          return;
        }

        if (isQueuingMessage) {
          const request = buildCreateQueuedFollowUpRequest({
            threadId: thread.id,
            input: submission.input,
            execution: followUpExecutionSelection,
          });

          if (request) {
            await createQueuedMessage.mutateAsync({
              ...request,
              ...options,
              prepareInput: submission.prepareInput,
            });
          }
        } else {
          const request = buildAutoFollowUpRequest({
            compactFirst,
            threadId: thread.id,
            input: submission.input,
            execution: followUpExecutionSelection,
          });

          if (request) {
            await sendMessage.mutateAsync({
              ...request,
              ...options,
              prepareInput: submission.prepareInput,
            });
            setFullHistoryThreadId(null);
          }
        }

        submission.complete();
      } catch (nextError) {
        submission.restoreFailed(promptDraft.restoreFailedDraft);
        showMutationErrorToast({
          error: nextError,
          fallbackMessage: isQueuingMessage
            ? "Failed to queue message"
            : "Failed to send message",
          lifecycleOperation: isQueuingMessage
            ? "queue_message"
            : "send_message",
        });
      }
    },
    [
      projectId,
      captureBottomUploads,
      queryClient,
      compactFirst,
      createHandoffThread,
      createQueuedMessage,
      followUpExecutionSelection,
      isHandoffSelection,
      promptDraft,
      sendMessage,
      setBottomAttachmentError,
      thread.id,
      runtimeDisplayStatus,
    ],
  );

  const submitDraftProgrammatically = useCallback(
    async (
      submittedDraft: PromptDraftState,
      submitOptions: ExperimentalComposerSubmitOptions,
      pluginSubmission: SendMessageRequest["pluginSubmission"],
      sendReservation?: ComposerSendSlot,
      capturedUploads: CapturedAttachmentUploads | null = null,
      clearCurrentDraft = false,
      pendingTranscript?: () => Promise<string>,
    ) => {
      let heldWait: ExpectedPluginWait | undefined;

      try {
        heldWait = expectedPluginWait(submitOptions, pluginSubmission);
      } catch (hintError) {
        sendReservation?.cancel();
        capturedUploads?.restore();

        if (!clearCurrentDraft) restoreFailedDraft(submittedDraft);
        throw hintError;
      }

      if (shouldHideComposer) {
        sendReservation?.cancel();
        capturedUploads?.restore();

        if (!clearCurrentDraft) restoreFailedDraft(submittedDraft);
        throw new Error("This thread is read-only.");
      }

      if (isHandoffSelection) {
        sendReservation?.cancel();

        if (effectiveSelectedModel.length === 0) {
          if (!clearCurrentDraft) restoreFailedDraft(submittedDraft);
          capturedUploads?.restore();
          throw new Error("The selected model is still loading.");
        }

        let created = false;

        try {
          created = await createHandoffThread(
            submittedDraft,
            submitOptions.sendAt,
            pluginSubmission,
            capturedUploads,
            heldWait,
          );
        } catch (submitError) {
          throw new Error(
            getMutationErrorMessage({
              error: submitError,
              fallbackMessage: "Failed to create thread",
              lifecycleOperation: "create_thread",
            }),
          );
        }

        if (!created) {
          throw new Error("Type a message before submitting it.");
        }

        return;
      }

      const submission = prepareComposerAttachmentSubmission({
        scope: { kind: "thread", projectId, threadId: thread.id },
        draft: submittedDraft,
        uploads: capturedUploads,
        pendingTranscript,
      });

      const request = buildAutoFollowUpRequest({
        compactFirst: compactFirst && submitOptions.sendAt === undefined,
        threadId: thread.id,
        input: submission.input,
        execution: followUpExecutionSelection,
      });

      if (request === null) {
        sendReservation?.cancel();
        capturedUploads?.restore();
        submission.complete();
        throw new Error("Type a message before submitting it.");
      }

      if (clearCurrentDraft) clearSubmittedDraft(submittedDraft);

      setBottomAttachmentError(null);

      try {
        await sendMessageAsync({
          ...request,
          prepareInput: submission.prepareInput,
          ...(sendReservation === undefined ? {} : { sendReservation }),
          ...(submitOptions.sendAt === undefined
            ? {}
            : { sendAt: submitOptions.sendAt }),
          ...(pluginSubmission === undefined ? {} : { pluginSubmission }),
          ...(heldWait === undefined ? {} : { expectedPluginWait: heldWait }),
        });
        submission.complete();
        setFullHistoryThreadId(null);
      } catch (scheduleError) {
        sendReservation?.cancel();
        submission.restoreFailed(restoreFailedDraft);

        throw new Error(
          getMutationErrorMessage({
            error: scheduleError,
            fallbackMessage: "Failed to submit message",
            lifecycleOperation: "send_message",
          }),
        );
      }
    },
    [
      compactFirst,
      createHandoffThread,
      shouldHideComposer,
      effectiveSelectedModel,
      followUpExecutionSelection,
      isHandoffSelection,
      clearSubmittedDraft,
      restoreFailedDraft,
      projectId,
      sendMessageAsync,
      setBottomAttachmentError,
      thread.id,
    ],
  );

  const submitProgrammatically = useCallback(
    (
      submitOptions: ExperimentalComposerSubmitOptions,
      pluginSubmission: SendMessageRequest["pluginSubmission"],
    ) => {
      const draft = promptDraft.getCurrent();

      return submitDraftProgrammatically(
        draft,
        submitOptions,
        pluginSubmission,
        undefined,
        captureBottomUploads(),
        true,
      );
    },
    [captureBottomUploads, promptDraft, submitDraftProgrammatically],
  );

  useEffect(() => {
    submitProgrammaticallyRef.current = submitProgrammatically;
  }, [submitProgrammatically]);

  const normalPluginComposerHost = useMemo<PluginComposerHost>(
    () => ({
      scope: { kind: "thread", threadId: thread.id },
      draftScope: { kind: "thread", projectId, threadId: thread.id },
      textEffectKey: promptDraft.storageKey,
      getCurrent: promptDraft.getCurrent,
      subscribeDraft: promptDraft.subscribe,
      getSelection,
      subscribeSelection,
      setDraft: promptDraft.setDraft,
      focus: focusBottomPluginComposer,
      submit: submitProgrammaticallyThroughRef,
      submitDraft: submitDraftProgrammatically,
      ...(isHandoffSelection
        ? {}
        : {
            submitVoiceDraft: (
              draft,
              transcript,
              sendReservation,
              capturedUploads,
            ) =>
              submitDraftProgrammatically(
                draft,
                { experimental_data: null },
                undefined,
                sendReservation,
                capturedUploads ?? null,
                false,
                transcript,
              ),
          }),
      captureAttachments: captureBottomUploads,
      reserveSubmission: isHandoffSelection
        ? undefined
        : () => reserveMessageSend(thread.id),
      setSelection,
    }),
    [
      focusBottomPluginComposer,
      captureBottomUploads,
      getSelection,
      isHandoffSelection,
      reserveMessageSend,
      projectId,
      promptDraft.getCurrent,
      promptDraft.setDraft,
      promptDraft.storageKey,
      promptDraft.subscribe,
      setSelection,
      subscribeSelection,
      submitProgrammaticallyThroughRef,
      submitDraftProgrammatically,
      thread.id,
    ],
  );

  const restoreHistoryDraft = useCallback(
    (draft: PromptDraftState) =>
      createCoreComposerActions(normalPluginComposerHost).restoreDraft(draft),
    [normalPluginComposerHost],
  );

  const handleModifierSubmit = useCallback(
    async (options?: { sendNow?: true }) => {
      if (!canSubmitModifierShortcut) {
        return;
      }

      const submittedDraft = promptDraft.getCurrent();
      const capturedUploads = captureBottomUploads();

      const submission = prepareComposerAttachmentSubmission({
        scope: { kind: "thread", projectId, threadId: thread.id },
        draft: submittedDraft,
        uploads: capturedUploads,
      });

      const shortcutRequest = buildFollowUpShortcutRequest({
        execution: followUpExecutionSelection,
        input: submission.input,
        queuedMessages: queuedMessagesRef.current,
        threadId: thread.id,
      });

      if (!shortcutRequest) {
        capturedUploads?.restore();
        submission.complete();

        return;
      }

      if (shortcutRequest.kind === "draft") {
        if (!promptDraft.clearIfCurrentMatches(submittedDraft)) {
          capturedUploads?.restore();
          submission.complete();

          return;
        }

        setBottomAttachmentError(null);

        try {
          await sendMessage.mutateAsync({
            ...shortcutRequest.request,
            ...options,
            prepareInput: submission.prepareInput,
          });
          submission.complete();
        } catch (nextError) {
          submission.restoreFailed(promptDraft.restoreFailedDraft);
          showMutationErrorToast({
            error: nextError,
            fallbackMessage: "Failed to send message",
            lifecycleOperation: "send_message",
          });
        }

        return;
      }

      submission.complete();
      const queuedMessageId = shortcutRequest.request.queuedMessageId;

      if (queuedMessagesRef.current[0]?.id !== queuedMessageId) {
        return;
      }

      await runWhileFollowUpShortcutSending(
        setIsFollowUpShortcutSending,
        async () => {
          await sendQueuedMessageById({
            guard: "current-head",
            messageId: queuedMessageId,
            mode: shortcutRequest.request.mode,
          });
        },
      );
    },
    [
      projectId,
      captureBottomUploads,
      canSubmitModifierShortcut,
      followUpExecutionSelection,
      promptDraft,
      queuedMessagesRef,
      sendMessage,
      sendQueuedMessageById,
      setBottomAttachmentError,
      thread.id,
    ],
  );

  const handleSendQueuedMessage = useCallback(
    (messageId: string) => {
      void sendQueuedMessageById({
        guard: "exists",
        messageId,
        mode: shouldSteerWhenReady ? "steer" : "auto",
      });
    },
    [sendQueuedMessageById, shouldSteerWhenReady],
  );

  const bottomFocusEndKey = `${composerFocusRequestNonce}:${bottomPluginFocusNonce}`;

  const bottomYieldsExistingFocus = useCallback(
    () => takePendingChatHandoff(thread.id),
    [thread.id],
  );

  const [pendingChatArrival] = useState(() =>
    isRecentPendingChatHandoff(thread.id)
      ? {
          threadId: thread.id,
          composerHeight: pendingChatHandoffComposerHeight(thread.id),
        }
      : null,
  );

  const arrivesFromPendingChat = pendingChatArrival?.threadId === thread.id;

  const handleToggleBannerSection = useCallback(
    (section: ThreadPromptContextBannerExpandedSection | null) => {
      setExpandedBannerSection((previous) =>
        previous === section ? null : section,
      );
    },
    [],
  );

  const isUnarchiveCurrentThreadPending =
    unarchiveThread.isPending && unarchiveThread.variables?.id === thread.id;

  const handleUnarchiveCurrentThread = useCallback(() => {
    unarchiveThread.mutate({ id: thread.id });
  }, [thread.id, unarchiveThread]);

  const isRestoreCurrentEnvironmentPending =
    restoreThreadEnvironment.isPending &&
    restoreThreadEnvironment.variables?.id === thread.id;

  const handleRestoreCurrentEnvironment = useCallback(() => {
    restoreThreadEnvironment.mutate({ id: thread.id });
  }, [restoreThreadEnvironment, thread.id]);

  const bottomAttachmentsConfig = useMemo(
    () => ({
      acceptWhileUploading: true,
      items: currentPromptDraft.attachments,
      targetHostId: environmentHostId,
      projectId,
      isAttaching: isAttachingBottomFiles,
      pendingUploads: bottomPendingUploads,
      error: bottomAttachmentError,
      onAttachFiles: handleAttachBottomFiles,
      onUpdate: promptDraft.updateAttachments,
    }),
    [
      bottomAttachmentError,
      environmentHostId,
      currentPromptDraft.attachments,
      handleAttachBottomFiles,
      isAttachingBottomFiles,
      bottomPendingUploads,
      projectId,
      promptDraft.updateAttachments,
    ],
  );

  const handleBottomComposerSubmit = useCallback(
    (options?: { sendNow?: true }) => {
      void handleSend(options);
    },
    [handleSend],
  );

  const handleBottomComposerModifierSubmit = useCallback(
    (options?: { sendNow?: true }) => {
      void handleModifierSubmit(options);
    },
    [handleModifierSubmit],
  );

  const handleInlineComposerSubmit = useCallback(() => {
    void handleSaveInlineQueuedMessage();
  }, [handleSaveInlineQueuedMessage]);

  const bottomComposerConfig = useMemo<FollowUpComposerProps>(
    () => ({
      history: {
        currentDraft: currentPromptDraft,
        entries: promptHistoryDrafts,
        onSelectEntry: restoreHistoryDraft,
        resetKey: thread.id,
      },
      isFollowUpSubmitting: false,
      message: currentPromptDraft.text,
      mentionRanges: currentPromptDraft.mentions,
      onChangeMessage: promptDraft.setTextAndMentions,
      onModifierSubmit: handleBottomComposerModifierSubmit,
      onSubmit: handleBottomComposerSubmit,
      ...(isHandoffSelection
        ? {
            submitLabel: "New thread",
            submitIcon: "MessageSquarePlus",
            submitTitle: "Create new thread (Enter)",
          }
        : {}),
      compactPromptPlaceholder,
      promptPlaceholder,
      canModifierSubmit: canSubmitModifierShortcut,
      steerActiveThreadOnEnter,
      submitMode,
      queuedSendForecast,
      threadRuntimeDisplayStatus: runtimeDisplayStatus,
    }),
    [
      queuedSendForecast,
      canSubmitModifierShortcut,
      compactPromptPlaceholder,
      currentPromptDraft,
      handleBottomComposerModifierSubmit,
      handleBottomComposerSubmit,
      isHandoffSelection,
      promptHistoryDrafts,
      promptPlaceholder,
      restoreHistoryDraft,
      promptDraft.setTextAndMentions,
      runtimeDisplayStatus,
      steerActiveThreadOnEnter,
      submitMode,
      thread.id,
    ],
  );

  const sentMessageEditInput = useMemo(
    () => (sentMessageEdit ? promptDraftToInput(sentMessageEdit.draft) : []),
    [sentMessageEdit],
  );

  const canSubmitSentMessageEdit =
    sentMessageEdit !== undefined &&
    sentMessageEditInput.length > 0 &&
    submitMode.kind === "ready" &&
    !shouldHideComposer &&
    !isDefaultExecutionOptionsLoading &&
    !isAttachingSentMessageFiles &&
    !isFollowUpSubmitting &&
    !isQueueMutationPending &&
    !sentMessageEdit.isSubmitting &&
    activeBackgroundAgentCount === 0 &&
    activeWorkflows.length === 0 &&
    activeBackgroundCommands.length === 0;

  const sentMessageEditSubmitMode = useMemo<FollowUpSubmitMode>(
    () =>
      canSubmitSentMessageEdit || sentMessageEditInput.length === 0
        ? { kind: "ready" }
        : submitMode.kind === "blocked"
          ? submitMode
          : { kind: "blocked", reason: "unavailable" },
    [canSubmitSentMessageEdit, sentMessageEditInput.length, submitMode],
  );

  const handleSentMessageEditSubmit = useCallback(() => {
    if (!sentMessageEdit || !canSubmitSentMessageEdit) {
      return;
    }

    sentMessageEdit.onSubmit({
      execution: followUpExecutionSelection,
      input: sentMessageEditInput,
    });
  }, [
    canSubmitSentMessageEdit,
    followUpExecutionSelection,
    sentMessageEdit,
    sentMessageEditInput,
  ]);

  const bottomExecutionConfig = useMemo(
    () => ({
      providerRouting:
        thread.environmentId === null
          ? executionOptionsRouting
          : { environmentId: thread.environmentId },
      catalog: {
        providers,
        verified: modelCatalogIsVerified,
        modelOptions: catalogModelOptions,
      },
      selection: { onChange: applyExecutionTuple },
      favoriteChips: true,
      provider: {
        options: providerOptions,
        selectedId: selectedProviderId,
        onChange: handleProviderChange,
        hasMultiple: hasMultipleProviders,
      },
      model: {
        active: effectiveSelectedModel
          ? { model: effectiveSelectedModel }
          : null,
        selected: selectedModel,
        options: modelOptions,
        moreOptions: moreModelOptions,
        isLoading: isLoadingModels,
        loadFailed: modelLoadFailed,
        loadError: modelLoadError,
        notice: modelNotice,
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
      handoff: {
        sourceProviderId: thread.providerId,
        active: isHandoffSelection,
        onStart: beginHandoff,
        onExit: exitHandoff,
      },
      ...(isHandoffSelection || pickerSessionOptionSections.length === 0
        ? {}
        : {
            agentOptions: {
              sections: pickerSessionOptionSections,
              onChange: sessionOptionChoices.choose,
            },
          }),
    }),
    [
      applyExecutionTuple,
      catalogModelOptions,
      pickerSessionOptionSections,
      sessionOptionChoices.choose,
      effectiveSelectedModel,
      executionOptionsRouting,
      hasMultipleProviders,
      beginHandoff,
      isHandoffSelection,
      exitHandoff,
      setSelectedModel,
      handleProviderChange,
      isLoadingModels,
      modelCatalogIsVerified,
      modelLoadFailed,
      modelLoadError,
      modelNotice,
      modelOptions,
      moreModelOptions,
      providerOptions,
      providers,
      reasoningLevel,
      reasoningOptions,
      isLoadingReasoning,
      selectedModel,
      selectedProviderId,
      serviceTier,
      setReasoningLevel,
      changeSessionSpeed,
      supportsServiceTier,
      serviceTierOptions,
      thread.environmentId,
      thread.providerId,
    ],
  );

  const compactExecutionConfig = useMemo(() => {
    const {
      handoff: _handoff,
      favoriteChips: _favoriteChips,
      provider: { onChange: _onProviderChange, ...lockedProvider },
      ...lockedExecution
    } = bottomExecutionConfig;

    return {
      ...lockedExecution,
      selection: { onChange: applySourceProviderTuple },
      provider: { ...lockedProvider, selectedId: thread.providerId },
    };
  }, [applySourceProviderTuple, bottomExecutionConfig, thread.providerId]);

  const bottomPermissionConfig = useMemo(
    () => ({
      value: hasConcreteDefaultExecutionOptions ? permissionMode : undefined,
      options: hasConcreteDefaultExecutionOptions ? permissionModeOptions : [],
      onChange: setPermissionMode,
      supported:
        hasConcreteDefaultExecutionOptions && supportsPermissionModeSelection,
    }),
    [
      hasConcreteDefaultExecutionOptions,
      permissionMode,
      permissionModeOptions,
      setPermissionMode,
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
            permissionLocked: false,
            providerId: thread.providerId,
            update: updateInlineQueuedMessage,
          })
        : null,
    [
      bottomExecutionConfig,
      bottomPermissionConfig,
      inlineEditingQueuedMessage,
      thread.providerId,
      updateInlineQueuedMessage,
    ],
  );

  const inlineExecutionConfig = inlineQueuedControls?.execution ?? null;
  const inlinePermissionConfig = inlineQueuedControls?.permission ?? null;

  const activePromptModeCard = useMemo(
    () => (
      <ThreadPromptModeCard
        activePromptMode={activePromptMode}
        isExitPending={cancelThreadPlan.isPending}
        isExpanded={isPromptModeExpanded}
        onExitPlanMode={handleCancelPlan}
        onToggle={() => setIsPromptModeExpanded((value) => !value)}
      />
    ),
    [
      activePromptMode,
      cancelThreadPlan.isPending,
      handleCancelPlan,
      isPromptModeExpanded,
    ],
  );

  const inlineEditSessionId = inlineEditingQueuedMessage?.editSessionId ?? null;

  const inlineEditQueuedMessageId =
    inlineEditingQueuedMessage?.queuedMessageId ?? null;

  const queuedMessageSelection = useMemo(
    () =>
      inlineEditingQueuedMessage
        ? readExecutionSelection({
            selectedProviderId: thread.providerId,
            selectedThreadModel: inlineEditingQueuedMessage.model,
            reasoningLevel: inlineEditingQueuedMessage.reasoningLevel,
            serviceTier: inlineEditingQueuedMessage.serviceTier,
            supportsServiceTier,
            permissionMode: inlineEditingQueuedMessage.permissionMode,
          })
        : NO_INLINE_EDITOR_SELECTION,
    [inlineEditingQueuedMessage, supportsServiceTier, thread.providerId],
  );

  const queuedMessageComposerSelection = useComposerHostSelection(
    `queued-message:${thread.id}:${inlineEditQueuedMessageId}:${inlineEditSessionId}`,
    queuedMessageSelection,
  );

  const queuedMessagePluginComposerHost =
    useMemo<PluginComposerHost | null>(() => {
      if (inlineEditSessionId === null || inlineEditQueuedMessageId === null) {
        return null;
      }

      const session = {
        editSessionId: inlineEditSessionId,
        queuedMessageId: inlineEditQueuedMessageId,
      };

      return {
        scope: {
          kind: "queued-message",
          threadId: thread.id,
          queuedMessageId: inlineEditQueuedMessageId,
        },
        textEffectKey: `queued-message:${thread.id}:${inlineEditQueuedMessageId}:${inlineEditSessionId}`,
        getCurrent: () =>
          readInlineQueuedMessageDraft(
            inlineEditingQueuedMessageRef,
            session,
            ENDED_EDIT_SESSION_DRAFT,
          ),
        subscribeDraft: subscribeInlineQueuedDraft,
        getSelection: queuedMessageComposerSelection.getSelection,
        subscribeSelection: queuedMessageComposerSelection.subscribeSelection,
        setDraft: (draft) =>
          writeInlineQueuedMessageDraft(
            inlineEditingQueuedMessageRef,
            session,
            draft,
            commitInlineQueuedMessage,
          ),
        isAvailable: () =>
          isInlineQueuedMessageEditSession(
            inlineEditingQueuedMessageRef.current,
            session,
          ),
        focus: focusInlinePluginComposer,
      };
    }, [
      commitInlineQueuedMessage,
      focusInlinePluginComposer,
      inlineEditQueuedMessageId,
      inlineEditSessionId,
      inlineEditingQueuedMessageRef,
      queuedMessageComposerSelection,
      subscribeInlineQueuedDraft,
      thread.id,
    ]);

  const queuedMessageEditor = useMemo(() => {
    if (
      !inlineEditingQueuedMessage ||
      !inlineExecutionConfig ||
      !inlinePermissionConfig ||
      !queuedMessagePluginComposerHost
    ) {
      return null;
    }

    const { editSessionId, queuedMessageId } = inlineEditingQueuedMessage;

    const inlineEditor: QueuedMessageInlineEditor = {
      queuedMessageId,
      queuedMessageIndex: inlineEditingQueuedMessage.queuedMessageIndex,
      onDismiss: dismissInlineQueuedMessageEditor,
      content: buildInlineDraftComposer({
        attachments: {
          items: activeComposerDraft.attachments,
          projectId,
          isAttaching: isAttachingInlineFiles,
          pendingUploads: inlinePendingUploads,
          error: inlineAttachmentError,
          targetHostId: environmentHostId,
          onAttachFiles: handleAttachInlineFiles,
          onUpdate: updateActiveComposerAttachments,
        },
        canModifierSubmit:
          activeComposerDraftInput.length > 0 && !isUpdateQueuedMessagePending,
        compactPromptPlaceholder,
        composerId: `${THREAD_DETAIL_COMPOSER_TEXTAREA_ID}-queued-${queuedMessageId}`,
        draft: activeComposerDraft,
        editFocusNonce,
        execution: inlineExecutionConfig,
        focusSessionKey: editSessionId,
        historyResetKey: `${thread.id}:${editSessionId}`,
        isSubmitting: isUpdateQueuedMessagePending,
        onChangeMessage: handleComposerMessageChange,
        onSelectHistoryEntry: (draft) =>
          createCoreComposerActions(
            queuedMessagePluginComposerHost,
          ).restoreDraft(draft),
        permission: inlinePermissionConfig,
        pluginComposerHost: queuedMessagePluginComposerHost,
        promptActions: inlinePromptActions,
        promptPlaceholder,
        submit: handleInlineComposerSubmit,
        submitMode: { kind: "ready" },
        textEffects: queuedComposerTextEffects,
        threadRuntimeDisplayStatus: runtimeDisplayStatus,
        typeahead: inlineTypeaheadConfig,
        collapseResetKey: `queued-message:${queuedMessageId}`,
      }),
    };

    return inlineEditor;
  }, [
    activeComposerDraft,
    activeComposerDraftInput.length,
    compactPromptPlaceholder,
    dismissInlineQueuedMessageEditor,
    environmentHostId,
    editFocusNonce,
    handleAttachInlineFiles,
    handleComposerMessageChange,
    handleInlineComposerSubmit,
    inlineAttachmentError,
    inlineEditingQueuedMessage,
    inlineExecutionConfig,
    inlinePermissionConfig,
    isAttachingInlineFiles,
    inlinePendingUploads,
    isUpdateQueuedMessagePending,
    projectId,
    inlinePromptActions,
    promptPlaceholder,
    queuedComposerTextEffects,
    queuedMessagePluginComposerHost,
    updateActiveComposerAttachments,
    runtimeDisplayStatus,
    thread.id,
    inlineTypeaheadConfig,
  ]);

  usePublishPluginComposerHost(
    queuedMessageEditor
      ? queuedMessagePluginComposerHost
      : normalPluginComposerHost,
  );
  const sentMessageEditOperationId = sentMessageEdit?.operationId ?? null;

  const sentMessageSelection = useMemo(
    () =>
      readExecutionSelection({
        selectedProviderId: thread.providerId,
        selectedThreadModel: effectiveSelectedModel,
        reasoningLevel,
        serviceTier,
        supportsServiceTier,
        permissionMode,
      }),
    [
      effectiveSelectedModel,
      permissionMode,
      reasoningLevel,
      serviceTier,
      supportsServiceTier,
      thread.providerId,
    ],
  );

  const sentMessageComposerSelection = useComposerHostSelection(
    `sent-message:${thread.id}:${sentMessageEditOperationId}`,
    sentMessageSelection,
  );

  const sentMessagePluginComposerHost =
    useMemo<PluginComposerHost | null>(() => {
      if (sentMessageEditOperationId === null) {
        return null;
      }

      const operationId = sentMessageEditOperationId;

      return {
        scope: { kind: "thread", threadId: thread.id },
        textEffectKey: `sent-message:${thread.id}:${operationId}`,
        getCurrent: () =>
          readSentMessageEditDraft(
            sentMessageEditRef,
            operationId,
            ENDED_EDIT_SESSION_DRAFT,
          ),
        subscribeDraft: subscribeSentMessageEditDraft,
        getSelection: sentMessageComposerSelection.getSelection,
        subscribeSelection: sentMessageComposerSelection.subscribeSelection,
        setDraft: (nextDraft) =>
          writeSentMessageEditDraft(sentMessageEditRef, operationId, nextDraft),
        isAvailable: () =>
          sentMessageEditRef.current?.operationId === operationId,
        focus: focusInlinePluginComposer,
      };
    }, [
      focusInlinePluginComposer,
      sentMessageComposerSelection,
      sentMessageEditOperationId,
      sentMessageEditRef,
      subscribeSentMessageEditDraft,
      thread.id,
    ]);

  const sentMessageEditorPortal = useMemo(() => {
    if (!sentMessageEdit?.hostElement || !sentMessagePluginComposerHost) {
      return null;
    }

    const { draft, hostElement, operationId } = sentMessageEdit;

    return createPortal(
      <InlineMessageEditorFrame
        cancelLabel="Stop editing sent message"
        label="Editing message"
        onCancel={sentMessageEdit.onCancel}
        variant="cap"
      >
        {buildInlineDraftComposer({
          attachments: {
            items: draft.attachments,
            projectId,
            isAttaching: isAttachingSentMessageFiles,
            pendingUploads: sentMessagePendingUploads,
            error: sentMessageAttachmentError,
            targetHostId: environmentHostId,
            onAttachFiles: handleAttachSentMessageFiles,
            onUpdate: (update) => {
              sentMessageEdit.updateDraft((current) => ({
                ...current,
                attachments: update(current.attachments),
              }));
            },
          },
          canModifierSubmit: canSubmitSentMessageEdit,
          compactPromptPlaceholder: "Edit message",
          composerId: `${THREAD_DETAIL_COMPOSER_TEXTAREA_ID}-sent-${operationId}`,
          draft,
          editFocusNonce,
          execution: compactExecutionConfig,
          focusSessionKey: operationId,
          historyResetKey: `${thread.id}:${operationId}`,
          isSubmitting: sentMessageEdit.isSubmitting,
          onChangeMessage: (text, mentions) =>
            sentMessageEdit.updateDraft((current) => ({
              ...current,
              text,
              mentions,
            })),
          onEscape: sentMessageEdit.onCancel,
          onSelectHistoryEntry: (nextDraft) =>
            createCoreComposerActions(
              sentMessagePluginComposerHost,
            ).restoreDraft(nextDraft),
          permission: bottomPermissionConfig,
          pluginComposerHost: sentMessagePluginComposerHost,
          promptActions: inlinePromptActions,
          promptPlaceholder: "Edit message",
          submit: handleSentMessageEditSubmit,
          submitMode: sentMessageEditSubmitMode,
          submitTitle: "Submit edit (Enter)",
          suppressPluginComposerCustomizations: true,
          textEffects: sentMessageComposerTextEffects,
          threadRuntimeDisplayStatus: runtimeDisplayStatus,
          typeahead: inlineTypeaheadConfig,
          collapseResetKey: `sent-message:${operationId}`,
        })}
      </InlineMessageEditorFrame>,
      hostElement,
    );
  }, [
    bottomPermissionConfig,
    canSubmitSentMessageEdit,
    environmentHostId,
    compactExecutionConfig,
    editFocusNonce,
    handleAttachSentMessageFiles,
    handleSentMessageEditSubmit,
    isAttachingSentMessageFiles,
    sentMessagePendingUploads,
    projectId,
    inlinePromptActions,
    runtimeDisplayStatus,
    sentMessageAttachmentError,
    sentMessageComposerTextEffects,
    sentMessageEdit,
    sentMessageEditSubmitMode,
    sentMessagePluginComposerHost,
    thread.id,
    inlineTypeaheadConfig,
  ]);

  const childPendingInteractionBanners = useMemo(
    () =>
      childPendingInteractions.map((item) => (
        <ThreadPendingInteractionBanners
          key={item.childThreadId}
          interactions={item.interactions}
          sourceThread={{ href: item.href, title: item.childTitle }}
          threadId={item.childThreadId}
        />
      )),
    [childPendingInteractions],
  );

  const promptStack = useMemo(
    () => (
      <>
        <ThreadWorkflowStack
          workflows={activeWorkflows}
          isStackExpanded={isWorkflowStackExpanded}
          onToggleStack={() =>
            setWorkflowStackExpandedThreadId((current) =>
              current === thread.id ? null : thread.id,
            )
          }
          expandedWorkflowIds={expandedWorkflowIds}
          onToggleWorkflow={toggleWorkflowExpanded}
        />
        <ThreadBackgroundCommandsCard
          commands={activeBackgroundCommands}
          isExpanded={isBackgroundCommandsExpanded}
          onToggle={() => setIsBackgroundCommandsExpanded((value) => !value)}
        />
        {shouldHideComposer ? null : activePromptModeCard}
        <ThreadTodoCard
          pendingTodos={
            thread.archivedAt === null && environmentGoneStatus === null
              ? pendingTodos
              : null
          }
          isExpanded={isTodoExpanded}
          onToggle={() => setIsTodoExpanded((value) => !value)}
        />
        {environmentHostId &&
        thread.archivedAt === null &&
        environmentGoneStatus === null ? (
          <ThreadMachineStatus hostId={environmentHostId} />
        ) : null}
        <ThreadPromptContextBanner
          archivedSection={
            thread.archivedAt !== null
              ? {
                  archivedAt: thread.archivedAt,
                  onUnarchive: handleUnarchiveCurrentThread,
                  unarchivePending: isUnarchiveCurrentThreadPending,
                }
              : null
          }
          environmentGoneSection={
            environmentGoneStatus === null
              ? null
              : {
                  status: environmentGoneStatus,
                  ...(canRestoreEnvironment
                    ? {
                        onRestore: handleRestoreCurrentEnvironment,
                        restorePending: isRestoreCurrentEnvironmentPending,
                      }
                    : {}),
                }
          }
          parentThreadSection={
            parentThreadSection?.relationship === "handoff"
              ? null
              : parentThreadSection
          }
          continuedInSection={null}
          childThreadsSection={childThreadsSection}
          expandedSection={expandedBannerSection}
          onToggleSection={handleToggleBannerSection}
        />
        {modelFallback ? (
          <ThreadModelFallbackCard
            key={`${thread.id}:${modelFallback.sourceSeq}`}
            fallback={modelFallback}
            threadId={thread.id}
          />
        ) : null}
      </>
    ),
    [
      environmentHostId,
      expandedBannerSection,
      handleToggleBannerSection,
      handleUnarchiveCurrentThread,
      handleRestoreCurrentEnvironment,
      canRestoreEnvironment,
      environmentGoneStatus,
      isRestoreCurrentEnvironmentPending,
      isUnarchiveCurrentThreadPending,
      activePromptModeCard,
      isTodoExpanded,
      activeWorkflows,
      isWorkflowStackExpanded,
      expandedWorkflowIds,
      toggleWorkflowExpanded,
      activeBackgroundCommands,
      isBackgroundCommandsExpanded,
      modelFallback,
      parentThreadSection,
      childThreadsSection,
      pendingTodos,
      shouldHideComposer,
      thread.archivedAt,
      thread.id,
    ],
  );

  const queuedMessagesAwaitingCompaction =
    useQueuedMessagesAwaitingCompaction();

  const composerWorking =
    queuedMessagesAwaitingCompaction.length === 0 ? working : null;

  const actionableQueuedMessages = useMemo(
    () =>
      queuedMessages.filter(
        (message) => !queuedMessageShowsInChat(message, runtimeDisplayStatus),
      ),
    [queuedMessages, runtimeDisplayStatus],
  );

  const pendingQueueFollowUps = usePendingQueueFollowUps(
    thread.id,
    runtimeDisplayStatus,
    queuedMessages,
  );

  const listedQueuedMessages = useMemo(
    () => [
      ...withoutQueuedMessages(
        actionableQueuedMessages,
        queuedMessagesAwaitingCompaction.filter(
          (message) =>
            message.id !== inlineEditingQueuedMessage?.queuedMessageId,
        ),
      ),
      ...pendingQueueFollowUps,
    ],
    [
      inlineEditingQueuedMessage?.queuedMessageId,
      actionableQueuedMessages,
      pendingQueueFollowUps,
      queuedMessagesAwaitingCompaction,
    ],
  );

  const waitingToSendEntries = useWaitingToSendEntries(thread.id);

  const promptQueue = useMemo(
    () => (
      <ComposerWorkingQueueHost
        active={
          !shouldHideComposer &&
          (queuedMessagesPending || listedQueuedMessages.length > 0)
        }
      >
        {(attachedToComposer) =>
          shouldHideComposer ? null : queuedMessagesPending ? (
            <QueuedMessagesPendingCard
              attachedToComposer={attachedToComposer}
              expanded={queueExpanded}
              queuedMessageCount={queuedMessageCount}
            />
          ) : (
            <LazyQueuedMessagesList
              key={thread.id}
              attachedToComposer={attachedToComposer}
              queuedMessages={listedQueuedMessages}
              resolveMentionLink={resolveMentionLink}
              inlineEditor={queuedMessageEditor ?? undefined}
              sendAction={
                shouldSteerWhenReady ? "steer-when-ready" : "send-now"
              }
              sendDisabled={
                submitMode.kind === "blocked" ||
                runtimeDisplayStatus === "waiting-for-host" ||
                isFollowUpSubmitting ||
                isQueueMutationPending
              }
              actionDisabled={isQueueMutationPending}
              processingMessageId={displayedProcessingQueuedMessage?.id ?? null}
              processingAction={
                displayedProcessingQueuedMessage?.action ?? null
              }
              onSend={handleSendQueuedMessage}
              onReorder={handleReorderQueuedMessage}
              onSetGroupBoundary={handleSetQueuedMessageGroupBoundary}
              onEdit={beginEditQueuedMessage}
              onDelete={handleDeleteQueuedMessage}
              expanded={queueExpanded}
              onExpandedChange={setQueueExpanded}
              waitingStartThreadId={
                thread.status === "pending" ? thread.id : undefined
              }
            />
          )
        }
      </ComposerWorkingQueueHost>
    ),
    [
      queueExpanded,
      setQueueExpanded,
      handleDeleteQueuedMessage,
      beginEditQueuedMessage,
      handleReorderQueuedMessage,
      handleSendQueuedMessage,
      handleSetQueuedMessageGroupBoundary,
      isFollowUpSubmitting,
      isQueueMutationPending,
      queuedMessageEditor,
      displayedProcessingQueuedMessage,
      queuedMessageCount,
      listedQueuedMessages,
      queuedMessagesPending,
      resolveMentionLink,
      runtimeDisplayStatus,
      shouldSteerWhenReady,
      shouldHideComposer,
      submitMode.kind,
      thread.id,
      thread.status,
    ],
  );

  const showsPendingInteraction =
    (hasPendingInteraction || hasRequiredNativeQuestion) && !shouldHideComposer;

  const pendingInteractionNode = useMemo(() => {
    if (!showsPendingInteraction) return null;

    return (
      <>
        <ThreadPendingInteractionBanners
          interactions={blockingPendingInteractions}
          threadId={thread.id}
        />
        {hasRequiredNativeQuestion ? (
          <NativeThreadAttention threadId={thread.id} />
        ) : null}
      </>
    );
  }, [
    hasRequiredNativeQuestion,
    blockingPendingInteractions,
    showsPendingInteraction,
    thread.id,
  ]);

  const pinnedPendingInteractionNode =
    pinnedPendingInteractions.length > 0 && !shouldHideComposer ? (
      <ThreadPendingInteractionBanners
        interactions={pinnedPendingInteractions}
        threadId={thread.id}
      />
    ) : null;

  const pendingInteractionStack = activePromptMode
    ? activePromptModeCard
    : null;

  const sessionOptionsControl =
    isHandoffSelection || placedSessionOptions.footer.length === 0 ? null : (
      <SessionOptionsMenu
        options={placedSessionOptions.footer}
        choices={sessionOptionChoices.choices}
        onChange={sessionOptionChoices.choose}
      />
    );

  const bottomContent = (
    <FollowUpPromptBox
      id={THREAD_DETAIL_COMPOSER_TEXTAREA_ID}
      machineId={environmentHostId}
      attachments={bottomAttachmentsConfig}
      attention={
        <>
          <ThreadContinueControl
            key={thread.id}
            threadId={thread.id}
            model={effectiveSelectedModel}
            modelControl={
              <ExecutionControls {...compactExecutionConfig} selects="model" />
            }
            errored={
              thread.status === "error" &&
              thread.archivedAt === null &&
              thread.deletedAt === null
            }
          />
          {hasNativeAttention &&
          !hasRequiredNativeQuestion &&
          !shouldHideComposer ? (
            <NativeThreadAttention threadId={thread.id} />
          ) : null}
          {ownerRecovery}
          <ThreadInboxReason
            threadId={thread.id}
            parentThreadId={
              thread.parentThreadId ?? thread.lifecycleOwnerThreadId
            }
          />
          {childPendingInteractionBanners}
          {pinnedPendingInteractionNode}
        </>
      }
      stack={
        <>
          {pendingInteractionNode ? pendingInteractionStack : promptStack}
          <ThreadCompanionInlineSlot />
        </>
      }
      queue={
        pendingInteractionNode ? null : (
          <>
            <WaitingToSendCard
              entries={waitingToSendEntries.filter(
                (entry) =>
                  outboxEntryPlacement(
                    entry,
                    thread.id,
                    runtimeDisplayStatus,
                  ) === "card",
              )}
            />
            {promptQueue}
          </>
        )
      }
      queuedMessageCount={
        pendingInteractionNode !== null || shouldHideComposer
          ? 0
          : queuedMessagesPending
            ? queuedMessageCount
            : actionableQueuedMessages.length
      }
      pendingInteraction={pendingInteractionNode}
      working={composerWorking}
      activePromptMode={isHandoffSelection ? null : activePromptMode}
      composer={shouldHideComposer ? null : bottomComposerConfig}
      pluginComposerHost={normalPluginComposerHost}
      voiceDraft={promptDraft}
      pluginComposerScope={normalPluginComposerHost.scope}
      textEffects={promptTextEffects}
      collapseResetKey={thread.id}
      arrivalHeight={
        arrivesFromPendingChat ? pendingChatArrival.composerHeight : null
      }
      takeArrivalText={arrivesFromPendingChat ? finishTypeAhead : null}
      focusEndKey={bottomFocusEndKey}
      yieldsExistingFocus={bottomYieldsExistingFocus}
      contextWindowUsage={contextWindowUsage ?? null}
      compactBeforeSend={
        compactBeforeSendTokens === null
          ? null
          : {
              compactFirst,
              tokens: compactBeforeSendTokens,
              onCompactFirstChange: (next) =>
                setFullHistoryThreadId(next ? null : thread.id),
            }
      }
      autoCompaction={autoCompactionOffer}
      execution={bottomExecutionConfig}
      permission={bottomPermissionConfig}
      sessionOptionsControl={sessionOptionsControl}
      typeahead={typeaheadConfig}
      promptActions={promptActions}
    />
  );

  return (
    <>
      {sentMessageEditorPortal}
      {bottomContent}
    </>
  );
}
