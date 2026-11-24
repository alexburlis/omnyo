import {
  memo,
  useCallback,
  type CSSProperties,
  type MouseEvent,
  type ReactNode,
} from "react";
import { experimental_useThreadGroupActions } from "@omnyo/plugin-sdk/app";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { useIsCompactViewport } from "@/components/ui/hooks/use-compact-viewport";
import {
  ActionMenuItem,
  type ActionMenuSurface,
} from "@/components/ui/action-menu-items";
import { CompactLongPressMenu } from "@/components/ui/compact-long-press-menu";
import { COARSE_POINTER_COMPACT_ROW_HEIGHT_CLASS } from "@/components/ui/coarse-pointer-sizing";
import { LIST_HOVER_TRANSITION } from "@/components/ui/motion";
import {
  SIDEBAR_GROUP_TEXT_CLASS,
  SIDEBAR_ROW_BASE_CLASS,
  SIDEBAR_ROW_GLYPH_SLOT_CLASS,
  SIDEBAR_STATUS_GLYPH_BOX_CLASS,
  getSidebarThreadRowPaddingLeft,
} from "@/components/ui/sidebar-row-classes";
import { Icon } from "@/components/ui/icon";
import { SECTION_COUNT_CLASS } from "@/components/ui/section-header";
import { cn } from "@/lib/utils";
import { SidebarStickyTier } from "../ui/sidebar.js";
import { useSidebarRename } from "../rows/SidebarInlineRename.js";
import { SidebarChildToggleChevron } from "../rows/SidebarChildToggleChevron.js";
import { CollapsedThreadStatusGlyph } from "../rows/ThreadRow.js";
import type { SidebarChatGroup } from "../model/project-thread-groups.js";
import { NO_THREAD_IDS, useThreadsHaveDraft } from "./sidebarDraftPresence.js";

export function chatGroupRenameId(groupId: string): string {
  return `chat-group:${groupId}`;
}

interface ChatGroupRowProps {
  group: SidebarChatGroup;
  depth: number;
  stickyLevel?: number;
  isCollapsed: boolean;
  onToggleCollapsed: () => void;
}

interface ChatGroupActionsMenuProps {
  label: string;
  disabled: boolean;
  children: ReactNode;
  onRename: () => void;
  onUngroup: () => void;
  onCloseAutoFocus?: (event: Event) => void;
}

function stopMenuClickPropagation(event: MouseEvent) {
  event.stopPropagation();
}

function ChatGroupActionsMenuItems({
  surface,
  onRename,
  onUngroup,
}: {
  surface: ActionMenuSurface;
  onRename: () => void;
  onUngroup: () => void;
}) {
  return (
    <>
      <ActionMenuItem surface={surface} icon="Edit" onSelect={onRename}>
        Rename
      </ActionMenuItem>
      <ActionMenuItem surface={surface} icon="FolderMinus" onSelect={onUngroup}>
        Ungroup
      </ActionMenuItem>
    </>
  );
}

function ChatGroupActionsMenu({
  label,
  disabled,
  children,
  onRename,
  onUngroup,
  onCloseAutoFocus,
}: ChatGroupActionsMenuProps) {
  const isCompactViewport = useIsCompactViewport();

  if (isCompactViewport) {
    return (
      <CompactLongPressMenu
        label={`${label} actions`}
        disabled={disabled}
        items={
          <ChatGroupActionsMenuItems
            surface="dropdown"
            onRename={onRename}
            onUngroup={onUngroup}
          />
        }
      >
        {children}
      </CompactLongPressMenu>
    );
  }

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild disabled={disabled}>
        {children}
      </ContextMenuTrigger>
      <ContextMenuContent
        aria-label={`${label} actions`}
        onCloseAutoFocus={onCloseAutoFocus}
        onClick={stopMenuClickPropagation}
      >
        <ChatGroupActionsMenuItems
          surface="context"
          onRename={onRename}
          onUngroup={onUngroup}
        />
      </ContextMenuContent>
    </ContextMenu>
  );
}

