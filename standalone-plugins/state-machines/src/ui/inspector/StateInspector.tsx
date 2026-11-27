import { experimental_Icon as Icon } from "@omnyo/plugin-sdk/app";
import { useState } from "react";

import type {
  AgentDraftState,
  ArgvPart,
  CommandDraftState,
  ContextSchema,
  DraftState,
  DraftTransition,
  Effect,
  EnvironmentOption,
  ManualDraftState,
  Problem,
  ResultOutcome,
  WaitDraftState,
} from "../data/contract.js";
import {
  type EditOperation,
  renameStateIdOperation,
  setInitialOperation,
  updateStateOperation,
} from "../graph/edit-model.js";
import { edgeLabel, KIND_LABEL } from "../graph/labels.js";
import { Button, Dialog } from "../primitives.js";
import {
  CommitInput,
  CommitTextarea,
  DurationField,
  problemFor,
  RadioField,
  Section,
  SelectField,
} from "./fields.js";
import { contextPaths } from "./GuardBuilder.js";
import { ModelField, PermissionField } from "./ModelField.js";

export interface StateInspectorProps {
  state: DraftState;
  stateIndex: number;
  editable: boolean;
  published: boolean;
  isInitial: boolean;
  problems: readonly Problem[];
  outgoing: readonly DraftTransition[];
  incoming: readonly DraftTransition[];
  edgeLabels: Readonly<Record<string, string>>;
  stateTitles: ReadonlyMap<string, string>;
  contextSchema: ContextSchema;
  environments: readonly EnvironmentOption[] | undefined;
  projectId: string | null;
  standingAuthority: { reference: string; scope: string } | null;
  dispatch(operation: EditOperation): void;
  onSelectTransition(id: string): void;
  onAddTransition(): void;
  onReorder(id: string, direction: -1 | 1): void;
  titleRef?: (element: HTMLInputElement | null) => void;
}

const EFFECT_OPTIONS: { value: Effect; label: string }[] = [
  { value: "local-read", label: "Reads local files" },
  { value: "local-edit", label: "Edits local files" },
  { value: "external-read", label: "Reads external services" },
  { value: "external-write", label: "Changes external services" },
];

