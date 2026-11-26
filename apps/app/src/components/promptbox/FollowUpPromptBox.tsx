import { Icon, type IconName } from "@omnyo/shared-ui/icon";
import { Button } from "@omnyo/shared-ui/button";
import { cn } from "@omnyo/shared-ui/lib/utils";
import type { FollowUpSubmitMode, PromptDraftState } from "@omnyo/client-core";
import {
  memo,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ComponentProps,
  type FocusEvent as ReactFocusEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  type RefObject,
} from "react";
import type {
  PromptTextMention,
  ThreadRuntimeDisplayStatus,
  ThreadTimelineActivePromptMode,
} from "@omnyo/domain";
import type { ComposerView, PluginComposerScope } from "@omnyo/plugin-sdk";
import type { ComposerTextEffectSource } from "@/lib/composer-text-effects";
import { modifierSubmitShortcutLabel } from "./modifier-submit-shortcut";
import {
  ComposerShellModeHeader,
  ComposerTerminalCard,
  ComposerTerminalToggleButton,
  parseComposerShellCommand,
  useComposerTerminal,
} from "./composer-terminal";
import { useAppCommandHandler } from "@/components/commands/AppCommandProvider";
import {
  APP_COMPOSER_SELECTOR,
  composerOwnsCommand,
  resolveComposerCommandScope,
} from "@/lib/composer-command-ownership";
import { useOptionalPaneContext } from "@/views/thread-detail/PaneContext";
import { MOTION_DURATION_MS } from "@omnyo/shared-ui/motion";
import { glidePromptBoxHeight } from "./prompt-box-height-glide";
import { COMPOSER_TOOL_BUTTON_CLASS } from "./composer-tool-button";
import { ComposerBannersSlot } from "@/components/plugin/PluginComposerBanners";
import { MobilePendingInteractionProvider } from "@/components/thread/pending-interactions/MobilePendingInteraction";
import { ComposerBannerStack } from "./ComposerBannerStack";
import {
  ComposerWorkingDock,
  ComposerWorkingProvider,
  type ComposerWorkingState,
} from "./ComposerWorkingTab";
import {
  ComposerStatusTray,
  ComposerStatusTrayToggle,
} from "./ComposerStatusTray";
import {
  PluginComposerHostProvider,
  PluginComposerViewProvider,
  type PluginComposerHost,
  usePluginComposerHostDraft,
  usePluginComposerViewModel,
} from "@/components/plugin/plugin-composer-host";
import {
  ComposerExtensionHost,
  useComposerExtensionController,
} from "@/components/plugin/ComposerExtensionHost";
import {
  DEFAULT_COMPOSER_SCOPE,
  PromptBoxInternal,
  type AttachmentsConfig,
  type HistoryConfig,
  type PromptBoxAction,
  type PromptBoxHandle,
  type PromptSubmitOptions,
  type TypeaheadConfig,
} from "@/components/promptbox/PromptBoxInternal";
import { usePromptModePermissionDisplay } from "@/components/promptbox/usePromptModePermissionDisplay";
import { usePromptVoice } from "@/components/promptbox/usePromptVoice";
import { PermissionModePicker } from "@/components/pickers/PermissionModePicker";
import {
  ExecutionControls,
  type ExecutionControlsProps,
  type ExecutionPermissionConfig,
} from "@/components/promptbox/ExecutionControls";
import { useBottomAnchoredScroll } from "@/components/ui/bottom-anchored-scroll-body.js";
import { useIsCompactViewport } from "@omnyo/shared-ui/hooks/use-compact-viewport";
import { usePointerCoarse } from "@omnyo/shared-ui/hooks/use-pointer-coarse";
import { ThreadTimelineScrollToBottomButton } from "@/views/thread-detail/ThreadTimelineScrollToBottomButton";
import type { ThreadContextWindowIndicator } from "@/components/thread/timeline";
import { formatCompactTokenCount } from "@/components/thread/timeline/thread-context-window-usage";
import type { PromptBoxChatMenu } from "@/components/promptbox/PromptBoxActionsMenu";
import {
  AutoCompactionChip,
  CompactBeforeSendChip,
  CompactBeforeSendNotice,
  type AutoCompactionOffer,
  type CompactBeforeSendOffer,
} from "@/components/promptbox/CompactBeforeSendChip";
import type { QueuedSendForecast } from "@/components/promptbox/QueuedSendForecastHint";
import { ThreadExecutionMachine } from "./ThreadExecutionMachine";

type PromptBoxWithScrollAnchorProps = ComponentProps<
  typeof PromptBoxInternal
> & {
  scrollToBottomOnSubmit?: boolean;
};

