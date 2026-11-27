import { useState, type KeyboardEvent } from "react";
import {
  experimental_Icon as Icon,
  experimental_ThreadStatusGlyph as ThreadStatusGlyph,
  type ExperimentalProjectSidebarGroup,
  type ExperimentalProjectSidebarItem,
} from "@omnyo/plugin-sdk/app";

function showsUnread(item: ExperimentalProjectSidebarItem): boolean {
  return item.unread === true || (item.children ?? []).some(showsUnread);
}

function ItemRow({
  item,
  depth,
  activeThreadId,
  onNavigate,
}: {
  item: ExperimentalProjectSidebarItem;
  depth: number;
  activeThreadId: string | null;
  onNavigate(): void;
}) {
  const [collapsed, setCollapsed] = useState(false);
  const children = item.children ?? [];
  const unread = item.unread === true && (collapsed || !children.some(showsUnread));

  return (
    <div role="treeitem" aria-expanded={children.length > 0 ? !collapsed : undefined}>
      <div
        className="ct-row"
        data-active={item.threadId !== undefined && item.threadId === activeThreadId}
        data-depth={depth}
        style={depth > 0 ? { paddingInlineStart: depth * 14 } : undefined}
      >
        {children.length > 0 ? (
          <button
            type="button"
            className="ct-kids"
            aria-label={`${collapsed ? "Expand" : "Collapse"} ${item.label}`}
            aria-expanded={!collapsed}
            onClick={() => setCollapsed(!collapsed)}
          >
            <Icon
              name={collapsed ? "ChevronRight" : "ChevronDown"}
              aria-hidden
              className="size-3"
            />
          </button>
        ) : null}
        <a href={item.href} className="ct-row-link" data-unread={unread} onClick={onNavigate}>
          <Icon name={item.icon} aria-hidden className="size-3.5" />
          <span className="ct-row-title">{item.label}</span>
          {item.indicator ? (
            <ThreadStatusGlyph indicator={item.indicator} size="compact" />
          ) : item.status ? (
            <span title={item.status.label}>
              <Icon name={item.status.icon} className="size-3" />
            </span>
          ) : null}
          {unread ? <span className="ct-item-dot" aria-label="Unseen changes" /> : null}
          {item.count !== undefined && item.count > 0 ? (
            <span className="ct-count">{item.count}</span>
          ) : null}
        </a>
      </div>
      {!collapsed && children.length > 0 ? (
        <div role="group">
          {children.map((child) => (
            <ItemRow
              key={child.id}
              item={child}
              depth={depth + 1}
              activeThreadId={activeThreadId}
              onNavigate={onNavigate}
            />
          ))}
        </div>
      ) : null}
    </div>
  );
}

function treeKeys(event: KeyboardEvent<HTMLDivElement>) {
  if (!(event.target instanceof HTMLAnchorElement)) return;

  const links = Array.from(event.currentTarget.querySelectorAll<HTMLAnchorElement>("a[href]"));

  const index = links.indexOf(event.target);

  const next =
    event.key === "ArrowDown"
      ? links[index + 1]
      : event.key === "ArrowUp"
        ? links[index - 1]
        : event.key === "Home"
          ? links[0]
          : event.key === "End"
            ? links.at(-1)
            : undefined;

  if (next) {
    event.preventDefault();
    next.focus();
  }

  const row = event.target.closest('[role="treeitem"]');

  if (event.key === "ArrowRight") {
    event.preventDefault();
    const expand = row?.querySelector<HTMLButtonElement>('button[aria-expanded="false"]');

    if (expand) expand.click();
    else row?.querySelector<HTMLAnchorElement>('[role="group"] a[href]')?.focus();
  }

  if (event.key === "ArrowLeft") {
    event.preventDefault();
    const collapse = row?.querySelector<HTMLButtonElement>('button[aria-expanded="true"]');

    if (collapse) collapse.click();
    else
      row?.parentElement
        ?.closest('[role="treeitem"]')
        ?.querySelector<HTMLAnchorElement>("a[href]")
        ?.focus();
  }
}

export function ProjectItems({
  groups,
  projectId,
  pinned,
  activeThreadId,
  onNavigate,
}: {
  groups: readonly ExperimentalProjectSidebarGroup[];
  projectId: string;
  pinned: boolean;
  activeThreadId: string | null;
  onNavigate(): void;
}) {
  return (
    <div
      role="tree"
      aria-label="Project items"
      className="ct-project-items"
      data-pinned={pinned ? "" : undefined}
      data-project-sidebar-items={projectId}
      onKeyDown={treeKeys}
    >
      {groups
        .filter((group) => group.projectId === projectId)
        .map((group, index) => (
          <div key={group.key ?? `${projectId}/${index}`}>
            {group.items.map((item) => (
              <ItemRow
                key={item.id}
                item={item}
                depth={0}
                activeThreadId={activeThreadId}
                onNavigate={onNavigate}
              />
            ))}
          </div>
        ))}
    </div>
  );
}
