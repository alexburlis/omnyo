import { useEffect, useMemo, useState } from "react";
import { useAtomValue } from "jotai";
import type { SidebarThread } from "../model/sidebar-thread.js";
import type { ThreadComparator } from "../model/project-thread-groups.js";
import {
  createThreadUnreadPredicate,
  groupComparatorByReadStatus,
  type HeldReadStatus,
} from "../model/read-status-grouping.js";
import { sidebarGroupByReadStatusAtom } from "../preferences/atoms.js";

interface ReadStatusHold {
  threadId: string;
  heldUnread: boolean | null;
  observedUnread: boolean;
  observedAttentionAt: number;
}

let lastReadStatusHold: ReadStatusHold | null = null;

function nextReadStatusHold(
  hold: ReadStatusHold | null,
  thread: SidebarThread,
): ReadStatusHold {
  if (hold?.threadId !== thread.id) {
    return {
      threadId: thread.id,
      heldUnread: thread.isUnread,
      observedUnread: thread.isUnread,
      observedAttentionAt: thread.latestAttentionAt,
    };
  }

  if (
    hold.observedUnread === thread.isUnread &&
    hold.observedAttentionAt === thread.latestAttentionAt
  ) {
    return hold;
  }

  const hasNewAttention = hold.observedAttentionAt !== thread.latestAttentionAt;
  const markedUnread = !hold.observedUnread && thread.isUnread;

  return {
    threadId: thread.id,
    heldUnread: hasNewAttention
      ? (hold.heldUnread ?? hold.observedUnread)
      : markedUnread
        ? null
        : hold.heldUnread,
    observedUnread: thread.isUnread,
    observedAttentionAt: thread.latestAttentionAt,
  };
}

export function useHeldReadStatus(
  threads: readonly SidebarThread[],
  selectedThreadId: string | undefined,
): HeldReadStatus | null {
  const [hold, setHold] = useState<ReadStatusHold | null>(() =>
    lastReadStatusHold?.threadId === selectedThreadId
      ? lastReadStatusHold
      : null,
  );

  useEffect(() => {
    lastReadStatusHold = hold;
  }, [hold]);

  const thread =
    selectedThreadId === undefined
      ? undefined
      : threads.find((candidate) => candidate.id === selectedThreadId);

  const next = thread
    ? nextReadStatusHold(hold, thread)
    : hold?.threadId === selectedThreadId
      ? hold
      : null;

  if (next !== hold) {
    setHold(next);
  }

  const heldThreadId = next?.threadId ?? null;
  const heldUnread = next?.heldUnread ?? null;

  return useMemo(
    () =>
      heldThreadId === null || heldUnread === null
        ? null
        : { threadId: heldThreadId, isUnread: heldUnread },
    [heldThreadId, heldUnread],
  );
}

export function useReadStatusGrouping({
  threads,
  selectedThreadId,
  comparator,
}: {
  threads: readonly SidebarThread[];
  selectedThreadId: string | undefined;
  comparator: ThreadComparator;
}) {
  const groupByReadStatus = useAtomValue(sidebarGroupByReadStatusAtom);
  const heldReadStatus = useHeldReadStatus(threads, selectedThreadId);

  const groupedComparator = useMemo(
    () =>
      groupByReadStatus
        ? groupComparatorByReadStatus(
            comparator,
            createThreadUnreadPredicate(heldReadStatus),
          )
        : comparator,
    [comparator, groupByReadStatus, heldReadStatus],
  );

  return { comparator: groupedComparator };
}
