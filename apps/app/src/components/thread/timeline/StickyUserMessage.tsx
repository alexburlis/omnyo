import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import {
  isHumanThreadInput,
  type ThreadTimelineViewRow,
} from "@omnyo/thread-view";
import { useBottomAnchoredScroll } from "@/components/ui/bottom-anchored-scroll-body.js";
import { OverflowFade } from "@/components/ui/overflow-fade.js";
import { Icon } from "@omnyo/shared-ui/icon";
import { cn } from "@omnyo/shared-ui/lib/utils";
import { CompactMessagePreview } from "./CompactMessagePreview.js";
import { useThreadTitleDisplayText } from "../ThreadTitleMentions.js";
import { revealTimelineRow } from "./reveal-timeline-row.js";

const STICKY_USER_MESSAGE_ESTIMATED_HEIGHT_PX = 64;

const STICKY_USER_MESSAGE_USER_SCROLL_MS = 300;

const USER_SCROLL_EVENT_TYPES = [
  "wheel",
  "touchmove",
  "keydown",
  "pointerdown",
] as const;

const OVERFLOW_FADE_MASK_STYLE: CSSProperties = {
  maskImage:
    "linear-gradient(to right, black 55%, transparent), linear-gradient(black, black)",
  maskSize: "100% 1lh, 100% calc(100% - 1lh)",
  maskPosition: "0 100%, 0 0",
  maskRepeat: "no-repeat",
};

export interface StickyUserMessageCandidate {
  id: string;
  label: string;
}

export function buildStickyUserMessageIndex(
  rows: readonly ThreadTimelineViewRow[],
): ReadonlyMap<string, StickyUserMessageCandidate | null> {
  const index = new Map<string, StickyUserMessageCandidate | null>();
  let latestUserMessage: StickyUserMessageCandidate | null = null;

  for (const row of rows) {
    if (
      row.kind === "conversation" &&
      row.role === "user" &&
      isHumanThreadInput(row)
    ) {
      latestUserMessage = { id: row.id, label: toStickyLabel(row) };
      index.set(row.id, null);
      continue;
    }

    index.set(row.id, latestUserMessage);
  }

  return index;
}

function toStickyLabel(
  row: Extract<ThreadTimelineViewRow, { kind: "conversation" }>,
): string {
  const label = row.text.replace(/\s+/g, " ").trim();

  return label || "Sent attachments";
}

function findTopLevelRowElements(list: HTMLElement): HTMLElement[] {
  return Array.from(
    list.querySelectorAll<HTMLElement>("[data-timeline-row-id]"),
  ).filter((row) => row.closest("[data-timeline-row-list]") === list);
}

export function findRowCrossingTop(
  rows: readonly HTMLElement[],
  viewportTop: number,
): string | null {
  let low = 0;
  let high = rows.length - 1;
  let crossing: HTMLElement | null = null;

  while (low <= high) {
    const middle = low + Math.floor((high - low) / 2);
    const row = rows[middle];

    if (!row) break;

    if (row.getBoundingClientRect().bottom <= viewportTop) {
      low = middle + 1;
    } else {
      crossing = row;
      high = middle - 1;
    }
  }

  return crossing?.dataset.timelineRowId ?? null;
}

