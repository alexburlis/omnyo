import { memo, useRef, type MouseEvent } from "react";
import * as ContextMenu from "@radix-ui/react-context-menu";
import {
  experimental_Icon as Icon,
  experimental_useThreadGroupActions,
} from "@omnyo/plugin-sdk/app";
import { chatCount } from "../lib/naming.ts";
import { ignoreSecondaryRelease, PORTAL_SCOPE } from "./inbox-view-menu.tsx";
import { StateDot, type DotKind } from "./state-dot.tsx";
import { useInlineTextEdit } from "./title-edit.tsx";

interface ChatGroupRowProps {
  groupId: string;
  name: string;
  count: number;
  collapsed: boolean;
  dot: DotKind;
  dotLabel: string;
  onToggle: (groupId: string) => void;
}

export const ChatGroupRow = memo(function ChatGroupRow({
  groupId,
  name,
  count,
  collapsed,
  dot,
  dotLabel,
  onToggle,
}: ChatGroupRowProps) {
  const actions = experimental_useThreadGroupActions();
  const pendingRename = useRef(false);

  const nameEdit = useInlineTextEdit({
    read: () => name,
    commit: (value) => actions.rename(groupId, value),
    label: "Group name",
    emptyError: "Enter a group name.",
    failure: null,
    className: "ct-row-title-input ct-group-input",
  });

  const label = `${name}, ${chatCount(count)}`;

  const fold = (
    <Icon
      name={collapsed ? "ChevronRight" : "ChevronDown"}
      aria-hidden
      className="ct-fold size-3"
    />
  );

  const trailing = (
    <>
      {collapsed ? <StateDot kind={dot} label={dotLabel} /> : null}
      <span className="ct-count" title={chatCount(count)}>
        {count}
      </span>
    </>
  );

  const renameOnDoubleClick = (event: MouseEvent<HTMLButtonElement>) => {
    if (!(event.target instanceof Element) || event.target.closest(".ct-group-name") === null)
      return;
    event.preventDefault();
    nameEdit.start();
  };

  return (
    <ContextMenu.Root modal={false}>
      <ContextMenu.Trigger asChild disabled={nameEdit.isEditing}>
        <div
          className="ct-group"
          data-chat-group={groupId}
          data-collapsed={collapsed}
          data-editing={nameEdit.isEditing || undefined}
        >
          {nameEdit.editor === null ? (
            <button
              type="button"
              className="ct-group-button"
              aria-expanded={!collapsed}
              aria-label={label}
              onClick={() => onToggle(groupId)}
              onDoubleClick={renameOnDoubleClick}
            >
              {fold}
              <span className="ct-group-name" title={name}>
                {name}
              </span>
              {trailing}
            </button>
          ) : (
            <div className="ct-group-button">
              {fold}
              {nameEdit.editor}
              {trailing}
            </div>
          )}
        </div>
      </ContextMenu.Trigger>
      <ContextMenu.Portal>
        <ContextMenu.Content
          {...PORTAL_SCOPE}
          className="ct-view-menu"
          aria-label={`Group ${name}`}
          collisionPadding={8}
          onPointerUpCapture={ignoreSecondaryRelease}
          onCloseAutoFocus={(event) => {
            if (!pendingRename.current) return;
            pendingRename.current = false;
            event.preventDefault();
            nameEdit.start();
          }}
        >
          <ContextMenu.Item
            className="ct-view-menu-item"
            data-group-action="rename"
            onSelect={() => {
              pendingRename.current = true;
            }}
          >
            Rename
          </ContextMenu.Item>
          <ContextMenu.Item
            className="ct-view-menu-item"
            data-group-action="ungroup"
            onSelect={() => {
              actions.ungroup(groupId).catch(() => undefined);
            }}
          >
            Ungroup
          </ContextMenu.Item>
        </ContextMenu.Content>
      </ContextMenu.Portal>
    </ContextMenu.Root>
  );
});
