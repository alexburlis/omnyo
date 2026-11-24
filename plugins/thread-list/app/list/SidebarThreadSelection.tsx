import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent,
  type ReactNode,
} from "react";
import { atom, createStore, useAtomValue } from "jotai";
import { selectAtom } from "jotai/utils";
import {
  experimental_setChatSelection,
  experimental_useChatSelection,
} from "@omnyo/plugin-sdk/app";
import { SidebarGroupContent } from "../ui/sidebar.js";
import { SIDEBAR_WINDOWED_NAV_ATTRIBUTE } from "./sidebarThreadShortcuts.js";

const THREAD_LINK = "a[data-sidebar-thread-id]";

const THREAD_ROW = "[data-sidebar-selectable-thread]";

const ROW_CONTROL =
  "a, button, input, textarea, select, [role=button], [contenteditable=true]";

const selectedThreadsAtom = atom<ReadonlySet<string> | null>(null);

const SelectionStoreContext = createContext<ReturnType<
  typeof createStore
> | null>(null);

export function useSidebarThreadSelected(threadId: string): boolean {
  const store = useContext(SelectionStoreContext);

  const selectedAtom = useMemo(
    () =>
      selectAtom(
        selectedThreadsAtom,
        (selected) => selected?.has(threadId) ?? false,
      ),
    [threadId],
  );

  return useAtomValue(selectedAtom, store === null ? undefined : { store });
}

function threadLink(root: HTMLElement, target: EventTarget | null) {
  if (!(target instanceof Element) || !root.contains(target)) return null;

  const row = target.closest(THREAD_ROW);
  const control = target.closest(ROW_CONTROL);

  if (
    row === null ||
    (control !== null &&
      control !== row &&
      row.contains(control) &&
      !control.matches(THREAD_LINK))
  )
    return null;

  return row.querySelector<HTMLAnchorElement>(THREAD_LINK);
}

function orderedThreadIds(root: HTMLElement): string[] {
  const ids = new Set<string>();

  for (const row of root.querySelectorAll<HTMLElement>(
    `${THREAD_LINK}, [${SIDEBAR_WINDOWED_NAV_ATTRIBUTE}]`,
  )) {
    if (row.closest('[data-sidebar-overflow="true"]')) continue;

    const id = row.dataset.sidebarThreadId;

    if (id) {
      ids.add(id);
    } else {
      for (const entry of (
        row.getAttribute(SIDEBAR_WINDOWED_NAV_ATTRIBUTE) ?? ""
      ).split(" ")) {
        const [windowedId] = entry.split(":");

        if (windowedId) ids.add(windowedId);
      }
    }
  }

  return [...ids];
}

function rangeSelection(
  order: readonly string[],
  from: string | undefined,
  through: string,
  base: ReadonlySet<string> | null,
) {
  const end = order.indexOf(through);
  const start = from === undefined ? end : order.indexOf(from);
  const selected = new Set(base);

  if (start < 0 || end < 0) {
    selected.add(through);
  } else {
    for (const id of order.slice(
      Math.min(start, end),
      Math.max(start, end) + 1,
    )) {
      selected.add(id);
    }
  }

  return selected;
}

function isSelectionClick(event: MouseEvent): boolean {
  return (
    event.button === 0 &&
    !event.altKey &&
    (event.shiftKey || event.metaKey || event.ctrlKey)
  );
}

function sameIds(left: readonly string[], right: readonly string[]): boolean {
  return (
    left.length === right.length &&
    left.every((id, index) => id === right[index])
  );
}

function displayOrderedSelection(
  root: HTMLElement | null,
  selected: ReadonlySet<string> | null,
): string[] {
  if (selected === null || selected.size === 0) return [];

  const ordered =
    root === null
      ? []
      : orderedThreadIds(root).filter((id) => selected.has(id));

  const placed = new Set(ordered);

  return [...ordered, ...[...selected].filter((id) => !placed.has(id))];
}

function useHostChatSelection(
  store: ReturnType<typeof createStore>,
  root: { readonly current: HTMLElement | null },
) {
  const hostSelection = experimental_useChatSelection();
  const published = useRef(hostSelection);
  const previousHostSelection = useRef(hostSelection);

  useEffect(() => {
    const publish = () => {
      const ids = displayOrderedSelection(
        root.current,
        store.get(selectedThreadsAtom),
      );

      if (sameIds(ids, published.current)) return;

      published.current = ids;
      experimental_setChatSelection(ids);
    };

    publish();
    const unsubscribe = store.sub(selectedThreadsAtom, publish);

    return () => {
      unsubscribe();

      if (published.current.length > 0) {
        published.current = [];
        experimental_setChatSelection([]);
      }
    };
  }, [root, store]);

  useEffect(() => {
    const cleared =
      previousHostSelection.current.length > 0 && hostSelection.length === 0;

    previousHostSelection.current = hostSelection;

    if (cleared && (store.get(selectedThreadsAtom)?.size ?? 0) > 0) {
      store.set(selectedThreadsAtom, null);
    }
  }, [hostSelection, store]);
}