function ChatGroupRowComponent({
  group,
  depth,
  stickyLevel,
  isCollapsed,
  onToggleCollapsed,
}: ChatGroupRowProps) {
  const actions = experimental_useThreadGroupActions();
  const groupId = group.id;

  const rename = useSidebarRename({
    kind: "section",
    id: chatGroupRenameId(groupId),
    ownerKey: chatGroupRenameId(groupId),
    name: group.name,
    label: "Group name",
    onSave: (name) => actions.rename(groupId, name),
  });

  const handleUngroup = useCallback(() => {
    void actions.ungroup(groupId).catch(() => {});
  }, [actions, groupId]);

  const hiddenThreadsHaveDraft = useThreadsHaveDraft(
    isCollapsed ? group.activity.threadIds : NO_THREAD_IDS,
  );

  const showRollupGlyph =
    isCollapsed &&
    (group.activity.work !== null ||
      hiddenThreadsHaveDraft ||
      group.activity.unread ||
      group.activity.unreadError);

  const className = cn(
    stickyLevel === undefined && "relative",
    SIDEBAR_ROW_BASE_CLASS,
    LIST_HOVER_TRANSITION,
    SIDEBAR_GROUP_TEXT_CLASS,
    COARSE_POINTER_COMPACT_ROW_HEIGHT_CLASS,
    "cursor-pointer select-none",
  );

  const style: CSSProperties = {
    paddingLeft: getSidebarThreadRowPaddingLeft(depth),
  };

  const rowProps = {
    "data-sidebar-rename-row": "",
    "data-sidebar-chat-group-id": groupId,
    className,
    style,
    onClick: (event: MouseEvent<HTMLDivElement>) => {
      if (rename.isEditing || event.defaultPrevented) return;
      onToggleCollapsed();
    },
  };

  const content = (
    <>
      <span className="relative z-10 flex min-w-0 flex-1 items-center gap-1.5 text-left">
        <span
          aria-hidden="true"
          className={cn(
            SIDEBAR_ROW_GLYPH_SLOT_CLASS,
            SIDEBAR_STATUS_GLYPH_BOX_CLASS,
          )}
        >
          <Icon
            name={isCollapsed ? "Folder" : "FolderOpen"}
            className="size-4"
          />
        </span>
        {rename.editor ?? (
          <span
            className="min-w-0 truncate"
            onDoubleClick={(event) => {
              event.preventDefault();
              event.stopPropagation();
              rename.startEditingFromDoubleClick();
            }}
          >
            {group.name}
          </span>
        )}
        <SidebarChildToggleChevron
          disabled={rename.isEditing}
          className={rename.isEditing ? "hidden" : undefined}
          isCollapsed={isCollapsed}
          expandLabel={`Expand ${group.name} group`}
          collapseLabel={`Collapse ${group.name} group`}
          onToggle={onToggleCollapsed}
        />
      </span>
      {rename.isEditing ? null : (
        <span className="relative z-10 inline-flex shrink-0 items-center gap-1.5 pr-2">
          {showRollupGlyph ? (
            <CollapsedThreadStatusGlyph activity={group.activity} />
          ) : null}
          <span
            className={SECTION_COUNT_CLASS}
            aria-label={`${group.memberCount} ${group.memberCount === 1 ? "chat" : "chats"}`}
          >
            {group.memberCount}
          </span>
        </span>
      )}
    </>
  );

  return (
    <ChatGroupActionsMenu
      label={group.name}
      disabled={rename.isEditing}
      onRename={rename.startEditingFromMenu}
      onUngroup={handleUngroup}
      onCloseAutoFocus={rename.onCloseAutoFocus}
    >
      {stickyLevel === undefined ? (
        <div {...rowProps}>{content}</div>
      ) : (
        <SidebarStickyTier tier="parent" level={stickyLevel} {...rowProps}>
          {content}
        </SidebarStickyTier>
      )}
    </ChatGroupActionsMenu>
  );
}

export const ChatGroupRow = memo(ChatGroupRowComponent);
