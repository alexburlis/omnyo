import { useEffect, type RefObject } from "react";
import { useRpc } from "@omnyo/plugin-sdk/app";
import type { rpcContract } from "./contract.ts";
import type { LayoutTrace } from "./diagnostics-contract.ts";

const STORAGE_KEY = "chat-topics:layout-diagnostics:v1";

const SAMPLE_INTERVAL = 250;

const SEND_INTERVAL = 5000;

const ROW_SELECTOR = "[data-chat-motion-key]";

function rounded(value: number) {
  return Number.isFinite(value) ? Math.max(-1e7, Math.min(1e7, Math.round(value * 10) / 10)) : 0;
}

function vector(value: string): [number, number] {
  const numbers = value.split(/\s+/u).map(Number.parseFloat);

  return [rounded(numbers[0] ?? 0), rounded(numbers[1] ?? 0)];
}

function matrix(value: string): [number, number, number, number, number, number] {
  const parsed = new DOMMatrixReadOnly(value === "none" ? undefined : value);

  return [
    rounded(parsed.a),
    rounded(parsed.b),
    rounded(parsed.c),
    rounded(parsed.d),
    rounded(parsed.e),
    rounded(parsed.f),
  ];
}

export function useListDiagnostics(list: RefObject<HTMLElement | null>) {
  const rpc = useRpc<typeof rpcContract>();

  useEffect(() => {
    const element = list.current;

    if (element === null) return;

    try {
      const previous = localStorage.getItem(STORAGE_KEY);

      if (previous !== null) localStorage.setItem(`${STORAGE_KEY}:previous`, previous);
    } catch {
      console.warn("Chat Topics previous layout diagnostics could not be retained.");
    }

    const startedAt = Date.now();
    const userAgent = navigator.userAgent;

    const trace: LayoutTrace = {
      v: 1,
      session: crypto.randomUUID(),
      asset: import.meta.url.match(/plugin-app-assets\/([a-f0-9]+)\//u)?.[1] ?? null,
      platform: /Electron\//u.test(userAgent) ? "electron" : "browser",
      chromeVersion: userAgent.match(/Chrome\/([\d.]+)/u)?.[1] ?? null,
      electronVersion: userAgent.match(/Electron\/([\d.]+)/u)?.[1] ?? null,
      startedAt,
      samples: [],
    };

    const ids = new WeakMap<HTMLElement, number>();
    let nextId = 1;
    let hovered: Element | null = null;
    let lastSample = Number.NEGATIVE_INFINITY;
    let sampleTimer: ReturnType<typeof setTimeout> | undefined;
    let sendTimer: ReturnType<typeof setTimeout> | undefined;

    let pending: {
      reason: LayoutTrace["samples"][number]["reason"];
      target: Element | null;
    } | null = null;

    let lastSend = Number.NEGATIVE_INFINITY;
    let sending = false;
    let warned = false;
    let dirty = false;
    let closed = false;

    const warn = () => {
      if (warned) return;
      warned = true;
      console.warn("Chat Topics layout diagnostics could not be retained or uploaded.");
    };

    const id = (row: Element | null): number | null => {
      if (!(row instanceof HTMLElement)) return null;
      const key = row;
      const found = ids.get(key);

      if (found !== undefined) return found;

      const value = nextId++;
      ids.set(key, value);

      return value;
    };

    const rowOf = (target: EventTarget | null) =>
      target instanceof Element ? target.closest(ROW_SELECTOR) : null;

    const save = () => {
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(trace));
      } catch {
        warn();
      }
    };

    const send = () => {
      sendTimer = undefined;

      if (!dirty || sending || trace.samples.length === 0) return;
      const wait = SEND_INTERVAL - (performance.now() - lastSend);

      if (wait > 0 && !closed) {
        sendTimer = setTimeout(send, wait);

        return;
      }

      if (wait > 0) return;
      dirty = false;
      sending = true;
      lastSend = performance.now();
      const batch = { ...trace, samples: [...trace.samples] };
      void rpc.call("diagnostics.record", { trace: batch }).then(
        () => {
          sending = false;

          if (dirty && !closed) sendTimer = setTimeout(send, SEND_INTERVAL);
        },
        () => {
          sending = false;
          dirty = true;
          warn();
        },
      );
    };

    const capture = () => {
      sampleTimer = undefined;
      const event = pending;
      pending = null;

      if (event === null) return;
      lastSample = performance.now();
      const target = id(event.target);
      const viewport = element.getBoundingClientRect();
      const root = element.querySelector(".ctf, .ct-space");
      const rootRect = root?.getBoundingClientRect();
      const toolbarRect = element.querySelector(".ct-toolbar")?.getBoundingClientRect();
      const rows = Array.from(element.querySelectorAll<HTMLElement>(ROW_SELECTOR));
      const hoveredIndex = rows.findIndex((row) => row === event.target);

      const selected = new Set(
        rows
          .filter((row) => {
            const rect = row.getBoundingClientRect();

            return rect.bottom > viewport.top && rect.top < viewport.bottom;
          })
          .slice(0, 6),
      );

      if (hoveredIndex >= 0)
        for (const row of rows.slice(Math.max(0, hoveredIndex - 2), hoveredIndex + 4))
          selected.add(row);
      const selectedRows = Array.from(selected).slice(0, 12);
      const point = event.target?.getBoundingClientRect();

      const hit =
        point === undefined
          ? null
          : rowOf(
              document.elementFromPoint(point.left + point.width / 2, point.top + point.height / 2),
            );

      trace.samples.push({
        at: rounded(performance.now()),
        reason: event.reason,
        visibility: document.visibilityState === "hidden" ? "hidden" : "visible",
        target,
        hit: id(hit),
        scrollTop: rounded(element.scrollTop),
        list: { width: rounded(viewport.width), height: rounded(viewport.height) },
        root:
          rootRect === undefined
            ? null
            : { top: rounded(rootRect.top - viewport.top), height: rounded(rootRect.height) },
        toolbar:
          toolbarRect === undefined
            ? null
            : { top: rounded(toolbarRect.top - viewport.top), height: rounded(toolbarRect.height) },
        rows: selectedRows.flatMap((row) => {
          const rowId = id(row);

          if (rowId === null) return [];
          const rect = row.getBoundingClientRect();
          const style = getComputedStyle(row);

          return [
            {
              id: rowId,
              top: rounded(rect.top - viewport.top),
              left: rounded(rect.left - viewport.left),
              width: rounded(rect.width),
              height: rounded(rect.height),
              offsetTop: rounded(row.offsetTop),
              translate: vector(style.translate),
              transform: matrix(style.transform),
              animations: row
                .getAnimations()
                .slice(0, 3)
                .map((animation) => ({
                  state: animation.playState,
                  time:
                    animation.currentTime === null ||
                    !Number.isFinite(Number(animation.currentTime))
                      ? null
                      : rounded(Number(animation.currentTime)),
                })),
            },
          ];
        }),
      });

      if (trace.samples.length > 40) trace.samples.shift();
      dirty = true;
      save();

      if (sendTimer === undefined && !closed) sendTimer = setTimeout(send, SEND_INTERVAL);
    };

    const queue = (reason: LayoutTrace["samples"][number]["reason"], target = hovered) => {
      pending = { reason, target };

      if (sampleTimer === undefined)
        sampleTimer = setTimeout(
          capture,
          Math.max(0, SAMPLE_INTERVAL - (performance.now() - lastSample)),
        );
    };

    const over = (event: PointerEvent) => {
      if (event.pointerType !== "mouse") return;
      const next = rowOf(event.target);

      if (next === hovered) return;
      hovered = next;
      queue("hover", next);
    };

    const leave = () => {
      queue("leave");
      hovered = null;
    };

    const scroll = () => queue("scroll");
    const observer = new MutationObserver(() => queue("mutation"));
    observer.observe(element, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ["style", "class", "data-state"],
    });
    element.addEventListener("pointerover", over, { passive: true });
    element.addEventListener("pointerleave", leave, { passive: true });
    element.addEventListener("scroll", scroll, { passive: true });

    return () => {
      closed = true;
      observer.disconnect();
      element.removeEventListener("pointerover", over);
      element.removeEventListener("pointerleave", leave);
      element.removeEventListener("scroll", scroll);
      clearTimeout(sampleTimer);
      clearTimeout(sendTimer);
      pending = { reason: "unmount", target: hovered };
      capture();
      send();
    };
  }, [list, rpc]);
}
