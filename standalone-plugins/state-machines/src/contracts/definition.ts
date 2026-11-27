import { z } from "zod";

export type JsonValue = null | boolean | number | string | JsonValue[] | JsonObject;

export interface JsonObject {
  [key: string]: JsonValue;
}

const forbiddenKeys = new Set(["__proto__", "prototype", "constructor"]);

export const isSafeSegment = (key: string): boolean => key.length > 0 && !forbiddenKeys.has(key);

export function isJsonObject(value: JsonValue | undefined): value is JsonObject {
  // oxlint-disable-next-line anti-slop/no-runtime-typeof -- Discriminate the validated recursive JSON union.
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function isBoundedJson(
  value: unknown,
  maxBytes = 262144,
  maxDepth = 32,
): value is JsonValue {
  const stack: (
    | { kind: "enter"; value: unknown; depth: number }
    | { kind: "exit"; value: object }
  )[] = [{ kind: "enter", value, depth: 0 }];

  const seen = new Set<object>();
  let nodes = 0;

  while (stack.length) {
    const current = stack.pop()!;

    if (current.kind === "exit") {
      seen.delete(current.value);
      continue;
    }

    if (++nodes > 20000 || current.depth > maxDepth) return false;
    const item = current.value;

    // oxlint-disable-next-line anti-slop/no-runtime-typeof -- This is the untrusted JSON parser boundary.
    if (item === null || typeof item === "string" || typeof item === "boolean") continue;

    // oxlint-disable-next-line anti-slop/no-runtime-typeof -- Reject non-finite JSON numbers at ingress.
    if (typeof item === "number") {
      if (!Number.isFinite(item)) return false;
      continue;
    }

    // oxlint-disable-next-line anti-slop/no-runtime-typeof -- Reject non-JSON primitives and cycles at ingress.
    if (typeof item !== "object" || seen.has(item)) return false;
    seen.add(item);
    stack.push({ kind: "exit", value: item });

    if (Array.isArray(item)) {
      for (const child of item)
        stack.push({ kind: "enter", value: child, depth: current.depth + 1 });
    } else {
      if (![Object.prototype, null].includes(Object.getPrototypeOf(item))) return false;

      for (const [key, child] of Object.entries(item)) {
        if (!isSafeSegment(key)) return false;
        stack.push({ kind: "enter", value: child, depth: current.depth + 1 });
      }
    }
  }

  try {
    return new TextEncoder().encode(JSON.stringify(value)).length <= maxBytes;
  } catch {
    return false;
  }
}

export const jsonValueSchema = z.preprocess((value, context) => {
  if (!isBoundedJson(value)) {
    context.addIssue({ code: "custom", message: "Expected bounded JSON without unsafe keys" });

    return z.NEVER;
  }

  return value;
}, z.json());

export const jsonObjectSchema = z.preprocess(
  (value, context) => {
    if (!isBoundedJson(value, 65536) || !isJsonObject(value)) {
      context.addIssue({ code: "custom", message: "Expected a JSON object of at most 64 KiB" });

      return z.NEVER;
    }

    return value;
  },
  z.record(z.string(), z.json()),
);

export type ValueSchema =
  | { type: "string"; minLength?: number; maxLength?: number; enum?: string[]; readOnly?: boolean }
  | { type: "number" | "integer"; minimum?: number; maximum?: number; readOnly?: boolean }
  | { type: "boolean" | "null"; readOnly?: boolean }
  | { type: "array"; items: ValueSchema; maxItems: number; readOnly?: boolean }
  | ContextSchema;

export interface ContextSchema {
  type: "object";
  properties: Record<string, ValueSchema>;
  required: string[];
  additionalProperties: false;
  readOnly?: boolean;
}

const safeKeySchema = z.string().min(1).max(128).refine(isSafeSegment, "Unsafe path segment");

const readonlyField = { readOnly: z.boolean().optional() };

export const valueSchemaSchema: z.ZodType<ValueSchema> = z.lazy(() =>
  z.union([
    z.strictObject({
      type: z.literal("string"),
      minLength: z.int().min(0).max(65536).optional(),
      maxLength: z.int().min(0).max(65536).optional(),
      enum: z.array(z.string().max(65536)).min(1).max(100).optional(),
      ...readonlyField,
    }),
    z.strictObject({
      type: z.enum(["number", "integer"]),
      minimum: z.number().optional(),
      maximum: z.number().optional(),
      ...readonlyField,
    }),
    z.strictObject({ type: z.enum(["boolean", "null"]), ...readonlyField }),
    z.strictObject({
      type: z.literal("array"),
      items: valueSchemaSchema,
      maxItems: z.int().min(0).max(1000),
      ...readonlyField,
    }),
    z.strictObject({
      type: z.literal("object"),
      properties: z.record(safeKeySchema, valueSchemaSchema),
      required: z.array(safeKeySchema).max(100),
      additionalProperties: z.literal(false),
      ...readonlyField,
    }),
  ]),
);

export const contextSchemaSchema = z.strictObject({
  type: z.literal("object"),
  properties: z.record(safeKeySchema, valueSchemaSchema),
  required: z.array(safeKeySchema).max(100),
  additionalProperties: z.literal(false),
  ...readonlyField,
});

export interface Path {
  root: "context" | "event" | "result";
  segments: string[];
}

export const pathSchema = z.strictObject({
  root: z.enum(["context", "event", "result"]),
  segments: z.array(safeKeySchema).max(16),
});

export type GuardExpression =
  | { all: GuardExpression[] }
  | { any: GuardExpression[] }
  | { not: GuardExpression }
  | { exists: Path }
  | { eq: [Path, JsonValue] }
  | { ne: [Path, JsonValue] }
  | { lt: [Path, JsonValue] }
  | { lte: [Path, JsonValue] }
  | { gt: [Path, JsonValue] }
  | { gte: [Path, JsonValue] }
  | { in: [Path, JsonValue[]] };

const comparison = z.tuple([pathSchema, jsonValueSchema]);

export const guardExpressionSchema: z.ZodType<GuardExpression> = z.lazy(() =>
  z.union([
    z.strictObject({ all: z.array(guardExpressionSchema).max(256) }),
    z.strictObject({ any: z.array(guardExpressionSchema).max(256) }),
    z.strictObject({ not: guardExpressionSchema }),
    z.strictObject({ exists: pathSchema }),
    z.strictObject({ eq: comparison }),
    z.strictObject({ ne: comparison }),
    z.strictObject({ lt: comparison }),
    z.strictObject({ lte: comparison }),
    z.strictObject({ gt: comparison }),
    z.strictObject({ gte: comparison }),
    z.strictObject({ in: z.tuple([pathSchema, z.array(jsonValueSchema).max(256)]) }),
  ]),
);

export type PatchOperation =
  | { op: "set"; path: string[]; value: JsonValue | Path }
  | { op: "remove"; path: string[] };

export const patchOperationSchema = z.discriminatedUnion("op", [
  z.strictObject({
    op: z.literal("set"),
    path: z.array(safeKeySchema).min(1).max(16),
    value: z.union([pathSchema, jsonValueSchema]),
  }),
  z.strictObject({ op: z.literal("remove"), path: z.array(safeKeySchema).min(1).max(16) }),
]);

const identifierSchema = z.string().min(1).max(128);

export const stateIdSchema = z.string().regex(/^[a-z][a-z0-9-]{0,47}$/);

export const triggerSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("event"), eventType: identifierSchema }),
  z.strictObject({ kind: z.literal("timer") }),
  z.strictObject({ kind: z.literal("always") }),
  ...(
    ["succeeded", "failed", "timed-out", "cancelled", "no-result", "budget-exhausted"] as const
  ).map((kind) => z.strictObject({ kind: z.literal(kind) })),
  z.strictObject({ kind: z.literal("result"), outcome: identifierSchema }),
  z.strictObject({ kind: z.literal("decision"), decisionId: identifierSchema }),
]);

