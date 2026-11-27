import { useEffect, useId, useState, type KeyboardEvent } from "react";
import {
  bentoColumns,
  flowLeaves,
  islandAccents,
  type Board,
  type IslandAccent,
  type IslandGroup,
  type HistorySummary,
  type HistoryEntry,
  type CanvasNode,
} from "../contract";
import type { SourceState } from "../source-contract";
import { islandGroups, updateIsland } from "../lib/composition";
import { Connections } from "./connections";
import { SourcePanel } from "./sources";
import { kindLabels } from "./node";
import type { EditorActions } from "./editor-actions";
import { errorSchema, failureText, FieldValue } from "./editor-value";
import { NodeInspector } from "./node-inspector";

export type { EditorActions } from "./editor-actions";

export type WorkbenchMode = "inspect" | "changes" | "sources";

interface EditorProps {
  threadId: string;
  mode: WorkbenchMode;
  onMode(mode: WorkbenchMode): void;
  onClose(): void;
  board: Board;
  selectedNode: CanvasNode | null;
  selectedIsland?: IslandGroup | null;
  onSelectNode?(id: string): void;
  onMoveIsland?(id: string, offset: { x: number; y: number } | null): void;
  sources: SourceState[];
  history: HistorySummary | null;
  historyError?: string | null;
  busy: boolean;
  actions: EditorActions;
}

const modes = ["inspect", "changes", "sources"] as const;

const names: Record<WorkbenchMode, string> = {
  inspect: "Inspect",
  changes: "Changes",
  sources: "Sources",
};

export function EditorWorkbench({
  threadId,
  mode,
  onMode,
  onClose,
  board,
  selectedNode,
  selectedIsland = null,
  onSelectNode,
  onMoveIsland,
  sources,
  history,
  historyError = null,
  busy,
  actions,
}: EditorProps) {
  const prefix = useId();

  function navigate(event: KeyboardEvent<HTMLButtonElement>, current: number) {
    let index = current;

    if (event.key === "ArrowRight") index = (current + 1) % modes.length;
    else if (event.key === "ArrowLeft") index = (current + modes.length - 1) % modes.length;
    else if (event.key === "Home") index = 0;
    else if (event.key === "End") index = modes.length - 1;
    else return;
    const next = modes[index];

    if (!next) return;
    event.preventDefault();
    onMode(next);
    event.currentTarget.parentElement
      ?.querySelectorAll<HTMLButtonElement>("[role=tab]")
      [index]?.focus();
  }

  return (
    <aside
      className="cnv-workbench"
      data-mode={mode}
      aria-label="Canvas workbench"
      data-thread-id={threadId}
    >
      <div className="cnv-workbench-head">
        <div>
          <h2>
            {mode === "inspect"
              ? (selectedIsland?.island.title ?? selectedNode?.title ?? "Inspect a module")
              : names[mode]}
          </h2>
          {mode === "inspect" && selectedIsland ? <p>Island</p> : null}
          {mode === "inspect" && !selectedIsland && selectedNode ? (
            <p>{kindLabels[selectedNode.kind]}</p>
          ) : null}
        </div>
        <button
          className="cnv-button"
          type="button"
          aria-label="Close Canvas workbench"
          onClick={onClose}
        >
          ×
        </button>
      </div>
      <div className="cnv-workbench-tabs" role="tablist" aria-label="Canvas tools">
        {modes.map((item, index) => (
          <button
            key={item}
            type="button"
            role="tab"
            id={`${prefix}-${item}-tab`}
            aria-controls={`${prefix}-${item}-panel`}
            aria-selected={mode === item}
            tabIndex={mode === item ? 0 : -1}
            onKeyDown={(event) => navigate(event, index)}
            onClick={() => onMode(item)}
          >
            {names[item]}
          </button>
        ))}
      </div>
      <div
        className="cnv-workbench-panel"
        role="tabpanel"
        id={`${prefix}-inspect-panel`}
        aria-labelledby={`${prefix}-inspect-tab`}
        hidden={mode !== "inspect"}
      >
        {selectedIsland && board.composition ? (
          <IslandInspector
            key={selectedIsland.id}
            island={selectedIsland}
            board={board}
            busy={busy}
            actions={actions}
            onSelectNode={onSelectNode}
            onMoveIsland={onMoveIsland}
          />
        ) : selectedNode ? (
          <NodeInspector
            key={selectedNode.id}
            node={selectedNode}
            board={board}
            sources={sources}
            busy={busy}
            actions={actions}
          />
        ) : (
          <p className="cnv-editor-empty">
            Select a module or an island title on the board to inspect or edit it.
          </p>
        )}
        {selectedNode && !selectedIsland ? (
          <Connections board={board} id={selectedNode.id} />
        ) : null}
      </div>
      <div
        className="cnv-workbench-panel"
        role="tabpanel"
        id={`${prefix}-changes-panel`}
        aria-labelledby={`${prefix}-changes-tab`}
        hidden={mode !== "changes"}
      >
        {mode === "changes" ? (
          <Changes
            board={board}
            history={history}
            historyError={historyError}
            busy={busy}
            actions={actions}
          />
        ) : null}
      </div>
      <div
        className="cnv-workbench-panel"
        role="tabpanel"
        id={`${prefix}-sources-panel`}
        aria-labelledby={`${prefix}-sources-tab`}
        hidden={mode !== "sources"}
      >
        <SourcePanel
          sources={sources}
          busy={busy}
          onSave={actions.saveSource}
          onRefresh={actions.refreshSource}
          onPause={actions.pauseSource}
          onPush={actions.pushDataset}
          onAddModule={actions.addModule}
        />
      </div>
    </aside>
  );
}