function PromptBoxWithScrollAnchor({
  onSubmit,
  scrollToBottomOnSubmit = true,
  submission,
  ...promptBoxProps
}: PromptBoxWithScrollAnchorProps) {
  const bottomAnchor = useBottomAnchoredScroll();

  const handleSubmit = (options?: PromptSubmitOptions) => {
    onSubmit(options);

    if (scrollToBottomOnSubmit) {
      bottomAnchor?.scrollToBottom();
    }
  };

  const handleModifierSubmit =
    submission?.onModifierSubmit === undefined
      ? undefined
      : (options?: PromptSubmitOptions) => {
          submission.onModifierSubmit?.(options);
          bottomAnchor?.scrollToBottom();
        };

  const anchoredSubmission =
    submission === undefined
      ? undefined
      : {
          ...submission,
          ...(handleModifierSubmit
            ? { onModifierSubmit: handleModifierSubmit }
            : {}),
        };

  return (
    <PromptBoxInternal
      {...promptBoxProps}
      onSubmit={handleSubmit}
      submission={anchoredSubmission}
    />
  );
}

const FOLLOW_UP_PROMPT_BOX_DEFAULT_MIN_HEIGHT = 40;

const FOLLOW_UP_PROMPT_BOX_PHONE_MIN_HEIGHT = 44;

const COMPOSER_CONTROL_SELECTOR = "button, [role='button'], [aria-haspopup]";

const PHONE_COMPOSER_OVERLAY_SELECTOR =
  "[data-omnyo-portaled-overlay], [role='dialog'], [role='menu'], [role='listbox'], [data-radix-popper-content-wrapper]";

export type { FollowUpSubmitMode } from "@omnyo/client-core";

export interface FollowUpComposerProps {
  history: HistoryConfig;
  isFollowUpSubmitting: boolean;
  message: string;
  mentionRanges: readonly PromptTextMention[];
  onChangeMessage: (value: string, mentionRanges: PromptTextMention[]) => void;
  onModifierSubmit: (options?: PromptSubmitOptions) => void;
  onSubmit: (options?: PromptSubmitOptions) => void;
  onEscape?: () => void;
  submitLabel?: string;
  submitIcon?: IconName;
  submitTitle?: string;
  compactPromptPlaceholder: string;
  promptPlaceholder: string;
  canModifierSubmit: boolean;
  steerActiveThreadOnEnter: boolean;
  submitMode: FollowUpSubmitMode;
  queuedSendForecast?: QueuedSendForecast | null;
  threadRuntimeDisplayStatus: ThreadRuntimeDisplayStatus;
}

type ContextWindowUsage = ComponentProps<
  typeof ThreadContextWindowIndicator
>["usage"];

export interface FollowUpPromptBoxProps {
  id?: string;
  attachments: AttachmentsConfig;
  attention: ReactNode | null;
  stack: ReactNode | null;
  queue?: ReactNode | null;
  queuedMessageCount: number;
  activePromptMode?: ThreadTimelineActivePromptMode | null;
  composer: FollowUpComposerProps | null;
  contextWindowUsage: ContextWindowUsage | null;
  compactBeforeSend?: CompactBeforeSendOffer | null;
  autoCompaction?: AutoCompactionOffer | null;
  execution: ExecutionControlsProps;
  permission: ExecutionPermissionConfig;
  sessionOptionsControl?: ReactNode;
  machineId?: string;
  executionReadOnly?: boolean;
  permissionReadOnly?: boolean;
  typeahead: TypeaheadConfig;
  promptActions?: readonly PromptBoxAction[];
  suppressPluginComposerCustomizations?: boolean;
  pluginComposerHost?: PluginComposerHost | null;
  voiceDraft?: {
    getCurrent: () => PromptDraftState;
    setDraft: (draft: PromptDraftState) => void;
  };
  pluginComposerScope?: PluginComposerScope | null;
  textEffects?: readonly ComposerTextEffectSource[];
  collapseResetKey: string | number;
  arrivalHeight?: number | null;
  takeArrivalText?: (() => string) | null;
  focusEndKey?: string | number;
  yieldsExistingFocus?: () => boolean;
  isPrimaryComposer?: boolean;
  showScrollToBottomButton?: boolean;
  pendingInteraction?: ReactNode;
  working?: ComposerWorkingState | null;
}

type FollowUpPromptBoxWithComposerProps = Omit<
  FollowUpPromptBoxProps,
  "composer"
> & {
  composer: FollowUpComposerProps;
};

