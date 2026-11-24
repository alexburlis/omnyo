import { eq, like } from "drizzle-orm";
import type { DbConnection } from "../connection.js";
import { appSettingsValues } from "../schema.js";

const HOST_GENERATION_PREFIX = "pluginHostGeneration:";

export interface PluginHostGeneration {
  digest: string;
  byteLength: number;
  generation: string;
}

export function getPluginHostGeneration(
  db: DbConnection,
  pluginId: string,
): PluginHostGeneration | undefined {
  const row = db
    .select({ value: appSettingsValues.value })
    .from(appSettingsValues)
    .where(eq(appSettingsValues.key, `${HOST_GENERATION_PREFIX}${pluginId}`))
    .get();

  if (row === undefined) return undefined;

  const [digest, byteLengthText, generation, ...extra] = row.value.split(":");

  if (
    digest === undefined ||
    byteLengthText === undefined ||
    generation === undefined ||
    extra.length !== 0 ||
    !/^[a-f0-9]{64}$/u.test(digest) ||
    !/^\d+$/u.test(byteLengthText) ||
    !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u.test(
      generation,
    )
  ) {
    throw new Error(
      `Invalid persisted host generation for plugin "${pluginId}"`,
    );
  }

  const byteLength = Number(byteLengthText);

  if (!Number.isSafeInteger(byteLength)) {
    throw new Error(
      `Invalid persisted host generation for plugin "${pluginId}"`,
    );
  }

  return { digest, byteLength, generation };
}

export function setPluginHostGeneration(
  db: DbConnection,
  pluginId: string,
  identity: PluginHostGeneration,
): void {
  const value = `${identity.digest}:${identity.byteLength}:${identity.generation}`;
  const updatedAt = Date.now();
  db.insert(appSettingsValues)
    .values({ key: `${HOST_GENERATION_PREFIX}${pluginId}`, value, updatedAt })
    .onConflictDoUpdate({
      target: appSettingsValues.key,
      set: { value, updatedAt },
    })
    .run();
}

export function deletePluginHostGeneration(
  db: DbConnection,
  pluginId: string,
): void {
  db.delete(appSettingsValues)
    .where(eq(appSettingsValues.key, `${HOST_GENERATION_PREFIX}${pluginId}`))
    .run();
}

export function listPluginHostGenerationIds(db: DbConnection): string[] {
  return db
    .select({ key: appSettingsValues.key })
    .from(appSettingsValues)
    .where(like(appSettingsValues.key, `${HOST_GENERATION_PREFIX}%`))
    .all()
    .map((row) => row.key.slice(HOST_GENERATION_PREFIX.length));
}