export type Trigger = z.infer<typeof triggerSchema>;

export const effectSchema = z.enum(["local-read", "local-edit", "external-read", "external-write"]);

export type Effect = z.infer<typeof effectSchema>;

export const typedFieldSchema = z.strictObject({
  name: safeKeySchema,
  schema: valueSchemaSchema,
  required: z.boolean(),
});

export type TypedField = z.infer<typeof typedFieldSchema>;

export const resultSpecSchema = z.strictObject({
  outcomes: z
    .array(z.strictObject({ name: identifierSchema, fields: z.array(typedFieldSchema).max(100) }))
    .min(1)
    .max(32),
});

export const executionSchema = z.strictObject({
  providerId: identifierSchema,
  model: identifierSchema,
  reasoningLevel: identifierSchema,
  serviceTier: identifierSchema.optional(),
});

export const permissionModeSchema = z.enum(["accept-edits", "auto", "full"]);

export const agentActionSchema = z.strictObject({
  prompt: z.string().min(1).max(32768),
  execution: executionSchema,
  permissionMode: permissionModeSchema,
  environmentId: identifierSchema,
  result: resultSpecSchema,
});

export const commandActionSchema = z.strictObject({
  argv: z
    .array(
      z.union([
        z.strictObject({ literal: z.string().max(8192) }),
        z.strictObject({ contextPath: z.string().min(1).max(1024) }),
      ]),
    )
    .min(1)
    .max(256),
  shell: z.literal(false),
  cwd: z.string().max(1024),
  environmentId: identifierSchema,
  successExitCodes: z.array(z.int().min(0).max(255)).min(1).max(32),
  retrySafety: z.enum(["never", "adapter-verified"]),
});

