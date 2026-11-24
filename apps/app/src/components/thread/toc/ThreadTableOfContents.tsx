import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { PromptTextMention } from "@omnyo/domain";
import type {
  ThreadConversationOutlineItem,
  ThreadConversationOutlineResponse,
  TimelineConversationAttachments,
  TimelineConversationRow,
  TimelineRow,
} from "@omnyo/server-contract";
import { useScrollOverflowState } from "@/components/thread/timeline/useScrollOverflowState";
import { useBottomAnchoredScroll } from "@/components/ui/bottom-anchored-scroll-body.js";
import { revealTimelineRow } from "@/components/thread/timeline/reveal-timeline-row.js";
import { useThreadConversationOutline } from "@/hooks/queries/thread-queries";
import { useSenderThreadMetadataById } from "@/hooks/useSenderThreadMetadataById";
import { PromptMentionIcon } from "@/components/promptbox/mentions/PromptMentionIcon";
import { PROMPT_MENTION_PILL_CLASS } from "@/components/promptbox/mentions/prompt-mention-display";
import { cn } from "@omnyo/shared-ui/lib/utils";
import { HOVER_REVEAL_NO_HOVER_VISIBLE_CLASS } from "@omnyo/shared-ui/hover-reveal";
import { Icon } from "@omnyo/shared-ui/icon";
import {
  FLOATING_POPOVER_MOTION,
  LIST_HOVER_TRANSITION,
  MOTION_DURATION_MS,
  TRANSITION_FALLBACK_SLACK_MS,
} from "@omnyo/shared-ui/motion";
import { ResponsiveDrawerShell } from "@omnyo/shared-ui/responsive-overlay";
import { useThreadOutlineRequests } from "@/components/thread/toc/thread-outline-request";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@omnyo/shared-ui/tooltip";
import {
  isHumanThreadInput,
  parseAgentMessageEnvelope,
} from "@omnyo/thread-view";
import { CompactMessagePreview } from "@/components/thread/timeline/CompactMessagePreview";
import { shiftMentionsToTextRange } from "@/components/thread/timeline/ConversationMessageMentions";
import {
  useResolveThreadTitle,
  useThreadTitleDisplayText,
} from "@/components/thread/ThreadTitleMentions";

export interface TocItem {
  id: string;
  label: string;
  text?: string;
  mentions?: readonly PromptTextMention[];
  role: "user" | "assistant";
}

type TocTab = "user" | "agent";

interface ActiveItemIds {
  agent: string | null;
  user: string | null;
  position: string | null;
}

interface ThreadTableOfContentsProps {
  contextBoundarySeq: number | null;
  threadId: string;
  timelineRows: readonly TimelineRow[];
  hasOlderTimelineRows: boolean;
  loadOlderTimelineRows: () => void | Promise<void>;
}

const TOC_MIN_VISIBLE_WIDTH_PX = 56 * 16;

const TOC_BOTTOM_ACTIVE_THRESHOLD_PX = 4;

const TOC_MIN_USER_MESSAGES = 3;

const TOC_MAX_RAIL_TICKS = 20;

const TOC_RAIL_SLOT_HEIGHT_PX = 28;

const TOC_RAIL_CONTROLS_HEIGHT_PX = 56;

const TOC_ACTIVE_UPDATE_IDLE_MS = 120;

const TOC_JUMP_MAX_PAGE_LOADS = 1000;

const TOC_OPEN_REQUEST_FRAMES = 2;

const TOC_JUMP_RENDER_FRAMES = 6;

