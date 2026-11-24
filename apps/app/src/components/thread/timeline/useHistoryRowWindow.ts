import { useEffect, useState, type RefObject } from "react";

import type { ThreadTimelineViewRow } from "@omnyo/thread-view";
import { estimateTimelineRowIntrinsicBlockSizePx } from "./timeline-row-containment";

type ObservedHeights = ReadonlyMap<string, number | null>;

const HISTORY_LEADING_ROWS = 6;

const HISTORY_ANCHOR_NEIGHBORS = 3;

export function historyRowSpacerHeight(
  row: ThreadTimelineViewRow,
  index: number,
  firstObservedIndex: number,
  heights: ObservedHeights,
): number | null {
  if (index < HISTORY_LEADING_ROWS) return null;

  if (index < firstObservedIndex - HISTORY_ANCHOR_NEIGHBORS)
    return estimateTimelineRowIntrinsicBlockSizePx(row) ?? 48;

  return heights.get(row.id) ?? null;
}

export function useHistoryRowWindow(
  listRef: RefObject<HTMLDivElement | null>,
  enabled: boolean,
) {
  const [heights, setHeights] = useState<ObservedHeights | null>(null);

  useEffect(() => {
    const list = listRef.current;

    if (!enabled || !list || typeof IntersectionObserver === "undefined") {
      setHeights(null);

      return;
    }

    let active = true;

    const observer = new IntersectionObserver(
      (entries) => {
        if (!active) return;
        const changes = new Map<string, number | null>();

        for (const entry of entries) {
          const row = entry.target;
          const id = row.getAttribute("data-timeline-row-id");

          if (!id) continue;

          if (entry.isIntersecting) {
            changes.set(id, null);
          } else if (
            entry.boundingClientRect.height > 0 &&
            !row.contains(document.activeElement) &&
            !row.querySelector(
              '[aria-expanded="true"], [contenteditable="true"], textarea, video, audio, iframe',
            ) &&
            !window.getSelection()?.containsNode(row, true)
          ) {
            changes.set(id, entry.boundingClientRect.height);
          }
        }

        setHeights((current) => {
          let next: Map<string, number | null> | undefined;

          for (const [id, height] of changes) {
            if (current?.get(id) === height) continue;
            next ??= new Map(current);

            next.set(id, height);
          }

          return next ?? current;
        });
      },
      { root: list.closest(".thread-scrollbar"), rootMargin: "480px 0px" },
    );

    for (const row of list.children) {
      if (row.hasAttribute("data-timeline-row-id")) observer.observe(row);
    }

    const mutations = new MutationObserver((records) => {
      for (const record of records) {
        for (const node of record.removedNodes) {
          if (node instanceof HTMLElement) observer.unobserve(node);
        }

        for (const node of record.addedNodes) {
          if (
            node instanceof HTMLElement &&
            node.hasAttribute("data-timeline-row-id")
          )
            observer.observe(node);
        }
      }
    });

    mutations.observe(list, { childList: true });

    return () => {
      mutations.disconnect();
      active = false;
      observer.disconnect();
    };
  }, [enabled, listRef]);

  return enabled ? heights : null;
}
