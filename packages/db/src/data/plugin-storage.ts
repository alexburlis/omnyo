import { and, asc, eq, placeholder, sql } from "drizzle-orm";
import {
  prepareCachedQuery,
  type DbConnection,
  type DbQueryConnection,
} from "../connection.js";
import { pluginKv, pluginSettings } from "../schema.js";
import { likePrefixPattern } from "./sql-like.js";

const prepareGetPluginKvValue = (db: DbQueryConnection) =>
  db
    .select({ value: pluginKv.value })
    .from(pluginKv)
    .where(
      and(
        eq(pluginKv.pluginId, placeholder("pluginId")),
        eq(pluginKv.key, placeholder("key")),
      ),
    )
    .prepare();

const prepareSetPluginKvValue = (db: DbQueryConnection) =>
  db
    .insert(pluginKv)
    .values({
      pluginId: placeholder("pluginId"),
      key: placeholder("key"),
      value: placeholder("value"),
      updatedAt: placeholder("updatedAt"),
    })
    .onConflictDoUpdate({
      target: [pluginKv.pluginId, pluginKv.key],
      set: {
        value: sql.raw("excluded.value"),
        updatedAt: sql.raw("excluded.updated_at"),
      },
    })
    .prepare();

const prepareDeletePluginKvValue = (db: DbQueryConnection) =>
  db
    .delete(pluginKv)
    .where(
      and(
        eq(pluginKv.pluginId, placeholder("pluginId")),
        eq(pluginKv.key, placeholder("key")),
      ),
    )
    .prepare();

const prepareListPluginKvKeys = (db: DbQueryConnection) =>
  db
    .select({ key: pluginKv.key })
    .from(pluginKv)
    .where(eq(pluginKv.pluginId, placeholder("pluginId")))
    .orderBy(asc(pluginKv.key))
    .prepare();

const prepareListPluginKvKeysWithPrefix = (db: DbQueryConnection) =>
  db
    .select({ key: pluginKv.key })
    .from(pluginKv)
    .where(
      and(
        eq(pluginKv.pluginId, placeholder("pluginId")),
        sql`${pluginKv.key} LIKE ${placeholder("pattern")} ESCAPE '\\'`,
      ),
    )
    .orderBy(asc(pluginKv.key))
    .prepare();

const prepareListPluginKvRows = (db: DbQueryConnection) =>
  db
    .select()
    .from(pluginKv)
    .where(eq(pluginKv.pluginId, placeholder("pluginId")))
    .orderBy(asc(pluginKv.key))
    .prepare();

export interface PluginKvRow {
  pluginId: string;
  key: string;
  value: string;
  updatedAt: number;
}

export interface PluginSettingRow {
  pluginId: string;
  key: string;
  value: string;
  updatedAt: number;
}

export function getPluginKvValue(
  db: DbConnection,
  pluginId: string,
  key: string,
): string | undefined {
  return prepareCachedQuery(db, prepareGetPluginKvValue).get({ pluginId, key })
    ?.value;
}

export function setPluginKvValue(
  db: DbConnection,
  pluginId: string,
  key: string,
  value: string,
): void {
  prepareCachedQuery(db, prepareSetPluginKvValue).run({
    pluginId,
    key,
    value,
    updatedAt: Date.now(),
  });
}

export function deletePluginKvValue(
  db: DbConnection,
  pluginId: string,
  key: string,
): boolean {
  const secureDelete: unknown = db.$client.pragma("secure_delete", {
    simple: true,
  });

  if (typeof secureDelete !== "number") {
    throw new Error("Invalid SQLite secure_delete setting");
  }

  db.$client.pragma("secure_delete = ON");

  try {
    const result = prepareCachedQuery(db, prepareDeletePluginKvValue).run({
      pluginId,
      key,
    });

    return result.changes > 0;
  } finally {
    db.$client.pragma(`secure_delete = ${secureDelete}`);
  }
}

export function listPluginKvKeys(
  db: DbConnection,
  pluginId: string,
  prefix?: string,
): string[] {
  const rows =
    prefix !== undefined && prefix.length > 0
      ? prepareCachedQuery(db, prepareListPluginKvKeysWithPrefix).all({
          pluginId,
          pattern: likePrefixPattern(prefix),
        })
      : prepareCachedQuery(db, prepareListPluginKvKeys).all({ pluginId });

  return rows.map((row) => row.key);
}

export function getPluginSettingsValues(
  db: DbConnection,
  pluginId: string,
): Record<string, string> {
  const rows = db
    .select({ key: pluginSettings.key, value: pluginSettings.value })
    .from(pluginSettings)
    .where(eq(pluginSettings.pluginId, pluginId))
    .all();

  return Object.fromEntries(rows.map((row) => [row.key, row.value]));
}

export function setPluginSettingsValues(
  db: DbConnection,
  pluginId: string,
  values: Record<string, string | null>,
): void {
  const updatedAt = Date.now();
  db.transaction((tx) => {
    for (const [key, value] of Object.entries(values)) {
      if (value === null) {
        tx.delete(pluginSettings)
          .where(
            and(
              eq(pluginSettings.pluginId, pluginId),
              eq(pluginSettings.key, key),
            ),
          )
          .run();
        continue;
      }

      tx.insert(pluginSettings)
        .values({ pluginId, key, value, updatedAt })
        .onConflictDoUpdate({
          target: [pluginSettings.pluginId, pluginSettings.key],
          set: { value, updatedAt },
        })
        .run();
    }
  });
}

export function deleteAllPluginSettings(
  db: DbConnection,
  pluginId: string,
): void {
  db.delete(pluginSettings).where(eq(pluginSettings.pluginId, pluginId)).run();
}

export function listPluginKvRows(
  db: DbConnection,
  pluginId: string,
): PluginKvRow[] {
  return prepareCachedQuery(db, prepareListPluginKvRows).all({ pluginId });
}

export function listPluginSettingRows(
  db: DbConnection,
  pluginId: string,
): PluginSettingRow[] {
  return db
    .select()
    .from(pluginSettings)
    .where(eq(pluginSettings.pluginId, pluginId))
    .orderBy(asc(pluginSettings.key))
    .all();
}
