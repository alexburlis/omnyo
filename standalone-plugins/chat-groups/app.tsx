import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { z } from "zod";
import {
  definePluginApp,
  experimental_Icon as Icon,
  experimental_usePluginId,
  experimental_useThreadActions,
  experimental_useAppNavigate,
  experimental_useSidebarThreadSplit,
  experimental_useSidebarThreads,
  useSdk,
  useSidebarThreadDraft,
  useSidebarThreadRowStatus,
  useSidebarThreadRowStatuses,
  useSidebarThreadShortcut,
  ThreadTitle,
} from "@omnyo/plugin-sdk/app";
import type {
  PluginSidebarThread,
  PluginThreadHeaderActionProps,
  PluginThreadListProps,
} from "@omnyo/plugin-sdk/app";
import {
  CHAT_GROUPS,
  CHAT_SECTIONS,
  chatGroup,
  chatTree,
  indicatorIcon,
  isAttentionGroup,
  sectionForGroup,
  type ChatGroup,
  type ChatNode,
  type ChatSection,
  type GroupId,
  type SectionId,
} from "./groups";
import { ChatMenu, ChatMenuItem } from "./components/ui/chat-menu";
import { useWorkflowActivity } from "./workflow-activity";
import "./app.css";

const PROVIDER_KEY = "sidebar.threadListProvider";

const PROJECT_PROVIDER = "thread-list/thread-list";

const archiveResult = z.object({
  archived: z.number().int().nonnegative(),
  failures: z.array(z.object({ threadId: z.string(), message: z.string() })),
});

function ViewToggle() {
  const sdk = useSdk();
  const pluginId = experimental_usePluginId();
  const groupedProvider = `${pluginId}/groups`;
  const [provider, setProvider] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let live = true;
    let request = 0;

    const refresh = () => {
      const current = ++request;
      sdk.system.uiPreferences.list().then(
        ({ preferences }) => {
          if (live && request === current) {
            setProvider(preferences[PROVIDER_KEY].value);
            setFailed(false);
          }
        },
        () => {
          if (live && request === current) setFailed(true);
        },
      );
    };

    refresh();

    const disposers = [
      sdk.subscribe({ event: "system:changed", callback: refresh }),
      sdk.subscribe({ event: "system:config-changed", callback: refresh }),
      sdk.subscribe({
        event: "realtime:connection",
        callback: (event) => {
          if (event.state === "connected") refresh();
        },
      }),
    ];

    return () => {
      live = false;

      for (const dispose of disposers) dispose();
    };
  }, [sdk]);

  const choose = async (next: string) => {
    if (pending) return;
    setPending(true);

    try {
      const { preferences } = await sdk.system.uiPreferences.list();

      const result = await sdk.system.uiPreferences.set({
        key: PROVIDER_KEY,
        value: next,
        expectedRevision: preferences[PROVIDER_KEY].revision,
      });

      setProvider(result.value);
      setFailed(false);
    } catch {
      setFailed(true);
    } finally {
      setPending(false);
    }
  };

  return (
    <div role="group" aria-label="Chat view" className="cg-view-toggle">
      <button
        type="button"
        className="cg-view-button"
        aria-label="Show project view"
        title={failed ? "Could not change the view. Click to retry." : "Projects"}
        aria-pressed={provider === PROJECT_PROVIDER}
        disabled={pending}
        onClick={() => void choose(PROJECT_PROVIDER)}
      >
        <Icon name="Folder" aria-hidden className="size-3.5" />
        Projects
      </button>
      <button
        type="button"
        className="cg-view-button"
        aria-label="Group chats by status"
        title={failed ? "Could not change the view. Click to retry." : "By status"}
        aria-pressed={provider === groupedProvider}
        disabled={pending}
        onClick={() => void choose(groupedProvider)}
      >
        <Icon name="FilterHorizontal" aria-hidden className="size-3.5" />
        Status
      </button>
      {failed ? (
        <span role="alert" aria-label="Could not change the chat view">
          <Icon name="AlertCircle" className="size-3.5" />
        </span>
      ) : null}
    </div>
  );
}

function ProjectPill({ projectId, isCompactViewport }: PluginThreadHeaderActionProps) {
  const { status, projects } = experimental_useSidebarThreads();
  const project = projects.find((entry) => entry.id === projectId);
  const name = project?.name ?? (status === "loading" ? "Loading project…" : "Project unavailable");

  return (
    <div className="cg-project-pill" title={name} data-compact={isCompactViewport}>
      <Icon name="Folder" className="size-3.5 shrink-0" aria-hidden />
      <span>{name}</span>
    </div>
  );
}

