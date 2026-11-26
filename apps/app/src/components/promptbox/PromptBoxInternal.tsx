import { shellHaptic } from "@/lib/native-shell/native-shell";
import { useHostDaemon } from "@/hooks/useHostDaemon";
import { registerLocalAttachmentPreview } from "@/lib/attachment-local-previews";
import { VoiceInputButton } from "./VoiceInputButton";
import { registerPaneComposerFocus } from "@/lib/pane-composer-focus";
import {
  uploadedAttachmentSource,
  type PendingAttachmentUpload,
} from "./usePendingAttachmentUploads";
import { registerThreadMentionDropTarget } from "@/lib/thread-mention-drop";
import type {
  PromptMentionCommandTrigger,
  PromptMentionResource,
  PromptTextMention,
} from "@omnyo/domain";
import type { ComposerView } from "@omnyo/plugin-sdk";
import type { ThreadResponse } from "@omnyo/server-contract";
import { QueryClientContext } from "@tanstack/react-query";
import { useThreadTitleMentionResources } from "@/components/thread/ThreadTitleMentions";
import { threadQueryKey } from "@/hooks/queries/query-keys";
import { sdk } from "@/lib/sdk";
import { getThreadDisplayTitle } from "@/lib/thread-title";
import type { Node as ProseMirrorNode, Slice } from "@tiptap/pm/model";
import { CommandManager } from "@tiptap/core";
import { closeHistory } from "@tiptap/pm/history";
import { TextSelection } from "@tiptap/pm/state";
import type { EditorView } from "@tiptap/pm/view";
import { useEditor, type Editor } from "@tiptap/react";
import { nanoid } from "nanoid";
import {
  useCallback,
  useContext,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type FormEvent,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  type Ref,
} from "react";
import {
  commandPillDismissedRangeEnd,
  findActiveTrigger,
  orderCommandSuggestions,
  type ActiveTrigger,
  type CommandMenuState,
  type MentionMenuState,
  type OrderedMentionSuggestions,
  type ProviderCommandSuggestion,
  type PromptMentionSuggestion,
  type TypeaheadMenuState,
  type TypeaheadTrigger,
} from "@omnyo/client-core";
import { AppCommandShortcutHint } from "@/components/commands/AppCommandShortcutHint";
import {
  useAppCommandKeyDispatch,
  useAppCommandShortcut,
} from "@/components/commands/AppCommandProvider";
import { canLoadMoreCommandResults } from "@/components/promptbox/mentions/mention-menu-scroll";
import {
  voiceUnsupportedMessage,
  type VoiceUnsupportedReason,
} from "@/hooks/voice-input-support";
import { Button } from "@omnyo/shared-ui/button";
import { Icon, type IconName } from "@omnyo/shared-ui/icon";
import {
  MOTION_DURATION_MS,
  prefersReducedMotion,
} from "@omnyo/shared-ui/motion";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@omnyo/shared-ui/tooltip";
import { ComposerActionsSlot } from "@/components/plugin/PluginComposerActions";
import { ComposerRailExtras } from "./ComposerRailExtras";
import {
  useResolvedComposerEditor,
  useResolvedComposerPopups,
} from "@/components/plugin/composer-slot-hooks";
import { PluginComposerPopup } from "@/components/plugin/PluginComposerPopup";
import { PluginComposerCommands } from "@/components/plugin/PluginComposerCommands";
import {
  APP_COMPOSER_SELECTOR,
  composerOwnsCommand,
  resolveComposerCommandScope,
} from "@/lib/composer-command-ownership";
import {
  ComposerCommand,
  ComposerCommandOwnerProvider,
} from "./composer-commands";
import { useOptionalPaneContext } from "@/views/thread-detail/PaneContext";
import { ComposerPopupHost } from "./ComposerPopupHost";
import {
  composerScopeIdentity,
  PluginComposerViewProvider,
  useOptionalPluginComposerView,
  usePluginComposerHost,
  usePluginComposerViewModel,
} from "@/components/plugin/plugin-composer-host";
import { useComposerInputLock } from "@/lib/plugin-sdk-hooks";
import { COARSE_POINTER_PROMPT_ICON_ACTION_BUTTON_CLASS } from "@omnyo/shared-ui/coarse-pointer-sizing";
import { CHROME_SUBTLE_ICON_BUTTON_FOREGROUND_CLASS } from "@omnyo/shared-ui/chrome-style-tokens";
import { usePointerCoarse } from "@omnyo/shared-ui/hooks/use-pointer-coarse";
import { useIsCompactViewport } from "@omnyo/shared-ui/hooks/use-compact-viewport";
import { blurActiveKeyboardInputWithin } from "@omnyo/shared-ui/overlay-trigger";
import {
  DEFAULT_PLUGIN_MENTION_TRIGGER,
  type PluginMentionTrigger,
} from "@omnyo/client-core";
import {
  clearComposerEditorBridge,
  publishComposerEditorBridge,
  type ComposerEditorBridge,
  type ComposerEditorInsertValue,
} from "@/lib/composer-editor-registry";
import type { ComposerEditorState } from "@omnyo/plugin-sdk/internal/composer-handle";
import {
  arePromptDraftStatesEqual,
  emptyPromptDraftState,
  hasAmbiguousPromptImageAnchors,
  isPromptDraftEmpty,
  isPromptImageAnchorMention,
  isSamePromptDraftAttachment,
  nextPromptImageAlias,
  resolvePromptImageAnchor,
  type PromptDraftAttachment,
  type PromptDraftState,
} from "@omnyo/client-core";
import { cn } from "@omnyo/shared-ui/lib/utils";
import { useComposerSuggestion } from "@/lib/composer-suggestions";
import { createCoreComposerActions } from "@/lib/plugin-composer-handle";
import {
  COMPOSER_SUGGESTION_ACTION_SELECTOR,
  ComposerSuggestion,
} from "./ComposerSuggestion";
import {
  COMPOSER_SUGGESTION_CARD_SELECTOR,
  ComposerSuggestionCard,
} from "./ComposerSuggestionCard";
import { PROMPT_STACK_EDGE_CARET_BUTTON_WIDTH_CLASS } from "./banner/PromptStackCard";
import {
  AttachmentPreview,
  isImageAttachment,
  resolveAttachmentPreviewSrc,
} from "./AttachmentPreview";
import {
  PromptImageAnchorContext,
  promptAttachmentKey,
  type PromptImageAnchorState,
} from "./attachment-anchor-focus";
import { useAttachmentOpener } from "@/components/secondary-panel/AttachmentOpenerContext";
import { isProjectAttachmentPath } from "@/lib/file-content-urls";
import {
  withAttachmentMentionSuggestions,
  type AttachmentMentionSuggestion,
} from "@/hooks/promptMentionCandidates";
import { VoiceRecordingBar } from "./VoiceRecordingBar";
import {
  ComposerPlusMenuSlot,
  type PromptBoxAction,
  type PromptBoxChatMenu,
} from "./PromptBoxActionsMenu";
import type { PromptMentionLinkResolver } from "./editor/prompt-mention-link";
import {
  refreshPromptDecorations,
  type PromptDecorationSource,
  type PromptDraftObserver,
} from "./editor/prompt-decoration-extension";
import type { ComposerTextEffectSource } from "@/lib/composer-text-effects";
import { promptEditorExtensions } from "./editor/prompt-editor-extensions";
import {
  AttachmentHistory,
  AttachmentHistoryStep,
  attachmentHistoryTransaction,
} from "./editor/attachment-history";
import {
  collectPromptImageAnchors,
  IMAGE_ANCHOR_DRAG_TYPE,
  isPendingImageAnchorPath,
  markPromptImageAnchorSync,
  pendingImageAnchorPath,
  promptImageAnchorContent,
  PromptImageAnchorSync,
  registerPendingImageAnchorFile,
  type PromptImageAnchorRef,
  type PromptImageAnchorSyncHandlers,
} from "./editor/prompt-image-anchor";
import {
  cancelPromptThreadLinkPaste,
  createPromptThreadLinkPasteExtension,
  promptThreadLinkPasteKey,
} from "./editor/prompt-thread-link-paste";
import {
  promptCommandResourceFromSuggestion,
  promptEditorClipboardTextFromSlice,
  promptEditorContentFromValue,
  promptEditorCopiedSlice,
  promptEditorInlineContentFromValue,
  promptEditorValueFromDoc,
  promptEditorValueFromSlice,
  promptMentionResourceFromSuggestion,
  type PromptEditorValue,
} from "./editor/prompt-editor-serialization";
import {
  exitTrailingBlockquoteBreak,
  insertParagraphBeforeBlockquote,
  removeEmptyBlockquotes,
} from "./editor/prompt-editor-blockquote";
import { applyPromptParagraphNewline } from "./editor/prompt-editor-paragraph";
import {
  MentionMenu,
  typeaheadSuggestionKey,
  type TypeaheadSuggestion,
} from "./mentions/MentionMenu";
import { useTypeaheadMenuMaxHeight } from "./useTypeaheadMenuMaxHeight";
import { parsePromptMentionClipboardElement } from "./mentions/prompt-mention-clipboard";
import {
  readMessageClipboardHtml,
  readMessageClipboardImage,
} from "@/lib/message-clipboard";
import { appToast } from "@/components/ui/app-toast";
import {
  getNativeFileResolver,
  partitionNativeFiles,
} from "@/lib/native-files";
import {
  carryAttachmentObservation,
  noteAttachmentNativePath,
  observePastedFiles,
} from "@/lib/attachment-diagnostics";
import { appLinkOrigins } from "@/lib/canonical-app-origin";
import { findPastedThreadLinkCandidates } from "./mentions/pasted-thread-link-candidates";
import {
  blurPromptEditor,
  ComposerEditorSlot,
  type ComposerEditorLayout,
} from "./ComposerEditorSlot";
import { QueuedEditorTypeaheadLayoutContext } from "./queued-editor-typeahead-layout";
import {
  isModifierSubmitKeyEvent,
  modifierSubmitShortcutAria,
} from "./modifier-submit-shortcut";

import {
  ComposerSendMenu,
  type ComposerSendMenuAction,
} from "./ComposerSendMenu";
import { glidePromptBoxHeight } from "./prompt-box-height-glide";
import {
  COMPOSER_SEND_BUTTON_CLASS,
  COMPOSER_TOOL_BUTTON_CLASS,
} from "./composer-tool-button";

const PROMPTBOX_MIN_HEIGHT = 68;

const PROMPTBOX_SELECTION_REVEAL_MARGIN = 12;

const COMPACT_PROMPT_ACTION_BUTTON_CLASS =
  "size-8 p-0 transition-[color,background-color,border-color,opacity,box-shadow,scale] [&_[data-icon-root]]:size-4 max-md:pointer-coarse:size-10";

const COMPACT_PROMPT_SEND_BUTTON_CLASS = `${COMPACT_PROMPT_ACTION_BUTTON_CLASS} rounded-full disabled:bg-surface-recessed disabled:text-subtle-foreground disabled:opacity-100`;

const RICH_PASTE_BLOCK_TAGS = new Set([
  "ADDRESS",
  "ARTICLE",
  "ASIDE",
  "BLOCKQUOTE",
  "DIV",
  "DD",
  "DL",
  "DT",
  "FIGCAPTION",
  "FIGURE",
  "FOOTER",
  "FORM",
  "H1",
  "H2",
  "H3",
  "H4",
  "H5",
  "H6",
  "HEADER",
  "HR",
  "MAIN",
  "NAV",
  "P",
  "SECTION",
  "TABLE",
  "TBODY",
  "TD",
  "TFOOT",
  "TH",
  "THEAD",
  "TR",
]);

const RICH_PASTE_LIST_MARKER = "- ";

const RICH_PASTE_IGNORED_TAGS = new Set([
  "HEAD",
  "LINK",
  "META",
  "NOSCRIPT",
  "SCRIPT",
  "STYLE",
  "TITLE",
]);

function hasWhitespaceAfterPosition(
  doc: ProseMirrorNode,
  position: number,
): boolean {
  const nextNode = doc.resolve(position).nodeAfter;

  if (!nextNode) {
    return false;
  }

  if (nextNode.isText) {
    return /^\s/u.test(nextNode.text ?? "");
  }

  return nextNode.type.name === "hardBreak";
}

function mentionPillTrailingText(
  doc: ProseMirrorNode,
  position: number,
): string {
  return hasWhitespaceAfterPosition(doc, position) ? "" : " ";
}

const VOICE_ACTION_EXIT_MS = MOTION_DURATION_MS.fast;

const PROMPTBOX_HEIGHT_TRANSITION_MS = MOTION_DURATION_MS.slow;

const PASTED_TEXT_ATTACHMENT_MIN_LENGTH = 5_000;

function uniqueAttachmentName(
  name: string,
  takenNames: ReadonlySet<string>,
): string {
  const extensionStart = name.lastIndexOf(".");
  const stem = extensionStart > 0 ? name.slice(0, extensionStart) : name;
  const extension = extensionStart > 0 ? name.slice(extensionStart) : "";
  let candidate = name;

  for (let index = 2; takenNames.has(candidate); index += 1) {
    candidate = `${stem} ${index}${extension}`;
  }

  return candidate;
}

function withUniqueAttachmentNames(
  files: readonly File[],
  existingNames: ReadonlySet<string>,
): File[] {
  const takenNames = new Set(existingNames);

  return files.map((file) => {
    const name = uniqueAttachmentName(file.name, takenNames);
    takenNames.add(name);

    if (name === file.name) return file;

    const renamed = new File([file], name, {
      type: file.type,
      lastModified: file.lastModified,
    });

    carryAttachmentObservation(file, renamed);

    return renamed;
  });
}

type VoiceActionTransition = "entering" | "active" | "exiting";

export const DEFAULT_COMPOSER_SCOPE = {
  kind: "new-thread",
  projectId: null,
} as const;

function shouldFinishVoiceCompletionTransitionImmediately(): boolean {
  return (
    prefersReducedMotion() ||
    (typeof document !== "undefined" && document.visibilityState === "hidden")
  );
}

export interface PromptSubmitOptions {
  sendNow?: true;
}

export interface PromptBoxSubmissionConfig {
  isSubmitting?: boolean;
  disabled?: boolean;
  disabledReason?: string;
  label?: string;
  icon?: IconName;
  title?: string;
  isRunning?: boolean;
  onStop?: () => void;
  onModifierSubmit?: (options?: PromptSubmitOptions) => void;
  swapSubmitActions?: boolean;
  showModifierSubmitAction?: boolean;
  menuActions?: readonly ComposerSendMenuAction[];
}

function suppressTouchCompatibilityClick(ownerDocument: Document) {
  const clear = () => {
    window.clearTimeout(timeout);
    ownerDocument.removeEventListener("click", handleClick, true);
    ownerDocument.removeEventListener("pointerdown", clear, true);
    ownerDocument.removeEventListener("keydown", clear, true);
  };

  const handleClick = (event: MouseEvent) => {
    if (event.detail === 0) return;
    clear();
    event.preventDefault();
    event.stopImmediatePropagation();
  };

  const timeout = window.setTimeout(clear, 1000);
  ownerDocument.addEventListener("click", handleClick, true);
  ownerDocument.addEventListener("pointerdown", clear, true);
  ownerDocument.addEventListener("keydown", clear, true);
}

interface PromptSubmitButtonProps {
  canSubmit: boolean;
  className: string;
  disabledReason: string | undefined;
  icon: IconName | undefined;
  isBusy: boolean;
  isCompact: boolean;
  label: string | undefined;
  onClick: (event: ReactMouseEvent<HTMLButtonElement>) => void;
  onPointerDown: (event: ReactPointerEvent<HTMLButtonElement>) => void;
  onTouchSubmit: () => void;
  title: string;
}

