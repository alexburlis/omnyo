import { memo, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import * as Menu from "@radix-ui/react-dropdown-menu";
import { toast } from "sonner";
import { z } from "zod";
import {
  definePluginApp,
  experimental_Icon as Icon,
  experimental_usePluginId,
  experimental_useProviders,
  experimental_useThreadActions,
  experimental_useSidebarThreadSplit,
  experimental_useSidebarThreads,
  ThreadTitle,
  experimental_useAppNavigate,
  useSdk,
  useSidebarThreadDraft,
  useSidebarThreadDraftIds,
  useSidebarThreadRowStatus,
  useSidebarThreadRowStatuses,
  useSidebarThreadShortcut,
  useComposer,
} from "@omnyo/plugin-sdk/app";
import type { PluginThreadHeaderActionProps, PluginThreadListProps } from "@omnyo/plugin-sdk/app";
import { branchForest, indicatorIcon, type BranchNode } from "./tree";
import "./app.css";

const inFlight = new Map<string, ReturnType<ReturnType<typeof useSdk>["threads"]["fork"]>>();

const COLLAPSE_KEY = "omnyo:branch-tree:collapsed:v1";

const focusAfterBranch = new Set<string>();

const collapsedSchema = z.array(z.string());

function useBranch(threadId: string, onNavigate?: () => void) {
  const sdk = useSdk();
  const navigate = experimental_useAppNavigate();
  const pluginId = experimental_usePluginId();
  const [busyFor, setBusyFor] = useState<string | null>(null);
  const lock = useRef(false);

  const branch = async () => {
    if (lock.current) return;
    lock.current = true;
    setBusyFor(threadId);

    try {
      let request = inFlight.get(threadId);

      if (!request) {
        request = sdk.threads
          .fork({
            sourceThreadId: threadId,
            visibility: "visible",
            origin: "plugin",
            originPluginId: pluginId,
          })
          .finally(() => inFlight.delete(threadId));
        inFlight.set(threadId, request);
      }

      const child = await request;
      focusAfterBranch.add(child.id);
      navigate.toThread(child.id);
      onNavigate?.();

      try {
        const { preferences } = await sdk.system.uiPreferences.list();
        const preference = preferences["sidebar.threadListProvider"];

        if (preference.value !== `${pluginId}/tree`) {
          await sdk.system.uiPreferences.set({
            key: "sidebar.threadListProvider",
            value: `${pluginId}/tree`,
            expectedRevision: preference.revision,
          });
        }
      } catch {
        toast.error("Branch opened. Could not switch the sidebar view.");
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "";

      if (message.includes("no active session") || message.includes("no provider session")) {
        toast.error("Send a message in this chat before branching.");
      } else if (message.includes("archived")) {
        toast.error("Unarchive this chat before branching.");
      } else if (message.includes("ready environment")) {
        toast.error("The chat’s workspace must be ready before branching.");
      } else if (message.includes("does not support thread forks")) {
        toast.error("This provider does not support branching.");
      } else {
        toast.error("Could not create the branch. Try again.");
      }
    } finally {
      lock.current = false;
      setBusyFor(null);
    }
  };

  return { branch, busy: busyFor === threadId };
}

function BranchButton({ threadId, isCompactViewport }: PluginThreadHeaderActionProps) {
  const composer = useComposer();
  useEffect(() => {
    if (
      focusAfterBranch.has(threadId) &&
      composer.scope.kind === "thread" &&
      composer.scope.threadId === threadId
    ) {
      composer.focus();
      focusAfterBranch.delete(threadId);
    }
  }, [threadId, composer]);
  const { threads } = experimental_useSidebarThreads();
  const { providers } = experimental_useProviders();
  const source = threads.find((thread) => thread.id === threadId);
  const provider = providers.find((entry) => entry.id === source?.providerId);
  const unsupported = provider !== undefined && !provider.capabilities.supportsFork;
  const { branch, busy } = useBranch(threadId);

  return (
    <button
      type="button"
      className="bt-branch-button"
      aria-label="Branch this chat"
      aria-busy={busy}
      title={
        unsupported
          ? "This provider does not support branching"
          : "Branch this chat with its current context"
      }
      disabled={busy || unsupported || source?.isArchived}
      onClick={() => void branch()}
    >
      <Icon
        name={busy ? "Spinner" : "GitBranch"}
        aria-hidden
        className={busy ? "bt-icon bt-spin" : "bt-icon"}
      />
      {!isCompactViewport ? <span>{busy ? "Branching…" : "Branch"}</span> : null}
    </button>
  );
}

interface ActionMenuProps {
  label: string;
  children: ReactNode;
}

function ActionMenu({ label, children }: ActionMenuProps) {
  return (
    <Menu.Root>
      <Menu.Trigger asChild>
        <button type="button" className="bt-icon-button bt-menu-trigger" aria-label={label}>
          <Icon name="MoreHorizontal" aria-hidden className="bt-icon" />
        </button>
      </Menu.Trigger>
      <Menu.Portal>
        <Menu.Content
          className="bt-menu"
          side="right"
          align="start"
          sideOffset={6}
          collisionPadding={8}
        >
          {children}
        </Menu.Content>
      </Menu.Portal>
    </Menu.Root>
  );
}

interface ItemProps {
  icon: string;
  children: ReactNode;
  onSelect: () => void;
  disabled?: boolean;
}

function MenuItem({ icon, children, onSelect, disabled }: ItemProps) {
  return (
    <Menu.Item className="bt-menu-item" onSelect={onSelect} disabled={disabled}>
      <Icon name={icon} className="bt-icon" aria-hidden />
      {children}
    </Menu.Item>
  );
}

interface ChatEntry {
  kind: "chat";
  key: string;
  node: BranchNode;
  depth: number;
  family: boolean;
  collapsed: boolean;
  attention: number;
}

interface HeadingEntry {
  kind: "project" | "section";
  key: string;
  label: string;
  count: number;
  collapsed: boolean;
}

type ListEntry = ChatEntry | HeadingEntry;

interface ChatRowProps {
  item: ChatEntry;
  active: boolean;
  toggle: (key: string) => void;
  onNavigate: () => void;
}

const ChatRow = memo(function ChatRow({ item, active, toggle, onNavigate }: ChatRowProps) {
  const { node, depth, family, collapsed, attention } = item;
  const { thread } = node;
  const mark = useSidebarThreadRowStatus(thread.id);
  const { hasUnsubmittedDraft } = useSidebarThreadDraft(thread.id);
  const shortcut = useSidebarThreadShortcut(thread.id);
  const { splitProps, isAvailable } = experimental_useSidebarThreadSplit(thread.id);
  const { branch, busy } = useBranch(thread.id, onNavigate);
  const [renaming, setRenaming] = useState(false);
  const [title, setTitle] = useState(thread.displayTitle);
  const cancelRename = useRef(false);
  const sdk = useSdk();
  const navigate = experimental_useAppNavigate();

  const threadActions = experimental_useThreadActions({
    id: thread.id,
    projectId: thread.projectId,
    parentThreadId: thread.parentThreadId,
    archivedAt: thread.archivedAt,
    pinnedAt: thread.pinnedAt,
    shelvedAt: thread.experimental_shelvedAt,
    sectionId: thread.sectionId,
    isUnread: thread.isUnread,
    status: thread.status,
    environment:
      thread.environment?.id == null
        ? null
        : { id: thread.environment.id, path: thread.environment.path },
  });

  const isActionDisabled = (id: "pin" | "read" | "archive" | "delete") =>
    threadActions.some((item) => item.key === `omnyo--core/${id}` && item.action.disabled === true);

  const runThreadAction = (id: "pin" | "read" | "archive" | "delete") => {
    const entry = threadActions.find((item) => item.key === `omnyo--core/${id}`);

    if (entry === undefined) {
      toast.error("Chat actions are not ready. Try again.");

      return;
    }

    if (entry.action.disabled) return;
    void entry.action.run();
  };

  const icon = mark?.icon ?? (hasUnsubmittedDraft ? "Edit" : indicatorIcon(thread));
  const label = mark?.label ?? (hasUnsubmittedDraft ? "Unsent draft" : thread.indicatorLabel);

  const update = (operation: Promise<void>) => {
    operation.catch(() => toast.error("Could not update the chat. Try again."));
  };

  const saveTitle = () => {
    setRenaming(false);

    if (cancelRename.current) return;
    const next = title.trim();

    if (next && next !== thread.displayTitle)
      update(sdk.threads.update({ threadId: thread.id, title: next }).then(() => undefined));
  };

  return (
    <div
      className="bt-row omnyo-sidebar-hover-actions-row"
      data-branch-row={thread.id}
      data-active={active}
      data-family={family}
      data-depth={depth}
      style={{ paddingInlineStart: 4 + Math.min(Math.max(0, depth - 1), 5) * 12 }}
    >
      {node.children.length > 0 ? (
        <button
          type="button"
          className="bt-disclosure"
          aria-expanded={!collapsed}
          aria-label={`${collapsed ? "Expand" : "Collapse"} branches of ${thread.displayTitle}`}
          onClick={() => toggle(item.key)}
        >
          <Icon
            name={collapsed ? "ChevronRight" : "ChevronDown"}
            className="bt-chevron"
            aria-hidden
          />
        </button>
      ) : (
        <span className="bt-junction" data-branch={depth > 0} aria-hidden />
      )}
      {renaming ? (
        <input
          className="bt-rename"
          aria-label="Chat title"
          autoFocus
          value={title}
          onChange={(event) => setTitle(event.target.value)}
          onBlur={saveTitle}
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              cancelRename.current = true;
              setRenaming(false);
            }

            if (event.key === "Enter") {
              event.preventDefault();
              event.currentTarget.blur();
            }
          }}
        />
      ) : (
        <a
          {...splitProps}
          href={thread.href}
          className="bt-chat-link"
          data-sidebar-thread-id={thread.id}
          data-sidebar-thread-shortcut-target=""
          data-unread={thread.isUnread}
          aria-current={active ? "page" : undefined}
          aria-keyshortcuts={shortcut?.ariaKeyshortcuts}
          title={thread.displayTitle}
          onClick={(event) => {
            if (
              event.button === 0 &&
              !event.metaKey &&
              !event.ctrlKey &&
              !event.shiftKey &&
              !event.altKey
            ) {
              event.preventDefault();
              navigate.toThread(thread.id);
              onNavigate();
            }
          }}
        >
          <span className="bt-chat-title">
            <ThreadTitle threadId={thread.id} />
          </span>
        </a>
      )}
      {family && depth === 0 ? (
        <span className="bt-original" title="Original chat">
          Original
        </span>
      ) : null}
      {node.children.length > 0 ? (
        <span
          className="bt-count"
          title={`${node.count - 1} branches${attention > 0 ? ` · ${attention} need attention` : ""}`}
          data-attention={collapsed && attention > 0}
        >
          {node.count - 1}
        </span>
      ) : null}
      {shortcut ? (
        <kbd className="bt-shortcut">{shortcut.label}</kbd>
      ) : icon ? (
        <span
          className="bt-status"
          role="img"
          aria-label={label ?? "Chat status"}
          title={label ?? undefined}
          data-tone={mark?.tone}
        >
          <Icon
            name={icon}
            className={icon === "Spinner" ? "bt-icon bt-spin" : "bt-icon"}
            aria-hidden
          />
        </span>
      ) : null}
      <button
        type="button"
        className="bt-icon-button bt-row-branch"
        aria-label={`Branch from ${thread.displayTitle}`}
        title="Branch chat"
        disabled={busy}
        onClick={() => void branch()}
      >
        <Icon
          name={busy ? "Spinner" : "GitBranch"}
          className={busy ? "bt-icon bt-spin" : "bt-icon"}
          aria-hidden
        />
      </button>
      <ActionMenu label={`Chat actions for ${thread.displayTitle}`}>
        <MenuItem icon="GitBranch" disabled={busy} onSelect={() => void branch()}>
          Branch chat
        </MenuItem>
        {isAvailable ? (
          <MenuItem
            icon="LayoutColumns"
            onSelect={() => {
              navigate.toThread(thread.id, { split: true });
              onNavigate();
            }}
          >
            Open in split
          </MenuItem>
        ) : null}
        <Menu.Separator className="bt-menu-separator" />
        <MenuItem
          icon="Edit"
          onSelect={() => {
            cancelRename.current = false;
            setTitle(thread.displayTitle);
            setRenaming(true);
          }}
        >
          Rename
        </MenuItem>
        <MenuItem
          icon="Pin"
          disabled={isActionDisabled("pin")}
          onSelect={() => runThreadAction("pin")}
        >
          {thread.isPinned ? "Unpin" : "Pin"}
        </MenuItem>
        <MenuItem
          icon="Mail"
          disabled={isActionDisabled("read")}
          onSelect={() => runThreadAction("read")}
        >
          {thread.isUnread ? "Mark as read" : "Mark as unread"}
        </MenuItem>
        <Menu.Separator className="bt-menu-separator" />
        <MenuItem
          icon="Archive"
          disabled={isActionDisabled("archive")}
          onSelect={() => runThreadAction("archive")}
        >
          Archive
        </MenuItem>
        <MenuItem
          icon="Trash"
          disabled={isActionDisabled("delete")}
          onSelect={() => runThreadAction("delete")}
        >
          Delete
        </MenuItem>
      </ActionMenu>
    </div>
  );
});