export function StateInspector(props: StateInspectorProps) {
  const { state, editable, dispatch, problems } = props;
  const path = `/states/${props.stateIndex}`;

  const update = (label: string, fn: (state: DraftState) => DraftState) =>
    dispatch(updateStateOperation(state.id, label, fn));

  const [idDraft, setIdDraft] = useState<string | null>(null);

  return (
    <div className="stm-inspector-content">
      <header className="stm-inspector-header">
        <p className="stm-text-xs stm-text-muted">{KIND_LABEL[state.kind]} state</p>
        <h2 className="stm-h2">{state.title}</h2>
      </header>
      <Section title="Identity">
        <CommitInput
          label="Title"
          value={state.title}
          maxLength={48}
          disabled={!editable}
          error={problemFor(problems, `${path}/title`)}
          inputRef={props.titleRef}
          onCommit={(title) =>
            title.trim().length > 0 &&
            update("Rename state", (current) => ({ ...current, title: title.trim() }))
          }
        />
        <CommitInput
          label="State id"
          value={idDraft ?? state.id}
          mono
          maxLength={48}
          disabled={!editable || props.published}
          hint={
            props.published
              ? "Used by published versions."
              : "Letters, digits and dashes; starts with a letter."
          }
          error={
            idDraft !== null && !/^[a-z][a-z0-9-]{0,47}$/.test(idDraft)
              ? "Use lowercase letters, digits and dashes; start with a letter."
              : null
          }
          onCommit={(next) => {
            if (/^[a-z][a-z0-9-]{0,47}$/.test(next)) {
              setIdDraft(null);
              dispatch(renameStateIdOperation(state.id, next));
            } else {
              setIdDraft(next);
            }
          }}
        />
        {state.kind === "end" ? null : (
          <CommitInput
            label="Subtitle"
            value={state.subtitle}
            maxLength={48}
            disabled={!editable}
            hint="Optional. Shown under the title."
            onCommit={(subtitle) =>
              update("Edit subtitle", (current) =>
                current.kind === "end" ? current : { ...current, subtitle },
              )
            }
          />
        )}
        <div className="stm-row stm-row--tight">
          {props.isInitial ? (
            <span className="stm-text-sm stm-text-muted">This is the initial state.</span>
          ) : (
            <Button disabled={!editable} onClick={() => dispatch(setInitialOperation(state.id))}>
              Make initial
            </Button>
          )}
        </div>
      </Section>
      {state.kind === "agent" ? <AgentSection {...props} state={state} path={path} /> : null}
      {state.kind === "command" ? <CommandSection {...props} state={state} path={path} /> : null}
      {state.kind === "wait" ? (
        <WaitSection
          state={state}
          editable={editable}
          update={update}
          problems={problems}
          path={path}
        />
      ) : null}
      {state.kind === "manual" ? (
        <ManualSection
          state={state}
          editable={editable}
          update={update}
          problems={problems}
          path={path}
        />
      ) : null}
      {state.kind === "end" ? (
        <Section title="Outcome">
          <RadioField
            label="Outcome"
            value={state.outcome}
            disabled={!editable}
            options={[
              { value: "success", label: "Success" },
              { value: "failure", label: "Failure" },
            ]}
            onChange={(outcome) =>
              update("Change end outcome", (current) =>
                current.kind === "end" ? { ...current, outcome } : current,
              )
            }
          />
          <CommitInput
            label="Reason"
            value={state.reason}
            maxLength={1024}
            disabled={!editable}
            onCommit={(reason) =>
              update("Edit end reason", (current) =>
                current.kind === "end" ? { ...current, reason } : current,
              )
            }
          />
        </Section>
      ) : null}
      {state.kind === "agent" || state.kind === "command" ? (
        <ActionPolicy {...props} state={state} path={path} />
      ) : null}
      <Section title="Transitions out">
        {props.outgoing.length === 0 ? (
          <p className="stm-text-sm stm-text-muted">None yet.</p>
        ) : null}
        <ol className="stm-transition-list">
          {[...props.outgoing]
            .sort((a, b) => a.priority - b.priority)
            .map((edge, index, list) => (
              <li key={edge.id} className="stm-transition-row">
                <button
                  type="button"
                  className="stm-link"
                  onClick={() => props.onSelectTransition(edge.id)}
                >
                  {edgeLabel(edge, props.edgeLabels)} →{" "}
                  {edge.to === null ? "no target" : (props.stateTitles.get(edge.to) ?? edge.to)}
                </button>
                {editable ? (
                  <span className="stm-row stm-row--tight">
                    <Button
                      variant="ghost"
                      icon="ArrowUp"
                      ariaLabel="Move up"
                      disabled={index === 0}
                      onClick={() => props.onReorder(edge.id, -1)}
                    />
                    <Button
                      variant="ghost"
                      icon="ArrowDown"
                      ariaLabel="Move down"
                      disabled={index === list.length - 1}
                      onClick={() => props.onReorder(edge.id, 1)}
                    />
                  </span>
                ) : null}
              </li>
            ))}
        </ol>
        {editable && state.kind !== "end" ? (
          <Button icon="Plus" onClick={props.onAddTransition}>
            Add transition
          </Button>
        ) : null}
      </Section>
      <Section title="Transitions in" defaultOpen={false}>
        {props.incoming.length === 0 ? <p className="stm-text-sm stm-text-muted">None.</p> : null}
        <ul className="stm-transition-list">
          {props.incoming.map((edge) => (
            <li key={edge.id}>
              <button
                type="button"
                className="stm-link"
                onClick={() => props.onSelectTransition(edge.id)}
              >
                {props.stateTitles.get(edge.from) ?? edge.from} on{" "}
                {edgeLabel(edge, props.edgeLabels)}
              </button>
            </li>
          ))}
        </ul>
      </Section>
    </div>
  );
}

function environmentOptions(environments: readonly EnvironmentOption[] | undefined) {
  return (environments ?? []).map((environment) => ({
    value: environment.environmentId,
    label: `${environment.label}${environment.available ? "" : " (offline)"}${environment.persistent ? "" : " (may be retired)"}`,
    disabled: !environment.available,
  }));
}

