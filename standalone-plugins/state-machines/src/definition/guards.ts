import {
  type ContextSchema,
  type GuardExpression,
  type JsonObject,
  type JsonValue,
  type PatchOperation,
  type Path,
  type ValueSchema,
  isBoundedJson,
  isJsonObject,
  pathSchema,
} from "../contracts/definition.js";
import { canonicalJson } from "./canonical.js";
import { assertContext, schemaAtPath } from "./values.js";

export interface EvaluationScope {
  context: JsonObject;
  event?: JsonValue;
  result?: JsonValue;
}

const missing = Symbol("missing");

type Resolved = JsonValue | typeof missing;

export class GuardEvaluationError extends Error {
  override name = "GuardEvaluationError";
}

export function readPath(path: Path, scope: EvaluationScope): Resolved {
  let value: JsonValue | undefined = scope[path.root];

  for (const segment of path.segments) {
    if (!isJsonObject(value) || !Object.hasOwn(value, segment)) return missing;
    value = value[segment];
  }

  return value === undefined ? missing : value;
}

function equal(left: JsonValue, right: JsonValue): boolean {
  // oxlint-disable-next-line anti-slop/no-runtime-typeof -- Guard operands are validated JSON and must have matching runtime types.
  if (typeof left !== typeof right || Array.isArray(left) !== Array.isArray(right))
    throw new GuardEvaluationError("Guard operands have different types");

  if ((left === null) !== (right === null))
    throw new GuardEvaluationError("Guard operands have different types");

  return canonicalJson(left) === canonicalJson(right);
}

export function evaluateGuard(guard: GuardExpression | null, scope: EvaluationScope): boolean {
  if (guard === null) return true;

  if ("all" in guard) return guard.all.every((child) => evaluateGuard(child, scope));

  if ("any" in guard) return guard.any.some((child) => evaluateGuard(child, scope));

  if ("not" in guard) return !evaluateGuard(guard.not, scope);

  if ("exists" in guard) return readPath(guard.exists, scope) !== missing;

  const required = (path: Path): JsonValue => {
    const value = readPath(path, scope);

    if (value === missing)
      throw new GuardEvaluationError("Guard path is missing; use exists before comparing");

    return value;
  };

  if ("in" in guard)
    return guard.in[1].some((candidate) => equal(required(guard.in[0]), candidate));

  if ("eq" in guard) return equal(required(guard.eq[0]), guard.eq[1]);

  if ("ne" in guard) return !equal(required(guard.ne[0]), guard.ne[1]);

  if ("lt" in guard) return ordered(required(guard.lt[0]), guard.lt[1], "lt");

  if ("lte" in guard) return ordered(required(guard.lte[0]), guard.lte[1], "lte");

  if ("gt" in guard) return ordered(required(guard.gt[0]), guard.gt[1], "gt");

  return ordered(required(guard.gte[0]), guard.gte[1], "gte");
}

function ordered(
  left: JsonValue,
  right: JsonValue,
  operation: "lt" | "lte" | "gt" | "gte",
): boolean {
  // oxlint-disable-next-line anti-slop/no-runtime-typeof -- Order comparisons require matching JSON number or string values.
  const numeric = typeof left === "number" && typeof right === "number";
  // oxlint-disable-next-line anti-slop/no-runtime-typeof -- Order comparisons require matching JSON number or string values.
  const textual = typeof left === "string" && typeof right === "string";

  if (!numeric && !textual)
    throw new GuardEvaluationError("Ordered guard requires matching numbers or strings");

  switch (operation) {
    case "lt":
      return left < right;
    case "lte":
      return left <= right;
    case "gt":
      return left > right;
    case "gte":
      return left >= right;
  }
}

export function applyContextPatch(
  context: JsonObject,
  patches: PatchOperation[],
  scope: EvaluationScope,
  schema: ContextSchema,
): JsonObject {
  const candidate = structuredClone(context);

  for (const patch of patches) {
    if (!schemaAtPath(schema, patch.path, true))
      throw new Error("Context path is undeclared or read only");
    let parent = candidate;

    for (const segment of patch.path.slice(0, -1)) {
      const next = parent[segment];

      if (!isJsonObject(next)) throw new Error("Context patch parent does not exist");
      parent = next;
    }

    const key = patch.path.at(-1)!;

    if (patch.op === "remove") delete parent[key];
    else {
      const parsedPath = pathSchema.safeParse(patch.value);

      const value = parsedPath.success
        ? readPath(parsedPath.data, { ...scope, context: candidate })
        : patch.value;

      if (value === missing || !isBoundedJson(value, 65536))
        throw new Error("Context patch source is missing or invalid");
      parent[key] = structuredClone(value);
    }
  }

  if (!isBoundedJson(candidate, 65536)) throw new Error("Context exceeds the 64 KiB limit");
  assertContext(schema, candidate);
  assertReadOnly(schema, context, candidate);

  return candidate;
}

function assertReadOnly(
  schema: ValueSchema,
  before: JsonValue | undefined,
  after: JsonValue | undefined,
): void {
  if (schema.readOnly) {
    const unchanged =
      before === undefined || after === undefined
        ? before === after
        : canonicalJson(before) === canonicalJson(after);

    if (!unchanged) throw new Error("Context patch changes a read only descendant");

    return;
  }

  if (schema.type === "object") {
    for (const [key, property] of Object.entries(schema.properties))
      assertReadOnly(
        property,
        isJsonObject(before) ? before[key] : undefined,
        isJsonObject(after) ? after[key] : undefined,
      );
  } else if (schema.type === "array") {
    const oldItems = Array.isArray(before) ? before : [];
    const newItems = Array.isArray(after) ? after : [];

    for (let i = 0; i < Math.max(oldItems.length, newItems.length); i++)
      assertReadOnly(schema.items, oldItems[i], newItems[i]);
  }
}