function readCollapsed(): Set<string> {
  try {
    const saved = localStorage.getItem(COLLAPSE_KEY);

    return saved === null ? new Set() : new Set(collapsedSchema.parse(JSON.parse(saved)));
  } catch {
    // An invalid saved preference cannot make the user's chats disappear.
    return new Set();
  }
}

function BranchTree({ activeThreadId, onNavigate, isCompactViewport }: PluginThreadListProps) {
  const { status, threads, projects, sections } = experimental_useSidebarThreads();
  const sdk = useSdk();
  const marks = useSidebarThreadRowStatuses();
  const drafts = useSidebarThreadDraftIds();
  const [collapsed, setCollapsed] = useState(readCollapsed);
  const scrollRef = useRef<HTMLDivElement>(null);
  const revealed = useRef<string | null>(null);
  const scrolled = useRef<string | null>(null);
  const forest = useMemo(() => branchForest(threads), [threads]);

  const toggle = (key: string) =>
    setCollapsed((current) => {
      const next = new Set(current);

      if (next.has(key)) next.delete(key);
      else next.add(key);

      return next;
    });

  useEffect(() => {
    try {
      localStorage.setItem(COLLAPSE_KEY, JSON.stringify([...collapsed]));
    } catch {
      toast.error("The browser could not save your collapsed branches.");
    }
  }, [collapsed]);
  useEffect(() => {
    if (activeThreadId === revealed.current || activeThreadId === null) return;
    const active = forest.nodes.get(activeThreadId);

    if (!active) return;
    revealed.current = activeThreadId;
    const keys = [`project:${active.thread.projectId}`];
    let cursor: string | undefined = activeThreadId;
    let root = active;

    while (cursor !== undefined) {
      keys.push(`chat:${cursor}`);
      root = forest.nodes.get(cursor) ?? root;
      cursor = forest.parents.get(cursor);
    }

    keys.push(
      `section:${active.thread.projectId}:${root.pinned ? "pinned" : (root.thread.sectionId ?? "loose")}`,
    );
    setCollapsed((current) => {
      if (!keys.some((key) => current.has(key))) return current;
      const next = new Set(current);

      for (const key of keys) next.delete(key);

      return next;
    });
  }, [activeThreadId, forest]);

  const entries = useMemo(() => {
    const result: ListEntry[] = [];
    const attention = new Map<string, number>();

    for (const root of forest.roots) {
      const order: BranchNode[] = [];
      const pending = [root];

      while (pending.length > 0) {
        const node = pending.pop();

        if (!node) break;
        order.push(node);
        pending.push(...node.children);
      }

      for (let i = order.length - 1; i >= 0; i--) {
        const { thread, children } = order[i];

        const own =
          thread.isUnread ||
          thread.hasPendingInteraction ||
          thread.queuedWork === "failed" ||
          marks.has(thread.id) ||
          drafts.has(thread.id);

        let count = own ? 1 : 0;

        for (const child of children) count += attention.get(child.thread.id) ?? 0;
        attention.set(thread.id, count);
      }
    }

    for (const project of projects) {
      const families = forest.roots.filter((node) => node.thread.projectId === project.id);

      if (families.length === 0) continue;
      const projectKey = `project:${project.id}`;
      result.push({
        kind: "project",
        key: projectKey,
        label: project.name,
        count: families.reduce((sum, node) => sum + node.count, 0),
        collapsed: collapsed.has(projectKey),
      });

      if (collapsed.has(projectKey)) continue;
      const groups = new Map<string, BranchNode[]>();

      for (const node of families) {
        const group = node.pinned ? "pinned" : (node.thread.sectionId ?? "loose");
        const current = groups.get(group);

        if (current) current.push(node);
        else groups.set(group, [node]);
      }

      const groupOrder = ["pinned", ...sections.map((section) => section.id), "loose"];

      for (const group of groups.keys()) if (!groupOrder.includes(group)) groupOrder.push(group);

      for (const group of groupOrder) {
        const roots = groups.get(group);

        if (!roots) continue;
        const groupKey = `section:${project.id}:${group}`;

        if (group !== "loose") {
          result.push({
            kind: "section",
            key: groupKey,
            label:
              group === "pinned"
                ? "Pinned"
                : (sections.find((section) => section.id === group)?.name ?? "Chats"),
            count: roots.reduce((sum, node) => sum + node.count, 0),
            collapsed: collapsed.has(groupKey),
          });

          if (collapsed.has(groupKey)) continue;
        }

        for (const root of roots) {
          const pending = [{ node: root, depth: 0 }];

          while (pending.length > 0) {
            const next = pending.pop();

            if (!next) break;
            const key = `chat:${next.node.thread.id}`;
            const hidden = collapsed.has(key);
            result.push({
              kind: "chat",
              key,
              ...next,
              family: root.count > 1,
              collapsed: hidden,
              attention: attention.get(next.node.thread.id) ?? 0,
            });

            if (hidden) continue;

            for (let i = next.node.children.length - 1; i >= 0; i--)
              pending.push({ node: next.node.children[i], depth: next.depth + 1 });
          }
        }
      }
    }

    return result;
  }, [forest, projects, sections, collapsed, marks, drafts]);

  const virtualizer = useVirtualizer({
    count: entries.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: (index) => (entries[index].kind === "section" ? 28 : 36),
    getItemKey: (index) => entries[index].key,
    overscan: 8,
  });

  useEffect(() => {
    if (!activeThreadId || scrolled.current === activeThreadId) return;

    const index = entries.findIndex(
      (entry) => entry.kind === "chat" && entry.node.thread.id === activeThreadId,
    );

    if (index < 0) return;
    scrolled.current = activeThreadId;
    virtualizer.scrollToIndex(index, { align: "auto" });
  }, [activeThreadId, entries, virtualizer]);

  const projectView = async () => {
    try {
      const { preferences } = await sdk.system.uiPreferences.list();
      await sdk.system.uiPreferences.set({
        key: "sidebar.threadListProvider",
        value: "thread-list/thread-list",
        expectedRevision: preferences["sidebar.threadListProvider"].revision,
      });
    } catch {
      toast.error("Could not change the chat view. Try again.");
    }
  };

  return (
    <nav
      className="bt-list"
      data-branch-tree="list"
      data-compact={isCompactViewport}
      aria-label="Chats grouped by branch"
    >
      <div className="bt-toolbar">
        <Icon name="GitBranch" className="bt-icon" aria-hidden />
        <span>Branches</span>
        <ActionMenu label="Branch tree options">
          <MenuItem icon="Folder" onSelect={() => void projectView()}>
            Project view
          </MenuItem>
          <MenuItem icon="ChevronDown" onSelect={() => setCollapsed(new Set())}>
            Expand all
          </MenuItem>
          <MenuItem
            icon="ChevronRight"
            onSelect={() =>
              setCollapsed(new Set(forest.roots.map((node) => `chat:${node.thread.id}`)))
            }
          >
            Collapse branches
          </MenuItem>
        </ActionMenu>
      </div>
      {status !== "ready" ? (
        <p className="bt-notice" role={status === "error" ? "alert" : "status"}>
          {status === "error"
            ? "Could not load chats. Reload Omnyo to try again."
            : "Loading chats…"}
        </p>
      ) : null}
      {status === "ready" && entries.length === 0 ? (
        <p className="bt-notice">Your chats will appear here.</p>
      ) : null}
      <div className="bt-scroll" ref={scrollRef}>
        <div className="bt-list-space" style={{ height: virtualizer.getTotalSize() }}>
          {virtualizer.getVirtualItems().map((virtual) => {
            const item = entries[virtual.index];

            return (
              <div
                key={item.key}
                className="bt-list-item"
                style={{ transform: `translateY(${virtual.start}px)` }}
              >
                {item.kind === "chat" ? (
                  <ChatRow
                    item={item}
                    active={item.node.thread.id === activeThreadId}
                    toggle={toggle}
                    onNavigate={onNavigate}
                  />
                ) : (
                  <button
                    type="button"
                    className="bt-heading"
                    data-kind={item.kind}
                    aria-expanded={!item.collapsed}
                    aria-label={`${item.collapsed ? "Expand" : "Collapse"} ${item.label}`}
                    onClick={() => toggle(item.key)}
                  >
                    <Icon
                      name={item.collapsed ? "ChevronRight" : "ChevronDown"}
                      className="bt-chevron"
                      aria-hidden
                    />
                    <span className="bt-heading-title">{item.label}</span>
                    <span className="bt-count">{item.count}</span>
                  </button>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </nav>
  );
}

export default definePluginApp((app) => {
  // A generation owns the shared stylesheet while navigation replaces slots.
  app.contentScripts.register({ id: "retain-styles", mount: () => () => {} });
  app.slots.experimental_threadHeaderAction({
    id: "branch",
    title: "Branch chat",
    component: BranchButton,
  });
  app.slots.experimental_threadList({
    id: "tree",
    title: "Branch tree",
    description: "Keep chat branches together, with nested continuations.",
    component: BranchTree,
  });
});