function FollowUpPromptBoxStackOnly({
  attention,
  stack,
  queue = null,
  pluginComposerHost,
  pluginComposerScope,
}: Pick<
  FollowUpPromptBoxProps,
  "attention" | "stack" | "queue" | "pluginComposerHost" | "pluginComposerScope"
>) {
  const composerScope =
    pluginComposerScope ?? pluginComposerHost?.scope ?? null;

  const hostDraft = usePluginComposerHostDraft(pluginComposerHost ?? null);

  const composerView = usePluginComposerViewModel({
    scope: composerScope ?? DEFAULT_COMPOSER_SCOPE,
    layout: "expanded",
    text: hostDraft?.text ?? "",
    attachmentCount: hostDraft?.attachments.length ?? 0,
    isRunning: false,
    isSubmitting: false,
  });

  if (!attention && !stack && !queue && !composerScope) {
    return null;
  }

  return (
    <PluginComposerViewProvider value={composerView}>
      <PluginComposerHostProvider value={pluginComposerHost ?? null}>
        <MobilePendingInteractionProvider>
          <div data-promptbox-shell="" className="space-y-2">
            <ComposerBannerStack>
              {composerScope ? (
                <ComposerBannersSlot attachedToComposer={queue}>
                  {attention}
                  {stack}
                </ComposerBannersSlot>
              ) : (
                <>
                  {attention}
                  {stack}
                  {queue}
                </>
              )}
            </ComposerBannerStack>
          </div>
        </MobilePendingInteractionProvider>
      </PluginComposerHostProvider>
    </PluginComposerViewProvider>
  );
}

