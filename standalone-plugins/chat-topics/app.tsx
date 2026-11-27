import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { z } from "zod";
import {
  definePluginApp,
  experimental_Icon as Icon,
  experimental_useSidebarThreadSplit,
  experimental_useAppNavigate,
  experimental_useProjectSidebarItems,
  UrlLink,
  useSdk,
  useSidebarThreadDraft,
  useSidebarThreadShortcut,
} from "@omnyo/plugin-sdk/app";
import type { PluginSidebarThread, PluginThreadListProps } from "@omnyo/plugin-sdk/app";
import { ProjectItems } from "./components/project-items.tsx";
import { projectSidebarClaims, unclaimedProjectThreads } from "./lib/project-sidebar.ts";
import { LiveCapsule } from "./components/capsule.tsx";
import { ChatSelection, useChatSelected } from "./components/chat-selection.tsx";
import { ChatActionsMenu, ChatRowMenu } from "./components/chat-actions.tsx";
import { ChatGroupRow } from "./components/chat-group-row.tsx";
import { useInlineTitleEdit } from "./components/title-edit.tsx";
import { useShelfDrag, type ShelfRowDrag } from "./components/shelf-drag.ts";
import { ContinuationMark } from "./components/continuation-mark.tsx";
import { InboxFeed, openFromClick, ShelfMore } from "./components/feed.tsx";
import { ListMotion } from "./components/list-motion.tsx";
import { RowAgeSlot, RowRail, SubChatToggle } from "./components/row-rail.tsx";
import { OnYouChip } from "./components/on-you-chip.tsx";
import { DOT_LABEL, StateDot, nodeDot, rootDot, type DotKind } from "./components/state-dot.tsx";
import { InboxSectionSettings } from "./components/inbox-settings.tsx";
import type { InboxSectionKey } from "./lib/inbox-order.ts";
import { InboxViewMenu } from "./components/inbox-view-menu.tsx";
import { TagSettings } from "./components/tag-settings.tsx";
import { TaskManagerCard, TaskManagerToggle } from "./components/task-manager.tsx";
import { ThreadUsage } from "./components/thread-usage.tsx";
import { useTaskUsage, type TaskUsage } from "./lib/use-task-usage.ts";
import { mountTaskManagerList, useTaskManager, useTaskManagerFooter } from "./lib/task-manager.ts";
import { tagMenuItems } from "./components/tags.tsx";
import { useListDiagnostics } from "./lib/list-diagnostics.ts";
import { rowLine, rowSummary } from "./lib/feed.ts";
import { chatTapOptions } from "./lib/chat-tap.ts";
import { chatCount } from "./lib/naming.ts";
import {
  groupFoldKey,
  placeProject,
  type ChatGroup,
  type PlacedSection,
} from "./lib/chat-groups.ts";
import {
  buildTree,
  PROJECT_SECTIONS,
  countReachable,
  groupProjects,
  groupThreadOf,
  isProjectRoot,
  projectGroup,
  rootAttention,
  rootsInProject,
  showsUnread,
  hasFamilyActivity,
  type ChatNode,
  type ChatState,
  type ProjectGroup,
  type ProjectSectionKey,
  type RootEntry,
} from "./lib/grouping.ts";
import { useShelfSidebarThreads, type ShelfPages } from "./lib/plugin-sdk-shelf.ts";
import { useScrollFade } from "./lib/scroll-fade.ts";
import { withHeldShelf, type ShelfSlot } from "./lib/shelf-order.ts";
import { useShelfReorder } from "./lib/use-shelf-reorder.ts";
import { readStored, writeStored } from "./lib/storage.ts";
import { familyChildCount } from "./lib/subagents.ts";
import { findTag, type Tag } from "./lib/tags.ts";
import { useSubchatExpansion } from "./lib/subchat-expansion.ts";
import { useTags } from "./lib/use-tags.ts";
import "./app.css";
import "./task-manager.css";

const VIEW_KEY = "chat-topics:view";

const FOLDS_KEY = "chat-topics:folds";

const INBOX_SHELF_KEY = "section:inbox:shelved";

function inboxSectionFoldKey(key: InboxSectionKey): string {
  return `section:inbox:${key}`;
}

const scopeSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("inbox") }),
  z.object({ kind: z.literal("project"), projectId: z.string().min(1) }),
]);

const scopePropsSchema = z.object({ experimental_scope: scopeSchema.optional() });

const UNKNOWN_PROJECT = "Project unavailable";

type ViewMode = "projects" | "inbox";

type Folds = Readonly<Record<string, boolean>>;

interface Roll {
  failed: number;
  blk: number;
  need: number;
  run: number;
  fresh: number;
}

interface ProjectItem {
  kind: "project";
  key: string;
  projectId: string;
  name: string;
  count: number;
  roll: Roll;
  collapsed: boolean;
}

interface SectionItem {
  kind: "section";
  key: string;
  section: ProjectSectionKey;
  label: string;
  count: number;
  more: boolean;
  folded: boolean;
  collapsed: boolean;
}

