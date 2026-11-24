import {
  forwardRef,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ComponentPropsWithoutRef,
  type ReactNode,
} from "react";
import type { KeyboardCommandId } from "@omnyo/domain";
import type {
  PluginThreadActionsContextMenuProps,
  PluginThreadActionsInlineItem,
  PluginThreadActionsMenuProps,
  PluginThreadActionsTriggerProps,
  PluginThreadActionTarget,
} from "@omnyo/plugin-sdk";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuShortcut,
  ContextMenuTrigger,
} from "@omnyo/shared-ui/context-menu";
import { ActionMenuItem } from "@omnyo/shared-ui/action-menu-items";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from "@omnyo/shared-ui/dropdown-menu";
import { useIsCompactViewport } from "@omnyo/shared-ui/hooks/use-compact-viewport";
import { CompactLongPressMenu } from "@omnyo/shared-ui/compact-long-press-menu";
import {
  useAppCommandShortcut,
  useAppCommandShortcuts,
} from "@/components/commands/AppCommandProvider";
import { useThreadGroupActions } from "@/hooks/useThreadGroupActions";
import { setChatSelection, useChatSelection } from "@/lib/chat-selection";
import {
  ThreadActionMenuRows,
  useThreadActionMenuGroups,
  type ThreadActionMenuSurface,
} from "./ThreadActionMenuItems";

const MENU_LABEL = "Thread actions";

const THREAD_ACTION_COMMANDS: ReadonlyMap<string, KeyboardCommandId> = new Map([
  ["omnyo--core/copyLink", "thread.copyLink"],
  ["omnyo--core/shelve", "thread.shelve"],
  ["omnyo--core/archive", "thread.archive"],
  ["omnyo--core/rename", "thread.rename"],
]);

const THREAD_ACTION_COMMAND_IDS = [...THREAD_ACTION_COMMANDS.values()];

const NO_SHORTCUTS: ReadonlyMap<string, string> = new Map();

function useThreadActionShortcuts(
  isDrawer: boolean,
): ReadonlyMap<string, string> {
  const presentations = useAppCommandShortcuts(THREAD_ACTION_COMMAND_IDS);

  return useMemo(() => {
    if (isDrawer) return NO_SHORTCUTS;
    const labels = new Map<string, string>();

    for (const [key, command] of THREAD_ACTION_COMMANDS) {
      const presentation = presentations.get(command);

      if (presentation !== undefined) labels.set(key, presentation.label);
    }

    return labels;
  }, [isDrawer, presentations]);
}

function ThreadActionsMenuItems({
  thread,
  inline,
  requestRename,
  surface,
  isDrawer,
  drawerStep,
  onDrawerStepChange,
}: {
  thread: PluginThreadActionTarget;
  inline?: readonly PluginThreadActionsInlineItem[];
  requestRename?: (threadId: string) => void;
  surface: ThreadActionMenuSurface;
  isDrawer: boolean;
  drawerStep: string | null;
  onDrawerStepChange: (key: string | null) => void;
}) {
  const groups = useThreadActionMenuGroups({ thread, inline, requestRename });
  const shortcuts = useThreadActionShortcuts(isDrawer);

  return (
    <ThreadActionMenuRows
      groups={groups}
      shortcuts={shortcuts}
      surface={surface}
      isDrawer={isDrawer}
      drawerStep={drawerStep}
      onDrawerStepChange={onDrawerStepChange}
    />
  );
}

function ChatSelectionMenuItems({
  threadIds,
}: {
  threadIds: readonly string[];
}) {
  const { group } = useThreadGroupActions();
  const shortcut = useAppCommandShortcut("thread.group");

  return (
    <>
      <ActionMenuItem
        surface="context"
        icon="FolderPlus"
        onSelect={() => {
          void group(threadIds).catch(() => undefined);
        }}
      >
        {`Group ${threadIds.length} chats`}
        {shortcut === null ? null : (
          <ContextMenuShortcut aria-hidden="true">
            {shortcut.label}
          </ContextMenuShortcut>
        )}
      </ActionMenuItem>
      <ActionMenuItem
        surface="context"
        icon="X"
        onSelect={() => setChatSelection([])}
      >
        Clear selection
      </ActionMenuItem>
    </>
  );
}

function ThreadContextMenuItems({
  thread,
  inline,
  requestRename,
}: {
  thread: PluginThreadActionTarget;
  inline?: readonly PluginThreadActionsInlineItem[];
  requestRename?: (threadId: string) => void;
}) {
  const selection = useChatSelection();

  if (selection.length > 1 && selection.includes(thread.id)) {
    return <ChatSelectionMenuItems threadIds={selection} />;
  }

  return (
    <ThreadActionsMenuItems
      thread={thread}
      inline={inline}
      requestRename={requestRename}
      surface="context"
      isDrawer={false}
      drawerStep={null}
      onDrawerStepChange={() => {}}
    />
  );
}