function FollowUpPromptBoxWithComposer({
  id,
  attachments,
  attention,
  stack,
  queue = null,
  queuedMessageCount,
  activePromptMode = null,
  composer,
  compactBeforeSend = null,
  autoCompaction = null,
  execution,
  permission,
  sessionOptionsControl = null,
  machineId,
  executionReadOnly,
  permissionReadOnly,
  typeahead,
  promptActions,
  suppressPluginComposerCustomizations,
  pluginComposerHost,
  voiceDraft,
  pluginComposerScope,
  textEffects,
  collapseResetKey,
  arrivalHeight = null,
  takeArrivalText = null,
  focusEndKey,
  yieldsExistingFocus,
  isPrimaryComposer = true,
  showScrollToBottomButton = true,
  pendingInteraction = null,
  working = null,
}: FollowUpPromptBoxWithComposerProps) {
  const submitMode = composer.submitMode;

  const hasPendingInteraction =
    pendingInteraction !== null && pendingInteraction !== undefined;

  const isStopping = submitMode.kind === "queue-while-stopping";
  const canQueueFollowUp = submitMode.kind === "queue" || isStopping;
  const canSubmit = submitMode.kind === "ready" || canQueueFollowUp;

  const readySendForecast =
    submitMode.kind === "ready" ? (composer.queuedSendForecast ?? null) : null;

  const isLoadingExecutionOptions =
    submitMode.kind === "blocked" &&
    submitMode.reason === "loading-execution-options";

  const isUnavailable =
    submitMode.kind === "blocked" && submitMode.reason === "unavailable";

  const onStopRuntime =
    submitMode.kind === "queue" ? submitMode.onStop : undefined;

  const canStopRuntime = onStopRuntime !== undefined;
  const attachmentCount = attachments.items?.length ?? 0;

  const composerScope =
    pluginComposerScope ?? pluginComposerHost?.scope ?? null;

  const composerTerminal = useComposerTerminal(
    isPrimaryComposer && composerScope?.kind === "thread"
      ? composerScope.threadId
      : null,
  );

  const shellCommand =
    composerTerminal !== null && attachmentCount === 0
      ? parseComposerShellCommand(composer.message)
      : null;

  const isShellMode = shellCommand !== null;
  const isTerminalShown = composerTerminal?.isShown ?? false;

  const [terminalWasShown, setTerminalWasShown] = useState(isTerminalShown);
  const [returnedFromTerminal, setReturnedFromTerminal] = useState(false);

  if (isTerminalShown !== terminalWasShown) {
    setTerminalWasShown(isTerminalShown);
    setReturnedFromTerminal(!isTerminalShown);
  }

  const [composerLayout, setComposerLayout] =
    useState<ComposerView["layout"]>("expanded");

  const composerView = usePluginComposerViewModel({
    scope: composerScope ?? DEFAULT_COMPOSER_SCOPE,
    layout: composerLayout,
    text: composer.message,
    attachmentCount,
    isRunning: canStopRuntime || isStopping,
    isSubmitting: composer.isFollowUpSubmitting,
  });

  const promptBoxRef = useRef<PromptBoxHandle>(null);

  const voice = usePromptVoice(
    promptBoxRef,
    voiceDraft
      ? {
          ...voiceDraft,
          scope: pluginComposerHost?.scope,
          draftScope: pluginComposerHost?.draftScope,
          submit: pluginComposerHost?.submit,
          submitDraft: pluginComposerHost?.submitDraft,
          reserveSubmission: pluginComposerHost?.reserveSubmission,
          captureAttachments: pluginComposerHost?.captureAttachments,
        }
      : (pluginComposerHost ?? undefined),
  );

  const isCompactViewport = useIsCompactViewport();
  const isPointerCoarse = usePointerCoarse();
  const composerInteractionRef = useRef<HTMLDivElement>(null);
  const composerSectionRef = useRef<HTMLDivElement>(null);
  const pressesControlRef = useRef(false);
  const sectionPressCleanupRef = useRef<(() => void) | null>(null);

  const [phoneComposerActive, setPhoneComposerActive] = useState(false);
  const [statusTrayOpenState, setStatusTrayOpenState] = useState(false);
  const [phoneStateKey, setPhoneStateKey] = useState(collapseResetKey);

  if (phoneStateKey !== collapseResetKey) {
    setPhoneStateKey(collapseResetKey);
    setPhoneComposerActive(false);
    setStatusTrayOpenState(false);
    setReturnedFromTerminal(false);
  }

  const isComposerEmpty =
    composer.message.trim() === "" && attachmentCount === 0;

  const isComposerEmptyRef = useRef(isComposerEmpty);

  useLayoutEffect(() => {
    isComposerEmptyRef.current = isComposerEmpty;
  }, [isComposerEmpty]);

  const isPhoneComposerIdle =
    isCompactViewport && !phoneComposerActive && isComposerEmpty;

  const isComposerCompact = isPhoneComposerIdle;

  const compactConfig = useMemo(
    () =>
      isCompactViewport
        ? {
            isCompact: isComposerCompact,
            placeholder: composer.compactPromptPlaceholder,
          }
        : undefined,
    [composer.compactPromptPlaceholder, isComposerCompact, isCompactViewport],
  );

  const usesStatusTray = isCompactViewport && !hasPendingInteraction;
  const statusTrayId = useId();
  const [statusTrayHasContent, setStatusTrayHasContent] = useState(false);

  const statusTrayOpen =
    usesStatusTray && statusTrayHasContent && statusTrayOpenState;

  const toggleStatusTray = useCallback(() => {
    setStatusTrayOpenState((current) => !current);
  }, []);

  const handleStatusTrayContentChange = useCallback((hasContent: boolean) => {
    setStatusTrayHasContent(hasContent);

    if (!hasContent) setStatusTrayOpenState(false);
  }, []);

  const [arrivalFromHeight] = useState(arrivalHeight);

  useLayoutEffect(() => {
    const form =
      composerInteractionRef.current?.querySelector<HTMLElement>(
        "[data-promptbox]",
      );

    if (arrivalFromHeight === null || !form) return;

    return glidePromptBoxHeight(form, arrivalFromHeight, {
      durationMs: MOTION_DURATION_MS.base,
    });
  }, [arrivalFromHeight]);

  const focusDefault = useCallback(() => {
    promptBoxRef.current?.focusEnd();

    return promptBoxRef.current !== null;
  }, []);

  const cancelSectionPress = useCallback(() => {
    sectionPressCleanupRef.current?.();
    sectionPressCleanupRef.current = null;
    pressesControlRef.current = false;
  }, []);

  const handleSectionPointerDown = useCallback(
    (event: ReactPointerEvent) => {
      cancelSectionPress();
      const target = event.target;
      pressesControlRef.current =
        target instanceof Element &&
        composerInteractionRef.current?.contains(target) === true &&
        target.closest(COMPOSER_CONTROL_SELECTOR) !== null;

      if (!pressesControlRef.current) return;
      let releaseTimeout: number | null = null;

      const cleanup = () => {
        window.removeEventListener("pointerup", finishRelease, true);
        window.removeEventListener("pointercancel", finishRelease, true);

        if (releaseTimeout !== null) window.clearTimeout(releaseTimeout);
        pressesControlRef.current = false;
      };

      const finishRelease = () => {
        releaseTimeout = window.setTimeout(() => {
          cleanup();
          sectionPressCleanupRef.current = null;
        });
      };

      window.addEventListener("pointerup", finishRelease, {
        capture: true,
        once: true,
      });
      window.addEventListener("pointercancel", finishRelease, {
        capture: true,
        once: true,
      });
      sectionPressCleanupRef.current = cleanup;
    },
    [cancelSectionPress],
  );

  const handleComposerFocus = useCallback(
    (event: ReactFocusEvent) => {
      if (
        takeArrivalText !== null &&
        event.target instanceof HTMLElement &&
        event.target.getAttribute("contenteditable") === "true"
      ) {
        const arrivalText = takeArrivalText();

        if (arrivalText !== "") {
          composer.onChangeMessage(`${composer.message}${arrivalText}`, [
            ...composer.mentionRanges,
          ]);
        }
      }

      if (pressesControlRef.current) return;

      if (isCompactViewport && !phoneComposerActive) {
        if (isPhoneComposerIdle)
          promptBoxRef.current?.captureHeightForLayoutChange();
        setPhoneComposerActive(true);
      }
    },
    [
      composer,
      isCompactViewport,
      isPhoneComposerIdle,
      phoneComposerActive,
      takeArrivalText,
    ],
  );

  useEffect(() => {
    const composerElement = composerInteractionRef.current;

    if (!isCompactViewport || !phoneComposerActive || !composerElement) return;
    let pointerDown = false;
    let settleTimeout: number | null = null;

    const isInSection = (node: EventTarget | null) =>
      node instanceof Node &&
      (composerSectionRef.current ?? composerElement).contains(node);

    const isInOverlay = (node: EventTarget | null) =>
      node instanceof Element &&
      node.closest(PHONE_COMPOSER_OVERLAY_SELECTOR) !== null;

    const settle = () => {
      settleTimeout = null;
      const active = document.activeElement;

      if (pointerDown || isInSection(active) || isInOverlay(active)) return;

      if (isComposerEmptyRef.current)
        promptBoxRef.current?.captureHeightForLayoutChange();
      setPhoneComposerActive(false);
    };

    const scheduleSettle = () => {
      if (settleTimeout !== null) window.clearTimeout(settleTimeout);
      settleTimeout = window.setTimeout(settle);
    };

    const handlePointerDown = () => {
      pointerDown = true;
    };

    const handlePointerEnd = (event: PointerEvent) => {
      pointerDown = false;

      if (
        event.type === "pointerup" &&
        !isInSection(event.target) &&
        !isInOverlay(event.target)
      )
        scheduleSettle();
    };

    const handleFocusOut = (event: FocusEvent) => {
      if (!isInSection(event.relatedTarget)) scheduleSettle();
    };

    document.addEventListener("pointerdown", handlePointerDown, true);
    document.addEventListener("pointerup", handlePointerEnd, true);
    document.addEventListener("pointercancel", handlePointerEnd, true);
    composerElement.addEventListener("focusout", handleFocusOut);

    return () => {
      if (settleTimeout !== null) window.clearTimeout(settleTimeout);
      document.removeEventListener("pointerdown", handlePointerDown, true);
      document.removeEventListener("pointerup", handlePointerEnd, true);
      document.removeEventListener("pointercancel", handlePointerEnd, true);
      composerElement.removeEventListener("focusout", handleFocusOut);
    };
  }, [isCompactViewport, phoneComposerActive]);

  const collapseIfFocused = useCallback(() => {
    const activeElement = document.activeElement;

    if (
      !(activeElement instanceof HTMLElement) ||
      !composerInteractionRef.current?.contains(activeElement)
    ) {
      return false;
    }

    activeElement.blur();

    return true;
  }, []);

  const extensionController = useComposerExtensionController({
    host: pluginComposerHost ?? null,
    view: composerView,
    collapseIfFocused,
    focusDefault,
  });

  useEffect(() => cancelSectionPress, [cancelSectionPress]);

  const steerOnPrimarySubmit =
    submitMode.kind === "queue" && composer.steerActiveThreadOnEnter;

  const isSteeringWhenReady =
    steerOnPrimarySubmit &&
    (composer.threadRuntimeDisplayStatus === "provisioning" ||
      composer.threadRuntimeDisplayStatus === "starting");

  const {
    onChangeMessage: changeComposerMessage,
    onModifierSubmit: modifierSubmitComposer,
    onSubmit: submitComposer,
  } = composer;

  const isFocusedPane = useOptionalPaneContext()?.isFocused ?? true;

  const ownsComposerTerminalCommand = useCallback(
    ({ target }: { target: EventTarget | null }) =>
      composerOwnsCommand(
        resolveComposerCommandScope({
          composer:
            composerInteractionRef.current?.closest(APP_COMPOSER_SELECTOR) ??
            null,
          target,
          isFocusedPane,
        }),
      ),
    [isFocusedPane],
  );

  const showChat = useCallback(() => {
    composerTerminal?.hide();
    requestAnimationFrame(() => promptBoxRef.current?.focusEnd());
  }, [composerTerminal]);

  useAppCommandHandler(
    "composer.terminal.toggle",
    () => {
      if (composerTerminal === null) return false;

      if (composerTerminal.isShown) {
        showChat();
      } else {
        composerTerminal.toggle();
      }

      return true;
    },
    0,
    composerTerminal !== null,
    ownsComposerTerminalCommand,
  );

  const chatCanSubmit =
    canSubmit &&
    !composer.isFollowUpSubmitting &&
    !(steerOnPrimarySubmit && !composer.canModifierSubmit);

  const sendShellTextToChat = useCallback(() => {
    if (steerOnPrimarySubmit) {
      modifierSubmitComposer();

      return;
    }

    submitComposer();
  }, [modifierSubmitComposer, steerOnPrimarySubmit, submitComposer]);

  const runShellCommand = useCallback(() => {
    if (composerTerminal === null || !shellCommand) return;
    void composerTerminal
      .run(shellCommand)
      .then(() => changeComposerMessage("", []))
      .catch(() => composerTerminal.hide());
  }, [changeComposerMessage, composerTerminal, shellCommand]);

  const handleTerminalSelectionAddToChat = useCallback(
    (text: string) => {
      showChat();
      requestAnimationFrame(() =>
        promptBoxRef.current?.insertTextAtCursor(text),
      );
    },
    [showChat],
  );

  const onModifierSubmit = composer.canModifierSubmit
    ? modifierSubmitComposer
    : undefined;

  const modifierSubmitHint = (action: "queue" | "steer"): string =>
    onModifierSubmit ? `, ${modifierSubmitShortcutLabel()} to ${action}` : "";

  const executionControlsDisabled =
    (executionReadOnly ?? false) || hasPendingInteraction;

  const footerStart = useMemo(
    () => (
      <>
        <ExecutionControls
          {...execution}
          disabled={executionControlsDisabled}
        />
        {sessionOptionsControl}
      </>
    ),
    [execution, executionControlsDisabled, sessionOptionsControl],
  );

  const { permissionDisplayOverride, permissionPickerDisabledByPlanMode } =
    usePromptModePermissionDisplay({
      execution,
      value: composer.message,
      mentionRanges: composer.mentionRanges,
      activePromptMode,
    });

  const permissionReadOnlyResolved =
    (permissionReadOnly ?? false) || hasPendingInteraction;

  const permissionPickerDisabled =
    permissionReadOnlyResolved || permissionPickerDisabledByPlanMode;

  const permissionControl = useMemo(
    () => (
      <PermissionModePicker
        value={permission.value}
        options={permission.options}
        onChange={permission.onChange}
        supported={permission.supported}
        disabled={permissionPickerDisabled}
        displayOverride={permissionDisplayOverride}
        presentation="icon"
        className={COMPOSER_TOOL_BUTTON_CLASS}
      />
    ),
    [
      permission.onChange,
      permission.options,
      permission.supported,
      permission.value,
      permissionDisplayOverride,
      permissionPickerDisabled,
    ],
  );

  const showTerminal = composerTerminal?.session
    ? composerTerminal.toggle
    : null;

  const chatMenu = useMemo((): PromptBoxChatMenu | undefined => {
    if (!isCompactViewport) return undefined;
    const permissionValue = permission.value;

    return {
      approvals:
        permission.supported &&
        permissionValue !== undefined &&
        permission.options.length > 1 &&
        !permissionPickerDisabled
          ? {
              value: permissionValue,
              options: permission.options,
              onChange: permission.onChange,
            }
          : null,
      compactBeforeSend,
      autoCompaction,
      onShowTerminal: showTerminal,
    };
  }, [
    autoCompaction,
    compactBeforeSend,
    isCompactViewport,
    permission.onChange,
    permission.options,
    permission.supported,
    permission.value,
    permissionPickerDisabled,
    showTerminal,
  ]);

  const compactFirstNotice =
    isCompactViewport && compactBeforeSend?.compactFirst ? (
      <CompactBeforeSendNotice
        tokens={compactBeforeSend.tokens}
        onCompactFirstChange={compactBeforeSend.onCompactFirstChange}
      />
    ) : null;

  const composerMinHeight = isCompactViewport
    ? FOLLOW_UP_PROMPT_BOX_PHONE_MIN_HEIGHT
    : FOLLOW_UP_PROMPT_BOX_DEFAULT_MIN_HEIGHT;

  const composerElement = (
    <div
      ref={composerInteractionRef}
      className="relative z-20"
      data-follow-up-composer=""
      data-follow-up-composer-expanded={isComposerCompact ? undefined : ""}
      hidden={hasPendingInteraction}
      onFocusCapture={handleComposerFocus}
    >
      <div
        className={
          isTerminalShown
            ? "hidden"
            : cn("contents", returnedFromTerminal && "*:animate-in *:fade-in-0")
        }
        onAnimationEnd={
          returnedFromTerminal
            ? (event) => {
                if (
                  event.target instanceof Element &&
                  event.target.parentElement === event.currentTarget
                ) {
                  setReturnedFromTerminal(false);
                }
              }
            : undefined
        }
      >
        <PromptBoxWithScrollAnchor
          id={id}
          promptBoxRef={promptBoxRef}
          onFocusCommand={extensionController.focus}
          voice={voice}
          minHeight={composerMinHeight}
          value={composer.message}
          mentionRanges={composer.mentionRanges}
          onChange={changeComposerMessage}
          onSubmit={isShellMode ? runShellCommand : submitComposer}
          onEscape={composer.onEscape}
          blurOnPointerSubmit={isCompactViewport && isPointerCoarse}
          textEffects={textEffects}
          onComposerLayoutChange={setComposerLayout}
          scrollToBottomOnSubmit={submitMode.kind !== "queue"}
          history={composer.history}
          focusEndKey={focusEndKey}
          yieldsExistingFocus={yieldsExistingFocus}
          placeholder={
            isCompactViewport
              ? composer.compactPromptPlaceholder
              : composer.promptPlaceholder
          }
          containerCompactPlaceholder={composer.compactPromptPlaceholder}
          heightAnimationKey={isComposerCompact ? "compact" : "expanded"}
          mentionMenuPlacement="top"
          submission={
            isShellMode
              ? {
                  label: "Run",
                  icon: "Terminal",
                  title: "Run in terminal (Enter)",
                  isSubmitting: composerTerminal?.isStarting ?? false,
                  disabled:
                    !shellCommand || (composerTerminal?.isStarting ?? false),
                  disabledReason: shellCommand ? undefined : "Type a command",
                  onModifierSubmit: chatCanSubmit
                    ? sendShellTextToChat
                    : undefined,
                  menuActions: chatCanSubmit
                    ? [
                        {
                          key: "send-to-chat",
                          label: "Send to chat",
                          icon: "MessageSquare",
                          shortcutLabel: modifierSubmitShortcutLabel(),
                          onSelect: sendShellTextToChat,
                        },
                      ]
                    : undefined,
                }
              : {
                  label:
                    readySendForecast !== null ||
                    (canQueueFollowUp && !steerOnPrimarySubmit)
                      ? "Queue message"
                      : composer.submitLabel,
                  icon:
                    readySendForecast !== null ||
                    (canQueueFollowUp && !steerOnPrimarySubmit)
                      ? "ListEnd"
                      : composer.submitIcon,
                  onStop: onStopRuntime,
                  isSubmitting: composer.isFollowUpSubmitting,
                  disabled:
                    !canSubmit ||
                    composer.isFollowUpSubmitting ||
                    (steerOnPrimarySubmit && !composer.canModifierSubmit),
                  disabledReason: composer.isFollowUpSubmitting
                    ? "Submitting..."
                    : isLoadingExecutionOptions
                      ? "Loading models..."
                      : isUnavailable
                        ? "Unavailable"
                        : undefined,
                  onModifierSubmit,
                  swapSubmitActions: steerOnPrimarySubmit,
                  showModifierSubmitAction: submitMode.kind === "queue",
                  title: composer.isFollowUpSubmitting
                    ? "Submitting..."
                    : canSubmit && compactBeforeSend?.compactFirst
                      ? `Compact ${formatCompactTokenCount(compactBeforeSend.tokens)} tokens, then send (Enter)`
                      : canSubmit && composer.submitTitle !== undefined
                        ? composer.submitTitle
                        : readySendForecast !== null
                          ? "Queue message (Enter)"
                          : isStopping
                            ? "Queue for after the stop (Enter)"
                            : canQueueFollowUp
                              ? steerOnPrimarySubmit
                                ? isSteeringWhenReady
                                  ? `Steer when ready (Enter)${modifierSubmitHint("queue")}`
                                  : `Steer current run (Enter)${modifierSubmitHint("queue")}`
                                : `Queue follow-up (Enter)${modifierSubmitHint("steer")}`
                              : isLoadingExecutionOptions
                                ? "Loading models..."
                                : isUnavailable
                                  ? "Unavailable"
                                  : "Submit (Enter)",
                  isRunning: canStopRuntime,
                }
          }
          typeahead={typeahead}
          attachments={attachments}
          promptActions={promptActions}
          chatMenu={chatMenu}
          submitAccessory={
            isCompactViewport ? null : (
              <>
                {machineId ? (
                  <ThreadExecutionMachine hostId={machineId} />
                ) : null}
                {compactBeforeSend ? (
                  <CompactBeforeSendChip {...compactBeforeSend} />
                ) : null}
                {compactBeforeSend === null && autoCompaction !== null ? (
                  <AutoCompactionChip {...autoCompaction} />
                ) : null}
                {composerTerminal?.session ? (
                  <span data-promptbox-expanded-only="" className="contents">
                    <ComposerTerminalToggleButton
                      onToggle={composerTerminal.toggle}
                    />
                  </span>
                ) : null}
                <span data-promptbox-expanded-only="" className="contents">
                  {permissionControl}
                </span>
              </>
            )
          }
          suppressPluginComposerCustomizations={
            suppressPluginComposerCustomizations
          }
          compact={compactConfig}
          editorLayout="thread"
          modeHeader={
            execution.handoff?.active ? (
              <div className="flex min-h-7 items-center gap-1.5 text-xs text-subtle-foreground">
                <Icon
                  name="MessageSquarePlus"
                  className="size-3.5 shrink-0"
                  aria-hidden
                />
                <span>Handoff to new thread</span>
                <Button
                  type="button"
                  size="icon"
                  variant="ghost"
                  className="ml-auto size-6 shrink-0 text-subtle-foreground"
                  onClick={execution.handoff.onExit}
                  disabled={executionControlsDisabled}
                  aria-label="Exit handoff"
                >
                  <Icon name="X" className="size-3" aria-hidden />
                </Button>
              </div>
            ) : isShellMode ? (
              <ComposerShellModeHeader />
            ) : null
          }
          footerStart={footerStart}
        />
      </div>
      {composerTerminal !== null && isTerminalShown ? (
        <ComposerTerminalCard
          terminal={composerTerminal}
          onSelectionAddToChat={handleTerminalSelectionAddToChat}
          onShowChat={showChat}
        />
      ) : null}
    </div>
  );

  return (
    <ComposerExtensionHost
      controller={extensionController}
      defaultRenderer={
        <DefaultFollowUpComposer
          active={composer.threadRuntimeDisplayStatus === "active"}
          composerElement={composerElement}
          hasPluginComposerScope={
            composerScope !== null && !suppressPluginComposerCustomizations
          }
          isPrimaryComposer={isPrimaryComposer}
          onSectionPointerDown={handleSectionPointerDown}
          sectionRef={composerSectionRef}
          pendingInteraction={pendingInteraction}
          working={working}
          showScrollToBottomButton={showScrollToBottomButton}
          attention={attention}
          stack={stack}
          queue={queue}
          compactFirstNotice={compactFirstNotice}
          statusTray={
            usesStatusTray
              ? {
                  id: statusTrayId,
                  open: statusTrayOpen,
                  hasContent: statusTrayHasContent,
                  queuedMessageCount,
                  resetKey: collapseResetKey,
                  onContentChange: handleStatusTrayContentChange,
                  onToggle: toggleStatusTray,
                }
              : null
          }
        />
      }
    />
  );
}

