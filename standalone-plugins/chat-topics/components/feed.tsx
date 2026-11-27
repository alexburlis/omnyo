import {
  Fragment,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { ComponentPropsWithRef, KeyboardEvent, MouseEvent, ReactNode, RefObject } from "react";
import {
  experimental_Icon as Icon,
  experimental_ProjectIcon as ProjectIcon,
  experimental_useSidebarThreadSplit,
  experimental_useAppNavigate,
  useComposer,
  useSidebarThreadShortcut,
} from "@omnyo/plugin-sdk/app";
import type { PluginSidebarThread, PluginThreadActionsInlineItem } from "@omnyo/plugin-sdk/app";
import { useChatSelected } from "./chat-selection.tsx";
import { rowLine, upcomingLabel } from "../lib/feed.ts";
import { chatTapOptions } from "../lib/chat-tap.ts";
import {
  markInboxMounted,
  setRunningExpanded,
  useRunningExpanded,
  useRunningReveal,
} from "../lib/feed-store.ts";
import {
  SHELF_SECTION,
  buildTree,
  familyStopping,
  groupThreadOf,
  hasFamilyActivity,
  type ChatNode,
  type ChatTree,
} from "../lib/grouping.ts";
import {
  UNDO_TOAST_MS,
  VIEW_LABEL,
  archiveRequest,
  bulkArchive,
  busyRoots,
  cardActionLine,
  chainsBehindPending,
  cardKind,
  cardSummary,
  dateInputValue,
  happenedWaitId,
  keyCommand,
  leavesInbox,
  moveLabel,
  offersUndo,
  predictAct,
  restoreThreadRows,
  predictRetry,
  openTarget,
  pickedDate,
  primaryIntent,
  primaryLabel,
  replyTarget,
  reportRequest,
  runEntry,
  shelfRows,
  waitChoices,
  waitRequest,
  waitingChip,
  waitingCondition,
  waitingDetail,
  waitingIn,
  waitingLane,
  waitingNextAt,
  WAITING_LANES,
  WAITING_LANE_LABEL,
  type ChoiceItem,
  type WaitingChip,
  type WaitingLane,
  type InboxActRequest,
  type InboxSnapshot,
  type InboxCard,
  type InboxCommand,
  type InboxEntry,
  type InboxPrimary,
  type InboxRun,
  type KeyResult,
  type WaitChoice,
  readyToArchive,
  asksWhileWorking,
  inboxSection,
  rowMark,
  type RowMark,
  shelvedOnly,
  runningProgress,
  type RunningProgress,
} from "../lib/inbox.ts";
import {
  arrangeInbox,
  cardChanges,
  recentlyChanged,
  revealAbove,
  shownCards,
  orderInboxStatusRows,
  readInboxStatusOrder,
  writeInboxStatusOrder,
  type InboxFocus,
  type InboxLayout,
  type ShownCard,
} from "../lib/inbox-layout.ts";
import type { ShelfPages } from "../lib/plugin-sdk-shelf.ts";
import { familyChildCount } from "../lib/subagents.ts";
import type { Tag } from "../lib/tags.ts";
import { createInboxFlights, undoAfter, type InboxFlight } from "../lib/inbox-store.ts";
import { useInbox, type InboxOutcome, type InboxPrediction } from "../lib/use-inbox.ts";
import { ChatActionsMenu, ChatRowMenu } from "./chat-actions.tsx";
import { RenameAlert, useInlineTitleEdit } from "./title-edit.tsx";
import { ListMotion } from "./list-motion.tsx";
import { DOT_LABEL, StateDot, nodeDot, type DotKind } from "./state-dot.tsx";
import { tagMenuItems } from "./tags.tsx";
import { RowAgeSlot, RowChip, RowRail, SubChatToggle } from "./row-rail.tsx";
import { ThreadUsage } from "./thread-usage.tsx";
import type { TaskUsage } from "../lib/use-task-usage.ts";
import { ContinuationMark } from "./continuation-mark.tsx";
import { useSectionDrag } from "./section-drag.ts";
import { useShelfDrag, type ShelfDrag } from "./shelf-drag.ts";
import { inShelfOrder, withHeldShelf, type ShelfSlot } from "../lib/shelf-order.ts";
import type { ShelfReorder } from "../lib/use-shelf-reorder.ts";
import {
  moveInboxSection,
  shownSections,
  useInboxSections,
  type InboxSectionKey,
} from "../lib/inbox-order.ts";
import { useScrolledPast } from "../lib/scrolled-past.ts";
import { useSubchatExpansion } from "../lib/subchat-expansion.ts";

const COMPOSER_WAIT_MS = 3000;

const EMPTY_SECTION: Readonly<Record<InboxSectionKey, string>> = {
  need: "Nothing needs you right now",
  failed: "No failed chats",
  finished: "No finished chats to look at",
  ready: "Nothing to archive",
  run: "Nothing is running",
  waiting: "Nothing is waiting",
  shelf: "The Shelf is empty",
};

const FEED_SECTION: Readonly<Record<InboxSectionKey, string>> = {
  need: "inbox",
  failed: "failed",
  finished: "finished",
  ready: "ready",
  run: "run",
  waiting: "waiting",
  shelf: "shelf",
};

const EVENT_MAX = 60;

const ARRIVE_MS = 600;

const FAILED_TEXT = "Couldn't do that. Try again.";

const CHANGED_TEXT = "This card just changed. Check it and try again.";

const NO_CHANGES: ReadonlyMap<string, number> = new Map();

const CHAINED_COMMANDS: ReadonlySet<InboxCommand> = new Set(["open", "reply", "shelf"]);

const NO_ENTRIES: readonly InboxEntry[] = [];

const STATE_DOT: Readonly<Record<InboxEntry["state"], DotKind>> = {
  "needs-you": "need",
  failed: "failed",
  finished: "done",
  working: "run",
  waiting: "que",
  resting: "idle",
  archive: "done",
};

const STATE_PRIORITY: Readonly<Record<InboxEntry["state"], number>> = {
  "needs-you": 0,
  failed: 0.5,
  working: 1,
  waiting: 2,
  finished: 3,
  resting: 4,
  archive: 5,
};

const INBOX_MENU_GROUP = "0_inbox";

const MENU_ACTIONS: Readonly<
  Record<"wait" | "reply", { label: string; icon: string; command: InboxCommand }>
> = {
  wait: { label: "Wait", icon: "Clock", command: "wait" },
  reply: { label: "Reply", icon: "MessageSquare", command: "reply" },
};

const PRIMARY_ICON: Readonly<Record<InboxPrimary["kind"], string>> = {
  answer: "MessageQuestion",
  "accept-proposal": "Check",
  ok: "Check",
  reply: "MessageSquare",
  archive: "Archive",
  "your-call": "CircleQuestion",
  "problem-chooser": "CircleQuestion",
  resume: "Play",
  "keep-waiting": "Clock",
  "remind-later": "Clock",
  "continue-with-result": "ArrowTurnForward",
  "archive-runs": "Archive",
  "resume-all-at-reset": "Play",
};

type Section = "inbox" | "waiting" | "shelf" | "running";

interface Cursor {
  section: Section;
  threadId: string;
}

interface Item {
  key: string;
  section: Section;
  entry: InboxEntry;
  shown: ShownCard | null;
  family: ChatNode | null;
  nested: boolean;
  ready: boolean;
}

type Overlay =
  | { kind: "choose"; key: string; items: readonly ChoiceItem[] }
  | { kind: "wait"; key: string; step: "menu" | "date" | "event" }
  | { kind: "stop"; key: string }
  | { kind: "bulk"; entries: readonly InboxEntry[] };

interface Toast {
  move: InboxFlight | null;
  restore: InboxPrediction | null;
  text: string;
}

interface FeedContext {
  usage: TaskUsage;
  tree: ChatTree;
  memberItems: ReadonlyMap<string, Item>;
  expanded: ReadonlySet<string>;
  toggleSubchats: (id: string) => void;
  now: number;
  touch: boolean;
  cursorKey: string | null;
  activeThreadId: string | null;
  pending: ReadonlySet<string>;
  changes: ReadonlyMap<string, number>;
  overlay: Overlay | null;
  threads: readonly PluginSidebarThread[];
  byId: ReadonlyMap<string, PluginSidebarThread>;
  projectNames: ReadonlyMap<string, string>;
  tags: readonly Tag[];
  tagOf: (threadId: string) => Tag | null;
  pickTag: (threadId: string, tagId: string | null) => void;
  open: (item: Item, split: boolean) => void;
  primary: (item: Item, focused: boolean) => void;
  command: (name: InboxCommand, item: Item, focused: boolean) => void;
  pick: (choice: ChoiceItem, item: Item) => void;
  pickWait: (item: Item, card: InboxCard, choice: WaitChoice) => void;
  submitDate: (item: Item, card: InboxCard, value: string) => void;
  submitEvent: (item: Item, card: InboxCard, value: string) => void;
  stop: (item: Item) => void;
  member: (item: Item, run: InboxRun) => void;
  openThread: (threadId: string, split?: boolean) => void;
  shelfDrag: ShelfDrag;
  shelfRoots: ReadonlySet<string>;
}

function keyOf(section: Section, threadId: string): string {
  return `${section}:${threadId}`;
}

function itemThreadId(item: Item): string {
  return item.family?.thread.id ?? item.entry.threadId;
}

function itemGroup(item: Item): InboxSectionKey | "on-you" {
  if (item.section === "shelf") return "shelf";

  if (item.section === "waiting" && item.entry.waiting?.group === "on-you") return "on-you";

  return inboxSection(item.entry);
}

function plural(count: number, word: string): string {
  return `${count} ${word}${count === 1 ? "" : "s"}`;
}

export function openFromClick(event: MouseEvent<Element>, open: (split: boolean) => void) {
  if (event.button !== 0 || event.shiftKey || (event.altKey && !event.metaKey && !event.ctrlKey))
    return;
  event.preventDefault();
  open(event.metaKey || event.ctrlKey);
}

const ROW_CLICK_EXCLUDED =
  "a, button, input, textarea, select, [role], [contenteditable], .ctf-card-body";

function openRowFromClick(event: MouseEvent<HTMLDivElement>, open: (split: boolean) => void) {
  const target = event.target;

  if (!(target instanceof Element) || !event.currentTarget.contains(target)) return;

  const excluded = target.closest(ROW_CLICK_EXCLUDED);

  if (excluded !== null && event.currentTarget.contains(excluded)) return;

  if (!(window.getSelection()?.isCollapsed ?? true)) return;
  openFromClick(event, open);
}

export function ShelfMore({ pages, className }: { pages: ShelfPages; className: string }) {
  return (
    <button
      type="button"
      className={className}
      disabled={pages.isFetchingNextPage}
      onClick={() => void pages.fetchNextPage()}
    >
      {pages.isFetchingNextPage
        ? "Loading…"
        : pages.isFetchNextPageError
          ? "Retry loading"
          : "Show more"}
    </button>
  );
}

function FocusComposer({ threadId, onDone }: { threadId: string; onDone: () => void }) {
  const composer = useComposer();
  const ready = composer.scope.kind === "thread" && composer.scope.threadId === threadId;

  useEffect(() => {
    if (!ready) return;

    const frame = requestAnimationFrame(() => {
      composer.focus();
      onDone();
    });

    return () => cancelAnimationFrame(frame);
  }, [ready, composer, onDone]);

  useEffect(() => {
    const timer = setTimeout(onDone, COMPOSER_WAIT_MS);

    return () => clearTimeout(timer);
  }, [onDone]);

  return null;
}

function RowMarkGlyph({ mark }: { mark: RowMark }) {
  switch (mark) {
    case "run":
      return (
        <svg className="ctf-row-mark-spin" viewBox="0 0 10 10" aria-hidden>
          <path d="M5 1.2A3.8 3.8 0 1 1 1.2 5" />
        </svg>
      );
    case "done":
      return (
        <svg className="ctf-row-mark-check" viewBox="0 0 10 10" aria-hidden>
          <path d="M1.6 5.4 4 7.7l4.4-5" />
        </svg>
      );
    case "ready":
      return (
        <svg className="ctf-row-mark-solid" viewBox="0 0 10 10" aria-hidden>
          <path
            fillRule="evenodd"
            d="M5 0a5 5 0 1 0 0 10A5 5 0 0 0 5 0ZM2.4 5.5l.9-.9 1.3 1.3 2.3-2.6.9.8-3.2 3.6Z"
          />
        </svg>
      );
    default:
      return null;
  }
}

function RowProject({ projectId, mark }: { projectId: string; mark: RowMark | null }) {
  return (
    <span className="ctf-row-project" data-mark={mark ?? undefined} aria-hidden>
      <ProjectIcon projectId={projectId} className="ctf-row-project-icon" />
      {mark === null ? null : (
        <span className="ctf-row-mark" data-dot={mark}>
          <RowMarkGlyph mark={mark} />
        </span>
      )}
    </span>
  );
}

interface ThreadMenuProps {
  thread: PluginSidebarThread | undefined;
  tag: Tag | null;
  context: FeedContext;
  onOpenChange: (open: boolean) => void;
  onRename?: () => void;
  extra?: readonly PluginThreadActionsInlineItem[];
  children: ReactNode;
}

function ThreadMenu({
  thread,
  tag,
  context,
  onOpenChange,
  onRename,
  extra = [],
  children,
}: ThreadMenuProps) {
  if (thread === undefined) return children;
  const pickTag = (tagId: string | null) => context.pickTag(thread.id, tagId);

  return (
    <ChatRowMenu
      thread={thread}
      inline={[...extra, ...tagMenuItems(context.tags, tag, pickTag)]}
      onOpenChange={onOpenChange}
      onRename={onRename}
    >
      {children}
    </ChatRowMenu>
  );
}

function RowMenu({
  thread,
  tag,
  context,
  onOpenChange,
  onRename,
  extra = [],
  meta = null,
}: Omit<ThreadMenuProps, "children"> & {
  meta?: ReactNode;
}) {
  if (thread === undefined) return null;
  const node = context.tree.nodes.get(thread.id);

  const tagItems = [
    ...extra,
    ...tagMenuItems(context.tags, tag, (tagId) => context.pickTag(thread.id, tagId)),
  ];

  return (
    <RowRail
      meta={meta}
      kids={
        node === undefined || node.children.length === 0 ? null : (
          <SubChatToggle
            count={node.children.length}
            fresh={node.newChildren}
            expanded={context.expanded.has(thread.id)}
            title={thread.displayTitle}
            onToggle={() => context.toggleSubchats(thread.id)}
          />
        )
      }
      menu={
        <ChatActionsMenu
          thread={thread}
          inline={tagItems}
          onOpenChange={onOpenChange}
          onRename={onRename}
        />
      }
    />
  );
}

function SubChats({ threadId, context }: { threadId: string; context: FeedContext }) {
  const node = context.tree.nodes.get(threadId);

  if (node === undefined || node.children.length === 0 || !context.expanded.has(threadId))
    return null;

  return (
    <div className="ctf-kids-list">
      {node.children.map((child) => {
        const thread = context.byId.get(child.thread.id);
        const item = context.memberItems.get(child.thread.id);

        return item !== undefined ? (
          <FeedMember key={child.thread.id} item={item} context={context} />
        ) : thread === undefined ? null : (
          <KidRow key={thread.id} node={child} thread={thread} context={context} />
        );
      })}
    </div>
  );
}

interface KidRowProps {
  node: ChatNode;
  thread: PluginSidebarThread;
  context: FeedContext;
}

function KidRow({ node, thread, context }: KidRowProps) {
  const [menuOpen, setMenuOpen] = useState(false);
  const active = context.activeThreadId === thread.id;
  const selected = useChatSelected(thread.id);
  const dot = nodeDot(node);
  const line = rowLine(node);
  const why = line.reason === null ? line.verb : `${line.verb}: ${line.reason}`;
  const tag = context.tagOf(thread.id);
  const tagItems = tagMenuItems(context.tags, tag, (tagId) => context.pickTag(thread.id, tagId));
  const titleEdit = useInlineTitleEdit(thread);
  const rename = context.touch ? undefined : titleEdit.start;

  return (
    <>
      <ChatRowMenu thread={thread} inline={tagItems} onOpenChange={setMenuOpen} onRename={rename}>
        <div
          className="ctf-kid-row"
          data-state={node.state}
          data-active={active}
          data-menu-open={menuOpen}
        >
          <a
            href={thread.href}
            className="ctf-kid"
            data-feed-item=""
            data-sidebar-thread-id={thread.id}
            data-chat-selection-id={titleEdit.isEditing ? undefined : thread.id}
            data-chat-selected={selected || undefined}
            aria-label={selected ? `${thread.displayTitle}, selected` : undefined}
            data-active={active}
            aria-current={active ? "page" : undefined}
            onClick={(event) =>
              openFromClick(event, (split) => context.openThread(thread.id, split))
            }
          >
            <StateDot kind={dot} label={why} agents={familyChildCount(node)} />
            {node.state !== "run" && hasFamilyActivity(node) ? (
              <StateDot kind="run" label="Working" agents={familyChildCount(node)} />
            ) : null}
            <span className="ctf-kid-text">
              {titleEdit.editor ?? <span className="ctf-kid-title">{thread.displayTitle}</span>}
              <ThreadUsage usage={context.usage} threadId={thread.id} status={thread.status} />
            </span>
            <RenameAlert edit={titleEdit} />
            {titleEdit.isEditing ? null : (
              <RowAgeSlot
                at={Math.max(thread.createdAt, thread.lastMessageAt ?? 0)}
                verb="Last message"
              />
            )}
            <ContinuationMark node={node} />
          </a>
          <RowRail
            kids={
              node.children.length === 0 ? null : (
                <SubChatToggle
                  count={node.children.length}
                  fresh={node.newChildren}
                  expanded={context.expanded.has(thread.id)}
                  title={thread.displayTitle}
                  onToggle={() => context.toggleSubchats(thread.id)}
                />
              )
            }
            menu={
              <ChatActionsMenu
                thread={thread}
                inline={tagItems}
                onOpenChange={setMenuOpen}
                onRename={rename}
              />
            }
          />
        </div>
      </ChatRowMenu>
      <SubChats threadId={thread.id} context={context} />
    </>
  );
}

interface ItemLinkProps extends Omit<ComponentPropsWithRef<"a">, "children" | "title"> {
  item: Item;
  label: string;
  summary: string | null;
  editing: boolean;
  context: FeedContext;
  children: ReactNode;
}

function ItemLink({ item, label, summary, editing, context, children, ...trigger }: ItemLinkProps) {
  const threadId = itemThreadId(item);
  const shortcut = useSidebarThreadShortcut(threadId);
  const { splitProps } = experimental_useSidebarThreadSplit(threadId);
  const active = context.activeThreadId === threadId;
  const selected = useChatSelected(threadId);

  return (
    <a
      {...trigger}
      onPointerDown={(event) => {
        trigger.onPointerDown?.(event);
        splitProps.onPointerDown?.(event);
      }}
      href={
        context.byId.get(item.family === null ? openTarget(item.entry, context.threads) : threadId)
          ?.href
      }
      tabIndex={0}
      className="ctf-row-link"
      data-feed-item=""
      data-inbox-item={item.key}
      data-sidebar-thread-id={threadId}
      data-chat-selection-id={editing ? undefined : threadId}
      data-chat-selected={selected || undefined}
      data-sidebar-thread-shortcut-target=""
      aria-current={active ? "page" : undefined}
      aria-label={selected ? `${label}, selected` : label}
      aria-description={summary ?? undefined}
      title={summary ?? undefined}
      aria-keyshortcuts={shortcut?.ariaKeyshortcuts}
      onClick={(event) => openFromClick(event, (split) => context.open(item, split))}
    >
      {children}
    </a>
  );
}

function CardChoices({
  label,
  choices,
  onPick,
}: {
  label: string;
  choices: readonly { digit: number; label: string }[];
  onPick: (digit: number) => void;
}) {
  return (
    <div className="ctf-choices" role="group" aria-label={label}>
      {choices.map((choice) => (
        <button
          key={choice.digit}
          type="button"
          className="ctf-choice"
          aria-keyshortcuts={String(choice.digit)}
          onClick={() => onPick(choice.digit)}
        >
          <kbd>{choice.digit}</kbd>
          {choice.label}
        </button>
      ))}
    </div>
  );
}

interface WaitMenuProps {
  step: "menu" | "date" | "event";
  item: Item;
  card: InboxCard;
  context: FeedContext;
}

function WaitMenu({ step, item, card, context }: WaitMenuProps) {
  const [date, setDate] = useState("");
  const [event, setEvent] = useState("");

  if (step === "menu") {
    const choices = waitChoices(card, context.now);

    return (
      <CardChoices
        label="Wait"
        choices={choices}
        onPick={(digit) => {
          const choice = choices.find((entry) => entry.digit === digit);

          if (choice !== undefined) context.pickWait(item, card, choice);
        }}
      />
    );
  }

  if (step === "date") {
    const until = pickedDate(date);
    const verb = card.primary.kind === "keep-waiting" ? "Keep waiting" : "Wait";

    return (
      <form
        className="ctf-choices"
        onSubmit={(submitted) => {
          submitted.preventDefault();
          context.submitDate(item, card, date);
        }}
      >
        <input
          type="date"
          className="ctf-input"
          aria-label="Date"
          value={date}
          min={dateInputValue(context.now)}
          autoFocus
          onChange={(changed) => setDate(changed.target.value)}
        />
        <button type="submit" className="ctf-button" disabled={until === null}>
          {until === null ? verb : `${verb} until ${upcomingLabel(context.now, until)}`}
        </button>
      </form>
    );
  }

  return (
    <form
      className="ctf-choices"
      onSubmit={(submitted) => {
        submitted.preventDefault();
        context.submitEvent(item, card, event);
      }}
    >
      <input
        type="text"
        className="ctf-input"
        aria-label="What will you report?"
        placeholder="What will happen?"
        value={event}
        maxLength={EVENT_MAX}
        autoFocus
        onChange={(changed) => setEvent(changed.target.value)}
      />
      <button type="submit" className="ctf-button" disabled={event.trim() === ""}>
        Wait
      </button>
    </form>
  );
}

function CardOverlay({
  overlay,
  item,
  card,
  context,
}: {
  overlay: Exclude<Overlay, { kind: "bulk" }>;
  item: Item;
  card: InboxCard;
  context: FeedContext;
}) {
  if (overlay.kind === "choose")
    return (
      <CardChoices
        label="Your call"
        choices={overlay.items}
        onPick={(digit) => {
          const choice = overlay.items.find((entry) => entry.digit === digit);

          if (choice !== undefined) context.pick(choice, item);
        }}
      />
    );

  if (overlay.kind === "stop")
    return (
      <div className="ctf-choices">
        <p className="ctf-line">
          {card.questionMode === "required"
            ? "A question is still open."
            : "Work is still running."}
        </p>
        <CardChoices
          label="Stop and archive"
          choices={[{ digit: 1, label: "Stop and archive" }]}
          onPick={() => context.stop(item)}
        />
      </div>
    );

  return <WaitMenu step={overlay.step} item={item} card={card} context={context} />;
}

function InboxReason({ entry, context }: { entry: InboxEntry; context: FeedContext }) {
  const showReason =
    entry.state === "needs-you" || entry.state === "failed" || entry.state === "finished";

  if (!showReason) return null;

  return (
    <p className="ctf-row-detail" data-inbox-reason={entry.state}>
      {entry.reason.kind === "recap" && entry.reason.threadId !== entry.threadId ? (
        <a
          className="ctf-row-detail-text underline decoration-dotted"
          href={context.byId.get(entry.reason.threadId)?.href}
          onClick={(event) => {
            event.preventDefault();
            event.stopPropagation();
            context.openThread(entry.reason.threadId, event.metaKey || event.ctrlKey);
          }}
        >
          {entry.reason.text}
        </a>
      ) : (
        <span className="ctf-row-detail-text">{entry.reason.text}</span>
      )}
    </p>
  );
}

export function newRepliesHint(count: number): string {
  return `${count} new ${count === 1 ? "reply" : "replies"} since you last wrote or acted on this chat`;
}

function newReplies(entry: InboxEntry): ReactNode {
  if (entry.state !== "waiting" || entry.pendingResults === 0) return null;

  return (
    <RowChip
      icon="MessageSquare"
      label={String(entry.pendingResults)}
      description={newRepliesHint(entry.pendingResults)}
    />
  );
}

function FeedCard({ item, context }: { item: Item; context: FeedContext }) {
  const [menuOpen, setMenuOpen] = useState(false);
  const { entry, shown } = item;
  const card = entry.card;
  const threadId = itemThreadId(item);
  const thread = context.byId.get(threadId);
  const node = context.tree.nodes.get(threadId);
  const tag = context.tagOf(threadId);
  const titleEdit = useInlineTitleEdit(thread);

  if (card === null || shown === null) return null;
  const rename = context.touch ? undefined : titleEdit.start;
  const focused = context.cursorKey === item.key;
  const overlay = context.overlay;
  const mine = overlay !== null && overlay.kind !== "bulk" && overlay.key === item.key;
  const changedAt = context.changes.get(threadId);
  const project = context.projectNames.get(entry.projectId);
  const kind = cardKind(card);
  const menuItems = inboxMenuItems(item, card, context);
  const wait = item.section === "waiting" ? waitingLook(entry, context.now) : null;

  return (
    <ThreadMenu
      thread={thread}
      tag={tag}
      context={context}
      onOpenChange={setMenuOpen}
      onRename={rename}
      extra={menuItems}
    >
      <div
        className="ctf-row ctf-card"
        data-feed-row={threadId}
        data-inbox-card={threadId}
        data-chat-motion-key={item.key}
        data-kind={card.kind}
        data-state={STATE_DOT[entry.state]}
        data-cursor={focused}
        data-active={context.activeThreadId === threadId}
        data-menu-open={menuOpen}
        data-tag={tag?.id}
        data-wait-lane={wait?.lane}
        data-wait-in={wait === null ? undefined : (wait.in ?? "")}
      >
        <div
          className="ctf-row-surface"
          onClick={(event) => openRowFromClick(event, (split) => context.open(item, split))}
        >
          {changedAt === undefined ? null : (
            <span key={changedAt} aria-hidden="true" className="ctf-changed-flash" />
          )}
          <div className="ctf-row-main">
            <ItemLink
              item={item}
              editing={titleEdit.isEditing}
              label={`${entry.title}. ${kind}${project === undefined ? "" : `. ${project}`}`}
              summary={cardSummary(card, context.now)}
              context={context}
            >
              <RowProject
                projectId={entry.projectId}
                mark={rowMark(STATE_DOT[entry.state], entry)}
              />
              {titleEdit.editor ?? <span className="ctf-title">{entry.title}</span>}
              <RenameAlert edit={titleEdit} />
              {thread === undefined || titleEdit.isEditing ? null : (
                <RowAgeSlot
                  at={card.since ?? thread.createdAt}
                  verb={card.since === undefined ? "Started" : "Since"}
                />
              )}
              {node === undefined ? null : <ContinuationMark node={node} />}
            </ItemLink>
            <RowMenu
              thread={thread}
              tag={tag}
              context={context}
              onOpenChange={setMenuOpen}
              onRename={rename}
              extra={menuItems}
            />
          </div>
          <InboxReason entry={entry} context={context} />
          <ThreadUsage usage={context.usage} threadId={threadId} status={thread?.status} />
          {mine ? (
            <div className="ctf-card-body">
              <CardOverlay overlay={overlay} item={item} card={card} context={context} />
            </div>
          ) : null}
        </div>
        <SubChats threadId={threadId} context={context} />
      </div>
    </ThreadMenu>
  );
}

function reportEventMenuItems(item: Item, context: FeedContext): PluginThreadActionsInlineItem[] {
  const { entry } = item;

  if (itemThreadId(item) !== entry.threadId || happenedWaitId(entry) === null) return [];

  return [
    {
      key: "chat-topics/inbox-happened",
      group: INBOX_MENU_GROUP,
      action: {
        label: "Report event and resume",
        icon: "Check",
        disabled: context.pending.has(entry.threadId),
        run: () => context.command("happened", item, true),
      },
    },
  ];
}

function inboxMenuItems(
  item: Item,
  card: InboxCard,
  context: FeedContext,
): PluginThreadActionsInlineItem[] {
  const shown = item.shown;

  if (card.kind === "question" || shown === null) return [];
  const entry = item.entry;
  const busy = context.pending.has(entry.threadId);
  const line = cardActionLine(card);
  const members = card.kind === "runs" ? entry.runs : (entry.incident?.members ?? null);
  const items = reportEventMenuItems(item, context);

  if (line.primary && card.primary.kind !== "archive")
    items.push({
      key: "chat-topics/inbox-primary",
      group: INBOX_MENU_GROUP,
      action: {
        label: primaryLabel(card.primary, context.now, context.touch),
        icon: PRIMARY_ICON[card.primary.kind],
        disabled: busy,
        run: () => context.primary(item, true),
      },
    });

  for (const action of line.actions) {
    if (action !== "wait" && action !== "reply") continue;
    const menu = MENU_ACTIONS[action];

    items.push({
      key: `chat-topics/inbox-${action}`,
      group: INBOX_MENU_GROUP,
      action: {
        label: menu.label,
        icon: menu.icon,
        disabled: busy && action !== "reply",
        run: () => context.command(menu.command, item, true),
      },
    });
  }

  if (members !== null && members.length > 0)
    items.push({
      key: "chat-topics/inbox-runs",
      group: INBOX_MENU_GROUP,
      action: {
        label: "Runs",
        icon: "Play",
        choices: {
          heading: "Runs",
          items: members.map((run) => ({
            id: run.threadId,
            label: `${primaryLabel(run.primary, context.now, true)} · ${run.title}`,
            disabled: context.pending.has(run.threadId),
          })),
        },
        run: ({ value }) => {
          const run = members.find((member) => member.threadId === value);

          if (run !== undefined) context.member(item, run);
        },
      },
    });

  return items;
}

interface FeedRowProps {
  item: Item;
  dot: DotKind;
  dotLabel: string;
  detail: string | null;
  action: ReactNode;
  progress: RunningProgress | null;
  wait?: WaitingLook | null;
  context: FeedContext;
}

/** How a Waiting row draws its timeline gutter, chip and condition icon. */
interface WaitingLook {
  lane: WaitingLane;
  label: string | null;
  in: string | null;
  chip: WaitingChip | null;
  icon: string | null;
}

const CONDITION_ICON: Partial<Record<WaitingLane, string>> = {
  chat: "CornerDownRight",
  event: "Zap",
};

function FeedRow({
  item,
  dot,
  dotLabel,
  detail,
  action,
  progress,
  wait = null,
  context,
}: FeedRowProps) {
  const [menuOpen, setMenuOpen] = useState(false);
  const { entry } = item;
  const threadId = itemThreadId(item);
  const thread = context.byId.get(threadId);
  const node = context.tree.nodes.get(threadId);
  const tag = context.tagOf(threadId);
  const title = item.family?.thread.displayTitle ?? entry.title;
  const titleEdit = useInlineTitleEdit(thread);
  const rename = context.touch ? undefined : titleEdit.start;
  const shelfRoot = !item.nested && item.section === "shelf" && context.shelfRoots.has(threadId);
  const menuItems = reportEventMenuItems(item, context);

  return (
    <ThreadMenu
      thread={thread}
      tag={tag}
      context={context}
      onOpenChange={setMenuOpen}
      onRename={rename}
      extra={menuItems}
    >
      <div
        className="ctf-row"
        data-feed-row={threadId}
        data-inbox-row={item.section}
        data-state={dot}
        data-chat-motion-key={item.key}
        data-cursor={context.cursorKey === item.key}
        data-active={context.activeThreadId === threadId}
        data-menu-open={menuOpen}
        data-tag={tag?.id}
        data-shelf-list={shelfRoot ? SHELF_SECTION.key : undefined}
        data-shelf-row={shelfRoot ? threadId : undefined}
        data-shelf-drag={shelfRoot ? (context.shelfDrag.stateOf(threadId) ?? undefined) : undefined}
        data-wait-lane={wait?.lane}
        data-wait-in={wait === null ? undefined : (wait.in ?? "")}
        onPointerDown={shelfRoot ? context.shelfDrag.begin : undefined}
      >
        <div
          className="ctf-row-surface"
          onClick={(event) => openRowFromClick(event, (split) => context.open(item, split))}
        >
          <div className="ctf-row-main">
            <ItemLink
              item={item}
              editing={titleEdit.isEditing}
              label={`${title}. ${dotLabel}${
                (wait?.label ?? detail) === null ? "" : `. ${wait?.label ?? detail}`
              }`}
              summary={null}
              context={context}
            >
              <RowProject projectId={entry.projectId} mark={rowMark(dot, entry)} />
              {titleEdit.editor ?? <span className="ctf-title">{title}</span>}
              <RenameAlert edit={titleEdit} />
              {thread === undefined || titleEdit.isEditing ? null : (
                <RowAgeSlot
                  at={Math.max(thread.createdAt, thread.lastMessageAt ?? 0)}
                  verb="Last message"
                />
              )}
              {wait?.chip == null ? null : <WaitChip chip={wait.chip} title={wait.label} />}
              {node === undefined ? null : <ContinuationMark node={node} />}
              {progress === null ? null : <RunProgress progress={progress} />}
            </ItemLink>
            <RowMenu
              thread={thread}
              tag={tag}
              context={context}
              onOpenChange={setMenuOpen}
              onRename={rename}
              extra={menuItems}
              meta={item.family === null ? newReplies(entry) : null}
            />
          </div>
          {detail === null && action === null ? null : (
            <p className="ctf-row-detail" data-wait-condition={wait === null ? undefined : ""}>
              {wait?.icon == null || detail === null ? null : (
                <Icon name={wait.icon} aria-hidden className="ctf-wait-icon" />
              )}
              {detail === null ? null : <span className="ctf-row-detail-text">{detail}</span>}
              {action}
            </p>
          )}
          {item.family === null && item.section !== "shelf" ? (
            <InboxReason entry={entry} context={context} />
          ) : null}
          <ThreadUsage usage={context.usage} threadId={threadId} status={thread?.status} />
        </div>
        <SubChats threadId={threadId} context={context} />
      </div>
    </ThreadMenu>
  );
}

function FeedMember({ item, context }: { item: Item; context: FeedContext }) {
  if (item.shown !== null) return <FeedCard item={item} context={context} />;
  const presented = itemThreadId(item) !== item.entry.threadId;

  const historyOnly =
    presented && !item.family?.family.some((thread) => thread.id === item.entry.threadId);

  const waitId = presented ? null : happenedWaitId(item.entry);
  const node = context.tree.nodes.get(itemThreadId(item));
  const stopping = item.entry.state === "working" && node !== undefined && familyStopping(node);
  const wait = item.section === "waiting" ? waitingLook(item.entry, context.now) : null;

  return (
    <FeedRow
      wait={wait}
      item={item}
      dot={
        historyOnly && node !== undefined
          ? nodeDot(node)
          : stopping
            ? "stop"
            : STATE_DOT[item.entry.state]
      }
      dotLabel={
        historyOnly && node !== undefined
          ? rowLine(node).verb
          : stopping
            ? DOT_LABEL.stop
            : item.entry.state === "failed"
              ? DOT_LABEL.failed
              : VIEW_LABEL[item.section === "shelf" ? "resting" : item.section]
      }
      detail={
        presented || item.section === "running" || item.section === "shelf"
          ? null
          : item.section === "waiting"
            ? item.entry.waiting === null
              ? null
              : waitingCondition(item.entry.waiting)
            : (item.entry.running?.label ?? null)
      }
      action={
        waitId === null ? null : (
          <button
            type="button"
            className="ctf-row-act"
            aria-keyshortcuts="H"
            title="Tell the chat that what it’s waiting for has happened (H)"
            disabled={context.pending.has(item.entry.threadId)}
            onClick={() => context.command("happened", item, context.cursorKey === item.key)}
          >
            It happened
          </button>
        )
      }
      progress={presented ? null : runningProgress(item.entry)}
      context={context}
    />
  );
}

function RunProgress({ progress }: { progress: RunningProgress }) {
  return (
    <span
      className="ctf-progress"
      data-ct-trailing=""
      role="progressbar"
      aria-label={`${progress.done} of ${progress.total} steps done`}
      aria-valuemin={0}
      aria-valuemax={progress.total}
      aria-valuenow={progress.done}
    >
      <span className="ctf-progress-track" aria-hidden>
        <span
          className="ctf-progress-fill"
          style={{ transform: `scaleX(${progress.done / progress.total})` }}
        />
      </span>
      <span className="ctf-progress-count" aria-hidden>
        {progress.done}/{progress.total}
      </span>
    </span>
  );
}

function WaitChip({ chip, title }: { chip: WaitingChip; title: string | null }) {
  return (
    <span
      className="ctf-wait-chip"
      data-ct-trailing=""
      data-warning={chip.warning ? "" : undefined}
      title={title ?? undefined}
    >
      <Icon name={chip.icon} aria-hidden className="ctf-wait-chip-icon" />
      {chip.text}
    </span>
  );
}

function waitingLook(entry: InboxEntry, now: number): WaitingLook {
  const row = entry.waiting;

  if (row === null) return { lane: "event", label: null, in: null, chip: null, icon: null };
  const lane = waitingLane(row);
  const at = waitingNextAt(row, now);

  const label = [
    row.reason,
    row.behind === null ? null : `Behind ${row.behind}`,
    waitingDetail(row, now),
  ]
    .filter((part) => part !== null)
    .join(" · ");

  return {
    lane,
    label,
    in: at === null ? null : waitingIn(now, at),
    chip: waitingChip(row),
    icon: CONDITION_ICON[lane] ?? null,
  };
}

/** Waiting rows in their titled lanes, soonest first within each lane. */
function waitingOrder(rows: readonly Item[], now: number): Item[] {
  const rank = (item: Item) => WAITING_LANES.indexOf(waitingLane(item.entry.waiting));

  const at = (item: Item) =>
    item.entry.waiting === null
      ? Number.MAX_SAFE_INTEGER
      : (waitingNextAt(item.entry.waiting, now) ?? Number.MAX_SAFE_INTEGER);

  return [...rows].sort((a, b) => rank(a) - rank(b) || at(a) - at(b));
}

interface SectionHeadingProps {
  sectionKey: InboxSectionKey;
  motionKey: string;
  label: string;
  count: number;
  noun: string;
  note: string | null;
  open: boolean;
  drag: ReturnType<ReturnType<typeof useSectionDrag>["heading"]>;
  running?: boolean;
  actions?: ReactNode;
  onToggle: (key: InboxSectionKey) => void;
}

function SectionHeading({
  sectionKey,
  motionKey,
  label,
  count,
  noun,
  note,
  open,
  drag,
  running = false,
  actions = null,
  onToggle,
}: SectionHeadingProps) {
  return (
    <h3 className="ctf-heading" data-chat-motion-key={motionKey} {...drag}>
      <button
        type="button"
        className="ctf-shelf-toggle"
        data-feed-running={running ? "" : undefined}
        aria-expanded={open}
        aria-label={`${label}, ${plural(count, noun)}${note === null ? "" : `, ${note}`}`}
        onClick={() => onToggle(sectionKey)}
      >
        <Icon name="ChevronRight" aria-hidden className="ctf-shelf-chevron" />
        <span className="ctf-heading-label">{label}</span>
        <span className="ctf-heading-count" data-running={running && count > 0 ? "" : undefined}>
          {running && count > 0 ? <StateDot kind="run" label={null} /> : null}
          {count}
        </span>
        {note === null ? null : <span className="ctf-heading-note">{note}</span>}
      </button>
      {actions}
    </h3>
  );
}

function SubGroup({ label, motionKey }: { label: string; motionKey: string }) {
  return (
    <p className="ctf-group" data-chat-motion-key={motionKey}>
      <span className="ctf-group-label">{label}</span>
    </p>
  );
}

export interface InboxFeedProps {
  list: RefObject<HTMLElement | null>;
  threads: readonly PluginSidebarThread[];
  byId: ReadonlyMap<string, PluginSidebarThread>;
  projectNames: ReadonlyMap<string, string>;
  activeThreadId: string | null;
  touch: boolean;
  usage: TaskUsage;
  isSectionFolded: (key: InboxSectionKey) => boolean;
  shelfReorder: ShelfReorder;
  tags: readonly Tag[];
  tagOf: (threadId: string) => Tag | null;
  onTag: (threadId: string, tagId: string | null) => Promise<void>;
  onToggleSection: (key: InboxSectionKey) => void;
  onNavigate: () => void;
}

export function InboxFeed({
  list,
  threads,
  byId,
  projectNames,
  activeThreadId,
  touch,
  usage,
  isSectionFolded,
  shelfReorder,
  tags,
  tagOf,
  onTag,
  onToggleSection,
  onNavigate,
}: InboxFeedProps) {
  const inbox = useInbox();
  const runningExpanded = useRunningExpanded();
  const sections = useInboxSections();
  const sectionOrder = useMemo(() => shownSections(sections), [sections]);
  const showEmpty = sections.showEmpty;
  const sectionDrag = useSectionDrag(!touch, moveInboxSection);
  const runningReveal = useRunningReveal();
  const runningSection = useRef<HTMLElement>(null);
  const [arriving, setArriving] = useState<InboxSectionKey | null>(null);

  const sectionOpen = (key: InboxSectionKey): boolean =>
    key === "run" ? runningExpanded : !isSectionFolded(key);

  useEffect(() => {
    if (arriving === null) return;
    const timer = setTimeout(() => setArriving(null), ARRIVE_MS);

    return () => clearTimeout(timer);
  }, [arriving]);

  const toggleSection = (key: InboxSectionKey) => {
    const opening = !sectionOpen(key);

    setArriving(opening ? key : null);

    if (key !== "run") onToggleSection(key);
    else setRunningExpanded(!runningExpanded);
  };

  const liveTree = useMemo(
    () =>
      buildTree(
        threads.filter((thread) => !thread.isHidden && !thread.isArchived).map(groupThreadOf),
      ),
    [threads],
  );

  const tree = useMemo(
    () => withHeldShelf(liveTree, shelfReorder.order),
    [liveTree, shelfReorder.order],
  );

  const { expanded, toggle: toggleSubchats } = useSubchatExpansion(tree, activeThreadId);

  const navigate = experimental_useAppNavigate();
  const rootRef = useRef<HTMLDivElement>(null);

  const questionSlotTop = useCallback(() => {
    const root = rootRef.current;

    if (root === null) return null;
    const need = root.querySelector(`[data-feed-section="${FEED_SECTION.need}"]`);

    if (need !== null) {
      const questions = need.querySelectorAll('[data-inbox-card][data-kind="question"]');
      const last = questions[questions.length - 1] ?? need.querySelector(".ctf-heading");

      return last === null ? null : last.getBoundingClientRect().bottom;
    }

    for (const key of sectionOrder.slice(sectionOrder.indexOf("need") + 1)) {
      const next = root.querySelector(`[data-feed-section="${FEED_SECTION[key]}"]`);

      if (next !== null) return next.getBoundingClientRect().top;
    }

    return null;
  }, [sectionOrder]);

  const scrolledPast = useScrolledPast(list, questionSlotTop);
  const focusFrame = useRef(0);
  const [now, setNow] = useState(() => Date.now());
  const [cursor, setCursor] = useState<Cursor | null>(null);
  const [memory, setMemory] = useState<InboxLayout | null>(null);
  const [statusOrder, setStatusOrder] = useState(readInboxStatusOrder);
  const [overlay, setOverlay] = useState<Overlay | null>(null);
  const [toast, setToast] = useState<Toast | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [pending, setPending] = useState<ReadonlySet<string>>(new Set());
  const [composerFor, setComposerFor] = useState<string | null>(null);
  const [changes, setChanges] = useState<ReadonlyMap<string, number>>(NO_CHANGES);
  const latches = useRef<ReadonlyMap<string, string> | null>(null);
  const cursorIndex = useRef(-1);

  const [flights] = useState(() =>
    createInboxFlights((threadId) =>
      setPending((previous) => {
        const next = new Set(previous);
        next.delete(threadId);

        return next;
      }),
    ),
  );

  useEffect(() => markInboxMounted(), []);

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 60_000);

    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    if (toast === null) return;
    const timer = setTimeout(() => setToast(null), UNDO_TOAST_MS);

    return () => clearTimeout(timer);
  }, [toast]);

  const load = inbox.load;

  const snapshot = load.status === "ready" ? load.snapshot : null;

  const snapshotReady = snapshot !== null;

  useEffect(() => {
    if (runningReveal > 0 && snapshotReady)
      runningSection.current?.scrollIntoView({ block: "start" });
  }, [runningReveal, snapshotReady]);

  const live = useMemo(
    () =>
      snapshot === null
        ? NO_ENTRIES
        : [...snapshot.inbox, ...snapshot.running, ...snapshot.waiting].filter(
            (entry) => !shelvedOnly(entry),
          ),
    [snapshot],
  );

  useEffect(() => {
    const changed = cardChanges(latches.current, live);

    latches.current = new Map(live.map((entry) => [entry.threadId, entry.latch]));

    if (changed.length === 0) return;
    const at = Date.now();

    setChanges((previous) => {
      const next = new Map(previous);

      for (const threadId of changed) next.set(threadId, at);

      return next;
    });
  }, [live]);

  const busyFamilies = useMemo(() => busyRoots(threads), [threads]);

  const focus: InboxFocus =
    cursor === null || cursor.section === "running"
      ? null
      : cursor.section === "inbox"
        ? { kind: "card", threadId: cursor.threadId }
        : { kind: "below" };

  const layout = snapshot === null ? null : arrangeInbox(memory, live, { focus, scrolledPast });

  if (layout !== null && layout !== memory) setMemory(layout);

  const cards = useMemo(() => (layout === null ? [] : shownCards(layout, live)), [layout, live]);

  const { roots: rootItems, members: memberItems } = useMemo(() => {
    const rowOf =
      (fallback: Section) =>
      (entry: InboxEntry): Item => {
        const section: Section =
          entry.state === "working" && !asksWhileWorking(entry)
            ? "running"
            : entry.state === "waiting"
              ? "waiting"
              : fallback;

        return {
          key: keyOf(section, entry.threadId),
          section,
          entry,
          shown: null,
          family: null,
          nested: false,
          ready: readyToArchive(entry),
        };
      };

    const cardItems = cards.map((shown): Item => ({
      ...rowOf("inbox")(shown.entry),
      shown: shown.entry.card === null ? null : shown,
    }));

    const all =
      snapshot === null
        ? []
        : [
            ...cardItems.filter((item) => !item.ready),
            ...snapshot.running.map(rowOf("running")),
            ...snapshot.waiting.map(rowOf("waiting")),
            ...cardItems.filter((item) => item.ready),
            ...shelfRows(snapshot).map(rowOf("shelf")),
          ];

    const byThread = new Map<string, Item>();

    for (const item of all)
      if (!byThread.has(item.entry.threadId)) byThread.set(item.entry.threadId, item);
    const families = new Map<string, ChatNode>();

    for (const root of [...tree.roots, ...tree.shelf]) {
      const pending = [root];

      while (pending.length > 0) {
        const member = pending.pop();

        if (member === undefined) continue;
        families.set(member.thread.id, root);
        pending.push(...member.children);
      }
    }

    const grouped = new Map<string, Item[]>();

    for (const item of byThread.values()) {
      const id = families.get(item.entry.threadId)?.thread.id ?? item.entry.threadId;
      const group = grouped.get(id);

      if (group === undefined) grouped.set(id, [item]);
      else group.push(item);
    }

    const roots: Item[] = [];

    for (const [id, group] of grouped) {
      const node = families.get(id);

      const own = group.filter(
        (item) =>
          node?.family.some((thread) => thread.id === item.entry.threadId) &&
          (item.entry.threadId === id || item.entry.state !== "failed"),
      );

      const first = (own.length > 0 ? own : group).reduce<Item | undefined>(
        (best, item) =>
          best === undefined || STATE_PRIORITY[item.entry.state] < STATE_PRIORITY[best.entry.state]
            ? item
            : best,
        undefined,
      );

      if (first === undefined) continue;

      if (node === undefined || (group.length === 1 && first.entry.threadId === id)) {
        roots.push(first);
        continue;
      }

      roots.push({
        ...first,
        key: keyOf(first.section, id),
        section: first.section,
        family: node,
        shown: own.length > 0 ? first.shown : null,
        ready: first.ready,
      });
    }

    return {
      roots,
      members: new Map([...byThread].map(([id, item]) => [id, { ...item, nested: true }])),
    };
  }, [snapshot, cards, tree]);

  const statusRows = useMemo(
    () =>
      rootItems.map((item) => ({
        id: item.key,
        group: itemGroup(item),
        at:
          (item.section === "shelf"
            ? byId.get(itemThreadId(item))?.experimental_shelvedAt
            : null) ?? item.entry.sortAt,
      })),
    [rootItems, byId],
  );

  const nextStatusOrder =
    snapshot === null ? statusOrder : orderInboxStatusRows(statusOrder, statusRows);

  if (nextStatusOrder !== statusOrder) setStatusOrder(nextStatusOrder);

  useEffect(() => {
    if (snapshotReady) writeInboxStatusOrder(nextStatusOrder);
  }, [snapshotReady, nextStatusOrder]);

  const items = useMemo(() => {
    const byKey = new Map(rootItems.map((item) => [item.key, item]));
    const visible: Item[] = [];

    const appendChildren = (node: ChatNode) => {
      if (!expanded.has(node.thread.id)) return;

      for (const child of node.children) {
        const item = memberItems.get(child.thread.id);

        if (item !== undefined) visible.push(item);
        appendChildren(child);
      }
    };

    for (const section of sectionOrder) {
      if (section === "run" ? !runningExpanded : isSectionFolded(section)) continue;

      const groups = section === "waiting" ? ["on-you", "waiting"] : [section];

      const rows = groups.flatMap((group) =>
        (nextStatusOrder?.get(group) ?? []).flatMap((key) => {
          const item = byKey.get(key);

          return item === undefined ? [] : [item];
        }),
      );

      for (const item of section === "shelf"
        ? inShelfOrder(rows, tree.shelf, itemThreadId)
        : section === "waiting"
          ? waitingOrder(rows, now)
          : rows) {
        visible.push(item);
        const node = tree.nodes.get(itemThreadId(item));

        if (node !== undefined) appendChildren(node);
      }
    }

    return visible;
  }, [
    rootItems,
    memberItems,
    nextStatusOrder,
    isSectionFolded,
    runningExpanded,
    sectionOrder,
    tree,
    expanded,
    now,
  ]);

  const shelfSlots = useMemo(() => {
    const shelved = new Set(tree.shelf);

    return items.flatMap((item): ShelfSlot[] => {
      if (item.nested || item.section !== "shelf") return [];
      const node = tree.nodes.get(itemThreadId(item));

      return node === undefined || node.thread.parentThreadId !== null || !shelved.has(node)
        ? []
        : [{ id: node.thread.id, keyed: node.thread.shelfSortKey !== null }];
    });
  }, [items, tree]);

  const shelfRoots = useMemo(() => new Set(shelfSlots.map((slot) => slot.id)), [shelfSlots]);

  const shelfDrag = useShelfDrag(
    !touch && !shelfReorder.busy,
    list,
    (_list, movedId, targetId, place) => shelfReorder.move(shelfSlots, movedId, targetId, place),
  );

  const cursorKey = cursor === null ? null : keyOf(cursor.section, cursor.threadId);
  const current = items.find((item) => item.key === cursorKey) ?? null;
  const itemsRef = useRef(items);
  const cursorRef = useRef(cursor);

  useLayoutEffect(() => {
    itemsRef.current = items;
    cursorRef.current = cursor;

    if (current !== null) cursorIndex.current = items.indexOf(current);
  });

  useEffect(() => {
    if (activeThreadId === null) return;

    const match = itemsRef.current.find(
      (item) => itemThreadId(item) === activeThreadId && item.section !== "shelf",
    );

    if (match === undefined || cursorRef.current?.threadId === activeThreadId) return;
    setCursor({ section: match.section, threadId: activeThreadId });
  }, [activeThreadId]);

  useEffect(() => {
    setOverlay((previous) =>
      previous === null || previous.kind === "bulk" || previous.key === cursorKey ? previous : null,
    );
  }, [cursorKey]);

  const elementOf = useCallback(
    (key: string) =>
      rootRef.current?.querySelector<HTMLElement>(`[data-inbox-item="${CSS.escape(key)}"]`) ?? null,
    [],
  );

  useEffect(() => {
    if (snapshot === null || cursor?.section !== "inbox" || current !== null) return;
    const next = items[Math.min(cursorIndex.current, items.length - 1)];

    if (next === undefined) {
      setCursor(null);

      return;
    }

    const key = next.key;
    const active = document.activeElement;
    const focused = active === document.body || rootRef.current?.contains(active) === true;

    setCursor({ section: next.section, threadId: itemThreadId(next) });

    if (focused) requestAnimationFrame(() => elementOf(key)?.focus());
  }, [snapshot, cursor, current, items, elementOf]);

  const select = useCallback(
    (item: Item, show: boolean, split: boolean, userInitiated = true) => {
      const threadId = itemThreadId(item);
      const section = item.section;
      const entry = item.entry;

      setCursor({ section, threadId });
      setOverlay(null);

      if (show) {
        navigate.toThread(
          item.family === null ? openTarget(entry, threads) : threadId,
          userInitiated ? chatTapOptions(split) : { split },
        );
        onNavigate();
      }

      cancelAnimationFrame(focusFrame.current);
      focusFrame.current = requestAnimationFrame(() => {
        if (document.activeElement?.closest("[data-sidebar-rename-editor]")) return;
        elementOf(keyOf(section, threadId))?.focus();
      });
    },
    [navigate, onNavigate, elementOf, threads],
  );

  const advance = (key: string) => {
    const list = itemsRef.current;
    const index = list.findIndex((item) => item.key === key);

    if (index < 0) return;
    const next = list[index + 1] ?? list[index - 1];

    if (next === undefined) setCursor(null);
    else select(next, !touch, false, false);
  };

  const fly = (threadId: string, run: () => Promise<InboxOutcome>, chained: boolean) => {
    setPending((previous) => (previous.has(threadId) ? previous : new Set(previous).add(threadId)));

    return flights.start(threadId, run, chained);
  };

  const settle = (
    item: Item,
    placed: Toast,
    outcome: InboxOutcome | null,
    advanceOnExit: boolean,
  ) => {
    const threadId = item.entry.threadId;

    if (outcome === null) {
      setToast((current) => (current === placed ? null : current));

      return;
    }

    if (outcome.kind !== "done") {
      setToast((current) => (current === placed ? null : current));

      if (outcome.kind === "updated") {
        setNotice(CHANGED_TEXT);
        setChanges((previous) => new Map(previous).set(threadId, Date.now()));
      } else setNotice(outcome.kind === "refused" ? outcome.message : FAILED_TEXT);

      return;
    }

    const entry = outcome.entry;
    const moveId = outcome.moveId;

    if (moveId === null && placed.move !== null)
      setToast((current) => (current === placed ? { ...placed, move: null } : current));

    if (entry !== null && latches.current !== null)
      latches.current = new Map(latches.current).set(threadId, entry.latch);

    if (!advanceOnExit || item.section !== "inbox" || item.shown === null) return;

    if (entry !== null && entry.view === "inbox") return;

    const at = cursorRef.current;

    if (at !== null && at.section === "inbox" && at.threadId === threadId) advance(item.key);
  };

  const advanceIfLeaving = (item: Item, predict: (snapshot: InboxSnapshot) => InboxSnapshot) => {
    const threadId = item.entry.threadId;
    const at = cursorRef.current;

    if (
      item.section === "inbox" &&
      item.shown !== null &&
      at !== null &&
      at.section === "inbox" &&
      at.threadId === threadId &&
      load.status === "ready" &&
      leavesInbox(load.snapshot, predict, threadId)
    )
      advance(item.key);
  };

  const advanceAfterMove = (item: Item, request: InboxActRequest): boolean => {
    if (request.action !== "archive" && (request.action !== "shelf" || !request.shelved))
      return false;

    const row = elementOf(item.key);

    const rows = Array.from(
      rootRef.current?.querySelectorAll<HTMLAnchorElement>(
        "a[data-feed-item][data-sidebar-thread-id]",
      ) ?? [],
    );

    const index = rows.findIndex((candidate) => candidate === row);
    const currentId = itemThreadId(item);
    const familyIds = new Set([currentId]);

    const addChildren = (node: ChatNode) => {
      for (const child of node.children) {
        familyIds.add(child.thread.id);
        addChildren(child);
      }
    };

    const node = tree.nodes.get(currentId);

    if (node !== undefined) addChildren(node);

    if (index < 0 || (activeThreadId !== null && !familyIds.has(activeThreadId))) return true;

    if (activeThreadId === null && cursorRef.current?.threadId !== currentId) return true;

    const next = rows.slice(index + 1).find((candidate) => {
      const id = candidate.dataset.sidebarThreadId;

      return (
        id !== undefined &&
        !familyIds.has(id) &&
        candidate.checkVisibility({ visibilityProperty: true })
      );
    });

    const nextId = next?.dataset.sidebarThreadId;

    const nextItem = itemsRef.current.find(
      (candidate) => candidate.key === next?.dataset.inboxItem,
    );

    if (nextItem !== undefined) select(nextItem, true, false, false);
    else if (nextId !== undefined) openThread(nextId, false, false);
    else {
      setCursor(null);
      navigate.toCompose({ projectId: item.entry.projectId });
      onNavigate();
    }

    return true;
  };

  const send = async (item: Item, request: InboxActRequest) => {
    setNotice(null);
    setOverlay(null);

    const before = inbox.load.status === "ready" ? inbox.load.snapshot : null;
    const waiting = flights.has(item.entry.threadId) && chainsBehindPending(request);
    const finish = waiting ? inbox.preview((snapshot) => predictAct(snapshot, request)) : null;

    const move = fly(
      item.entry.threadId,
      () => {
        finish?.();

        return inbox.act(request);
      },
      chainsBehindPending(request),
    );

    if (finish !== null) void move.then(() => finish());

    const threadIds = new Set(
      request.action === "archive-runs"
        ? [request.threadId, ...request.threadIds]
        : [request.threadId],
    );

    const placed: Toast = {
      move: offersUndo(request) ? move : null,
      restore:
        before === null ? null : (snapshot) => restoreThreadRows(snapshot, before, threadIds),
      text: moveLabel(request, Date.now()),
    };

    setToast(placed);
    const advancedMove = advanceAfterMove(item, request);

    if (!advancedMove) advanceIfLeaving(item, (snapshot) => predictAct(snapshot, request));
    settle(item, placed, await move, !advancedMove);
  };

  const retry = async (item: Item, targetThreadId: string) => {
    const threadId = item.entry.threadId;

    setNotice(null);
    setOverlay(null);
    const flight = fly(threadId, () => inbox.retry(targetThreadId), false);
    advanceIfLeaving(item, (snapshot) => predictRetry(snapshot, threadId));
    const outcome = await flight;

    if (outcome?.kind === "refused") setNotice(outcome.message);
    else if (outcome?.kind === "failed") setNotice(FAILED_TEXT);
  };

  const openThread = (threadId: string, split = false, userInitiated = true) => {
    navigate.toThread(threadId, userInitiated ? chatTapOptions(split) : { split });
    onNavigate();
  };

  const member = (item: Item, run: InboxRun) => {
    const entry = runEntry(item.entry, run);
    const card = entry.card;

    if (card === null || pending.has(run.threadId)) return;
    const intent = primaryIntent(entry, card, true, true);

    const memberItem: Item = {
      key: keyOf("inbox", run.threadId),
      section: "inbox",
      entry,
      shown: null,
      family: null,
      nested: true,
      ready: readyToArchive(entry),
    };

    if (intent.kind === "act") void send(memberItem, intent.request);
    else if (intent.kind !== "command" || intent.command === "open") openThread(run.threadId);
    else if (intent.command === "reply") reply(run.threadId);
    else if (intent.command === "archive" && !busyFamilies.has(run.threadId))
      void send(memberItem, archiveRequest(entry, true, false));
    else openThread(run.threadId);
  };

  const reply = (threadId: string) => {
    setOverlay(null);
    navigate.toThread(threadId, chatTapOptions());
    onNavigate();
    setComposerFor(threadId);
  };

  const endReply = useCallback(() => setComposerFor(null), []);

  const openOverlay = (item: Item, next: Exclude<Overlay, { kind: "bulk" }>) => {
    setCursor({ section: item.section, threadId: item.entry.threadId });
    setOverlay(next);
  };

  const archive = (item: Item, focused: boolean) => {
    const card = item.entry.card;

    if (card === null) return;

    if (card.questionMode === "required" || busyFamilies.has(item.entry.threadId))
      openOverlay(item, { kind: "stop", key: item.key });
    else void send(item, archiveRequest(item.entry, focused, false));
  };

  const command = (name: InboxCommand, item: Item, focused: boolean): boolean => {
    const entry = item.entry;
    const card = entry.card;

    if (itemThreadId(item) !== entry.threadId) {
      if (name === "open") select(item, true, false);
      else if (name === "reply") reply(itemThreadId(item));
      else return false;

      return true;
    }

    if (flights.has(entry.threadId) && !CHAINED_COMMANDS.has(name)) return true;

    if (card?.kind === "runs" && (name === "archive" || name === "shelf")) return false;

    switch (name) {
      case "open":
        select(item, true, false);

        return true;
      case "reply":
        reply(replyTarget(entry));

        return true;
      case "archive":
        archive(item, focused);

        return card !== null;
      case "wait":
        if (card === null || !card.actions.includes("wait")) return false;
        openOverlay(item, { kind: "wait", key: item.key, step: "menu" });

        return true;
      case "shelf":
        void send(item, { action: "shelf", threadId: entry.threadId, shelved: !entry.shelved });

        return true;
      case "happened": {
        const waitId = happenedWaitId(entry);

        if (waitId === null) return false;
        void send(item, { action: "happened", threadId: entry.threadId, waitId, note: null });

        return true;
      }

      case "retry": {
        const primary = card?.primary;

        if (primary?.kind !== "problem-chooser") return false;
        void retry(item, primary.targetThreadId);

        return true;
      }
    }
  };

  const primary = (item: Item, focused: boolean): boolean => {
    const shown = item.shown;
    const card = item.entry.card;
    const threadId = item.entry.threadId;

    if (shown === null || card === null) {
      select(item, true, false);

      return true;
    }

    if (pending.has(threadId) || recentlyChanged(changes, threadId, Date.now())) return true;

    const intent = primaryIntent(item.entry, card, focused, touch);

    switch (intent.kind) {
      case "act":
        void send(item, intent.request);

        return true;
      case "command":
        return command(intent.command, item, focused);
      case "choose":
        openOverlay(item, { kind: "choose", key: item.key, items: intent.items });

        return true;
      case "answer":
        return command("open", item, focused);
    }
  };

  const pickWait = (item: Item, card: InboxCard, choice: WaitChoice) => {
    if (choice.step === "date") void send(item, waitRequest(item.entry, card, true, choice.until));
    else
      openOverlay(item, {
        kind: "wait",
        key: item.key,
        step: choice.step === "pick" ? "date" : "event",
      });
  };

  const choose = (digit: number): boolean => {
    if (current === null) return false;
    const card = current.entry.card;

    if (
      overlay !== null &&
      overlay.kind !== "bulk" &&
      overlay.key === current.key &&
      card !== null
    ) {
      if (overlay.kind === "choose") {
        const choice = overlay.items.find((entry) => entry.digit === digit);

        if (choice !== undefined) {
          setOverlay(null);
          command(choice.command, current, true);
        }
      } else if (overlay.kind === "stop") {
        if (digit === 1) void send(current, archiveRequest(current.entry, true, true));
      } else if (overlay.step === "menu") {
        const choice = waitChoices(card, now).find((entry) => entry.digit === digit);

        if (choice !== undefined) pickWait(current, card, choice);
      }

      return true;
    }

    return false;
  };

  const undoLast = (): boolean => {
    const move = toast?.move ?? null;

    if (move === null) return false;

    const finish =
      toast?.restore === null || toast?.restore === undefined ? null : inbox.preview(toast.restore);

    setToast(null);

    void (async () => {
      const outcome = await undoAfter(move, (moveId) => {
        finish?.();

        return inbox.undo(moveId);
      });

      finish?.();

      if (outcome === null) return;

      if (outcome.kind === "done") setToast({ move: null, restore: null, text: "Undone" });
      else setNotice(outcome.kind === "refused" ? outcome.message : "Couldn't undo. Try again.");
    })();

    return true;
  };

  const archiveBulk = async (entries: readonly InboxEntry[]) => {
    setOverlay(null);
    setNotice(null);

    if (entries.length === 0) return;

    const placed: Toast = {
      move: null,
      restore: null,
      text: `Archived ${plural(entries.length, "chat")}`,
    };

    setToast(placed);

    const outcomes = await Promise.all(
      entries.map((entry) => inbox.act(archiveRequest(entry, true, false))),
    );

    const done = outcomes.filter((outcome) => outcome.kind === "done");
    const archived = done.length;

    if (archived === 0) {
      setToast((current) => (current === placed ? null : current));
      setNotice(FAILED_TEXT);

      return;
    }

    const single = archived === 1 ? (done[0] ?? null) : null;

    setToast((current) => {
      if (current !== placed) return current;

      return {
        move: single === null ? null : Promise.resolve(single),
        restore: null,
        text:
          archived === entries.length
            ? `Archived ${plural(archived, "chat")}`
            : `Archived ${archived} of ${entries.length}`,
      };
    });
  };

  const openBulk = () => {
    const entries = bulkArchive(
      cards.map((shown) => shown.entry),
      busyFamilies,
    );

    if (entries.length === 0 || !sectionOrder.includes("ready")) return;

    setOverlay({ kind: "bulk", entries });
  };

  const reveal = () => {
    if (layout === null) return;
    const shown = revealAbove(layout);

    const first = rootItems.find(
      (item) =>
        item.entry.threadId === shown.first ||
        item.family?.family.some((thread) => thread.id === shown.first),
    );

    setMemory(shown.layout);

    if (!sectionOpen("need")) toggleSection("need");

    if (first !== undefined) select(first, !touch, false);
  };

  const move = (step: number) => {
    if (items.length === 0) return;

    const index =
      current === null
        ? items.findIndex((item) => itemThreadId(item) === activeThreadId)
        : items.indexOf(current);

    const next = items[Math.max(0, Math.min(items.length - 1, index + step))];

    if (next !== undefined) select(next, true, false);
  };

  const escape = (): boolean => {
    if (overlay !== null) {
      setOverlay(null);

      return true;
    }

    const runningShown =
      sectionOrder.includes("run") &&
      (showEmpty || rootItems.some((item) => item.section === "running"));

    if (!runningExpanded || !runningShown) return false;
    setRunningExpanded(false);

    return true;
  };

  const run = (result: KeyResult): boolean => {
    if (result.kind === "digit") return choose(result.digit);

    switch (result.command) {
      case "next":
        move(1);

        return true;
      case "previous":
        move(-1);

        return true;
      case "escape":
        return escape();
      case "undo":
        return undoLast();
      case "bulk":
        openBulk();

        return true;
      case "primary":
        if (overlay?.kind === "bulk") {
          void archiveBulk(overlay.entries);

          return true;
        }

        return current === null ? false : primary(current, true);
      default:
        return current === null ? false : command(result.command, current, true);
    }
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.defaultPrevented) return;
    const target = event.target;

    if (!(target instanceof HTMLElement)) return;

    if (target.closest("input, textarea, select, [contenteditable]") !== null) {
      if (event.key === "Escape" && overlay !== null) {
        event.preventDefault();
        setOverlay(null);
      }

      return;
    }

    const result = keyCommand(event);

    if (result === null) return;

    if (result.kind === "command" && result.command === "primary" && target.closest("button"))
      return;

    if (run(result)) event.preventDefault();
  };

  const pickTag = useCallback(
    (threadId: string, tagId: string | null) => {
      setNotice(null);
      onTag(threadId, tagId).catch(() => setNotice("Could not change the tag."));
    },
    [onTag],
  );

  const context: FeedContext = {
    usage,
    tree,
    memberItems,
    expanded,
    toggleSubchats,
    now,
    touch,
    cursorKey,
    activeThreadId,
    pending,
    changes,
    overlay,
    threads,
    byId,
    projectNames,
    tags,
    tagOf,
    pickTag,
    open: (item, split) => select(item, true, split),
    primary: (item, focused) => void primary(item, focused),
    command: (name, item, focused) => void command(name, item, focused),
    pick: (choice, item) => {
      setOverlay(null);
      command(choice.command, item, true);
    },
    pickWait,
    submitDate: (item, card, value) => {
      const until = pickedDate(value);

      if (until === null || until <= Date.now()) setNotice("Pick a future date.");
      else void send(item, waitRequest(item.entry, card, true, until));
    },
    submitEvent: (item, card, value) => {
      const event = value.trim().slice(0, EVENT_MAX);

      if (event !== "") void send(item, reportRequest(item.entry, card, true, event));
    },
    member,
    openThread,
    stop: (item) => void send(item, archiveRequest(item.entry, true, true)),
    shelfDrag,
    shelfRoots,
  };

  if (load.status === "error" && snapshot === null)
    return (
      <div role="alert" className="ctf-empty" data-inbox-error="">
        <Icon name="AlertCircle" aria-hidden className="ctf-empty-glyph" data-tone="error" />
        <p className="ctf-empty-title">The Inbox didn’t load</p>
        <span>Refresh Omnyo to try again.</span>
      </div>
    );

  if (load.status === "loading" || snapshot === null)
    return (
      <div role="status" aria-label="Loading the Inbox" className="ctf-skeleton">
        {[0, 1].map((group) => (
          <div key={group} className="ctf-skeleton-group" aria-hidden>
            <span className="ctf-skeleton-heading" />
            {[0, 1, 2].map((row) => (
              <span key={row} className="ctf-skeleton-row">
                <span className="ctf-skeleton-icon" />
                <span className="ctf-skeleton-line" data-width={(group + row) % 3} />
              </span>
            ))}
          </div>
        ))}
      </div>
    );

  const above = layout?.above.size ?? 0;
  const shown = (key: InboxSectionKey, item: Item) => sectionOpen(key) && !item.nested;
  const roots = rootItems.filter((item) => !item.nested);
  const needCount = roots.filter((item) => inboxSection(item.entry) === "need").length;

  const needItems = items.filter(
    (item) => shown("need", item) && inboxSection(item.entry) === "need",
  );

  const failedCount = roots.filter((item) => inboxSection(item.entry) === "failed").length;

  const failedItems = items.filter(
    (item) => shown("failed", item) && inboxSection(item.entry) === "failed",
  );

  const isFinished = (item: Item) =>
    item.section !== "shelf" && inboxSection(item.entry) === "finished";

  const finishedCount = roots.filter(isFinished).length;
  const finishedItems = items.filter((item) => shown("finished", item) && isFinished(item));
  const readyCount = roots.filter((item) => inboxSection(item.entry) === "ready").length;

  const readyItems = items.filter(
    (item) => shown("ready", item) && inboxSection(item.entry) === "ready",
  );

  const waitingLanes = WAITING_LANES.map((lane) => ({
    lane,
    rows: items.filter(
      (item) =>
        shown("waiting", item) &&
        item.section === "waiting" &&
        waitingLane(item.entry.waiting) === lane,
    ),
  })).filter(({ rows }) => rows.length > 0);

  const shelf = items.filter((item) => !item.nested && item.section === "shelf");
  const shelfCount = rootItems.filter((item) => item.section === "shelf").length;
  const runningCount = roots.filter((item) => item.section === "running").length;
  const waitingCount = rootItems.filter((item) => item.section === "waiting").length;

  const bulkReady = bulkArchive(
    cards.map((card) => card.entry),
    busyFamilies,
  );

  const arrive = (key: InboxSectionKey) => (arriving === key ? "" : undefined);

  const toolbar = (
    <>
      {toast === null ? null : (
        <div className="ctf-bar" role="status">
          <Icon
            name={toast.text === "Undone" ? "RotateCcw" : "CircleCheck"}
            aria-hidden
            className="ctf-bar-icon"
          />
          <span className="ctf-bar-text">{toast.text}</span>
          {toast.move === null ? null : (
            <button type="button" className="ctf-row-act" aria-keyshortcuts="Z" onClick={undoLast}>
              Undo
              <kbd>Z</kbd>
            </button>
          )}
        </div>
      )}
      {notice === null ? null : (
        <p role="alert" className="ctf-notice">
          <Icon name="AlertCircle" aria-hidden className="ctf-notice-icon" />
          {notice}
        </p>
      )}
      {load.status === "ready" && load.failed ? (
        <p role="alert" className="ctf-notice">
          <Icon name="AlertCircle" aria-hidden className="ctf-notice-icon" />
          Couldn’t refresh the Inbox. It shows the last update.
        </p>
      ) : null}
    </>
  );

  const block = (
    key: InboxSectionKey,
    label: string,
    count: number,
    body: ReactNode,
    extra: {
      note?: string | null;
      actions?: ReactNode;
      ref?: RefObject<HTMLElement | null>;
    } = {},
  ): ReactNode =>
    count === 0 && !showEmpty ? null : (
      <section
        {...sectionDrag.section(key)}
        ref={extra.ref}
        className="ctf-section"
        data-feed-section={FEED_SECTION[key]}
        data-open={sectionOpen(key)}
        data-arrive={arrive(key)}
        aria-label={`${label}, ${count}`}
      >
        <SectionHeading
          sectionKey={key}
          motionKey={`section:${FEED_SECTION[key]}`}
          label={label}
          count={count}
          noun="chat"
          note={extra.note ?? null}
          open={sectionOpen(key)}
          drag={sectionDrag.heading(key, label)}
          running={key === "run"}
          actions={extra.actions}
          onToggle={toggleSection}
        />
        {count === 0 && sectionOpen(key) ? (
          <p className="ctf-section-empty">{EMPTY_SECTION[key]}</p>
        ) : (
          body
        )}
      </section>
    );

  const members = (list: readonly Item[]) =>
    list.map((item) => <FeedMember key={item.key} item={item} context={context} />);

  const sectionBlocks: Record<InboxSectionKey, ReactNode> = {
    need: block("need", "Needs you", needCount, members(needItems)),
    failed: block("failed", "Failed", failedCount, members(failedItems)),
    finished: block("finished", "Finished", finishedCount, members(finishedItems)),
    ready: block("ready", "Ready to archive", readyCount, members(readyItems), {
      actions:
        overlay?.kind === "bulk" ? (
          <span
            className="ctf-heading-action ctf-heading-confirm"
            role="group"
            aria-label={`Archive ${plural(overlay.entries.length, "finished chat")}?`}
          >
            <button type="button" className="ctf-row-act" onClick={() => setOverlay(null)}>
              Cancel
            </button>
            <button
              type="button"
              className="ctf-row-act"
              data-confirm=""
              aria-keyshortcuts="Enter"
              onClick={() => void archiveBulk(overlay.entries)}
            >
              Archive {overlay.entries.length}?
            </button>
          </span>
        ) : bulkReady.length === 0 ? null : (
          <button
            type="button"
            className="ctf-row-act ctf-heading-action"
            aria-keyshortcuts="Shift+E"
            title={`Archive ${plural(bulkReady.length, "finished chat")} (Shift E)`}
            onClick={openBulk}
          >
            {bulkReady.length === readyCount ? "Archive all" : `Archive ${bulkReady.length}`}
          </button>
        ),
    }),
    run: block(
      "run",
      "Running",
      runningCount,
      members(items.filter((item) => !item.nested && item.section === "running")),
      { ref: runningSection },
    ),
    waiting: block(
      "waiting",
      VIEW_LABEL.waiting,
      waitingCount,
      <div className="ctf-timeline">
        {waitingLanes.map(({ lane, rows }) => (
          <Fragment key={lane}>
            <SubGroup label={WAITING_LANE_LABEL[lane]} motionKey={`group:wait-${lane}`} />
            {members(rows)}
          </Fragment>
        ))}
      </div>,
    ),
    shelf: block(
      "shelf",
      SHELF_SECTION.label,
      shelfCount,
      shelf.map((item) => (
        <FeedRow
          key={item.key}
          item={item}
          dot={STATE_DOT[item.entry.state]}
          dotLabel={VIEW_LABEL[item.entry.view]}
          detail={null}
          action={null}
          progress={null}
          context={context}
        />
      )),
    ),
  };

  return (
    <div ref={rootRef} className="ctf-root" onKeyDown={onKeyDown}>
      {composerFor === null ? null : (
        <FocusComposer key={composerFor} threadId={composerFor} onDone={endReply} />
      )}
      <ListMotion scopeKey="inbox" className="ctf" data-feed="" data-inbox="">
        <>
          {toolbar}
          {above === 0 ? null : (
            <button type="button" className="ctf-pill" onClick={reveal}>
              {plural(above, "new question")}
              <Icon name="ArrowUp" aria-hidden className="size-3" />
            </button>
          )}
          {sectionOrder.map((key) => (
            <Fragment key={key}>{sectionBlocks[key]}</Fragment>
          ))}
          {sectionOrder.some((key) => sectionBlocks[key] !== null) ? null : (
            <div className="ctf-empty" data-inbox-empty="">
              <Icon name="CircleCheck" aria-hidden className="ctf-empty-glyph" />
              <p className="ctf-empty-title">Nothing needs you</p>
              <span>
                {sections.hidden.size === 0
                  ? "New questions, finished work and waits show up here."
                  : `${plural(sections.hidden.size, "section")} ${sections.hidden.size === 1 ? "is" : "are"} hidden.`}
              </span>
              {touch ? null : (
                <span className="ctf-empty-hint">Right-click to choose which sections show.</span>
              )}
            </div>
          )}
        </>
      </ListMotion>
    </div>
  );
}
