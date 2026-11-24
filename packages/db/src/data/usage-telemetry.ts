import { eq, sql } from "drizzle-orm";
import {
  usageActorsSchema,
  type UsageActor,
} from "@omnyo/domain/usage-telemetry";

export type { UsageActor } from "@omnyo/domain/usage-telemetry";

import type { DbConnection } from "../connection.js";
import { appSettingsValues } from "../schema.js";

const ACTORS_KEY = "usageAnalyticsActorsV1";

const WEEK_KEY = "usageHighestAttemptedWeekV1";

export function readUsageActors(db: DbConnection): UsageActor[] {
  const row = db
    .select({ value: appSettingsValues.value })
    .from(appSettingsValues)
    .where(eq(appSettingsValues.key, ACTORS_KEY))
    .get();

  if (!row) return [];

  try {
    return usageActorsSchema.parse(JSON.parse(row.value));
  } catch {
    return [];
  }
}

export function writeUsageActors(db: DbConnection, actors: UsageActor[]): void {
  const value = JSON.stringify(usageActorsSchema.parse(actors));
  db.insert(appSettingsValues)
    .values({ key: ACTORS_KEY, value, updatedAt: Date.now() })
    .onConflictDoUpdate({
      target: appSettingsValues.key,
      set: { value, updatedAt: Date.now() },
    })
    .run();
}

export function readUsageAttemptedWeek(db: DbConnection): string | null {
  const row = db
    .select({ value: appSettingsValues.value })
    .from(appSettingsValues)
    .where(eq(appSettingsValues.key, WEEK_KEY))
    .get();

  return row && /^\d{4}-\d{2}-\d{2}$/.test(row.value) ? row.value : null;
}

export function claimUsageWeek(db: DbConnection, week: string): boolean {
  const result = db
    .insert(appSettingsValues)
    .values({ key: WEEK_KEY, value: week, updatedAt: Date.now() })
    .onConflictDoUpdate({
      target: appSettingsValues.key,
      set: { value: week, updatedAt: Date.now() },
      setWhere: sql`${appSettingsValues.value} < ${week}`,
    })
    .run();

  return result.changes === 1;
}
