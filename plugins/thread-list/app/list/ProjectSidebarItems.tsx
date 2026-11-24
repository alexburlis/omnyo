import { useState } from "react";
import { toast } from "sonner";
import {
  experimental_useProjectSidebarItems,
  experimental_ThreadStatusGlyph as ThreadStatusGlyph,
  type ExperimentalProjectSidebarGroup,
  type ExperimentalProjectSidebarItem,
} from "@omnyo/plugin-sdk/app";
import { Icon } from "@/components/ui/icon";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { ActionMenuItem } from "@/components/ui/action-menu-items";
import { useSidebarRename } from "../rows/SidebarInlineRename.js";

const dragType = "application/x-omnyo-project-sidebar-item";

function runAction(action: () => void | Promise<void>) {
  void Promise.resolve()
    .then(action)
    .catch(() => toast.error("Could not update sidebar item."));
}

export function projectSidebarClaims(
  groups: readonly ExperimentalProjectSidebarGroup[],
  projectIds: ReadonlySet<string>,
): ReadonlyMap<string, ReadonlySet<string>> {
  const claims = new Map<string, Set<string>>();

  function visit(
    items: readonly ExperimentalProjectSidebarItem[],
    ids: Set<string>,
  ) {
    for (const item of items) {
      if (item.threadId) ids.add(item.threadId);

      if (item.children) visit(item.children, ids);
    }
  }

  for (const group of groups) {
    if (!projectIds.has(group.projectId)) continue;
    const ids = claims.get(group.projectId) ?? new Set<string>();
    visit(group.items, ids);
    claims.set(group.projectId, ids);
  }

  return claims;
}