interface GroupHeading {
  kind: "heading";
  key: string;
  group: ChatGroup;
  count: number;
  sectionId: SectionId;
}

interface SectionEntry {
  kind: "section";
  key: string;
  section: ChatSection;
  count: number;
}

interface ChatEntry {
  kind: "chat";
  key: string;
  group: GroupId;
  thread: PluginSidebarThread;
  projectName: string;
  depth: number;
  childCount: number;
  statusGroup: GroupId;
  sectionId: SectionId;
  projectBlock: string;
  projectEnd: boolean;
}

interface ProjectChats {
  key: string;
  group: ChatGroup;
  projectId: string;
  projectName: string;
  roots: ChatNode[];
}

interface ProjectEntry {
  kind: "project";
  key: string;
  group: GroupId;
  sectionId: SectionId;
  projectId: string;
  projectName: string;
}

type ListItem = SectionEntry | GroupHeading | ProjectEntry | ChatEntry;

function ProjectHeader({ item }: { item: ProjectEntry }) {
  const Heading = item.sectionId === "working" ? "h3" : "h4";

  return (
    <Heading
      className="cg-project-heading"
      data-chat-project-header={item.projectId}
      data-chat-group={item.group}
    >
      <span className="cg-project-group-pill" title={item.projectName}>
        <Icon name="Folder" className="size-3.5 shrink-0" aria-hidden />
        <span className="cg-project-group-name">{item.projectName}</span>
      </span>
    </Heading>
  );
}

interface SectionHeaderProps {
  item: SectionEntry;
  collapsed: boolean;
  onToggle: (id: SectionId) => void;
  sticky?: boolean;
}

function SectionHeader({ item, collapsed, onToggle, sticky = false }: SectionHeaderProps) {
  const { section, count } = item;
  const working = section.id === "working";

  return (
    <h2 className="cg-section-frame">
      <button
        type="button"
        className="cg-section-heading"
        data-chat-section-header={sticky ? undefined : section.id}
        data-sticky-section={sticky ? section.id : undefined}
        data-chat-group-header={!sticky && working ? "working" : undefined}
        aria-label={`${section.label} chats (${count})`}
        aria-expanded={!collapsed}
        onClick={() => onToggle(section.id)}
      >
        <Icon name={collapsed ? "ChevronRight" : "ChevronDown"} aria-hidden className="size-3" />
        <span className="cg-section-title">{section.label}</span>
        {working ? <Icon name="Spinner" className="cg-group-icon size-3.5" aria-hidden /> : null}
        <span className={working ? "cg-section-count cg-group-count" : "cg-section-count"}>
          {count}
        </span>
      </button>
    </h2>
  );
}

interface ChatRowProps {
  item: ChatEntry;
  active: boolean;
  onNavigate: () => void;
  expanded: boolean;
  onToggle: (id: string) => void;
  onArchive: (id: string) => Promise<void>;
}

