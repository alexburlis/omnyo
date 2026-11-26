import { and, eq, inArray, sql } from "drizzle-orm";
import {
  aiServiceSelectionSchema,
  AI_TASKS,
  appKeybindingOverridesSchema,
  appSettingsSchema,
  defaultAiServiceSelections,
  defaultAppSettings,
  usageConsentSchema,
  disabledProviderIdsSchema,
  pluginOmnyoManifestSchema,
  type AiServiceSelection,
  type AiServiceSelections,
  type AiTask,
  type AppKeybindingOverrides,
  type AppSettings,
  claudeProfileSelectionSchema,
  type ClaudeProfileSelection,
} from "@omnyo/domain";
import {
  prepareCachedQuery,
  type DbConnection,
  type DbQueryConnection,
} from "../connection.js";
import { appSettingsValues } from "../schema.js";

const appSettingsKeySchema = appSettingsSchema.keyof();

const appSettingsKeys = appSettingsKeySchema.options;

const KEYBINDING_OVERRIDES_KEY = "keybindingOverrides";

const AI_SERVICE_SELECTIONS_KEY = "aiServiceSelections";

const PLUGIN_SAFE_MODE_KEY = "pluginSafeMode";

const DISABLED_PROVIDER_IDS_KEY = "disabledProviderIds";

const LEGACY_DIAGNOSTIC_EVENTS_KEY = "showUnhandledProviderEvents";

const NATIVE_CLAUDE_PROFILES_PILOT_KEY = "nativeClaudeProfilesOwnerPilot";

function claudeProfileDefaultKey(
  hostId: string,
  projectId: string | null,
): string {
  return `nativeClaudeProfileDefault:${JSON.stringify([hostId, projectId])}`;
}

export function getNativeClaudeProfilesOwnerPilot(db: DbConnection): boolean {
  const row = db
    .select({ value: appSettingsValues.value })
    .from(appSettingsValues)
    .where(eq(appSettingsValues.key, NATIVE_CLAUDE_PROFILES_PILOT_KEY))
    .get();

  return row !== undefined && parseStoredValue(row.value) === true;
}

export function setNativeClaudeProfilesOwnerPilot(
  db: DbConnection,
  enabled: boolean,
): void {
  writeValue(db, NATIVE_CLAUDE_PROFILES_PILOT_KEY, enabled, Date.now());
}

export function getNativeClaudeProfileDefault(
  db: DbConnection,
  args: { hostId: string; projectId: string | null },
): ClaudeProfileSelection | null {
  const row = db
    .select({ value: appSettingsValues.value })
    .from(appSettingsValues)
    .where(
      eq(
        appSettingsValues.key,
        claudeProfileDefaultKey(args.hostId, args.projectId),
      ),
    )
    .get();

  if (row === undefined) return null;

  const parsed = claudeProfileSelectionSchema.safeParse(
    parseStoredValue(row.value),
  );

  return parsed.success ? parsed.data : null;
}

export function setNativeClaudeProfileDefault(
  db: DbConnection,
  args: {
    hostId: string;
    projectId: string | null;
    selection: ClaudeProfileSelection;
  },
): void {
  writeValue(
    db,
    claudeProfileDefaultKey(args.hostId, args.projectId),
    args.selection,
    Date.now(),
  );
}

export function clearNativeClaudeProfileDefaults(
  db: DbConnection,
  args: { hostId: string; profileId: string },
): void {
  const prefix = `nativeClaudeProfileDefault:[${JSON.stringify(args.hostId)},`;
  const { key, value } = appSettingsValues;
  db.delete(appSettingsValues)
    .where(
      and(
        sql`substr(${key}, 1, length(${prefix})) = ${prefix}`,
        sql`case when json_valid(${value}) then json_extract(${value}, '$.kind') = 'profile' and json_extract(${value}, '$.profileId') = ${args.profileId} else 0 end`,
      ),
    )
    .run();
}