function AgentSection(props: StateInspectorProps & { state: AgentDraftState; path: string }) {
  const { state, editable, path, problems } = props;

  const update = (
    label: string,
    fn: (action: AgentDraftState["action"]) => AgentDraftState["action"],
  ) =>
    props.dispatch(
      updateStateOperation(state.id, label, (current) =>
        current.kind === "agent" ? { ...current, action: fn(current.action) } : current,
      ),
    );

  return (
    <Section title="Agent step">
      <CommitTextarea
        label="Prompt"
        value={state.action.prompt ?? ""}
        rows={6}
        maxLength={32768}
        disabled={!editable}
        hint="Use {{context.name}} to insert context values."
        error={problemFor(problems, `${path}/action/prompt`)}
        onCommit={(prompt) =>
          update("Edit prompt", (action) => ({
            ...action,
            prompt: prompt.length > 0 ? prompt : null,
          }))
        }
      />
      <SelectField
        label="Runs in"
        value={state.action.environmentId}
        options={environmentOptions(props.environments)}
        disabled={!editable}
        placeholder={
          props.environments === undefined ? "Loading environments…" : "Choose an environment"
        }
        error={problemFor(problems, `${path}/action/environmentId`)}
        onChange={(environmentId) =>
          update("Choose environment", (action) => ({ ...action, environmentId }))
        }
      />
      <ModelField
        value={state.action.execution}
        environmentId={state.action.environmentId}
        disabled={!editable}
        error={problemFor(problems, `${path}/action/execution`)}
        onCommit={(execution) => update("Choose model", (action) => ({ ...action, execution }))}
      />
      <PermissionField
        value={state.action.permissionMode}
        providerId={state.action.execution?.providerId ?? null}
        environmentId={state.action.environmentId}
        disabled={!editable}
        onCommit={(permissionMode) =>
          update("Change permission mode", (action) => ({ ...action, permissionMode }))
        }
      />
      <p className="stm-field-hint">
        Each run starts a new thread. The step succeeds only when the agent submits a result. A
        finished turn without a result routes as “no result”.
      </p>
      <OutcomesEditor
        outcomes={state.action.result.outcomes}
        editable={editable}
        error={problemFor(problems, `${path}/action/result`)}
        onChange={(outcomes) =>
          update("Edit result outcomes", (action) => ({ ...action, result: { outcomes } }))
        }
      />
    </Section>
  );
}

function OutcomesEditor({
  outcomes,
  editable,
  error,
  onChange,
}: {
  outcomes: readonly ResultOutcome[];
  editable: boolean;
  error: string | null;
  onChange(outcomes: ResultOutcome[]): void;
}) {
  const [name, setName] = useState("");

  const valid =
    /^[a-z][a-z0-9-]{0,63}$/.test(name) && !outcomes.some((outcome) => outcome.name === name);

  return (
    <div className={`stm-field${error ? " stm-field--error" : ""}`}>
      <span className="stm-field-label">Result outcomes</span>
      <ul className="stm-list">
        {outcomes.map((outcome) => (
          <li key={outcome.name} className="stm-row stm-row--tight">
            <code className="stm-mono">{outcome.name}</code>
            <span className="stm-text-muted stm-text-xs">
              {outcome.fields.length === 0
                ? "no fields"
                : outcome.fields
                    .map(
                      (field) => `${field.name}${field.required ? "" : "?"}: ${field.schema.type}`,
                    )
                    .join(", ")}
            </span>
            {editable ? (
              <Button
                variant="ghost"
                icon="CircleX"
                ariaLabel={`Remove outcome ${outcome.name}`}
                onClick={() => onChange(outcomes.filter((item) => item.name !== outcome.name))}
              />
            ) : null}
          </li>
        ))}
      </ul>
      {editable ? (
        <div className="stm-row stm-row--tight">
          <input
            className="stm-input stm-mono"
            aria-label="New outcome name"
            placeholder="pr-opened"
            value={name}
            onChange={(event) => setName(event.target.value)}
          />
          <Button
            disabled={!valid}
            onClick={() => {
              onChange([...outcomes, { name, fields: [] }]);
              setName("");
            }}
          >
            Add outcome
          </Button>
        </div>
      ) : null}
      {error ? (
        <p className="stm-field-error">{error}</p>
      ) : (
        <p className="stm-field-hint">Each outcome becomes a trigger, e.g. “result: pr-opened”.</p>
      )}
    </div>
  );
}

