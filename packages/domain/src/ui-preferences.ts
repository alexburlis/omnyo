import { z } from "zod";
import { DEFAULT_SERVICE_TIER } from "./shared-types.js";

const UI_PREFERENCE_STRING_MAX_LENGTH = 1_024;

const UI_PREFERENCE_LIST_MAX_LENGTH = 10_000;

const sidebarOrganizationModeSchema = z.enum([
  "project",
  "chronological",
  "machine",
]);

export type SidebarOrganizationMode = z.infer<
  typeof sidebarOrganizationModeSchema
>;

const sidebarChronologicalSortSchema = z.enum([
  "updated",
  "created",
  "alpha",
  "none",
]);

const sidebarThreadGroupingSchema = z.union([z.literal("auto"), z.boolean()]);

const uiPreferenceStringSchema = z
  .string()
  .min(1)
  .max(UI_PREFERENCE_STRING_MAX_LENGTH);

const uiPreferenceStringListSchema = z
  .array(uiPreferenceStringSchema)
  .max(UI_PREFERENCE_LIST_MAX_LENGTH);

const sidebarHiddenGroupsSchema = z
  .array(uiPreferenceStringSchema.regex(/^(project|section|machine):\S+$/))
  .max(UI_PREFERENCE_LIST_MAX_LENGTH)
  .transform((value) => [...new Set(value)]);

export const MODEL_PICKER_FAVORITES_MAX = 24;

const modelPickerFavoriteSchema = z
  .object({
    providerId: uiPreferenceStringSchema,
    model: uiPreferenceStringSchema,
    reasoningLevel: uiPreferenceStringSchema,
    serviceTier: uiPreferenceStringSchema.default(DEFAULT_SERVICE_TIER),
  })
  .strict();

export type ModelPickerFavorite = z.output<typeof modelPickerFavoriteSchema>;

export function modelPickerFavoriteKey(favorite: ModelPickerFavorite): string {
  return [
    favorite.providerId,
    favorite.model,
    favorite.reasoningLevel,
    favorite.serviceTier,
  ].join("\0");
}

const modelPickerFavoritesSchema = z
  .array(modelPickerFavoriteSchema)
  .max(MODEL_PICKER_FAVORITES_MAX)
  .transform((favorites) => {
    const seen = new Set<string>();

    return favorites.filter((favorite) => {
      const key = modelPickerFavoriteKey(favorite);

      if (seen.has(key)) return false;
      seen.add(key);

      return true;
    });
  });

const modelPickerHiddenModelsSchema = z
  .record(uiPreferenceStringSchema, uiPreferenceStringListSchema)
  .transform((hiddenModels) => {
    const normalized: Record<string, string[]> = {};

    for (const [providerId, models] of Object.entries(hiddenModels)) {
      if (models.length > 0) normalized[providerId] = [...new Set(models)];
    }

    return normalized;
  });

export const UI_PREFERENCE_KEYS = [
  "sidebar.organizationMode",
  "sidebar.threadGrouping.environment",
  "sidebar.chronologicalSort",
  "sidebar.sortDirection",
  "sidebar.sectionOrder",
  "sidebar.manualSectionOrder",
  "sidebar.machineSectionOrder",
  "sidebar.hiddenGroups",
  "sidebar.footerOrder",
  "sidebar.hiddenFooterItems",
  "sidebar.pluginPanelOrder",
  "sidebar.visiblePluginPanels",
  "sidebar.threadListProvider",
  "infoPanel.collapsedSections",
  "modelPicker.favorites",
  "modelPicker.hiddenModels",
  "modelPicker.footerFavorites",
] as const;

export type UiPreferenceKey = (typeof UI_PREFERENCE_KEYS)[number];

const uiPreferenceKeySchema = z.enum(UI_PREFERENCE_KEYS);

export function isUiPreferenceKey(value: string): value is UiPreferenceKey {
  return uiPreferenceKeySchema.safeParse(value).success;
}

interface UiPreferenceDefinition<Schema extends z.ZodTypeAny = z.ZodTypeAny> {
  schema: Schema;
  defaultValue: z.infer<Schema>;
  description: string;
}

function defineUiPreference<Schema extends z.ZodTypeAny>(
  schema: Schema,
  defaultValue: z.infer<Schema>,
  description: string,
): UiPreferenceDefinition<Schema> {
  return { schema, defaultValue, description };
}

