import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { PointerEvent as ReactPointerEvent, RefObject } from "react";
import type { DropPlace } from "../lib/inbox-order.ts";

const ENGAGE_PX = 6;

const EDGE_PX = 32;

const EDGE_STEP = 8;

const CLICK_GUARD_MS = 300;

const NOT_A_HANDLE = "button, input, textarea, select, [contenteditable]";

export interface ShelfDrop {
  id: string;
  place: DropPlace;
}

export type ShelfRowDrag = "dragged" | DropPlace | null;

export interface ShelfDrag {
  begin: (event: ReactPointerEvent<HTMLElement>) => void;
  stateOf: (id: string) => ShelfRowDrag;
}

export type ShelfDropHandler = (
  list: string,
  movedId: string,
  targetId: string,
  place: DropPlace,
) => void;

function sameDrop(left: ShelfDrop | null, right: ShelfDrop | null): boolean {
  return left?.id === right?.id && left?.place === right?.place;
}

function rowAt(x: number, y: number, list: string): HTMLElement | null {
  const row = document.elementFromPoint(x, y)?.closest<HTMLElement>("[data-shelf-row]") ?? null;

  return row !== null && row.dataset.shelfList === list ? row : null;
}

function swallowNextClick() {
  const swallow = (event: MouseEvent) => {
    event.preventDefault();
    event.stopPropagation();
    window.removeEventListener("click", swallow, true);
  };

  window.addEventListener("click", swallow, true);
  window.setTimeout(() => window.removeEventListener("click", swallow, true), CLICK_GUARD_MS);
}

export function useShelfDrag(
  enabled: boolean,
  scroller: RefObject<HTMLElement | null>,
  onDrop: ShelfDropHandler,
): ShelfDrag {
  const [dragged, setDragged] = useState<string | null>(null);
  const [drop, setDrop] = useState<ShelfDrop | null>(null);
  const latest = useRef({ enabled, onDrop });
  const stop = useRef<(() => void) | null>(null);

  useLayoutEffect(() => {
    latest.current = { enabled, onDrop };
  });

  useEffect(() => () => stop.current?.(), []);

  const begin = useCallback(
    (event: ReactPointerEvent<HTMLElement>) => {
      const row = event.currentTarget;
      const { shelfList: list, shelfRow: id } = row.dataset;
      const handle = event.target instanceof Element ? event.target.closest(NOT_A_HANDLE) : null;

      if (
        !latest.current.enabled ||
        list === undefined ||
        id === undefined ||
        event.button !== 0 ||
        event.pointerType === "touch" ||
        stop.current !== null ||
        (handle !== null && row.contains(handle))
      )
        return;

      const pointerId = event.pointerId;
      const startX = event.clientX;
      const startY = event.clientY;
      let x = startX;
      let y = startY;
      let engaged = false;
      let target: ShelfDrop | null = null;
      let frame = 0;

      const aim = () => {
        const over = rowAt(x, y, list);
        const box = scroller.current?.getBoundingClientRect();

        const inside =
          box !== undefined && x >= box.left && x <= box.right && y >= box.top && y <= box.bottom;

        let next = target;

        if (over !== null) {
          const overId = over.dataset.shelfRow;
          const rect = over.getBoundingClientRect();

          next =
            overId === undefined || overId === id
              ? null
              : { id: overId, place: y < rect.top + rect.height / 2 ? "before" : "after" };
        } else if (!inside) next = null;

        if (sameDrop(next, target)) return;
        target = next;
        setDrop(next);
      };

      const scroll = () => {
        frame = 0;
        const element = scroller.current;

        if (!engaged || element === null) return;
        const box = element.getBoundingClientRect();
        const step = y < box.top + EDGE_PX ? -EDGE_STEP : y > box.bottom - EDGE_PX ? EDGE_STEP : 0;
        const before = element.scrollTop;

        if (step === 0) return;
        element.scrollTop += step;

        if (element.scrollTop === before) return;
        aim();
        frame = requestAnimationFrame(scroll);
      };

      const teardown = () => {
        stop.current = null;
        cancelAnimationFrame(frame);
        window.removeEventListener("pointermove", move);
        window.removeEventListener("pointerup", up);
        window.removeEventListener("pointercancel", teardown);
        window.removeEventListener("blur", teardown);
        window.removeEventListener("keydown", key, true);
        window.removeEventListener("dragstart", noDrag);
        window.removeEventListener("selectstart", noSelect);

        if (engaged) document.body.style.cursor = "";
        setDragged(null);
        setDrop(null);
      };

      const move = (moved: PointerEvent) => {
        if (moved.pointerId !== pointerId) return;
        x = moved.clientX;
        y = moved.clientY;

        if (!engaged) {
          const dx = Math.abs(x - startX);
          const dy = Math.abs(y - startY);

          if (dy < ENGAGE_PX || dy <= dx) return;
          engaged = true;
          window.getSelection()?.removeAllRanges();
          document.body.style.cursor = "grabbing";
          setDragged(id);
        }

        aim();

        if (frame === 0) frame = requestAnimationFrame(scroll);
      };

      const up = (released: PointerEvent) => {
        if (released.pointerId !== pointerId) return;
        const wasEngaged = engaged;
        const dropped = target;
        teardown();

        if (!wasEngaged) return;
        swallowNextClick();

        if (dropped !== null) latest.current.onDrop(list, id, dropped.id, dropped.place);
      };

      const key = (pressed: KeyboardEvent) => {
        if (pressed.key !== "Escape") return;

        if (engaged) pressed.preventDefault();
        teardown();
      };

      const noDrag = (started: DragEvent) => started.preventDefault();

      const noSelect = (started: Event) => {
        if (engaged) started.preventDefault();
      };

      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", up);
      window.addEventListener("pointercancel", teardown);
      window.addEventListener("blur", teardown);
      window.addEventListener("keydown", key, true);
      window.addEventListener("dragstart", noDrag);
      window.addEventListener("selectstart", noSelect);
      stop.current = teardown;
    },
    [scroller],
  );

  const stateOf = useCallback(
    (id: string): ShelfRowDrag =>
      dragged === id ? "dragged" : drop?.id === id ? drop.place : null,
    [dragged, drop],
  );

  return { begin, stateOf };
}
