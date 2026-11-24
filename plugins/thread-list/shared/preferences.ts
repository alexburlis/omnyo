import { z } from "zod";

const STRING_MAX_LENGTH = 1_024;

const LIST_MAX_LENGTH = 10_000;

const listItemSchema = z.string().min(1).max(STRING_MAX_LENGTH);

const stringListSchema = z.array(listItemSchema).max(LIST_MAX_LENGTH);

export const organizationModeSchema = z.enum([
  "project",
  "chronological",
  "machine",
]);

export type OrganizationMode = z.infer<typeof organizationModeSchema>;

export const chronologicalSortSchema = z.enum([
  "updated",
  "created",
  "alpha",
  "none",
]);

export type ChronologicalSort = z.infer<typeof chronologicalSortSchema>;

export const sortDirectionSchema = z.enum([
  "default",
  "ascending",
  "descending",
]);

export type SortDirection = z.infer<typeof sortDirectionSchema>;

export const environmentGroupingSchema = z.union([
  z.literal("auto"),
  z.boolean(),
]);

export const THREAD_ROW_ACTION_LIMIT = 3;

const CORE_THREAD_ACTION_OWNER = "omnyo--core";

const LEGACY_THREAD_ROW_ACTION_KEYS_V1 = {
  split: "omnyo--core/split",
  copyLink: "omnyo--core/copyLink",
  read: "omnyo--core/read",
  pin: "omnyo--core/pin",
  move: "thread-list/move",
  rename: "omnyo--core/rename",
  archive: "omnyo--core/archive",
} as const;

type LegacyThreadRowActionIdV1 = keyof typeof LEGACY_THREAD_ROW_ACTION_KEYS_V1;

const LEGACY_CORE_THREAD_ACTION_IDS_V1: ReadonlySet<string> = new Set([
  "split",
  "newThreadInEnvironment",
  "copyLink",
  "copyId",
  "read",
  "pin",
  "shelve",
  "rename",
  "archive",
  "delete",
]);

function isLegacyThreadRowActionIdV1(
  value: string,
): value is LegacyThreadRowActionIdV1 {
  return Object.hasOwn(LEGACY_THREAD_ROW_ACTION_KEYS_V1, value);
}

function importLegacyThreadRowActionKeyV1(value: string): string {
  if (isLegacyThreadRowActionIdV1(value))
    return LEGACY_THREAD_ROW_ACTION_KEYS_V1[value];
  const slash = value.indexOf("/");

  if (slash === -1) return value;
  const owner = value.slice(0, slash);
  const action = value.slice(slash + 1);

  return owner === "core" && LEGACY_CORE_THREAD_ACTION_IDS_V1.has(action)
    ? `${CORE_THREAD_ACTION_OWNER}/${action}`
    : value;
}

export const threadRowActionKeySchema = z
  .string()
  .transform(importLegacyThreadRowActionKeyV1)
  .pipe(
    z.string().regex(/^[^/\s]+\/[^/\s]+$/, {
      message: "Row actions are thread action keys: <owner>/<id>",
    }),
  );

const collapsibleSectionIdSchema = z.enum(["pinned", "threads"]);

const hiddenGroupsSchema = z
  .array(
    z.union([
      z.literal("threads"),
      listItemSchema.regex(/^(project|section|machine):\S+$/),
    ]),
  )
  .max(LIST_MAX_LENGTH)
  .transform((value) => [...new Set(value)]);

function definePreference<Schema extends z.ZodTypeAny>(
  schema: Schema,
  defaultValue: z.infer<Schema>,
  description: string,
  legacyKey: string | null,
) {
  return { schema, defaultValue, description, legacyKey };
}

