import { useState } from "react";

import type { ContextSchema, EditorDraft, JsonValue, ValueSchema } from "../data/contract.js";
import { type EditOperation, updateMachineOperation } from "../graph/edit-model.js";
import { Section } from "../inspector/fields.js";
import { Button } from "../primitives.js";

type VarType = "string" | "number" | "boolean";

function typeOf(schema: ValueSchema): string {
  return schema.type;
}

function initialFor(type: VarType, text: string): JsonValue {
  if (type === "number")
    return Number.isFinite(Number(text)) && text.trim().length > 0 ? Number(text) : 0;

  if (type === "boolean") return text.trim() === "true";

  return text;
}

export function ContextEditor({
  draft,
  editable,
  dispatch,
}: {
  draft: EditorDraft;
  editable: boolean;
  dispatch(operation: EditOperation): void;
}) {
  const [name, setName] = useState("");
  const [type, setType] = useState<VarType>("string");
  const [writable, setWritable] = useState(true);
  const [initial, setInitial] = useState("");
  const [adding, setAdding] = useState(false);
  const schema: ContextSchema = draft.contextSchema;
  const entries = Object.entries(schema.properties);

  const validName =
    /^[a-zA-Z][a-zA-Z0-9_]{0,63}$/.test(name) && !Object.hasOwn(schema.properties, name);

  const add = () => {
    const property: ValueSchema =
      type === "string"
        ? { type: "string", readOnly: !writable }
        : type === "number"
          ? { type: "number", readOnly: !writable }
          : { type: "boolean", readOnly: !writable };

    const value = initialFor(type, initial);

    dispatch(
      updateMachineOperation("Add context value", (current) => ({
        ...current,
        contextSchema: {
          ...current.contextSchema,
          properties: { ...current.contextSchema.properties, [name]: property },
          required: [...current.contextSchema.required, name],
        },
        initialContext: { ...current.initialContext, [name]: value },
      })),
    );
    setName("");
    setInitial("");
  };

  const remove = (key: string) =>
    dispatch(
      updateMachineOperation("Remove context value", (current) => {
        const properties = { ...current.contextSchema.properties };
        const initialContext = { ...current.initialContext };

        delete properties[key];
        delete initialContext[key];

        return {
          ...current,
          contextSchema: {
            ...current.contextSchema,
            properties,
            required: current.contextSchema.required.filter((item) => item !== key),
          },
          initialContext,
        };
      }),
    );

  return (
    <Section title={`Context values (${entries.length})`} defaultOpen={entries.length > 0}>
      <p className="stm-field-hint">
        Used by conditions, prompts and command arguments. Budgets and counters are runtime-owned.
      </p>
      {entries.length === 0 ? <p className="stm-text-sm stm-text-muted">None declared.</p> : null}
      <ul className="stm-list">
        {entries.map(([key, value]) => (
          <li key={key} className="stm-row stm-row--tight">
            <code className="stm-mono">{key}</code>
            <span className="stm-text-xs stm-text-muted">
              {typeOf(value)}
              {value.readOnly === true ? " · read only" : " · writable"} · initial{" "}
              {JSON.stringify(draft.initialContext[key] ?? null)}
            </span>
            {editable ? (
              <Button
                variant="ghost"
                icon="CircleX"
                ariaLabel={`Remove ${key}`}
                onClick={() => remove(key)}
              />
            ) : null}
          </li>
        ))}
      </ul>
      {editable && !adding ? (
        <Button icon="Plus" onClick={() => setAdding(true)}>
          Add context value
        </Button>
      ) : null}
      {editable && adding ? (
        <div className="stm-context-add">
          <input
            className="stm-input stm-mono"
            aria-label="Name"
            placeholder="Name, e.g. sourceSha"
            value={name}
            onChange={(event) => setName(event.target.value)}
          />
          <select
            className="stm-input stm-input--short"
            aria-label="Type"
            value={type}
            onChange={(event) =>
              setType(
                event.target.value === "number"
                  ? "number"
                  : event.target.value === "boolean"
                    ? "boolean"
                    : "string",
              )
            }
          >
            <option value="string">Text</option>
            <option value="number">Number</option>
            <option value="boolean">Yes/no</option>
          </select>
          <input
            className="stm-input"
            aria-label="Initial value"
            placeholder="Initial value"
            value={initial}
            onChange={(event) => setInitial(event.target.value)}
          />
          <label className="stm-check">
            <input
              type="checkbox"
              checked={writable}
              onChange={(event) => setWritable(event.target.checked)}
            />
            <span>Writable</span>
          </label>
          <Button disabled={!validName} onClick={add}>
            Add value
          </Button>
        </div>
      ) : null}
    </Section>
  );
}