interface ChatItem {
  kind: "chat";
  key: string;
  node: ChatNode;
  thread: PluginSidebarThread;
  depth: number;
  section: ProjectSectionKey;
  shelfList: string | null;
  folder: string | null;
}

interface GroupItem {
  kind: "group";
  key: string;
  groupId: string;
  name: string;
  count: number;
  collapsed: boolean;
  dot: DotKind;
}

interface MoreItem {
  kind: "more";
  key: string;
  pages: ShelfPages;
}

interface ProjectItemsItem {
  kind: "project-items";
  key: string;
  projectId: string;
  pinned: boolean;
}

type Item = ProjectItem | SectionItem | ChatItem | GroupItem | MoreItem | ProjectItemsItem;

const NO_GROUPS: readonly ChatGroup[] = [];

function emptyRoll(): Roll {
  return { failed: 0, blk: 0, need: 0, run: 0, fresh: 0 };
}

function addToRoll(roll: Roll, state: ChatState, unread: boolean) {
  if (state === "failed") roll.failed += 1;
  else if (state === "blk") roll.blk += 1;
  else if (state === "need") roll.need += 1;
  else if (state === "run" || state === "que") roll.run += 1;

  if (unread) roll.fresh += 1;
}

function rollEntries(entries: readonly RootEntry[]): Roll {
  const roll = emptyRoll();

  for (const entry of entries) {
    const { state, unread } = rootAttention(entry.node);
    addToRoll(roll, state, unread);
  }

  return roll;
}

function RollBadges({ roll, onInspect }: { roll: Roll; onInspect: (state: keyof Roll) => void }) {
  return (
    <span className="ct-roll">
      {roll.failed > 0 ? (
        <button
          type="button"
          onClick={() => onInspect("failed")}
          className="ct-roll-item"
          data-state="failed"
          title={`Show ${roll.failed} failed chats`}
          aria-label={`Show ${roll.failed} failed chats`}
        >
          <Icon name="AlertCircle" aria-hidden className="size-3" />
          {roll.failed}
        </button>
      ) : null}
      {roll.blk > 0 ? (
        <button
          type="button"
          onClick={() => onInspect("blk")}
          className="ct-roll-item"
          data-state="blk"
          title={`Show ${roll.blk} blocked chats`}
          aria-label={`Show ${roll.blk} blocked chats`}
        >
          <Icon name="AlertCircle" aria-hidden className="size-3" />
          {roll.blk}
        </button>
      ) : null}
      {roll.need > 0 ? (
        <button
          type="button"
          onClick={() => onInspect("need")}
          className="ct-roll-item"
          data-state="need"
          title={`Show ${roll.need} chats that need you`}
          aria-label={`Show ${roll.need} chats that need you`}
        >
          <Icon name="MessageQuestion" aria-hidden className="size-3" />
          {roll.need}
        </button>
      ) : null}
      {roll.run > 0 ? (
        <button
          type="button"
          onClick={() => onInspect("run")}
          className="ct-roll-item"
          data-state="run"
          title={`Show ${roll.run} running or queued chats`}
          aria-label={`Show ${roll.run} running or queued chats`}
        >
          <Icon name="Spinner" aria-hidden className="size-3" />
          {roll.run}
        </button>
      ) : null}
      {roll.fresh > 0 ? (
        <button
          type="button"
          onClick={() => onInspect("fresh")}
          className="ct-roll-item"
          data-state="unread"
          title={`Show ${roll.fresh} chats with new results`}
          aria-label={`Show ${roll.fresh} chats with new results`}
        >
          <Icon name="Circle" aria-hidden className="size-2.5" />
          {roll.fresh}
        </button>
      ) : null}
    </span>
  );
}

interface ChatRowProps {
  usage: TaskUsage;
  item: ChatItem;
  tag: Tag | null;
  tags: readonly Tag[];
  onTag: (threadId: string, tagId: string | null) => Promise<void>;
  active: boolean;
  compact: boolean;
  expanded: boolean;
  onToggle: (id: string) => void;
  onNavigate: () => void;
  onHint: (row: HTMLElement, title: string) => void;
  onHintEnd: () => void;
  shelfDrag: ShelfRowDrag;
  onShelfPointerDown: (event: ReactPointerEvent<HTMLElement>) => void;
}

