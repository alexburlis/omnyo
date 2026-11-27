import { useRef, type MouseEvent, type ReactNode } from "react";
import {
  experimental_Icon as Icon,
  experimental_ThreadActionsContextMenu as ThreadActionsContextMenu,
  experimental_ThreadActionsMenu as ThreadActionsMenu,
  experimental_useThreadActions,
} from "@omnyo/plugin-sdk/app";
import type {
  PluginSidebarThread,
  PluginThreadActionTarget,
  PluginThreadActionsInlineItem,
  PluginThreadActionsTriggerProps,
} from "@omnyo/plugin-sdk/app";

function actionTarget(thread: PluginSidebarThread): PluginThreadActionTarget {
  return {
    ...thread,
    environment: thread.environment?.id
      ? { id: thread.environment.id, path: thread.environment.path }
      : null,
    shelvedAt: thread.experimental_shelvedAt ?? null,
  };
}

function useMenuRename(onRename: (() => void) | undefined) {
  const pending = useRef<(() => void) | null>(null);

  if (onRename === undefined) return { requestRename: undefined, onCloseAutoFocus: undefined };

  return {
    requestRename: () => {
      pending.current = onRename;
    },
    onCloseAutoFocus: (event: Event) => {
      const begin = pending.current;

      if (begin === null) return;
      pending.current = null;
      event.preventDefault();
      begin();
    },
  };
}

interface ChatActionsMenuProps {
  thread: PluginSidebarThread;
  inline: readonly PluginThreadActionsInlineItem[];
  onOpenChange?: (open: boolean) => void;
  onRename?: () => void;
}

export function ChatActionsMenu({ thread, inline, onOpenChange, onRename }: ChatActionsMenuProps) {
  const menuRename = useMenuRename(onRename);

  return (
    <ThreadActionsMenu
      thread={actionTarget(thread)}
      inline={inline}
      side="right"
      align="start"
      sideOffset={6}
      onOpenChange={onOpenChange}
      requestRename={menuRename.requestRename}
      onCloseAutoFocus={menuRename.onCloseAutoFocus}
      trigger={({ className, ...props }: PluginThreadActionsTriggerProps) => (
        <button
          {...props}
          type="button"
          className={className === undefined ? "cg-row-menu" : `cg-row-menu ${className}`}
          aria-label={`Chat actions for ${thread.displayTitle}`}
        >
          <Icon name="MoreHorizontal" aria-hidden className="size-4" />
        </button>
      )}
    />
  );
}

interface ChatRowMenuProps {
  thread: PluginSidebarThread;
  inline?: readonly PluginThreadActionsInlineItem[];
  onOpenChange?: (open: boolean) => void;
  onRename?: () => void;
  children: ReactNode;
}

const RENAME_KEYS = ["omnyo--core/rename"];

const ROW_CONTROLS = "button, input, textarea, select, [role='button'], [contenteditable]";

const TEXT_FIELDS = "input, textarea, [contenteditable]";

function closestOf(target: EventTarget, selector: string): Element | null {
  return target instanceof Element ? target.closest(selector) : null;
}

export function ChatRowMenu({
  thread,
  inline,
  onOpenChange,
  onRename,
  children,
}: ChatRowMenuProps) {
  const target = actionTarget(thread);
  const [rename] = experimental_useThreadActions(target, { keys: RENAME_KEYS });
  const menuRename = useMenuRename(onRename);

  const renameOnDoubleClick = (event: MouseEvent<HTMLDivElement>) => {
    if (closestOf(event.target, ROW_CONTROLS) !== null) return;

    if (onRename === undefined && rename === undefined) return;
    event.preventDefault();
    event.stopPropagation();

    if (onRename !== undefined) onRename();
    else void rename?.action.run();
  };

  return (
    <ThreadActionsContextMenu
      thread={target}
      inline={inline}
      onOpenChange={onOpenChange}
      requestRename={menuRename.requestRename}
      onCloseAutoFocus={menuRename.onCloseAutoFocus}
    >
      <div
        data-chat-row-menu=""
        style={{ display: "contents" }}
        onContextMenuCapture={(event) => {
          if (closestOf(event.target, TEXT_FIELDS) !== null) event.stopPropagation();
        }}
        onDoubleClick={renameOnDoubleClick}
      >
        {children}
      </div>
    </ThreadActionsContextMenu>
  );
}
