import { z } from "zod";
import { jsonObjectSchema, type AgentState, type ContextSchema } from "./definition.js";
import { validateValue } from "../definition/values.js";

export const actionResultSchema = z.strictObject({
  outcome: z.string().min(1).max(128),
  payload: jsonObjectSchema,
});

export type ActionResult = z.infer<typeof actionResultSchema>;

// oxlint-disable-next-line anti-slop/no-unknown-parameters -- Structured agent output is untrusted and parsed immediately.
export function parseActionResult(state: AgentState, input: unknown): ActionResult {
  const result = actionResultSchema.parse(input);

  if (new TextEncoder().encode(JSON.stringify(result)).length > 16384)
    throw new Error("Action result exceeds 16 KiB");
  const outcome = state.action.result.outcomes.find((item) => item.name === result.outcome);

  if (!outcome) throw new Error("Result outcome is not declared");

  const schema: ContextSchema = {
    type: "object",
    properties: {},
    required: [],
    additionalProperties: false,
  };

  for (const field of outcome.fields) {
    schema.properties[field.name] = field.schema;

    if (field.required) schema.required.push(field.name);
  }

  const problems = validateValue(schema, result.payload);

  if (problems.length)
    throw new Error(`Invalid result at ${problems[0]!.path}: ${problems[0]!.message}`);

  return result;
}