const ChatRow = memo(function ChatRow({
  item,
  active,
  onNavigate,
  expanded,
  onToggle,
  onArchive,
}: ChatRowProps) {
  const { thread, projectName, group, depth, childCount, statusGroup } = item;
  const navigate = experimental_useAppNavigate();

  const hostActions = experimental_useThreadActions({
    ...thread,
    shelvedAt: thread.experimental_shelvedAt,
    environment: thread.environment?.id
      ? { id: thread.environment.id, path: thread.environment.path }
      : null,
  });

  const hostAction = (key: string) =>
    hostActions.find((entry) => entry.key === `omnyo--core/${key}`)?.action;

  const mark = useSidebarThreadRowStatus(thread.id);
  const ownGroup = chatGroup(thread, mark);
  const childNeedsInput = isAttentionGroup(statusGroup) && !isAttentionGroup(ownGroup);
  const childrenWorking = statusGroup === "working" && ownGroup !== "working";

  const rowStatus =
    statusGroup !== "ready" &&
    statusGroup !== "unread-ready" &&
    mark?.icon === "Archive" &&
    mark.label === "Ready to archive"
      ? null
      : mark;

  const { hasUnsubmittedDraft } = useSidebarThreadDraft(thread.id);
  const shortcut = useSidebarThreadShortcut(thread.id);
  const { splitProps } = experimental_useSidebarThreadSplit(thread.id);
  const [failed, setFailed] = useState(false);
  const [archiving, setArchiving] = useState(false);

  const archiveSuggested =
    rowStatus?.icon === "Archive" &&
    rowStatus.label === "Ready to archive" &&
    (statusGroup === "ready" || statusGroup === "unread-ready");

  const icon = childNeedsInput
    ? "MessageQuestion"
    : childrenWorking
      ? "Spinner"
      : (rowStatus?.icon ??
        (hasUnsubmittedDraft
          ? "Edit"
          : (indicatorIcon(thread) ?? (statusGroup === "working" ? "Spinner" : null))));

  const label = childNeedsInput
    ? "Sub-chat needs input"
    : childrenWorking
      ? "Sub-chats working"
      : (rowStatus?.label ??
        (hasUnsubmittedDraft
          ? "Unsent draft"
          : (thread.indicatorLabel ?? (statusGroup === "working" ? "Work in progress" : null))));

  const archive = async () => {
    if (archiving) return;
    setArchiving(true);
    setFailed(false);

    try {
      await onArchive(thread.id);
    } catch {
      setFailed(true);
    } finally {
      setArchiving(false);
    }
  };

  return (
    <div
      className="cg-row omnyo-sidebar-hover-actions-row"
      data-active={active}
      style={{ paddingInlineStart: (group === "working" ? 12 : 24) + depth * 16 }}
    >
      {childCount > 0 ? (
        <button
          type="button"
          className="cg-row-toggle"
          aria-label={`${expanded ? "Collapse" : "Expand"} sub-chats for ${thread.displayTitle}`}
          aria-expanded={expanded}
          onClick={() => onToggle(thread.id)}
        >
          <Icon name={expanded ? "ChevronDown" : "ChevronRight"} className="size-3.5" aria-hidden />
        </button>
      ) : (
        <span className="cg-row-spacer" aria-hidden />
      )}
      <a
        {...splitProps}
        href={thread.href}
        className="cg-row-link"
        data-sidebar-thread-id={thread.id}
        data-sidebar-thread-shortcut-target=""
        data-chat-group={group}
        data-chat-depth={depth}
        data-chat-section={item.sectionId}
        data-project-id={thread.projectId}
        data-parent-thread-id={thread.parentThreadId ?? undefined}
        data-unread={thread.isUnread}
        aria-current={active ? "page" : undefined}
        aria-label={`${thread.displayTitle}, ${projectName}`}
        title={thread.displayTitle}
        aria-keyshortcuts={shortcut?.ariaKeyshortcuts}
        onClick={(event) => {
          if (event.button !== 0 || event.altKey || event.shiftKey) return;
          event.preventDefault();
          navigate.toThread(thread.id, { split: event.metaKey || event.ctrlKey });
          onNavigate();
        }}
      >
        <span className="cg-row-body">
          <span className="cg-row-title">
            <ThreadTitle threadId={thread.id} />
          </span>
          {childCount > 0 ? (
            <span className="cg-row-meta cg-child-count">
              {childCount} {childCount === 1 ? "sub-chat" : "sub-chats"}
            </span>
          ) : null}
        </span>
        {thread.isPinned ? (
          <Icon name="Pin" className="size-3 shrink-0 text-muted-foreground" aria-label="Pinned" />
        ) : null}
        {shortcut !== null ? (
          <kbd className="text-xs text-muted-foreground">{shortcut.label}</kbd>
        ) : null}
      </a>
      {failed ? (
        <span
          role="alert"
          className="text-destructive"
          title={
            archiveSuggested
              ? "Could not archive this chat. Try again."
              : "Could not update this chat. Try again."
          }
          aria-label={
            archiveSuggested ? "Could not archive this chat" : "Could not update this chat"
          }
        >
          <Icon name="AlertCircle" className="size-3.5" />
        </span>
      ) : null}
      <ChatMenu title={thread.displayTitle}>
        {(["read", "pin", "rename", "split", "archive", "delete"] as const).map((key) => {
          const action = hostAction(key);

          if (action === undefined) return null;

          const label =
            key === "read"
              ? thread.isUnread
                ? "Mark as read"
                : "Mark as unread"
              : key === "delete"
                ? "Delete…"
                : action.label;

          return (
            <ChatMenuItem key={key} disabled={action.disabled} onSelect={() => void action.run()}>
              {label}
            </ChatMenuItem>
          );
        })}
      </ChatMenu>
      {archiveSuggested ? (
        <button
          type="button"
          className="cg-row-status cg-archive-suggestion"
          data-archive-suggestion={thread.id}
          data-sidebar-thread-trailing-indicator=""
          data-tone="success"
          aria-label={`Archive ${thread.displayTitle} and open next chat`}
          title="Archive and open next chat"
          disabled={archiving}
          onClick={() => void archive()}
        >
          <Icon name={archiving ? "Spinner" : "Archive"} className="size-3.5" aria-hidden />
        </button>
      ) : icon !== null ? (
        <span
          className="cg-row-status"
          data-sidebar-thread-trailing-indicator=""
          data-tone={rowStatus?.tone}
          aria-label={label ?? undefined}
          title={label ?? undefined}
        >
          <Icon name={icon} className="size-3.5" aria-hidden />
        </span>
      ) : (
        <span className="cg-row-status" aria-hidden />
      )}
    </div>
  );
});

