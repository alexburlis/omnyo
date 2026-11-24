import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import type { RefObject } from "react";
import {
  BottomAnchoredScrollBody,
  useBottomAnchoredScroll,
} from "../../../../app/src/components/ui/bottom-anchored-scroll-body.js";

type FixtureRow = {
  id: string;
  ordinal: number;
  kind: "text" | "image" | "diff";
  text: string;
};

declare global {
  interface Window {
    __omnyoAcceptanceCase?: string;
    __omnyoAcceptanceActionState?: number;
    __omnyoAcceptanceResizeTarget?: number;
    __omnyoAcceptanceThread?: number;
  }
}

const ROW_COUNT = 500;

const FOCUS_ROW = 421;

const SELECTION_ROW = FOCUS_ROW;

function makeRow(thread: string, ordinal: number): FixtureRow {
  const kind =
    ordinal % 5 === 0 ? "image" : ordinal % 7 === 0 ? "diff" : "text";

  const proseRepeatCount = 1 + Math.abs(ordinal % 4);

  const text =
    kind === "diff"
      ? `+ changed synthetic line ${ordinal}\n  stable context ${ordinal}\n- prior synthetic line ${ordinal}`
      : `Thread ${thread} synthetic row ${ordinal}. ${"Mixed-height touch scrolling sample with deterministic local prose. ".repeat(proseRepeatCount)}`;

  return { id: `${thread}-${ordinal}`, ordinal, kind, text };
}

function makeRows(thread: string): FixtureRow[] {
  return Array.from({ length: ROW_COUNT }, (_, index) =>
    makeRow(thread, index),
  );
}

function GoToBottomButton() {
  const scroll = useBottomAnchoredScroll();

  return (
    <button type="button" onClick={() => scroll?.scrollToBottom()}>
      Go to bottom
    </button>
  );
}

function FixtureRows({
  thread,
  rows,
  resizeTargetOrdinal,
  focusRef,
}: {
  thread: string;
  rows: FixtureRow[];
  resizeTargetOrdinal: number | null;
  focusRef: RefObject<HTMLButtonElement | null>;
}) {
  return (
    <div
      data-timeline-row-list="top-level"
      data-fixture-total-rows={rows.length}
      style={{ display: "flex", flexDirection: "column", gap: 8 }}
    >
      {rows.map((row) => {
        const focused = row.ordinal === FOCUS_ROW;
        const selected = row.ordinal === SELECTION_ROW;

        return (
          <article
            key={row.id}
            data-timeline-row-id={row.id}
            data-acceptance-anchor={row.ordinal}
            aria-label={`thread ${thread} row ${row.ordinal}`}
            role="article"
          >
            <p>{row.text}</p>
            {row.kind === "image" ? (
              <div
                data-fixture-image=""
                aria-label={`synthetic image row ${row.ordinal}`}
                style={{
                  height: row.ordinal === resizeTargetOrdinal ? 232 : 96,
                }}
              />
            ) : null}
            {row.kind === "diff" ? (
              <pre data-fixture-diff="">{row.text}</pre>
            ) : null}
            {focused ? (
              <button
                ref={focusRef}
                type="button"
                aria-label={`focus target ${thread}`}
              >
                Focus target
              </button>
            ) : null}
            {selected ? (
              <p data-fixture-selectable-prose="">
                {`Selectable prose ${thread} row ${row.ordinal}: ${row.text}`}
              </p>
            ) : null}
          </article>
        );
      })}
    </div>
  );
}