function parseStoredValue(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function writeValue(
  db: DbQueryConnection,
  key: string,
  value: unknown,
  updatedAt: number,
): void {
  const text = JSON.stringify(value);
  db.insert(appSettingsValues)
    .values({ key, value: text, updatedAt })
    .onConflictDoUpdate({
      target: appSettingsValues.key,
      set: { value: text, updatedAt },
    })
    .run();
}

const prepareListAppSettingsValues = (db: DbQueryConnection) =>
  db
    .select({ key: appSettingsValues.key, value: appSettingsValues.value })
    .from(appSettingsValues)
    .where(
      inArray(appSettingsValues.key, [
        ...appSettingsKeys,
        LEGACY_DIAGNOSTIC_EVENTS_KEY,
      ]),
    )
    .prepare();

export function getAppSettings(db: DbConnection): AppSettings {
  const values: Record<string, unknown> = { ...defaultAppSettings };
  const rows = prepareCachedQuery(db, prepareListAppSettingsValues).all();

  const legacyDiagnosticEvents = rows.find(
    (row) => row.key === LEGACY_DIAGNOSTIC_EVENTS_KEY,
  );

  if (legacyDiagnosticEvents) {
    const parsed = appSettingsSchema.shape.showDiagnosticEvents.safeParse(
      parseStoredValue(legacyDiagnosticEvents.value),
    );

    if (parsed.success) values.showDiagnosticEvents = parsed.data;
  }

  for (const row of rows) {
    const key = appSettingsKeySchema.safeParse(row.key);

    if (!key.success) continue;

    const value = appSettingsSchema.shape[key.data].safeParse(
      parseStoredValue(row.value),
    );

    if (value.success) values[key.data] = value.data;
  }

  if (!rows.some((row) => row.key === "usageConsent")) {
    const legacyRefusal = rows.some(
      (row) =>
        row.key === "telemetryEnabled" && parseStoredValue(row.value) === false,
    );

    values.usageConsent = usageConsentSchema.parse({
      ...defaultAppSettings.usageConsent,
      ...(legacyRefusal
        ? {
            count: "declined",
            product: "declined",
            countSource: "legacy-refusal",
            productSource: "legacy-refusal",
          }
        : {}),
    });
  }

  return appSettingsSchema.parse(values);
}

export function migrateUsageConsent(db: DbConnection): void {
  db.insert(appSettingsValues)
    .values({
      key: "usageConsent",
      value: JSON.stringify(getAppSettings(db).usageConsent),
      updatedAt: Date.now(),
    })
    .onConflictDoNothing()
    .run();
}

export function setAppSettings(db: DbConnection, settings: AppSettings): void {
  const updatedAt = Date.now();
  db.transaction((transaction) => {
    for (const key of appSettingsKeys) {
      writeValue(transaction, key, settings[key], updatedAt);
    }

    transaction
      .delete(appSettingsValues)
      .where(eq(appSettingsValues.key, LEGACY_DIAGNOSTIC_EVENTS_KEY))
      .run();
  });
}

export function getAppKeybindingOverrides(
  db: DbConnection,
): AppKeybindingOverrides {
  const row = db
    .select({ value: appSettingsValues.value })
    .from(appSettingsValues)
    .where(eq(appSettingsValues.key, KEYBINDING_OVERRIDES_KEY))
    .get();

  if (row === undefined) {
    return [];
  }

  return appKeybindingOverridesSchema.parse(parseStoredValue(row.value));
}

export function setAppKeybindingOverrides(
  db: DbConnection,
  overrides: AppKeybindingOverrides,
): void {
  writeValue(db, KEYBINDING_OVERRIDES_KEY, overrides, Date.now());
}

export function getAiServiceSelections(db: DbConnection): AiServiceSelections {
  const row = db
    .select({ value: appSettingsValues.value })
    .from(appSettingsValues)
    .where(eq(appSettingsValues.key, AI_SERVICE_SELECTIONS_KEY))
    .get();

  const stored: unknown =
    row === undefined ? undefined : parseStoredValue(row.value);

  const selections: AiServiceSelections = { ...defaultAiServiceSelections };

  if (typeof stored !== "object" || stored === null) return selections;

  for (const task of AI_TASKS) {
    const parsed = aiServiceSelectionSchema.safeParse(
      Reflect.get(stored, task),
    );

    if (!parsed.success) continue;
    const selection = parsed.data;
    selections[task] =
      task === "voice" &&
      selection.mode === "service" &&
      selection.pluginId === "provider-codex" &&
      selection.serviceId === "codex"
        ? { mode: "service", pluginId: "local-voice", serviceId: "local-voice" }
        : selection;
  }

  return selections;
}

export function setAiServiceSelection(
  db: DbConnection,
  task: AiTask,
  selection: AiServiceSelection,
): AiServiceSelections {
  const selections = { ...getAiServiceSelections(db), [task]: selection };
  writeValue(db, AI_SERVICE_SELECTIONS_KEY, selections, Date.now());

  return selections;
}

export function getPluginSafeMode(db: DbConnection): boolean {
  const row = db
    .select({ value: appSettingsValues.value })
    .from(appSettingsValues)
    .where(eq(appSettingsValues.key, PLUGIN_SAFE_MODE_KEY))
    .get();

  return row !== undefined && parseStoredValue(row.value) === true;
}

export function setPluginSafeMode(db: DbConnection, enabled: boolean): void {
  writeValue(db, PLUGIN_SAFE_MODE_KEY, enabled, Date.now());
}

export function getDisabledProviderIds(db: DbConnection): string[] {
  const row = db
    .select({ value: appSettingsValues.value })
    .from(appSettingsValues)
    .where(eq(appSettingsValues.key, DISABLED_PROVIDER_IDS_KEY))
    .get();

  const parsed = disabledProviderIdsSchema.safeParse(
    row === undefined ? [] : parseStoredValue(row.value),
  );

  return parsed.success ? parsed.data : [];
}

export function setDisabledProviderIds(
  db: DbConnection,
  providerIds: readonly string[],
): void {
  writeValue(db, DISABLED_PROVIDER_IDS_KEY, providerIds, Date.now());
}

const pluginProviderCatalogSchema =
  pluginOmnyoManifestSchema.shape.experimental_providers
    .unwrap()
    .element.omit({ kind: true })
    .array();

function pluginProviderCatalogKey(pluginId: string): string {
  return `pluginProviders:${pluginId}`;
}

export function getDisabledPluginProviderCatalog(
  db: DbConnection,
  pluginId: string,
): Array<{ id: string; displayName: string }> {
  const row = db
    .select({ value: appSettingsValues.value })
    .from(appSettingsValues)
    .where(eq(appSettingsValues.key, pluginProviderCatalogKey(pluginId)))
    .get();

  const parsed = pluginProviderCatalogSchema.safeParse(
    row === undefined ? [] : parseStoredValue(row.value),
  );

  return parsed.success ? parsed.data : [];
}

export function setDisabledPluginProviderCatalog(
  db: DbConnection,
  pluginId: string,
  providers: Array<{ id: string; displayName: string }>,
): void {
  writeValue(db, pluginProviderCatalogKey(pluginId), providers, Date.now());
}

export function forgetPluginProviders(
  db: DbConnection,
  pluginId: string,
  providerIds: ReadonlySet<string>,
): void {
  const disabledProviderIds = getDisabledProviderIds(db);
  db.transaction((transaction) => {
    writeValue(
      transaction,
      DISABLED_PROVIDER_IDS_KEY,
      disabledProviderIds.filter((id) => !providerIds.has(id)),
      Date.now(),
    );
    transaction
      .delete(appSettingsValues)
      .where(eq(appSettingsValues.key, pluginProviderCatalogKey(pluginId)))
      .run();
  });
}