const ChatRow = memo(function ChatRow({
  usage,
  item,
  tag,
  tags,
  onTag,
  active,
  compact,
  expanded,
  onToggle,
  onNavigate,
  onHint,
  onHintEnd,
  shelfDrag,
  onShelfPointerDown,
}: ChatRowProps) {
  const { thread, node, depth, section, shelfList, folder } = item;
  const indent = folder === null ? depth : depth + 1;
  const navigate = experimental_useAppNavigate();
  const { hasUnsubmittedDraft } = useSidebarThreadDraft(thread.id);
  const shortcut = useSidebarThreadShortcut(thread.id);
  const { splitProps } = experimental_useSidebarThreadSplit(thread.id);
  const [failure, setFailure] = useState<string | null>(null);
  const titleEdit = useInlineTitleEdit(thread);
  const isRenaming = titleEdit.isEditing;
  const title = thread.displayTitle;
  const selected = useChatSelected(thread.id);

  const childCount = familyChildCount(node);
  const shelved = section === "shelf";
  const unread = !shelved && showsUnread(node) && !active;
  const rowLabel = unread ? `${title}. Unread result` : title;

  const asking = !shelved && rootAttention(node).asking;
  const dot = asking ? "need" : nodeDot(node);
  const detail = rowLine(node);
  const label = detail.reason ?? "Work summary unavailable";
  const summary = shelved ? null : rowSummary(node, thread.experimental_subtitle);

  const rowFailure = titleEdit.error ?? failure;

  const run = (work: () => Promise<void>, text: string) => {
    setFailure(null);

    work().catch(() => setFailure(text));
  };

  const pickTag = (tagId: string | null) =>
    run(() => onTag(thread.id, tagId), "Could not change the tag.");

  const tagItems = tagMenuItems(tags, tag, pickTag);

  const renameInline = () => {
    onHintEnd();
    setFailure(null);
    titleEdit.start();
  };

  return (
    <ChatRowMenu
      thread={thread}
      inline={tagItems}
      onRename={compact || isRenaming ? undefined : renameInline}
    >
      <div
        className={`ct-row omnyo-sidebar-hover-actions-row${active ? " omnyo-sidebar-selected-row" : ""}`}
        data-sidebar-row-presentation="owned"
        data-active={active}
        data-state={shelved ? "shelf" : asking ? "need" : node.state}
        data-asking={asking}
        data-unread={unread}
        data-depth={indent}
        data-chat-group={folder ?? undefined}
        data-tag={tag?.id}
        data-shelf-list={shelfList ?? undefined}
        data-shelf-row={shelfList === null ? undefined : thread.id}
        data-shelf-drag={shelfDrag ?? undefined}
        style={indent > 0 ? { paddingInlineStart: indent * 14 } : undefined}
        onPointerDown={shelfList === null ? undefined : onShelfPointerDown}
      >
        <a
          {...splitProps}
          href={isRenaming ? undefined : thread.href}
          className="ct-row-link"
          data-sidebar-thread-id={thread.id}
          data-chat-selection-id={isRenaming ? undefined : thread.id}
          data-chat-selected={selected || undefined}
          data-sidebar-thread-shortcut-target=""
          data-unread={unread}
          data-project-id={thread.projectId}
          data-parent-thread-id={thread.parentThreadId ?? undefined}
          data-chat-depth={depth}
          aria-current={active ? "page" : undefined}
          aria-label={selected ? `${rowLabel}, selected` : rowLabel}
          aria-description={label}
          title={`${DOT_LABEL[dot]}: ${label}`}
          aria-keyshortcuts={shortcut?.ariaKeyshortcuts}
          onPointerEnter={(event) => {
            if (isRenaming) return;

            if (event.pointerType === "mouse") onHint(event.currentTarget, title);
          }}
          onPointerLeave={onHintEnd}
          onClick={(event) => {
            if (isRenaming) {
              event.preventDefault();

              return;
            }

            openFromClick(event, (split) => {
              onHintEnd();
              navigate.toThread(thread.id, chatTapOptions(split));
              onNavigate();
            });
          }}
        >
          <StateDot kind={dot} label={label} agents={childCount} />
          {(asking || node.state !== "run") && hasFamilyActivity(node) ? (
            <StateDot kind="run" label="Working" agents={childCount} />
          ) : null}
          {unread ? <span className="ct-unread-dot" aria-hidden /> : null}
          <span className="ct-row-text">
            {titleEdit.editor ?? <span className="omnyo-thread-title ct-row-title">{title}</span>}
            {!isRenaming && summary !== null ? (
              <span className="ct-row-summary text-xs">{summary}</span>
            ) : null}
            <ThreadUsage usage={usage} threadId={thread.id} status={thread.status} />
          </span>
          {isRenaming ? null : (
            <RowAgeSlot
              at={Math.max(thread.createdAt, thread.lastMessageAt ?? 0)}
              verb="Last message"
            />
          )}
          <ContinuationMark node={node} />
          {thread.isPinned && section !== "pinned" ? (
            <Icon name="Pin" className="ct-pin size-3" data-ct-trailing="" aria-label="Pinned" />
          ) : null}
          {shortcut !== null ? (
            <kbd className="ct-kbd" data-ct-trailing="">
              {shortcut.label}
            </kbd>
          ) : null}
        </a>
        {rowFailure !== null ? (
          <span
            role="alert"
            className="ct-row-alert"
            data-ct-trailing=""
            title={rowFailure}
            aria-label={rowFailure}
          >
            <Icon name="AlertCircle" className="size-3.5" />
          </span>
        ) : null}
        {hasUnsubmittedDraft ? (
          <span
            className="ct-draft"
            data-ct-trailing=""
            data-sidebar-thread-trailing-indicator=""
            role="img"
            aria-label="Unsent draft"
            title="Unsent draft"
          >
            <Icon name="Edit" className="size-3" aria-hidden />
          </span>
        ) : null}
        <RowRail
          kids={
            node.children.length > 0 ? (
              <SubChatToggle
                count={node.children.length}
                fresh={node.newChildren}
                expanded={expanded}
                title={title}
                onToggle={() => onToggle(thread.id)}
              />
            ) : null
          }
          menu={
            <ChatActionsMenu
              thread={thread}
              inline={tagItems}
              onRename={compact ? undefined : renameInline}
            />
          }
        />
      </div>
    </ChatRowMenu>
  );
});

