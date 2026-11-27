import { useEffect, useId, useState } from "react";

import type {
  ContextSchema,
  EditorGuard,
  JsonValue,
  PatchOperation,
  Path,
  ValueSchema,
} from "../data/contract.js";
import { Button } from "../primitives.js";

type Operator = "exists" | "eq" | "ne" | "lt" | "lte" | "gt" | "gte" | "in";

const OPERATORS: { value: Operator; label: string }[] = [
  { value: "exists", label: "exists" },
  { value: "eq", label: "=" },
  { value: "ne", label: "≠" },
  { value: "lt", label: "<" },
  { value: "lte", label: "≤" },
  { value: "gt", label: ">" },
  { value: "gte", label: "≥" },
  { value: "in", label: "in" },
];

const MAX_UI_DEPTH = 4;

export function contextPaths(schema: ContextSchema, writableOnly = false): string[] {
  const paths: string[] = [];

  const walk = (node: ValueSchema, prefix: string[], readOnly: boolean) => {
    if (node.type !== "object") return;

    for (const [key, child] of Object.entries(node.properties)) {
      const path = [...prefix, key];
      const childReadOnly = readOnly || child.readOnly === true;

      if (!writableOnly || !childReadOnly) paths.push(path.join("."));

      walk(child, path, childReadOnly);
    }
  };

  walk(schema, [], schema.readOnly === true);

  return paths;
}

export function formatPath(path: Path): string {
  return [path.root, ...path.segments].join(".");
}

export function parsePath(text: string): Path | null {
  const [root, ...segments] = text.trim().split(".");

  if (
    (root !== "context" && root !== "event" && root !== "result") ||
    segments.length === 0 ||
    segments.some((segment) => segment.length === 0)
  )
    return null;

  return { root, segments };
}

function parseLiteral(text: string): JsonValue {
  const trimmed = text.trim();

  if (trimmed === "true") return true;

  if (trimmed === "false") return false;

  if (trimmed === "null") return null;

  if (trimmed.length > 0 && Number.isFinite(Number(trimmed))) return Number(trimmed);

  if (trimmed.startsWith('"') && trimmed.endsWith('"') && trimmed.length >= 2)
    return trimmed.slice(1, -1);

  return trimmed;
}

function literalText(value: JsonValue | undefined): string {
  if (value === undefined) return "";

  if (value === null) return "null";

  if (Array.isArray(value)) return value.map((item) => literalText(item)).join(", ");

  if (value === true || value === false) return String(value);

  if (Number.isFinite(value)) return String(value);

  return JSON.stringify(value).replace(/^"|"$/g, "");
}

function leafOperator(guard: EditorGuard): Operator | null {
  for (const operator of OPERATORS) if (operator.value in guard) return operator.value;

  return null;
}

function leafPath(guard: EditorGuard): Path | null {
  if ("exists" in guard) return guard.exists;

  if ("in" in guard) return guard.in[0];

  if ("eq" in guard) return guard.eq[0];

  if ("ne" in guard) return guard.ne[0];

  if ("lt" in guard) return guard.lt[0];

  if ("lte" in guard) return guard.lte[0];

  if ("gt" in guard) return guard.gt[0];

  if ("gte" in guard) return guard.gte[0];

  return null;
}

function leafValue(guard: EditorGuard): JsonValue | undefined {
  if ("in" in guard) return guard.in[1];

  if ("eq" in guard) return guard.eq[1];

  if ("ne" in guard) return guard.ne[1];

  if ("lt" in guard) return guard.lt[1];

  if ("lte" in guard) return guard.lte[1];

  if ("gt" in guard) return guard.gt[1];

  if ("gte" in guard) return guard.gte[1];

  return undefined;
}

function buildLeaf(operator: Operator, path: Path, valueText: string): EditorGuard {
  const value = valueText.trim().length === 0 ? undefined : parseLiteral(valueText);

  switch (operator) {
    case "exists":
      return { exists: path };
    case "in":
      return {
        in: [
          path,
          valueText.trim().length === 0
            ? undefined
            : valueText.split(",").map((part) => parseLiteral(part)),
        ],
      };
    case "eq":
      return { eq: [path, value] };
    case "ne":
      return { ne: [path, value] };
    case "lt":
      return { lt: [path, value] };
    case "lte":
      return { lte: [path, value] };
    case "gt":
      return { gt: [path, value] };
    case "gte":
      return { gte: [path, value] };
  }
}

const DEFAULT_LEAF: EditorGuard = { eq: [{ root: "result", segments: ["value"] }] };

