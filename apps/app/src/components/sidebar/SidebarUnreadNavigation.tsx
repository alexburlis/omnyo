import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type RefObject,
} from "react";
import { Icon } from "@omnyo/shared-ui/icon";
import { cn } from "@omnyo/shared-ui/lib/utils";
import { prefersReducedMotion } from "@omnyo/shared-ui/motion";
import { useAppCommandHandler } from "@/components/commands/AppCommandProvider";

type Direction = "up" | "down";

interface NavigationState {
  up: number | null;
  down: number | null;
}

interface NavigationTarget {
  threadId: string;
  offset: number;
  windowed: boolean;
}

const EMPTY_NAVIGATION: NavigationState = { up: null, down: null };

const UNREAD_PILL_OPEN_CLASS = "visible opacity-100";

const UNREAD_PILL_CLOSED_CLASS = "invisible pointer-events-none opacity-0";

function unreadTarget(
  root: HTMLElement,
  unread: ReadonlySet<string>,
  direction: Direction,
): NavigationTarget | null {
  if (
    unread.size === 0 ||
    (direction === "up"
      ? root.scrollTop <= 1
      : root.scrollTop + root.clientHeight >= root.scrollHeight - 1)
  )
    return null;

  const bounds = root.getBoundingClientRect();
  const top = Math.max(0, bounds.top + root.clientTop);

  const bottom = Math.min(
    window.innerHeight,
    bounds.top + root.clientTop + root.clientHeight,
  );

  const sticky = Array.from(
    root.querySelectorAll<HTMLElement>("[data-sidebar-sticky-tier]"),
  );

  let farthest: NavigationTarget | null = null;

  for (const element of root.querySelectorAll<HTMLElement>(
    "a[data-sidebar-thread-id], [data-sidebar-windowed-nav]",
  )) {
    const id = element.getAttribute("data-sidebar-thread-id");

    const targets =
      id === null
        ? (element.getAttribute("data-sidebar-windowed-nav") ?? "")
            .split(/\s+/u)
            .map((pair) => pair.split(":")[0])
        : [id];

    if (element.closest('[data-sidebar-overflow="true"]')) continue;
    let threadId: string | null = null;

    for (const target of targets) {
      if (!unread.has(target)) continue;
      threadId = target;

      if (direction === "up") break;
    }

    if (threadId === null) continue;

    const row =
      id === null
        ? element
        : (element.closest<HTMLElement>(".omnyo-sidebar-hover-actions-row") ??
          element);

    const rect = row.getBoundingClientRect();

    if (rect.width === 0 || rect.height === 0) continue;

    let readableTop = top;

    for (const header of sticky) {
      if (
        header === row ||
        !header.parentElement?.contains(row) ||
        !(
          header.compareDocumentPosition(row) & Node.DOCUMENT_POSITION_FOLLOWING
        )
      )
        continue;

      const style = getComputedStyle(header);

      if (style.position !== "sticky") continue;
      const headerRect = header.getBoundingClientRect();
      const parsedInset = Number.parseFloat(style.top);
      const inset = Number.isFinite(parsedInset) ? parsedInset : 0;

      if (rect.top < top)
        readableTop = Math.max(readableTop, top + inset + headerRect.height);
      else if (
        headerRect.top >= top &&
        headerRect.top <= top + inset + 1 &&
        headerRect.bottom > rect.top &&
        headerRect.top < rect.bottom
      )
        readableTop = Math.max(readableTop, headerRect.bottom);
    }

    const offset =
      direction === "up" ? readableTop - rect.top : rect.bottom - bottom;

    if (offset > 1 && (farthest === null || offset > farthest.offset))
      farthest = { threadId, offset, windowed: id === null };
  }

  return farthest;
}

