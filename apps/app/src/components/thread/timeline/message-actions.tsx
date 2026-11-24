import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactElement,
} from "react";
import { Slot } from "@radix-ui/react-slot";
import { CompactLongPressMenu } from "@omnyo/shared-ui/compact-long-press-menu";
import {
  DropdownMenuItem,
  DropdownMenuLabel,
} from "@omnyo/shared-ui/dropdown-menu";
import { Icon, type IconName } from "@omnyo/shared-ui/icon";
import { usePointerCoarse } from "@omnyo/shared-ui/hooks/use-pointer-coarse";
import { cn } from "@omnyo/shared-ui/lib/utils";
import type { PromptDraftAttachment } from "@omnyo/client-core";
import type { PromptTextMention } from "@omnyo/domain";
import { copyToClipboardWithToast } from "@/lib/clipboard";
import { PluginItemIcon, pluginIconName } from "@/components/plugin/PluginIcon";
import type {
  ThreadTimelineAddToChatHandler,
  ThreadTimelinePluginMessageAction,
} from "./types.js";

export interface MessageAction {
  icon: IconName;
  plugin?: { pluginId: string | null; icon: string | null };
  key?: string;
  label: string;
  onSelect: () => void;
  disabled?: boolean;
  copyText?: string;
  copyImageUrl?: string;
  kind?: "copy";
}

export interface MessageActionSource {
  messageText: string;
  addToChatAttachments?: readonly PromptDraftAttachment[];
  addToChatMentions?: readonly PromptTextMention[];
  copyImageUrl?: string;
  onAddToChat?: ThreadTimelineAddToChatHandler;
  onCopyLink?: () => void;
  onEdit?: () => void;
  onFork?: () => void;
  forkDisabled?: boolean;
  pluginActions?: readonly ThreadTimelinePluginMessageAction[];
}

export const NO_MESSAGE_ACTIONS: readonly MessageAction[] = [];

export function buildMessageActions({
  messageText,
  addToChatAttachments = [],
  addToChatMentions,
  copyImageUrl,
  onAddToChat,
  onCopyLink,
  onEdit,
  onFork,
  forkDisabled,
  pluginActions = [],
}: MessageActionSource): MessageAction[] {
  const hasCopy = messageText.length > 0 || copyImageUrl !== undefined;

  const addToChat =
    onAddToChat !== undefined && (hasCopy || addToChatAttachments.length > 0)
      ? () => {
          if (addToChatMentions !== undefined && addToChatMentions.length > 0) {
            onAddToChat(
              messageText,
              addToChatAttachments.length > 0
                ? addToChatAttachments
                : undefined,
              addToChatMentions,
            );

            return;
          }

          if (addToChatAttachments.length > 0) {
            onAddToChat(messageText, addToChatAttachments);

            return;
          }

          onAddToChat(messageText);
        }
      : undefined;

  return [
    ...(hasCopy
      ? [
          {
            icon: "Copy",
            label: "Copy message",
            onSelect: () => {
              void copyToClipboardWithToast(messageText, {
                errorMessage: "Failed to copy",
                imageUrl: copyImageUrl,
              });
            },
            copyText: messageText,
            copyImageUrl,
            kind: "copy" as const,
          },
        ]
      : []),
    ...(onEdit
      ? [{ icon: "Edit", label: "Edit message", onSelect: onEdit }]
      : []),
    ...(onCopyLink
      ? [{ icon: "Link", label: "Copy link", onSelect: onCopyLink }]
      : []),
    ...(addToChat
      ? [
          {
            icon: "MessageSquarePlus",
            label: "Add to chat",
            onSelect: addToChat,
          },
        ]
      : []),
    ...(onFork
      ? [
          {
            icon: "Fork",
            label: "Fork into new thread",
            onSelect: onFork,
            disabled: forkDisabled,
          },
        ]
      : []),
    ...pluginActions.map((action) => ({
      icon: "Copy",
      plugin: { pluginId: action.pluginId, icon: action.icon },
      key: action.key,
      label: action.label,
      onSelect: action.onSelect,
    })),
  ];
}