export function GuardBuilder({
  guard,
  onChange,
  disabled,
  suggestions,
}: {
  guard: EditorGuard | null;
  onChange(guard: EditorGuard | null): void;
  disabled: boolean;
  suggestions: readonly string[];
}) {
  const listId = useId();

  return (
    <div className="stm-guard">
      <datalist id={listId}>
        {suggestions.map((path) => (
          <option key={path} value={path} />
        ))}
      </datalist>
      {guard === null ? (
        <div className="stm-row stm-row--tight">
          <span className="stm-text-sm stm-text-muted">
            No condition. This transition always matches its trigger.
          </span>
          <Button disabled={disabled} onClick={() => onChange({ all: [DEFAULT_LEAF] })}>
            Add condition
          </Button>
        </div>
      ) : (
        <GuardNode
          guard={guard}
          depth={1}
          listId={listId}
          disabled={disabled}
          onChange={onChange}
          onRemove={() => onChange(null)}
        />
      )}
    </div>
  );
}

function GuardNode({
  guard,
  depth,
  listId,
  disabled,
  onChange,
  onRemove,
}: {
  guard: EditorGuard;
  depth: number;
  listId: string;
  disabled: boolean;
  onChange(guard: EditorGuard): void;
  onRemove(): void;
}) {
  if ("all" in guard || "any" in guard) {
    const mode = "all" in guard ? "all" : "any";
    const children = "all" in guard ? guard.all : guard.any;

    const update = (next: EditorGuard[]) =>
      onChange(mode === "all" ? { all: next } : { any: next });

    return (
      <div
        className={`stm-guard-group stm-guard-group--depth-${depth}`}
        role="group"
        aria-label={mode === "all" ? "All of" : "Any of"}
      >
        <div className="stm-row stm-row--tight">
          <select
            className="stm-input stm-input--short"
            aria-label="Group type"
            value={mode}
            disabled={disabled}
            onChange={(event) =>
              onChange(event.target.value === "all" ? { all: children } : { any: children })
            }
          >
            <option value="all">All of</option>
            <option value="any">Any of</option>
          </select>
          <Button
            variant="ghost"
            icon="CircleX"
            ariaLabel="Remove group"
            disabled={disabled}
            onClick={onRemove}
          />
        </div>
        {children.map((child, index) => (
          <GuardNode
            key={index}
            guard={child}
            depth={depth + 1}
            listId={listId}
            disabled={disabled}
            onChange={(next) =>
              update(children.map((item, itemIndex) => (itemIndex === index ? next : item)))
            }
            onRemove={() => update(children.filter((_, itemIndex) => itemIndex !== index))}
          />
        ))}
        <div className="stm-row stm-row--tight">
          <Button
            variant="ghost"
            icon="Plus"
            disabled={disabled}
            onClick={() => update([...children, DEFAULT_LEAF])}
          >
            Condition
          </Button>
          {depth < MAX_UI_DEPTH ? (
            <>
              <Button
                variant="ghost"
                icon="Plus"
                disabled={disabled}
                onClick={() => update([...children, { any: [DEFAULT_LEAF] }])}
              >
                Group
              </Button>
              <Button
                variant="ghost"
                icon="Plus"
                disabled={disabled}
                onClick={() => update([...children, { not: DEFAULT_LEAF }])}
              >
                Not
              </Button>
            </>
          ) : null}
        </div>
      </div>
    );
  }

  if ("not" in guard)
    return (
      <div className="stm-guard-group" role="group" aria-label="Not">
        <div className="stm-row stm-row--tight">
          <span className="stm-text-sm stm-text-strong">Not</span>
          <Button
            variant="ghost"
            icon="CircleX"
            ariaLabel="Remove not"
            disabled={disabled}
            onClick={onRemove}
          />
        </div>
        <GuardNode
          guard={guard.not}
          depth={depth + 1}
          listId={listId}
          disabled={disabled}
          onChange={(next) => onChange({ not: next })}
          onRemove={onRemove}
        />
      </div>
    );

  return (
    <GuardLeaf
      guard={guard}
      listId={listId}
      disabled={disabled}
      onChange={onChange}
      onRemove={onRemove}
    />
  );
}