function CommandSection(props: StateInspectorProps & { state: CommandDraftState; path: string }) {
  const { state, editable, path, problems } = props;

  const update = (
    label: string,
    fn: (action: CommandDraftState["action"]) => CommandDraftState["action"],
  ) =>
    props.dispatch(
      updateStateOperation(state.id, label, (current) =>
        current.kind === "command" ? { ...current, action: fn(current.action) } : current,
      ),
    );

  const program = state.action.argv[0];
  const programText = program !== undefined && "literal" in program ? program.literal : "";
  const args = state.action.argv.slice(1);
  const scalarPaths = contextPaths(props.contextSchema);

  return (
    <Section title="Command step">
      <CommitInput
        label="Program"
        value={programText}
        mono
        maxLength={8192}
        disabled={!editable}
        placeholder="pnpm"
        error={problemFor(problems, `${path}/action/argv`)}
        onCommit={(literal) =>
          update("Edit program", (action) => ({
            ...action,
            argv:
              literal.length === 0 && action.argv.length <= 1
                ? []
                : [{ literal }, ...action.argv.slice(1)],
          }))
        }
      />
      <div className="stm-field">
        <span className="stm-field-label">Arguments</span>
        <ol className="stm-argv">
          {args.map((part, index) => (
            <ArgumentRow
              key={index}
              part={part}
              editable={editable}
              contextPaths={scalarPaths}
              isFirst={index === 0}
              isLast={index === args.length - 1}
              onChange={(next) =>
                update("Edit argument", (action) => ({
                  ...action,
                  argv: action.argv.map((item, itemIndex) =>
                    itemIndex === index + 1 ? next : item,
                  ),
                }))
              }
              onRemove={() =>
                update("Remove argument", (action) => ({
                  ...action,
                  argv: action.argv.filter((_, itemIndex) => itemIndex !== index + 1),
                }))
              }
              onMove={(direction) =>
                update("Reorder argument", (action) => {
                  const argv = [...action.argv];
                  const from = index + 1;
                  const to = from + direction;
                  const moving = argv[from];
                  const other = argv[to];

                  if (moving === undefined || other === undefined || to < 1) return action;

                  argv[from] = other;
                  argv[to] = moving;

                  return { ...action, argv };
                })
              }
            />
          ))}
        </ol>
        {editable ? (
          <Button
            variant="ghost"
            icon="Plus"
            disabled={programText.length === 0}
            disabledReason="Enter a program first."
            onClick={() =>
              update("Add argument", (action) => ({
                ...action,
                argv: [...action.argv, { literal: "" }],
              }))
            }
          >
            Argument
          </Button>
        ) : null}
        <p className="stm-field-hint">No shell. Arguments are passed as-is.</p>
      </div>
      <CommitInput
        label="Working directory"
        value={state.action.cwd}
        mono
        maxLength={1024}
        disabled={!editable}
        hint="Relative to the environment's root."
        onCommit={(cwd) => update("Edit working directory", (action) => ({ ...action, cwd }))}
      />
      <SelectField
        label="Runs in"
        value={state.action.environmentId}
        options={environmentOptions(props.environments)}
        disabled={!editable}
        placeholder={
          props.environments === undefined ? "Loading environments…" : "Choose an environment"
        }
        error={problemFor(problems, `${path}/action/environmentId`)}
        onChange={(environmentId) =>
          update("Choose environment", (action) => ({ ...action, environmentId }))
        }
      />
      <CommitInput
        label="Success exit codes"
        value={state.action.successExitCodes.join(", ")}
        mono
        disabled={!editable}
        hint="Exit code 0 by default."
        onCommit={(text) => {
          const codes = text
            .split(",")
            .map((part) => Number(part.trim()))
            .filter((code) => Number.isInteger(code) && code >= 0 && code <= 255);

          if (codes.length > 0)
            update("Edit success exit codes", (action) => ({ ...action, successExitCodes: codes }));
        }}
      />
      <div className="stm-field">
        <span className="stm-field-label">Output</span>
        <p className="stm-text-sm">Up to 1 MiB; the step stops at the cap.</p>
      </div>
      <div className="stm-field">
        <span className="stm-field-label">Retry safety</span>
        <p className="stm-text-sm">
          {state.action.retrySafety === "never"
            ? "Never retried automatically after it may have started."
            : "Adapter-verified safe to retry."}
        </p>
        <p className="stm-field-hint">Set by the command adapter, not here.</p>
      </div>
    </Section>
  );
}

