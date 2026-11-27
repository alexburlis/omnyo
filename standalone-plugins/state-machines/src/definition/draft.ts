import { z } from "zod";
import {
  agentActionSchema,
  commandActionSchema,
  decisionSchema,
  DEFAULT_MACHINE_LIMITS,
  graphLayoutSchema,
  type GuardExpression,
  type JsonValue,
  type Path,
  jsonValueSchema,
  pathSchema,
  permissionModeSchema,
  isBoundedJson,
  machineDefinitionSchema,
  stateDefinitionSchema,
  transitionDefinitionSchema,
  waitTriggerSchema,
} from "../contracts/definition.js";
import {
  type DefinitionProblem,
  type DefinitionValidation,
  validateDefinition,
} from "./validate.js";

export const DEFAULT_AGENT_PERMISSION_MODE = "full";

const editorAgentActionSchema = agentActionSchema.extend({
  prompt: z.string().max(32768).nullable(),
  execution: agentActionSchema.shape.execution.nullable(),
  environmentId: agentActionSchema.shape.environmentId.nullable(),
  result: agentActionSchema.shape.result.extend({
    outcomes: z.array(agentActionSchema.shape.result.shape.outcomes.element).max(32),
  }),
});

const editorCommandActionSchema = commandActionSchema.extend({
  argv: z.array(commandActionSchema.shape.argv.element).max(256),
  environmentId: commandActionSchema.shape.environmentId.nullable(),
});

export type EditorGuard =
  | GuardExpression
  | { all: EditorGuard[] }
  | { any: EditorGuard[] }
  | { not: EditorGuard }
  | { eq: [Path, JsonValue?] }
  | { ne: [Path, JsonValue?] }
  | { lt: [Path, JsonValue?] }
  | { lte: [Path, JsonValue?] }
  | { gt: [Path, JsonValue?] }
  | { gte: [Path, JsonValue?] }
  | { in: [Path, JsonValue[]?] };

const draftComparisonSchema = z.tuple([pathSchema, jsonValueSchema.optional()]);

export const editorGuardSchema: z.ZodType<EditorGuard> = z.lazy(() =>
  z.union([
    z.strictObject({ all: z.array(editorGuardSchema).max(256) }),
    z.strictObject({ any: z.array(editorGuardSchema).max(256) }),
    z.strictObject({ not: editorGuardSchema }),
    z.strictObject({ exists: pathSchema }),
    z.strictObject({ eq: draftComparisonSchema }),
    z.strictObject({ ne: draftComparisonSchema }),
    z.strictObject({ lt: draftComparisonSchema }),
    z.strictObject({ lte: draftComparisonSchema }),
    z.strictObject({ gt: draftComparisonSchema }),
    z.strictObject({ gte: draftComparisonSchema }),
    z.strictObject({ in: z.tuple([pathSchema, z.array(jsonValueSchema).max(256).optional()]) }),
  ]),
);

function draftSchema<Permission extends z.ZodType>(permissionMode: Permission) {
  return machineDefinitionSchema.extend({
    initialStateId: machineDefinitionSchema.shape.initialStateId.nullable(),
    states: z
      .array(
        z.discriminatedUnion("kind", [
          stateDefinitionSchema.options[0].extend({ triggers: z.array(waitTriggerSchema).max(32) }),
          stateDefinitionSchema.options[1],
          stateDefinitionSchema.options[2].extend({
            action: editorAgentActionSchema.extend({ permissionMode }),
          }),
          stateDefinitionSchema.options[3].extend({ action: editorCommandActionSchema }),
          stateDefinitionSchema.options[4].extend({ decisions: z.array(decisionSchema).max(32) }),
          stateDefinitionSchema.options[5],
        ]),
      )
      .max(100),
    transitions: z
      .array(
        transitionDefinitionSchema.extend({
          to: transitionDefinitionSchema.shape.to.nullable(),
          guard: editorGuardSchema.nullable(),
        }),
      )
      .max(300),
  });
}

const draftPermissionModeInputSchema = permissionModeSchema.nullish();

export const editorDraftInputSchema = draftSchema(draftPermissionModeInputSchema);