function ItemRow({
  item,
  owner,
  depth,
  siblings,
  onReorder,
  onNavigate,
}: {
  item: ExperimentalProjectSidebarItem;
  owner: string;
  depth: number;
  siblings: readonly ExperimentalProjectSidebarItem[];
  onReorder?: (ids: readonly string[]) => void | Promise<void>;
  onNavigate?: () => void;
}) {
  const storageKey = `omnyo.sidebar.projectItems.${owner}.${item.id}`;

  const [collapsed, setCollapsed] = useState(
    () => localStorage.getItem(storageKey) === "collapsed",
  );

  const rename = useSidebarRename({
    kind: "section",
    id: item.id,
    ownerKey: storageKey,
    name: item.label,
    label: "Name",
    onSave: async (name) => {
      await item.onRename?.(name);
    },
  });

  const children = item.children ?? [];
  const canReorder = onReorder !== undefined;

  return (
    <li
      role="treeitem"
      aria-expanded={children.length > 0 ? !collapsed : undefined}
    >
      <div
        className="group flex min-h-8 items-center gap-1 rounded-md px-2 hover:bg-accent"
        style={{ paddingLeft: `${8 + depth * 12}px` }}
        draggable={canReorder || item.threadId !== undefined}
        onDragStart={(event) => {
          event.stopPropagation();
          event.dataTransfer.setData(
            dragType,
            JSON.stringify({ owner, id: item.id }),
          );
        }}
        onDragOver={(event) => {
          if (
            (item.onDrop || canReorder) &&
            event.dataTransfer.types.includes(dragType)
          )
            event.preventDefault();
        }}
        onDrop={(event) => {
          if (!event.dataTransfer.types.includes(dragType)) return;
          event.preventDefault();
          event.stopPropagation();

          try {
            const value: unknown = JSON.parse(
              event.dataTransfer.getData(dragType),
            );

            if (
              typeof value !== "object" ||
              value === null ||
              !("owner" in value) ||
              value.owner !== owner ||
              !("id" in value) ||
              typeof value.id !== "string" ||
              value.id === item.id
            )
              return;
            const id = value.id;

            if (onReorder && siblings.some((sibling) => sibling.id === id)) {
              const ids = siblings
                .filter((sibling) => sibling.id !== id)
                .map((sibling) => sibling.id);

              ids.splice(ids.indexOf(item.id), 0, id);
              runAction(() => onReorder(ids));
            } else if (item.onDrop) runAction(() => item.onDrop?.(id));
          } catch {
            toast.error("Could not move sidebar item.");
          }
        }}
      >
        {children.length > 0 && (
          <button
            type="button"
            aria-expanded={!collapsed}
            aria-label={`${collapsed ? "Expand" : "Collapse"} ${item.label}`}
            onClick={() => {
              localStorage.setItem(
                storageKey,
                collapsed ? "expanded" : "collapsed",
              );
              setCollapsed(!collapsed);
            }}
          >
            <Icon
              name={collapsed ? "ChevronRight" : "ChevronDown"}
              className="size-3"
            />
          </button>
        )}
        <Icon name={item.icon} className="size-4 shrink-0" />
        {rename.isEditing ? (
          rename.editor
        ) : (
          <a
            className="min-w-0 flex-1 truncate text-sm"
            tabIndex={-1}
            href={item.href}
            onClick={onNavigate}
            onDoubleClick={
              item.onRename
                ? (event) => {
                    event.preventDefault();
                    rename.startEditingFromDoubleClick();
                  }
                : undefined
            }
          >
            {item.label}
          </a>
        )}
        {item.indicator && (
          <ThreadStatusGlyph indicator={item.indicator} size="compact" />
        )}
        {item.status && !item.indicator && (
          <span title={item.status.label}>
            <Icon name={item.status.icon} className="size-3" />
          </span>
        )}
        {item.unread && (
          <span
            aria-label="Unseen changes"
            className="size-1.5 rounded-full bg-primary"
          />
        )}
        {item.count !== undefined && item.count > 0 && (
          <span className="text-xs text-muted-foreground">{item.count}</span>
        )}
        {(item.onRename || item.menuItems?.length || canReorder) && (
          <DropdownMenu>
            <DropdownMenuTrigger
              aria-label={`${item.label} actions`}
              className="opacity-100 sm:opacity-0 sm:group-hover:opacity-100 focus:opacity-100 [@media(hover:none)]:opacity-100"
            >
              <Icon name="MoreHorizontal" className="size-4" />
            </DropdownMenuTrigger>
            <DropdownMenuContent>
              {item.onRename && (
                <ActionMenuItem
                  surface="dropdown"
                  icon="Edit"
                  onSelect={rename.startEditingFromMenu}
                >
                  Rename
                </ActionMenuItem>
              )}
              {canReorder &&
                [-1, 1].map((direction) => (
                  <ActionMenuItem
                    key={direction}
                    icon={direction < 0 ? "ArrowUp" : "ArrowDown"}
                    surface="dropdown"
                    disabled={
                      siblings.findIndex((sibling) => sibling.id === item.id) +
                        direction <
                        0 ||
                      siblings.findIndex((sibling) => sibling.id === item.id) +
                        direction >=
                        siblings.length
                    }
                    onSelect={() => {
                      const ids = siblings.map((sibling) => sibling.id);
                      const index = ids.indexOf(item.id);
                      const target = index + direction;
                      const other = ids[target];

                      if (other === undefined || !onReorder) return;
                      ids[index] = other;
                      ids[target] = item.id;
                      runAction(() => onReorder(ids));
                    }}
                  >
                    {direction < 0 ? "Move up" : "Move down"}
                  </ActionMenuItem>
                ))}
              {item.menuItems?.map((entry) => (
                <ActionMenuItem
                  key={entry.id}
                  surface="dropdown"
                  icon={entry.icon ?? "Dot"}
                  variant={entry.destructive ? "destructive" : undefined}
                  onSelect={() => runAction(entry.run)}
                >
                  {entry.label}
                </ActionMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      </div>
      {children.length > 0 && !collapsed && (
        <ul role="group">
          {children.map((child) => (
            <ItemRow
              key={child.id}
              item={child}
              owner={owner}
              depth={depth + 1}
              siblings={children}
              onReorder={item.onReorder}
              onNavigate={onNavigate}
            />
          ))}
        </ul>
      )}
    </li>
  );
}

export function ProjectSidebarItems({
  projectId,
  onNavigate,
}: {
  projectId: string;
  onNavigate?: () => void;
}) {
  const groups = experimental_useProjectSidebarItems().filter(
    (group) => group.projectId === projectId,
  );

  return (
    <>
      {groups.map((group, index) => (
        <ul
          role="tree"
          tabIndex={0}
          onFocus={(event) => {
            if (event.target === event.currentTarget)
              event.currentTarget
                .querySelector<HTMLAnchorElement>("a[href]")
                ?.focus();
          }}
          onKeyDown={(event) => {
            if (!(event.target instanceof HTMLAnchorElement)) return;

            const links = Array.from(
              event.currentTarget.querySelectorAll<HTMLAnchorElement>(
                "a[href]",
              ),
            );

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

            const row = event.target.closest("li");

            if (event.key === "ArrowRight") {
              event.preventDefault();

              const expand = row?.querySelector<HTMLButtonElement>(
                'button[aria-expanded="false"]',
              );

              if (expand) expand.click();
              else row?.querySelector<HTMLAnchorElement>("ul a[href]")?.focus();
            }

            if (event.key === "ArrowLeft") {
              event.preventDefault();

              const collapse = row?.querySelector<HTMLButtonElement>(
                'button[aria-expanded="true"]',
              );

              if (collapse) collapse.click();
              else
                row?.parentElement
                  ?.closest("li")
                  ?.querySelector<HTMLAnchorElement>("a[href]")
                  ?.focus();
            }
          }}
          aria-label="Project navigation"
          key={group.key ?? index}
        >
          {group.items.map((item) => (
            <ItemRow
              key={item.id}
              item={item}
              owner={group.key ?? `${projectId}/${index}`}
              depth={0}
              siblings={group.items}
              onNavigate={onNavigate}
            />
          ))}
        </ul>
      ))}
    </>
  );
}