export function SidebarUnreadNavigation({
  scrollRef,
  unreadIds,
  enabled,
}: {
  scrollRef: RefObject<HTMLDivElement | null>;
  unreadIds: ReadonlySet<string>;
  enabled: boolean;
}) {
  const unreadRef = useRef(unreadIds);
  const revealRef = useRef<string | null>(null);
  const [navigation, setNavigation] = useState(EMPTY_NAVIGATION);

  const refresh = useCallback(() => {
    const root = scrollRef.current;

    if (root === null) return;

    if (!enabled) {
      revealRef.current = null;
      setNavigation((previous) =>
        previous.up === null && previous.down === null
          ? previous
          : EMPTY_NAVIGATION,
      );

      return;
    }

    const bounds = root.getBoundingClientRect();

    const visible =
      bounds.width > 0 &&
      bounds.height > 0 &&
      bounds.right > 0 &&
      bounds.left < window.innerWidth &&
      bounds.bottom > 0 &&
      bounds.top < window.innerHeight &&
      root.closest('[hidden], [inert], [aria-hidden="true"]') === null;

    const revealId = revealRef.current;

    if (revealId !== null) {
      if (!visible || !unreadRef.current.has(revealId)) {
        revealRef.current = null;
      } else if (
        root.querySelector(
          `a[data-sidebar-thread-id="${CSS.escape(revealId)}"]`,
        ) !== null
      ) {
        revealRef.current = null;
        const targetIds = new Set([revealId]);
        const above = unreadTarget(root, targetIds, "up");
        const below = unreadTarget(root, targetIds, "down");

        if (above !== null || below !== null) {
          root.scrollTo({
            top:
              root.scrollTop +
              (above !== null ? -above.offset - 8 : (below?.offset ?? 0) + 8),
            behavior: "instant",
          });
        }
      }
    }

    const next: NavigationState = visible
      ? {
          up: unreadTarget(root, unreadRef.current, "up")?.offset ?? null,
          down: unreadTarget(root, unreadRef.current, "down")?.offset ?? null,
        }
      : EMPTY_NAVIGATION;

    setNavigation((previous) =>
      previous.up === next.up && previous.down === next.down ? previous : next,
    );
  }, [enabled, scrollRef]);

  useLayoutEffect(() => {
    unreadRef.current = unreadIds;
    refresh();
  }, [refresh, unreadIds]);

  useEffect(() => {
    const root = scrollRef.current;

    if (root === null || !enabled) return;
    let pending = 0;

    const schedule = () => {
      if (pending !== 0) return;
      pending = requestAnimationFrame(() => {
        pending = 0;
        refresh();
      });
    };

    const cancelReveal = () => {
      revealRef.current = null;
    };

    const inputEvents = [
      "wheel",
      "touchstart",
      "pointerdown",
      "keydown",
    ] as const;

    for (const event of inputEvents)
      root.addEventListener(event, cancelReveal, { passive: true });

    const mutations = new MutationObserver(schedule);
    mutations.observe(root, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: [
        "data-sidebar-windowed-nav",
        "data-sidebar-thread-id",
        "aria-expanded",
        "hidden",
        "style",
      ],
    });
    const resize = new ResizeObserver(schedule);
    resize.observe(root);
    root.addEventListener("scroll", schedule, { passive: true });
    window.addEventListener("resize", schedule);
    window.visualViewport?.addEventListener("resize", schedule);
    window.visualViewport?.addEventListener("scroll", schedule);
    schedule();

    return () => {
      if (pending !== 0) cancelAnimationFrame(pending);
      mutations.disconnect();
      resize.disconnect();
      revealRef.current = null;

      for (const event of inputEvents)
        root.removeEventListener(event, cancelReveal);
      root.removeEventListener("scroll", schedule);
      window.removeEventListener("resize", schedule);
      window.visualViewport?.removeEventListener("resize", schedule);
      window.visualViewport?.removeEventListener("scroll", schedule);
    };
  }, [enabled, refresh, scrollRef]);

  const scroll = useCallback(
    (direction: Direction) => {
      const root = scrollRef.current;

      if (root === null || !enabled) return false;
      const target = unreadTarget(root, unreadRef.current, direction);

      if (target === null) return false;
      revealRef.current = target.windowed ? target.threadId : null;
      root.scrollTo({
        top:
          root.scrollTop +
          (direction === "up" ? -target.offset - 8 : target.offset + 8),
        behavior: prefersReducedMotion() ? "instant" : "smooth",
      });
      refresh();

      return true;
    },
    [enabled, refresh, scrollRef],
  );

  useAppCommandHandler(
    "thread.unreadAbove",
    () => scroll("up"),
    0,
    enabled,
    () => navigation.up !== null,
  );
  useAppCommandHandler(
    "thread.unreadBelow",
    () => scroll("down"),
    0,
    enabled,
    () => navigation.down !== null,
  );

  if (!enabled) return null;

  return (["up", "down"] as const).map((direction) => {
    const visible = navigation[direction] !== null;

    return (
      <button
        key={direction}
        type="button"
        data-sidebar-unread-direction={direction}
        data-state={visible ? "open" : "closed"}
        aria-hidden={!visible}
        inert={!visible}
        className={cn(
          "absolute inset-x-2 z-[60] flex h-8 cursor-pointer items-center justify-center rounded-md border border-success/25 bg-sidebar text-success/60 shadow-sm hover:border-success/50 hover:text-success focus-visible:text-success focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sidebar-ring max-md:pointer-coarse:h-10",
          direction === "up" ? "top-1" : "bottom-1",
          visible ? UNREAD_PILL_OPEN_CLASS : UNREAD_PILL_CLOSED_CLASS,
        )}
        aria-label={`Scroll to unread chats ${direction === "up" ? "above" : "below"}`}
        onClick={() => scroll(direction)}
      >
        <Icon
          name={direction === "up" ? "ArrowUp" : "ArrowDown"}
          className="size-4"
        />
      </button>
    );
  });
}
