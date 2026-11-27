import { useEffect, useRef, type ReactNode } from "react";
import type { Board } from "../contract";
import type { SourceState } from "../source-contract";
import { Outline } from "./outline";
import type { NodeWorkspace } from "./node";

export function ProjectContentsTree({ children }: { children: ReactNode }) {
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const element = root.current;

    if (!element) return;
    const items = Array.from(element.querySelectorAll<HTMLElement>('[role="treeitem"]'));
    const focused = items.find((item) => item === document.activeElement);

    for (const item of items) item.tabIndex = item === (focused ?? items[0]) ? 0 : -1;
  });

  return (
    <div
      ref={root}
      role="tree"
      aria-label="Canvas contents"
      onFocusCapture={(event) => {
        const item = event.target.closest<HTMLElement>('[role="treeitem"]');

        for (const entry of Array.from(
          event.currentTarget.querySelectorAll<HTMLElement>('[role="treeitem"]'),
        ))
          entry.tabIndex = entry === item ? 0 : -1;
      }}
      onKeyDown={(event) => {
        if (!(event.target instanceof HTMLElement) || event.target.closest(".cnv-project-menu"))
          return;
        const item = event.target.closest<HTMLElement>('[role="treeitem"]');

        if (!item) return;

        const items = Array.from(
          event.currentTarget.querySelectorAll<HTMLElement>('[role="treeitem"]'),
        ).filter((entry) => {
          let parent = entry.parentElement;

          while (parent && parent !== event.currentTarget) {
            if (parent instanceof HTMLDetailsElement && !parent.open) return false;
            parent = parent.parentElement;
          }

          return true;
        });

        const index = items.indexOf(item);
        let next: HTMLElement | undefined;

        switch (event.key) {
          case "ArrowDown":
            next = items[Math.min(index + 1, items.length - 1)];
            break;
          case "ArrowUp":
            next = items[Math.max(index - 1, 0)];
            break;
          case "Home":
            next = items[0];
            break;
          case "End":
            next = items.at(-1);
            break;
          case "ArrowRight":
            if (item instanceof HTMLDetailsElement && !item.open) item.open = true;
            else next = item.querySelector<HTMLElement>('[role="treeitem"]') ?? undefined;
            break;
          case "ArrowLeft":
            if (item instanceof HTMLDetailsElement && item.open) item.open = false;
            else next = item.parentElement?.closest<HTMLElement>('[role="treeitem"]') ?? undefined;
            break;
          case "Enter":
          case " ":
            if (event.target !== item) return;

            if (item instanceof HTMLButtonElement) item.click();
            else item.querySelector<HTMLButtonElement>("button")?.click();
            break;
          default:
            return;
        }

        event.preventDefault();
        event.stopPropagation();
        next?.focus();
      }}
    >
      {children}
    </div>
  );
}

export function ProjectOutline({
  board,
  workspace,
  sources,
  anchor,
  selected,
  onSelect,
  children,
}: {
  board: Board;
  workspace: NodeWorkspace;
  sources: readonly SourceState[];
  anchor: { kind: "node" | "island" | "section" | "free" | "chat"; id: string | null; key: string };
  selected: string | null;
  onSelect(id: string | null): void;
  children: ReactNode;
}) {
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const element = root.current;

    if (!element) return;

    const target =
      anchor.kind === "node"
        ? Array.from(element.querySelectorAll<HTMLElement>("[data-node-id]")).find(
            (entry) => entry.dataset.nodeId === anchor.id,
          )
        : anchor.kind === "island"
          ? Array.from(element.querySelectorAll<HTMLElement>(".cnv-outline-island")).find(
              (entry) =>
                entry.querySelector<HTMLElement>("[data-island]")?.dataset.island === anchor.id,
            )
          : element;

    if (target) {
      element.scrollTop += target.getBoundingClientRect().top - element.getBoundingClientRect().top;
    }
  }, [anchor.kind, anchor.id, anchor.key, board.revision]);

  return (
    <div ref={root} className="cnv-project-outline" data-project-section-id={board.threadId}>
      {children}
      <Outline
        board={board}
        baseline={board.seenRevision}
        workspace={workspace}
        sources={sources}
        selected={selected}
        onSelect={onSelect}
        actions={{
          choose: async () => {
            throw new Error("Open a canvas chat to choose an option.");
          },
        }}
      />
    </div>
  );
}
