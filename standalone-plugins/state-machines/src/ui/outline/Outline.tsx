import { experimental_Icon as Icon } from "@omnyo/plugin-sdk/app";
import { type KeyboardEvent, useMemo, useRef, useState } from "react";

import type { GraphDefinition, StateKind } from "../data/contract.js";
import type { LiveOverlay } from "../graph/Canvas.js";
import { findByData } from "../graph/dom.js";
import { edgeLabel, KIND_ICON, KIND_LABEL, STATE_KINDS, stateSubtitle } from "../graph/labels.js";
import { outlineOrder } from "../graph/spatial-nav.js";
import { nodeStatus } from "../graph/status-style.js";
import type { Selection } from "../routes.js";

interface Row {
  key: string;
  level: 1 | 2;
  selection: Exclude<Selection, null>;
}

export function Outline({
  definition,
  label,
  selection,
  onSelect,
  live,
  onAddState,
  onAddTransition,
}: {
  definition: GraphDefinition;
  label: string;
  selection: Selection;
  onSelect(selection: Exclude<Selection, null>): void;
  live?: LiveOverlay;
  onAddState?(kind: StateKind): void;
  onAddTransition?(from: string): void;
}) {
  const order = useMemo(
    () =>
      outlineOrder(
        definition.initialStateId,
        definition.states.map((state) => state.id),
        definition.transitions,
      ),
    [definition.initialStateId, definition.states, definition.transitions],
  );

  const statesById = useMemo(
    () => new Map(definition.states.map((state) => [state.id, state])),
    [definition.states],
  );

  const rows = useMemo<Row[]>(
    () =>
      order.flatMap((id) => [
        { key: `state:${id}`, level: 1 as const, selection: { kind: "state" as const, id } },
        ...definition.transitions
          .filter((edge) => edge.from === id)
          .sort((a, b) => a.priority - b.priority)
          .map((edge) => ({
            key: `tr:${edge.id}`,
            level: 2 as const,
            selection: { kind: "transition" as const, id: edge.id },
          })),
      ]),
    [definition.transitions, order],
  );

  const [focusKey, setFocusKey] = useState<string | null>(null);
  const treeRef = useRef<HTMLUListElement>(null);

  const selectedKey =
    selection === null ? null : `${selection.kind === "state" ? "state" : "tr"}:${selection.id}`;

  const activeKey = focusKey ?? selectedKey ?? rows[0]?.key ?? null;
  const [addOpen, setAddOpen] = useState(false);

  const move = (key: string) => {
    setFocusKey(key);
    requestAnimationFrame(() => findByData(treeRef.current, "rowKey", key)?.focus());
  };

  const onKeyDown = (event: KeyboardEvent<HTMLUListElement>) => {
    const index = rows.findIndex((row) => row.key === activeKey);
    const current = rows[index];

    if (current === undefined) return;

    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();

      const next = rows[index + (event.key === "ArrowDown" ? 1 : -1)];

      if (next !== undefined) move(next.key);
    } else if (event.key === "Home" || event.key === "End") {
      event.preventDefault();

      const next = event.key === "Home" ? rows[0] : rows.at(-1);

      if (next !== undefined) move(next.key);
    } else if (event.key === "ArrowLeft" && current.level === 2) {
      event.preventDefault();

      const parent = rows
        .slice(0, index)
        .reverse()
        .find((row) => row.level === 1);

      if (parent !== undefined) move(parent.key);
    } else if (event.key === "ArrowRight" && current.level === 1) {
      event.preventDefault();

      const child = rows[index + 1];

      if (child?.level === 2) move(child.key);
    } else if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      onSelect(current.selection);
    }
  };

  return (
    <div className="stm-outline">
      <ul
        ref={treeRef}
        role="tree"
        aria-label={`${label} outline`}
        className="stm-outline-tree"
        onKeyDown={onKeyDown}
      >
        {rows.map((row) => {
          const selected = row.key === selectedKey;

          if (row.selection.kind === "state") {
            const state = statesById.get(row.selection.id);

            if (state === undefined) return null;

            const status =
              live === undefined
                ? null
                : nodeStatus(live.instance, state.id, live.now, live.frozen);

            return (
              <li
                key={row.key}
                role="treeitem"
                aria-level={1}
                aria-selected={selected}
                aria-current={status?.isCurrent === true ? "step" : undefined}
                aria-expanded={true}
                data-row-key={row.key}
                tabIndex={row.key === activeKey ? 0 : -1}
                className={`stm-outline-state${status?.isCurrent === true ? ` stm-outline-state--${status.visual}` : ""}${selected ? " stm-outline--selected" : ""}`}
                onClick={() => {
                  setFocusKey(row.key);
                  onSelect(row.selection);
                }}
              >
                <Icon
                  name={KIND_ICON[state.kind]}
                  fallback="Circle"
                  aria-hidden
                  className="stm-outline-glyph"
                />
                <span className="stm-outline-main">
                  <span className="stm-text-strong">
                    {state.title}
                    {definition.initialStateId === state.id ? (
                      <span className="stm-text-muted"> · initial</span>
                    ) : null}
                  </span>
                  <span className="stm-text-muted stm-text-xs">
                    {KIND_LABEL[state.kind]} · {stateSubtitle(state)}
                  </span>
                  {status?.isCurrent === true ? (
                    <span className="stm-outline-meta">{status.meta}</span>
                  ) : null}
                </span>
                {onAddTransition !== undefined && state.kind !== "end" ? (
                  <button
                    type="button"
                    className="stm-tool"
                    aria-label={`Add transition from ${state.title}`}
                    tabIndex={-1}
                    onClick={(event) => {
                      event.stopPropagation();
                      onAddTransition(state.id);
                    }}
                  >
                    <Icon name="ArrowRight" aria-hidden />
                  </button>
                ) : null}
              </li>
            );
          }

          const edge = definition.transitions.find(
            (candidate) => candidate.id === row.selection.id,
          );

          if (edge === undefined) return null;

          const target =
            edge.to === null ? "no target" : (statesById.get(edge.to)?.title ?? edge.to);

          const last = live?.instance.lastTransition?.transitionId === edge.id;

          return (
            <li
              key={row.key}
              role="treeitem"
              aria-level={2}
              aria-selected={selected}
              data-row-key={row.key}
              tabIndex={row.key === activeKey ? 0 : -1}
              className={`stm-outline-transition${selected ? " stm-outline--selected" : ""}${last ? " stm-outline-transition--last" : ""}`}
              onClick={() => {
                setFocusKey(row.key);
                onSelect(row.selection);
              }}
            >
              <span className="stm-text-muted">on</span>{" "}
              <span>{edgeLabel(edge, definition.layout.edgeLabels)}</span>{" "}
              <span className="stm-text-muted">→</span> <span>{target}</span>
              {last ? <span className="stm-text-muted stm-text-xs"> · last taken</span> : null}
            </li>
          );
        })}
      </ul>
      {rows.length === 0 ? <p className="stm-text-muted stm-text-sm">No states yet.</p> : null}
      {onAddState !== undefined ? (
        <div className="stm-menu-anchor">
          <button
            type="button"
            className="stm-button stm-button--secondary"
            aria-haspopup="menu"
            aria-expanded={addOpen}
            onClick={() => setAddOpen((value) => !value)}
          >
            Add state
          </button>
          {addOpen ? (
            <div className="stm-menu" role="menu" aria-label="Add state">
              {STATE_KINDS.map((kind) => (
                <button
                  key={kind}
                  type="button"
                  role="menuitem"
                  className="stm-menu-item"
                  onClick={() => {
                    setAddOpen(false);
                    onAddState(kind);
                  }}
                >
                  <Icon name={KIND_ICON[kind]} fallback="Circle" aria-hidden />
                  <span>{KIND_LABEL[kind]}</span>
                </button>
              ))}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