export function MessageActionIcon({
  action,
  className,
}: {
  action: MessageAction;
  className?: string;
}) {
  if (action.plugin === undefined) {
    return <Icon name={action.icon} className={className} aria-hidden="true" />;
  }

  return action.plugin.pluginId === null ? (
    <Icon
      name={pluginIconName(action.plugin.icon)}
      className={cn("size-4 shrink-0", className)}
      aria-hidden="true"
    />
  ) : (
    <PluginItemIcon
      pluginId={action.plugin.pluginId}
      icon={action.plugin.icon}
      className={className}
    />
  );
}

export function MessageActionMenuItems({
  actions,
}: {
  actions: readonly MessageAction[];
}) {
  return actions.map((action) => (
    <DropdownMenuItem
      key={action.key ?? action.label}
      disabled={action.disabled}
      onSelect={action.onSelect}
      textValue={action.label}
    >
      <MessageActionIcon action={action} />
      {action.label}
    </DropdownMenuItem>
  ));
}

const LINK_NATIVE_CALLOUT_CLASS =
  "[&_:where(a,[role=link])]:[-webkit-touch-callout:default]";

const OWN_GESTURE_SELECTOR = [
  "a",
  "button",
  "input",
  "textarea",
  "select",
  "img",
  "video",
  '[role="button"]',
  '[role="link"]',
  '[contenteditable="true"]',
  "[data-no-message-long-press]",
].join(", ");

export function isMessageLongPressTarget(target: Element): boolean {
  return target.closest(OWN_GESTURE_SELECTOR) === null;
}

const MESSAGE_TEXT_ROOT_SELECTOR = "[data-sidebar-swipe-selectable]";

function formatSheetSentTime(timestamp: number): string {
  return `Sent ${new Date(timestamp).toLocaleString(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  })}`;
}

interface MessageTouchActionsProps {
  actions: readonly MessageAction[];
  timestamp: number;
  canSelectText: boolean;
  children: ReactElement;
}

export function MessageTouchActions(props: MessageTouchActionsProps) {
  const isPointerCoarse = usePointerCoarse();

  if (!isPointerCoarse || props.actions.length === 0) {
    return props.children;
  }

  return <MessageActionSheet {...props} />;
}

function MessageActionSheet({
  actions,
  timestamp,
  canSelectText,
  children,
}: MessageTouchActionsProps) {
  const [open, setOpen] = useState(false);
  const [selectingText, setSelectingText] = useState(false);
  const targetRef = useRef<HTMLElement>(null);

  useEffect(() => {
    if (!selectingText) return;
    const node = targetRef.current;
    const selection = window.getSelection();

    if (node === null || selection === null) {
      setSelectingText(false);

      return;
    }

    selection.selectAllChildren(
      node.querySelector(MESSAGE_TEXT_ROOT_SELECTOR) ?? node,
    );

    const endWhenDismissed = () => {
      const current = window.getSelection();

      if (
        current === null ||
        current.isCollapsed ||
        current.rangeCount === 0 ||
        !current.getRangeAt(0).intersectsNode(node)
      ) {
        setSelectingText(false);
      }
    };

    document.addEventListener("selectionchange", endWhenDismissed);

    return () => {
      document.removeEventListener("selectionchange", endWhenDismissed);
    };
  }, [selectingText]);

  const selectText = useCallback(() => setSelectingText(true), []);

  const sheetActions: readonly MessageAction[] = canSelectText
    ? [
        ...actions.slice(0, 1),
        { icon: "AlignLeft", label: "Select text", onSelect: selectText },
        ...actions.slice(1),
      ]
    : actions;

  return (
    <>
      <CompactLongPressMenu
        label="Message"
        open={open}
        onOpenChange={setOpen}
        disabled={selectingText}
        presentation="sheet"
        shouldStartPress={isMessageLongPressTarget}
        items={
          <>
            <DropdownMenuLabel>
              {formatSheetSentTime(timestamp)}
            </DropdownMenuLabel>
            <MessageActionMenuItems actions={sheetActions} />
          </>
        }
      >
        <Slot
          ref={targetRef}
          className={cn(
            LINK_NATIVE_CALLOUT_CLASS,
            !selectingText && "select-none",
          )}
          data-message-actions-target=""
        >
          {children}
        </Slot>
      </CompactLongPressMenu>
      <button
        type="button"
        className="sr-only"
        aria-haspopup="menu"
        onClick={() => setOpen(true)}
      >
        Message actions
      </button>
    </>
  );
}
