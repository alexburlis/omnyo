import type { PluginLogger, PluginSecrets } from "@omnyo/plugin-sdk";
import { z } from "zod";
import {
  listStoredExecutions,
  replaceStoredExecution,
  storedEnvKeys,
  type AutomationEnv,
  type AutomationEnvValues,
  type Db,
} from "./data.js";

const ENV_SECRET_PREFIX = "env/";

const automationIdSegmentSchema = z
  .string()
  .max(196)
  .regex(/^[A-Za-z0-9_-][A-Za-z0-9._-]*$/u);

const envValuesSchema = z.record(z.string(), z.string());

const legacyEnvExecutionSchema = z
  .object({ env: envValuesSchema })
  .passthrough();

function envSecretName(automationId: string): string {
  return `${ENV_SECRET_PREFIX}${automationIdSegmentSchema.parse(automationId)}`;
}

function sameEnv(
  left: AutomationEnv | undefined,
  right: AutomationEnv | undefined,
): boolean {
  if (left === undefined || right === undefined) return left === right;
  const leftKeys = Object.keys(left);

  return (
    leftKeys.length === Object.keys(right).length &&
    leftKeys.every(
      (key) => Object.hasOwn(right, key) && left[key] === right[key],
    )
  );
}

function nonEmpty(env: AutomationEnv | undefined): AutomationEnv | undefined {
  return env === undefined || Object.keys(env).length === 0 ? undefined : env;
}

export class AutomationEnvStore implements AutomationEnvValues {
  private readonly cache = new Map<string, AutomationEnv>();

  constructor(private readonly secrets: PluginSecrets) {}

  values(automationId: string): AutomationEnv | undefined {
    return this.cache.get(automationId);
  }

  async write(
    automationId: string,
    env: AutomationEnv | undefined,
  ): Promise<void> {
    const next = nonEmpty(env);

    if (sameEnv(this.cache.get(automationId), next)) return;
    const name = envSecretName(automationId);

    if (next === undefined) {
      await this.secrets.delete(name);
      this.cache.delete(automationId);

      return;
    }

    const value = JSON.stringify(next);
    await this.secrets.set(name, value);

    if ((await this.secrets.get(name)) !== value) {
      throw new Error(
        `Automation ${automationId} environment did not read back from the secret store`,
      );
    }

    this.cache.set(automationId, next);
  }

  async load(log: Pick<PluginLogger, "error">): Promise<void> {
    for (const name of await this.secrets.list(ENV_SECRET_PREFIX)) {
      const value = await this.secrets.get(name);

      if (value === undefined) continue;

      try {
        this.cache.set(
          name.slice(ENV_SECRET_PREFIX.length),
          envValuesSchema.parse(JSON.parse(value)),
        );
      } catch {
        log.error(`Automation environment secret ${name} is unreadable`);
      }
    }
  }

  storedIds(): string[] {
    return [...this.cache.keys()];
  }
}

export async function openAutomationEnv(args: {
  db: Db;
  secrets: PluginSecrets;
  log: Pick<PluginLogger, "error">;
}): Promise<AutomationEnvStore> {
  const store = new AutomationEnvStore(args.secrets);
  await store.load(args.log);
  const envKeysById = new Map<string, string[] | undefined>();

  for (const row of listStoredExecutions(args.db)) {
    let legacy: z.infer<typeof legacyEnvExecutionSchema> | undefined;

    try {
      const parsed = legacyEnvExecutionSchema.safeParse(
        JSON.parse(row.execution),
      );

      legacy = parsed.success ? parsed.data : undefined;
    } catch {
      legacy = undefined;
    }

    if (legacy === undefined) {
      envKeysById.set(row.id, storedEnvKeys(row.execution));
      continue;
    }

    const { env, ...rest } = legacy;
    await store.write(row.id, env);
    const envKeys = Object.keys(env);

    replaceStoredExecution(args.db, {
      id: row.id,
      from: row.execution,
      to: JSON.stringify({ ...rest, envKeys }),
    });
    envKeysById.set(row.id, envKeys);
  }

  for (const automationId of store.storedIds()) {
    const envKeys = envKeysById.get(automationId);
    const values = store.values(automationId);

    if (envKeys === undefined || values === undefined) {
      await store.write(automationId, undefined);
      continue;
    }

    await store.write(
      automationId,
      Object.fromEntries(
        envKeys.flatMap((key) =>
          Object.hasOwn(values, key) ? [[key, values[key]]] : [],
        ),
      ),
    );
  }

  return store;
}