function ViewToggle({ view, onChange }: { view: ViewMode; onChange: (view: ViewMode) => void }) {
  return (
    <div role="group" aria-label="Chat view" className="ct-toggle">
      <button
        type="button"
        className="ct-toggle-button"
        aria-pressed={view === "projects"}
        onClick={() => onChange("projects")}
      >
        <Icon name="Folder" aria-hidden className="size-3.5" />
        Projects
      </button>
      <button
        type="button"
        className="ct-toggle-button"
        aria-pressed={view === "inbox"}
        onClick={() => onChange("inbox")}
      >
        <Icon name="Mail" aria-hidden className="size-3.5" />
        Inbox
      </button>
    </div>
  );
}

const CHIEF_PLUGIN_ID = "chief";

function SwipeThrough() {
  const sdk = useSdk();
  const [running, setRunning] = useState(false);

  useEffect(() => {
    let live = true;

    const check = () => {
      sdk.plugins.list().then(
        ({ plugins }) => {
          if (live)
            setRunning(
              plugins.some(
                (plugin) => plugin.id === CHIEF_PLUGIN_ID && plugin.status === "running",
              ),
            );
        },
        () => {
          if (live) setRunning(false);
        },
      );
    };

    check();
    window.addEventListener("focus", check);

    return () => {
      live = false;
      window.removeEventListener("focus", check);
    };
  }, [sdk]);

  if (!running) return null;

  return (
    <UrlLink href={`/plugins/${CHIEF_PLUGIN_ID}/home`} className="ct-toggle-button">
      <Icon name="Layers" aria-hidden className="size-3.5" />
      Swipe through
    </UrlLink>
  );
}

interface Hint {
  title: string;
  left: number;
  width: number;
  top: number;
  below: boolean;
}

const HINT_DELAY = 350;

const HINT_ROOM = 96;

function isClipped(row: HTMLElement): boolean {
  const title = row.querySelector(".ct-row-title");

  return title !== null && title.scrollWidth > title.clientWidth + 1;
}

function HoverHint({ hint }: { hint: Hint }) {
  return (
    <div
      role="tooltip"
      className="ct-hint"
      data-side={hint.below ? "below" : "above"}
      style={{ left: hint.left, width: hint.width, top: hint.top }}
    >
      <span className="ct-hint-title">{hint.title}</span>
    </div>
  );
}