export const waitTriggerSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("event"),
    eventType: identifierSchema,
    filter: z.record(safeKeySchema, jsonValueSchema),
  }),
  z.strictObject({ kind: z.literal("check"), everyMs: z.int().min(30000).max(2147483647) }),
]);

export const decisionSchema = z.strictObject({
  id: identifierSchema,
  label: z.string().min(1).max(160),
  evidenceRequired: z.boolean(),
  evidencePrompt: z.string().max(1024),
});

const stateBase = {
  id: stateIdSchema,
  title: z.string().min(1).max(160),
  subtitle: z.string().max(320),
};

const actionBase = {
  deadlineMs: z.int().min(1000).max(7200000),
  maxAttempts: z.int().min(1).max(3),
  effect: effectSchema,
  effectTarget: z.string().min(1).max(1024),
  annotations: z.strictObject({ category: z.enum(["repository", "release"]).nullable() }),
};

export const stateDefinitionSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("wait"),
    ...stateBase,
    triggers: z.array(waitTriggerSchema).min(1).max(32),
  }),
  z.strictObject({ kind: z.literal("choice"), ...stateBase }),
  z.strictObject({
    kind: z.literal("agent"),
    ...stateBase,
    ...actionBase,
    action: agentActionSchema,
  }),
  z.strictObject({
    kind: z.literal("command"),
    ...stateBase,
    ...actionBase,
    action: commandActionSchema,
  }),
  z.strictObject({
    kind: z.literal("manual"),
    ...stateBase,
    prompt: z.string().min(1).max(8192),
    decisions: z.array(decisionSchema).min(1).max(32),
  }),
  z.strictObject({
    kind: z.literal("end"),
    id: stateIdSchema,
    title: z.string().min(1).max(160),
    outcome: z.enum(["success", "failure"]),
    reason: z.string().max(1024),
  }),
]);

export type StateDefinition = z.infer<typeof stateDefinitionSchema>;

export type AgentState = Extract<StateDefinition, { kind: "agent" }>;

export type CommandState = Extract<StateDefinition, { kind: "command" }>;

export type AgentAction = AgentState["action"];

export type CommandAction = CommandState["action"];

export type WaitTrigger = z.infer<typeof waitTriggerSchema>;

export type Decision = z.infer<typeof decisionSchema>;

export const transitionDefinitionSchema = z.strictObject({
  id: z.string().regex(/^tr_[a-zA-Z0-9_-]{1,100}$/),
  from: stateIdSchema,
  to: stateIdSchema,
  trigger: triggerSchema,
  guard: guardExpressionSchema.nullable(),
  contextPatch: z.array(patchOperationSchema).max(100),
  priority: z.int().min(0).max(10000),
});

export type TransitionDefinition = z.infer<typeof transitionDefinitionSchema>;

export const machineLimitsSchema = z.strictObject({
  microstepsPerWake: z.int().min(1).max(32),
  actionStartsPerFiveMinutes: z.int().min(1).max(10),
  repairAttemptsPerSubject: z.int().min(1).max(2),
});

export type MachineLimits = z.infer<typeof machineLimitsSchema>;

export const DEFAULT_MACHINE_LIMITS: MachineLimits = {
  microstepsPerWake: 32,
  actionStartsPerFiveMinutes: 10,
  repairAttemptsPerSubject: 2,
};

export const pointSchema = z.strictObject({
  x: z.number().min(-100000).max(100000),
  y: z.number().min(-100000).max(100000),
});

const sideSchema = z.enum(["top", "right", "bottom", "left"]);

export const graphLayoutSchema = z.strictObject({
  initial: pointSchema,
  nodes: z.record(stateIdSchema, pointSchema),
  edges: z.record(
    z.string().max(128),
    z.strictObject({
      sourceSide: sideSchema,
      targetSide: sideSchema,
      waypoints: z.array(pointSchema).max(64),
      labelAt: z.number().min(0).max(1),
    }),
  ),
  edgeLabels: z.record(z.string().max(128), z.string().max(320)),
});

export type GraphLayout = z.infer<typeof graphLayoutSchema>;

export const machineDefinitionSchema = z.strictObject({
  schemaVersion: z.literal(1),
  machineId: z.string().regex(/^mch_[a-zA-Z0-9_-]{1,100}$/),
  name: z.string().min(1).max(160),
  description: z.string().max(8192),
  initialStateId: stateIdSchema,
  contextSchema: contextSchemaSchema,
  initialContext: jsonObjectSchema,
  states: z.array(stateDefinitionSchema).min(1).max(100),
  transitions: z.array(transitionDefinitionSchema).max(300),
  limits: machineLimitsSchema,
  layout: graphLayoutSchema,
});

export const definitionSchema = machineDefinitionSchema;

export type MachineDefinition = z.infer<typeof machineDefinitionSchema>;