function toPreviewLabel(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function formatAttachmentCountLabel(
  imageCount: number,
  fileCount: number,
): string {
  const totalCount = imageCount + fileCount;

  if (totalCount === 0) return "Message";

  if (totalCount === 1) {
    return imageCount === 1 ? "Image attachment" : "File attachment";
  }

  return `${totalCount} attachments`;
}

function toTocLabel({
  attachments,
  text,
}: {
  attachments: TimelineConversationAttachments | null;
  text: string;
}): string {
  const textLabel = toPreviewLabel(text);

  if (textLabel) return textLabel;

  if (!attachments) return "Message";

  return formatAttachmentCountLabel(
    attachments.webImages + attachments.localImages,
    attachments.localFiles,
  );
}

const timelineTocItemsByRow = new WeakMap<
  TimelineConversationRow,
  TocItem | null
>();

function getTimelineTocItem(row: TimelineConversationRow): TocItem | null {
  const cachedItem = timelineTocItemsByRow.get(row);

  if (cachedItem !== undefined) return cachedItem;

  const text = row.text;

  if (
    row.role === "user" &&
    !isHumanThreadInput({
      initiator: row.initiator,
      senderThreadId: row.senderThreadId,
      systemMessageKind: row.systemMessageKind,
      text,
    })
  ) {
    timelineTocItemsByRow.set(row, null);

    return null;
  }

  const item: TocItem = {
    id: row.id,
    label: toTocLabel({ attachments: row.attachments, text }),
    text: text.trim().length === 0 ? undefined : text,
    mentions: row.role === "user" ? row.mentions : undefined,
    role: row.role,
  };

  timelineTocItemsByRow.set(row, item);

  return item;
}

function outlineItemToTocItem(item: ThreadConversationOutlineItem): TocItem {
  const summary = item.attachmentSummary;

  return {
    id: item.id,
    label:
      item.preview ||
      (summary
        ? formatAttachmentCountLabel(summary.imageCount, summary.fileCount)
        : "Message"),
    mentions: item.mentions,
    role: item.role,
  };
}

function partitionTocItems(items: Iterable<TocItem>): {
  agentItems: TocItem[];
  userItems: TocItem[];
} {
  const userItems: TocItem[] = [];
  const agentItems: TocItem[] = [];

  for (const item of items) {
    if (item.role === "user") {
      userItems.push(item);
    } else {
      agentItems.push(item);
    }
  }

  return { agentItems, userItems };
}

function mergeLiveTocItems(
  outlineItems: readonly TocItem[],
  timelineItems: readonly TocItem[],
): TocItem[] {
  const timelineItemsById = new Map(
    timelineItems.map((item) => [item.id, item]),
  );

  const outlineItemIds = new Set(outlineItems.map((item) => item.id));

  return [
    ...outlineItems.map((item) => timelineItemsById.get(item.id) ?? item),
    ...timelineItems.filter((item) => !outlineItemIds.has(item.id)),
  ];
}

export function selectTocRailItems({
  activeId,
  items,
  maxItems = TOC_MAX_RAIL_TICKS,
}: {
  activeId: string | null;
  items: readonly TocItem[];
  maxItems?: number;
}): readonly TocItem[] {
  if (items.length <= maxItems) return items;

  const maxIndex = items.length - 1;

  const activeIndex =
    activeId === null ? -1 : items.findIndex((item) => item.id === activeId);

  const sampledIndices = new Set<number>();

  for (let slot = 0; slot < maxItems; slot += 1) {
    sampledIndices.add(Math.round((slot * maxIndex) / (maxItems - 1)));
  }

  if (activeIndex >= 0) {
    sampledIndices.add(activeIndex);

    if (sampledIndices.size > maxItems) {
      let removableIndex: number | null = null;
      let removableDistance = Number.POSITIVE_INFINITY;

      for (const index of sampledIndices) {
        if (index === activeIndex || index === 0 || index === maxIndex) {
          continue;
        }

        const distance = Math.abs(index - activeIndex);

        if (distance < removableDistance) {
          removableIndex = index;
          removableDistance = distance;
        }
      }

      if (removableIndex !== null) sampledIndices.delete(removableIndex);
    }
  }

  return Array.from(sampledIndices)
    .sort((a, b) => a - b)
    .map((index) => items[index]);
}

function TocPanelTab({
  label,
  active,
  hasSlidingIndicator,
  onSelect,
}: {
  label: string;
  active: boolean;
  hasSlidingIndicator: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-pressed={active}
      className={cn(
        "flex h-7 flex-1 cursor-pointer items-center justify-center rounded-md text-xs transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
        active
          ? cn("text-foreground", !hasSlidingIndicator && "bg-state-hover")
          : "text-muted-foreground hover:bg-state-hover",
      )}
    >
      {label}
    </button>
  );
}

function TocPanelTabIndicator({ activeTab }: { activeTab: TocTab }) {
  return (
    <span
      aria-hidden
      data-toc-tab-indicator=""
      className={cn(
        "pointer-events-none absolute top-0 left-0 -z-10 h-7 w-[calc(50%-0.125rem)] rounded-md bg-state-hover transition-[translate] duration-(--motion-duration-base) ease-(--motion-ease-smooth) motion-reduce:transition-none",
        activeTab === "user" && "translate-x-[calc(100%+0.25rem)]",
      )}
    />
  );
}

function TocThreadMention({
  threadId,
  threadTitle,
}: {
  threadId: string;
  threadTitle: string | null;
}) {
  const label = useThreadTitleDisplayText(threadTitle ?? "Agent");

  return (
    <span
      className={cn(
        PROMPT_MENTION_PILL_CLASS,
        "max-w-32 shrink-0 bg-surface-raised/50 text-foreground",
      )}
      title={`Thread: ${label}`}
    >
      <PromptMentionIcon
        resource={{ kind: "thread", threadId, label }}
        className="size-3 shrink-0 self-center text-muted-foreground"
      />
      <span className="truncate">{label}</span>
    </span>
  );
}

function TocItemPreview({
  item,
  senderThreadMetadataById,
}: {
  item: TocItem;
  senderThreadMetadataById: ReadonlyMap<string, { title: string | null }>;
}) {
  const text = item.text ?? item.label;
  const source = parseAgentMessageEnvelope(text);

  if (source === null) {
    return (
      <CompactMessagePreview
        className="line-clamp-2"
        text={text}
        mentions={item.mentions}
      />
    );
  }

  const body = text.slice(source.bodyStart);

  return (
    <span className="flex min-w-0 items-start gap-1">
      <TocThreadMention
        threadId={source.senderThreadId}
        threadTitle={
          senderThreadMetadataById.get(source.senderThreadId)?.title ?? null
        }
      />
      <CompactMessagePreview
        className="line-clamp-2 min-w-0"
        text={body || "Message"}
        mentions={shiftMentionsToTextRange({
          mentions: item.mentions ?? [],
          rangeStart: source.bodyStart,
          rangeEnd: text.length,
        })}
      />
    </span>
  );
}

function mergeOutlineTocItems(
  outlineItems: readonly ThreadConversationOutlineItem[] | undefined,
  timelineItems: readonly TocItem[],
): TocItem[] {
  if (!outlineItems || outlineItems.length === 0) return [...timelineItems];

  return mergeLiveTocItems(
    outlineItems.map(outlineItemToTocItem),
    timelineItems,
  );
}

function useConversationTocItems({
  agentOutlineItems,
  timelineRows,
  userOutlineItems,
}: {
  agentOutlineItems: readonly ThreadConversationOutlineItem[] | undefined;
  timelineRows: readonly TimelineRow[];
  userOutlineItems: readonly ThreadConversationOutlineItem[] | undefined;
}) {
  const timelineTocItems = useMemo(
    () =>
      partitionTocItems(
        timelineRows
          .filter((row) => row.kind === "conversation")
          .flatMap((row) => {
            const item = getTimelineTocItem(row);

            return item === null ? [] : [item];
          }),
      ),
    [timelineRows],
  );

  const userItems = useMemo(
    () => mergeOutlineTocItems(userOutlineItems, timelineTocItems.userItems),
    [timelineTocItems.userItems, userOutlineItems],
  );

  const agentItems = useMemo(
    () => mergeOutlineTocItems(agentOutlineItems, timelineTocItems.agentItems),
    [agentOutlineItems, timelineTocItems.agentItems],
  );

  return { agentItems, userItems };
}

function currentOutlineItems(
  data: ThreadConversationOutlineResponse | undefined,
  contextBoundarySeq: number | null,
): readonly ThreadConversationOutlineItem[] | undefined {
  return contextBoundarySeq !== null &&
    (data?.maxSeq ?? -1) < contextBoundarySeq
    ? undefined
    : data?.items;
}

function useThreadTocLayout(rootElement: HTMLElement | null) {
  const [layout, setLayout] = useState<{
    mode: "measuring" | "rail" | "compact";
    maxRailItems: number;
  }>(() => ({
    mode: typeof ResizeObserver === "undefined" ? "rail" : "measuring",
    maxRailItems: TOC_MAX_RAIL_TICKS,
  }));

  useEffect(() => {
    const host =
      rootElement?.closest<HTMLElement>("[data-scroll-overlay]") ?? null;

    if (!host || typeof ResizeObserver === "undefined") return;

    const resizeObserver = new ResizeObserver(([entry]) => {
      if (!entry) return;

      const inlineSize =
        entry.contentBoxSize[0]?.inlineSize ?? entry.contentRect.width;

      const blockSize =
        entry.contentBoxSize[0]?.blockSize ?? entry.contentRect.height;

      const availableSlots = Math.floor(
        (blockSize - TOC_RAIL_CONTROLS_HEIGHT_PX) / TOC_RAIL_SLOT_HEIGHT_PX,
      );

      const nextLayout: typeof layout = {
        mode:
          inlineSize >= TOC_MIN_VISIBLE_WIDTH_PX &&
          availableSlots >= TOC_MIN_USER_MESSAGES
            ? "rail"
            : "compact",
        maxRailItems: Math.max(
          TOC_MIN_USER_MESSAGES,
          Math.min(TOC_MAX_RAIL_TICKS, availableSlots),
        ),
      };

      setLayout((current) =>
        current.mode === nextLayout.mode &&
        current.maxRailItems === nextLayout.maxRailItems
          ? current
          : nextLayout,
      );
    });

    resizeObserver.observe(host, { box: "content-box" });

    return () => resizeObserver.disconnect();
  }, [rootElement]);

  return layout;
}

function isElementRendered(element: HTMLElement): boolean {
  return (
    element.isConnected &&
    (typeof element.checkVisibility !== "function" || element.checkVisibility())
  );
}

function findTimelineRowElements(
  scrollElement: HTMLElement | null,
): HTMLElement[] {
  return scrollElement
    ? Array.from(
        scrollElement.querySelectorAll<HTMLElement>("[data-timeline-row-id]"),
      )
    : [];
}

function findTimelineRowElement(
  scrollElement: HTMLElement | null,
  rowId: string,
): HTMLElement | null {
  return (
    findTimelineRowElements(scrollElement).find(
      (row) => row.dataset.timelineRowId === rowId,
    ) ?? null
  );
}

function waitForAnimationFrame(): Promise<void> {
  return new Promise((resolve) => {
    if (typeof window === "undefined") {
      resolve();

      return;
    }

    window.requestAnimationFrame(() => resolve());
  });
}

function isScrollElementNearBottom(scrollElement: HTMLElement): boolean {
  return (
    scrollElement.scrollHeight -
      scrollElement.clientHeight -
      scrollElement.scrollTop <=
    TOC_BOTTOM_ACTIVE_THRESHOLD_PX
  );
}

function findFirstVisibleItemId({
  rows,
  scrollBottom,
  scrollTop,
}: {
  rows: readonly HTMLElement[];
  scrollBottom: number;
  scrollTop: number;
}): string | null {
  let low = 0;
  let high = rows.length - 1;
  let visibleRow: HTMLElement | null = null;
  let visibleRect: DOMRect | null = null;

  while (low <= high) {
    const index = low + Math.floor((high - low) / 2);
    const row = rows[index];

    if (!row) break;
    const rect = row.getBoundingClientRect();

    if (rect.bottom <= scrollTop) {
      low = index + 1;
      continue;
    }

    visibleRow = row;
    visibleRect = rect;
    high = index - 1;
  }

  if (!visibleRow || !visibleRect || visibleRect.top >= scrollBottom) {
    return null;
  }

  return visibleRow.dataset.timelineRowId ?? null;
}

function findLastVisibleItemId({
  rows,
  scrollBottom,
  scrollTop,
}: {
  rows: readonly HTMLElement[];
  scrollBottom: number;
  scrollTop: number;
}): string | null {
  let low = 0;
  let high = rows.length - 1;
  let visibleRow: HTMLElement | null = null;
  let visibleRect: DOMRect | null = null;

  while (low <= high) {
    const index = low + Math.floor((high - low) / 2);
    const row = rows[index];

    if (!row) break;
    const rect = row.getBoundingClientRect();

    if (rect.top >= scrollBottom) {
      high = index - 1;
      continue;
    }

    visibleRow = row;
    visibleRect = rect;
    low = index + 1;
  }

  if (!visibleRow || !visibleRect || visibleRect.bottom <= scrollTop) {
    return null;
  }

  return visibleRow.dataset.timelineRowId ?? null;
}

export function findActiveItemIds({
  agentItems,
  scrollElement,
  userItems,
}: {
  agentItems: readonly TocItem[];
  scrollElement: HTMLElement | null;
  userItems: readonly TocItem[];
}): ActiveItemIds {
  if (!scrollElement || (userItems.length === 0 && agentItems.length === 0)) {
    return { agent: null, user: null, position: null };
  }

  const scrollRect = scrollElement.getBoundingClientRect();
  const scrollTop = scrollRect.top;
  const scrollBottom = scrollRect.bottom;
  const isNearBottom = isScrollElementNearBottom(scrollElement);
  const rolesById = new Map<string, TocTab>();

  for (const item of userItems) rolesById.set(item.id, "user");

  for (const item of agentItems) rolesById.set(item.id, "agent");
  const userRows: HTMLElement[] = [];
  const agentRows: HTMLElement[] = [];
  const timelineRowElements = findTimelineRowElements(scrollElement);

  for (const row of timelineRowElements) {
    const rowId = row.dataset.timelineRowId;

    if (!rowId) continue;
    const role = rolesById.get(rowId);

    if (role === "user") {
      userRows.push(row);
    } else if (role === "agent") {
      agentRows.push(row);
    }
  }

  if (isNearBottom) {
    return {
      agent: findLastVisibleItemId({
        rows: agentRows,
        scrollBottom,
        scrollTop,
      }),
      user: findLastVisibleItemId({
        rows: userRows,
        scrollBottom,
        scrollTop,
      }),
      position: findLastVisibleItemId({
        rows: timelineRowElements,
        scrollBottom,
        scrollTop,
      }),
    };
  }

  return {
    agent: findFirstVisibleItemId({
      rows: agentRows,
      scrollBottom,
      scrollTop,
    }),
    user: findFirstVisibleItemId({
      rows: userRows,
      scrollBottom,
      scrollTop,
    }),
    position: findFirstVisibleItemId({
      rows: timelineRowElements,
      scrollBottom,
      scrollTop,
    }),
  };
}

function TocPanelContents({
  activeId,
  activeTab,
  compact,
  hasAgentMessages,
  items,
  open,
  pendingJumpId,
  senderThreadMetadataById,
  onSelectTab,
  onSelectItem,
}: {
  activeId: string | null;
  activeTab: TocTab;
  compact: boolean;
  hasAgentMessages: boolean;
  items: readonly TocItem[];
  open: boolean;
  pendingJumpId: string | null;
  senderThreadMetadataById: ReadonlyMap<string, { title: string | null }>;
  onSelectTab: (tab: TocTab) => void;
  onSelectItem: (id: string) => void;
}) {
  const {
    aboveOverflow,
    belowOverflow,
    bottomSentinelRef,
    scrollRef,
    topSentinelRef,
  } = useScrollOverflowState<HTMLDivElement>({
    enabled: open,
    measureOverflow: true,
  });

  const itemEls = useRef(new Map<string, HTMLElement>());

  useEffect(() => {
    if (!open) return;
    const container = scrollRef.current;
    const el = activeId ? itemEls.current.get(activeId) : null;

    if (!container || !el) return;
    const containerRect = container.getBoundingClientRect();
    const elRect = el.getBoundingClientRect();
    const pad = 8;

    if (elRect.top < containerRect.top + pad) {
      container.scrollTo({
        top: container.scrollTop - (containerRect.top + pad - elRect.top),
      });
    } else if (elRect.bottom > containerRect.bottom - pad) {
      container.scrollTo({
        top:
          container.scrollTop + (elRect.bottom - (containerRect.bottom - pad)),
      });
    }
  }, [activeId, items, open, scrollRef]);

  return (
    <>
      <div className="relative isolate flex items-center gap-1 pb-1">
        {hasAgentMessages ? (
          <>
            <TocPanelTabIndicator activeTab={activeTab} />
            <TocPanelTab
              label="Agent messages"
              active={activeTab === "agent"}
              hasSlidingIndicator
              onSelect={() => onSelectTab("agent")}
            />
          </>
        ) : null}
        <TocPanelTab
          label="Your messages"
          active={activeTab === "user"}
          hasSlidingIndicator={hasAgentMessages}
          onSelect={() => onSelectTab("user")}
        />
      </div>
      <div className="relative isolate">
        <div
          ref={scrollRef}
          className={cn(
            "overflow-y-auto overflow-x-hidden",
            compact ? "max-h-[60dvh]" : "max-h-64",
          )}
        >
          <div ref={topSentinelRef} aria-hidden className="h-px w-full" />
          <ul className="flex flex-col">
            {items.map((item) => {
              const active = item.id === activeId;
              const pending = item.id === pendingJumpId;

              return (
                <li key={item.id}>
                  <button
                    ref={(node) => {
                      if (node) itemEls.current.set(item.id, node);
                      else itemEls.current.delete(item.id);
                    }}
                    type="button"
                    aria-current={active ? "location" : undefined}
                    aria-busy={pending}
                    onClick={() => onSelectItem(item.id)}
                    className={cn(
                      "flex w-full cursor-pointer rounded-md px-2 py-1.5 text-left",
                      LIST_HOVER_TRANSITION,
                      active ? "bg-state-hover" : "hover:bg-state-hover",
                    )}
                  >
                    <span
                      className={cn(
                        "text-xs leading-snug",
                        active ? "text-foreground" : "text-muted-foreground",
                        pending && "motion-safe:animate-pulse",
                      )}
                    >
                      <TocItemPreview
                        item={item}
                        senderThreadMetadataById={senderThreadMetadataById}
                      />
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
          <div ref={bottomSentinelRef} aria-hidden className="h-px w-full" />
        </div>
        {aboveOverflow ? (
          <div
            aria-hidden
            className="pointer-events-none absolute inset-x-0 top-0 z-10 h-8 bg-gradient-to-b from-popover/90 via-popover/60 to-transparent"
          />
        ) : null}
        {belowOverflow ? (
          <div
            aria-hidden
            className="pointer-events-none absolute inset-x-0 bottom-0 z-10 h-8 bg-gradient-to-t from-popover/90 via-popover/60 to-transparent"
          />
        ) : null}
      </div>
    </>
  );
}

export function ThreadTableOfContents({
  contextBoundarySeq,
  threadId,
  timelineRows,
  hasOlderTimelineRows,
  loadOlderTimelineRows,
}: ThreadTableOfContentsProps) {
  const resolveMentionLabel = useResolveThreadTitle();
  const bottomAnchor = useBottomAnchoredScroll();
  const [rootElement, setRootElement] = useState<HTMLElement | null>(null);
  const { mode, maxRailItems } = useThreadTocLayout(rootElement);
  const railVisible = mode === "rail";
  const [open, setOpen] = useState(false);
  const [panelWasOpen, setPanelWasOpen] = useState(false);
  const [panelClosing, setPanelClosing] = useState(false);

  if (panelWasOpen !== open) {
    setPanelWasOpen(open);
    setPanelClosing(!open);
  }

  useEffect(() => {
    if (!panelClosing) return;

    const id = window.setTimeout(
      () => setPanelClosing(false),
      MOTION_DURATION_MS.fast + TRANSITION_FALLBACK_SLACK_MS,
    );

    return () => window.clearTimeout(id);
  }, [panelClosing]);

  const [tab, setTab] = useState<TocTab>("user");
  const outlineTriggerRef = useRef<HTMLButtonElement>(null);
  const outlineVisible = railVisible || open;
  const outlineEnabled = outlineVisible && timelineRows.length > 0;

  const userOutlineQuery = useThreadConversationOutline(threadId, "user", {
    enabled: outlineEnabled,
  });

  const agentOutlineQuery = useThreadConversationOutline(
    threadId,
    "assistant",
    { enabled: outlineEnabled && open && tab === "agent" },
  );

  const senderThreadMetadataById = useSenderThreadMetadataById();

  const { agentItems, userItems } = useConversationTocItems({
    agentOutlineItems: currentOutlineItems(
      agentOutlineQuery.data,
      contextBoundarySeq,
    ),
    timelineRows,
    userOutlineItems: currentOutlineItems(
      userOutlineQuery.data,
      contextBoundarySeq,
    ),
  });

  const [activeUserId, setActiveUserId] = useState<string | null>(null);
  const [activeAgentId, setActiveAgentId] = useState<string | null>(null);

  const [activePositionRowId, setActivePositionRowId] = useState<string | null>(
    null,
  );

  const [pendingJumpId, setPendingJumpId] = useState<string | null>(null);

  const activeIdsRef = useRef<ActiveItemIds>({
    agent: null,
    user: null,
    position: null,
  });

  const hasAgentMessages = agentItems.length > 0;
  const activeTab = tab === "agent" && hasAgentMessages ? "agent" : "user";
  const items = activeTab === "user" ? userItems : agentItems;
  const activeId = activeTab === "user" ? activeUserId : activeAgentId;

  const userSectionByRowId = useMemo(() => {
    const userIds = new Set(userItems.map((item) => item.id));
    const firstUserRow = timelineRows.find((row) => userIds.has(row.id));

    const firstUserIndex = firstUserRow
      ? userItems.findIndex((item) => item.id === firstUserRow.id)
      : userItems.length;

    let userId = userItems[firstUserIndex - 1]?.id ?? null;
    const sections = new Map<string, string>();

    for (const row of timelineRows) {
      if (userIds.has(row.id)) userId = row.id;

      if (userId !== null) sections.set(row.id, userId);
    }

    return sections;
  }, [timelineRows, userItems]);

  const positionUserId =
    (activePositionRowId === null
      ? null
      : userSectionByRowId.get(activePositionRowId)) ?? activeUserId;

  const railItems = useMemo(
    () =>
      selectTocRailItems({
        activeId: positionUserId,
        items: userItems,
        maxItems: maxRailItems,
      }),
    [maxRailItems, positionUserId, userItems],
  );

  const hasOlderRef = useRef(hasOlderTimelineRows);
  hasOlderRef.current = hasOlderTimelineRows;
  const loadOlderRef = useRef(loadOlderTimelineRows);
  loadOlderRef.current = loadOlderTimelineRows;
  const jumpInProgressRef = useRef(false);
  const mountedRef = useRef(true);
  const openRequestFrameRef = useRef<number | null>(null);

  const cancelOpenRequest = useCallback(() => {
    if (openRequestFrameRef.current === null) return;
    window.cancelAnimationFrame(openRequestFrameRef.current);
    openRequestFrameRef.current = null;
  }, []);

  useEffect(() => {
    mountedRef.current = true;

    return () => {
      mountedRef.current = false;
      cancelOpenRequest();
    };
  }, [cancelOpenRequest]);

  const hasLoadedItems = userItems.length > 0 || agentItems.length > 0;

  const compact =
    mode === "compact" ||
    (railVisible && userItems.length < TOC_MIN_USER_MESSAGES && hasLoadedItems);

  const panelAvailable = compact
    ? hasLoadedItems || hasOlderTimelineRows
    : railVisible && userItems.length >= TOC_MIN_USER_MESSAGES;

  const pendingOpenRequestRef = useRef(false);

  const startOpenRequest = () => {
    cancelOpenRequest();
    let framesLeft = TOC_OPEN_REQUEST_FRAMES;

    const step = () => {
      framesLeft -= 1;

      if (framesLeft > 0) {
        openRequestFrameRef.current = window.requestAnimationFrame(step);

        return;
      }

      openRequestFrameRef.current = null;
      setOpen(true);
      outlineTriggerRef.current?.focus();
    };

    openRequestFrameRef.current = window.requestAnimationFrame(step);
  };

  useThreadOutlineRequests(threadId, () => {
    if (mode === "measuring") {
      pendingOpenRequestRef.current = true;

      return;
    }

    if (rootElement === null || !isElementRendered(rootElement)) return;
    startOpenRequest();
  });

  useEffect(() => {
    if (!pendingOpenRequestRef.current || mode === "measuring") return;

    if (!panelAvailable) {
      pendingOpenRequestRef.current = false;

      return;
    }

    if (rootElement === null || !isElementRendered(rootElement)) return;
    pendingOpenRequestRef.current = false;
    startOpenRequest();
  });

  useEffect(() => {
    if (!open || compact || !railVisible || rootElement === null) return;

    const closeOnOutsidePointer = (event: PointerEvent) => {
      if (event.target instanceof Node && rootElement.contains(event.target)) {
        return;
      }

      setOpen(false);
    };

    document.addEventListener("pointerdown", closeOnOutsidePointer);

    return () => {
      document.removeEventListener("pointerdown", closeOnOutsidePointer);
    };
  }, [compact, railVisible, open, rootElement]);

  useEffect(() => {
    if (!outlineVisible) return;
    const scrollElement = bottomAnchor?.getScrollElement();

    if (!scrollElement) return;

    const publishActiveItems = (nextActiveIds: ActiveItemIds) => {
      const currentActiveIds = activeIdsRef.current;

      if (nextActiveIds.user !== currentActiveIds.user) {
        setActiveUserId(nextActiveIds.user);
      }

      if (nextActiveIds.agent !== currentActiveIds.agent) {
        setActiveAgentId(nextActiveIds.agent);
      }

      if (nextActiveIds.position !== currentActiveIds.position) {
        setActivePositionRowId(nextActiveIds.position);
      }

      activeIdsRef.current = nextActiveIds;
    };

    const updateActiveItems = () => {
      publishActiveItems(
        findActiveItemIds({ agentItems, scrollElement, userItems }),
      );
    };

    let updateTimeout: number | null = null;

    const scheduleActiveItemsUpdate = () => {
      if (updateTimeout !== null) {
        window.clearTimeout(updateTimeout);
      }

      updateTimeout = window.setTimeout(() => {
        updateTimeout = null;
        updateActiveItems();
      }, TOC_ACTIVE_UPDATE_IDLE_MS);
    };

    scheduleActiveItemsUpdate();
    scrollElement.addEventListener("scroll", scheduleActiveItemsUpdate, {
      passive: true,
    });

    const resizeObserver =
      typeof ResizeObserver === "undefined"
        ? null
        : new ResizeObserver(scheduleActiveItemsUpdate);

    resizeObserver?.observe(scrollElement);

    return () => {
      scrollElement.removeEventListener("scroll", scheduleActiveItemsUpdate);
      resizeObserver?.disconnect();

      if (updateTimeout !== null) {
        window.clearTimeout(updateTimeout);
      }
    };
  }, [agentItems, bottomAnchor, outlineVisible, userItems]);

  const handleSelect = useCallback(
    async (id: string) => {
      const getScrollElement = () => bottomAnchor?.getScrollElement() ?? null;

      const scrollToRow = (element: HTMLElement) => {
        revealTimelineRow(element, bottomAnchor);
      };

      let row = findTimelineRowElement(getScrollElement(), id);

      if (row) {
        scrollToRow(row);

        return;
      }

      if (jumpInProgressRef.current) return;
      jumpInProgressRef.current = true;
      setPendingJumpId(id);

      const waitForRenderedRow = async () => {
        for (let frame = 0; frame < TOC_JUMP_RENDER_FRAMES; frame++) {
          await waitForAnimationFrame();

          if (!mountedRef.current) return null;
          const renderedRow = findTimelineRowElement(getScrollElement(), id);

          if (renderedRow) return renderedRow;
        }

        return null;
      };

      try {
        if (timelineRows.some((timelineRow) => timelineRow.id === id)) {
          row = await waitForRenderedRow();

          if (!mountedRef.current) return;
        }

        let loads = 0;

        while (!row && hasOlderRef.current && loads < TOC_JUMP_MAX_PAGE_LOADS) {
          loads += 1;

          try {
            await Promise.resolve(loadOlderRef.current());
          } catch {
            break;
          }

          if (!mountedRef.current) return;
          row = await waitForRenderedRow();

          if (!mountedRef.current) return;
        }

        if (!row) row = findTimelineRowElement(getScrollElement(), id);

        if (row) scrollToRow(row);
      } finally {
        jumpInProgressRef.current = false;
        setPendingJumpId(null);
      }
    },
    [bottomAnchor, timelineRows],
  );

  if (!panelAvailable) {
    return <span ref={setRootElement} aria-hidden className="hidden" />;
  }

  const panel = (
    <TocPanelContents
      activeId={activeId}
      activeTab={activeTab}
      compact={compact}
      hasAgentMessages={hasAgentMessages}
      items={items}
      open={open}
      pendingJumpId={pendingJumpId}
      senderThreadMetadataById={senderThreadMetadataById}
      onSelectTab={setTab}
      onSelectItem={(id) => {
        if (compact) setOpen(false);
        void handleSelect(id);
      }}
    />
  );

  if (compact) {
    return (
      <div ref={setRootElement} data-thread-toc="compact">
        <ResponsiveDrawerShell
          open={open}
          onOpenChange={setOpen}
          srLabel="Thread table of contents"
        >
          <div className="px-3 pb-3">{panel}</div>
        </ResponsiveDrawerShell>
      </div>
    );
  }

  return (
    <div
      ref={setRootElement}
      data-thread-toc="rail"
      className="group/toc relative w-8"
      onMouseLeave={(event) => {
        if (event.currentTarget.contains(document.activeElement)) return;
        setOpen(false);
      }}
      onBlurCapture={(event) => {
        if (
          !(event.relatedTarget instanceof Node) ||
          !event.currentTarget.contains(event.relatedTarget)
        ) {
          setOpen(false);
        }
      }}
      onKeyDown={(event) => {
        if (event.key !== "Escape" || !open) return;
        event.preventDefault();
        setOpen(false);
        outlineTriggerRef.current?.focus();
      }}
    >
      <div className="relative">
        <nav aria-label="Chat position" className="flex flex-col py-2">
          {railItems.map((item) => {
            const active = item.id === positionUserId;

            return (
              <Tooltip key={item.id} delayDuration={0} disableHoverableContent>
                <TooltipTrigger asChild>
                  <button
                    type="button"
                    aria-label={`Go to message: ${resolveMentionLabel(item.label).slice(0, 160)}`}
                    aria-current={active ? "location" : undefined}
                    aria-busy={item.id === pendingJumpId}
                    onClick={() => {
                      void handleSelect(item.id);
                    }}
                    className={cn(
                      "group/marker flex w-8 shrink-0 cursor-pointer items-center justify-end rounded-md pr-3 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
                      "h-7",
                    )}
                  >
                    <span
                      aria-hidden
                      className={cn(
                        "h-2 w-3 shrink-0 rounded-full transition-colors motion-reduce:transition-none group-hover/marker:bg-foreground/60 group-focus-visible/marker:bg-foreground/60",
                        active ? "bg-foreground" : "bg-foreground/20",
                        item.id === pendingJumpId &&
                          "motion-safe:animate-pulse",
                      )}
                    />
                  </button>
                </TooltipTrigger>
                <TooltipContent
                  side="left"
                  sideOffset={8}
                  className="max-w-72 border border-border bg-popover text-popover-foreground shadow-lg"
                >
                  <TocItemPreview
                    item={item}
                    senderThreadMetadataById={senderThreadMetadataById}
                  />
                </TooltipContent>
              </Tooltip>
            );
          })}
        </nav>
        <button
          ref={outlineTriggerRef}
          type="button"
          aria-label="Thread table of contents"
          aria-expanded={open}
          aria-controls={`thread-toc-panel-${threadId}`}
          onClick={() => setOpen((current) => !current)}
          className={cn(
            "flex h-7 w-8 cursor-pointer items-center justify-center rounded-md text-muted-foreground transition-[color,opacity] hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
            !open && [
              "opacity-0 group-hover/toc:opacity-100 group-focus-within/toc:opacity-100",
              HOVER_REVEAL_NO_HOVER_VISIBLE_CLASS,
            ],
          )}
        >
          <Icon name="MoreHorizontal" className="size-4" aria-hidden />
        </button>

        {open || panelClosing ? (
          <div
            id={`thread-toc-panel-${threadId}`}
            data-state={open ? "open" : "closed"}
            data-side="left"
            className={cn(
              "pointer-events-auto absolute right-full top-0 w-[18.25rem] max-w-[calc(100vw-3rem)] origin-top-right pr-1 data-[state=closed]:pointer-events-none",
              FLOATING_POPOVER_MOTION,
            )}
          >
            <div className="rounded-lg border border-border bg-popover p-1 shadow-lg">
              {panel}
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}
