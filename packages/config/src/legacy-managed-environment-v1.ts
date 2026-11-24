import { importLegacyConfigEnvironmentV1 } from "./omnyo-environment.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function importEnvironmentValuesV1(
  value: Record<string, unknown>,
): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};

  for (const [name, entry] of Object.entries(value)) {
    if (typeof entry !== "string")
      throw new Error("Saved environment values must be strings");
    environment[name] = entry;
  }

  return importLegacyConfigEnvironmentV1(environment);
}

export function importLegacyManagedConfigEnvironmentV1(
  value: unknown,
): unknown {
  if (!isRecord(value) || !isRecord(value.config)) return value;

  return { ...value, config: importEnvironmentValuesV1(value.config) };
}

export function importLegacyManagedEnvFileV1(value: unknown): unknown {
  if (!isRecord(value) || !isRecord(value.env)) return value;

  return { ...value, env: importEnvironmentValuesV1(value.env) };
}
