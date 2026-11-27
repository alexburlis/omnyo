import type { ChangeSummary, EditorDraft, Problem } from "../data/contract.js";
import type { Selection } from "../routes.js";

export function selectionForProblem(
  problem: Problem,
  draft: EditorDraft,
): Exclude<Selection, null> | null {
  if (problem.stateId !== null) return { kind: "state", id: problem.stateId };

  if (problem.transitionId !== null) return { kind: "transition", id: problem.transitionId };

  const stateMatch = /^\/states\/(\d+)/.exec(problem.path);

  if (stateMatch?.[1] !== undefined) {
    const state = draft.states[Number(stateMatch[1])];

    return state === undefined ? null : { kind: "state", id: state.id };
  }

  const transitionMatch = /^\/transitions\/(\d+)/.exec(problem.path);

  if (transitionMatch?.[1] !== undefined) {
    const edge = draft.transitions[Number(transitionMatch[1])];

    return edge === undefined ? null : { kind: "transition", id: edge.id };
  }

  return null;
}

export function DraftOverview({
  draft,
  problems,
  changeSummary,
  baseVersion,
  onSelect,
}: {
  draft: EditorDraft;
  problems: readonly Problem[];
  changeSummary: ChangeSummary | null;
  baseVersion: number | null;
  onSelect(selection: Exclude<Selection, null>): void;
}) {
  const errors = problems.filter((problem) => problem.severity === "error");
  const others = problems.filter((problem) => problem.severity !== "error");

  return (
    <div className="stm-inspector-content">
      <header className="stm-inspector-header">
        <p className="stm-text-xs stm-text-muted">Draft</p>
        <h2 className="stm-h2">{draft.name}</h2>
      </header>
      <section className="stm-inspector-section" aria-labelledby="stm-draft-howto">
        <h3 id="stm-draft-howto" className="stm-h3">
          How editing works
        </h3>
        <ul className="stm-list stm-text-sm">
          <li>Select a state or arrow to edit it here.</li>
          <li>Add states from the toolbar; drag from a state's edge to connect it.</li>
          <li>Changes save automatically to this draft. Running instances don't change.</li>
          <li>Publish turns the draft into a new version you can start.</li>
        </ul>
      </section>
      <section className="stm-inspector-section">
        <h3 className="stm-h3">Problems</h3>
        {problems.length === 0 ? (
          <p className="stm-text-sm stm-text-muted">
            {draft.states.length === 0 ? "Add a state to begin." : "No problems. Ready to publish."}
          </p>
        ) : null}
        <ul className="stm-problem-list">
          {[...errors, ...others].map((problem) => {
            const target = selectionForProblem(problem, draft);

            return (
              <li
                key={`${problem.code}:${problem.path}`}
                className={`stm-problem stm-problem--${problem.severity}`}
              >
                <button
                  type="button"
                  className="stm-link"
                  disabled={target === null}
                  onClick={() => target !== null && onSelect(target)}
                >
                  {problem.message}
                </button>
                {target === null ? (
                  <span className="stm-text-xs stm-text-muted stm-mono">{problem.path}</span>
                ) : null}
              </li>
            );
          })}
        </ul>
        {errors.length > 0 ? (
          <p className="stm-text-sm">Errors block publishing. Warnings don't.</p>
        ) : null}
      </section>
      <section className="stm-inspector-section">
        <h3 className="stm-h3">
          Changes {baseVersion === null ? "(not published yet)" : `since v${baseVersion}`}
        </h3>
        {changeSummary === null ? (
          <p className="stm-text-sm stm-text-muted">Save to compare.</p>
        ) : (
          <ChangeSummaryList summary={changeSummary} />
        )}
      </section>
    </div>
  );
}

export function ChangeSummaryList({ summary }: { summary: ChangeSummary }) {
  const rows: [string, string[]][] = [
    ["Added states", summary.states.added],
    ["Removed states", summary.states.removed],
    [
      "Changed states",
      summary.states.changed.map((item) => `${item.stateId}: ${item.fields.join(", ")}`),
    ],
    ["Added transitions", summary.transitions.added],
    ["Removed transitions", summary.transitions.removed],
    ["Changed transitions", summary.transitions.changed],
  ];

  const visible = rows.filter(([, items]) => items.length > 0);

  if (visible.length === 0) return <p className="stm-text-sm stm-text-muted">No changes.</p>;

  return (
    <dl className="stm-kv">
      {visible.map(([label, items]) => (
        <div key={label} className="stm-kv-row">
          <dt className="stm-text-muted">{label}</dt>
          <dd>{items.join("; ")}</dd>
        </div>
      ))}
    </dl>
  );
}