function GroupedChats({ activeThreadId, onNavigate }: PluginThreadListProps) {
  const { status, threads, projects } = experimental_useSidebarThreads();
  const rowStatuses = useSidebarThreadRowStatuses();
  const navigate = experimental_useAppNavigate();
  const sdk = useSdk();
  const scrollRef = useRef<HTMLDivElement>(null);
  const lastActiveId = useRef(activeThreadId);
  const pendingReveal = useRef<string | null>(null);
  const initialReveal = useRef(true);
  const [collapsed, setCollapsed] = useState<ReadonlySet<GroupId>>(new Set());
  const [collapsedSections, setCollapsedSections] = useState<ReadonlySet<SectionId>>(new Set());
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const workflows = useWorkflowActivity(threads, activeThreadId);

  const tree = useMemo(
    () => chatTree(threads, rowStatuses, workflows.working, workflows.uncertain),
    [threads, rowStatuses, workflows.working, workflows.uncertain],
  );

  const projectGroups = useMemo(() => {
    const grouped = new Map<GroupId, Map<string, ChatNode[]>>(
      CHAT_GROUPS.map((group) => [group.id, new Map()]),
    );

    const names = new Map(projects.map((project) => [project.id, project.name]));

    for (const root of tree.roots) {
      const byProject = grouped.get(root.group)!;
      const projectRoots = byProject.get(root.thread.projectId);

      if (projectRoots === undefined) byProject.set(root.thread.projectId, [root]);
      else projectRoots.push(root);
    }

    const result: ProjectChats[] = [];

    for (const group of CHAT_GROUPS)
      for (const [projectId, roots] of grouped.get(group.id)!)
        result.push({
          key: `project:${group.id}:${projectId}`,
          group,
          projectId,
          projectName: names.get(projectId) ?? "Project unavailable",
          roots,
        });

    return result;
  }, [tree, projects]);

  const archiveAndNext = useCallback(
    async (threadId: string) => {
      const roots = projectGroups.flatMap((project) => project.roots);
      let root = tree.nodes.get(threadId);

      if (root === undefined) throw new Error("Chat is no longer available.");

      while (root.thread.parentThreadId !== null) {
        root = tree.nodes.get(root.thread.parentThreadId);

        if (root === undefined) throw new Error("Parent chat is no longer available.");
      }

      const index = roots.findIndex((node) => node.thread.id === root.thread.id);
      const next = roots[index + 1] ?? roots[index - 1];

      const result = await sdk.plugins.callRpc({
        pluginId: "tidy",
        method: "archive",
        input: { threadIds: [threadId] },
        outputSchema: archiveResult,
      });

      if (result.archived !== 1 || result.failures.length > 0)
        throw new Error("Chat could not be archived.");

      if (next !== undefined) navigate.toThread(next.thread.id);
      else navigate.toCompose({ projectId: root.thread.projectId });
      onNavigate();
    },
    [projectGroups, tree, sdk, navigate, onNavigate],
  );

  const toggleSection = useCallback((id: SectionId) => {
    setCollapsedSections((previous) => {
      const next = new Set(previous);

      if (next.has(id)) next.delete(id);
      else next.add(id);

      return next;
    });
  }, []);

  const toggleThread = useCallback((id: string) => {
    setExpanded((previous) => {
      const next = new Set(previous);

      if (next.has(id)) next.delete(id);
      else next.add(id);

      return next;
    });
  }, []);

  const items = useMemo(() => {
    const projectNames = new Map(projects.map((project) => [project.id, project.name]));

    const result: ListItem[] = [];

    const append = (node: ChatNode, project: ProjectChats, depth: number) => {
      const { thread } = node;
      result.push({
        kind: "chat",
        key: thread.id,
        group: project.group.id,
        thread,
        projectName: projectNames.get(thread.projectId) ?? "Project unavailable",
        depth,
        childCount: node.children.length,
        statusGroup: node.group,
        sectionId: sectionForGroup(project.group.id),
        projectBlock: project.key,
        projectEnd: false,
      });

      if (expanded.has(thread.id))
        for (const child of node.children) append(child, project, depth + 1);
    };

    for (const section of CHAT_SECTIONS) {
      const groups = CHAT_GROUPS.filter((group) => section.groups.includes(group.id));
      let count = 0;

      for (const project of projectGroups)
        if (section.groups.includes(project.group.id)) count += project.roots.length;

      if (count === 0) continue;
      result.push({ kind: "section", key: `section:${section.id}`, section, count });

      if (collapsedSections.has(section.id)) continue;

      for (const group of groups) {
        const matchingProjects = projectGroups.filter((project) => project.group.id === group.id);
        const count = matchingProjects.reduce((total, project) => total + project.roots.length, 0);

        if (count === 0) continue;

        if (section.id !== "working")
          result.push({
            kind: "heading",
            key: group.id,
            group,
            count,
            sectionId: section.id,
          });

        if (collapsed.has(group.id)) continue;

        for (const project of matchingProjects) {
          result.push({
            kind: "project",
            key: project.key,
            group: group.id,
            sectionId: section.id,
            projectId: project.projectId,
            projectName: project.projectName,
          });

          for (const node of project.roots) append(node, project, 0);
          const last = result[result.length - 1];

          if (last.kind === "chat") last.projectEnd = true;
        }
      }
    }

    return result;
  }, [projectGroups, projects, collapsed, collapsedSections, expanded]);

  const getItemKey = useCallback((index: number) => items[index].key, [items]);

  const virtualizer = useVirtualizer({
    count: items.length,
    getScrollElement: () => scrollRef.current,
    getItemKey,
    estimateSize: (index) =>
      items[index].kind === "section"
        ? 44
        : items[index].kind === "heading"
          ? 30
          : items[index].kind === "project"
            ? 36
            : 46,
    overscan: 12,
  });

  useEffect(() => {
    if (initialReveal.current && status === "ready") {
      initialReveal.current = false;

      // Keep unread sections at the top on initial root navigation. A direct
      // child URL still needs its ancestry expanded and revealed.
      if (activeThreadId !== null && tree.nodes.get(activeThreadId)?.thread.parentThreadId)
        pendingReveal.current = activeThreadId;
    }

    if (lastActiveId.current !== activeThreadId) {
      lastActiveId.current = activeThreadId;
      pendingReveal.current = activeThreadId;
    }

    if (pendingReveal.current === null) return;

    let root = tree.nodes.get(pendingReveal.current);

    if (root === undefined) return;
    const ancestors: string[] = [];

    while (root.thread.parentThreadId !== null) {
      const parent = tree.nodes.get(root.thread.parentThreadId);

      if (parent === undefined) return;
      ancestors.push(parent.thread.id);
      root = parent;
    }

    const missing = ancestors.filter((id) => !expanded.has(id));

    if (missing.length > 0) setExpanded((previous) => new Set([...previous, ...missing]));
    const group = root.group;
    const sectionId = sectionForGroup(group);

    if (collapsedSections.has(sectionId))
      setCollapsedSections((previous) => {
        const next = new Set(previous);
        next.delete(sectionId);

        return next;
      });

    if (collapsed.has(group))
      setCollapsed((previous) => {
        const next = new Set(previous);
        next.delete(group);

        return next;
      });

    if (missing.length > 0 || collapsed.has(group) || collapsedSections.has(sectionId)) return;

    const index = items.findIndex(
      (item) => item.kind === "chat" && item.thread.id === activeThreadId,
    );

    if (index >= 0) {
      virtualizer.scrollToIndex(index, { align: "auto" });
      pendingReveal.current = null;

      return;
    }
  }, [activeThreadId, items, virtualizer, tree, collapsed, collapsedSections, expanded, status]);

  const virtualRows = virtualizer.getVirtualItems();
  const firstVisible = virtualRows.find((row) => row.end > (virtualizer.scrollOffset ?? 0));
  const visibleItem = firstVisible === undefined ? undefined : items[firstVisible.index];

  const stickyHeading =
    visibleItem !== undefined && visibleItem.kind !== "section"
      ? items.find(
          (item): item is SectionEntry =>
            item.kind === "section" && item.section.id === visibleItem.sectionId,
        )
      : undefined;

  return (
    <div
      ref={scrollRef}
      className="cg-list"
      data-chat-groups="list"
      role="navigation"
      aria-label="Chats grouped by status"
    >
      {workflows.failed ? (
        <p role="alert" className="cg-notice">
          Could not check workflow progress. Ready status is paused.
        </p>
      ) : null}
      {status !== "ready" ? (
        <p role={status === "error" ? "alert" : "status"} className="cg-notice">
          {status === "error"
            ? "Could not load chats. Refresh Omnyo to try again."
            : "Loading chats…"}
        </p>
      ) : items.length === 0 ? (
        <p className="cg-notice">No chats to show.</p>
      ) : (
        <>
          {stickyHeading ? (
            <div className="cg-sticky-section">
              <SectionHeader
                item={stickyHeading}
                collapsed={false}
                onToggle={toggleSection}
                sticky
              />
            </div>
          ) : null}
          <div className="cg-list-space" style={{ height: virtualizer.getTotalSize() }}>
            {virtualRows.map((virtualRow) => {
              const item = items[virtualRow.index];

              if (item === undefined) return null;

              return (
                <div
                  key={item.key}
                  ref={virtualizer.measureElement}
                  data-index={virtualRow.index}
                  data-kind={item.kind}
                  data-chat-section={item.kind === "section" ? item.section.id : item.sectionId}
                  data-project-block={
                    item.kind === "project"
                      ? item.key
                      : item.kind === "chat"
                        ? item.projectBlock
                        : undefined
                  }
                  data-project-end={item.kind === "chat" && item.projectEnd ? "" : undefined}
                  className="cg-list-item"
                  style={{ transform: `translateY(${virtualRow.start}px)` }}
                >
                  {item.kind === "section" ? (
                    <SectionHeader
                      item={item}
                      collapsed={collapsedSections.has(item.section.id)}
                      onToggle={toggleSection}
                    />
                  ) : item.kind === "project" ? (
                    <ProjectHeader item={item} />
                  ) : item.kind === "chat" ? (
                    <ChatRow
                      item={item}
                      active={item.thread.id === activeThreadId}
                      onNavigate={onNavigate}
                      expanded={expanded.has(item.thread.id)}
                      onToggle={toggleThread}
                      onArchive={archiveAndNext}
                    />
                  ) : (
                    <h3 className="cg-group-frame">
                      <button
                        type="button"
                        className="cg-group-heading"
                        data-chat-group-header={item.group.id}
                        data-read-state={item.group.readState ?? undefined}
                        aria-label={`${item.group.readState ? `${item.group.readState} · ` : ""}${item.group.label} (${item.count})`}
                        aria-expanded={!collapsed.has(item.group.id)}
                        onClick={() =>
                          setCollapsed((previous) => {
                            const next = new Set(previous);

                            if (next.has(item.group.id)) next.delete(item.group.id);
                            else next.add(item.group.id);

                            return next;
                          })
                        }
                      >
                        <Icon
                          name={collapsed.has(item.group.id) ? "ChevronRight" : "ChevronDown"}
                          aria-hidden
                          className="size-3"
                        />
                        <span className="cg-group-title">{item.group.label}</span>
                        <Icon name={item.group.icon} aria-hidden className="cg-group-icon size-3" />
                        <span className="cg-group-count">{item.count}</span>
                      </button>
                    </h3>
                  )}
                </div>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}

export default definePluginApp((app) => {
  app.experimental_sidebarFooter.register({
    kind: "disclosure",
    id: "view-toggle",
    label: "Chat view",
    icon: "FilterHorizontal",
    component: ViewToggle,
  });
  app.slots.experimental_threadList({
    id: "groups",
    title: "Chats by status",
    description: "Unread chats first, then read chats, with working chats last.",
    component: GroupedChats,
  });
  app.slots.experimental_threadHeaderAction({
    id: "project",
    title: "Chat project",
    component: ProjectPill,
  });
});