interface RangeDrag {
  pointerId: number;
  start: string;
  order: readonly string[];
  base: ReadonlySet<string> | null;
  last: string;
}

export function SidebarThreadSelection({
  activeThreadId,
  children,
}: {
  activeThreadId?: string;
  children: ReactNode;
}) {
  const [store] = useState(createStore);
  const root = useRef<HTMLDivElement>(null);
  const anchor = useRef<string | undefined>(undefined);
  const drag = useRef<RangeDrag | null>(null);
  const suppressClick = useRef(false);

  useEffect(() => {
    const finishDrag = (event: PointerEvent) => {
      if (drag.current?.pointerId === event.pointerId) drag.current = null;
    };

    const cancelDrag = () => {
      drag.current = null;
      suppressClick.current = false;
    };

    window.addEventListener("pointerup", finishDrag, true);
    window.addEventListener("pointercancel", finishDrag, true);
    window.addEventListener("blur", cancelDrag);

    return () => {
      window.removeEventListener("pointerup", finishDrag, true);
      window.removeEventListener("pointercancel", finishDrag, true);
      window.removeEventListener("blur", cancelDrag);
    };
  }, []);

  useHostChatSelection(store, root);

  return (
    <SelectionStoreContext.Provider value={store}>
      <SidebarGroupContent
        ref={root}
        onPointerDownCapture={(event) => {
          suppressClick.current = false;
          drag.current = null;

          if (event.pointerType === "touch" || !isSelectionClick(event)) return;

          const link = threadLink(event.currentTarget, event.target);
          const id = link?.dataset.sidebarThreadId;

          if (!link || !id) return;

          event.preventDefault();
          event.stopPropagation();
          link.focus({ preventScroll: true });

          if (event.shiftKey) {
            drag.current = {
              pointerId: event.pointerId,
              start: id,
              order: orderedThreadIds(event.currentTarget),
              base:
                event.metaKey || event.ctrlKey
                  ? store.get(selectedThreadsAtom)
                  : null,
              last: id,
            };
          }
        }}
        onPointerMoveCapture={(event) => {
          const currentDrag = drag.current;

          if (
            currentDrag === null ||
            event.pointerId !== currentDrag.pointerId ||
            (event.buttons & 1) === 0
          )
            return;

          const id = threadLink(event.currentTarget, event.target)?.dataset
            .sidebarThreadId;

          if (!id || id === currentDrag.last) return;

          currentDrag.last = id;
          suppressClick.current = true;
          anchor.current = currentDrag.start;
          store.set(
            selectedThreadsAtom,
            rangeSelection(
              currentDrag.order,
              currentDrag.start,
              id,
              currentDrag.base,
            ),
          );
        }}
        onClickCapture={(event) => {
          if (event.detail > 0 && suppressClick.current) {
            suppressClick.current = false;
            event.preventDefault();
            event.stopPropagation();

            return;
          }

          const root = event.currentTarget;
          const id = threadLink(root, event.target)?.dataset.sidebarThreadId;

          if (id === undefined) return;

          if (!isSelectionClick(event)) {
            if (event.button === 0 && !event.altKey) {
              anchor.current = id;
              store.set(selectedThreadsAtom, null);
            }

            return;
          }

          event.preventDefault();
          event.stopPropagation();

          const current = store.get(selectedThreadsAtom);
          const additive = event.metaKey || event.ctrlKey;
          const order = orderedThreadIds(root);

          const start = [anchor.current, activeThreadId].find(
            (candidate) => candidate !== undefined && order.includes(candidate),
          );

          if (event.shiftKey) {
            anchor.current = start ?? id;
            store.set(
              selectedThreadsAtom,
              rangeSelection(order, start, id, additive ? current : null),
            );

            return;
          }

          const selected = new Set(
            current ?? (start === undefined ? [] : [start]),
          );

          if (selected.has(id)) selected.delete(id);
          else selected.add(id);

          anchor.current = id;
          store.set(selectedThreadsAtom, selected);
        }}
        onDoubleClickCapture={(event) => {
          if (
            !isSelectionClick(event) ||
            threadLink(event.currentTarget, event.target) === null
          )
            return;

          event.preventDefault();
          event.stopPropagation();
        }}
        onKeyDownCapture={(event) => {
          const link = threadLink(event.currentTarget, event.target);

          if (link !== event.target) return;

          if (
            event.key === "Escape" &&
            store.get(selectedThreadsAtom) !== null
          ) {
            anchor.current = undefined;
            store.set(selectedThreadsAtom, null);
          } else if (
            (event.metaKey || event.ctrlKey) &&
            !event.shiftKey &&
            !event.altKey &&
            event.key.toLowerCase() === "a"
          ) {
            anchor.current = link.dataset.sidebarThreadId;
            store.set(
              selectedThreadsAtom,
              new Set(orderedThreadIds(event.currentTarget)),
            );
          } else {
            return;
          }

          event.preventDefault();
          event.stopPropagation();
        }}
      >
        {children}
      </SidebarGroupContent>
    </SelectionStoreContext.Provider>
  );
}
