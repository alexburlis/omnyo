import {
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
  type MouseEvent,
  useSyncExternalStore,
  type ComponentPropsWithRef,
  type RefObject,
} from "react";
import {
  experimental_setChatSelection,
  experimental_useChatSelection,
} from "@omnyo/plugin-sdk/app";
import { adoptsHostClear, orderedSelection, sameSelection } from "../lib/selection-sync.ts";

const THREAD_LINK = "a[data-chat-selection-id]";

const THREAD_ROW = ".ct-row, .ctf-row, .ctf-kid-row";

const ROW_CONTROL = "a, button, input, textarea, select, [role=button], [contenteditable]";

function createSelectionStore() {
  let selected: ReadonlySet<string> | null = null;
  const listeners = new Set<() => void>();

  return {
    get: () => selected,
    set: (next: ReadonlySet<string> | null) => {
      if (next === selected) return;
      selected = next;

      for (const listener of listeners) listener();
    },
    subscribe: (listener: () => void) => {
      listeners.add(listener);

      return () => {
        listeners.delete(listener);
      };
    },
  };
}

const SelectionContext = createContext(createSelectionStore());

export function useChatSelected(id: string): boolean {
  const store = useContext(SelectionContext);

  return useSyncExternalStore(store.subscribe, () => store.get()?.has(id) ?? false);
}

function threadLink(root: HTMLElement, target: EventTarget | null) {
  if (!(target instanceof Element) || !root.contains(target)) return null;

  const row = target.closest(THREAD_ROW);
  const control = target.closest(ROW_CONTROL);

  if (
    row === null ||
    (control !== null && control !== row && row.contains(control) && !control.matches(THREAD_LINK))
  )
    return null;

  const link = row.querySelector<HTMLAnchorElement>(THREAD_LINK);

  return link?.closest(THREAD_ROW) === row ? link : null;
}

function displayedIds(root: HTMLElement): string[] {
  const ids = new Set<string>();

  for (const link of Array.from(root.querySelectorAll<HTMLElement>(THREAD_LINK))) {
    const id = link.dataset.chatSelectionId;

    if (id) ids.add(id);
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
    for (const id of order.slice(Math.min(start, end), Math.max(start, end) + 1)) {
      selected.add(id);
    }
  }

  return selected;
}

type SelectionStore = ReturnType<typeof createSelectionStore>;

function useHostSelection(
  store: SelectionStore,
  root: RefObject<HTMLDivElement | null>,
  visibleOrder: readonly string[] | null,
) {
  const host = experimental_useChatSelection();
  const selected = useSyncExternalStore(store.subscribe, store.get);
  const published = useRef<readonly string[]>([]);
  const previousHost = useRef(host);

  useEffect(() => {
    const before = previousHost.current;
    previousHost.current = host;

    if (!adoptsHostClear(before, host, published.current)) return;
    published.current = [];
    store.set(null);
  }, [host, store]);

  useEffect(() => {
    const element = root.current;
    const order = visibleOrder ?? (element === null ? [] : displayedIds(element));
    const ids = orderedSelection(store.get(), order);

    if (sameSelection(ids, published.current)) return;
    published.current = ids;
    experimental_setChatSelection(ids);
  }, [selected, visibleOrder, root, store]);

  useEffect(
    () => () => {
      if (published.current.length === 0) return;
      published.current = [];
      experimental_setChatSelection([]);
    },
    [],
  );
}

function isSelectionClick(event: MouseEvent): boolean {
  return event.button === 0 && !event.altKey && (event.shiftKey || event.metaKey || event.ctrlKey);
}

interface RangeDrag {
  pointerId: number;
  start: string;
  order: readonly string[];
  base: ReadonlySet<string> | null;
  last: string;
}

export function ChatSelection({
  activeThreadId,
  visibleOrder,
  scope,
  ref,
  ...props
}: Omit<ComponentPropsWithRef<"div">, "ref"> & {
  ref: RefObject<HTMLDivElement | null>;
  activeThreadId: string | null;
  scope: string;
  visibleOrder: readonly string[] | null;
}) {
  const [store] = useState(createSelectionStore);
  const anchor = useRef<string | undefined>(undefined);
  const drag = useRef<RangeDrag | null>(null);
  const suppressClick = useRef(false);

  useHostSelection(store, ref, visibleOrder);

  useEffect(() => {
    anchor.current = undefined;
    drag.current = null;
    suppressClick.current = false;
    store.set(null);
  }, [scope, store]);

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

  return (
    <SelectionContext.Provider value={store}>
      <div
        {...props}
        ref={ref}
        onPointerDownCapture={(event) => {
          suppressClick.current = false;
          drag.current = null;

          if (event.pointerType === "touch" || !isSelectionClick(event)) return;

          const link = threadLink(event.currentTarget, event.target);
          const id = link?.dataset.chatSelectionId;

          if (!link || !id) return;

          event.preventDefault();
          event.stopPropagation();
          link.focus({ preventScroll: true });

          if (event.shiftKey) {
            drag.current = {
              pointerId: event.pointerId,
              start: id,
              order: visibleOrder ?? displayedIds(event.currentTarget),
              base: event.metaKey || event.ctrlKey ? store.get() : null,
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

          const id = threadLink(event.currentTarget, event.target)?.dataset.chatSelectionId;

          if (!id || id === currentDrag.last) return;

          currentDrag.last = id;
          suppressClick.current = true;
          anchor.current = currentDrag.start;
          store.set(rangeSelection(currentDrag.order, currentDrag.start, id, currentDrag.base));
        }}
        onClickCapture={(event) => {
          if (event.detail > 0 && suppressClick.current) {
            suppressClick.current = false;
            event.preventDefault();
            event.stopPropagation();

            return;
          }

          const root = event.currentTarget;
          const id = threadLink(root, event.target)?.dataset.chatSelectionId;

          if (id === undefined) return;

          if (!isSelectionClick(event)) {
            if (event.button === 0 && !event.altKey) {
              anchor.current = id;
              store.set(null);
            }

            return;
          }

          event.preventDefault();
          event.stopPropagation();

          const current = store.get();
          const additive = event.metaKey || event.ctrlKey;
          const order = visibleOrder ?? displayedIds(root);

          const start = [anchor.current, activeThreadId ?? undefined].find(
            (candidate) => candidate !== undefined && order.includes(candidate),
          );

          if (event.shiftKey) {
            anchor.current = start ?? id;
            store.set(rangeSelection(order, start, id, additive ? current : null));

            return;
          }

          const selected = new Set(current ?? (start === undefined ? [] : [start]));

          if (selected.has(id)) selected.delete(id);
          else selected.add(id);

          anchor.current = id;
          store.set(selected);
        }}
        onDoubleClickCapture={(event) => {
          if (!isSelectionClick(event) || threadLink(event.currentTarget, event.target) === null)
            return;

          event.preventDefault();
          event.stopPropagation();
        }}
        onKeyDownCapture={(event) => {
          const link = threadLink(event.currentTarget, event.target);

          if (link !== event.target) return;

          if (event.key === "Escape" && store.get() !== null) {
            anchor.current = undefined;
            store.set(null);
          } else if (
            (event.metaKey || event.ctrlKey) &&
            !event.shiftKey &&
            !event.altKey &&
            event.key.toLowerCase() === "a"
          ) {
            anchor.current = link.dataset.chatSelectionId;
            store.set(new Set(visibleOrder ?? displayedIds(event.currentTarget)));
          } else {
            return;
          }

          event.preventDefault();
          event.stopPropagation();
        }}
      />
    </SelectionContext.Provider>
  );
}