function describeTriggerContractViolation(
  element: HTMLElement | null,
  hostClassName: string | undefined,
): string | null {
  if (element === null) {
    return "did not attach the ref it received, so the menu cannot open; spread its props and ref onto the button";
  }

  const missing = (hostClassName ?? "")
    .split(/\s+/)
    .filter((name) => name.length > 0 && !element.classList.contains(name));

  return missing.length === 0
    ? null
    : `dropped the host's classes (${missing.join(" ")}); merge props.className into your own className`;
}

const ThreadActionsTriggerSlot = forwardRef<
  HTMLButtonElement,
  ComponentPropsWithoutRef<"button"> & {
    render: (props: PluginThreadActionsTriggerProps) => ReactNode;
  }
>(function ThreadActionsTriggerSlot({ render, ...props }, ref) {
  const element = useRef<HTMLButtonElement | null>(null);
  const hostClassName = props.className;
  useLayoutEffect(() => {
    const problem = describeTriggerContractViolation(
      element.current,
      hostClassName,
    );

    if (problem !== null) {
      console.error(`experimental_ThreadActionsMenu: \`trigger\` ${problem}`);
    }
  }, [hostClassName]);

  return render({
    ...props,
    ref: (node: HTMLButtonElement | null) => {
      element.current = node;

      if (typeof ref === "function") ref(node);
      else if (ref !== null) ref.current = node;
    },
  });
});

function useDrawerStep(onOpenChange?: (open: boolean) => void) {
  const [drawerStep, setDrawerStep] = useState<string | null>(null);

  const handleOpenChange = useCallback(
    (open: boolean) => {
      if (!open) setDrawerStep(null);
      onOpenChange?.(open);
    },
    [onOpenChange],
  );

  return { drawerStep, setDrawerStep, handleOpenChange };
}

export function ThreadActionsMenu({
  thread,
  trigger,
  inline,
  requestRename,
  onOpenChange,
  onCloseAutoFocus,
  side,
  align = "end",
  sideOffset,
}: PluginThreadActionsMenuProps) {
  const isCompactViewport = useIsCompactViewport();

  const { drawerStep, setDrawerStep, handleOpenChange } =
    useDrawerStep(onOpenChange);

  return (
    <DropdownMenu modal={false} onOpenChange={handleOpenChange}>
      <DropdownMenuTrigger asChild>
        <ThreadActionsTriggerSlot render={trigger} />
      </DropdownMenuTrigger>
      <DropdownMenuContent
        side={side}
        align={align}
        sideOffset={sideOffset}
        mobileTitle={MENU_LABEL}
        onCloseAutoFocus={onCloseAutoFocus}
      >
        <ThreadActionsMenuItems
          thread={thread}
          inline={inline}
          requestRename={requestRename}
          surface="dropdown"
          isDrawer={isCompactViewport}
          drawerStep={drawerStep}
          onDrawerStepChange={setDrawerStep}
        />
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export function ThreadActionsContextMenu(
  props: PluginThreadActionsContextMenuProps,
) {
  const isCompactViewport = useIsCompactViewport();

  return isCompactViewport ? (
    <ThreadActionsLongPressMenu {...props} />
  ) : (
    <ThreadActionsDesktopContextMenu {...props} />
  );
}

function ThreadActionsLongPressMenu({
  thread,
  children,
  inline,
  requestRename,
  onOpenChange,
  disabled,
  dragging,
}: PluginThreadActionsContextMenuProps) {
  const { drawerStep, setDrawerStep, handleOpenChange } =
    useDrawerStep(onOpenChange);

  return (
    <CompactLongPressMenu
      label={MENU_LABEL}
      disabled={disabled}
      dragging={dragging}
      onOpenChange={handleOpenChange}
      items={
        <ThreadActionsMenuItems
          thread={thread}
          inline={inline}
          requestRename={requestRename}
          surface="dropdown"
          isDrawer
          drawerStep={drawerStep}
          onDrawerStepChange={setDrawerStep}
        />
      }
    >
      {children}
    </CompactLongPressMenu>
  );
}

function ThreadActionsDesktopContextMenu({
  thread,
  children,
  inline,
  requestRename,
  onOpenChange,
  onCloseAutoFocus,
  disabled,
  dragging = false,
}: PluginThreadActionsContextMenuProps) {
  const [open, setOpen] = useState(false);

  const handleOpenChange = useCallback(
    (nextOpen: boolean) => {
      if (nextOpen && dragging) return;
      setOpen(nextOpen);
      onOpenChange?.(nextOpen);
    },
    [dragging, onOpenChange],
  );

  useEffect(() => {
    if (dragging && open) handleOpenChange(false);
  }, [dragging, handleOpenChange, open]);

  return (
    <ContextMenu modal={false} open={open} onOpenChange={handleOpenChange}>
      <ContextMenuTrigger asChild disabled={disabled || dragging}>
        {children}
      </ContextMenuTrigger>
      <ContextMenuContent
        aria-label={MENU_LABEL}
        onCloseAutoFocus={onCloseAutoFocus}
      >
        <ThreadContextMenuItems
          thread={thread}
          inline={inline}
          requestRename={requestRename}
        />
      </ContextMenuContent>
    </ContextMenu>
  );
}