function WindowingFixtureBody({ thread }: { thread: string }) {
  const [rowsByThread, setRowsByThread] = useState(
    () => new Map<string, FixtureRow[]>([[thread, makeRows(thread)]]),
  );

  const [resizeTargetsByThread, setResizeTargetsByThread] = useState(
    () => new Map<string, number | null>([[thread, null]]),
  );

  const activeThreadRef = useRef(thread);
  const rows = rowsByThread.get(thread) ?? makeRows(thread);
  const resizeTargetOrdinal = resizeTargetsByThread.get(thread) ?? null;
  const focusRef = useRef<HTMLButtonElement>(null);

  useLayoutEffect(() => {
    activeThreadRef.current = thread;
    window.__omnyoAcceptanceResizeTarget =
      resizeTargetsByThread.get(thread) ?? -1;
  }, [resizeTargetsByThread, rowsByThread, thread]);

  const updateRows = useCallback(
    (update: (current: FixtureRow[]) => FixtureRow[]) => {
      setRowsByThread((current) => {
        const nextRows = update(current.get(thread) ?? makeRows(thread));

        return new Map(current).set(thread, nextRows);
      });
    },
    [thread],
  );

  const scrollToInteractionRow = useCallback(() => {
    const root = document.querySelector<HTMLElement>(
      "[data-page-scroll-viewport]",
    );

    if (!root) return;
    root.scrollTop =
      (root.scrollHeight - root.clientHeight) * (FOCUS_ROW / ROW_COUNT);
  }, []);

  const focusInteractionRow = useCallback(() => {
    scrollToInteractionRow();

    let remainingFrames = 6;

    const focusWhenMounted = () => {
      const target = focusRef.current;

      if (target) {
        target.focus();

        return;
      }

      if (remainingFrames <= 0) return;
      remainingFrames -= 1;
      window.requestAnimationFrame(focusWhenMounted);
    };

    window.requestAnimationFrame(focusWhenMounted);
  }, [scrollToInteractionRow]);

  const prepend = useCallback(() => {
    updateRows((current) => [
      ...Array.from({ length: 12 }, (_, index) => makeRow(thread, -index - 1)),
      ...current,
    ]);
  }, [thread, updateRows]);

  const resize = useCallback(() => {
    if (activeThreadRef.current !== thread) return;

    const root = document.querySelector<HTMLElement>(
      "[data-page-scroll-viewport]",
    );

    if (!root) return;
    const rootTop = root.getBoundingClientRect().top;

    const images = Array.from(
      root.querySelectorAll<HTMLElement>("[data-fixture-image]"),
    );

    const aboveViewport = images
      .filter((image) => image.getBoundingClientRect().bottom <= rootTop)
      .sort(
        (left, right) =>
          right.getBoundingClientRect().bottom -
          left.getBoundingClientRect().bottom,
      );

    const target = aboveViewport[0]?.parentElement;
    const ordinal = Number(target?.dataset.acceptanceAnchor);

    if (target && Number.isFinite(ordinal)) {
      setResizeTargetsByThread((current) =>
        new Map(current).set(thread, ordinal),
      );
      window.__omnyoAcceptanceResizeTarget = ordinal;
    }
  }, [thread]);

  const append = useCallback(() => {
    updateRows((current) => [
      ...current,
      makeRow(thread, ROW_COUNT + current.length - ROW_COUNT),
    ]);
  }, [thread, updateRows]);

  useEffect(() => {
    const onTouchEnd = (event: TouchEvent) => {
      const target = event.target;

      const scrollRoot = document.querySelector("[data-page-scroll-viewport]");
      const testCase = window.__omnyoAcceptanceCase;

      if (!testCase) {
        window.__omnyoAcceptanceActionState = 1;

        return;
      }

      if (
        !scrollRoot ||
        !(target instanceof Node) ||
        !scrollRoot.contains(target)
      ) {
        window.__omnyoAcceptanceActionState = 2;

        return;
      }

      if (
        target instanceof Element &&
        target.closest("[data-fixture-controls]") !== null
      ) {
        window.__omnyoAcceptanceActionState = 3;

        return;
      }

      window.__omnyoAcceptanceCase = undefined;

      if (testCase === "mutations") {
        window.__omnyoAcceptanceActionState = 4;
        window.setTimeout(prepend, 120);
        window.setTimeout(resize, 240);
        window.setTimeout(append, 390);
      }

      if (testCase === "switch") {
        window.__omnyoAcceptanceActionState = 5;
        window.setTimeout(prepend, 80);
        window.setTimeout(resize, 120);
        window.setTimeout(() => {
          window.dispatchEvent(
            new CustomEvent("omnyo-acceptance-switch-thread"),
          );
        }, 150);
      }
    };

    document.addEventListener("touchend", onTouchEnd, {
      capture: true,
      passive: true,
    });

    return () =>
      document.removeEventListener("touchend", onTouchEnd, { capture: true });
  }, [append, prepend, resize, thread]);

  return (
    <BottomAnchoredScrollBody
      footer={
        <div data-fixture-controls="" aria-label="Timeline fixture controls">
          <GoToBottomButton />
          <button type="button" onClick={prepend}>
            Prepend older rows
          </button>
          <button type="button" onClick={resize}>
            Resize synthetic image
          </button>
          <button type="button" onClick={append}>
            Append synthetic row
          </button>
          <button type="button" onClick={focusInteractionRow}>
            Focus target
          </button>
          <button type="button" onClick={scrollToInteractionRow}>
            Go to selectable prose
          </button>
          <button
            type="button"
            onClick={() => {
              window.__omnyoAcceptanceCase = "mutations";
            }}
          >
            Queue mutations after flick
          </button>
          <button
            type="button"
            onClick={() => {
              window.__omnyoAcceptanceCase = "switch";
            }}
          >
            Queue thread switch after flick
          </button>
          <button
            type="button"
            aria-label={`switch thread from ${thread}`}
            onClick={() =>
              window.dispatchEvent(
                new CustomEvent("omnyo-acceptance-switch-thread"),
              )
            }
          >
            Switch thread
          </button>
        </div>
      }
      maxWidthClassName="fixture-width"
    >
      <FixtureRows
        thread={thread}
        rows={rows}
        resizeTargetOrdinal={resizeTargetOrdinal}
        focusRef={focusRef}
      />
    </BottomAnchoredScrollBody>
  );
}

export function AcceptanceFixture() {
  const [thread, setThread] = useState("A");
  const nextThreadRef = useRef(0);
  useEffect(() => {
    const switchThread = () => {
      const next = nextThreadRef.current === 0 ? "B" : "A";
      nextThreadRef.current = next === "A" ? 0 : 1;
      setThread(next);
    };

    window.addEventListener("omnyo-acceptance-switch-thread", switchThread);

    return () =>
      window.removeEventListener(
        "omnyo-acceptance-switch-thread",
        switchThread,
      );
  }, []);
  useLayoutEffect(() => {
    window.__omnyoAcceptanceThread = thread === "A" ? 0 : 1;
  }, [thread]);

  return (
    <main className="fixture-shell" aria-label="Timeline windowing fixture">
      <div className="fixture-title">Synthetic thread {thread}</div>
      <WindowingFixtureBody thread={thread} />
      <div data-metrics-sentinel="" aria-label="Numeric frame capture" />
    </main>
  );
}
