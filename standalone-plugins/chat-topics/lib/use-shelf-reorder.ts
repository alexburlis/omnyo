import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useSdk } from "@omnyo/plugin-sdk/app";
import type { GroupThread } from "./grouping.ts";
import type { DropPlace } from "./inbox-order.ts";
import {
  heldShelfOrder,
  liveShelfOrder,
  shelfMove,
  type ShelfHold,
  type ShelfSlot,
} from "./shelf-order.ts";

const NO_IDS: readonly string[] = [];

export interface ShelfReorder {
  order: readonly string[] | null;
  busy: boolean;
  failed: boolean;
  move: (slots: readonly ShelfSlot[], movedId: string, targetId: string, place: DropPlace) => void;
}

export function useShelfReorder(threads: readonly GroupThread[]): ShelfReorder {
  const sdk = useSdk();
  const [hold, setHold] = useState<ShelfHold | null>(null);
  const [failed, setFailed] = useState(false);

  const live = useMemo(
    () => (hold === null ? NO_IDS : liveShelfOrder(threads, hold.order)),
    [threads, hold],
  );

  const order = heldShelfOrder(hold, live);
  const latest = useRef(live);

  useLayoutEffect(() => {
    latest.current = live;
  });

  useEffect(() => {
    if (hold !== null && hold.settled !== null && order === null) setHold(null);
  }, [hold, order]);

  const busy = hold !== null && hold.settled === null;

  const move = useCallback(
    (slots: readonly ShelfSlot[], movedId: string, targetId: string, place: DropPlace) => {
      const request = shelfMove(slots, movedId, targetId, place);

      if (request === null) return;
      const placed: ShelfHold = { order: request.order, settled: null };
      setFailed(false);
      setHold(placed);

      void sdk.threads
        .experimental_reorderShelved({
          threadId: request.threadId,
          previousThreadId: request.previousThreadId,
          nextThreadId: request.nextThreadId,
        })
        .then(
          () =>
            setHold((current) =>
              current === placed ? { ...placed, settled: latest.current } : current,
            ),
          () => {
            setHold((current) => (current === placed ? null : current));
            setFailed(true);
          },
        );
    },
    [sdk],
  );

  return { order, busy, failed, move };
}
