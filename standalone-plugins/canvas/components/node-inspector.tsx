import { useEffect, useRef, useState } from "react";
import { z } from "zod";
import {
  bentoColumns,
  compositionSchema,
  nodeFieldsSchema,
  nodeTones,
  type Board,
  type CanvasNode,
  type Composition,
  type NodeFields,
  type NodeInspection,
} from "../contract";
import {
  changeFlow,
  draftChanged,
  draftFields,
  draftFor,
  evidenceFor,
  mergeDraft,
  selectedFlow,
  type NodeDraft,
} from "../lib/editor";
import { nodeBindingSchema, type SourceState } from "../source-contract";
import type { RenderVerification } from "../workspace-contract";
import type { EditorActions } from "./editor-actions";
import { errorSchema, failureText, FieldValue } from "./editor-value";

export function NodeInspector({
  node,
  board,
  sources,
  busy,
  actions,
}: {
  node: CanvasNode;
  board: Board;
  sources: SourceState[];
  busy: boolean;
  actions: EditorActions;
}) {
  const [base, setBase] = useState<NodeInspection | null>(null);
  const [draft, setDraft] = useState<NodeDraft | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [processing, setProcessing] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [reviewed, setReviewed] = useState(false);

  const [verification, setVerification] = useState<{
    scope: string;
    value: RenderVerification;
  } | null>(null);

  const disabled = busy || processing;
  const dirty = base !== null && draft !== null && draftChanged(base.node, draft);
  const current = useRef({ base, dirty, nodeRevision: node.updatedRevision });
  current.current = { base, dirty, nodeRevision: node.updatedRevision };
  const inspectionRequest = useRef(0);
  const inspect = useRef(actions.inspect);
  inspect.current = actions.inspect;

  const boundSource = sources.find(
    (entry) => entry.source.definition.id === node.binding?.sourceId,
  );

  const verificationScope = JSON.stringify([
    board.revision,
    node.updatedRevision,
    node.binding ?? null,
    boundSource?.dataset?.revision ?? null,
    boundSource?.source.status ?? null,
    boundSource?.source.error ?? null,
    boundSource?.source.definition ?? null,
  ]);

  const verificationRequest = useRef({ scope: verificationScope });

  if (verificationRequest.current.scope !== verificationScope)
    verificationRequest.current = { scope: verificationScope };

  useEffect(() => setVerification(null), [verificationScope]);
  useEffect(() => {
    if (dirty || (base !== null && base.node.updatedRevision >= node.updatedRevision)) return;
    let live = true;
    const request = ++inspectionRequest.current;
    inspect.current(node.id).then(
      (result) => {
        if (
          !live ||
          request !== inspectionRequest.current ||
          current.current.dirty ||
          result.node.updatedRevision < current.current.nodeRevision ||
          (current.current.base?.node.updatedRevision ?? 0) > result.node.updatedRevision
        )
          return;
        setBase(result);
        setDraft(draftFor(result.node));
        setReviewed(false);
        setError(null);
      },
      (failure) => {
        if (live && request === inspectionRequest.current)
          setError(failureText(errorSchema.parse(failure)));
      },
    );

    return () => {
      live = false;
    };
  }, [node.id, node.updatedRevision, dirty]);

  function update<Key extends keyof NodeDraft>(key: Key, value: NodeDraft[Key]) {
    setDraft((current) => (current === null ? null : { ...current, [key]: value }));
  }

  async function perform(action: () => Promise<void>) {
    setError(null);
    setProcessing(true);

    try {
      await action();
    } catch (failure) {
      setError(failureText(errorSchema.parse(failure)));
    } finally {
      setProcessing(false);
    }
  }

  async function reviewLatest(discard = false) {
    const request = ++inspectionRequest.current;
    const latest = await actions.inspect(node.id);

    if (request !== inspectionRequest.current) return;

    if (latest.node.updatedRevision < current.current.nodeRevision)
      throw new Error("The module changed while loading. Review latest again.");
    setDraft((current) =>
      discard || current === null || base === null
        ? draftFor(latest.node)
        : mergeDraft(base.node, current, latest.node),
    );
    setBase(latest);
    setReviewed(!discard);
    setError(null);
    setVerification(null);
  }

  async function apply(fields?: NodeFields) {
    if (!base || !draft) return;
    const changes = fields ?? draftFields(base.node, draft, sources);

    if (!Object.keys(changes).length) return;

    const expectedVersions = Object.fromEntries(
      Object.keys(changes).map((field) => [field, base.fieldVersions[field] ?? 0]),
    );

    inspectionRequest.current += 1;
    await actions.edit({
      id: node.id,
      fields: changes,
      expectedVersions,
      label: `Edit ${base.node.title ?? node.id}`,
    });

    try {
      const request = ++inspectionRequest.current;
      const latest = await actions.inspect(node.id);

      if (request !== inspectionRequest.current) return;

      if (latest.node.updatedRevision < current.current.nodeRevision)
        throw new Error("The saved module changed again.");
      setBase(latest);
      setDraft(fields ? mergeDraft(base.node, draft, latest.node) : draftFor(latest.node));
      setReviewed(false);
      setVerification(null);
    } catch {
      throw new Error("Change saved. Review latest to reload the editor.");
    }
  }

  if (!base || !draft)
    return (
      <div className="cnv-editor-form">
        {error ? (
          <p className="cnv-editor-error" role="alert">
            {error}
          </p>
        ) : (
          <p className="cnv-muted" aria-busy="true">
            Loading module…
          </p>
        )}
        <button
          type="button"
          className="cnv-button"
          disabled={disabled || error === null}
          onClick={() => void perform(() => reviewLatest(true))}
        >
          Review latest
        </button>
      </div>
    );

  const bindingColumns =
    sources.find((entry) => entry.source.definition.id === draft.bindingSource)?.dataset?.columns ??
    [];

  let currentFields: NodeFields = {};

  try {
    currentFields = draftFields(base.node, draft, sources);
  } catch {
    currentFields = {};
  }

  const evidenceIds = [
    ...new Set([...sources.map((entry) => entry.source.definition.id), ...draft.evidenceSources]),
  ];

  return (
    <form
      className="cnv-editor-form"
      onSubmit={(event) => {
        event.preventDefault();

        if (!disabled && dirty)
          void perform(async () => {
            setSubmitting(true);

            try {
              await apply();
            } finally {
              setSubmitting(false);
            }
          });
      }}
    >
      {node.updatedRevision > base.node.updatedRevision ? (
        <p className="cnv-editor-notice">Newer changes are available. Your draft is kept.</p>
      ) : null}
      {error ? (
        <p className="cnv-editor-error" role="alert">
          {error}
        </p>
      ) : null}
      <div className="cnv-editor-actions">
        <button
          type="button"
          className="cnv-button"
          disabled={disabled}
          onClick={() => void perform(() => reviewLatest())}
        >
          Review latest
        </button>
        {dirty ? (
          <button
            type="button"
            className="cnv-button"
            disabled={disabled}
            onClick={() => void perform(() => reviewLatest(true))}
          >
            Discard draft
          </button>
        ) : null}
      </div>
      {reviewed && dirty ? (
        <div className="cnv-change-diff" aria-label="Current values and your draft">
          <p className="cnv-muted">Your draft is kept. Review these values before applying.</p>
          {Object.entries(currentFields).map(([field, value]) => (
            <div key={field}>
              <strong>{field}</strong>
              <div className="cnv-before">
                <span className="cnv-diff-label">Current</span>
                <FieldValue value={base.node[nodeFieldsSchema.keyof().parse(field)]} />
              </div>
              <div className="cnv-after">
                <span className="cnv-diff-label">Your draft</span>
                <FieldValue value={value} />
              </div>
            </div>
          ))}
        </div>
      ) : null}
      <fieldset className="cnv-editor-fields" disabled={disabled}>
        <label className="cnv-field">
          Title
          <input
            aria-label="Title"
            maxLength={120}
            value={draft.title}
            onChange={(event) => update("title", event.target.value)}
          />
        </label>
        <label className="cnv-field">
          Notes
          <textarea
            aria-label="Notes"
            rows={3}
            value={draft.body}
            onChange={(event) => update("body", event.target.value)}
          />
        </label>
        <div className="cnv-field-row">
          <label className="cnv-field">
            Tone
            <select
              aria-label="Tone"
              value={draft.tone}
              onChange={(event) => update("tone", z.enum(nodeTones).parse(event.target.value))}
            >
              {nodeTones.map((tone) => (
                <option key={tone} value={tone}>
                  {tone[0]?.toUpperCase()}
                  {tone.slice(1)}
                </option>
              ))}
            </select>
          </label>
          <label className="cnv-field">
            Width
            <input
              aria-label="Width"
              type="number"
              min={240}
              max={1600}
              placeholder="Flow width"
              value={draft.width}
              onChange={(event) => update("width", event.target.value)}
            />
            <small>Blank uses the flow width.</small>
          </label>
        </div>
        {node.kind === "link" || node.kind === "file" ? (
          <label className="cnv-field">
            Link or file path
            <input
              aria-label="Link or file path"
              value={draft.href}
              onChange={(event) => update("href", event.target.value)}
            />
          </label>
        ) : null}
        <fieldset className="cnv-editor-section">
          <legend>Connected data</legend>
          <label className="cnv-field">
            Source
            <select
              aria-label="Connected source"
              value={draft.bindingSource}
              onChange={(event) => update("bindingSource", event.target.value)}
            >
              <option value="">No data binding</option>
              {sources.map((entry) => (
                <option key={entry.source.definition.id} value={entry.source.definition.id}>
                  {entry.source.definition.title}
                </option>
              ))}
              {draft.bindingSource &&
              !sources.some((entry) => entry.source.definition.id === draft.bindingSource) ? (
                <option value={draft.bindingSource}>{draft.bindingSource} · unavailable</option>
              ) : null}
            </select>
          </label>
          {draft.bindingSource ? (
            <>
              <div className="cnv-field-row">
                <label className="cnv-field">
                  View
                  <select
                    aria-label="Data view"
                    value={draft.bindingView}
                    onChange={(event) =>
                      update("bindingView", nodeBindingSchema.shape.view.parse(event.target.value))
                    }
                  >
                    {["metric", "bar", "line", "table", "html"].map((value) => (
                      <option key={value} value={value}>
                        {value}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="cnv-field">
                  Format
                  <select
                    aria-label="Value format"
                    value={draft.bindingFormat}
                    onChange={(event) =>
                      update(
                        "bindingFormat",
                        event.target.value === "percent"
                          ? "percent"
                          : event.target.value === "currency"
                            ? "currency"
                            : "number",
                      )
                    }
                  >
                    <option value="number">Number</option>
                    <option value="percent">Percent</option>
                    <option value="currency">Currency</option>
                  </select>
                </label>
              </div>
              <div className="cnv-field-row">
                <label className="cnv-field">
                  Labels
                  <input
                    list={`columns-${node.id}`}
                    value={draft.bindingX}
                    onChange={(event) => update("bindingX", event.target.value)}
                  />
                </label>
                <label className="cnv-field">
                  Values
                  <input
                    list={`columns-${node.id}`}
                    value={draft.bindingY}
                    onChange={(event) => update("bindingY", event.target.value)}
                  />
                </label>
              </div>
              <datalist id={`columns-${node.id}`}>
                {bindingColumns.map((column) => (
                  <option key={column.key} value={column.key}>
                    {column.label}
                  </option>
                ))}
              </datalist>
            </>
          ) : null}
        </fieldset>
        {node.kind === "html" ? (
          <details className="cnv-editor-section">
            <summary>HTML and zoom views</summary>
            <label className="cnv-field">
              HTML
              <textarea
                aria-label="HTML"
                data-code="true"
                rows={10}
                spellCheck={false}
                value={draft.html}
                onChange={(event) => update("html", event.target.value)}
              />
            </label>
            <label className="cnv-field">
              Overview
              <textarea
                aria-label="Overview HTML"
                data-code="true"
                rows={4}
                spellCheck={false}
                value={draft.overview}
                onChange={(event) => update("overview", event.target.value)}
              />
            </label>
            <label className="cnv-field">
              Evidence
              <textarea
                aria-label="Evidence HTML"
                data-code="true"
                rows={5}
                spellCheck={false}
                value={draft.viewEvidence}
                onChange={(event) => update("viewEvidence", event.target.value)}
              />
              <small>Blank uses the primary HTML.</small>
            </label>
            <label className="cnv-field">
              Sources
              <textarea
                aria-label="Sources HTML"
                data-code="true"
                rows={4}
                spellCheck={false}
                value={draft.sources}
                onChange={(event) => update("sources", event.target.value)}
              />
            </label>
          </details>
        ) : null}
        {evidenceIds.length ? (
          <fieldset className="cnv-editor-section">
            <legend>Evidence references</legend>
            {evidenceIds.map((id) => (
              <label key={id} className="cnv-evidence-choice">
                <input
                  type="checkbox"
                  checked={draft.evidenceSources.includes(id)}
                  onChange={(event) =>
                    update(
                      "evidenceSources",
                      event.target.checked
                        ? [...draft.evidenceSources, id]
                        : draft.evidenceSources.filter((value) => value !== id),
                    )
                  }
                />
                {sources.find((entry) => entry.source.definition.id === id)?.source.definition
                  .title ?? `${id} · unavailable`}
              </label>
            ))}
            {draft.evidenceSources.length ? (
              <button
                type="button"
                className="cnv-button"
                disabled={disabled}
                onClick={() =>
                  void perform(() =>
                    apply({ evidence: evidenceFor(draft.evidenceSources, sources, true) }),
                  )
                }
              >
                Mark evidence reviewed
              </button>
            ) : null}
          </fieldset>
        ) : null}
      </fieldset>
      <div className="cnv-editor-actions">
        <button
          type="submit"
          className="cnv-button"
          data-variant="primary"
          disabled={disabled || !dirty}
        >
          {submitting ? "Applying…" : "Apply change"}
        </button>
        <button
          type="button"
          className="cnv-button"
          disabled={disabled}
          onClick={() =>
            void perform(async () => {
              const request = verificationRequest.current;
              const result = await actions.verify(node.id);

              if (request === verificationRequest.current)
                setVerification({ scope: verificationScope, value: result });
            })
          }
        >
          Verify render
        </button>
      </div>
      {verification?.scope === verificationScope ? (
        <Verification value={verification.value} />
      ) : null}
      {board.composition ? (
        <FlowEditor
          composition={board.composition}
          nodeId={node.id}
          busy={disabled}
          onCompose={actions.compose}
        />
      ) : null}
      <div className="cnv-editor-actions" aria-label="Module actions">
        <button
          type="button"
          className="cnv-button"
          disabled={disabled}
          onClick={() => actions.reference(node)}
        >
          Reference
        </button>
        <button
          type="button"
          className="cnv-button"
          disabled={disabled}
          onClick={() => void perform(() => actions.pin(node))}
        >
          {node.pinned ? "Unpin" : "Pin"}
        </button>
        {node.position ? (
          <button
            type="button"
            className="cnv-button"
            disabled={disabled}
            onClick={() => void perform(() => actions.resetPosition(node))}
          >
            Reset position
          </button>
        ) : null}
        <button
          type="button"
          className="cnv-button"
          disabled={disabled || dirty}
          onClick={() => void perform(() => actions.duplicate(node.id))}
        >
          Duplicate
        </button>
        <button
          type="button"
          className="cnv-button"
          disabled={disabled || dirty}
          onClick={() => void perform(() => actions.hide(node))}
        >
          Hide
        </button>
      </div>
    </form>
  );
}

function Verification({ value }: { value: RenderVerification }) {
  const ready = value.current && value.report?.ready === true;

  return (
    <div
      className="cnv-verification"
      data-state={
        ready && !value.issues.length ? "verified" : value.issues.length ? "failed" : "pending"
      }
      role="status"
    >
      <strong>
        {value.report === null
          ? "Not reported"
          : !value.current
            ? "Stale render"
            : !value.report.ready
              ? "Waiting for render"
              : "Current render"}
      </strong>
      {value.report ? (
        <span>
          {Math.round(value.report.bounds.width)} × {Math.round(value.report.bounds.height)} ·{" "}
          {Math.round(value.report.zoom * 100)}% zoom · {value.report.view}
        </span>
      ) : null}
      {value.issues.map((issue) => (
        <p key={issue}>{issue}</p>
      ))}
      {value.report?.text ? (
        <details>
          <summary>Rendered text</summary>
          <p>{value.report.text}</p>
        </details>
      ) : null}
    </div>
  );
}

function FlowEditor({
  composition,
  nodeId,
  busy,
  onCompose,
}: {
  composition: Composition;
  nodeId: string;
  busy: boolean;
  onCompose(value: Composition): Promise<void>;
}) {
  const selected = selectedFlow(composition.root, nodeId);
  const [base, setBase] = useState(composition);
  const initial = selectedFlow(base.root, nodeId);
  const [flow, setFlow] = useState(initial?.parent.flow ?? "row");
  const [gap, setGap] = useState(String(initial?.parent.gap ?? 24));
  const [weight, setWeight] = useState(String(initial?.leaf.weight ?? 1));
  const [span, setSpan] = useState(String(initial?.leaf.span ?? 1));
  const [columns, setColumns] = useState(String(initial?.parent.columns ?? bentoColumns));
  const [error, setError] = useState<string | null>(null);
  const [processing, setProcessing] = useState(false);

  if (!selected || !initial) return null;
  const currentSelection = selected;

  const changed =
    flow !== initial.parent.flow ||
    gap !== String(initial.parent.gap ?? 24) ||
    weight !== String(initial.leaf.weight ?? 1) ||
    span !== String(initial.leaf.span ?? 1) ||
    columns !== String(initial.parent.columns ?? bentoColumns);

  const stale = JSON.stringify(base) !== JSON.stringify(composition);

  function review() {
    setBase(composition);
    setFlow(currentSelection.parent.flow);
    setGap(String(currentSelection.parent.gap ?? 24));
    setWeight(String(currentSelection.leaf.weight ?? 1));
    setSpan(String(currentSelection.leaf.span ?? 1));
    setColumns(String(currentSelection.parent.columns ?? bentoColumns));
    setError(null);
  }

  async function save(direction = 0) {
    setError(null);
    setProcessing(true);

    try {
      if (stale) throw new Error("The layout changed. Review the latest layout before applying.");

      const next = compositionSchema.parse(
        changeFlow(
          base,
          nodeId,
          {
            flow,
            gap: Number(gap),
            weight: Number(weight),
            span: Math.min(Number(span), Number(columns)),
            columns: Number(columns),
          },
          direction,
        ),
      );

      await onCompose(next);
      setBase(next);
      const normalized = selectedFlow(next.root, nodeId);

      if (normalized) {
        setFlow(normalized.parent.flow);
        setGap(String(normalized.parent.gap ?? 24));
        setWeight(String(normalized.leaf.weight ?? 1));
        setSpan(String(normalized.leaf.span ?? 1));
        setColumns(String(normalized.parent.columns ?? bentoColumns));
      }
    } catch (failure) {
      setError(failureText(errorSchema.parse(failure)));
    } finally {
      setProcessing(false);
    }
  }

  return (
    <fieldset className="cnv-editor-section" disabled={busy || processing}>
      <legend>Layout</legend>
      {stale ? <p className="cnv-editor-notice">The board layout changed.</p> : null}
      <div className="cnv-field-row">
        <label className="cnv-field">
          Group flow
          <select
            aria-label="Group flow"
            value={flow}
            onChange={(event) =>
              setFlow(
                event.target.value === "column"
                  ? "column"
                  : event.target.value === "wrap"
                    ? "wrap"
                    : event.target.value === "bento"
                      ? "bento"
                      : "row",
              )
            }
          >
            <option value="row">Row</option>
            <option value="column">Column</option>
            <option value="wrap">Wrap</option>
            <option value="bento">Bento</option>
          </select>
        </label>
        <label className="cnv-field">
          Gap
          <input
            aria-label="Group gap"
            type="number"
            min={0}
            max={120}
            value={gap}
            onChange={(event) => setGap(event.target.value)}
          />
        </label>
      </div>
      {flow === "bento" ? (
        <div className="cnv-field-row">
          <label className="cnv-field">
            Columns
            <input
              aria-label="Bento columns"
              type="number"
              min={1}
              max={6}
              value={columns}
              onChange={(event) => setColumns(event.target.value)}
            />
          </label>
          <label className="cnv-field">
            Span
            <input
              aria-label="Bento span"
              type="number"
              min={1}
              max={Number(columns) || bentoColumns}
              value={span}
              onChange={(event) => setSpan(event.target.value)}
            />
          </label>
        </div>
      ) : (
        <label className="cnv-field">
          Relative width
          <input
            aria-label="Relative width"
            type="number"
            min={0.25}
            max={8}
            step={0.25}
            value={weight}
            onChange={(event) => setWeight(event.target.value)}
          />
        </label>
      )}
      {error ? (
        <p className="cnv-editor-error" role="alert">
          {error}
        </p>
      ) : null}
      <div className="cnv-editor-actions">
        <button
          type="button"
          className="cnv-button"
          disabled={busy || processing || !changed}
          onClick={() => void save()}
        >
          Apply layout
        </button>
        <button type="button" className="cnv-button" disabled={busy || processing} onClick={review}>
          Review layout
        </button>
        <button
          type="button"
          className="cnv-button"
          disabled={busy || processing || changed || selected.index === 0}
          onClick={() => void save(-1)}
        >
          Earlier
        </button>
        <button
          type="button"
          className="cnv-button"
          disabled={
            busy || processing || changed || selected.index === selected.parent.children.length - 1
          }
          onClick={() => void save(1)}
        >
          Later
        </button>
      </div>
    </fieldset>
  );
}