interface DefaultFollowUpComposerProps {
  active: boolean;
  composerElement: ReactNode;
  hasPluginComposerScope: boolean;
  isPrimaryComposer: boolean;
  onSectionPointerDown: (event: ReactPointerEvent) => void;
  sectionRef: RefObject<HTMLDivElement | null>;
  pendingInteraction?: ReactNode;
  working: ComposerWorkingState | null;
  showScrollToBottomButton: boolean;
  attention: ReactNode | null;
  stack: ReactNode | null;
  queue: ReactNode | null;
  compactFirstNotice: ReactNode | null;
  statusTray: {
    id: string;
    open: boolean;
    hasContent: boolean;
    queuedMessageCount: number;
    resetKey: string | number;
    onContentChange: (hasContent: boolean) => void;
    onToggle: () => void;
  } | null;
}

function DefaultFollowUpComposer({
  active,
  composerElement,
  hasPluginComposerScope,
  isPrimaryComposer,
  onSectionPointerDown,
  sectionRef,
  pendingInteraction = null,
  working,
  showScrollToBottomButton,
  attention,
  stack,
  queue,
  compactFirstNotice,
  statusTray,
}: DefaultFollowUpComposerProps) {
  const statusContent = hasPluginComposerScope ? (
    <ComposerBannersSlot attachedToComposer={queue}>
      {stack}
    </ComposerBannersSlot>
  ) : (
    <>
      {stack}
      {queue}
    </>
  );

  return (
    <MobilePendingInteractionProvider>
      <ComposerWorkingProvider
        state={working}
        allowQueueHost={statusTray === null}
      >
        <div ref={sectionRef} onPointerDownCapture={onSectionPointerDown}>
          {showScrollToBottomButton ? (
            <ThreadTimelineScrollToBottomButton active={active} />
          ) : null}
          <div
            data-app-composer=""
            data-app-composer-role={isPrimaryComposer ? "primary" : "secondary"}
            data-promptbox-shell=""
            className={cn(
              "flex flex-col gap-2",
              statusTray === null ? "md:gap-0" : "relative gap-1.5",
            )}
          >
            {statusTray === null ? (
              <ComposerBannerStack className="empty:hidden md:after:content-['']">
                {hasPluginComposerScope ? (
                  <ComposerBannersSlot attachedToComposer={queue}>
                    {attention}
                    {stack}
                  </ComposerBannersSlot>
                ) : (
                  <>
                    {attention}
                    {stack}
                    {queue}
                  </>
                )}
                {pendingInteraction}
              </ComposerBannerStack>
            ) : (
              <>
                <ComposerBannerStack className="empty:hidden">
                  {attention}
                  {compactFirstNotice}
                  {pendingInteraction}
                </ComposerBannerStack>
                {statusTray.hasContent ? (
                  <ComposerStatusTrayToggle
                    controlsId={statusTray.id}
                    open={statusTray.open}
                    queuedMessageCount={statusTray.queuedMessageCount}
                    onToggle={statusTray.onToggle}
                  />
                ) : null}
                <ComposerStatusTray
                  id={statusTray.id}
                  open={statusTray.open}
                  resetKey={statusTray.resetKey}
                  onContentChange={statusTray.onContentChange}
                >
                  {statusContent}
                </ComposerStatusTray>
              </>
            )}
            <ComposerWorkingDock>
              <div data-follow-up-composer-anchor="">{composerElement}</div>
            </ComposerWorkingDock>
          </div>
        </div>
      </ComposerWorkingProvider>
    </MobilePendingInteractionProvider>
  );
}

export const FollowUpPromptBox = memo(function FollowUpPromptBox(
  props: FollowUpPromptBoxProps,
) {
  if (props.composer === null) {
    return (
      <FollowUpPromptBoxStackOnly
        attention={props.attention}
        stack={props.stack}
        queue={props.queue}
        pluginComposerHost={props.pluginComposerHost}
        pluginComposerScope={props.pluginComposerScope}
      />
    );
  }

  return <FollowUpPromptBoxWithComposer {...props} composer={props.composer} />;
});