function ChatList(props: PluginThreadListProps) {
  const { activeThreadId, onNavigate } = props;
  const { status, threads, projects, shelfPages, experimental_groups } = useShelfSidebarThreads();
  const chatGroups = experimental_groups ?? NO_GROUPS;
  const navigate = experimental_useAppNavigate();
  const collectedProjectItems = experimental_useProjectSidebarItems();

  const projectItems = useMemo(
    () =>
      collectedProjectItems.filter((group) =>
        projects.some((project) => project.id === group.projectId),
      ),
    [collectedProjectItems, projects],
  );

  const claims = useMemo(
    () => projectSidebarClaims(projectItems, new Set(projects.map((project) => project.id))),
    [projectItems, projects],
  );

  const scrollRef = useRef<HTMLDivElement>(null);
  useScrollFade(scrollRef);
  useListDiagnostics(scrollRef);
  const [hint, setHint] = useState<Hint | null>(null);
  const hintTimer = useRef<number | undefined>(undefined);
  const lastActive = useRef<string | null>(null);
  const parsedScope = scopePropsSchema.safeParse(props);
  const scope = parsedScope.success ? (parsedScope.data.experimental_scope ?? null) : null;
  const scopeProjectId = scope?.kind === "project" ? scope.projectId : null;
  const scopeKey = scope === null ? null : (scopeProjectId ?? "inbox");

  const [storedView, setStoredView] = useState<ViewMode>(() =>
    readStored(VIEW_KEY, z.enum(["projects", "inbox"]), "projects"),
  );

  const view: ViewMode =
    scope === null ? storedView : scope.kind === "inbox" ? "inbox" : "projects";

  const [folds, setFolds] = useState<Folds>(() =>
    readStored(FOLDS_KEY, z.record(z.string(), z.boolean()), {}),
  );

  const [inspectTarget, setInspectTarget] = useState<string | null>(null);

  const visible = useMemo(
    () => threads.filter((thread) => !thread.isHidden && !thread.isArchived),
    [threads],
  );

  const byId = useMemo(() => new Map(visible.map((thread) => [thread.id, thread])), [visible]);
  const ids = useMemo(() => visible.map((thread) => thread.id), [visible]);
  const allThreads = useMemo(() => visible.map(groupThreadOf), [visible]);
  const tagState = useTags(ids);
  const { tags, tagIdOf, setTag } = tagState;

  const tagOf = useCallback(
    (threadId: string) => findTag(tags, tagIdOf(threadId)),
    [tags, tagIdOf],
  );

  const groupThreads = allThreads;
  useLayoutEffect(mountTaskManagerList, []);
  const taskManager = useTaskManager();
  const taskManagerInFooter = useTaskManagerFooter();
  const usage = useTaskUsage(taskManager, threads);

  const shelfReorder = useShelfReorder(allThreads);

  const tree = useMemo(
    () =>
      withHeldShelf(
        buildTree(unclaimedProjectThreads(groupThreads, claims, view)),
        shelfReorder.order,
      ),
    [groupThreads, claims, view, shelfReorder.order],
  );

  const { expanded, toggle: toggleSubchats } = useSubchatExpansion(tree, activeThreadId);

  const projectNames = useMemo(
    () => new Map(projects.map((project) => [project.id, project.name])),
    [projects],
  );

  const scopedRoots = useMemo(
    () => (scopeProjectId === null ? tree.roots : rootsInProject(tree.roots, scopeProjectId)),
    [tree, scopeProjectId],
  );

  const scopedGroup: ProjectGroup | null = useMemo(
    () =>
      scopeProjectId === null
        ? null
        : projectGroup(scopeProjectId, scopedRoots, rootsInProject(tree.shelf, scopeProjectId)),
    [scopeProjectId, scopedRoots, tree],
  );

  const scopedName =
    scopeProjectId === null ? null : (projectNames.get(scopeProjectId) ?? UNKNOWN_PROJECT);

  const isFolded = useCallback((key: string, fallback: boolean) => folds[key] ?? fallback, [folds]);

  const toggleFold = useCallback((key: string, fallback: boolean) => {
    setFolds((previous) => {
      const next = { ...previous, [key]: !(previous[key] ?? fallback) };
      writeStored(FOLDS_KEY, next);

      return next;
    });
  }, []);

  const isInboxSectionFolded = useCallback(
    (key: InboxSectionKey) =>
      key === "shelf" ? isFolded(INBOX_SHELF_KEY, true) : isFolded(inboxSectionFoldKey(key), false),
    [isFolded],
  );

  const toggleInboxSection = useCallback(
    (key: InboxSectionKey) =>
      key === "shelf"
        ? toggleFold(INBOX_SHELF_KEY, true)
        : toggleFold(inboxSectionFoldKey(key), false),
    [toggleFold],
  );

  const toggleGroup = useCallback(
    (groupId: string) => toggleFold(groupFoldKey(groupId), false),
    [toggleFold],
  );

  const changeView = useCallback((next: ViewMode) => {
    setStoredView(next);
    writeStored(VIEW_KEY, next);
  }, []);

  const endHint = useCallback(() => {
    window.clearTimeout(hintTimer.current);
    setHint(null);
  }, []);

  const startHint = useCallback((link: HTMLElement, title: string) => {
    window.clearTimeout(hintTimer.current);
    hintTimer.current = window.setTimeout(() => {
      const list = scrollRef.current;
      const row = link.closest<HTMLElement>(".ct-row");

      if (list === null || row === null || !row.isConnected || !isClipped(row)) return;
      const origin = list.getBoundingClientRect();
      const box = row.getBoundingClientRect();
      const below = box.bottom + HINT_ROOM < origin.bottom;

      setHint({
        title,
        left: box.left - origin.left,
        width: box.width,
        top: (below ? box.bottom + 4 : box.top - 4) - origin.top + list.scrollTop,
        below,
      });
    }, HINT_DELAY);
  }, []);

  useEffect(() => () => window.clearTimeout(hintTimer.current), []);

  const composeIn = useCallback(
    (projectId: string) => {
      navigate.toCompose({ projectId });
      onNavigate();
    },
    [navigate, onNavigate],
  );

  const items = useMemo(() => {
    const result: Item[] = [];

    const shelfRoots = new Set(
      tree.shelf.flatMap((node) => (node.thread.parentThreadId === null ? [node.thread.id] : [])),
    );

    const appendNode = (
      node: ChatNode,
      depth: number,
      section: ProjectSectionKey,
      shelfList: string | null,
      folder: string | null,
    ) => {
      const thread = byId.get(node.thread.id);

      if (thread === undefined) return;

      result.push({
        kind: "chat",
        key: thread.id,
        node,
        thread,
        depth,
        section,
        shelfList,
        folder,
      });

      if (expanded.has(thread.id))
        for (const child of node.children) appendNode(child, depth + 1, section, null, folder);
    };

    const appendEntry = (entry: RootEntry, section: ProjectSectionKey, list: string) => {
      const draggable = section === "shelf" && shelfRoots.has(entry.node.thread.id);
      appendNode(entry.node, 0, section, draggable ? list : null, null);
    };

    const appendSection = (projectId: string, section: PlacedSection, pages: ShelfPages | null) => {
      const key = `section:${projectId}:${section.key}`;
      const collapsed = isFolded(key, section.folded);
      const more = pages !== null && pages.hasNextPage;

      result.push({
        kind: "section",
        key,
        section: section.key,
        label: section.label,
        count: section.count,
        more,
        folded: section.folded,
        collapsed,
      });

      if (collapsed) return;

      for (const row of section.rows) {
        if (row.kind === "chat") {
          appendEntry(row.entry, section.key, key);
          continue;
        }

        const groupKey = groupFoldKey(row.group.id);
        const groupCollapsed = isFolded(groupKey, false);
        const lead = row.members[0].node;

        result.push({
          kind: "group",
          key: groupKey,
          groupId: row.group.id,
          name: row.group.name,
          count: row.members.length,
          collapsed: groupCollapsed,
          dot: rootDot(lead),
        });

        if (groupCollapsed) continue;

        for (const member of row.members)
          appendNode(member.node, 0, section.key, null, row.group.id);
      }

      if (more) result.push({ kind: "more", key: `more:${key}`, pages });
    };

    const appendProjectItems = (projectId: string, pinned: boolean) => {
      if (projectItems.some((group) => group.projectId === projectId && group.items.length > 0))
        result.push({
          kind: "project-items",
          key: `project-items:${projectId}`,
          projectId,
          pinned,
        });
    };

    const appendSections = (group: ProjectGroup) => {
      const placed = placeProject(group, chatGroups);

      for (const section of placed.sections) appendSection(group.projectId, section, null);

      if (placed.shelf !== null) appendSection(group.projectId, placed.shelf, shelfPages);
    };

    if (view === "inbox") return result;

    if (scopedGroup !== null) {
      appendProjectItems(scopedGroup.projectId, true);
      appendSections(scopedGroup);

      return result;
    }

    const groups = groupProjects(tree);

    for (const project of projects)
      if (
        !groups.some((group) => group.projectId === project.id) &&
        projectItems.some((group) => group.projectId === project.id && group.items.length > 0)
      )
        groups.push(projectGroup(project.id, [], []));

    for (const group of groups) {
      const key = `project:${group.projectId}`;
      const collapsed = isFolded(key, false);

      const entries = group.sections
        .flatMap((section) => section.entries)
        .filter(({ node }) => isProjectRoot(node));

      result.push({
        kind: "project",
        key,
        projectId: group.projectId,
        name: projectNames.get(group.projectId) ?? UNKNOWN_PROJECT,
        count: entries.length,
        roll: rollEntries(entries),
        collapsed,
      });

      if (!collapsed) {
        appendProjectItems(group.projectId, false);
        appendSections(group);
      }
    }

    return result;
  }, [
    view,
    scopedGroup,
    tree,
    projects,
    projectItems,
    projectNames,
    byId,
    expanded,
    isFolded,
    shelfPages,
    chatGroups,
  ]);

  const shelfDrag = useShelfDrag(
    !props.isCompactViewport && !shelfReorder.busy,
    scrollRef,
    (list, movedId, targetId, place) => {
      const slots = items.flatMap((item): ShelfSlot[] =>
        item.kind === "chat" && item.shelfList === list
          ? [{ id: item.thread.id, keyed: item.node.thread.shelfSortKey !== null }]
          : [],
      );

      shelfReorder.move(slots, movedId, targetId, place);
    },
  );

  const getItemKey = useCallback((index: number) => items[index].key, [items]);
  const showToolbar = scope === null;
  const toolbarRef = useRef<HTMLDivElement>(null);
  const [toolbarHeight, setToolbarHeight] = useState(0);

  useLayoutEffect(() => {
    const toolbar = toolbarRef.current;

    if (toolbar === null) {
      setToolbarHeight(0);

      return;
    }

    const measure = () => setToolbarHeight(toolbar.offsetHeight);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(toolbar);

    return () => observer.disconnect();
  }, [showToolbar]);

  useLayoutEffect(() => {
    scrollRef.current?.style.setProperty("--ct-toolbar-height", `${toolbarHeight}px`);
  }, [toolbarHeight]);

  const virtualizer = useVirtualizer({
    count: items.length,
    getScrollElement: () => scrollRef.current,
    getItemKey,
    scrollMargin: toolbarHeight,
    scrollPaddingStart: toolbarHeight,
    estimateSize: (index) => {
      const item = items[index];

      if (item.kind === "project") return 34;

      if (item.kind === "section") return index === 0 ? 30 : 36;

      if (item.kind === "group") return 30;

      if (item.kind === "more") return 24;

      return item.kind === "chat" &&
        rowSummary(item.node, item.thread.experimental_subtitle) !== null
        ? 48
        : 32;
    },
    overscan: 12,
  });

  useEffect(() => {
    if (inspectTarget === null) return;
    const index = items.findIndex((item) => item.key === inspectTarget);

    if (index === -1) return;
    virtualizer.scrollToIndex(index, { align: "start" });
    setInspectTarget(null);
  }, [inspectTarget, items, virtualizer]);

  const inspectProjectState = (projectId: string, state: keyof Roll) => {
    const node = rootsInProject(tree.roots, projectId).find((node) => {
      const attention = rootAttention(node);

      return state === "fresh"
        ? attention.unread
        : state === "run"
          ? attention.state === "run" || attention.state === "que"
          : attention.state === state;
    });

    if (node === undefined) return;

    const unfolded = Object.fromEntries(
      [
        "project:" + projectId,
        ...PROJECT_SECTIONS.map((section) => `section:${projectId}:${section.key}`),
        ...(node.thread.groupId === null ? [] : [groupFoldKey(node.thread.groupId)]),
      ].map((key) => [key, false]),
    );

    setFolds((previous) => {
      const next = { ...previous, ...unfolded };
      writeStored(FOLDS_KEY, next);

      return next;
    });
    setInspectTarget(node.thread.id);
  };

  useEffect(() => {
    lastActive.current = null;

    if (scrollRef.current !== null) scrollRef.current.scrollTop = 0;
  }, [scopeKey]);

  useEffect(() => {
    if (activeThreadId === null || activeThreadId === lastActive.current) return;

    const index = items.findIndex(
      (item) => item.kind === "chat" && item.thread.id === activeThreadId,
    );

    if (index < 0) return;
    lastActive.current = activeThreadId;
    virtualizer.scrollToIndex(index, { align: "auto" });
  }, [activeThreadId, items, virtualizer]);

  const total = useMemo(
    () =>
      groupThreads.filter(
        (thread) =>
          thread.shelvedAt === null &&
          (scopeProjectId === null || thread.projectId === scopeProjectId),
      ).length,
    [groupThreads, scopeProjectId],
  );

  const reachable = useMemo(
    () =>
      countReachable(scopedRoots, scopeProjectId) +
      (view === "projects"
        ? groupThreads.filter(
            (thread) =>
              thread.shelvedAt === null &&
              (scopeProjectId === null || thread.projectId === scopeProjectId) &&
              claims.get(thread.projectId)?.has(thread.id),
          ).length
        : 0),
    [scopedRoots, scopeProjectId, view, groupThreads, claims],
  );

  const listLabel =
    scopedName !== null
      ? `Chats in ${scopedName}`
      : view === "inbox"
        ? "Chats by what needs you"
        : "Chats by project and state";

  const selectionOrder = useMemo(
    () =>
      view === "projects"
        ? items.flatMap((item) => (item.kind === "chat" ? [item.thread.id] : []))
        : null,
    [items, view],
  );

  return (
    <div className="ct-shell" role="navigation" aria-label={listLabel}>
      <InboxViewMenu disabled={view !== "inbox" || props.isCompactViewport}>
        <ChatSelection
          scope={JSON.stringify([scopeKey, view])}
          activeThreadId={activeThreadId}
          visibleOrder={selectionOrder}
          ref={scrollRef}
          className="ct-list"
          data-chat-topics={view}
          data-chat-scope={scopeKey ?? undefined}
          data-chat-total={total}
          data-chat-reachable={reachable}
          onScroll={hint === null ? undefined : endHint}
        >
          {showToolbar ? (
            <div ref={toolbarRef} className="ct-toolbar">
              {scope === null ? <ViewToggle view={view} onChange={changeView} /> : null}
              {scope === null && view === "inbox" ? <SwipeThrough /> : null}
            </div>
          ) : null}
          {tagState.failed ? (
            <p role="alert" className="ct-notice">
              Could not load tags. Chats keep their titles.
            </p>
          ) : null}
          {shelfPages?.status === "error" ? (
            <p role="alert" className="ct-notice">
              Could not load shelved chats. Refresh Omnyo to try again.
            </p>
          ) : null}
          {shelfReorder.failed ? (
            <p role="alert" className="ct-notice">
              Could not move that chat on the Shelf. Try again.
            </p>
          ) : null}
          {status !== "ready" ? (
            <p role={status === "error" ? "alert" : "status"} className="ct-notice">
              {status === "error"
                ? "Could not load chats. Refresh Omnyo to try again."
                : "Loading chats…"}
            </p>
          ) : view === "inbox" ? (
            <InboxFeed
              list={scrollRef}
              threads={threads}
              byId={byId}
              projectNames={projectNames}
              activeThreadId={activeThreadId}
              touch={props.isCompactViewport}
              usage={usage}
              isSectionFolded={isInboxSectionFolded}
              shelfReorder={shelfReorder}
              tags={tags}
              tagOf={tagOf}
              onTag={setTag}
              onToggleSection={toggleInboxSection}
              onNavigate={onNavigate}
            />
          ) : scopedGroup !== null &&
            scopedGroup.sections.length === 0 &&
            scopedGroup.shelf === null &&
            !projectItems.some(
              (group) => group.projectId === scopedGroup.projectId && group.items.length > 0,
            ) ? (
            <div className="ct-empty">
              <p className="ct-empty-text">No chats yet</p>
              <button
                type="button"
                className="ct-empty-new"
                onClick={() => composeIn(scopedGroup.projectId)}
              >
                <Icon name="Plus" aria-hidden className="size-3.5" />
                New chat
              </button>
            </div>
          ) : items.length === 0 ? (
            <p className="ct-notice">No chats yet.</p>
          ) : (
            <ListMotion
              scopeKey={scopeKey}
              className="ct-space"
              style={{ height: virtualizer.getTotalSize() }}
            >
              {virtualizer.getVirtualItems().map((row) => {
                const item = items[row.index];

                if (item === undefined) return null;

                return (
                  <div
                    key={item.key}
                    ref={virtualizer.measureElement}
                    data-index={row.index}
                    data-chat-motion-key={item.key}
                    data-kind={item.kind}
                    data-first={row.index === 0 ? "" : undefined}
                    className="ct-item"
                    style={{ transform: `translateY(${row.start - toolbarHeight}px)` }}
                  >
                    {item.kind === "project-items" ? (
                      <ProjectItems
                        groups={projectItems}
                        projectId={item.projectId}
                        pinned={item.pinned}
                        activeThreadId={activeThreadId}
                        onNavigate={onNavigate}
                      />
                    ) : item.kind === "chat" ? (
                      <ChatRow
                        item={item}
                        usage={usage}
                        tag={tagOf(item.thread.id)}
                        tags={tags}
                        onTag={setTag}
                        active={item.thread.id === activeThreadId}
                        compact={props.isCompactViewport}
                        expanded={expanded.has(item.thread.id)}
                        onToggle={toggleSubchats}
                        onNavigate={onNavigate}
                        onHint={startHint}
                        onHintEnd={endHint}
                        shelfDrag={shelfDrag.stateOf(item.thread.id)}
                        onShelfPointerDown={shelfDrag.begin}
                      />
                    ) : item.kind === "group" ? (
                      <ChatGroupRow
                        groupId={item.groupId}
                        name={item.name}
                        count={item.count}
                        collapsed={item.collapsed}
                        dot={item.dot}
                        dotLabel={DOT_LABEL[item.dot]}
                        onToggle={toggleGroup}
                      />
                    ) : item.kind === "project" ? (
                      <div className="ct-project" data-project-id={item.projectId}>
                        <button
                          type="button"
                          className="ct-project-button"
                          aria-expanded={!item.collapsed}
                          aria-label={`${item.name}, ${chatCount(item.count)}`}
                          onClick={() => toggleFold(item.key, false)}
                        >
                          <Icon
                            name={item.collapsed ? "ChevronRight" : "ChevronDown"}
                            aria-hidden
                            className="ct-fold size-3"
                          />
                          <span className="ct-project-name">{item.name}</span>
                          <span className="ct-count" title={`${item.count} top-level chats`}>
                            {item.count} chats
                          </span>
                        </button>
                        <RollBadges
                          roll={item.roll}
                          onInspect={(state) => inspectProjectState(item.projectId, state)}
                        />
                        <button
                          type="button"
                          className="ct-project-new"
                          aria-label={`New chat in ${item.name}`}
                          title="New chat"
                          onClick={() => composeIn(item.projectId)}
                        >
                          <Icon name="Plus" aria-hidden className="size-3.5" />
                        </button>
                      </div>
                    ) : item.kind === "section" ? (
                      <button
                        type="button"
                        className="ct-section"
                        data-section={item.section}
                        aria-expanded={!item.collapsed}
                        aria-label={`${item.label}, ${chatCount(item.count, item.more)}`}
                        onClick={() => toggleFold(item.key, item.folded)}
                      >
                        <span className="ct-section-name">{item.label}</span>
                        <Icon name="ChevronRight" aria-hidden className="ct-section-fold size-3" />
                        <span className="ct-section-rule" aria-hidden />
                        <span className="ct-count">
                          {item.count}
                          {item.more ? "+" : ""}
                        </span>
                      </button>
                    ) : (
                      <ShelfMore pages={item.pages} className="ct-more" />
                    )}
                  </div>
                );
              })}
            </ListMotion>
          )}
          {hint === null ? null : <HoverHint hint={hint} />}
        </ChatSelection>
      </InboxViewMenu>
      {taskManagerInFooter ? null : (
        <div className="ct-task-footer">
          <TaskManagerToggle />
        </div>
      )}
    </div>
  );
}

export default definePluginApp((app) => {
  app.composer.customize({
    id: "on-you",
    scopes: ["new-thread"],
    banners: [
      {
        id: "on-you",
        chrome: "bare",
        experimental_placement: "adjacent-to-composer",
        component: OnYouChip,
      },
    ],
  });
  app.slots.experimental_threadList({
    id: "topics",
    title: "Chats by state",
    description: "Each project's chats sorted by state, plus an Inbox of chats that need you.",
    component: ChatList,
  });
  app.slots.settingsSection({
    id: "tags",
    title: "Tags",
    description: "The types of work a chat can be tagged with, in display order.",
    component: TagSettings,
  });
  app.slots.settingsSection({
    id: "inbox-sections",
    title: "Inbox sections",
    description: "Which Inbox sections appear, and their order.",
    component: InboxSectionSettings,
  });
  app.slots.experimental_sidebarFooterCard?.({ id: "live", component: LiveCapsule });
  app.slots.experimental_sidebarFooterCard?.({ id: "tag-filter", component: TaskManagerCard });
});