function PromptSubmitButton({
  canSubmit,
  className,
  disabledReason,
  icon,
  isBusy,
  isCompact,
  label,
  onClick,
  onPointerDown,
  onTouchSubmit,
  title,
}: PromptSubmitButtonProps) {
  const touchRef = useRef<{ pointerId: number; x: number; y: number } | null>(
    null,
  );

  const suppressTouchClickRef = useRef(false);

  const button = (
    <Button
      data-promptbox-submit-action=""
      type="submit"
      size={isCompact ? "icon" : "sm"}
      variant="default"
      aria-label={title}
      aria-busy={isBusy}
      disabled={!canSubmit}
      onPointerDown={(event) => {
        suppressTouchClickRef.current = false;
        touchRef.current =
          event.pointerType === "touch" && event.isPrimary && event.button === 0
            ? { pointerId: event.pointerId, x: event.clientX, y: event.clientY }
            : null;
        onPointerDown(event);
      }}
      onPointerMove={(event) => {
        const touch = touchRef.current;

        if (
          touch &&
          touch.pointerId === event.pointerId &&
          Math.hypot(event.clientX - touch.x, event.clientY - touch.y) > 10
        ) {
          touchRef.current = null;
          suppressTouchClickRef.current = true;
        }
      }}
      onPointerCancel={() => {
        if (touchRef.current) suppressTouchClickRef.current = true;
        touchRef.current = null;
      }}
      onPointerUp={(event) => {
        const touch = touchRef.current;
        touchRef.current = null;

        if (!touch || touch.pointerId !== event.pointerId) return;
        suppressTouchClickRef.current = true;

        if (!canSubmit) return;
        const bounds = event.currentTarget.getBoundingClientRect();

        if (
          Math.hypot(event.clientX - touch.x, event.clientY - touch.y) > 10 ||
          event.clientX < bounds.left ||
          event.clientX >= bounds.right ||
          event.clientY < bounds.top ||
          event.clientY >= bounds.bottom
        ) {
          return;
        }

        suppressTouchCompatibilityClick(event.currentTarget.ownerDocument);
        onTouchSubmit();
      }}
      onMouseDown={(event) => event.preventDefault()}
      onClick={(event) => {
        if (suppressTouchClickRef.current && event.detail > 0) {
          event.preventDefault();

          return;
        }

        onClick(event);
      }}
      className={cn(
        className,
        label !== undefined &&
          !isCompact &&
          "size-auto h-7.5 gap-1.5 px-3 max-md:pointer-coarse:size-auto max-md:pointer-coarse:h-10",
      )}
    >
      {isBusy ? (
        <Icon name="Loading" className="size-4 animate-spin" />
      ) : (
        <>
          <Icon name={icon ?? "ArrowUp"} className="size-4" />
          {label !== undefined && !isCompact ? (
            <span data-promptbox-submit-label="">{label}</span>
          ) : null}
        </>
      )}
    </Button>
  );

  if (!disabledReason) return button;

  return (
    <TooltipProvider delayDuration={300}>
      <Tooltip>
        <TooltipTrigger asChild>
          <span
            data-promptbox-submit-disabled-reason=""
            className="inline-flex shrink-0"
          >
            {button}
          </span>
        </TooltipTrigger>
        <TooltipContent side="top">{disabledReason}</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

export interface TypeaheadMentionConfig {
  triggers?: readonly PluginMentionTrigger[];
  results: OrderedMentionSuggestions;
  isLoading: boolean;
  isRefreshing: boolean;
  isError: boolean;
  onQueryChange: (
    query: string | null,
    trigger: PluginMentionTrigger | null,
  ) => void;
  resolveLink?: PromptMentionLinkResolver;
}

export interface TypeaheadCommandConfig {
  errorMessage?: string | null;
  isUpdating?: boolean;
  triggers: readonly PromptMentionCommandTrigger[];
  suggestions: readonly ProviderCommandSuggestion[];
  isLoading: boolean;
  isError: boolean;
  hasMore: boolean;
  isLoadingMore: boolean;
  loadMore: () => void;
  onQueryChange: (
    query: string | null,
    trigger: PromptMentionCommandTrigger | null,
  ) => void;
}

export interface TypeaheadConfig {
  mention: TypeaheadMentionConfig;
  command: TypeaheadCommandConfig;
}

export const INERT_TYPEAHEAD_COMMAND_CONFIG: TypeaheadCommandConfig = {
  triggers: [],
  suggestions: [],
  isLoading: false,
  isError: false,
  hasMore: false,
  isLoadingMore: false,
  loadMore: () => {},
  onQueryChange: () => {},
};

export interface AttachmentsConfig {
  targetHostId?: string | null;
  items?: PromptDraftAttachment[];
  pendingUploads?: readonly PendingAttachmentUpload[];
  isAttaching?: boolean;
  acceptWhileUploading?: boolean;
  error?: string | null;
  onAttachFiles?: (files: File[]) => Promise<PromptDraftAttachment[]>;
  onUpdate?: (
    update: (attachments: PromptDraftAttachment[]) => PromptDraftAttachment[],
  ) => void;
  projectId?: string;
}

interface AttachmentHistoryEntry {
  attachments: PromptDraftAttachment[] | null;
  aliases: string[];
  pendingPath?: string;
  draftKey: string | null;
  positions: number[];
  present: boolean;
}

function recordAttachmentHistory(
  view: EditorView,
  id: string,
  present: boolean,
): void {
  view.dispatch(attachmentHistoryTransaction(view.state.tr, id, present));
  view.dispatch(closeHistory(view.state.tr));
}

function reservedImageAliases(
  entries: ReadonlyMap<string, AttachmentHistoryEntry>,
): string[] {
  return [...entries.values()].flatMap((entry) => [
    ...entry.aliases,
    ...(entry.attachments ?? []).flatMap((attachment) =>
      attachment.alias === undefined ? [] : [attachment.alias],
    ),
  ]);
}

function pendingImageAnchorBatch(path: string): string | null {
  return isPendingImageAnchorPath(path) ? (path.split(":")[1] ?? null) : null;
}

function recordImageAnchorHistory(
  editor: Editor,
  id: string,
  anchors: readonly PromptImageAnchorRef[],
  position: number | undefined,
): void {
  const { view } = editor;
  const tr = closeHistory(view.state.tr);

  if (position !== undefined)
    tr.setSelection(
      TextSelection.near(
        tr.doc.resolve(Math.min(Math.max(position, 0), tr.doc.content.size)),
      ),
    );

  const { $from, $to } = tr.selection;
  const before = $from.nodeBefore;
  const after = $to.nodeAfter;

  const touches = (node: ProseMirrorNode | null | undefined, edge: RegExp) =>
    node !== null &&
    node !== undefined &&
    (node.type.name === "mention" ||
      (node.isText && !edge.test(node.text ?? "")));

  const content = [
    ...(touches(before, /\s$/u) ? [{ type: "text", text: " " }] : []),
    ...anchors.flatMap((anchor, index) => [
      ...(index > 0 ? [{ type: "text", text: " " }] : []),
      promptImageAnchorContent(anchor),
    ]),
    ...(touches(after, /^\s/u) ? [{ type: "text", text: " " }] : []),
  ];

  new CommandManager({ editor })
    .createChain(tr, true)
    .insertContent(content)
    .run();
  tr.step(new AttachmentHistoryStep(id, true));
  view.dispatch(markPromptImageAnchorSync(tr));
  view.dispatch(closeHistory(view.state.tr));
}

const settledPendingImageAnchors = new Map<
  string,
  PromptImageAnchorRef | "failed"
>();

const livePendingImageBatches = new Set<string>();

const pendingImageAnchorListeners = new Set<() => void>();

const UNCLEAR_IMAGE_MESSAGE =
  "An image link is unclear. Remove it and add the image again.";

function recordPastedTextHistory(
  editor: Editor,
  id: string,
  value: PromptEditorValue,
): void {
  const { view } = editor;
  const insert = closeHistory(view.state.tr);
  const from = view.state.selection.from;
  new CommandManager({ editor })
    .createChain(insert, true)
    .insertContent(promptEditorInlineContentFromValue(value))
    .run();
  const inserted = view.state.applyTransaction(insert).state;

  const replaced = inserted.applyTransaction(
    attachmentHistoryTransaction(
      inserted.tr.delete(insert.mapping.map(from, -1), inserted.selection.from),
      id,
      true,
    ),
  ).state;

  view.updateState(replaced.applyTransaction(closeHistory(replaced.tr)).state);
}

interface PromptBoxCompactConfig {
  isCompact: boolean;
  placeholder?: string;
}

export interface HistoryConfig {
  currentDraft: PromptDraftState;
  entries: readonly PromptDraftState[];
  onSelectEntry: (draft: PromptDraftState) => void;
  resetKey?: string | number;
}

type PromptVoiceState =
  | "idle"
  | "starting"
  | "recording"
  | "transcribing"
  | "error";

export interface PromptVoiceConfig {
  state: PromptVoiceState;
  microphoneWarning: string | null;
  isSupported: boolean;
  unsupportedReason?: VoiceUnsupportedReason | null;
  stream: MediaStream | null;
  start: () => void | Promise<void>;
  stop: () => void;
  send: () => void;
  cancel: () => void;
}

export interface PromptBoxHandle {
  focusEnd: () => void;
  captureHeightForLayoutChange: () => void;
  insertTextAtCursor: (text: string) => void;
  insertTypedText: (text: string) => void;
  sendVoiceTranscript: (text: string) => void;
  getTextBeforeCursor: () => string | undefined;
  playVoiceCompletionTransition: () => Promise<void>;
  dismissMenu: () => boolean;
  openAttachmentPicker: () => void;
  applyPromptAction: (action: PromptBoxAction) => void;
}

export type { PromptBoxAction } from "./PromptBoxActionsMenu";

export type MentionMenuPlacement = "top" | "bottom";

export type PromptBoxPlusMenu = "inline" | "none";

const FIND_SKILLS_SUGGESTION_KEY = "find-curated-skills";

type ComposerMenuState =
  | { kind: "suggestions"; trigger: ActiveTrigger; revealOnMatch: boolean }
  | { kind: "plugin"; key: string; open: boolean; initialSkillQuery?: string }
  | null;

export type PromptBoxSurface = "raised" | "flat";

interface PromptBoxInternalProps {
  id?: string;
  value: string;
  mentionRanges: readonly PromptTextMention[];
  onChange: (value: string, mentionRanges: PromptTextMention[]) => void;
  onSubmit: (options?: PromptSubmitOptions) => void;
  onEscape?: () => void;
  blurOnPointerSubmit?: boolean;
  placeholder?: string;
  autoFocus?: boolean;
  yieldsExistingFocus?: () => boolean;
  textEffects?: readonly ComposerTextEffectSource[];
  onComposerLayoutChange?: (layout: ComposerView["layout"]) => void;
  header?: ReactNode;
  modeHeader?: ReactNode;
  leading?: ReactNode;
  plusMenu?: PromptBoxPlusMenu;
  chatMenu?: PromptBoxChatMenu;
  footerStart?: ReactNode;
  submitAccessory?: ReactNode;
  submission?: PromptBoxSubmissionConfig;
  minHeight?: number;
  typeahead: TypeaheadConfig;
  mentionMenuPlacement: MentionMenuPlacement;
  attachments?: AttachmentsConfig;
  promptActions?: readonly PromptBoxAction[];
  suppressPluginComposerCustomizations?: boolean;
  onFocusCommand?: () => void;
  editorLayout?: ComposerEditorLayout;
  onCollapse?: () => void;
  compact?: PromptBoxCompactConfig;
  surface?: PromptBoxSurface;
  containerCompactPlaceholder?: string;
  heightAnimationKey?: string | number;
  history?: HistoryConfig;
  voice?: PromptVoiceConfig;
  promptBoxRef?: Ref<PromptBoxHandle>;
  focusEndKey?: string | number;
}

interface DismissedTriggerRange {
  start: number;
  end: number;
  hasLeftRange: boolean;
  reopenBeforeOffset: number | null;
}

interface PromptEditorValueKey {
  text: string;
  mentions: readonly PromptTextMention[];
}

const DEFAULT_TYPEAHEAD_MENTION_TRIGGERS = [
  DEFAULT_PLUGIN_MENTION_TRIGGER,
] as const satisfies readonly PluginMentionTrigger[];

interface PromptEditorSelectionRevealArgs {
  editor: Editor;
  scrollContainer: HTMLElement;
}

interface ParsedRichClipboardValue {
  threadLinks: { text: string; literal: boolean }[];
  hasMentions: boolean;
  value: PromptEditorValue;
}

type PromptBoxMouseDownEvent = ReactMouseEvent<HTMLFormElement>;

interface PromptActionInsertionRange {
  from: number;
  to: number;
}

interface PromptActionCommand {
  serializedText: string;
  trailingText: string;
  trigger: PromptMentionCommandTrigger;
  suggestion: ProviderCommandSuggestion;
}

const PROMPTBOX_INTERACTIVE_TARGET_SELECTOR = [
  "a[href]",
  "button",
  "input",
  "select",
  "textarea",
  "[contenteditable='true']",
  "[data-prompt-mention='true']",
  "[role='button']",
  "[role='link']",
  "[role='menuitem']",
  "[role='option']",
  COMPOSER_SUGGESTION_CARD_SELECTOR,
].join(",");

export function arePromptEditorValuesEqual(
  left: PromptEditorValueKey | null,
  right: PromptEditorValueKey,
): boolean {
  if (left === null) return false;

  if (left.text !== right.text) return false;

  if (left.mentions === right.mentions) return true;

  if (left.mentions.length !== right.mentions.length) return false;

  for (let index = 0; index < left.mentions.length; index += 1) {
    const leftMention = left.mentions[index]!;
    const rightMention = right.mentions[index]!;

    if (leftMention === rightMention) continue;

    if (
      leftMention.start !== rightMention.start ||
      leftMention.end !== rightMention.end
    ) {
      return false;
    }

    if (
      leftMention.resource !== rightMention.resource &&
      JSON.stringify(leftMention.resource) !==
        JSON.stringify(rightMention.resource)
    ) {
      return false;
    }
  }

  return true;
}

function normalizePastedPlainText(text: string): string {
  return text.replace(/\r\n?/gu, "\n");
}

function promptActionCommandMentionsFromText(
  text: string,
  actions: readonly PromptBoxAction[] | undefined,
): PromptTextMention[] {
  const mentions: PromptTextMention[] = [];

  for (const action of actions ?? []) {
    const commandAction = promptActionCommandFromAction(action);

    if (commandAction === null) {
      continue;
    }

    let searchStart = 0;

    while (searchStart < text.length) {
      const start = text.indexOf(commandAction.serializedText, searchStart);

      if (start === -1) {
        break;
      }

      const end = start + commandAction.serializedText.length;
      const before = start === 0 ? "" : text[start - 1]!;
      const after = end >= text.length ? "" : text[end]!;
      const hasTokenBoundaryBefore = before === "" || /\s/u.test(before);
      const hasTokenBoundaryAfter = after === "" || /\s/u.test(after);

      if (hasTokenBoundaryBefore && hasTokenBoundaryAfter) {
        mentions.push({
          start,
          end,
          resource: promptCommandResourceFromSuggestion({
            suggestion: commandAction.suggestion,
            trigger: commandAction.trigger,
          }),
        });
      }

      searchStart = end;
    }
  }

  return mentions.sort(
    (left, right) => left.start - right.start || left.end - right.end,
  );
}

function mergePromptTextMentions(
  baseMentions: readonly PromptTextMention[],
  additionalMentions: readonly PromptTextMention[],
): PromptTextMention[] {
  const merged = [...baseMentions].sort(
    (left, right) => left.start - right.start || left.end - right.end,
  );

  for (const additionalMention of additionalMentions) {
    const overlapsExisting = merged.some(
      (mention) =>
        additionalMention.start < mention.end &&
        additionalMention.end > mention.start,
    );

    if (!overlapsExisting) {
      merged.push(additionalMention);
    }
  }

  return merged.sort(
    (left, right) => left.start - right.start || left.end - right.end,
  );
}

function withPromptActionCommandMentions(
  value: PromptEditorValue,
  promptActions: readonly PromptBoxAction[] | undefined,
): PromptEditorValue {
  const promptActionMentions = promptActionCommandMentionsFromText(
    value.text,
    promptActions,
  );

  if (promptActionMentions.length === 0) {
    return value;
  }

  return {
    ...value,
    mentions: mergePromptTextMentions(value.mentions, promptActionMentions),
  };
}

function promptEditorValueFromPlainText(
  text: string,
  promptActions?: readonly PromptBoxAction[],
): PromptEditorValue {
  const normalizedText = normalizePastedPlainText(text);

  return withPromptActionCommandMentions(
    {
      text: normalizedText,
      mentions: [],
    },
    promptActions,
  );
}

function promptEditorSliceHasBlockquote(slice: Slice): boolean {
  let hasBlockquote = false;
  slice.content.descendants((node) => {
    if (node.type.name === "blockquote") {
      hasBlockquote = true;

      return false;
    }

    return true;
  });

  return hasBlockquote;
}

function plainTextHasQuoteLine(text: string): boolean {
  return normalizePastedPlainText(text)
    .split("\n")
    .some((line) => line === ">" || line.startsWith("> "));
}

function trimTrailingPromptNewlines(
  value: PromptEditorValue,
): PromptEditorValue {
  const text = value.text.replace(/\n+$/u, "");

  if (text.length === value.text.length) {
    return value;
  }

  return {
    text,
    mentions: value.mentions.filter((mention) => mention.end <= text.length),
  };
}

function promptEditorValueFromRichHtml(html: string): ParsedRichClipboardValue {
  const document = new DOMParser().parseFromString(html, "text/html");
  let text = "";
  let hasMentions = false;
  let listMarkerPending = false;
  const mentions: PromptTextMention[] = [];
  const literalRanges: { from: number; to: number }[] = [];

  const flushListMarker = () => {
    if (!listMarkerPending) {
      return;
    }

    listMarkerPending = false;
    text += RICH_PASTE_LIST_MARKER;
  };

  const appendText = (appendedText: string, literal = false) => {
    if (appendedText.length === 0) {
      return;
    }

    flushListMarker();

    if (literal)
      literalRanges.push({
        from: text.length,
        to: text.length + appendedText.length,
      });
    text += appendedText;
  };

  const appendNewline = () => {
    text = text.replace(/[ \t]+$/u, "");

    if (text.length > 0 && !text.endsWith("\n")) {
      text += "\n";
    }
  };

  const appendCollapsedText = (rawText: string, literal: boolean) => {
    const collapsedText = rawText.replace(/\s+/gu, " ");

    if (collapsedText.trim().length === 0) {
      if (listMarkerPending) {
        return;
      }

      if (text.length > 0 && !/[\s]$/u.test(text)) {
        appendText(" ");
      }

      return;
    }

    appendText(collapsedText, literal);
  };

  const appendClipboardMention = (element: Element): boolean => {
    const payload = parsePromptMentionClipboardElement({ element });

    if (!payload) {
      return false;
    }

    flushListMarker();
    const start = text.length;
    appendText(payload.serializedText);
    mentions.push({
      start,
      end: text.length,
      resource: payload.resource,
    });
    hasMentions = true;

    return true;
  };

  const visitChildren = (
    node: Node,
    preserveWhitespace: boolean,
    literal = false,
  ) => {
    for (const childNode of node.childNodes) {
      visitNode(childNode, preserveWhitespace, literal);
    }
  };

  const visitNode = (
    node: Node,
    preserveWhitespace: boolean,
    literal: boolean,
  ) => {
    if (node.nodeType === Node.TEXT_NODE) {
      const rawText = node.textContent ?? "";

      if (preserveWhitespace) {
        appendText(normalizePastedPlainText(rawText), literal);

        return;
      }

      appendCollapsedText(rawText, literal);

      return;
    }

    if (!(node instanceof Element)) {
      visitChildren(node, preserveWhitespace, literal);

      return;
    }

    const tagName = node.tagName.toUpperCase();
    literal ||=
      tagName === "CODE" ||
      tagName === "BLOCKQUOTE" ||
      (tagName === "A" &&
        node.getAttribute("href") !== node.textContent?.trim());

    if (RICH_PASTE_IGNORED_TAGS.has(tagName)) {
      return;
    }

    if (appendClipboardMention(node)) {
      return;
    }

    if (tagName === "BR") {
      appendNewline();

      return;
    }

    if (tagName === "PRE") {
      appendNewline();
      appendText(normalizePastedPlainText(node.textContent ?? ""), true);
      appendNewline();

      return;
    }

    if (tagName === "LI") {
      appendNewline();
      listMarkerPending = true;
      visitChildren(node, preserveWhitespace, literal);
      listMarkerPending = false;
      appendNewline();

      return;
    }

    if (RICH_PASTE_BLOCK_TAGS.has(tagName)) {
      appendNewline();
      visitChildren(node, preserveWhitespace, literal);
      appendNewline();

      return;
    }

    visitChildren(node, preserveWhitespace, literal);
  };

  visitChildren(document.body, false);

  const threadLinks = findPastedThreadLinkCandidates({
    text,
    origins: appLinkOrigins(),
  }).map((link) => ({
    text: link.text,
    literal: literalRanges.some(
      (range) => range.from < link.to && range.to > link.from,
    ),
  }));

  if (hasMentions) {
    const trimmedText = text.replace(/\n+$/u, "");

    return {
      hasMentions,
      threadLinks,
      value: {
        text: trimmedText,
        mentions: mentions.filter(
          (mention) =>
            mention.start >= 0 &&
            mention.end > mention.start &&
            mention.end <= trimmedText.length,
        ),
      },
    };
  }

  return {
    hasMentions,
    threadLinks,
    value: {
      text: text
        .replace(/[ \t]+\n/gu, "\n")
        .replace(/\n{3,}/gu, "\n\n")
        .replace(/^\n+/u, "")
        .replace(/\n+$/u, ""),
      mentions: [],
    },
  };
}

function promptEditorValueFromClipboardPaste(
  clipboardData: DataTransfer | null,
  promptActions?: readonly PromptBoxAction[],
  richValue?: ParsedRichClipboardValue | null,
): PromptEditorValue | null {
  if (richValue?.hasMentions) {
    return withPromptActionCommandMentions(richValue.value, promptActions);
  }

  const plainText = clipboardData?.getData("text/plain") ?? "";

  if (plainText.length > 0) {
    return promptEditorValueFromPlainText(plainText, promptActions);
  }

  return richValue?.value ?? null;
}

function runAfterClipboardCut(callback: () => void): void {
  if (typeof queueMicrotask === "function") {
    queueMicrotask(callback);

    return;
  }

  setTimeout(callback, 0);
}

function revealPromptEditorSelection({
  editor,
  scrollContainer,
}: PromptEditorSelectionRevealArgs): void {
  const scrollContainerRect = scrollContainer.getBoundingClientRect();

  if (scrollContainerRect.height <= 0) return;

  let selectionRect: ReturnType<Editor["view"]["coordsAtPos"]>;

  try {
    selectionRect = editor.view.coordsAtPos(editor.state.selection.head);
  } catch {
    return;
  }

  const topOverflow =
    selectionRect.top -
    scrollContainerRect.top -
    PROMPTBOX_SELECTION_REVEAL_MARGIN;

  if (topOverflow < 0) {
    scrollContainer.scrollTop = Math.max(
      0,
      scrollContainer.scrollTop + topOverflow,
    );

    return;
  }

  const bottomOverflow =
    selectionRect.bottom -
    scrollContainerRect.bottom +
    PROMPTBOX_SELECTION_REVEAL_MARGIN;

  if (bottomOverflow > 0) {
    scrollContainer.scrollTop += bottomOverflow;
  }
}

function isPromptBoxChromeTarget(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;

  return target.closest(PROMPTBOX_INTERACTIVE_TARGET_SELECTOR) === null;
}

function promptActionTextImmediatelyBeforeCursor(
  editor: Editor,
  actionText: string,
): boolean {
  if (!editor.state.selection.empty) {
    return false;
  }

  const before = editor.state.doc.textBetween(
    0,
    editor.state.selection.from,
    "\n",
    "\n",
  );

  return before.endsWith(actionText);
}

function withLeadingCommand(
  value: { text: string; mentions: readonly PromptTextMention[] },
  command: PromptActionCommand,
): PromptEditorValue {
  const leadingCommand = value.mentions.find(
    (mention) => mention.resource.kind === "command" && mention.start === 0,
  );

  const rest = value.text.slice(leadingCommand?.end ?? 0).trimStart();
  const prefix = `${command.serializedText}${command.trailingText}`;
  const shift = prefix.length - (value.text.length - rest.length);

  return {
    text: `${prefix}${rest}`,
    mentions: [
      {
        start: 0,
        end: command.serializedText.length,
        resource: promptCommandResourceFromSuggestion({
          suggestion: command.suggestion,
          trigger: command.trigger,
        }),
      },
      ...value.mentions
        .filter((mention) => mention !== leadingCommand)
        .map((mention) => ({
          ...mention,
          start: mention.start + shift,
          end: mention.end + shift,
        })),
    ],
  };
}

function skillsTriggerInsertionRange(
  editor: Editor,
  action: PromptBoxAction,
  triggers: readonly TypeaheadTrigger[],
): PromptActionInsertionRange | null {
  const selection = editor.state.selection;

  if (!selection.empty) {
    return { from: selection.from, to: selection.to };
  }

  if (promptActionTextImmediatelyBeforeCursor(editor, action.text)) {
    return null;
  }

  const activeTrigger = findActiveTrigger(editor, triggers);

  if (
    activeTrigger !== null &&
    activeTrigger.kind === "command" &&
    activeTrigger.char === action.text &&
    activeTrigger.to === selection.from
  ) {
    return null;
  }

  return { from: selection.from, to: selection.to };
}

function promptActionCommandFromAction(
  action: PromptBoxAction,
): PromptActionCommand | null {
  if (action.kind === "skills" || !action.command) {
    return null;
  }

  const { trigger, name, trailingText } = action.command;
  const serializedText = `${trigger}${name}`;

  return {
    serializedText,
    trailingText,
    trigger,
    suggestion: {
      kind: "command",
      name,
      source: "command",
      origin: "user",
      description: null,
      argumentHint: null,
    },
  };
}

export function suppressPromptEditorAnchorActivation(event: Event): boolean {
  if (!(event.target instanceof Element)) return false;

  if (event.target.closest("a[href]") === null) return false;

  event.preventDefault();
  event.stopPropagation();

  return true;
}

function focusEditorAtEnd(editor: Editor): void {
  const transaction = editor.state.tr
    .setSelection(TextSelection.atEnd(editor.state.doc))
    .scrollIntoView();

  editor.view.dispatch(transaction);
  editor.view.focus();
}

const SAFARI_POST_COMPOSITION_KEYDOWN_WINDOW_MS = 500;

function isIPadOSWebKit(): boolean {
  if (typeof navigator === "undefined") return false;

  const isAppleWebKit =
    /Apple Computer/u.test(navigator.vendor) &&
    /\bAppleWebKit\//u.test(navigator.userAgent);

  const isIPad =
    navigator.platform === "iPad" ||
    (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 2);

  return isAppleWebKit && isIPad;
}

function usePostCompositionKeyDownEvents(): WeakSet<KeyboardEvent> {
  const ref = useRef<WeakSet<KeyboardEvent> | null>(null);
  ref.current ??= new WeakSet<KeyboardEvent>();

  return ref.current;
}

function isIPadHardwareEnterCandidate(event: KeyboardEvent): boolean {
  return (
    event.key === "Enter" &&
    (event.code === "Enter" || event.code === "NumpadEnter")
  );
}

export function PromptBoxInternal({
  id,
  value,
  mentionRanges,
  onChange,
  onSubmit: onDefaultSubmit,
  onEscape,
  blurOnPointerSubmit = false,
  placeholder = "Ask anything. @ to mention files, folders, or sections",
  autoFocus = true,
  yieldsExistingFocus,
  textEffects,
  onComposerLayoutChange,
  header,
  modeHeader,
  leading,
  plusMenu = "inline",
  chatMenu,
  footerStart,
  submitAccessory,
  submission = {},
  minHeight = PROMPTBOX_MIN_HEIGHT,
  typeahead,
  mentionMenuPlacement,
  attachments: attachmentConfig = {},
  promptActions,
  suppressPluginComposerCustomizations = false,
  onFocusCommand,
  editorLayout = "thread",
  onCollapse,
  compact,
  surface = "raised",
  containerCompactPlaceholder,
  heightAnimationKey,
  history,
  voice,
  promptBoxRef,
  focusEndKey,
}: PromptBoxInternalProps) {
  const focusComposerShortcut = useAppCommandShortcut("composer.focus");

  const {
    isSubmitting = false,
    disabled: submitDisabled = false,
    disabledReason: submitDisabledReason,
    label: submitLabel,
    icon: submitIcon,
    title: submitTitle = "Submit (Enter)",
    isRunning = false,
    onStop,
    onModifierSubmit: onDefaultModifierSubmit,
    swapSubmitActions = false,
    showModifierSubmitAction = false,
    menuActions,
  } = submission;

  const draftSubmitAction = { onSubmit: onDefaultSubmit, requiresInput: true };

  const immediateSubmitAction = {
    onSubmit: onDefaultModifierSubmit,
    requiresInput: false,
  };

  const [primarySubmitAction, modifierSubmitAction] = swapSubmitActions
    ? [immediateSubmitAction, draftSubmitAction]
    : [draftSubmitAction, immediateSubmitAction];

  const { onSubmit } = primarySubmitAction;
  const { onSubmit: onModifierSubmit } = modifierSubmitAction;

  const {
    triggers: mentionTriggerChars = DEFAULT_TYPEAHEAD_MENTION_TRIGGERS,
    results: mentionResults,
    isLoading: mentionLoading,
    isRefreshing: mentionRefreshing,
    isError: mentionError,
    onQueryChange: onMentionQueryChange,
    resolveLink: mentionResolveLink,
  } = typeahead.mention;

  const {
    triggers: commandTriggerChars,
    suggestions: commandSuggestions,
    isLoading: commandLoading,
    isUpdating: commandUpdating = false,
    isError: commandError,
    errorMessage: commandErrorMessage,
    onQueryChange: onCommandQueryChange,
  } = typeahead.command;

  const {
    items: attachments = [],
    pendingUploads,
    isAttaching = false,
    acceptWhileUploading = false,
    error: attachmentError = null,
    onAttachFiles,
    onUpdate: onUpdateAttachments,
    projectId: attachmentProjectId,
    targetHostId: attachmentTargetHostId = null,
  } = attachmentConfig;

  const { localHostId } = useHostDaemon();
  const attachmentTargetHostIdRef = useRef(attachmentTargetHostId);
  attachmentTargetHostIdRef.current = attachmentTargetHostId;
  const localAttachmentHostIdRef = useRef(localHostId);
  localAttachmentHostIdRef.current = localHostId;
  const nativeFilePathsRef = useRef(new WeakMap<File, string | null>());
  const openAttachment = useAttachmentOpener();

  const resolveEditorMentionLink: PromptMentionLinkResolver = (resource) => {
    if (resource.kind !== "attachment") {
      return mentionResolveLink?.(resource) ?? null;
    }

    const attachment = attachments.find((item) => item.path === resource.path);
    const projectId = attachment?.sourceProjectId ?? attachmentProjectId;

    if (
      !attachment ||
      !openAttachment ||
      !projectId ||
      !isProjectAttachmentPath(attachment)
    ) {
      return null;
    }

    return () =>
      openAttachment({
        name: attachment.name,
        path: attachment.path,
        projectId,
      });
  };

  const isPointerCoarse = usePointerCoarse();
  const isIPadOSWebKitDevice = useMemo(isIPadOSWebKit, []);
  const editorEnterKeyHint = isPointerCoarse ? "enter" : "send";
  const formRef = useRef<HTMLFormElement>(null);
  const typeaheadMenuRef = useRef<HTMLDivElement>(null);

  const reportQueuedEditorTypeaheadLayout = useContext(
    QueuedEditorTypeaheadLayoutContext,
  );

  const blurAfterPointerSubmitRef = useRef(false);
  const heightAnimationFromRef = useRef<number | null>(null);

  const capturePromptBoxHeight = useCallback(() => {
    const formElement = formRef.current;
    heightAnimationFromRef.current =
      formElement?.getBoundingClientRect().height ?? null;
  }, []);

  useLayoutEffect(() => {
    const formElement = formRef.current;

    if (!formElement) return;

    if (containerCompactPlaceholder === undefined) {
      formElement.style.removeProperty(
        "--promptbox-container-compact-placeholder",
      );

      return;
    }

    formElement.style.setProperty(
      "--promptbox-container-compact-placeholder",
      JSON.stringify(containerCompactPlaceholder),
    );
  }, [containerCompactPlaceholder]);
  const editorRef = useRef<Editor | null>(null);

  const nativePasteFormattingRef = useRef(
    new WeakMap<ClipboardEvent, boolean>(),
  );

  const nativeFilesPendingRef = useRef(false);
  const pasteWithoutFormattingRef = useRef(false);
  const threadTitleResources = useThreadTitleMentionResources();
  const queryClient = useContext(QueryClientContext);
  const threadLinkCacheRef = useRef({ threadTitleResources, queryClient });
  threadLinkCacheRef.current = { threadTitleResources, queryClient };
  const editorScrollContainerRef = useRef<HTMLDivElement>(null);
  const revealSelectionFrameRef = useRef<number | null>(null);
  const promptActionFocusFrameRef = useRef<number | null>(null);
  const pendingFocusEndRef = useRef(false);
  const attachmentInputRef = useRef<HTMLInputElement>(null);
  const valueRef = useRef(value);
  const mentionRangesRef = useRef<readonly PromptTextMention[]>(mentionRanges);
  const placeholderRef = useRef(placeholder);
  const skipEditorChangeRef = useRef(false);
  const lastSyncedEditorValueRef = useRef<PromptEditorValueKey | null>(null);
  const lastSyncedEditorRef = useRef<Editor | null>(null);
  const triggerKeyRef = useRef("");

  const handleEditorKeyDownRef = useRef<
    (event: KeyboardEvent, isOriginalIPadHardwareEnter?: boolean) => boolean
  >(() => false);

  const compositionEndedAtRef = useRef(Number.NEGATIVE_INFINITY);
  const postCompositionKeyDownEvents = usePostCompositionKeyDownEvents();
  const dispatchAppCommandKey = useAppCommandKeyDispatch();
  const syncTriggerStateRef = useRef<(editor: Editor) => void>(() => {});
  const onAttachFilesRef = useRef(onAttachFiles);
  const attachmentNamesRef = useRef<ReadonlySet<string>>(new Set());
  const attachmentItemsRef = useRef<PromptDraftAttachment[]>([]);
  const onUpdateAttachmentsRef = useRef(onUpdateAttachments);
  const attachmentDraftKeyRef = useRef<string | null>(null);

  const attachmentHistoryRef = useRef(
    new Map<string, AttachmentHistoryEntry>(),
  );

  const imageAliasHighWaterRef = useRef(
    history?.currentDraft.imageAliasHighWater ?? 0,
  );

  imageAliasHighWaterRef.current =
    history?.currentDraft.imageAliasHighWater ?? 0;

  const pendingImageAnchorsRef = useRef(settledPendingImageAnchors);

  const [activeImageKey, setActiveImageKey] = useState<string | null>(null);

  const setAttachmentPresenceRef = useRef<
    (id: string, present: boolean) => void
  >(() => {});

  const attachFilesWithHistoryRef = useRef<
    (
      files: File[],
      recordHistory?: (id: string, editor: Editor) => void,
      anchorPosition?: number,
    ) => void
  >(() => {});

  const dismissedTriggerRef = useRef<DismissedTriggerRange | null>(null);
  const isRestoringAppliedMentionRef = useRef(false);

  const [composerMenu, setComposerMenuState] =
    useState<ComposerMenuState>(null);

  const composerMenuRef = useRef<ComposerMenuState>(null);

  const setComposerMenu = useCallback((next: ComposerMenuState) => {
    composerMenuRef.current = next;
    setComposerMenuState(next);
  }, []);

  const activeTrigger =
    composerMenu?.kind === "suggestions" ? composerMenu.trigger : null;

  const [selectedSuggestionKey, setSelectedSuggestionKey] = useState<
    string | null
  >(null);

  const [expandedImageIndex, setExpandedImageIndex] = useState<number | null>(
    null,
  );

  const [activeHistoryIndex, setActiveHistoryIndex] = useState<number | null>(
    null,
  );

  const [temporaryHistoryDraft, setTemporaryHistoryDraft] =
    useState<PromptDraftState | null>(null);

  const [recalledHistoryDraft, setRecalledHistoryDraft] =
    useState<PromptDraftState | null>(null);

  const hasActiveHistorySessionRef = useRef(false);
  const isVoiceStarting = voice?.state === "starting";
  const isVoiceRecording = voice?.state === "recording";
  const isVoiceProcessing = voice?.state === "transcribing";

  const showVoiceActionGroup =
    isVoiceStarting || isVoiceRecording || isVoiceProcessing;

  const voiceActionState = isVoiceStarting
    ? "starting"
    : isVoiceRecording
      ? "recording"
      : isVoiceProcessing
        ? "transcribing"
        : null;

  const lastVoiceActionStateRef = useRef<
    "starting" | "recording" | "transcribing"
  >(voiceActionState ?? "recording");

  const renderedVoiceActionState =
    voiceActionState ?? lastVoiceActionStateRef.current;

  useLayoutEffect(() => {
    if (voiceActionState !== null) {
      lastVoiceActionStateRef.current = voiceActionState;
    }
  }, [voiceActionState]);

  const [isVoiceActionPresent, setIsVoiceActionPresent] =
    useState(showVoiceActionGroup);

  const [voiceActionTransition, setVoiceActionTransition] =
    useState<VoiceActionTransition>(
      showVoiceActionGroup ? "active" : "exiting",
    );

  const isVoiceActionVisible = voiceActionTransition === "active";
  const wasVoiceActionShownRef = useRef(showVoiceActionGroup);
  const voiceActionRevealFrameRef = useRef<number | null>(null);
  const voiceActionRemovalTimeoutRef = useRef<number | null>(null);
  const voiceCompletionTimeoutRef = useRef<number | null>(null);
  const voiceCompletionPromiseRef = useRef<Promise<void> | null>(null);
  const voiceCompletionResolveRef = useRef<(() => void) | null>(null);

  useLayoutEffect(() => {
    const wasVoiceActionShown = wasVoiceActionShownRef.current;
    wasVoiceActionShownRef.current = showVoiceActionGroup;

    if (voiceActionRevealFrameRef.current !== null) {
      window.cancelAnimationFrame(voiceActionRevealFrameRef.current);
      voiceActionRevealFrameRef.current = null;
    }

    if (voiceActionRemovalTimeoutRef.current !== null) {
      window.clearTimeout(voiceActionRemovalTimeoutRef.current);
      voiceActionRemovalTimeoutRef.current = null;
    }

    if (showVoiceActionGroup) {
      setIsVoiceActionPresent(true);

      if (wasVoiceActionShown || prefersReducedMotion()) {
        setVoiceActionTransition("active");

        return;
      }

      setVoiceActionTransition("entering");
      voiceActionRevealFrameRef.current = window.requestAnimationFrame(() => {
        voiceActionRevealFrameRef.current = null;
        setVoiceActionTransition("active");
      });

      return;
    }

    setVoiceActionTransition("exiting");

    if (!wasVoiceActionShown) {
      setIsVoiceActionPresent(false);

      return;
    }

    if (prefersReducedMotion()) {
      setIsVoiceActionPresent(false);

      return;
    }

    voiceActionRemovalTimeoutRef.current = window.setTimeout(() => {
      voiceActionRemovalTimeoutRef.current = null;
      setIsVoiceActionPresent(false);
    }, VOICE_ACTION_EXIT_MS);
  }, [showVoiceActionGroup]);

  useEffect(
    () => () => {
      if (voiceActionRevealFrameRef.current !== null) {
        window.cancelAnimationFrame(voiceActionRevealFrameRef.current);
      }

      if (voiceActionRemovalTimeoutRef.current !== null) {
        window.clearTimeout(voiceActionRemovalTimeoutRef.current);
      }

      if (voiceCompletionTimeoutRef.current !== null) {
        window.clearTimeout(voiceCompletionTimeoutRef.current);
      }

      voiceCompletionResolveRef.current?.();
    },
    [],
  );

  const playVoiceCompletionTransition = useCallback((): Promise<void> => {
    if (voiceActionRevealFrameRef.current !== null) {
      window.cancelAnimationFrame(voiceActionRevealFrameRef.current);
      voiceActionRevealFrameRef.current = null;
    }

    setVoiceActionTransition("exiting");

    if (shouldFinishVoiceCompletionTransitionImmediately()) {
      if (voiceCompletionTimeoutRef.current !== null) {
        window.clearTimeout(voiceCompletionTimeoutRef.current);
        voiceCompletionTimeoutRef.current = null;
      }

      const resolvePendingTransition = voiceCompletionResolveRef.current;
      voiceCompletionPromiseRef.current = null;
      voiceCompletionResolveRef.current = null;
      resolvePendingTransition?.();

      return Promise.resolve();
    }

    if (voiceCompletionPromiseRef.current) {
      return voiceCompletionPromiseRef.current;
    }

    const transition = new Promise<void>((resolve) => {
      voiceCompletionResolveRef.current = resolve;
      voiceCompletionTimeoutRef.current = window.setTimeout(() => {
        voiceCompletionTimeoutRef.current = null;
        voiceCompletionPromiseRef.current = null;
        voiceCompletionResolveRef.current = null;
        resolve();
      }, VOICE_ACTION_EXIT_MS);
    });

    voiceCompletionPromiseRef.current = transition;

    return transition;
  }, []);

  const showCompactLayout =
    compact?.isCompact === true &&
    (!showVoiceActionGroup ||
      (value.trim().length === 0 &&
        attachments.length === 0 &&
        !pendingUploads?.length));

  const effectivePlaceholder = showCompactLayout
    ? (compact.placeholder ?? placeholder)
    : placeholder;

  const pluginComposerHost = usePluginComposerHost();

  const composerInputLocked = useComposerInputLock(
    pluginComposerHost?.textEffectKey ?? null,
  );

  const suggestionKey = pluginComposerHost?.textEffectKey ?? null;
  const suggestion = useComposerSuggestion(suggestionKey);
  const isCompactViewport = useIsCompactViewport();
  const suggestionCardMode = isCompactViewport || showCompactLayout;

  const [suggestionEngagedKey, setSuggestionEngagedKey] = useState<
    string | null
  >(null);

  const suggestionEngagedKeyRef = useRef(suggestionEngagedKey);
  suggestionEngagedKeyRef.current = suggestionEngagedKey;

  const suggestionEngaged =
    suggestionKey !== null && suggestionEngagedKey === suggestionKey;

  const [sentSuggestion, setSentSuggestion] = useState<{
    key: string;
    text: string;
  } | null>(null);

  const suggestionSent =
    sentSuggestion !== null &&
    sentSuggestion.key === suggestionKey &&
    suggestion?.status === "ready" &&
    suggestion.text === sentSuggestion.text;

  if (sentSuggestion !== null && !suggestionSent) setSentSuggestion(null);

  const suggestionAvailable =
    suggestion !== null &&
    !suggestionSent &&
    value === "" &&
    attachments.length === 0 &&
    !pendingUploads?.length &&
    !composerInputLocked &&
    !showVoiceActionGroup;

  const suggestionShown = suggestionAvailable && !suggestionEngaged;

  const readySuggestion =
    suggestionAvailable && suggestion.status === "ready" ? suggestion : null;

  const suggestionVisible = suggestionCardMode
    ? suggestionAvailable
    : suggestionShown || (suggestionEngaged && readySuggestion !== null);

  const suggestionOverlayShown = !suggestionCardMode && suggestionVisible;

  const focusScopeKey = history?.resetKey;

  const [suggestionReveal, setSuggestionReveal] = useState({
    scopeKey: focusScopeKey,
    suggestionKey,
    shown: suggestionVisible,
    animate: false,
  });

  if (
    suggestionReveal.scopeKey !== focusScopeKey ||
    suggestionReveal.suggestionKey !== suggestionKey
  ) {
    setSuggestionReveal({
      scopeKey: focusScopeKey,
      suggestionKey,
      shown: suggestionVisible,
      animate: false,
    });
  } else if (suggestionReveal.shown !== suggestionVisible) {
    setSuggestionReveal({
      scopeKey: focusScopeKey,
      suggestionKey,
      shown: suggestionVisible,
      animate: suggestionVisible,
    });
  }

  const engageSuggestion = useCallback(() => {
    setSuggestionEngagedKey(suggestionKey);
  }, [suggestionKey]);

  useEffect(() => {
    if (value !== "" && suggestionEngagedKeyRef.current !== suggestionKey)
      setSuggestionEngagedKey(suggestionKey);
  }, [suggestionKey, value]);

  const handleEditorScrollPointerDown = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      if (
        event.target instanceof Element &&
        event.target.closest(COMPOSER_SUGGESTION_ACTION_SELECTOR) !== null
      )
        return;
      engageSuggestion();
    },
    [engageSuggestion],
  );

  const insertSuggestion = useCallback(() => {
    if (readySuggestion === null || pluginComposerHost === null) return;
    engageSuggestion();
    const actions = createCoreComposerActions(pluginComposerHost);
    actions.replace({ text: readySuggestion.text, mentions: [] });
    actions.focus();
  }, [engageSuggestion, pluginComposerHost, readySuggestion]);

  const composerLayout = showCompactLayout ? "compact" : "expanded";

  const localComposerView = usePluginComposerViewModel({
    scope: pluginComposerHost?.scope ?? DEFAULT_COMPOSER_SCOPE,
    layout: composerLayout,
    text: value,
    attachmentCount: attachments.length,
    isRunning,
    isSubmitting,
  });

  const composerView = useOptionalPluginComposerView() ?? localComposerView;
  const composerViewRef = useRef(composerView);
  composerViewRef.current = composerView;
  const composerScopeKey = composerScopeIdentity(composerView.scope);

  const resolvedComposerEditor = useResolvedComposerEditor(
    suppressPluginComposerCustomizations ? null : composerView.scope.kind,
  );

  useEffect(() => {
    onComposerLayoutChange?.(composerLayout);
  }, [composerLayout, onComposerLayoutChange]);

  const pluginRichTextContributions = useMemo(() => {
    const sources: PromptDecorationSource[] = [];
    const observers: PromptDraftObserver[] = [];

    for (const contribution of resolvedComposerEditor.effects) {
      sources.push({
        id: `${contribution.pluginId}/${contribution.customizationId}`,
        generation: contribution.generation,
        pluginId: contribution.pluginId,
        effects: contribution.effects,
      });
    }

    for (const contribution of resolvedComposerEditor.observers) {
      observers.push({
        id: `${contribution.pluginId}/${contribution.customizationId}`,
        getView: () => composerViewRef.current,
        onDraftChange: contribution.onDraftChange,
      });
    }

    for (const effectSource of textEffects ?? []) {
      const className = effectSource.effect.className;

      if (className.length === 0) continue;
      sources.push({
        id: `plugin-imperative:${effectSource.pluginId}:${effectSource.order}`,
        generation: effectSource.order,
        pluginId: effectSource.pluginId,
        effects: [
          {
            id: "whole-draft",
            className,
            match: (text) =>
              text.length === 0 ? [] : [{ from: 0, to: text.length }],
          },
        ],
      });
    }

    return { sources, observers };
  }, [resolvedComposerEditor, textEffects]);

  const pluginDecorationSourcesRef = useRef(
    pluginRichTextContributions.sources,
  );

  pluginDecorationSourcesRef.current = pluginRichTextContributions.sources;
  const pluginDraftObserversRef = useRef(pluginRichTextContributions.observers);
  pluginDraftObserversRef.current = pluginRichTextContributions.observers;
  const onChangeRef = useRef(onChange);

  useEffect(() => {
    onChangeRef.current = onChange;
  }, [onChange]);

  useEffect(() => {
    onAttachFilesRef.current = onAttachFiles;
  }, [onAttachFiles]);

  useEffect(() => {
    attachmentItemsRef.current = attachments;
    attachmentNamesRef.current = new Set([
      ...attachments.map((attachment) => attachment.name),
      ...(pendingUploads ?? []).map((upload) => upload.file.name),
    ]);
  }, [attachments, pendingUploads]);

  useEffect(() => {
    onUpdateAttachmentsRef.current = onUpdateAttachments;
  }, [onUpdateAttachments]);

  useEffect(() => {
    attachmentDraftKeyRef.current = pluginComposerHost?.textEffectKey ?? null;
  }, [pluginComposerHost?.textEffectKey]);

  const removeHistoryAttachments = useCallback(
    (entry: AttachmentHistoryEntry, attachments: PromptDraftAttachment[]) => {
      const update = onUpdateAttachmentsRef.current;

      if (!update || attachments.length === 0) return;
      entry.positions = attachments.map((attachment) =>
        attachmentItemsRef.current.findIndex((item) =>
          isSamePromptDraftAttachment(item, attachment),
        ),
      );
      update((current) =>
        current.filter(
          (item) =>
            !attachments.some((attachment) =>
              isSamePromptDraftAttachment(item, attachment),
            ),
        ),
      );
    },
    [],
  );

  const restoreHistoryAttachments = useCallback(
    (entry: AttachmentHistoryEntry, attachments: PromptDraftAttachment[]) => {
      const update = onUpdateAttachmentsRef.current;

      if (!update || attachments.length === 0) return;

      const restored = attachments
        .map((attachment, index) => ({
          attachment,
          position: entry.positions[index] ?? -1,
        }))
        .sort((left, right) => left.position - right.position);

      update((current) => {
        const next = current.filter(
          (item) =>
            !restored.some(({ attachment }) =>
              isSamePromptDraftAttachment(attachment, item),
            ),
        );

        for (const { attachment, position } of restored) {
          next.splice(
            position < 0 ? next.length : Math.min(position, next.length),
            0,
            attachment,
          );
        }

        return next;
      });
    },
    [],
  );

  const setAttachmentPresence = useCallback(
    (id: string, present: boolean) => {
      const entry = attachmentHistoryRef.current.get(id);

      if (
        !entry ||
        entry.present === present ||
        entry.draftKey !== attachmentDraftKeyRef.current
      )
        return;
      entry.present = present;

      if (entry.attachments === null) return;

      if (present) restoreHistoryAttachments(entry, entry.attachments);
      else removeHistoryAttachments(entry, entry.attachments);
    },
    [removeHistoryAttachments, restoreHistoryAttachments],
  );

  const attachFilesWithHistory = useCallback(
    (
      files: File[],
      recordHistory?: (id: string, editor: Editor) => void,
      anchorPosition?: number,
    ) => {
      const attach = onAttachFilesRef.current;

      if (!attach || files.length === 0) return;
      const id = nanoid();
      const currentEditor = editorRef.current;

      const canAnchor =
        !recordHistory &&
        currentEditor !== null &&
        !currentEditor.isDestroyed &&
        onUpdateAttachmentsRef.current !== undefined;

      const anchors: (PromptImageAnchorRef | null)[] = files.map(() => null);

      if (canAnchor) {
        const reserved = reservedImageAliases(attachmentHistoryRef.current);
        const text = promptEditorValueFromDoc(currentEditor.state.doc).text;

        files.forEach((file, index) => {
          if (!file.type.startsWith("image/")) return;

          const label = nextPromptImageAlias({
            text,
            attachments: attachmentItemsRef.current,
            highWater: imageAliasHighWaterRef.current,
            reservedAliases: reserved,
          });

          reserved.push(label);
          anchors[index] = { label, path: pendingImageAnchorPath(id, index) };
        });
      }

      const entry: AttachmentHistoryEntry = {
        attachments: null,
        aliases: anchors.flatMap((anchor) => (anchor ? [anchor.label] : [])),
        draftKey: attachmentDraftKeyRef.current,
        positions: [],
        present: true,
      };

      attachmentHistoryRef.current.set(id, entry);

      if (anchors.some(Boolean)) livePendingImageBatches.add(id);

      if (currentEditor && !currentEditor.isDestroyed) {
        const placed = anchors.flatMap((anchor) => (anchor ? [anchor] : []));

        if (recordHistory) recordHistory(id, currentEditor);
        else if (placed.length > 0)
          recordImageAnchorHistory(currentEditor, id, placed, anchorPosition);
        else recordAttachmentHistory(currentEditor.view, id, true);
      }

      const settleAnchors = (
        settled: readonly {
          index: number;
          attachment: PromptDraftAttachment;
        }[],
        finished: boolean,
      ) => {
        for (const { index, attachment } of settled) {
          const anchor = anchors[index];

          if (!anchor) continue;
          pendingImageAnchorsRef.current.set(anchor.path, {
            label: anchor.label,
            path: attachment.path,
          });

          const removals = [...attachmentHistoryRef.current.values()].filter(
            (candidate) => candidate.pendingPath === anchor.path,
          );

          for (const removal of removals) removal.attachments = [attachment];
          const latest = removals.at(-1);

          if (latest && !latest.present)
            removeHistoryAttachments(latest, [attachment]);
        }

        if (finished)
          anchors.forEach((anchor) => {
            if (anchor && !pendingImageAnchorsRef.current.has(anchor.path))
              pendingImageAnchorsRef.current.set(anchor.path, "failed");
          });

        if (finished) livePendingImageBatches.delete(id);

        for (const listener of pendingImageAnchorListeners) listener();
      };

      const targetHostId = attachmentTargetHostIdRef.current;
      const nativeHostId = localAttachmentHostIdRef.current;

      const addFiles = async () => {
        const resolver = getNativeFileResolver();

        if (
          resolver !== null &&
          files.some((file) => !nativeFilePathsRef.current.has(file))
        ) {
          const resolved = partitionNativeFiles(
            files,
            await resolver.resolve(files),
          );

          for (const file of resolved.files)
            nativeFilePathsRef.current.set(
              file,
              resolved.paths.get(file) ?? null,
            );
        }

        if (
          entry.draftKey !== attachmentDraftKeyRef.current ||
          targetHostId !== attachmentTargetHostIdRef.current ||
          nativeHostId !== localAttachmentHostIdRef.current
        ) {
          appToast.error("The draft changed. Attach the files again.");
          settleAnchors([], true);

          return [];
        }

        const named = withUniqueAttachmentNames(
          files,
          attachmentNamesRef.current,
        );

        const local: PromptDraftAttachment[] = [];
        const localIndexes: number[] = [];
        const uploads: File[] = [];
        const uploadIndexes: number[] = [];
        files.forEach((file, index) => {
          const path = nativeFilePathsRef.current.get(file);

          if (
            path &&
            targetHostId !== null &&
            targetHostId === nativeHostId &&
            onUpdateAttachmentsRef.current
          ) {
            const alias = anchors[index]?.label;

            const attachment: PromptDraftAttachment = {
              type: file.type.startsWith("image/") ? "localImage" : "localFile",
              path,
              hostId: targetHostId,
              name: named[index]!.name,
              sizeBytes: file.size,
              mimeType: file.type || undefined,
              ...(alias === undefined ? {} : { alias }),
            };

            if (attachment.type === "localImage")
              registerLocalAttachmentPreview(path, file);
            local.push(attachment);
            localIndexes.push(index);
          } else {
            const anchor = anchors[index];
            noteAttachmentNativePath(named[index]!, Boolean(path));

            if (anchor)
              registerPendingImageAnchorFile(named[index]!, anchor.path);
            uploads.push(named[index]!);
            uploadIndexes.push(index);
          }
        });
        entry.attachments = local;

        if (local.length > 0 && entry.present)
          onUpdateAttachmentsRef.current?.((current) => [...current, ...local]);
        settleAnchors(
          local.map((attachment, position) => ({
            index: localIndexes[position]!,
            attachment,
          })),
          uploads.length === 0,
        );

        if (uploads.length === 0) return local;
        const uploaded = await attach(uploads);

        const settled = uploaded.flatMap((attachment) => {
          const source = uploadedAttachmentSource(attachment);

          const index =
            source === null
              ? undefined
              : uploadIndexes[uploads.indexOf(source)];

          return index === undefined ? [] : [{ index, attachment }];
        });

        if (
          anchors.some(Boolean) &&
          uploaded.some(
            (attachment) =>
              !settled.some((item) => item.attachment === attachment),
          )
        )
          appToast.error(
            "An uploaded image could not be matched to its label. Add it again.",
          );

        const aliased = uploaded.map((attachment) => {
          const index = settled.find(
            (item) => item.attachment === attachment,
          )?.index;

          const alias = index === undefined ? undefined : anchors[index]?.label;

          return alias === undefined || attachment.type !== "localImage"
            ? attachment
            : { ...attachment, alias };
        });

        if (aliased.some((attachment, index) => attachment !== uploaded[index]))
          onUpdateAttachmentsRef.current?.((current) =>
            current.map((item) => {
              const match = uploaded.findIndex((attachment) =>
                isSamePromptDraftAttachment(item, attachment),
              );

              return match < 0 ? item : aliased[match]!;
            }),
          );

        settleAnchors(
          settled.map(({ index, attachment }) => ({
            index,
            attachment: aliased[uploaded.indexOf(attachment)] ?? attachment,
          })),
          true,
        );

        return [...local, ...aliased];
      };

      void addFiles()
        .then((added) => {
          entry.attachments = added;

          if (!entry.present) removeHistoryAttachments(entry, added);
        })
        .catch(() => {
          settleAnchors([], true);
          appToast.error("The files could not be attached. Try again.");
        });
    },
    [removeHistoryAttachments],
  );

  const removeAttachment = useCallback(
    (target: PromptDraftAttachment) => {
      const items = attachmentItemsRef.current;

      const attachment = items.find((item) =>
        isSamePromptDraftAttachment(item, target),
      );

      if (!attachment) return;
      const id = nanoid();

      const entry: AttachmentHistoryEntry = {
        attachments: [attachment],
        aliases: [],
        draftKey: attachmentDraftKeyRef.current,
        positions: [],
        present: false,
      };

      attachmentHistoryRef.current.set(id, entry);
      removeHistoryAttachments(entry, [attachment]);
      const currentEditor = editorRef.current;

      if (!currentEditor || currentEditor.isDestroyed) return;
      const { view } = currentEditor;
      const tr = closeHistory(view.state.tr);

      for (const { pos, node, anchor } of collectPromptImageAnchors(
        tr.doc,
      ).reverse()) {
        const binding = resolvePromptImageAnchor(items, anchor);

        if (
          binding.status === "bound" &&
          isSamePromptDraftAttachment(binding.attachment, attachment)
        )
          tr.delete(pos, pos + node.nodeSize);
      }

      tr.step(new AttachmentHistoryStep(id, false));
      view.dispatch(markPromptImageAnchorSync(tr));
      view.dispatch(closeHistory(view.state.tr));
    },
    [removeHistoryAttachments],
  );

  const imageAnchorHandlersRef = useRef<PromptImageAnchorSyncHandlers>({
    resolvePending: () => null,
    onAnchorsRemoved: () => [],
    onAnchorsAdded: () => [],
  });

  imageAnchorHandlersRef.current = {
    resolvePending: (path) => {
      const settled = pendingImageAnchorsRef.current.get(path);

      if (settled !== undefined) return settled;
      const batch = pendingImageAnchorBatch(path);

      return batch !== null && livePendingImageBatches.has(batch)
        ? null
        : "failed";
    },
    onAnchorsRemoved: (anchors) => {
      if (skipEditorChangeRef.current || !onUpdateAttachmentsRef.current)
        return [];

      return anchors.flatMap((anchor) => {
        if (isPendingImageAnchorPath(anchor.path)) {
          const id = nanoid();
          attachmentHistoryRef.current.set(id, {
            attachments: null,
            aliases: [anchor.label],
            pendingPath: anchor.path,
            draftKey: attachmentDraftKeyRef.current,
            positions: [],
            present: true,
          });

          return [id];
        }

        const binding = resolvePromptImageAnchor(
          attachmentItemsRef.current,
          anchor,
        );

        if (binding.status !== "bound") return [];
        const id = nanoid();
        attachmentHistoryRef.current.set(id, {
          attachments: [binding.attachment],
          aliases: [],
          draftKey: attachmentDraftKeyRef.current,
          positions: [],
          present: true,
        });

        return [id];
      });
    },
    onAnchorsAdded: (anchors) => {
      if (skipEditorChangeRef.current || !onUpdateAttachmentsRef.current)
        return [];

      return anchors.flatMap((anchor) => {
        if (isPendingImageAnchorPath(anchor.path)) {
          const latest = [...attachmentHistoryRef.current.values()]
            .filter((entry) => entry.pendingPath === anchor.path)
            .at(-1);

          if (!latest || latest.present) return [];
          const id = nanoid();
          attachmentHistoryRef.current.set(id, {
            ...latest,
            positions: [],
            present: false,
          });

          return [id];
        }

        if (
          resolvePromptImageAnchor(attachmentItemsRef.current, anchor)
            .status !== "missing"
        )
          return [];

        const removed = [...attachmentHistoryRef.current.values()]
          .filter(
            (entry) =>
              !entry.present &&
              entry.draftKey === attachmentDraftKeyRef.current,
          )
          .flatMap((entry) => entry.attachments ?? [])
          .find(
            (attachment) =>
              attachment.type === "localImage" &&
              attachment.alias === anchor.label &&
              attachment.path === anchor.path,
          );

        if (!removed) return [];
        const id = nanoid();
        attachmentHistoryRef.current.set(id, {
          attachments: [removed],
          aliases: [],
          draftKey: attachmentDraftKeyRef.current,
          positions: [],
          present: false,
        });

        return [id];
      });
    },
  };

  const insertImageAnchorAtPoint = useCallback(
    (key: string, left: number, top: number) => {
      const currentEditor = editorRef.current;

      const attachment = attachmentItemsRef.current.find(
        (item) =>
          item.type === "localImage" &&
          item.alias !== undefined &&
          promptAttachmentKey(item) === key,
      );

      if (!currentEditor || currentEditor.isDestroyed || !attachment?.alias)
        return false;
      const position = currentEditor.view.posAtCoords({ left, top })?.pos;

      if (position === undefined) return false;

      currentEditor
        .chain()
        .focus()
        .setTextSelection(position)
        .insertContent([
          promptImageAnchorContent({
            label: attachment.alias,
            path: attachment.path,
          }),
          { type: "text", text: " " },
        ])
        .run();

      return true;
    },
    [],
  );

  useEffect(() => {
    const resolvePendingAnchors = () => {
      const editor = editorRef.current;

      if (editor && !editor.isDestroyed)
        editor.view.dispatch(markPromptImageAnchorSync(editor.state.tr));
    };

    pendingImageAnchorListeners.add(resolvePendingAnchors);

    return () => {
      pendingImageAnchorListeners.delete(resolvePendingAnchors);
    };
  }, []);

  const insertImageAnchorAtPointRef = useRef(insertImageAnchorAtPoint);
  insertImageAnchorAtPointRef.current = insertImageAnchorAtPoint;

  useEffect(() => {
    setAttachmentPresenceRef.current = setAttachmentPresence;
    attachFilesWithHistoryRef.current = attachFilesWithHistory;
  }, [attachFilesWithHistory, setAttachmentPresence]);

  const revealEditorSelection = useCallback(() => {
    const currentEditor = editorRef.current;
    const scrollContainer = editorScrollContainerRef.current;

    if (!currentEditor || currentEditor.isDestroyed || !scrollContainer) return;

    revealPromptEditorSelection({
      editor: currentEditor,
      scrollContainer,
    });
  }, []);

  const scheduleRevealEditorSelection = useCallback(() => {
    if (typeof requestAnimationFrame !== "function") {
      revealEditorSelection();

      return;
    }

    if (revealSelectionFrameRef.current !== null) {
      cancelAnimationFrame(revealSelectionFrameRef.current);
    }

    revealSelectionFrameRef.current = requestAnimationFrame(() => {
      revealSelectionFrameRef.current = null;
      revealEditorSelection();
    });
  }, [revealEditorSelection]);

  useEffect(() => {
    return () => {
      if (revealSelectionFrameRef.current === null) return;
      cancelAnimationFrame(revealSelectionFrameRef.current);
    };
  }, []);

  useEffect(() => {
    return () => {
      if (promptActionFocusFrameRef.current === null) return;
      cancelAnimationFrame(promptActionFocusFrameRef.current);
    };
  }, []);

  const triggers = useMemo<TypeaheadTrigger[]>(() => {
    const mentionTriggers = mentionTriggerChars.map((char) => ({
      char,
      kind: "mention" as const,
    }));

    if (commandTriggerChars.length === 0) {
      return mentionTriggers;
    }

    return [
      ...mentionTriggers,
      ...commandTriggerChars.map((char) => ({
        char,
        kind: "command" as const,
      })),
    ];
  }, [commandTriggerChars, mentionTriggerChars]);

  const dispatchTriggerQuery = useCallback(
    (active: ActiveTrigger | null) => {
      if (active?.kind === "mention") {
        onMentionQueryChange(active.query, active.char);
        onCommandQueryChange(null, null);

        return;
      }

      if (active?.kind === "command") {
        onCommandQueryChange(active.query, active.char);
        onMentionQueryChange(null, null);

        return;
      }

      onMentionQueryChange(null, null);
      onCommandQueryChange(null, null);
    },
    [onCommandQueryChange, onMentionQueryChange],
  );

  const dismissComposerMenu = useCallback(
    (restoreFocus = false) => {
      const current = composerMenuRef.current;
      triggerKeyRef.current = "";

      if (current?.kind === "suggestions") {
        dismissedTriggerRef.current = {
          start: current.trigger.from,
          end: current.trigger.to,
          hasLeftRange: false,
          reopenBeforeOffset: null,
        };
      }

      setComposerMenu(
        current?.kind === "plugin" ? { ...current, open: false } : null,
      );
      dispatchTriggerQuery(null);
      const currentEditor = editorRef.current;

      if (
        restoreFocus &&
        currentEditor &&
        !currentEditor.isDestroyed &&
        !currentEditor.isFocused
      )
        currentEditor.commands.focus();
    },
    [dispatchTriggerQuery, setComposerMenu],
  );

  const dismissUnmatchedMention = useCallback(() => {
    const current = composerMenuRef.current;

    if (current?.kind !== "suggestions") return;
    triggerKeyRef.current = "";
    dismissedTriggerRef.current = {
      start: current.trigger.from,
      end: current.trigger.to,
      hasLeftRange: false,
      reopenBeforeOffset: current.trigger.to - current.trigger.from,
    };
    setComposerMenu(null);
    dispatchTriggerQuery(null);
  }, [dispatchTriggerQuery, setComposerMenu]);

  const syncTriggerState = useCallback(
    (editor: Editor) => {
      if (
        composerMenuRef.current?.kind === "plugin" &&
        composerMenuRef.current.open
      )
        return;
      const caretPosition = editor.state.selection.from;
      let dismissedTrigger = dismissedTriggerRef.current;

      const isRestoringAppliedMention =
        isRestoringAppliedMentionRef.current && dismissedTrigger !== null;

      const detectedTrigger = findActiveTrigger(editor, triggers);

      const reopensUnmatchedTrigger =
        dismissedTrigger !== null &&
        !isRestoringAppliedMention &&
        !dismissedTrigger.hasLeftRange &&
        dismissedTrigger.reopenBeforeOffset !== null &&
        detectedTrigger?.from === dismissedTrigger.start &&
        caretPosition - dismissedTrigger.start <
          dismissedTrigger.reopenBeforeOffset;

      if (reopensUnmatchedTrigger) {
        dismissedTrigger = null;
        dismissedTriggerRef.current = null;
      }

      if (dismissedTrigger && !isRestoringAppliedMention) {
        if (
          !dismissedTrigger.hasLeftRange &&
          detectedTrigger?.from === dismissedTrigger.start
        ) {
          dismissedTrigger = {
            ...dismissedTrigger,
            end: Math.max(dismissedTrigger.end, caretPosition),
          };
          dismissedTriggerRef.current = dismissedTrigger;
        }

        const isWithinDismissedRange =
          caretPosition >= dismissedTrigger.start &&
          caretPosition <= dismissedTrigger.end;

        if (!isWithinDismissedRange) {
          dismissedTriggerRef.current = {
            ...dismissedTrigger,
            hasLeftRange: true,
          };
        } else if (dismissedTrigger.hasLeftRange) {
          dismissedTriggerRef.current = null;
        }
      }

      const shouldSuppressTrigger = Boolean(
        dismissedTriggerRef.current &&
        !dismissedTriggerRef.current.hasLeftRange &&
        (isRestoringAppliedMention ||
          (caretPosition >= dismissedTriggerRef.current.start &&
            caretPosition <= dismissedTriggerRef.current.end)),
      );

      const nextTrigger = shouldSuppressTrigger ? null : detectedTrigger;

      const nextKey = nextTrigger
        ? `${nextTrigger.kind}:${nextTrigger.from}:${nextTrigger.to}:${nextTrigger.query}`
        : "";

      if (nextKey !== triggerKeyRef.current) {
        triggerKeyRef.current = nextKey;
        setSelectedSuggestionKey(null);
      }

      const previousMenu = composerMenuRef.current;

      setComposerMenu(
        nextTrigger
          ? {
              kind: "suggestions",
              trigger: nextTrigger,
              revealOnMatch:
                reopensUnmatchedTrigger ||
                (previousMenu?.kind === "suggestions" &&
                  previousMenu.revealOnMatch &&
                  previousMenu.trigger.from === nextTrigger.from),
            }
          : previousMenu?.kind === "plugin"
            ? previousMenu
            : null,
      );

      dispatchTriggerQuery(nextTrigger);
    },
    [dispatchTriggerQuery, setComposerMenu, triggers],
  );

  useEffect(() => {
    syncTriggerStateRef.current = syncTriggerState;
  }, [syncTriggerState]);

  const editorExtensions = useMemo(
    () => [
      ...promptEditorExtensions({
        getPlaceholder: () => placeholderRef.current,
        getDecorationSources: () => pluginDecorationSourcesRef.current,
        getDraftObservers: () => pluginDraftObserversRef.current,
      }),
      createPromptThreadLinkPasteExtension({
        getOrigins: () => appLinkOrigins(),
        getCachedThread: (threadId) => {
          const cache = threadLinkCacheRef.current;

          const thread =
            cache.threadTitleResources.threadById.get(threadId) ??
            cache.queryClient?.getQueryData<ThreadResponse>(
              threadQueryKey(threadId),
            );

          return thread
            ? {
                threadId,
                projectId: thread.projectId,
                label: getThreadDisplayTitle(thread),
              }
            : null;
        },
        resolveThreads: (threadIds, signal) =>
          sdk.threads.resolveMentions({ threadIds, signal }),
      }),
      AttachmentHistory.configure({
        onChange: (id, present) =>
          setAttachmentPresenceRef.current(id, present),
      }),
      PromptImageAnchorSync.configure({
        handlers: {
          resolvePending: (path) =>
            imageAnchorHandlersRef.current.resolvePending(path),
          onAnchorsRemoved: (anchors) =>
            imageAnchorHandlersRef.current.onAnchorsRemoved(anchors),
          onAnchorsAdded: (anchors) =>
            imageAnchorHandlersRef.current.onAnchorsAdded(anchors),
        },
      }),
    ],
    [],
  );

  const initialEditorContent = useMemo(
    () =>
      promptEditorContentFromValue({ text: value, mentions: mentionRanges }),
    // oxlint-disable-next-line react/exhaustive-deps -- value/mentionRanges are read once per editor instance on purpose (see above).
    [],
  );

  const editor = useEditor(
    {
      extensions: editorExtensions,
      content: initialEditorContent,
      immediatelyRender: false,
      editorProps: {
        attributes: {
          "aria-label": effectivePlaceholder,
          "data-placeholder": effectivePlaceholder,
          ...(onModifierSubmit
            ? { "aria-keyshortcuts": modifierSubmitShortcutAria() }
            : {}),
          autocomplete: "off",
          class: cn(
            "min-h-full whitespace-pre-wrap break-words outline-none",
            "placeholder:select-none placeholder:text-subtle-foreground",
          ),
          enterkeyhint: editorEnterKeyHint,
          ...(id ? { id } : {}),
          role: "textbox",
        },
        transformCopied: (slice, view) =>
          promptEditorCopiedSlice(slice, view.state.selection),
        clipboardTextSerializer: (slice, view) =>
          promptEditorClipboardTextFromSlice(slice, view.state.schema),
        handleDOMEvents: {
          auxclick: (_view, event) => {
            return suppressPromptEditorAnchorActivation(event);
          },
          focus: () => {
            if (composerMenuRef.current?.kind === "plugin")
              dismissComposerMenu();

            return false;
          },
          blur: () => {
            pasteWithoutFormattingRef.current = false;

            if (valueRef.current === "") setSuggestionEngagedKey(null);

            if (composerMenuRef.current?.kind === "suggestions")
              dismissComposerMenu();

            if (dismissedTriggerRef.current) {
              dismissedTriggerRef.current = {
                ...dismissedTriggerRef.current,
                hasLeftRange: true,
              };
            }

            return false;
          },
          cut: () => {
            runAfterClipboardCut(() => {
              const currentEditor = editorRef.current;

              if (!currentEditor || currentEditor.isDestroyed) return;
              removeEmptyBlockquotes(currentEditor);
            });

            return false;
          },
          compositionend: (_view, event) => {
            if (!_view.composing) return false;
            compositionEndedAtRef.current = event.timeStamp;

            return false;
          },
          keydown: (_view, event) => {
            pasteWithoutFormattingRef.current =
              (event.metaKey || event.ctrlKey) &&
              event.shiftKey &&
              event.key.toLowerCase() === "v";

            if (
              !_view.editable ||
              !isIPadOSWebKitDevice ||
              !isIPadHardwareEnterCandidate(event) ||
              _view.composing ||
              event.isComposing ||
              event.keyCode === 229
            ) {
              return false;
            }

            if (
              Math.abs(event.timeStamp - compositionEndedAtRef.current) <
              SAFARI_POST_COMPOSITION_KEYDOWN_WINDOW_MS
            ) {
              compositionEndedAtRef.current = Number.NEGATIVE_INFINITY;
              postCompositionKeyDownEvents.add(event);

              return false;
            }

            return handleEditorKeyDownRef.current(event, true);
          },
          keyup: () => {
            pasteWithoutFormattingRef.current = false;

            return false;
          },
          click: (_view, event) => {
            return suppressPromptEditorAnchorActivation(event);
          },
        },
        handleClick: () => {
          const currentEditor = editorRef.current;

          if (!currentEditor) return false;
          syncTriggerStateRef.current(currentEditor);

          return false;
        },
        handleKeyDown: (_view, event) => {
          return handleEditorKeyDownRef.current(event);
        },
        handleDrop: (_view, event) => {
          const key = event.dataTransfer?.getData(IMAGE_ANCHOR_DRAG_TYPE);

          if (!key) return false;
          event.preventDefault();
          insertImageAnchorAtPointRef.current(
            key,
            event.clientX,
            event.clientY,
          );

          return true;
        },
        handlePaste: (view, event, slice) => {
          const skipThreadLinks =
            nativePasteFormattingRef.current.get(event) ??
            pasteWithoutFormattingRef.current;

          pasteWithoutFormattingRef.current = false;
          const html = event.clipboardData?.getData("text/html") ?? "";

          const richClipboard = html.trim()
            ? promptEditorValueFromRichHtml(html)
            : null;

          const threadLinkMetadata = (pastedValue: PromptEditorValue) => {
            const links = richClipboard?.threadLinks ?? [];

            if (!links.some((link) => link.literal))
              return { skip: skipThreadLinks };

            const pastedLinks = findPastedThreadLinkCandidates({
              text: pastedValue.text,
              origins: appLinkOrigins(),
            });

            if (
              pastedLinks.length !== links.length ||
              pastedLinks.some(
                (link, index) => link.text !== links[index]?.text,
              )
            )
              return { skip: true };

            return {
              skip: skipThreadLinks,
              literalLinkIndexes: links.flatMap((link, index) =>
                link.literal ? [index] : [],
              ),
            };
          };

          const attachFiles = onAttachFilesRef.current;
          const clipboardItems = Array.from(event.clipboardData?.items ?? []);

          const pastedFiles = clipboardItems
            .filter((item) => item.kind === "file")
            .map((item) => item.getAsFile())
            .filter((file): file is File => file !== null);

          const nativeResolver = getNativeFileResolver();

          if (pastedFiles.length > 0)
            observePastedFiles(pastedFiles, {
              clipboardTypes: Array.from(event.clipboardData?.types ?? []),
              nativeResolver: nativeResolver !== null,
              replayed: nativePasteFormattingRef.current.has(event),
            });

          if (
            nativeResolver !== null &&
            pastedFiles.length > 0 &&
            !nativePasteFormattingRef.current.has(event)
          ) {
            event.preventDefault();

            if (nativeFilesPendingRef.current) {
              appToast.error("Wait a moment, then paste the files again.");

              return true;
            }

            nativeFilesPendingRef.current = true;
            const editor = editorRef.current;
            const doc = view.state.doc;
            const selection = view.state.selection;
            const href = window.location.href;
            const draftKey = attachmentDraftKeyRef.current;
            const targetHostId = attachmentTargetHostIdRef.current;

            const data = new Map(
              Array.from(event.clipboardData?.types ?? [])
                .filter((type) => type !== "Files")
                .map((type) => [
                  type,
                  event.clipboardData?.getData(type) ?? "",
                ]),
            );

            void nativeResolver
              .resolve(pastedFiles)
              .then((classifications) => {
                if (
                  editor === null ||
                  editor.isDestroyed ||
                  editorRef.current !== editor ||
                  !editor.state.doc.eq(doc) ||
                  !editor.state.selection.eq(selection) ||
                  !editor.view.hasFocus() ||
                  window.location.href !== href ||
                  attachmentDraftKeyRef.current !== draftKey ||
                  attachmentTargetHostIdRef.current !== targetHostId
                ) {
                  appToast.error("The draft changed. Paste the files again.");

                  return;
                }

                const resolved = partitionNativeFiles(
                  pastedFiles,
                  classifications,
                );

                for (const file of resolved.files)
                  nativeFilePathsRef.current.set(
                    file,
                    resolved.paths.get(file) ?? null,
                  );
                const clipboardData = new DataTransfer();
                resolved.files.forEach((file) => clipboardData.items.add(file));

                if (resolved.directories.length > 0)
                  clipboardData.setData(
                    "text/plain",
                    resolved.directories.join("\n"),
                  );
                else
                  data.forEach((value, type) =>
                    clipboardData.setData(type, value),
                  );

                const replay = new ClipboardEvent("paste", {
                  clipboardData,
                  bubbles: true,
                  cancelable: true,
                });

                nativePasteFormattingRef.current.set(replay, skipThreadLinks);
                editor.view.dom.dispatchEvent(replay);
              })
              .catch(() =>
                appToast.error(
                  "The files could not be resolved. Copy them and paste again.",
                ),
              )
              .finally(() => {
                nativeFilesPendingRef.current = false;
              });

            return true;
          }

          const copiedMessage = skipThreadLinks
            ? null
            : readMessageClipboardHtml(html);

          if (copiedMessage) {
            event.preventDefault();
            editorRef.current
              ?.chain()
              .focus()
              .insertContent(
                promptEditorInlineContentFromValue({
                  text: copiedMessage.text,
                  mentions: [],
                }),
              )
              .setMeta("uiEvent", "paste")
              .setMeta(promptThreadLinkPasteKey, { skip: skipThreadLinks })
              .run();

            if (attachFiles) {
              if (pastedFiles.length > 0) {
                attachFilesWithHistoryRef.current(pastedFiles);
              } else {
                const editor = editorRef.current;
                const href = window.location.href;
                const controller = new AbortController();
                const timer = setTimeout(() => controller.abort(), 30000);
                void readMessageClipboardImage(
                  copiedMessage.imageUrl,
                  controller.signal,
                )
                  .then((file) => {
                    if (
                      editor &&
                      !editor.isDestroyed &&
                      editorRef.current === editor &&
                      window.location.href === href
                    )
                      attachFilesWithHistoryRef.current([file]);
                  })
                  .catch(() => {
                    if (
                      editor &&
                      !editor.isDestroyed &&
                      editorRef.current === editor &&
                      window.location.href === href
                    )
                      appToast.error("The copied image could not be attached");
                  })
                  .finally(() => clearTimeout(timer));
              }
            }

            return true;
          }

          const plainText = event.clipboardData?.getData("text/plain") ?? "";

          if (attachFiles && pastedFiles.length > 0) {
            event.preventDefault();
            attachFilesWithHistoryRef.current(pastedFiles);
          } else if (
            attachFiles &&
            plainText.length >= PASTED_TEXT_ATTACHMENT_MIN_LENGTH
          ) {
            event.preventDefault();

            const file = new File([plainText], "Pasted text.txt", {
              type: "text/plain",
            });

            attachFilesWithHistoryRef.current([file], (id, currentEditor) => {
              const previousDoc = currentEditor.state.doc;
              recordPastedTextHistory(
                currentEditor,
                id,
                promptEditorValueFromPlainText(plainText, promptActions),
              );

              if (currentEditor.state.doc.eq(previousDoc)) return;

              const nextValue = trimTrailingPromptNewlines(
                promptEditorValueFromDoc(currentEditor.state.doc),
              );

              lastSyncedEditorValueRef.current = nextValue;
              onChangeRef.current(nextValue.text, nextValue.mentions);
            });
            view.focus();

            return true;
          }

          const sliceHasBlockquote = promptEditorSliceHasBlockquote(slice);

          if (sliceHasBlockquote || plainTextHasQuoteLine(plainText)) {
            event.preventDefault();

            const pastedValue = trimTrailingPromptNewlines(
              sliceHasBlockquote
                ? promptEditorValueFromSlice(slice, view.state.schema)
                : promptEditorValueFromPlainText(plainText, promptActions),
            );

            if (pastedValue.text.length === 0) return true;

            const currentEditor = editorRef.current;

            const pastedContent =
              promptEditorContentFromValue(pastedValue).content ?? [];

            currentEditor
              ?.chain()
              .focus()
              .insertContent(pastedContent)
              .setMeta("uiEvent", "paste")
              .setMeta(
                promptThreadLinkPasteKey,
                threadLinkMetadata(pastedValue),
              )
              .run();

            if (currentEditor && !currentEditor.isDestroyed) {
              const nextValue = trimTrailingPromptNewlines(
                promptEditorValueFromDoc(currentEditor.state.doc),
              );

              lastSyncedEditorValueRef.current = nextValue;
              onChangeRef.current(nextValue.text, nextValue.mentions);
            }

            return true;
          }

          const pastedValue = promptEditorValueFromClipboardPaste(
            event.clipboardData ?? null,
            promptActions,
            richClipboard,
          );

          if (pastedValue === null) {
            return attachFiles !== undefined && pastedFiles.length > 0;
          }

          event.preventDefault();

          if (pastedValue.text.length === 0) return true;

          editorRef.current
            ?.chain()
            .focus()
            .insertContent(promptEditorInlineContentFromValue(pastedValue))
            .setMeta("uiEvent", "paste")
            .setMeta(promptThreadLinkPasteKey, threadLinkMetadata(pastedValue))
            .run();

          return true;
        },
      },
      onCreate({ editor: createdEditor }) {
        editorRef.current = createdEditor;
      },
      onSelectionUpdate({ editor: updatedEditor, transaction }) {
        if (transaction.docChanged) return;
        syncTriggerStateRef.current(updatedEditor);
        scheduleRevealEditorSelection();
      },
      onUpdate({ editor: updatedEditor, transaction }) {
        if (skipEditorChangeRef.current) return;
        const dismissedTrigger = dismissedTriggerRef.current;

        if (
          dismissedTrigger !== null &&
          transaction.docChanged &&
          !isRestoringAppliedMentionRef.current
        ) {
          const mappedStart = transaction.mapping.mapResult(
            dismissedTrigger.start,
            1,
          );

          dismissedTriggerRef.current = mappedStart.deleted
            ? null
            : {
                ...dismissedTrigger,
                start: mappedStart.pos,
                end: transaction.mapping.map(dismissedTrigger.end, -1),
              };
        }

        const nextValue = promptEditorValueFromDoc(updatedEditor.state.doc);
        lastSyncedEditorValueRef.current = nextValue;
        onChangeRef.current(nextValue.text, nextValue.mentions);
        syncTriggerStateRef.current(updatedEditor);

        if (transaction.getMeta("uiEvent") !== undefined) {
          scheduleRevealEditorSelection();
        }
      },
    },
    [],
  );

  useEffect(() => {
    if (!editor || editor.isDestroyed) return;
    const editable = !composerInputLocked && !showVoiceActionGroup;

    if (editor.isEditable !== editable) editor.setEditable(editable);
    editor.view.dom.tabIndex = editable ? 0 : -1;

    if (editable) {
      editor.view.dom.removeAttribute("aria-readonly");
    } else {
      editor.view.dom.setAttribute("aria-readonly", "true");
    }
  }, [composerInputLocked, editor, showVoiceActionGroup]);

  useEffect(() => {
    editorRef.current = editor?.isDestroyed ? null : editor;

    return () => {
      editorRef.current = null;
    };
  }, [editor]);

  useLayoutEffect(() => {
    if (editor && !editor.isDestroyed) cancelPromptThreadLinkPaste(editor);
  }, [
    editor,
    composerScopeKey,
    pluginComposerHost?.textEffectKey,
    focusScopeKey,
  ]);

  useLayoutEffect(() => {
    if (
      editor &&
      !editor.isDestroyed &&
      (isSubmitting || composerInputLocked)
    ) {
      cancelPromptThreadLinkPaste(editor);
    }
  }, [editor, isSubmitting, composerInputLocked]);

  useLayoutEffect(() => {
    if (!editor || editor.isDestroyed) return;

    return registerPaneComposerFocus(editor.view.dom, () => {
      if (!editor.isDestroyed && editor.isEditable) editor.view.focus();
    });
  }, [editor]);

  useEffect(() => {
    if (!editor || editor.isDestroyed) return;
    refreshPromptDecorations(editor);
  }, [composerScopeKey, editor, pluginRichTextContributions]);

  useLayoutEffect(() => {
    if (!pendingFocusEndRef.current) return;

    if (isPointerCoarse) {
      pendingFocusEndRef.current = false;

      return;
    }

    if (!editor || editor.isDestroyed) return;
    pendingFocusEndRef.current = false;
    focusEditorAtEnd(editor);
    scheduleRevealEditorSelection();
  }, [editor, isPointerCoarse, scheduleRevealEditorSelection]);

  useLayoutEffect(() => {
    placeholderRef.current = suggestionOverlayShown ? "" : effectivePlaceholder;

    if (!editor || editor.isDestroyed) return;

    editor.view.dom.setAttribute("aria-label", effectivePlaceholder);
    editor.view.dom.setAttribute(
      "data-placeholder",
      suggestionOverlayShown ? "" : effectivePlaceholder,
    );
    editor.view.dom.setAttribute("enterkeyhint", editorEnterKeyHint);
    editor.view.dispatch(editor.state.tr);
  }, [
    editor,
    editorEnterKeyHint,
    effectivePlaceholder,
    suggestionOverlayShown,
  ]);

  const yieldsExistingFocusRef = useRef(yieldsExistingFocus);
  useLayoutEffect(() => {
    yieldsExistingFocusRef.current = yieldsExistingFocus;
  }, [yieldsExistingFocus]);

  useLayoutEffect(() => {
    if (!editor || editor.isDestroyed) return;

    if (!autoFocus) {
      if (editor.view.dom.contains(document.activeElement)) {
        blurPromptEditor(editor);
      }

      return;
    }

    if (isPointerCoarse) return;

    const focusEditor = () => {
      if (editor.isDestroyed) return;
      const yieldsFocus = yieldsExistingFocusRef.current?.() === true;
      const active = document.activeElement;

      if (yieldsFocus && active !== null && active !== document.body) return;

      if (active?.closest("[data-sidebar-rename-editor]")) return;

      if (active?.matches("[data-sidebar-thread-id]:focus-visible")) return;
      focusEditorAtEnd(editor);
      scheduleRevealEditorSelection();
    };

    if (typeof window.requestAnimationFrame !== "function") {
      focusEditor();

      return;
    }

    const handle = window.requestAnimationFrame(focusEditor);

    return () => window.cancelAnimationFrame(handle);
  }, [
    autoFocus,
    editor,
    focusScopeKey,
    scheduleRevealEditorSelection,
    isPointerCoarse,
  ]);

  useEffect(() => {
    mentionRangesRef.current = mentionRanges;
  }, [mentionRanges]);

  useEffect(() => {
    valueRef.current = value;
  }, [value]);

  useLayoutEffect(() => {
    if (!editor || editor.isDestroyed) return;

    const nextValue = {
      text: value,
      mentions: mentionRanges,
    };

    if (
      lastSyncedEditorRef.current === editor &&
      arePromptEditorValuesEqual(lastSyncedEditorValueRef.current, nextValue)
    ) {
      return;
    }

    dismissedTriggerRef.current = null;
    triggerKeyRef.current = "";

    try {
      skipEditorChangeRef.current = true;
      cancelPromptThreadLinkPaste(editor);
      editor.commands.setContent(promptEditorContentFromValue(nextValue));
      lastSyncedEditorValueRef.current = nextValue;
      lastSyncedEditorRef.current = editor;
    } finally {
      skipEditorChangeRef.current = false;
    }

    syncTriggerState(editor);
    scheduleRevealEditorSelection();
  }, [
    editor,
    mentionRanges,
    scheduleRevealEditorSelection,
    syncTriggerState,
    value,
  ]);

  const lastFocusEndKeyRef = useRef(focusEndKey);
  useLayoutEffect(() => {
    if (focusEndKey === undefined) return;

    if (focusEndKey === lastFocusEndKeyRef.current) return;

    if (isPointerCoarse) {
      lastFocusEndKeyRef.current = focusEndKey;

      return;
    }

    if (!editor || editor.isDestroyed) return;
    lastFocusEndKeyRef.current = focusEndKey;
    focusEditorAtEnd(editor);
    scheduleRevealEditorSelection();
  }, [editor, focusEndKey, isPointerCoarse, scheduleRevealEditorSelection]);

  useLayoutEffect(() => {
    scheduleRevealEditorSelection();
  }, [minHeight, scheduleRevealEditorSelection]);

  const resetHistorySession = useCallback(() => {
    if (!hasActiveHistorySessionRef.current) return;
    hasActiveHistorySessionRef.current = false;
    setActiveHistoryIndex(null);
    setTemporaryHistoryDraft(null);
    setRecalledHistoryDraft(null);
  }, []);

  useEffect(() => {
    if (!history) {
      resetHistorySession();

      return;
    }

    if (history.entries.length === 0) {
      resetHistorySession();

      return;
    }

    if (
      activeHistoryIndex !== null &&
      activeHistoryIndex >= history.entries.length
    ) {
      resetHistorySession();
    }
  }, [activeHistoryIndex, history, resetHistorySession]);

  useEffect(() => {
    resetHistorySession();
  }, [history?.resetKey, resetHistorySession]);

  useEffect(() => {
    if (!history || activeHistoryIndex === null || !recalledHistoryDraft) {
      return;
    }

    const activeHistoryEntry = history.entries[activeHistoryIndex];

    if (
      !activeHistoryEntry ||
      !arePromptDraftStatesEqual(activeHistoryEntry, recalledHistoryDraft)
    ) {
      resetHistorySession();

      return;
    }

    if (arePromptDraftStatesEqual(history.currentDraft, recalledHistoryDraft)) {
      return;
    }

    resetHistorySession();
  }, [activeHistoryIndex, history, recalledHistoryDraft, resetHistorySession]);

  useLayoutEffect(() => {
    const fromHeight = heightAnimationFromRef.current;
    const formElement = formRef.current;

    if (fromHeight === null || !formElement) return;
    heightAnimationFromRef.current = null;

    return glidePromptBoxHeight(formElement, fromHeight, {
      durationMs: PROMPTBOX_HEIGHT_TRANSITION_MS,
    });
  }, [heightAnimationKey, showCompactLayout]);

  const trimmedValue = value.trim();
  const hasAttachments = attachments.length > 0;

  const hasSubmittableInput =
    trimmedValue.length > 0 ||
    hasAttachments ||
    (acceptWhileUploading && (pendingUploads?.length ?? 0) > 0);

  const hasUnclearImages = hasAmbiguousPromptImageAnchors({
    text: value,
    mentions: [...mentionRanges],
    attachments,
  });

  const orderedAttachments = useMemo(() => {
    const firstAnchor = new Map<PromptDraftAttachment, number>();

    for (const mention of mentionRanges) {
      if (
        mention.resource.kind !== "attachment" ||
        !isPromptImageAnchorMention(mention, value)
      )
        continue;
      const binding = resolvePromptImageAnchor(attachments, mention.resource);

      if (binding.status !== "bound") continue;
      const known = firstAnchor.get(binding.attachment);

      if (known === undefined || mention.start < known)
        firstAnchor.set(binding.attachment, mention.start);
    }

    return firstAnchor.size === 0
      ? attachments
      : [...attachments].sort(
          (left, right) =>
            (firstAnchor.get(left) ?? Number.POSITIVE_INFINITY) -
            (firstAnchor.get(right) ?? Number.POSITIVE_INFINITY),
        );
  }, [attachments, mentionRanges, value]);

  const imageAnchorContext = useMemo<PromptImageAnchorState>(
    () => ({
      activeKey: activeImageKey,
      setActiveKey: setActiveImageKey,
      resolve: (anchor) => {
        if (isPendingImageAnchorPath(anchor.path)) return { status: "pending" };
        const binding = resolvePromptImageAnchor(attachments, anchor);

        if (binding.status !== "bound") return binding;

        return {
          status: "bound",
          attachment: binding.attachment,
          key: promptAttachmentKey(binding.attachment),
          previewSrc: resolveAttachmentPreviewSrc(
            binding.attachment.path,
            binding.attachment.sourceProjectId ?? attachmentProjectId,
          ),
        };
      },
    }),
    [activeImageKey, attachmentProjectId, attachments],
  );

  const activeTriggerKind = activeTrigger?.kind ?? null;
  const commandHasMore = typeahead.command.hasMore;
  const commandIsLoadingMore = typeahead.command.isLoadingMore;
  const loadMoreCommands = typeahead.command.loadMore;

  const canLoadMoreCommands =
    activeTriggerKind === "command" &&
    canLoadMoreCommandResults({
      hasMore: commandHasMore,
      isError: commandError,
      isLoadingMore: commandIsLoadingMore,
    });

  const activeCommandQuery =
    activeTrigger?.kind === "command" ? activeTrigger.query : "";

  const orderedCommandSuggestions = useMemo(
    () => orderCommandSuggestions(commandSuggestions, activeCommandQuery),
    [activeCommandQuery, commandSuggestions],
  );

  const activeMentionQuery =
    activeTrigger?.kind === "mention" ? activeTrigger.query.trim() : "";

  const isDefaultMentionTrigger =
    activeTrigger?.kind === "mention" &&
    activeTrigger.char === DEFAULT_PLUGIN_MENTION_TRIGGER;

  const attachmentMentionSuggestions = useMemo(
    () =>
      attachments
        .filter((attachment) => !isImageAttachment(attachment))
        .map((attachment): AttachmentMentionSuggestion => ({
          kind: "attachment",
          path: attachment.path,
          name: attachment.name,
          replacement: `@${attachment.name}`,
        })),
    [attachments],
  );

  const composerMentionResults = useMemo(
    () =>
      isDefaultMentionTrigger
        ? withAttachmentMentionSuggestions({
            attachments: attachmentMentionSuggestions,
            query: activeMentionQuery,
            results: mentionResults,
          })
        : mentionResults,
    [
      activeMentionQuery,
      attachmentMentionSuggestions,
      isDefaultMentionTrigger,
      mentionResults,
    ],
  );

  const activeSuggestions = useMemo<readonly TypeaheadSuggestion[]>(
    () =>
      activeTriggerKind === "command"
        ? orderedCommandSuggestions
        : activeTriggerKind === "mention"
          ? composerMentionResults.suggestions
          : [],
    [
      activeTriggerKind,
      composerMentionResults.suggestions,
      orderedCommandSuggestions,
    ],
  );

  const selectedSuggestionIndex = useMemo(() => {
    if (selectedSuggestionKey === null) return -1;

    return activeSuggestions.findIndex(
      (suggestion) =>
        typeaheadSuggestionKey(suggestion) === selectedSuggestionKey,
    );
  }, [activeSuggestions, selectedSuggestionKey]);

  const selectedIndex = Math.max(0, selectedSuggestionIndex);

  const popups = useResolvedComposerPopups(
    suppressPluginComposerCustomizations ? null : composerView.scope.kind,
  );

  const skillSearchPopup = popups.find(
    ({ pluginId, popup }) =>
      pluginId === "skill-discovery" && popup.id === "find-skills",
  );

  const canFindSkills =
    activeTrigger?.kind === "command" &&
    activeTrigger.char === "/" &&
    skillSearchPopup !== undefined;

  const isFindSkillsSelected =
    canFindSkills &&
    (selectedSuggestionKey === FIND_SKILLS_SUGGESTION_KEY ||
      (activeSuggestions.length === 0 && activeTrigger.query.length === 0));

  const mentionMenuState: MentionMenuState =
    composerMentionResults !== mentionResults
      ? {
          kind: "results",
          results: composerMentionResults,
          refreshing: mentionRefreshing,
        }
      : activeMentionQuery.length === 0
        ? { kind: "hint" }
        : mentionLoading
          ? { kind: "loading" }
          : mentionError
            ? { kind: "error" }
            : {
                kind: "results",
                results: mentionResults,
                refreshing: mentionRefreshing,
              };

  const commandMenuState: CommandMenuState = commandLoading
    ? { kind: "loading" }
    : commandError
      ? { kind: "error" }
      : {
          kind: "results",
          suggestions: orderedCommandSuggestions,
          isUpdating: commandUpdating,
        };

  const isCommandTriggerLiteral =
    activeTriggerKind === "command" &&
    !canFindSkills &&
    !commandLoading &&
    !commandUpdating &&
    !commandError &&
    commandSuggestions.length === 0;

  const isBareNonDefaultMentionTrigger =
    activeTrigger?.kind === "mention" &&
    activeTrigger.char !== DEFAULT_PLUGIN_MENTION_TRIGGER &&
    activeMentionQuery.length === 0;

  const isUnmatchedMultiwordMention =
    activeTriggerKind === "mention" &&
    activeMentionQuery.includes(" ") &&
    !mentionLoading &&
    !mentionError &&
    !mentionRefreshing &&
    activeSuggestions.length === 0;

  useEffect(() => {
    if (isUnmatchedMultiwordMention) dismissUnmatchedMention();
  }, [dismissUnmatchedMention, isUnmatchedMultiwordMention]);

  const isHiddenUntilMatch =
    composerMenu?.kind === "suggestions" &&
    composerMenu.revealOnMatch &&
    !canFindSkills &&
    activeSuggestions.length === 0;

  const showTypeaheadMenu =
    !showVoiceActionGroup &&
    activeTrigger !== null &&
    !isCommandTriggerLiteral &&
    !isUnmatchedMultiwordMention &&
    !isHiddenUntilMatch &&
    !isBareNonDefaultMentionTrigger;

  useTypeaheadMenuMaxHeight(
    typeaheadMenuRef,
    showTypeaheadMenu && mentionMenuPlacement === "top",
  );

  const popupContribution =
    composerMenu?.kind === "plugin"
      ? (popups.find((popup) => popup.key === composerMenu.key) ?? null)
      : null;

  const popupOpen =
    composerMenu?.kind === "plugin" &&
    composerMenu.open &&
    popupContribution !== null;

  const composerMenuOpen = popupOpen || showTypeaheadMenu;

  const typeaheadMenuState: TypeaheadMenuState =
    activeTriggerKind === "command"
      ? { trigger: "command", state: commandMenuState }
      : { trigger: "mention", state: mentionMenuState };

  useLayoutEffect(() => {
    if (reportQueuedEditorTypeaheadLayout === null) return;
    const menu = typeaheadMenuRef.current;

    if (!composerMenuOpen || menu === null) {
      reportQueuedEditorTypeaheadLayout({ height: 0, isOpen: false });

      return;
    }

    const reportOpenLayout = () => {
      reportQueuedEditorTypeaheadLayout({
        height: menu.getBoundingClientRect().height,
        isOpen: true,
      });
    };

    reportOpenLayout();

    const resizeObserver =
      typeof ResizeObserver === "undefined"
        ? null
        : new ResizeObserver(reportOpenLayout);

    resizeObserver?.observe(menu);

    return () => {
      resizeObserver?.disconnect();
      reportQueuedEditorTypeaheadLayout({ height: 0, isOpen: false });
    };
  }, [reportQueuedEditorTypeaheadLayout, composerMenuOpen]);

  useEffect(() => {
    if (
      selectedSuggestionKey !== null &&
      selectedSuggestionIndex === -1 &&
      !(canFindSkills && selectedSuggestionKey === FIND_SKILLS_SUGGESTION_KEY)
    ) {
      setSelectedSuggestionKey(null);
    }
  }, [canFindSkills, selectedSuggestionIndex, selectedSuggestionKey]);

  useEffect(() => {
    if (
      activeTriggerKind !== "command" ||
      !canLoadMoreCommands ||
      activeSuggestions.length === 0
    ) {
      return;
    }

    const prefetchIndex = Math.max(0, activeSuggestions.length - 3);

    if (selectedIndex >= prefetchIndex) {
      loadMoreCommands();
    }
  }, [
    activeSuggestions.length,
    activeTriggerKind,
    canLoadMoreCommands,
    loadMoreCommands,
    selectedIndex,
  ]);

  const finishApply = useCallback(
    (appliedEditor: Editor) => {
      const nextValue = promptEditorValueFromDoc(appliedEditor.state.doc);
      lastSyncedEditorValueRef.current = nextValue;
      onChangeRef.current(nextValue.text, nextValue.mentions);

      requestAnimationFrame(() => {
        const nextEditor = editorRef.current;

        if (!nextEditor || nextEditor.isDestroyed) {
          isRestoringAppliedMentionRef.current = false;

          return;
        }

        nextEditor.commands.focus();
        syncTriggerState(nextEditor);
        scheduleRevealEditorSelection();
        isRestoringAppliedMentionRef.current = false;
      });
    },
    [scheduleRevealEditorSelection, syncTriggerState],
  );

  const insertPromptMentionPill = useCallback(
    ({
      editor: targetEditor,
      range,
      resource,
      serializedText,
      trailingText,
      dismissedTrigger,
      clearQuery,
    }: {
      editor: Editor;
      range: { from: number; to: number };
      resource: PromptMentionResource;
      serializedText: string;
      trailingText: string;
      dismissedTrigger: DismissedTriggerRange | null;
      clearQuery: () => void;
    }) => {
      triggerKeyRef.current = "";
      dismissedTriggerRef.current = dismissedTrigger;
      isRestoringAppliedMentionRef.current = true;
      setComposerMenu(null);
      setSelectedSuggestionKey(null);
      clearQuery();

      try {
        skipEditorChangeRef.current = true;
        targetEditor
          .chain()
          .focus()
          .deleteRange(range)
          .insertContent([
            {
              type: "mention",
              attrs: {
                resource,
                serializedText,
              },
            },
            ...(trailingText ? [{ type: "text", text: trailingText }] : []),
          ])
          .run();
      } finally {
        skipEditorChangeRef.current = false;
      }

      finishApply(targetEditor);
    },
    [finishApply, setComposerMenu],
  );

  useEffect(() => {
    const element = formRef.current;

    if (!element || !editor || editor.isDestroyed) return;

    return registerThreadMentionDropTarget(element, {
      accepts: () => editor.isEditable && !editor.isDestroyed,
      insert: (thread, x, y) => {
        const position =
          editor.view.posAtCoords({ left: x, top: y })?.pos ??
          editor.state.selection.to;

        insertPromptMentionPill({
          editor,
          range: { from: position, to: position },
          resource: {
            kind: "thread",
            threadId: thread.threadId,
            label: thread.label,
          },
          serializedText: `@thread:${thread.threadId}`,
          trailingText: mentionPillTrailingText(editor.state.doc, position),
          dismissedTrigger: null,
          clearQuery: () => onMentionQueryChange(null, null),
        });
      },
    });
  }, [editor, insertPromptMentionPill, onMentionQueryChange]);

  const applyMentionSuggestion = useCallback(
    (item: PromptMentionSuggestion) => {
      const currentEditor = editorRef.current;

      if (!currentEditor || activeTrigger?.kind !== "mention") return;

      const replacement = item.replacement.trim();
      insertPromptMentionPill({
        editor: currentEditor,
        range: { from: activeTrigger.from, to: activeTrigger.to },
        resource: promptMentionResourceFromSuggestion(item),
        serializedText: replacement.startsWith(activeTrigger.char)
          ? replacement
          : `${activeTrigger.char}${replacement}`,
        trailingText: mentionPillTrailingText(
          currentEditor.state.doc,
          activeTrigger.to,
        ),
        dismissedTrigger: {
          start: activeTrigger.from,
          end: activeTrigger.from + 2,
          hasLeftRange: false,
          reopenBeforeOffset: null,
        },
        clearQuery: () => onMentionQueryChange(null, null),
      });
    },
    [activeTrigger, insertPromptMentionPill, onMentionQueryChange],
  );

  const applyCommandSuggestion = useCallback(
    (item: ProviderCommandSuggestion) => {
      const currentEditor = editorRef.current;

      if (!currentEditor || activeTrigger === null) return;

      if (activeTrigger.kind !== "command") return;

      const trailingText = mentionPillTrailingText(
        currentEditor.state.doc,
        activeTrigger.to,
      );

      insertPromptMentionPill({
        editor: currentEditor,
        range: { from: activeTrigger.from, to: activeTrigger.to },
        resource: promptCommandResourceFromSuggestion({
          suggestion: item,
          trigger: activeTrigger.char,
        }),
        serializedText: `${activeTrigger.char}${item.name}`,
        trailingText,
        dismissedTrigger: {
          start: activeTrigger.from,
          end: commandPillDismissedRangeEnd({
            triggerPosition: activeTrigger.from,
            trailingText,
          }),
          hasLeftRange: false,
          reopenBeforeOffset: null,
        },
        clearQuery: () => onCommandQueryChange(null, null),
      });
    },
    [activeTrigger, insertPromptMentionPill, onCommandQueryChange],
  );

  const applyTrigger = useCallback(
    (item: TypeaheadSuggestion) => {
      if (item.kind === "command") {
        applyCommandSuggestion(item);

        return;
      }

      applyMentionSuggestion(item);
    },
    [applyCommandSuggestion, applyMentionSuggestion],
  );

  const handleComposerMenuKeyDown = useCallback(
    (event: KeyboardEvent): boolean => {
      if (!composerMenuOpen || event.defaultPrevented) return false;

      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        dismissComposerMenu(true);

        return true;
      }

      if (
        popupOpen &&
        event.key === "Enter" &&
        event.target instanceof HTMLInputElement
      ) {
        event.preventDefault();

        return true;
      }

      return false;
    },
    [composerMenuOpen, dismissComposerMenu, popupOpen],
  );

  const isFocusedPane = useOptionalPaneContext()?.isFocused ?? true;

  const ownsCommandTarget = useCallback(
    (target: EventTarget | null) =>
      composerOwnsCommand(
        resolveComposerCommandScope({
          composer: formRef.current?.closest(APP_COMPOSER_SELECTOR) ?? null,
          target,
          isFocusedPane,
        }),
      ),
    [isFocusedPane],
  );

  const openPopupForPlugin = useCallback(
    (pluginId: string, popupId: string, initialSkillQuery?: string) => {
      const contribution = popups.find(
        (popup) => popup.pluginId === pluginId && popup.popup.id === popupId,
      );

      if (!contribution) return false;
      dismissComposerMenu();
      setComposerMenu({
        kind: "plugin",
        key: contribution.key,
        open: true,
        ...(initialSkillQuery === undefined ? {} : { initialSkillQuery }),
      });

      return true;
    },
    [dismissComposerMenu, popups, setComposerMenu],
  );

  const openFindSkills = useCallback(() => {
    const currentEditor = editorRef.current;
    const currentMenu = composerMenuRef.current;

    if (
      !skillSearchPopup ||
      !currentEditor ||
      currentEditor.isDestroyed ||
      !currentEditor.isEditable ||
      currentMenu?.kind !== "suggestions" ||
      currentMenu.trigger.kind !== "command" ||
      currentMenu.trigger.char !== "/"
    )
      return;

    const { from, to, query } = currentMenu.trigger;

    if (
      openPopupForPlugin(
        skillSearchPopup.pluginId,
        skillSearchPopup.popup.id,
        query.trim().slice(0, 256),
      )
    ) {
      dismissedTriggerRef.current = null;
      currentEditor.commands.deleteRange({ from, to });
    }
  }, [openPopupForPlugin, skillSearchPopup]);

  const closePopupForPlugin = useCallback(
    (pluginId: string) => {
      const current = composerMenuRef.current;

      if (
        current?.kind !== "plugin" ||
        !current.open ||
        !popups.some(
          (popup) => popup.key === current.key && popup.pluginId === pluginId,
        )
      )
        return false;
      dismissComposerMenu(true);

      return true;
    },
    [dismissComposerMenu, popups],
  );

  const focusEnd = useCallback(() => {
    if (isPointerCoarse) {
      pendingFocusEndRef.current = false;

      return;
    }

    const currentEditor = editorRef.current;

    if (!currentEditor || currentEditor.isDestroyed) {
      pendingFocusEndRef.current = true;

      return;
    }

    pendingFocusEndRef.current = false;
    focusEditorAtEnd(currentEditor);
    scheduleRevealEditorSelection();
  }, [isPointerCoarse, scheduleRevealEditorSelection]);

  const insertTextAtCursor = useCallback(
    (rawText: string) => {
      const normalizedText = rawText.replace(/\s+/g, " ").trim();

      if (normalizedText.length === 0) return;

      const currentEditor = editorRef.current;
      const currentValue = valueRef.current;

      if (!currentEditor) {
        const nextValue =
          currentValue.length === 0 || /\s$/.test(currentValue)
            ? `${currentValue}${normalizedText}`
            : `${currentValue} ${normalizedText}`;

        onChangeRef.current(nextValue, [...mentionRangesRef.current]);

        return;
      }

      const selection = currentEditor.state.selection;

      const before = currentEditor.state.doc.textBetween(
        0,
        selection.from,
        "\n",
        "\n",
      );

      const after = currentEditor.state.doc.textBetween(
        selection.to,
        currentEditor.state.doc.content.size,
        "\n",
        "\n",
      );

      const needsLeadingWhitespace = before.length > 0 && !/\s$/.test(before);
      const needsTrailingWhitespace = after.length > 0 && !/^\s/.test(after);
      const insertedText = `${needsLeadingWhitespace ? " " : ""}${normalizedText}${needsTrailingWhitespace ? " " : ""}`;

      const insertion = currentEditor.chain();

      if (!isPointerCoarse) insertion.focus();
      insertion.insertContent(insertedText).run();

      if (!isPointerCoarse) scheduleRevealEditorSelection();
    },
    [isPointerCoarse, scheduleRevealEditorSelection],
  );

  const insertTypedText = useCallback(
    (text: string) => {
      if (text.length === 0) return;

      const currentEditor = editorRef.current;

      if (!currentEditor) {
        onChangeRef.current(`${valueRef.current}${text}`, [
          ...mentionRangesRef.current,
        ]);

        return;
      }

      currentEditor.chain().insertContent(text).run();

      if (!isPointerCoarse) scheduleRevealEditorSelection();
    },
    [isPointerCoarse, scheduleRevealEditorSelection],
  );

  const focusAfterPromptAction = useCallback(
    (currentEditor: Editor, position?: "end") => {
      const focusEditor = () => {
        promptActionFocusFrameRef.current = null;

        if (currentEditor.isDestroyed) return;
        currentEditor.commands.focus(position);
        syncTriggerState(currentEditor);
        scheduleRevealEditorSelection();
      };

      if (typeof requestAnimationFrame !== "function") {
        focusEditor();

        return;
      }

      if (promptActionFocusFrameRef.current !== null) {
        cancelAnimationFrame(promptActionFocusFrameRef.current);
      }

      promptActionFocusFrameRef.current = requestAnimationFrame(focusEditor);
    },
    [scheduleRevealEditorSelection, syncTriggerState],
  );

  const applyPromptAction = useCallback(
    (action: PromptBoxAction) => {
      if (action.text.length === 0) return;
      const currentEditor = editorRef.current;
      const commandAction = promptActionCommandFromAction(action);

      if (commandAction) {
        const next = withLeadingCommand(
          { text: valueRef.current, mentions: mentionRangesRef.current },
          commandAction,
        );

        onChangeRef.current(next.text, next.mentions);

        if (currentEditor && !currentEditor.isDestroyed) {
          focusAfterPromptAction(currentEditor, "end");
        }

        return;
      }

      if (!currentEditor || currentEditor.isDestroyed) {
        const currentValue = valueRef.current;

        if (currentValue.endsWith(action.text)) return;
        onChangeRef.current(`${currentValue}${action.text}`, [
          ...mentionRangesRef.current,
        ]);

        return;
      }

      const insertionRange = skillsTriggerInsertionRange(
        currentEditor,
        action,
        triggers,
      );

      if (insertionRange === null) {
        focusAfterPromptAction(currentEditor);

        return;
      }

      triggerKeyRef.current = "";
      dismissedTriggerRef.current = null;
      setSelectedSuggestionKey(null);
      currentEditor
        .chain()
        .focus()
        .deleteRange({ from: insertionRange.from, to: insertionRange.to })
        .insertContent(action.text)
        .run();
      finishApply(currentEditor);
    },
    [finishApply, focusAfterPromptAction, triggers],
  );

  const getTextBeforeCursor = useCallback((): string | undefined => {
    const currentValue = valueRef.current;
    const currentEditor = editorRef.current;

    if (!currentEditor) {
      const trimmed = currentValue.trim();

      return trimmed.length > 0 ? trimmed : undefined;
    }

    const beforeCursor = currentEditor.state.doc
      .textBetween(0, currentEditor.state.selection.from, "\n", "\n")
      .trim();

    return beforeCursor.length > 0 ? beforeCursor : undefined;
  }, []);

  const [voiceSubmitBaseline, setVoiceSubmitBaseline] = useState<string | null>(
    null,
  );

  const sendVoiceTranscript = useCallback(
    (text: string) => {
      setVoiceSubmitBaseline(valueRef.current);
      insertTextAtCursor(text);
    },
    [insertTextAtCursor],
  );

  useImperativeHandle(
    promptBoxRef,
    () => ({
      captureHeightForLayoutChange: capturePromptBoxHeight,
      focusEnd,
      insertTextAtCursor,
      insertTypedText,
      sendVoiceTranscript,
      getTextBeforeCursor,
      playVoiceCompletionTransition,
      dismissMenu: () => {
        if (!composerMenuOpen) return false;
        dismissComposerMenu(true);

        return true;
      },
      openAttachmentPicker: () => {
        if (onAttachFiles) attachmentInputRef.current?.click();
      },
      applyPromptAction,
    }),
    [
      applyPromptAction,
      capturePromptBoxHeight,
      composerMenuOpen,
      dismissComposerMenu,
      focusEnd,
      getTextBeforeCursor,
      insertTextAtCursor,
      insertTypedText,
      onAttachFiles,
      sendVoiceTranscript,
      playVoiceCompletionTransition,
    ],
  );

  const uploadsBlockSubmission = isAttaching && !acceptWhileUploading;

  const canSubmitAction = (action: typeof immediateSubmitAction) =>
    action.onSubmit !== undefined &&
    (!action.requiresInput || hasSubmittableInput) &&
    !uploadsBlockSubmission &&
    !hasUnclearImages &&
    !isSubmitting &&
    !submitDisabled &&
    !showVoiceActionGroup;

  const canPrimarySubmit = canSubmitAction(primarySubmitAction);
  const canSubmit = hasSubmittableInput && canPrimarySubmit;

  const suggestionSendBlockedReason = uploadsBlockSubmission
    ? "Uploading attachments..."
    : isSubmitting
      ? "Submitting..."
      : submitDisabled
        ? (submitDisabledReason ?? "This composer can't submit right now.")
        : null;

  const suggestionSendable =
    readySuggestion !== null &&
    pluginComposerHost?.submitDraft !== undefined &&
    suggestionSendBlockedReason === null &&
    (suggestionCardMode || suggestionShown);

  const canSendSuggestion = suggestionSendable && !suggestionCardMode;

  const canModifierSubmit = canSubmitAction(modifierSubmitAction);
  const composerEditorKey = pluginComposerHost?.textEffectKey ?? null;

  const submittingBlockedReason = canSubmit
    ? null
    : uploadsBlockSubmission
      ? "Uploading attachments..."
      : hasUnclearImages
        ? UNCLEAR_IMAGE_MESSAGE
        : (submitDisabledReason ??
          (showVoiceActionGroup
            ? "Finish voice input first."
            : isSubmitting
              ? "Submitting..."
              : hasSubmittableInput
                ? "This composer can't submit right now."
                : "Type a message first."));

  const composerEditorState = useMemo<ComposerEditorState>(
    () => ({
      layout: composerLayout,
      isRunning,
      isSubmitting,
      isSubmittingBlocked: !canSubmit,
      submittingBlockedReason,
      isAttaching,
      attachmentError,
    }),
    [
      attachmentError,
      canSubmit,
      composerLayout,
      isAttaching,
      isRunning,
      isSubmitting,
      submittingBlockedReason,
    ],
  );

  const insertAtCursorForPlugin = useCallback(
    (value: ComposerEditorInsertValue, block: boolean) => {
      const currentEditor = editorRef.current;

      if (!currentEditor || currentEditor.isDestroyed) return false;
      const insertion = currentEditor.chain();

      if (!isPointerCoarse) insertion.focus();
      insertion
        .insertContent(
          block
            ? promptEditorContentFromValue(value)
            : promptEditorInlineContentFromValue(value),
        )
        .run();

      if (!isPointerCoarse) scheduleRevealEditorSelection();

      return true;
    },
    [isPointerCoarse, scheduleRevealEditorSelection],
  );

  const composerEditorBridge = useMemo<ComposerEditorBridge | null>(
    () =>
      pluginComposerHost === null
        ? null
        : {
            host: pluginComposerHost,
            pluginCustomizable: !suppressPluginComposerCustomizations,
            state: composerEditorState,
            insertAtCursor: insertAtCursorForPlugin,
            openPopup: openPopupForPlugin,
            closePopup: closePopupForPlugin,
            isPopupOpen: () => {
              const current = composerMenuRef.current;

              return (
                current?.kind === "plugin" &&
                current.open &&
                popups.some((popup) => popup.key === current.key)
              );
            },
          },
    [
      composerEditorState,
      insertAtCursorForPlugin,
      openPopupForPlugin,
      closePopupForPlugin,
      popups,
      pluginComposerHost,
      suppressPluginComposerCustomizations,
    ],
  );

  const publishedComposerEditorBridgeRef = useRef<{
    key: string;
    bridge: ComposerEditorBridge;
  } | null>(null);

  useLayoutEffect(() => {
    const previous = publishedComposerEditorBridgeRef.current;

    if (previous !== null && previous.key !== composerEditorKey) {
      clearComposerEditorBridge(previous.key, previous.bridge);
    }

    if (composerEditorKey === null || composerEditorBridge === null) {
      publishedComposerEditorBridgeRef.current = null;

      return;
    }

    publishComposerEditorBridge(composerEditorKey, composerEditorBridge);
    publishedComposerEditorBridgeRef.current = {
      key: composerEditorKey,
      bridge: composerEditorBridge,
    };
  }, [composerEditorBridge, composerEditorKey]);
  useEffect(
    () => () => {
      const published = publishedComposerEditorBridgeRef.current;

      if (published !== null) {
        clearComposerEditorBridge(published.key, published.bridge);
      }
    },
    [],
  );

  const showStop = Boolean(
    isRunning && onStop && !canSubmit && !isAttaching && !showVoiceActionGroup,
  );

  const canStartVoiceInput =
    voice !== undefined && voice.isSupported && !isSubmitting;

  const showVoiceAsPrimaryAction =
    isPointerCoarse &&
    !isAttaching &&
    !hasSubmittableInput &&
    !canSendSuggestion &&
    canStartVoiceInput;

  const showCompactVoiceAction =
    showCompactLayout &&
    canStartVoiceInput &&
    (!showVoiceAsPrimaryAction || showStop);

  const handleVoicePointerDown = useCallback(
    (event: ReactPointerEvent<HTMLButtonElement>) => {
      if (!isPointerCoarse || event.button !== 0) return;

      event.preventDefault();
    },
    [isPointerCoarse],
  );

  const startVoiceInput = useCallback(() => {
    if (isPointerCoarse) {
      const currentEditor = editorRef.current;

      if (currentEditor && !currentEditor.isDestroyed) {
        blurActiveKeyboardInputWithin(currentEditor.view.dom);
      }
    }

    void voice?.start();
  }, [isPointerCoarse, voice]);

  const cancelVoiceInput = useCallback(() => {
    if (voiceActionRevealFrameRef.current !== null) {
      window.cancelAnimationFrame(voiceActionRevealFrameRef.current);
      voiceActionRevealFrameRef.current = null;
    }

    setVoiceActionTransition("exiting");
    voice?.cancel();
  }, [voice]);

  const attachmentUploadTitle = "Uploading attachments...";

  const effectiveSubmitTitle = uploadsBlockSubmission
    ? attachmentUploadTitle
    : !canSubmit && submitDisabledReason
      ? submitDisabledReason
      : submitTitle;

  const sendSuggestion = useCallback(() => {
    const host = pluginComposerHost;

    if (
      !suggestionSendable ||
      readySuggestion === null ||
      host?.submitDraft === undefined
    )
      return;
    const reservation = host.reserveSubmission?.();
    const sent = { key: host.textEffectKey, text: readySuggestion.text };
    shellHaptic("impact-light");
    setSentSuggestion(sent);

    void host
      .submitDraft(
        { ...emptyPromptDraftState(), text: sent.text },
        { experimental_data: null },
        undefined,
        reservation,
      )
      .catch((error: unknown) => {
        setSentSuggestion((current) => (current === sent ? null : current));
        appToast.error(
          error instanceof Error
            ? error.message
            : "Couldn't send the suggestion.",
        );
      })
      .finally(() => reservation?.cancel());
  }, [pluginComposerHost, readySuggestion, suggestionSendable]);

  const submitPrompt = useCallback(() => {
    const shouldBlurAfterSubmit = blurAfterPointerSubmitRef.current;
    blurAfterPointerSubmitRef.current = false;

    if (!canPrimarySubmit) return;
    setSuggestionEngagedKey(null);

    if (editorRef.current) cancelPromptThreadLinkPaste(editorRef.current);
    onSubmit?.();
    shellHaptic("impact-light");

    if (shouldBlurAfterSubmit) {
      blurPromptEditor(editorRef.current);
    }
  }, [canPrimarySubmit, onSubmit]);

  useEffect(() => {
    if (
      voiceSubmitBaseline === null ||
      showVoiceActionGroup ||
      value === voiceSubmitBaseline
    )
      return;
    setVoiceSubmitBaseline(null);

    if (canSubmit) submitPrompt();
  }, [
    voiceSubmitBaseline,
    showVoiceActionGroup,
    value,
    canSubmit,
    submitPrompt,
  ]);

  const handleSubmitClick = useCallback(
    (event: ReactMouseEvent<HTMLButtonElement>) => {
      blurAfterPointerSubmitRef.current =
        blurOnPointerSubmit && event.detail > 0;
    },
    [blurOnPointerSubmit],
  );

  const handleTouchSubmit = useCallback(() => {
    if (canSendSuggestion) {
      sendSuggestion();

      return;
    }

    blurAfterPointerSubmitRef.current = blurOnPointerSubmit;
    submitPrompt();
  }, [blurOnPointerSubmit, canSendSuggestion, sendSuggestion, submitPrompt]);

  const handleSubmitPointerDown = useCallback(
    (event: ReactPointerEvent<HTMLButtonElement>) => {
      if (event.button !== 0) return;

      if (isPointerCoarse) {
        event.preventDefault();

        return;
      }

      const currentEditor = editorRef.current;
      const editorElement = currentEditor?.view.dom;
      const activeElement = editorElement?.ownerDocument.activeElement;

      if (
        !currentEditor ||
        currentEditor.isDestroyed ||
        !editorElement?.contains(activeElement ?? null)
      ) {
        return;
      }

      event.preventDefault();
    },
    [isPointerCoarse],
  );

  const [pendingCommandSubmit, setPendingCommandSubmit] = useState(false);
  useEffect(() => {
    if (!pendingCommandSubmit) return;
    setPendingCommandSubmit(false);
    submitPrompt();
  }, [pendingCommandSubmit, submitPrompt]);

  const submitModifierPrompt = useCallback(() => {
    if (!canModifierSubmit || !onModifierSubmit) return;

    if (editorRef.current) cancelPromptThreadLinkPaste(editorRef.current);
    onModifierSubmit({ sendNow: true });
    shellHaptic("impact-light");
  }, [canModifierSubmit, onModifierSubmit]);

  const applyHistoryDraft = useCallback(
    (draft: PromptDraftState) => {
      if (!history) {
        return;
      }

      history.onSelectEntry(draft);
      requestAnimationFrame(() => {
        const currentEditor = editorRef.current;

        if (!currentEditor || currentEditor.isDestroyed) {
          return;
        }

        focusEditorAtEnd(currentEditor);
        syncTriggerState(currentEditor);
        scheduleRevealEditorSelection();
      });
    },
    [history, scheduleRevealEditorSelection, syncTriggerState],
  );

  const collapsePromptBox = useCallback(() => {
    if (!onCollapse) return;
    capturePromptBoxHeight();
    blurPromptEditor(editorRef.current);
    onCollapse();
  }, [capturePromptBoxHeight, onCollapse]);

  const handleAttachmentInputChange = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => {
      const fileList = event.target.files;

      if (!fileList || fileList.length === 0) return;
      attachFilesWithHistory(Array.from(fileList));
      event.target.value = "";
    },
    [attachFilesWithHistory],
  );

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();

    if (canSendSuggestion) {
      sendSuggestion();

      return;
    }

    submitPrompt();
  };

  const handlePromptBoxMouseDown = useCallback(
    (event: PromptBoxMouseDownEvent) => {
      if (!isPromptBoxChromeTarget(event.target)) return;

      const currentEditor = editorRef.current;

      if (!currentEditor || currentEditor.isDestroyed) return;

      event.preventDefault();
      engageSuggestion();
      focusEditorAtEnd(currentEditor);
      scheduleRevealEditorSelection();
    },
    [engageSuggestion, scheduleRevealEditorSelection],
  );

  const handleEditorKeyDown = useCallback(
    (event: KeyboardEvent, isOriginalIPadHardwareEnter = false): boolean => {
      if (
        event.isComposing ||
        event.keyCode === 229 ||
        postCompositionKeyDownEvents.has(event)
      ) {
        return false;
      }

      if (dispatchAppCommandKey(event) || handleComposerMenuKeyDown(event)) {
        return true;
      }

      if (
        suggestion !== null &&
        suggestionAvailable &&
        !event.altKey &&
        !event.ctrlKey &&
        !event.metaKey &&
        !event.shiftKey
      ) {
        if (event.key === "Tab" && readySuggestion !== null) {
          event.preventDefault();
          insertSuggestion();

          return true;
        }

        if (event.key === "Escape" && !event.defaultPrevented) {
          event.preventDefault();
          suggestion.onDismiss();

          return true;
        }
      }

      const canSubmitWithEnterKey =
        !isPointerCoarse || isOriginalIPadHardwareEnter;

      const currentEditor = editorRef.current;
      const selection = currentEditor?.state.selection;
      const hasCollapsedSelection = Boolean(selection?.empty);

      const hasArrowNavigationModifier =
        event.shiftKey || event.altKey || event.metaKey || event.ctrlKey;

      const hasCursorAtEnd =
        hasCollapsedSelection &&
        currentEditor !== null &&
        currentEditor !== undefined &&
        selection !== undefined &&
        selection.from >= currentEditor.state.doc.content.size - 1;

      const activeHistoryEntry =
        history && activeHistoryIndex !== null
          ? history.entries[activeHistoryIndex]
          : null;

      const hasSelectedHistoryEntry = Boolean(
        history &&
        activeHistoryEntry !== null &&
        activeHistoryEntry !== undefined &&
        arePromptDraftStatesEqual(history.currentDraft, activeHistoryEntry),
      );

      const canNavigateHistory =
        history !== undefined &&
        !hasArrowNavigationModifier &&
        hasCursorAtEnd &&
        (isPromptDraftEmpty(history.currentDraft) || hasSelectedHistoryEntry);

      const canNavigateTypeahead =
        showTypeaheadMenu && !hasArrowNavigationModifier && !canNavigateHistory;

      if (showTypeaheadMenu) {
        if (
          (event.key === "ArrowDown" || event.key === "ArrowUp") &&
          canNavigateTypeahead &&
          (activeSuggestions.length > 0 || canFindSkills)
        ) {
          event.preventDefault();
          const forward = event.key === "ArrowDown";

          if (
            forward &&
            activeTriggerKind === "command" &&
            !isFindSkillsSelected &&
            activeSuggestions.length > 0 &&
            !commandError &&
            selectedIndex >= activeSuggestions.length - 1 &&
            (commandHasMore || commandIsLoadingMore)
          ) {
            if (canLoadMoreCommands) {
              loadMoreCommands();
            }

            return true;
          }

          const count = activeSuggestions.length + (canFindSkills ? 1 : 0);

          const currentIndex = isFindSkillsSelected
            ? activeSuggestions.length
            : selectedIndex;

          const nextIndex = (currentIndex + (forward ? 1 : -1) + count) % count;
          const nextSuggestion = activeSuggestions[nextIndex];

          setSelectedSuggestionKey(
            nextSuggestion
              ? typeaheadSuggestionKey(nextSuggestion)
              : FIND_SKILLS_SUGGESTION_KEY,
          );

          return true;
        }

        if (
          (event.key === "Enter" || event.key === "Tab") &&
          isFindSkillsSelected
        ) {
          event.preventDefault();
          openFindSkills();

          return true;
        }

        if (
          (event.key === "Enter" || event.key === "Tab") &&
          activeSuggestions.length > 0
        ) {
          event.preventDefault();

          const selected =
            activeSuggestions[selectedIndex] ?? activeSuggestions[0];

          if (selected) {
            applyTrigger(selected);

            if (
              event.key === "Enter" &&
              selected.kind === "command" &&
              selected.origin === "builtin"
            ) {
              setPendingCommandSubmit(true);
            }
          }

          return true;
        }
      }

      if (event.key === "Escape") {
        if (event.defaultPrevented) return true;

        if (onEscape) {
          onEscape();

          return true;
        }

        blurPromptEditor(currentEditor);

        return true;
      }

      if (history) {
        if (
          event.key === "ArrowUp" &&
          canNavigateHistory &&
          history.entries.length > 0
        ) {
          event.preventDefault();

          const nextHistoryIndex =
            activeHistoryIndex === null
              ? 0
              : Math.min(activeHistoryIndex + 1, history.entries.length - 1);

          hasActiveHistorySessionRef.current = true;

          if (activeHistoryIndex === null) {
            setTemporaryHistoryDraft(history.currentDraft);
          }

          setActiveHistoryIndex(nextHistoryIndex);
          const nextDraft = history.entries[nextHistoryIndex];
          setRecalledHistoryDraft(nextDraft);
          applyHistoryDraft(nextDraft);

          return true;
        }

        if (
          event.key === "ArrowDown" &&
          canNavigateHistory &&
          activeHistoryIndex !== null
        ) {
          event.preventDefault();

          if (activeHistoryIndex === 0) {
            if (temporaryHistoryDraft) {
              applyHistoryDraft(temporaryHistoryDraft);
            }

            resetHistorySession();

            return true;
          }

          const nextHistoryIndex = activeHistoryIndex - 1;
          setActiveHistoryIndex(nextHistoryIndex);
          const nextDraft = history.entries[nextHistoryIndex];
          setRecalledHistoryDraft(nextDraft);
          applyHistoryDraft(nextDraft);

          return true;
        }
      }

      if (isModifierSubmitKeyEvent(event) && onModifierSubmit) {
        event.preventDefault();
        submitModifierPrompt();

        return true;
      }

      const isBlockquoteExitKey =
        event.key === "Enter" &&
        event.shiftKey &&
        !event.metaKey &&
        !event.altKey &&
        !event.ctrlKey;

      if (
        isBlockquoteExitKey &&
        currentEditor &&
        (insertParagraphBeforeBlockquote(currentEditor) ||
          exitTrailingBlockquoteBreak(currentEditor))
      ) {
        event.preventDefault();

        return true;
      }

      const isPromptNewlineKey =
        event.key === "Enter" &&
        !event.metaKey &&
        !event.altKey &&
        !event.ctrlKey &&
        (event.shiftKey || !canSubmitWithEnterKey);

      if (
        isPromptNewlineKey &&
        currentEditor &&
        applyPromptParagraphNewline(currentEditor)
      ) {
        event.preventDefault();

        return true;
      }

      if (!canSubmitWithEnterKey) return false;
      const isSubmitKey = event.key === "Enter" && !event.shiftKey;

      if (!isSubmitKey) return false;
      event.preventDefault();
      submitPrompt();

      return true;
    },
    [
      activeHistoryIndex,
      activeSuggestions,
      activeTriggerKind,
      applyHistoryDraft,
      applyTrigger,
      canFindSkills,
      canLoadMoreCommands,
      commandError,
      commandHasMore,
      commandIsLoadingMore,
      dispatchAppCommandKey,
      handleComposerMenuKeyDown,
      history,
      insertSuggestion,
      isFindSkillsSelected,
      isPointerCoarse,
      loadMoreCommands,
      onEscape,
      onModifierSubmit,
      openFindSkills,
      postCompositionKeyDownEvents,
      resetHistorySession,
      selectedIndex,
      readySuggestion,
      setPendingCommandSubmit,
      showTypeaheadMenu,
      submitModifierPrompt,
      submitPrompt,
      suggestion,
      suggestionAvailable,
      temporaryHistoryDraft,
    ],
  );

  useLayoutEffect(() => {
    handleEditorKeyDownRef.current = handleEditorKeyDown;
  }, [handleEditorKeyDown]);

  useEffect(() => {
    if (!showVoiceActionGroup || !voice) return;

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      cancelVoiceInput();
    };

    window.addEventListener("keydown", handleKeyDown, true);

    return () => window.removeEventListener("keydown", handleKeyDown, true);
  }, [cancelVoiceInput, showVoiceActionGroup, voice]);

  const suggestionCard =
    suggestionCardMode && suggestionVisible && suggestion !== null ? (
      <ComposerSuggestionCard
        suggestion={suggestion}
        animate={suggestionReveal.animate}
        send={
          pluginComposerHost?.submitDraft === undefined
            ? null
            : {
                blockedReason: suggestionSendBlockedReason,
                onSend: sendSuggestion,
              }
        }
        onEdit={insertSuggestion}
      />
    ) : null;

  const editorSlot = (
    <ComposerEditorSlot
      editor={editor}
      scrollContainerRef={editorScrollContainerRef}
      inputLocked={composerInputLocked}
      isCompactLayout={showCompactLayout}
      isEmpty={value.length === 0}
      minHeight={minHeight}
      layout={editorLayout}
      resolveMentionLink={resolveEditorMentionLink}
      leadingInset={leading !== undefined}
      suggestion={
        suggestionOverlayShown && suggestion !== null ? (
          <ComposerSuggestion
            suggestion={suggestion}
            engaged={suggestionEngaged}
            touch={isPointerCoarse}
            onInsert={insertSuggestion}
          />
        ) : null
      }
      animateSuggestion={suggestionReveal.animate}
      onPointerDown={handleEditorScrollPointerDown}
    />
  );

  return (
    <PromptImageAnchorContext.Provider value={imageAnchorContext}>
      <form
        ref={formRef}
        data-promptbox=""
        data-promptbox-compact={showCompactLayout ? "" : undefined}
        data-promptbox-voice-active={showVoiceActionGroup ? "" : undefined}
        onSubmit={handleSubmit}
        onKeyDown={(event) => handleComposerMenuKeyDown(event.nativeEvent)}
        onMouseDown={handlePromptBoxMouseDown}
        onDragOver={(event) => {
          if (!onAttachFiles) return;
          event.preventDefault();
        }}
        onDrop={(event) => {
          if (!onAttachFiles) return;
          event.preventDefault();

          if (
            !event.dataTransfer?.files ||
            event.dataTransfer.files.length === 0
          )
            return;
          const files = Array.from(event.dataTransfer.files);
          const nativeResolver = getNativeFileResolver();

          if (nativeResolver === null) {
            attachFilesWithHistory(
              files,
              undefined,
              editorRef.current?.view.posAtCoords({
                left: event.clientX,
                top: event.clientY,
              })?.pos,
            );

            return;
          }

          if (nativeFilesPendingRef.current) {
            appToast.error("Wait a moment, then drop the files again.");

            return;
          }

          const editor = editorRef.current;

          if (editor === null || editor.isDestroyed) return;
          nativeFilesPendingRef.current = true;
          const doc = editor.state.doc;
          const selection = editor.state.selection;
          const activeElement = document.activeElement;
          const href = window.location.href;
          const draftKey = attachmentDraftKeyRef.current;
          const targetHostId = attachmentTargetHostIdRef.current;

          const position =
            editor.view.posAtCoords({ left: event.clientX, top: event.clientY })
              ?.pos ?? editor.state.doc.content.size;

          void nativeResolver
            .resolve(files)
            .then((classifications) => {
              if (
                editor.isDestroyed ||
                editorRef.current !== editor ||
                !editor.state.doc.eq(doc) ||
                !editor.state.selection.eq(selection) ||
                document.activeElement !== activeElement ||
                window.location.href !== href ||
                attachmentDraftKeyRef.current !== draftKey ||
                attachmentTargetHostIdRef.current !== targetHostId
              ) {
                appToast.error("The draft changed. Drop the files again.");

                return;
              }

              const resolved = partitionNativeFiles(files, classifications);

              for (const file of resolved.files)
                nativeFilePathsRef.current.set(
                  file,
                  resolved.paths.get(file) ?? null,
                );

              if (resolved.directories.length > 0) {
                editor
                  .chain()
                  .focus()
                  .setTextSelection(position)
                  .insertContent(
                    promptEditorInlineContentFromValue({
                      text: resolved.directories.join("\n"),
                      mentions: [],
                    }),
                  )
                  .setMeta("uiEvent", "paste")
                  .run();
              }

              attachFilesWithHistoryRef.current(
                resolved.files,
                undefined,
                resolved.directories.length > 0 ? undefined : position,
              );
            })
            .catch(() =>
              appToast.error(
                "The files could not be resolved. Drop them again.",
              ),
            )
            .finally(() => {
              nativeFilesPendingRef.current = false;
            });
        }}
        className={cn(
          "group/promptbox relative w-full rounded-[20px] md:rounded-[14px]",
          surface === "raised" &&
            "bg-(--material-raised) shadow-(--material-shadow-raised)",
          showCompactLayout && "overflow-hidden",
        )}
      >
        <input
          ref={attachmentInputRef}
          type="file"
          multiple
          className="hidden"
          onChange={handleAttachmentInputChange}
        />
        {modeHeader ? (
          <div
            inert={showVoiceActionGroup ? true : undefined}
            className="px-3 pt-1.5"
          >
            {modeHeader}
          </div>
        ) : null}
        {suggestionCard}
        <div
          data-promptbox-layout=""
          className={cn("grid", showCompactLayout && "relative")}
          style={{ gridTemplateRows: "1fr" }}
        >
          <div
            data-promptbox-main=""
            className={cn(
              "min-h-0 overflow-hidden",
              showCompactLayout && "relative flex h-12 items-center",
              showVoiceActionGroup && "pointer-events-none",
            )}
          >
            {header && !showCompactLayout ? (
              <div
                data-promptbox-expanded-only=""
                inert={showVoiceActionGroup ? true : undefined}
                className="pl-4 pr-14 pt-3"
              >
                {header}
              </div>
            ) : null}
            {showCompactLayout ? (
              <AttachmentPreview
                compact
                attachments={orderedAttachments}
                pendingUploads={pendingUploads}
                attachmentProjectId={attachmentProjectId}
                expandedImageIndex={expandedImageIndex}
                onExpandedImageIndexChange={setExpandedImageIndex}
                onRemoveAttachment={
                  onUpdateAttachments ? removeAttachment : undefined
                }
              />
            ) : null}
            <div
              data-promptbox-input-region=""
              aria-hidden={
                showCompactLayout && showVoiceActionGroup ? true : undefined
              }
              className={cn(
                "relative",
                showCompactLayout && "min-w-0 flex-1",
                showCompactLayout && showVoiceActionGroup && "invisible",
              )}
            >
              {!showCompactLayout ? (
                <>
                  <div data-promptbox-expanded-only="">
                    <AppCommandShortcutHint
                      shortcut={focusComposerShortcut}
                      className={cn(
                        "absolute top-2 z-20 group-focus-within/promptbox:hidden",
                        onCollapse ? "right-10" : "right-2",
                      )}
                    />
                  </div>
                  {onCollapse ? (
                    <div
                      data-promptbox-expanded-only=""
                      data-promptbox-standard-actions=""
                      inert={showVoiceActionGroup ? true : undefined}
                      className="absolute right-[13px] top-2 z-20 flex items-center"
                    >
                      <Button
                        type="button"
                        size="icon"
                        variant="ghost"
                        onMouseDown={(event) => {
                          event.preventDefault();
                        }}
                        onClick={collapsePromptBox}
                        aria-label="Collapse prompt box"
                        className={cn(
                          CHROME_SUBTLE_ICON_BUTTON_FOREGROUND_CLASS,
                          COARSE_POINTER_PROMPT_ICON_ACTION_BUTTON_CLASS,
                          PROMPT_STACK_EDGE_CARET_BUTTON_WIDTH_CLASS,
                        )}
                      >
                        <Icon name="ChevronDown" className="size-3.5" />
                      </Button>
                    </div>
                  ) : null}
                </>
              ) : null}
              {leading === undefined ? (
                editorSlot
              ) : (
                <div className="flex min-w-0 items-start">
                  <div
                    data-promptbox-leading=""
                    className="mt-3 flex h-7 shrink-0 items-center pl-4"
                  >
                    {leading}
                  </div>
                  <div className="min-w-0 flex-1">{editorSlot}</div>
                </div>
              )}
            </div>

            <PluginComposerViewProvider value={composerView}>
              <ComposerCommandOwnerProvider value={ownsCommandTarget}>
                {onFocusCommand !== undefined ? (
                  <ComposerCommand
                    command="composer.focus"
                    run={onFocusCommand}
                  />
                ) : null}
                {pluginComposerHost !== null &&
                !suppressPluginComposerCustomizations ? (
                  <PluginComposerCommands />
                ) : null}
              </ComposerCommandOwnerProvider>
              <ComposerPopupHost
                open={composerMenuOpen}
                placement={mentionMenuPlacement}
                label={popupContribution?.popup.label ?? "Suggestions"}
                interactive={popupContribution !== null}
                popupKey={popupContribution?.key ?? null}
                popupRef={typeaheadMenuRef}
                composerRef={formRef}
                onClose={dismissComposerMenu}
              >
                {popupContribution !== null ? (
                  <PluginComposerPopup
                    key={popupContribution.key}
                    contribution={popupContribution}
                    initialSkillQuery={
                      composerMenu?.kind === "plugin"
                        ? composerMenu.initialSkillQuery
                        : undefined
                    }
                    onClose={() => dismissComposerMenu(true)}
                  />
                ) : (
                  <MentionMenu
                    state={typeaheadMenuState}
                    commandErrorMessage={commandErrorMessage}
                    selectedIndex={isFindSkillsSelected ? -1 : selectedIndex}
                    findSkills={
                      canFindSkills
                        ? {
                            selected: isFindSkillsSelected,
                            open: openFindSkills,
                          }
                        : undefined
                    }
                    onApply={applyTrigger}
                    onDismiss={
                      isPointerCoarse ? dismissComposerMenu : undefined
                    }
                    onCommandLoadMore={
                      canLoadMoreCommands ? loadMoreCommands : undefined
                    }
                  />
                )}
              </ComposerPopupHost>
            </PluginComposerViewProvider>

            {!showCompactLayout ? (
              <>
                <div
                  data-promptbox-expanded-only=""
                  inert={showVoiceActionGroup ? true : undefined}
                >
                  <AttachmentPreview
                    attachments={orderedAttachments}
                    pendingUploads={pendingUploads}
                    attachmentProjectId={attachmentProjectId}
                    expandedImageIndex={expandedImageIndex}
                    onExpandedImageIndexChange={setExpandedImageIndex}
                    onRemoveAttachment={
                      onUpdateAttachments ? removeAttachment : undefined
                    }
                  />

                  {attachmentError || hasUnclearImages ? (
                    <div className="mx-3 mb-1 mt-1 text-xs text-destructive">
                      {attachmentError ?? UNCLEAR_IMAGE_MESSAGE}
                    </div>
                  ) : null}
                </div>
              </>
            ) : null}

            <PluginComposerViewProvider value={composerView}>
              <div
                data-promptbox-action-row=""
                className={cn(
                  "relative flex min-w-0 shrink-0 select-none flex-row flex-nowrap items-center gap-1 pb-2 pl-3.5 pr-[13px] pt-1.5",
                  !showCompactLayout &&
                    "max-md:flex-nowrap max-md:gap-1 max-md:px-1.5 max-md:pb-1.5 max-md:pt-0",
                  showCompactLayout && "flex-nowrap gap-0 p-0 pr-2",
                  showCompactLayout &&
                    showVoiceActionGroup &&
                    "absolute inset-0",
                )}
              >
                {voice && isVoiceActionPresent ? (
                  <div
                    data-promptbox-voice-controls=""
                    data-voice-transition={voiceActionTransition}
                    inert={isVoiceActionVisible ? undefined : true}
                    aria-hidden={isVoiceActionVisible ? undefined : true}
                    className={cn(
                      "absolute inset-0 z-10 min-w-0 origin-center transition-[opacity,translate,scale] will-change-[opacity,transform] motion-reduce:transition-none",
                      isVoiceActionVisible
                        ? "pointer-events-auto translate-y-0 scale-100 opacity-100 duration-(--motion-duration-base)"
                        : "pointer-events-none translate-y-1 scale-[0.985] opacity-0 duration-(--motion-duration-fast)",
                    )}
                  >
                    <VoiceRecordingBar
                      isCompact={showCompactLayout}
                      state={renderedVoiceActionState}
                      stream={voice.stream}
                      microphoneWarning={voice.microphoneWarning}
                      submitIcon={submitIcon ?? "ArrowUp"}
                      onConfirm={voice.stop}
                      onSend={voice.send}
                      onCancel={cancelVoiceInput}
                    />
                  </div>
                ) : null}
                {!showCompactLayout ? (
                  <div
                    data-promptbox-expanded-only=""
                    data-promptbox-standard-actions=""
                    className={cn(
                      "flex min-w-0 max-w-[60%] flex-initial flex-row flex-nowrap items-center gap-1 transition-[opacity,translate] motion-reduce:transition-none",
                      showVoiceActionGroup
                        ? "pointer-events-none translate-y-1 opacity-0 duration-(--motion-duration-fast)"
                        : "translate-y-0 opacity-100 duration-(--motion-duration-base)",
                    )}
                    inert={showVoiceActionGroup ? true : undefined}
                    aria-live="polite"
                  >
                    {plusMenu === "inline" ? (
                      <ComposerPlusMenuSlot
                        actions={promptActions}
                        chat={chatMenu}
                        onAttach={
                          onAttachFiles
                            ? () => attachmentInputRef.current?.click()
                            : undefined
                        }
                        onAction={applyPromptAction}
                      />
                    ) : null}
                    {footerStart}
                  </div>
                ) : null}
                <div
                  data-promptbox-standard-actions=""
                  className={cn(
                    "ml-auto flex min-w-0 flex-1 flex-row flex-nowrap items-center justify-end gap-1 transition-[opacity,translate] motion-reduce:transition-none max-md:flex-nowrap max-md:gap-0",
                    showCompactLayout && "max-w-full flex-none",
                    showVoiceActionGroup
                      ? "pointer-events-none translate-y-1 opacity-0 duration-(--motion-duration-fast)"
                      : "translate-y-0 opacity-100 duration-(--motion-duration-base)",
                  )}
                  inert={showVoiceActionGroup ? true : undefined}
                >
                  {showCompactLayout ? (
                    submitAccessory
                  ) : (
                    <ComposerRailExtras>
                      <ComposerActionsSlot
                        includePluginContributions={
                          !suppressPluginComposerCustomizations
                        }
                      >
                        {submitAccessory}
                      </ComposerActionsSlot>
                    </ComposerRailExtras>
                  )}
                  {!showCompactLayout || showCompactVoiceAction ? (
                    <>
                      {voice &&
                      !showVoiceActionGroup &&
                      (!showVoiceAsPrimaryAction || showStop) ? (
                        <VoiceInputButton
                          warning={voice?.microphoneWarning ?? null}
                          data-promptbox-expanded-only={
                            showCompactLayout ? undefined : ""
                          }
                          type="button"
                          size="icon"
                          variant="ghost"
                          aria-label={
                            !voice.isSupported
                              ? voiceUnsupportedMessage(
                                  voice.unsupportedReason ?? null,
                                )
                              : "Start voice input"
                          }
                          disabled={!canStartVoiceInput}
                          onPointerDown={handleVoicePointerDown}
                          onClick={startVoiceInput}
                          className={
                            showCompactLayout
                              ? COMPACT_PROMPT_ACTION_BUTTON_CLASS
                              : COMPOSER_TOOL_BUTTON_CLASS
                          }
                        >
                          <Icon name="Mic" className="size-4" />
                        </VoiceInputButton>
                      ) : null}
                    </>
                  ) : null}
                  <div
                    data-promptbox-submit-group=""
                    className="flex shrink-0 flex-row items-center"
                  >
                    {showStop ? (
                      <Button
                        data-promptbox-submit-action=""
                        type="button"
                        size="icon"
                        variant="secondary"
                        aria-label="Stop run"
                        onClick={onStop}
                        className={cn(
                          showCompactLayout
                            ? COMPACT_PROMPT_SEND_BUTTON_CLASS
                            : ["ml-1", COMPOSER_SEND_BUTTON_CLASS],
                          "bg-surface-recessed text-foreground hover:bg-state-active",
                        )}
                      >
                        <Icon
                          name="Square"
                          className="size-3.5 fill-current [&_*]:stroke-0"
                        />
                      </Button>
                    ) : showVoiceAsPrimaryAction ? (
                      <VoiceInputButton
                        warning={voice?.microphoneWarning ?? null}
                        data-promptbox-submit-action=""
                        type="button"
                        size={showCompactLayout ? "icon" : "sm"}
                        variant="default"
                        aria-label="Start voice input"
                        onPointerDown={handleVoicePointerDown}
                        onClick={startVoiceInput}
                        className={cn(
                          showCompactLayout
                            ? COMPACT_PROMPT_SEND_BUTTON_CLASS
                            : ["ml-1", COMPOSER_SEND_BUTTON_CLASS],
                        )}
                      >
                        <Icon name="Mic" className="size-4" />
                      </VoiceInputButton>
                    ) : (
                      <ComposerSendMenu
                        actions={canSubmit ? menuActions : undefined}
                        isPointerCoarse={isPointerCoarse}
                        includePluginContributions={
                          !suppressPluginComposerCustomizations
                        }
                        queue={swapSubmitActions}
                        hasInput={hasSubmittableInput}
                        canSubmit={canSubmit}
                        canSend={canSubmit || canSendSuggestion}
                        onSubmit={
                          showModifierSubmitAction && onModifierSubmit
                            ? submitModifierPrompt
                            : undefined
                        }
                      >
                        <PromptSubmitButton
                          canSubmit={canSubmit || canSendSuggestion}
                          icon={submitIcon}
                          label={canSendSuggestion ? undefined : submitLabel}
                          className={cn(
                            showCompactLayout
                              ? COMPACT_PROMPT_SEND_BUTTON_CLASS
                              : ["ml-1", COMPOSER_SEND_BUTTON_CLASS],
                          )}
                          disabledReason={
                            !canSubmit && !canSendSuggestion
                              ? uploadsBlockSubmission
                                ? attachmentUploadTitle
                                : submitDisabledReason
                              : undefined
                          }
                          isBusy={isSubmitting || uploadsBlockSubmission}
                          isCompact={showCompactLayout}
                          onPointerDown={handleSubmitPointerDown}
                          onClick={handleSubmitClick}
                          onTouchSubmit={handleTouchSubmit}
                          title={
                            canSendSuggestion
                              ? "Send suggestion"
                              : effectiveSubmitTitle
                          }
                        />
                      </ComposerSendMenu>
                    )}
                  </div>
                </div>
              </div>
            </PluginComposerViewProvider>
          </div>
        </div>
      </form>
    </PromptImageAnchorContext.Provider>
  );
}