export const uiPreferenceDefinitions = {
  "sidebar.organizationMode": defineUiPreference(
    sidebarOrganizationModeSchema,
    "chronological",
    "How the sidebar groups threads: by project, Custom (chronological), or by machine. New installations default to Custom; migrated installations with existing work or preferences fall back to By project.",
  ),
  "sidebar.threadGrouping.environment": defineUiPreference(
    sidebarThreadGroupingSchema,
    "auto",
    "Whether sibling threads sharing a worktree environment collapse into one row. auto groups them in every organization mode except Custom.",
  ),
  "sidebar.chronologicalSort": defineUiPreference(
    sidebarChronologicalSortSchema,
    "updated",
    "Sort order for the chronological sidebar organization.",
  ),
  "sidebar.sortDirection": defineUiPreference(
    z.enum(["default", "ascending", "descending"]),
    "default",
    "Sidebar thread sort direction; default preserves the selected field's original direction.",
  ),
  "sidebar.sectionOrder": defineUiPreference(
    uiPreferenceStringListSchema,
    ["pinned", "projects", "threads"],
    "Top-level section order when the sidebar is organized by project.",
  ),
  "sidebar.manualSectionOrder": defineUiPreference(
    uiPreferenceStringListSchema,
    ["pinned", "sections", "threads"],
    "Top-level section order when the sidebar is organized chronologically.",
  ),
  "sidebar.machineSectionOrder": defineUiPreference(
    uiPreferenceStringListSchema,
    ["pinned", "machines", "threads"],
    "Top-level section order when the sidebar is organized by machine.",
  ),
  "sidebar.hiddenGroups": defineUiPreference(
    sidebarHiddenGroupsSchema,
    [],
    "Project, custom section, and machine groups moved into More, using project:<id>, section:<id>, or machine:<id>. Setting this list replaces the hidden groups across all sidebar organizations; reset shows every group.",
  ),
  "sidebar.footerOrder": defineUiPreference(
    uiPreferenceStringListSchema,
    [],
    "Order of built-in and plugin sidebar footer actions.",
  ),
  "sidebar.hiddenFooterItems": defineUiPreference(
    uiPreferenceStringListSchema,
    [],
    "Footer action IDs moved into the More menu, plus pinned:<key> entries for gear-menu actions added to the footer. Setting this list replaces it, so keep any pinned entries; reset clears both.",
  ),
  "sidebar.pluginPanelOrder": defineUiPreference(
    uiPreferenceStringListSchema,
    [],
    "Order of navigation entries in the sidebar navigation strip.",
  ),
  "sidebar.visiblePluginPanels": defineUiPreference(
    uiPreferenceStringListSchema.nullable(),
    null,
    "Navigation entries shown in the sidebar navigation strip; null shows every entry.",
  ),
  "sidebar.threadListProvider": defineUiPreference(
    uiPreferenceStringSchema.transform((value) =>
      value === "__builtin__" ? "thread-list/thread-list" : value,
    ),
    "__automatic__",
    "Plugin that renders the sidebar thread list, or __automatic__ for the first installed thread list plugin other than the bundled thread-list/thread-list, falling back to it. Legacy __builtin__ resolves to thread-list/thread-list.",
  ),
  "infoPanel.collapsedSections": defineUiPreference(
    uiPreferenceStringListSchema,
    [],
    "Thread Info panel section ids that are collapsed, such as commits, uncommittedChanges, forks, or threadStorage.",
  ),
  "modelPicker.favorites": defineUiPreference(
    modelPickerFavoritesSchema,
    [],
    "Favorite provider, model, reasoning and speed combinations, in order, that the model picker offers as one-click choices.",
  ),
  "modelPicker.hiddenModels": defineUiPreference(
    modelPickerHiddenModelsSchema,
    {},
    "Models per provider that the model picker folds under More; search still finds them.",
  ),
  "modelPicker.footerFavorites": defineUiPreference(
    z.boolean(),
    true,
    "Whether desktop composers show model favorites as a one-click switcher; false keeps only the model button.",
  ),
} as const satisfies Record<UiPreferenceKey, UiPreferenceDefinition>;

export type UiPreferenceValue<Key extends UiPreferenceKey> = z.infer<
  (typeof uiPreferenceDefinitions)[Key]["schema"]
>;

export type UiPreferenceValues = {
  [Key in UiPreferenceKey]: UiPreferenceValue<Key>;
};

export function getUiPreferenceDefault<Key extends UiPreferenceKey>(
  key: Key,
): UiPreferenceValue<Key> {
  return uiPreferenceDefinitions[key].defaultValue as UiPreferenceValue<Key>;
}

export const defaultUiPreferences: UiPreferenceValues = Object.fromEntries(
  UI_PREFERENCE_KEYS.map((key) => [key, getUiPreferenceDefault(key)]),
) as UiPreferenceValues;

export type UiPreferenceParseResult<Key extends UiPreferenceKey> =
  | { success: true; value: UiPreferenceValue<Key> }
  | { success: false; message: string };

export function parseUiPreferenceValue<Key extends UiPreferenceKey>(
  key: Key,
  value: unknown,
): UiPreferenceParseResult<Key> {
  const schema: z.ZodTypeAny = uiPreferenceDefinitions[key].schema;
  const parsed = schema.safeParse(value);

  if (parsed.success) {
    return { success: true, value: parsed.data as UiPreferenceValue<Key> };
  }

  return {
    success: false,
    message: parsed.error.issues.map((issue) => issue.message).join("; "),
  };
}

export function describeUiPreference(key: UiPreferenceKey): string {
  return uiPreferenceDefinitions[key].description;
}

export interface UiPreferenceEntry<
  Key extends UiPreferenceKey = UiPreferenceKey,
> {
  revision: number;
  value: UiPreferenceValue<Key>;
}

export type UiPreferenceEntries = {
  [Key in UiPreferenceKey]: UiPreferenceEntry<Key>;
};