function ArgumentRow({
  part,
  editable,
  contextPaths: paths,
  onChange,
  onRemove,
  onMove,
  isFirst,
  isLast,
}: {
  part: ArgvPart;
  editable: boolean;
  contextPaths: readonly string[];
  onChange(part: ArgvPart): void;
  onRemove(): void;
  onMove(direction: -1 | 1): void;
  isFirst: boolean;
  isLast: boolean;
}) {
  const mode = "literal" in part ? "literal" : "context";
  const [text, setText] = useState("literal" in part ? part.literal : "");

  return (
    <li className="stm-argv-row">
      <select
        className="stm-input stm-input--short"
        aria-label="Argument source"
        value={mode}
        disabled={!editable}
        onChange={(event) =>
          onChange(
            event.target.value === "literal" ? { literal: "" } : { contextPath: paths[0] ?? "" },
          )
        }
      >
        <option value="literal">Text</option>
        <option value="context" disabled={paths.length === 0}>
          From context
        </option>
      </select>
      {"literal" in part ? (
        <input
          className="stm-input stm-mono"
          aria-label="Argument text"
          value={text}
          disabled={!editable}
          onChange={(event) => setText(event.target.value)}
          onBlur={() => text !== part.literal && onChange({ literal: text })}
        />
      ) : (
        <select
          className="stm-input stm-mono"
          aria-label="Context value"
          value={part.contextPath}
          disabled={!editable}
          onChange={(event) => onChange({ contextPath: event.target.value })}
        >
          {paths.map((path) => (
            <option key={path} value={path}>
              {path}
            </option>
          ))}
        </select>
      )}
      {editable ? (
        <span className="stm-row stm-row--tight">
          <Button
            variant="ghost"
            icon="ArrowUp"
            ariaLabel="Move argument up"
            disabled={isFirst}
            onClick={() => onMove(-1)}
          />
          <Button
            variant="ghost"
            icon="ArrowDown"
            ariaLabel="Move argument down"
            disabled={isLast}
            onClick={() => onMove(1)}
          />
          <Button variant="ghost" icon="CircleX" ariaLabel="Remove argument" onClick={onRemove} />
        </span>
      ) : null}
    </li>
  );
}