export const preferenceDefinitions = {
  showProviderIcons: definePreference(
    z.boolean(),
    true,
    "Show each thread's agent provider icon before its title.",
    null,
  ),
  showEmptyProjects: definePreference(
    z.boolean(),
    true,
    "Show project groups that have no visible threads when organized by project.",
    null,
  ),
  threadLifecycles: definePreference(
    z
      .array(z.enum(["active", "archived"]))
      .min(1)
      .max(2)
      .refine((value) => new Set(value).size === value.length),
    ["active"],
    "Thread lifecycles shown in the list: active, archived, or both. At least one is required. Shelved threads load into the Shelf whenever active threads are shown.",
    null,
  ),
  organizationMode: definePreference(
    organizationModeSchema,
    "chronological",
    "How the list groups threads: by project, chronologically with custom sections, or by machine.",
    "sidebar.organizationMode",
  ),
  environmentGrouping: definePreference(
    environmentGroupingSchema,
    "auto",
    "Whether sibling threads sharing a worktree collapse into one row. auto groups them in every organization except chronological.",
    "sidebar.threadGrouping.environment",
  ),
  groupByReadStatus: definePreference(
    z.boolean(),
    false,
    "List threads that show an unread dot above the rest, keeping the selected sort within each group. The open thread keeps its place until another thread is opened.",
    null,
  ),
  chronologicalSort: definePreference(
    chronologicalSortSchema,
    "updated",
    "Sort field for the chronological organization.",
    "sidebar.chronologicalSort",
  ),
  sortDirection: definePreference(
    sortDirectionSchema,
    "default",
    "Sort direction; default keeps the field's natural direction.",
    "sidebar.sortDirection",
  ),
  sectionOrder: definePreference(
    stringListSchema,
    ["pinned", "projects", "threads", "shelf"],
    "Top-level order when organized by project. Built-in sections are pinned, threads, and shelf. An order without shelf ends with it.",
    "sidebar.sectionOrder",
  ),
  manualSectionOrder: definePreference(
    stringListSchema,
    ["pinned", "sections", "threads", "shelf"],
    "Top-level order when organized chronologically. Built-in sections are pinned, threads, and shelf. An order without shelf ends with it.",
    "sidebar.manualSectionOrder",
  ),
  machineSectionOrder: definePreference(
    stringListSchema,
    ["pinned", "machines", "threads", "shelf"],
    "Top-level order when organized by machine. Built-in sections are pinned, threads, and shelf. An order without shelf ends with it.",
    "sidebar.machineSectionOrder",
  ),
  hiddenGroups: definePreference(
    hiddenGroupsSchema,
    [],
    "Groups moved into More: threads, project:<id>, section:<id>, or machine:<id>.",
    "sidebar.hiddenGroups",
  ),
  rowActions: definePreference(
    z
      .array(threadRowActionKeySchema)
      .max(LIST_MAX_LENGTH)
      .transform((value) => [...new Set(value)])
      .refine((value) => value.length <= THREAD_ROW_ACTION_LIMIT, {
        message: `Choose at most ${THREAD_ROW_ACTION_LIMIT} row actions`,
      }),
    ["omnyo--core/archive"],
    `Up to ${THREAD_ROW_ACTION_LIMIT} quick actions shown on a thread row's hover, left to right before its actions menu, as thread action keys: omnyo--core/split, omnyo--core/copyLink, omnyo--core/read, omnyo--core/pin, omnyo--core/shelve, thread-list/move, omnyo--core/rename, omnyo--core/archive, or a plugin's <pluginId>/<actionId>. Bare legacy ids such as archive and core/<id> keys are accepted. An empty list shows only the menu. Archived rows always show omnyo--core/archive and Shelf rows always show omnyo--core/shelve instead.`,
    null,
  ),
  collapsedSections: definePreference(
    z.array(collapsibleSectionIdSchema).max(LIST_MAX_LENGTH),
    [],
    "Built-in sections (pinned, threads) that are collapsed. The Shelf uses shelfExpanded.",
    null,
  ),
  shelfExpanded: definePreference(
    z.boolean(),
    false,
    "Whether the Shelf section is open. It starts folded and appears only while shelved threads exist.",
    null,
  ),
  collapsedProjects: definePreference(
    stringListSchema,
    [],
    "Project ids whose rows are collapsed.",
    null,
  ),
  collapsedEnvironments: definePreference(
    stringListSchema,
    [],
    "Environment ids whose rows are collapsed.",
    null,
  ),
  collapsedThreadSections: definePreference(
    stringListSchema,
    [],
    "Custom section ids that are collapsed.",
    null,
  ),
  collapsedMachines: definePreference(
    stringListSchema,
    [],
    "Machine ids whose rows are collapsed.",
    null,
  ),
  collapsedGroups: definePreference(
    stringListSchema,
    [],
    "Chat group ids whose folders are collapsed.",
    null,
  ),
} as const;

export type PreferenceKey = keyof typeof preferenceDefinitions;

export const PREFERENCE_KEYS = Object.keys(
  preferenceDefinitions,
) as PreferenceKey[];

export type PreferenceValue<Key extends PreferenceKey> = z.infer<
  (typeof preferenceDefinitions)[Key]["schema"]
>;

export type PreferenceValues = {
  [Key in PreferenceKey]: PreferenceValue<Key>;
};

export function isPreferenceKey(value: string): value is PreferenceKey {
  return Object.hasOwn(preferenceDefinitions, value);
}

export function getPreferenceDefault<Key extends PreferenceKey>(
  key: Key,
): PreferenceValue<Key> {
  return preferenceDefinitions[key].defaultValue as PreferenceValue<Key>;
}

export function defaultPreferences(): PreferenceValues {
  return Object.fromEntries(
    PREFERENCE_KEYS.map((key) => [key, getPreferenceDefault(key)]),
  ) as PreferenceValues;
}

export type PreferenceParseResult<Key extends PreferenceKey> =
  | { success: true; value: PreferenceValue<Key> }
  | { success: false; message: string };

export function parsePreferenceValue<Key extends PreferenceKey>(
  key: Key,
  value: unknown,
): PreferenceParseResult<Key> {
  const schema: z.ZodTypeAny = preferenceDefinitions[key].schema;
  const parsed = schema.safeParse(value);

  if (parsed.success) {
    return { success: true, value: parsed.data as PreferenceValue<Key> };
  }

  return {
    success: false,
    message: parsed.error.issues.map((issue) => issue.message).join("; "),
  };
}

export function parseStoredPreferenceValue<Key extends PreferenceKey>(
  key: Key,
  value: unknown,
): PreferenceParseResult<Key> {
  return parsePreferenceValue(
    key,
    key === "rowActions" ? knownRowActions(value) : value,
  );
}

function knownRowActions(value: unknown): unknown {
  if (!Array.isArray(value)) return value;

  const known = value.flatMap((id) => {
    const parsed = threadRowActionKeySchema.safeParse(id);

    return parsed.success ? [parsed.data] : [];
  });

  return [...new Set(known)].slice(0, THREAD_ROW_ACTION_LIMIT);
}

export function describePreference(key: PreferenceKey): string {
  return preferenceDefinitions[key].description;
}

export const PREFERENCES_CHANGED_CHANNEL = "preferences";

export const preferenceWriteReplySchema = z
  .object({
    key: z.enum(PREFERENCE_KEYS as [PreferenceKey, ...PreferenceKey[]]),
    value: z.unknown(),
  })
  .strict();

export const preferencesChangedSignalSchema = z
  .object({
    key: z.enum(PREFERENCE_KEYS as [PreferenceKey, ...PreferenceKey[]]),
    value: z.unknown(),
    origin: z.string().nullable(),
  })
  .strict();