export const editorDraftSchema = draftSchema(
  draftPermissionModeInputSchema
    .transform((mode) => mode ?? DEFAULT_AGENT_PERMISSION_MODE)
    .pipe(permissionModeSchema),
);

export type EditorDraft = z.infer<typeof editorDraftSchema>;

export function createEmptyDraft(input: {
  machineId: string;
  name: string;
  description?: string;
}): EditorDraft {
  return {
    schemaVersion: 1,
    machineId: input.machineId,
    name: input.name,
    description: input.description ?? "",
    initialStateId: null,
    contextSchema: { type: "object", properties: {}, required: [], additionalProperties: false },
    initialContext: {},
    states: [],
    transitions: [],
    limits: { ...DEFAULT_MACHINE_LIMITS },
    layout: graphLayoutSchema.parse({
      initial: { x: 0, y: 0 },
      nodes: {},
      edges: {},
      edgeLabels: {},
    }),
  };
}

// oxlint-disable-next-line anti-slop/no-unknown-parameters -- The editor draft is untrusted JSON and parsed immediately.
export function parseDraft(input: unknown): EditorDraft {
  if (!isBoundedJson(input, 262144, 64))
    throw new Error("Draft must be safe JSON of at most 256 KiB");

  return editorDraftSchema.parse(input);
}

// oxlint-disable-next-line anti-slop/no-unknown-parameters -- Compilation is the boundary from arbitrary draft JSON to executable definitions.
export function compileDraft(input: unknown): DefinitionValidation {
  const problems: DefinitionProblem[] = [];

  const problem = (code: string, path: string, message: string): void => {
    problems.push({ code, path, message, severity: "error" });
  };

  let draft: EditorDraft;

  try {
    draft = parseDraft(input);
  } catch {
    return validateDefinition(input);
  }

  if (draft.initialStateId === null)
    problem("no-initial", "/initialStateId", "Choose an initial state");
  draft.states.forEach((state, index) => {
    const path = `/states/${index}`;

    if (state.kind === "agent") {
      if (!state.action.prompt?.trim())
        problem("missing-prompt", `${path}/action/prompt`, "Write an agent prompt");

      if (!state.action.execution)
        problem("missing-model", `${path}/action/execution`, "Choose a model");

      if (!state.action.result.outcomes.length)
        problem("missing-result-schema", `${path}/action/result`, "Declare a structured result");
    }

    if ((state.kind === "agent" || state.kind === "command") && !state.action.environmentId)
      problem("missing-environment", `${path}/action/environmentId`, "Choose an environment");

    if (state.kind === "command") {
      const program = state.action.argv[0];

      if (!program || !("literal" in program) || !program.literal.trim())
        problem("missing-command", `${path}/action/argv`, "Choose a program and arguments");
    }

    if (state.kind === "wait" && !state.triggers.length)
      problem("wait-no-trigger", `${path}/triggers`, "Add an event or timer");

    if (state.kind === "manual" && !state.decisions.length)
      problem("gate-no-decisions", `${path}/decisions`, "Add a decision");
  });
  draft.transitions.forEach((edge, index) => {
    if (edge.to === null)
      problem("dangling-transition", `/transitions/${index}/to`, "Choose a target state");

    const inspect = (guard: EditorGuard, path: string): void => {
      if ("all" in guard)
        guard.all.forEach((child, childIndex) => inspect(child, `${path}/all/${childIndex}`));
      else if ("any" in guard)
        guard.any.forEach((child, childIndex) => inspect(child, `${path}/any/${childIndex}`));
      else if ("not" in guard) inspect(guard.not, `${path}/not`);
      else if (!("exists" in guard)) {
        const value = Object.values(guard)[0];

        if (!value || value.length < 2)
          problem("guard-incomplete", path, "Choose a guard comparison value");
      }
    };

    if (edge.guard) inspect(edge.guard, `/transitions/${index}/guard`);
  });
  const canonical = validateDefinition(draft);
  canonical.problems.forEach((item) => {
    if (
      !problems.some(
        (existing) => item.path === existing.path || item.path.startsWith(`${existing.path}/`),
      )
    )
      problems.push(item);
  });

  return {
    valid: !problems.some((item) => item.severity === "error"),
    definition: canonical.definition,
    problems,
  };
}

export const validateDraft = compileDraft;