function ActionPolicy(
  props: StateInspectorProps & { state: AgentDraftState | CommandDraftState; path: string },
) {
  const { state, editable } = props;

  const update = (
    label: string,
    fn: (state: AgentDraftState | CommandDraftState) => AgentDraftState | CommandDraftState,
  ) =>
    props.dispatch(
      updateStateOperation(state.id, label, (current) =>
        current.kind === "agent" || current.kind === "command" ? fn(current) : current,
      ),
    );

  const isAgent = state.kind === "agent";

  return (
    <>
      <Section title="Retries and deadline">
        <SelectField
          label="Attempts in total"
          value={String(state.maxAttempts)}
          disabled={!editable}
          options={[
            { value: "1", label: "1" },
            { value: "2", label: "2" },
            { value: "3", label: "3" },
          ]}
          onChange={(value) =>
            update("Change attempts", (current) => ({ ...current, maxAttempts: Number(value) }))
          }
        />
        <p className="stm-field-hint">
          Retries back off 5s, then 30s. Only rejections before the step started retry; after it may
          have started, only adapter-verified safe steps retry. Unknown outcomes always go to a
          person.
        </p>
        <DurationField
          label="Deadline per attempt"
          valueMs={state.deadlineMs}
          minMs={60_000}
          maxMs={7_200_000}
          disabled={!editable}
          hint={`Default ${isAgent ? "30" : "10"} minutes. Starts at dispatch, not while queued, and keeps running while paused.`}
          onCommit={(deadlineMs) =>
            update("Change deadline", (current) => ({ ...current, deadlineMs }))
          }
        />
      </Section>
      <Section title="Effects and authority">
        <RadioField
          label="Effect"
          value={state.effect}
          options={EFFECT_OPTIONS}
          disabled={!editable}
          onChange={(effect) => update("Change effect", (current) => ({ ...current, effect }))}
        />
        <SelectField
          label="Category (display only)"
          value={state.annotations.category ?? "none"}
          disabled={!editable}
          options={[
            { value: "none", label: "None" },
            { value: "repository", label: "Repository" },
            { value: "release", label: "Release" },
          ]}
          onChange={(value) =>
            update("Change category", (current) => ({
              ...current,
              annotations: { category: value === "none" ? null : value },
            }))
          }
        />
        <CommitInput
          label="Target"
          value={state.effectTarget}
          maxLength={1024}
          disabled={!editable}
          hint="The project, repository or channel this step acts on."
          onCommit={(effectTarget) =>
            effectTarget.trim().length > 0 &&
            update("Change target", (current) => ({
              ...current,
              effectTarget: effectTarget.trim(),
            }))
          }
        />
        {state.effect === "external-write" ? (
          props.standingAuthority !== null ? (
            <p className="stm-authority-line">
              <Icon name="SecurityCheck" aria-hidden /> Covered by existing standing authority:{" "}
              <code className="stm-mono">{props.standingAuthority.reference}</code> · scope{" "}
              {props.standingAuthority.scope}
            </p>
          ) : (
            <blockquote className="stm-notice">
              Steps that change external services need an approval Omnyo can verify came from you.
              That isn't available yet, so this step will stop and ask for authority
              (AUTHORITY_REQUIRED).
            </blockquote>
          )
        ) : null}
      </Section>
    </>
  );
}

function WaitSection({
  state,
  editable,
  update,
  problems,
  path,
}: {
  state: WaitDraftState;
  editable: boolean;
  update(label: string, fn: (state: DraftState) => DraftState): void;
  problems: readonly Problem[];
  path: string;
}) {
  const [eventType, setEventType] = useState("");

  const set = (label: string, triggers: WaitDraftState["triggers"]) =>
    update(label, (current) => (current.kind === "wait" ? { ...current, triggers } : current));

  const check = state.triggers.find((trigger) => trigger.kind === "check");

  return (
    <Section title="Wakes on">
      <ul className="stm-list">
        {state.triggers.map((trigger, index) => (
          <li key={index} className="stm-row stm-row--tight">
            <span className="stm-text-sm">
              {trigger.kind === "event"
                ? `Event ${trigger.eventType}`
                : `Check every ${Math.round(trigger.everyMs / 60_000)}m`}
            </span>
            {editable ? (
              <Button
                variant="ghost"
                icon="CircleX"
                ariaLabel="Remove trigger"
                onClick={() =>
                  set(
                    "Remove trigger",
                    state.triggers.filter((_, itemIndex) => itemIndex !== index),
                  )
                }
              />
            ) : null}
          </li>
        ))}
      </ul>
      {problemFor(problems, `${path}/triggers`) === null ? null : (
        <p className="stm-field-error">{problemFor(problems, `${path}/triggers`)}</p>
      )}
      {editable ? (
        <>
          <div className="stm-row stm-row--tight">
            <input
              className="stm-input stm-mono"
              aria-label="Event type"
              placeholder="source.new-sha"
              value={eventType}
              onChange={(event) => setEventType(event.target.value)}
            />
            <Button
              disabled={eventType.trim().length === 0}
              onClick={() => {
                set("Add event trigger", [
                  ...state.triggers,
                  { kind: "event", eventType: eventType.trim(), filter: {} },
                ]);
                setEventType("");
              }}
            >
              Add event
            </Button>
          </div>
          {check === undefined ? (
            <Button
              onClick={() =>
                set("Add check interval", [
                  ...state.triggers,
                  { kind: "check", everyMs: 5 * 60_000 },
                ])
              }
            >
              Check every 5 minutes
            </Button>
          ) : (
            <DurationField
              label="Check every"
              valueMs={check.everyMs}
              minMs={30_000}
              maxMs={24 * 3_600_000}
              disabled={!editable}
              hint="Minimum 30 seconds. Missed checks coalesce."
              onCommit={(everyMs) =>
                set(
                  "Change check interval",
                  state.triggers.map((trigger) =>
                    trigger.kind === "check" ? { kind: "check", everyMs } : trigger,
                  ),
                )
              }
            />
          )}
        </>
      ) : null}
      <p className="stm-field-hint">
        Person actions (such as “Request promotion”) come from the instance's event catalog and only
        enter a manual gate; they authorize nothing.
      </p>
    </Section>
  );
}

