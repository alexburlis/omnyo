import type { ContextSchema, DraftState, DraftTransition, Problem } from "../data/contract.js";
import {
  type EditOperation,
  resetEdgeRouteOperation,
  setEdgeLabelOperation,
  updateTransitionOperation,
} from "../graph/edit-model.js";
import { parseTriggerValue, triggerLabel, triggerOptions, triggerValue } from "../graph/labels.js";
import { Button } from "../primitives.js";
import { CommitInput, problemFor, Section, SelectField } from "./fields.js";
import { contextPaths, GuardBuilder, PatchEditor } from "./GuardBuilder.js";

export function TransitionInspector({
  edge,
  index,
  states,
  editable,
  problems,
  edgeLabels,
  hasCustomRoute,
  contextSchema,
  dispatch,
  onDelete,
  onSelectState,
  liveTaken,
}: {
  edge: DraftTransition;
  index: number;
  states: readonly DraftState[];
  editable: boolean;
  problems: readonly Problem[];
  edgeLabels: Readonly<Record<string, string>>;
  hasCustomRoute: boolean;
  contextSchema: ContextSchema;
  dispatch(operation: EditOperation): void;
  onDelete(): void;
  onSelectState(id: string): void;
  liveTaken?: { lastAt: number | null } | null;
}) {
  const path = `/transitions/${index}`;
  const source = states.find((state) => state.id === edge.from);
  const options = source === undefined ? [] : triggerOptions(source);
  const current = triggerValue(edge.trigger);

  const allOptions = options.some((option) => option.value === current)
    ? options
    : [
        { value: current, label: `${triggerLabel(edge.trigger)} (not offered by this state)` },
        ...options,
      ];

  const stateOptions = states.map((state) => ({ value: state.id, label: state.title }));

  const update = (label: string, fn: (edge: DraftTransition) => DraftTransition) =>
    dispatch(updateTransitionOperation(edge.id, label, fn));

  const suggestions = [
    ...contextPaths(contextSchema).map((item) => `context.${item}`),
    ...(source?.kind === "agent"
      ? source.action.result.outcomes.flatMap((outcome) =>
          outcome.fields.map((field) => `result.${field.name}`),
        )
      : []),
  ];

  return (
    <div className="stm-inspector-content">
      <header className="stm-inspector-header">
        <p className="stm-text-xs stm-text-muted">Transition</p>
        <h2 className="stm-h2">
          <button type="button" className="stm-link" onClick={() => onSelectState(edge.from)}>
            {source?.title ?? edge.from}
          </button>{" "}
          →{" "}
          {edge.to === null ? (
            "no target"
          ) : (
            <button
              type="button"
              className="stm-link"
              onClick={() => edge.to !== null && onSelectState(edge.to)}
            >
              {states.find((state) => state.id === edge.to)?.title ?? edge.to}
            </button>
          )}
        </h2>
      </header>
      {liveTaken === undefined || liveTaken === null ? null : (
        <p className="stm-text-sm stm-text-muted">
          {liveTaken.lastAt === null
            ? "Not taken in retained history."
            : `Last taken ${new Date(liveTaken.lastAt).toLocaleString()}.`}
        </p>
      )}
      <Section title="Route">
        <SelectField
          label="From"
          value={edge.from}
          options={stateOptions}
          disabled={!editable}
          onChange={(from) =>
            update("Change transition source", (current) => ({ ...current, from }))
          }
        />
        <SelectField
          label="To"
          value={edge.to}
          options={stateOptions}
          disabled={!editable}
          placeholder="Choose a target"
          error={problemFor(problems, `${path}/to`)}
          onChange={(to) => update("Change transition target", (current) => ({ ...current, to }))}
        />
        <SelectField
          label="Trigger"
          value={current}
          options={allOptions}
          disabled={!editable}
          error={problemFor(problems, `${path}/trigger`)}
          onChange={(value) => {
            const trigger = parseTriggerValue(value);

            if (trigger !== null) update("Change trigger", (item) => ({ ...item, trigger }));
          }}
        />
        <CommitInput
          label="Label"
          value={edgeLabels[edge.id] ?? ""}
          placeholder={triggerLabel(edge.trigger)}
          maxLength={320}
          disabled={!editable}
          hint="Display only."
          onCommit={(label) => dispatch(setEdgeLabelOperation(edge.id, label))}
        />
        <p className="stm-text-sm stm-text-muted">
          Priority {edge.priority}. Reorder in the source state's transition list.
        </p>
        {editable && hasCustomRoute ? (
          <Button onClick={() => dispatch(resetEdgeRouteOperation(edge.id))}>Reset route</Button>
        ) : null}
      </Section>
      <Section title="Condition">
        <GuardBuilder
          guard={edge.guard}
          suggestions={suggestions}
          disabled={!editable}
          onChange={(guard) => update("Edit condition", (item) => ({ ...item, guard }))}
        />
        {problemFor(problems, `${path}/guard`) === null ? null : (
          <p className="stm-field-error">{problemFor(problems, `${path}/guard`)}</p>
        )}
      </Section>
      <Section title="Context changes">
        <PatchEditor
          patches={edge.contextPatch}
          writablePaths={contextPaths(contextSchema, true)}
          disabled={!editable}
          onChange={(contextPatch) =>
            update("Edit context changes", (item) => ({ ...item, contextPatch }))
          }
        />
      </Section>
      {editable ? (
        <Button variant="destructive" icon="Trash2" onClick={onDelete}>
          Delete transition
        </Button>
      ) : null}
    </div>
  );
}
