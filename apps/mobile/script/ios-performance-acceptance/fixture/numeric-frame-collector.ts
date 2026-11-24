type Sample = [
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
];

declare global {
  interface Window {
    __omnyoAcceptanceCase?: string;
    __omnyoAcceptanceActionState?: number;
    __omnyoAcceptanceResizeTarget?: number;
    __omnyoAcceptanceThread?: number;
    webkit?: {
      messageHandlers?: {
        metrics?: {
          postMessage: (message: { run: number; samples: Sample[] }) => void;
        };
      };
    };
  }
}

const MAX_SAMPLES = 800;

const MAX_AFTER_TOUCH_MS = 6_000;

const MIN_AFTER_TOUCH_MS = 900;

const QUIET_AFTER_SCROLL_END_MS = 350;

export function installFrameCollector(): void {
  let runId = 0;
  let active = false;
  let startedAt = 0;
  let touchEndedAt: number | null = null;
  let scrollEndAt: number | null = null;
  let lastScrollChangeAt = 0;
  let previousScrollTop = 0;
  let animationFrame = 0;
  let root: HTMLElement | null = null;
  let totalRowsElement: HTMLElement | null = null;
  let rows: HTMLElement[] = [];
  let rowObserver: MutationObserver | null = null;
  let samples: Sample[] = [];

  function onScrollEnd() {
    scrollEndAt = performance.now();
  }

  function onScroll() {
    lastScrollChangeAt = performance.now();
    previousScrollTop = root?.scrollTop ?? previousScrollTop;
    scrollEndAt = null;
  }

  function refreshRows() {
    if (root === null) return;
    rows = Array.from(
      root.querySelectorAll<HTMLElement>("[data-timeline-row-id]"),
    );
    totalRowsElement = root.querySelector<HTMLElement>(
      "[data-fixture-total-rows]",
    );
  }

  function bindRoot(nextRoot: HTMLElement) {
    root?.removeEventListener("scroll", onScroll);
    root?.removeEventListener("scrollend", onScrollEnd);
    rowObserver?.disconnect();
    root = nextRoot;
    previousScrollTop = root.scrollTop;
    lastScrollChangeAt = performance.now();
    scrollEndAt = null;
    refreshRows();
    rowObserver = new MutationObserver(refreshRows);
    rowObserver.observe(root, {
      attributes: true,
      attributeFilter: ["data-fixture-total-rows"],
      childList: true,
      subtree: true,
    });
    root.addEventListener("scroll", onScroll, { passive: true });
    root.addEventListener("scrollend", onScrollEnd);
  }

  const sampleFrame = (now: number) => {
    if (!active) return;

    if (root === null || !root.isConnected) {
      const replacement = document.querySelector<HTMLElement>(
        "[data-page-scroll-viewport]",
      );

      if (replacement) bindRoot(replacement);
    }

    if (root === null) {
      animationFrame = requestAnimationFrame(sampleFrame);

      return;
    }

    const rootRect = root.getBoundingClientRect();
    const scrollTop = root.scrollTop;

    if (Math.abs(scrollTop - previousScrollTop) > 0.25) {
      lastScrollChangeAt = now;
      previousScrollTop = scrollTop;
      scrollEndAt = null;
    }

    let lower = 0;
    let upper = rows.length;

    while (lower < upper) {
      const middle = lower + Math.floor((upper - lower) / 2);
      const row = rows[middle];

      if (row && row.getBoundingClientRect().bottom <= rootRect.top) {
        lower = middle + 1;
      } else {
        upper = middle;
      }
    }

    const firstVisibleIndex = lower;
    lower = firstVisibleIndex;
    upper = rows.length;

    while (lower < upper) {
      const middle = lower + Math.floor((upper - lower) / 2);
      const row = rows[middle];

      if (row && row.getBoundingClientRect().top < rootRect.bottom) {
        lower = middle + 1;
      } else {
        upper = middle;
      }
    }

    const visibleRows = Math.max(0, lower - firstVisibleIndex);
    const visibleRow = rows[firstVisibleIndex];
    const rowRect = visibleRow?.getBoundingClientRect();

    const rowIndex = visibleRow
      ? Number(visibleRow.dataset.acceptanceAnchor)
      : -1;

    const totalRows = Number(totalRowsElement?.dataset.fixtureTotalRows ?? 0);

    const selection = window.getSelection();
    const selectionAnchor = selection?.anchorNode;

    const selectionElement =
      selectionAnchor instanceof Element
        ? selectionAnchor
        : selectionAnchor?.parentElement;

    const selectedRow = selectionElement?.closest<HTMLElement>(
      "[data-acceptance-anchor]",
    );

    const selectedOrdinal =
      selection && !selection.isCollapsed && selectedRow?.isConnected
        ? Number(selectedRow?.dataset.acceptanceAnchor ?? -1)
        : -1;

    const thread = window.__omnyoAcceptanceThread ?? 0;
    const afterTouch = touchEndedAt === null ? 0 : now - touchEndedAt;
    const quietFor = now - Math.max(lastScrollChangeAt, scrollEndAt ?? 0);

    const phase =
      touchEndedAt === null
        ? 0
        : scrollEndAt !== null && quietFor >= QUIET_AFTER_SCROLL_END_MS
          ? 2
          : scrollEndAt === null && quietFor >= QUIET_AFTER_SCROLL_END_MS
            ? 3
            : 1;

    samples.push([
      Math.round((now - startedAt) * 100) / 100,
      Math.round(scrollTop * 100) / 100,
      rows.length,
      Number.isFinite(rowIndex) ? rowIndex : -1,
      rowRect ? Math.round((rootRect.top - rowRect.top) * 100) / 100 : 0,
      thread,
      phase,
      Number.isFinite(totalRows) ? totalRows : 0,
      visibleRows,
      window.__omnyoAcceptanceResizeTarget ?? -1,
      window.__omnyoAcceptanceActionState ?? 0,
      Number.isFinite(selectedOrdinal) ? selectedOrdinal : -1,
    ]);

    if (samples.length >= MAX_SAMPLES) {
      finish();

      return;
    }

    if (
      touchEndedAt !== null &&
      ((phase >= 2 && afterTouch >= MIN_AFTER_TOUCH_MS) ||
        afterTouch >= MAX_AFTER_TOUCH_MS)
    ) {
      finish();

      return;
    }

    animationFrame = requestAnimationFrame(sampleFrame);
  };

  function finish() {
    if (!active) return;
    active = false;
    cancelAnimationFrame(animationFrame);
    root?.removeEventListener("scroll", onScroll);
    root?.removeEventListener("scrollend", onScrollEnd);
    rowObserver?.disconnect();
    rowObserver = null;

    const numericSamples = samples.filter(
      (sample) =>
        sample.length === 12 && sample.every((value) => Number.isFinite(value)),
    );

    window.webkit?.messageHandlers?.metrics?.postMessage({
      run: ++runId,
      samples: numericSamples,
    });
    root = null;
    totalRowsElement = null;
    rows = [];
    samples = [];
  }

  document.addEventListener(
    "touchstart",
    (event) => {
      if (active) return;

      if (
        event.target instanceof Element &&
        event.target.closest("[data-fixture-controls]")
      )
        return;

      const target = document.querySelector<HTMLElement>(
        "[data-page-scroll-viewport]",
      );

      if (
        !target ||
        !(event.target instanceof Node) ||
        !target.contains(event.target)
      )
        return;
      active = true;
      startedAt = performance.now();
      touchEndedAt = null;
      scrollEndAt = null;
      samples = [];
      bindRoot(target);
      animationFrame = requestAnimationFrame(sampleFrame);
    },
    { passive: true, capture: true },
  );

  document.addEventListener(
    "touchend",
    () => {
      if (active && touchEndedAt === null) touchEndedAt = performance.now();
    },
    { passive: true, capture: true },
  );
}