function GuardLeaf({
  guard,
  listId,
  disabled,
  onChange,
  onRemove,
}: {
  guard: EditorGuard;
  listId: string;
  disabled: boolean;
  onChange(guard: EditorGuard): void;
  onRemove(): void;
}) {
  const operator = leafOperator(guard) ?? "eq";
  const path = leafPath(guard) ?? { root: "context", segments: ["value"] };
  const [pathText, setPathText] = useState(formatPath(path));
  const [valueText, setValueText] = useState(literalText(leafValue(guard)));
  const [pathError, setPathError] = useState<string | null>(null);

  const pathKey = formatPath(path);

  useEffect(() => setPathText(pathKey), [pathKey]);

  const commit = (nextOperator: Operator, nextPathText: string, nextValueText: string) => {
    const parsed = parsePath(nextPathText);

    if (parsed === null) {
      setPathError("Start with context., event. or result.");

      return;
    }

    setPathError(null);
    onChange(buildLeaf(nextOperator, parsed, nextValueText));
  };

  return (
    <div className="stm-guard-leaf">
      <input
        className={`stm-input stm-mono${pathError === null ? "" : " stm-input--invalid"}`}
        aria-label="Value path"
        list={listId}
        value={pathText}
        disabled={disabled}
        onChange={(event) => setPathText(event.target.value)}
        onBlur={() => commit(operator, pathText, valueText)}
      />
      <select
        className="stm-input stm-input--short"
        aria-label="Comparison"
        value={operator}
        disabled={disabled}
        onChange={(event) =>
          commit(
            OPERATORS.find((item) => item.value === event.target.value)?.value ?? "eq",
            pathText,
            valueText,
          )
        }
      >
        {OPERATORS.map((item) => (
          <option key={item.value} value={item.value}>
            {item.label}
          </option>
        ))}
      </select>
      {operator === "exists" ? null : (
        <input
          className="stm-input"
          aria-label={operator === "in" ? "Values, separated by commas" : "Value"}
          placeholder={operator === "in" ? "a, b, c" : "value"}
          value={valueText}
          disabled={disabled}
          onChange={(event) => setValueText(event.target.value)}
          onBlur={() => commit(operator, pathText, valueText)}
        />
      )}
      <Button
        variant="ghost"
        icon="CircleX"
        ariaLabel="Remove condition"
        disabled={disabled}
        onClick={onRemove}
      />
      {pathError === null ? null : <p className="stm-field-error">{pathError}</p>}
    </div>
  );
}

export function PatchEditor({
  patches,
  onChange,
  disabled,
  writablePaths,
}: {
  patches: readonly PatchOperation[];
  onChange(patches: PatchOperation[]): void;
  disabled: boolean;
  writablePaths: readonly string[];
}) {
  const update = (index: number, next: PatchOperation) =>
    onChange(patches.map((patch, itemIndex) => (itemIndex === index ? next : patch)));

  return (
    <div className="stm-patches">
      {patches.length === 0 ? (
        <p className="stm-text-sm stm-text-muted">No context changes.</p>
      ) : null}
      {patches.map((patch, index) => (
        <div key={index} className="stm-guard-leaf">
          <select
            className="stm-input stm-input--short"
            aria-label="Change type"
            value={patch.op}
            disabled={disabled}
            onChange={(event) =>
              update(
                index,
                event.target.value === "remove"
                  ? { op: "remove", path: patch.path }
                  : { op: "set", path: patch.path, value: "" },
              )
            }
          >
            <option value="set">Set</option>
            <option value="remove">Remove</option>
          </select>
          <select
            className="stm-input stm-mono"
            aria-label="Context path"
            value={patch.path.join(".")}
            disabled={disabled}
            onChange={(event) => {
              const path = event.target.value.split(".");

              update(
                index,
                patch.op === "remove"
                  ? { op: "remove", path }
                  : { op: "set", path, value: patch.value },
              );
            }}
          >
            {writablePaths.includes(patch.path.join(".")) ? null : (
              <option value={patch.path.join(".")}>{patch.path.join(".")} (not writable)</option>
            )}
            {writablePaths.map((path) => (
              <option key={path} value={path}>
                {path}
              </option>
            ))}
          </select>
          {patch.op === "set" ? (
            <PatchValue
              value={patch.value}
              disabled={disabled}
              onCommit={(value) => update(index, { op: "set", path: patch.path, value })}
            />
          ) : null}
          <Button
            variant="ghost"
            icon="CircleX"
            ariaLabel="Remove change"
            disabled={disabled}
            onClick={() => onChange(patches.filter((_, itemIndex) => itemIndex !== index))}
          />
        </div>
      ))}
      <Button
        variant="ghost"
        icon="Plus"
        disabled={disabled || writablePaths.length === 0}
        disabledReason="Declare a writable context value in machine settings first."
        onClick={() =>
          onChange([
            ...patches,
            { op: "set", path: (writablePaths[0] ?? "value").split("."), value: "" },
          ])
        }
      >
        Context change
      </Button>
    </div>
  );
}

function isPath(value: JsonValue | Path): value is Path {
  return (
    value !== null &&
    !Array.isArray(value) &&
    value instanceof Object &&
    "root" in value &&
    "segments" in value
  );
}

function PatchValue({
  value,
  disabled,
  onCommit,
}: {
  value: JsonValue | Path;
  disabled: boolean;
  onCommit(value: JsonValue | Path): void;
}) {
  const initial = isPath(value) ? formatPath(value) : literalText(value);
  const [text, setText] = useState(initial);

  useEffect(() => setText(initial), [initial]);

  return (
    <input
      className="stm-input"
      aria-label="New value (literal, or event.… / result.… to copy)"
      value={text}
      disabled={disabled}
      onChange={(event) => setText(event.target.value)}
      onBlur={() => {
        const path = /^(event|result)\./.test(text.trim()) ? parsePath(text) : null;

        onCommit(path ?? parseLiteral(text));
      }}
    />
  );
}
