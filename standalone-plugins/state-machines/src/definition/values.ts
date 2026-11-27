import {
  type ContextSchema,
  type JsonObject,
  type JsonValue,
  type ValueSchema,
  isSafeSegment,
  isJsonObject,
} from "../contracts/definition.js";

export interface ValueProblem {
  path: string;
  message: string;
}

const escapePath = (part: string): string => part.replaceAll("~", "~0").replaceAll("/", "~1");

export function validateValue(schema: ValueSchema, value: JsonValue, path = ""): ValueProblem[] {
  const problems: ValueProblem[] = [];

  const fail = (message: string): void => {
    problems.push({ path, message });
  };

  switch (schema.type) {
    case "null":
      if (value !== null) fail("Expected null");
      break;
    case "boolean":
      // oxlint-disable-next-line anti-slop/no-runtime-typeof -- Validate data against its user-declared JSON schema.
      if (typeof value !== "boolean") fail("Expected boolean");
      break;
    case "string":
      // oxlint-disable-next-line anti-slop/no-runtime-typeof -- Validate data against its user-declared JSON schema.
      if (typeof value !== "string") fail("Expected string");
      else if (schema.minLength !== undefined && value.length < schema.minLength)
        fail("String is too short");
      else if (schema.maxLength !== undefined && value.length > schema.maxLength)
        fail("String is too long");
      else if (schema.enum && !schema.enum.includes(value))
        fail("Value is not in the declared enum");
      break;
    case "number":
    case "integer":
      // oxlint-disable-next-line anti-slop/no-runtime-typeof -- Validate finite numbers against the user-declared JSON schema.
      if (typeof value !== "number" || !Number.isFinite(value)) fail("Expected finite number");
      else if (schema.type === "integer" && !Number.isInteger(value)) fail("Expected integer");
      else if (schema.minimum !== undefined && value < schema.minimum)
        fail("Number is below minimum");
      else if (schema.maximum !== undefined && value > schema.maximum)
        fail("Number is above maximum");
      break;
    case "array":
      if (!Array.isArray(value)) fail("Expected array");
      else if (value.length > schema.maxItems) fail("Array exceeds item limit");
      else
        value.forEach((item, i) =>
          problems.push(...validateValue(schema.items, item, `${path}/${i}`)),
        );
      break;
    case "object":
      if (!isJsonObject(value)) {
        fail("Expected object");
        break;
      }

      for (const key of schema.required)
        if (!Object.hasOwn(value, key))
          problems.push({
            path: `${path}/${escapePath(key)}`,
            message: "Required field is missing",
          });

      for (const [key, child] of Object.entries(value)) {
        const field = schema.properties[key];

        if (!Object.hasOwn(schema.properties, key) || !field)
          problems.push({ path: `${path}/${escapePath(key)}`, message: "Field is not declared" });
        else problems.push(...validateValue(field, child, `${path}/${escapePath(key)}`));
      }

      break;
  }

  return problems;
}

export function schemaAtPath(
  schema: ContextSchema,
  segments: readonly string[],
  writable = false,
): ValueSchema | null {
  let current: ValueSchema = schema;

  for (const part of segments) {
    if (!isSafeSegment(part) || current.type !== "object" || (writable && current.readOnly))
      return null;

    const next: ValueSchema | undefined = Object.hasOwn(current.properties, part)
      ? current.properties[part]
      : undefined;

    if (!next) return null;
    current = next;
  }

  if (writable && current.readOnly) return null;

  return current;
}

export function parseContextPath(path: string): string[] {
  const parts = path.startsWith("/")
    ? path
        .slice(1)
        .split("/")
        .map((part) => part.replaceAll("~1", "/").replaceAll("~0", "~"))
    : path.split(".");

  if (!parts.length || parts.some((part) => !isSafeSegment(part)) || parts.length > 16)
    throw new Error("Invalid context path");

  return parts;
}

export function assertContext(schema: ContextSchema, value: JsonObject): void {
  const problems = validateValue(schema, value);

  if (problems.length)
    throw new Error(
      `Context validation failed at ${problems[0]!.path || "/"}: ${problems[0]!.message}`,
    );
}