export function StickyUserMessage({
  rows,
}: {
  rows: readonly ThreadTimelineViewRow[];
}) {
  const bottomAnchor = useBottomAnchoredScroll();
  const anchorRef = useRef<HTMLDivElement>(null);
  const textRef = useRef<HTMLSpanElement>(null);
  const stripRef = useRef<HTMLDivElement>(null);
  const stripHeightRef = useRef(STICKY_USER_MESSAGE_ESTIMATED_HEIGHT_PX);
  const index = useMemo(() => buildStickyUserMessageIndex(rows), [rows]);

  const rowOrder = useMemo(
    () => new Map(Array.from(index.keys(), (id, position) => [id, position])),
    [index],
  );

  const [current, setCurrent] = useState<StickyUserMessageCandidate | null>(
    null,
  );

  const currentRef = useRef(current);

  const [overflowing, setOverflowing] = useState(false);

  const [lastShown, setLastShown] = useState<StickyUserMessageCandidate | null>(
    null,
  );

  if (current !== null && current !== lastShown) setLastShown(current);

  const userScrolledAtRef = useRef(Number.NEGATIVE_INFINITY);
  const [stripMoves, setStripMoves] = useState(false);

  const [animatedLabel, setAnimatedLabel] = useState<{
    id: string;
    earlier: boolean;
  } | null>(null);

  useLayoutEffect(
    () => () => {
      userScrolledAtRef.current = Number.NEGATIVE_INFINITY;
      setStripMoves(false);
      setAnimatedLabel(null);
    },
    [],
  );

  const getList = useCallback((): HTMLElement | null => {
    const sibling = anchorRef.current?.nextElementSibling;

    return sibling instanceof HTMLElement &&
      sibling.dataset.timelineRowList === "top-level"
      ? sibling
      : null;
  }, []);

  useEffect(() => {
    const scrollElement = bottomAnchor?.getScrollElement();

    if (!scrollElement) return;
    let frame: number | null = null;

    const update = () => {
      frame = null;
      const list = getList();

      if (
        !list ||
        (typeof scrollElement.checkVisibility === "function" &&
          !scrollElement.checkVisibility({ visibilityProperty: true }))
      ) {
        return;
      }

      const stripHeight = stripRef.current?.offsetHeight;

      if (stripHeight) stripHeightRef.current = stripHeight;

      const viewportTop =
        scrollElement.getBoundingClientRect().top + stripHeightRef.current;

      const topRowId =
        bottomAnchor?.isAtBottom !== true
          ? findRowCrossingTop(findTopLevelRowElements(list), viewportTop)
          : null;

      const next = topRowId === null ? null : (index.get(topRowId) ?? null);
      const previous = currentRef.current;

      if (previous?.id === next?.id && previous?.label === next?.label) return;

      const userScrolled =
        performance.now() - userScrolledAtRef.current <=
        STICKY_USER_MESSAGE_USER_SCROLL_MS;

      const earlier =
        previous !== null &&
        next !== null &&
        (rowOrder.get(next.id) ?? 0) < (rowOrder.get(previous.id) ?? 0);

      currentRef.current = next;
      setStripMoves(userScrolled);

      setAnimatedLabel(
        userScrolled && next !== null ? { id: next.id, earlier } : null,
      );
      setCurrent(next);
    };

    const schedule = () => {
      if (frame === null) frame = window.requestAnimationFrame(update);
    };

    const markUserScroll = () => {
      userScrolledAtRef.current = performance.now();
    };

    const handleScroll = () => {
      if (
        performance.now() - userScrolledAtRef.current <=
        STICKY_USER_MESSAGE_USER_SCROLL_MS
      ) {
        markUserScroll();
      }

      schedule();
    };

    schedule();
    scrollElement.addEventListener("scroll", handleScroll, { passive: true });

    for (const type of USER_SCROLL_EVENT_TYPES) {
      scrollElement.addEventListener(type, markUserScroll, { passive: true });
    }

    const resizeObserver =
      typeof ResizeObserver === "undefined"
        ? null
        : new ResizeObserver(schedule);

    resizeObserver?.observe(scrollElement);

    return () => {
      scrollElement.removeEventListener("scroll", handleScroll);

      for (const type of USER_SCROLL_EVENT_TYPES) {
        scrollElement.removeEventListener(type, markUserScroll);
      }

      resizeObserver?.disconnect();

      if (frame !== null) window.cancelAnimationFrame(frame);
    };
  }, [bottomAnchor, getList, index, rowOrder]);

  useLayoutEffect(() => {
    const text = textRef.current;

    setOverflowing(text !== null && text.scrollHeight > text.clientHeight + 1);
  }, [current?.label, lastShown?.label]);

  const reveal = useCallback(
    (rowId: string) => {
      const row =
        getList()?.querySelector<HTMLElement>(
          `[data-timeline-row-id="${CSS.escape(rowId)}"]`,
        ) ?? null;

      if (!row) return;
      userScrolledAtRef.current = performance.now();
      revealTimelineRow(row, bottomAnchor);
    },
    [bottomAnchor, getList],
  );

  const shown = current ?? lastShown;
  const accessibleLabel = useThreadTitleDisplayText(shown?.label ?? "");
  const shownRow = rows.find((row) => row.id === shown?.id);

  return (
    <div
      ref={anchorRef}
      data-sticky-user-message=""
      data-state={current ? "open" : "closed"}
      className="pointer-events-none sticky top-0 z-20 h-0 [overflow-anchor:none]"
    >
      {shown ? (
        <div
          ref={stripRef}
          aria-hidden={current ? undefined : true}
          inert={current ? undefined : true}
          className={cn(
            "relative -mx-4 bg-background px-4 pb-1 pt-2",
            !stripMoves && "transition-none",
            stripMoves &&
              current &&
              "transition-[opacity,translate] duration-(--motion-duration-base) ease-out motion-reduce:transition-[opacity] motion-reduce:translate-y-0",
            stripMoves &&
              !current &&
              "transition-[opacity,translate] duration-(--motion-duration-fast) ease-(--motion-ease-standard) motion-reduce:transition-[opacity] motion-reduce:translate-y-0",
            current ? "translate-y-0 opacity-100" : "-translate-y-2 opacity-0",
          )}
        >
          <button
            type="button"
            aria-label={`Jump to your message: ${accessibleLabel}`}
            onClick={() => reveal(shown.id)}
            className={cn(
              "group/sticky flex w-full cursor-pointer items-start gap-3 rounded-xl border border-border-seam bg-surface-recessed-solid px-3.5 py-2.5 text-left shadow-[0_8px_20px_-12px_var(--shadow-color)] transition-colors hover:border-border focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
              current && "pointer-events-auto",
            )}
          >
            <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-background text-muted-foreground">
              <Icon name="UserRound" className="size-3.5" aria-hidden="true" />
            </span>
            <span
              key={shown.id}
              ref={textRef}
              data-sticky-user-text=""
              className={cn(
                "block min-w-0 max-h-[2lh] flex-1 overflow-hidden break-words text-sm leading-relaxed text-foreground",
                animatedLabel?.id === shown.id &&
                  (animatedLabel.earlier
                    ? "animate-in fade-in-0 slide-in-from-top-1 duration-(--motion-duration-base) ease-out"
                    : "animate-in fade-in-0 slide-in-from-bottom-1 duration-(--motion-duration-base) ease-out"),
              )}
              style={overflowing ? OVERFLOW_FADE_MASK_STYLE : undefined}
            >
              <CompactMessagePreview
                text={
                  shownRow?.kind === "conversation"
                    ? shownRow.text
                    : shown.label
                }
                mentions={
                  shownRow?.kind === "conversation" && shownRow.role === "user"
                    ? shownRow.mentions
                    : undefined
                }
              />
            </span>
            <span className="mt-0.5 flex shrink-0 items-center gap-1 text-xs text-muted-foreground opacity-0 transition-opacity group-hover/sticky:opacity-100 group-focus-visible/sticky:opacity-100">
              Jump
              <Icon name="ArrowUp" className="size-3.5" aria-hidden="true" />
            </span>
          </button>
          <OverflowFade placement="below" tone="background" />
        </div>
      ) : null}
    </div>
  );
}