function ManualSection({
  state,
  editable,
  update,
  problems,
  path,
}: {
  state: ManualDraftState;
  editable: boolean;
  update(label: string, fn: (state: DraftState) => DraftState): void;
  problems: readonly Problem[];
  path: string;
}) {
  const [label, setLabel] = useState("");
  const [confirmRemove, setConfirmRemove] = useState<string | null>(null);

  const set = (text: string, fn: (state: ManualDraftState) => ManualDraftState) =>
    update(text, (current) => (current.kind === "manual" ? fn(current) : current));

  const slug = label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

  return (
    <Section title="Needs a person">
      <CommitTextarea
        label="Prompt"
        value={state.prompt}
        maxLength={8192}
        disabled={!editable}
        hint="Markdown. Shown on the attention card."
        onCommit={(prompt) =>
          prompt.trim().length > 0 && set("Edit gate prompt", (current) => ({ ...current, prompt }))
        }
      />
      <div className="stm-field">
        <span className="stm-field-label">Decisions</span>
        <ul className="stm-list">
          {state.decisions.map((decision) => (
            <li key={decision.id} className="stm-decision-edit">
              <span className="stm-text-sm stm-text-strong">{decision.label}</span>
              <code className="stm-mono stm-text-xs">decision.{decision.id}</code>
              <label className="stm-check">
                <input
                  type="checkbox"
                  checked={decision.evidenceRequired}
                  disabled={!editable}
                  onChange={(event) =>
                    set("Change evidence requirement", (current) => ({
                      ...current,
                      decisions: current.decisions.map((item) =>
                        item.id === decision.id
                          ? { ...item, evidenceRequired: event.target.checked }
                          : item,
                      ),
                    }))
                  }
                />
                <span>Evidence required</span>
              </label>
              {editable ? (
                <Button
                  variant="ghost"
                  icon="CircleX"
                  ariaLabel={`Remove ${decision.label}`}
                  onClick={() => setConfirmRemove(decision.id)}
                />
              ) : null}
            </li>
          ))}
        </ul>
        {problemFor(problems, `${path}/decisions`) === null ? null : (
          <p className="stm-field-error">{problemFor(problems, `${path}/decisions`)}</p>
        )}
        {editable ? (
          <div className="stm-row stm-row--tight">
            <input
              className="stm-input"
              aria-label="New decision label"
              placeholder="Resume waiting"
              value={label}
              maxLength={40}
              onChange={(event) => setLabel(event.target.value)}
            />
            <Button
              disabled={
                slug.length === 0 || state.decisions.some((decision) => decision.id === slug)
              }
              onClick={() => {
                set("Add decision", (current) => ({
                  ...current,
                  decisions: [
                    ...current.decisions,
                    { id: slug, label: label.trim(), evidenceRequired: false, evidencePrompt: "" },
                  ],
                }));
                setLabel("");
              }}
            >
              Add decision
            </Button>
          </div>
        ) : null}
        <p className="stm-field-hint">
          Decisions record operator intent. They never approve external changes.
        </p>
      </div>
      <Dialog
        open={confirmRemove !== null}
        onOpenChange={(open) => !open && setConfirmRemove(null)}
        title="Remove this decision?"
        footer={
          <>
            <Button variant="ghost" onClick={() => setConfirmRemove(null)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={() => {
                const id = confirmRemove;

                setConfirmRemove(null);

                if (id !== null)
                  set("Remove decision", (current) => ({
                    ...current,
                    decisions: current.decisions.filter((decision) => decision.id !== id),
                  }));
              }}
            >
              Remove
            </Button>
          </>
        }
      >
        <p className="stm-text-sm">
          Transitions that use this decision keep their trigger and will show a problem until you
          change them.
        </p>
      </Dialog>
    </Section>
  );
}