const accentNames: Record<IslandAccent, string> = {
  neutral: "Neutral",
  blue: "Blue",
  teal: "Teal",
  violet: "Violet",
  rose: "Rose",
  amber: "Amber",
};

function IslandInspector({
  island,
  board,
  busy,
  actions,
  onSelectNode,
  onMoveIsland,
}: {
  island: IslandGroup;
  board: Board;
  busy: boolean;
  actions: EditorActions;
  onSelectNode?(id: string): void;
  onMoveIsland?(id: string, offset: { x: number; y: number } | null): void;
}) {
  const [title, setTitle] = useState(island.island.title);
  const [question, setQuestion] = useState(island.island.question ?? "");
  const [accent, setAccent] = useState<IslandAccent>(island.island.accent ?? "neutral");
  const [surface, setSurface] = useState(island.island.surface ?? "soft");
  const [error, setError] = useState<string | null>(null);
  const [processing, setProcessing] = useState(false);
  const titles = new Map(board.nodes.map((node) => [node.id, node.title ?? node.id]));
  const members = flowLeaves(island).filter((leaf) => titles.has(leaf.node));

  const changed =
    title.trim() !== island.island.title ||
    question.trim() !== (island.island.question ?? "") ||
    accent !== (island.island.accent ?? "neutral") ||
    surface !== (island.island.surface ?? "soft");

  async function save() {
    const composition = board.composition;

    if (!composition) return;
    setError(null);
    setProcessing(true);

    try {
      await actions.compose(
        updateIsland(composition, island.id, {
          title: title.trim(),
          question: question.trim() === "" ? null : question.trim(),
          accent: accent === "neutral" ? null : accent,
          surface: surface === "soft" ? null : surface,
        }),
        `Edit island ${island.island.title}`,
      );
    } catch (failure) {
      setError(failureText(errorSchema.parse(failure)));
    } finally {
      setProcessing(false);
    }
  }

  return (
    <div className="cnv-island-inspector" data-accent={accent}>
      <fieldset className="cnv-editor-section" disabled={busy || processing}>
        <legend>Island</legend>
        <label className="cnv-field">
          Name
          <input
            aria-label="Island name"
            value={title}
            maxLength={60}
            onChange={(event) => setTitle(event.target.value)}
          />
        </label>
        <label className="cnv-field">
          Question it answers
          <input
            value={question}
            maxLength={160}
            placeholder="How do people find us?"
            onChange={(event) => setQuestion(event.target.value)}
          />
        </label>
        <div className="cnv-field">
          <span>Accent</span>
          <div className="cnv-swatches" role="radiogroup" aria-label="Island accent">
            {islandAccents.map((value) => (
              <button
                key={value}
                type="button"
                role="radio"
                className="cnv-swatch"
                data-accent={value}
                aria-checked={accent === value}
                aria-label={accentNames[value]}
                title={accentNames[value]}
                onClick={() => setAccent(value)}
              />
            ))}
          </div>
        </div>
        <div className="cnv-field">
          <span>Surface</span>
          <div className="cnv-segmented" role="radiogroup" aria-label="Island surface">
            {(["soft", "none"] as const).map((value) => (
              <button
                key={value}
                type="button"
                role="radio"
                aria-checked={surface === value}
                onClick={() => setSurface(value)}
              >
                {value === "soft" ? "Soft surface" : "No surface"}
              </button>
            ))}
          </div>
        </div>
        {error ? (
          <p className="cnv-editor-error" role="alert">
            {error}
          </p>
        ) : null}
        <div className="cnv-editor-actions">
          <button
            type="button"
            className="cnv-button"
            data-variant="primary"
            disabled={busy || processing || !changed || title.trim() === ""}
            onClick={() => void save()}
          >
            Apply
          </button>
          {island.island.offset && onMoveIsland ? (
            <button
              type="button"
              className="cnv-button"
              disabled={busy || processing}
              onClick={() => onMoveIsland(island.id, null)}
            >
              Return to flow
            </button>
          ) : null}
        </div>
      </fieldset>
      <section className="cnv-editor-section">
        <h3>
          {island.flow === "bento"
            ? `Bento · ${island.columns ?? bentoColumns} columns`
            : `${island.flow[0]?.toUpperCase() ?? ""}${island.flow.slice(1)} flow`}{" "}
          · {members.length} {members.length === 1 ? "module" : "modules"}
        </h3>
        <ul className="cnv-island-members">
          {members.map((leaf) => (
            <li key={leaf.node}>
              <button type="button" onClick={() => onSelectNode?.(leaf.node)}>
                <span>{titles.get(leaf.node)}</span>
                {leaf.span !== undefined && leaf.span > 1 ? <small>span {leaf.span}</small> : null}
                {leaf.emphasis === "lead" ? <small>lead</small> : null}
              </button>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}

function changeTarget(board: Board, target: string): string {
  const title = (id: string) => board.nodes.find((node) => node.id === id)?.title ?? id;

  if (target.startsWith("node:")) return title(target.slice("node:".length));

  if (target.startsWith("edge:")) {
    const [from = "", to = ""] = target.slice("edge:".length).split(":");

    return `${title(from)} → ${title(to)}`;
  }

  if (target.startsWith("island:")) {
    const id = target.slice("island:".length);

    return (
      (board.composition &&
        islandGroups(board.composition.root).find((island) => island.id === id)?.island.title) ||
      "Island"
    );
  }

  return target === "board" ? "Board" : target;
}

function Changes({
  board,
  history,
  historyError,
  busy,
  actions,
}: {
  board: Board;
  history: HistorySummary | null;
  historyError: string | null;
  busy: boolean;
  actions: EditorActions;
}) {
  const [selected, setSelected] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [processing, setProcessing] = useState(false);

  const entries = [...(history?.entries ?? [])].sort(
    (left, right) => right.lastActivityAt - left.lastActivityAt || right.revision - left.revision,
  );

  const active = selected ?? entries[0]?.id;
  const activeAt = entries.find((entry) => entry.id === active)?.lastActivityAt;
  const [detail, setDetail] = useState<HistoryEntry | null>(null);

  useEffect(() => {
    let live = true;
    setDetail(null);
    setError(null);

    if (!active) return;

    actions.readHistory(active).then(
      (value) => {
        if (live) setDetail(value);
      },
      (reason) => {
        if (live) setError(failureText(errorSchema.parse(reason)));
      },
    );

    return () => {
      live = false;
    };
  }, [active, activeAt, actions.readHistory]);

  async function restore(id: string, action: "undo" | "redo") {
    setError(null);
    setProcessing(true);

    try {
      await actions[action](id);
    } catch (failure) {
      setError(failureText(errorSchema.parse(failure)));
    } finally {
      setProcessing(false);
    }
  }

  return (
    <div>
      {error ? (
        <p className="cnv-editor-error" role="alert">
          {error}
        </p>
      ) : null}
      {historyError ? (
        <div className="cnv-editor-error" role="alert">
          <p>{historyError}</p>
          <button
            type="button"
            className="cnv-button"
            disabled={processing}
            onClick={() => void actions.refreshHistory()}
          >
            Retry
          </button>
        </div>
      ) : null}
      {history === null ? (
        historyError ? null : (
          <p className="cnv-editor-empty" aria-busy="true">
            Loading changes…
          </p>
        )
      ) : entries.length === 0 ? (
        <p className="cnv-editor-empty">No saved changes yet.</p>
      ) : (
        <ol className="cnv-history-list">
          {entries.map((entry) => (
            <li key={entry.id} className="cnv-history-item" data-selected={active === entry.id}>
              <button
                type="button"
                aria-expanded={active === entry.id}
                onClick={() => setSelected(active === entry.id ? "" : entry.id)}
              >
                <strong>{entry.label}</strong>
                <br />
                <small>
                  {entry.lastActor === "human"
                    ? "You"
                    : entry.lastActor === "agent"
                      ? "Agent"
                      : "System"}{" "}
                  ·{" "}
                  {entry.lastAction === "undo"
                    ? "Undone"
                    : entry.lastAction === "redo"
                      ? "Redone"
                      : "Edited"}{" "}
                  ·{" "}
                  <time dateTime={new Date(entry.lastActivityAt).toISOString()}>
                    {new Date(entry.lastActivityAt).toLocaleString()}
                  </time>
                </small>
                {entry.actor !== entry.lastActor ? (
                  <span className="cnv-history-origin">
                    Original change by{" "}
                    {entry.actor === "human"
                      ? "you"
                      : entry.actor === "agent"
                        ? "the agent"
                        : "the system"}
                  </span>
                ) : null}
              </button>
              {active === entry.id ? (
                <>
                  <div className="cnv-change-diff">
                    {detail === null ? <p aria-busy="true">Loading change…</p> : null}
                    {detail?.id === entry.id
                      ? detail.fields.map((field) => (
                          <div key={`${field.target}:${field.field}`}>
                            <strong>
                              {changeTarget(board, field.target)} · {field.field}
                            </strong>
                            <div className="cnv-before">
                              <span className="cnv-diff-label">Before</span>
                              <FieldValue value={field.before} />
                            </div>
                            <div className="cnv-after">
                              <span className="cnv-diff-label">After</span>
                              <FieldValue value={field.after} />
                            </div>
                          </div>
                        ))
                      : null}
                  </div>
                  <div className="cnv-editor-actions">
                    <button
                      type="button"
                      className="cnv-button"
                      disabled={busy || processing}
                      onClick={() =>
                        void restore(entry.id, entry.state === "applied" ? "undo" : "redo")
                      }
                    >
                      {entry.state === "applied" ? "Undo this change" : "Redo this change"}
                    </button>
                  </div>
                </>
              ) : null}
            </li>
          ))}
        </ol>
      )}
      {history !== null && history.entries.length < history.total ? (
        <button
          type="button"
          className="cnv-button"
          disabled={busy || processing}
          onClick={() => void actions.loadHistory()}
        >
          Load older changes
        </button>
      ) : null}
    </div>
  );
}
