import {
  jsonValueSchema,
  pluginCatalogCategoryIdSchema,
  pluginMarketplaceCategorySchema,
  pluginMarketplaceCollectionIdSchema,
  pluginMarketplaceCollectionPluginIdSchema,
} from "@omnyo/domain";
import { z } from "zod";

export const pluginRuntimeStatusSchema = z.enum([
  "starting",
  "running",
  "error",
  "incompatible",
  "missing",
  "disabled",
  "degraded",
  "needs-configuration",
]);

export type PluginRuntimeStatus = z.infer<typeof pluginRuntimeStatusSchema>;

export const pluginUpdateOutcomeSchema = z.enum([
  "current",
  "update-available",
  "pinned",
  "incompatible",
  "unavailable",
]);

export const pluginResolvedVersionSchema = z.object({
  version: z.string(),
  display: z.string(),
});

export const pluginUpdateCheckEntrySchema = z.object({
  id: z.string(),
  outcome: pluginUpdateOutcomeSchema,
  devMode: z.literal(true).optional(),
  installed: pluginResolvedVersionSchema,
  candidate: pluginResolvedVersionSchema.optional(),
  blocked: z
    .object({ version: z.string(), reasons: z.array(z.string()) })
    .optional(),
  detail: z.string().optional(),
});

export type PluginUpdateCheckEntry = z.infer<
  typeof pluginUpdateCheckEntrySchema
>;

export const pluginUpdateCheckRequestSchema = z
  .object({ id: z.string().min(1).optional() })
  .strict();

export const pluginUpdateCheckResponseSchema = z.object({
  results: z.array(pluginUpdateCheckEntrySchema),
});

export const MAX_BUNDLED_PLUGIN_BYTES = 32 * 1024 * 1024;

export const MAX_BUNDLED_PLUGIN_FILES = 4096;

export const MAX_BUNDLED_PLUGIN_REQUEST_BYTES = 48 * 1024 * 1024;

export const pluginApplyUpdateRequestSchema = z
  .object({
    bundledCandidate: z
      .object({
        expectedVersion: z.string().min(1),
        expectedArtifactId: z.string().min(1).nullable(),
        files: z
          .array(
            z
              .object({
                path: z.string().min(1).max(1024),
                base64: z
                  .string()
                  .max(Math.ceil(MAX_BUNDLED_PLUGIN_BYTES / 3) * 4),
                sha256: z.string().regex(/^[a-f0-9]{64}$/u),
              })
              .strict(),
          )
          .min(1)
          .max(MAX_BUNDLED_PLUGIN_FILES),
      })
      .strict()
      .optional(),
  })
  .strict();

export type PluginApplyUpdateRequest = z.infer<
  typeof pluginApplyUpdateRequestSchema
>;

export const pluginApplyUpdateResultSchema = z.object({
  applied: z.boolean(),
  from: pluginResolvedVersionSchema,
  to: pluginResolvedVersionSchema.optional(),
  outcome: z.enum(["current", "updated", "rolled-back"]),
  detail: z.string().optional(),
});

export type PluginApplyUpdateResult = z.infer<
  typeof pluginApplyUpdateResultSchema
>;

export const pluginUpdatePhaseSchema = z.enum([
  "preparing",
  "activating",
  "checking",
  "rolling-back",
]);

export type PluginUpdatePhase = z.infer<typeof pluginUpdatePhaseSchema>;

const pluginUpdateJobFields = {
  id: z.string().min(1),
  pluginId: z.string().min(1),
  displayName: z.string().min(1),
};

export const pluginUpdateJobSchema = z.discriminatedUnion("state", [
  z.object({ ...pluginUpdateJobFields, state: z.literal("queued") }),
  z.object({
    ...pluginUpdateJobFields,
    state: z.literal("running"),
    phase: pluginUpdatePhaseSchema,
  }),
  z.object({
    ...pluginUpdateJobFields,
    state: z.literal("completed"),
    result: pluginApplyUpdateResultSchema,
  }),
  z.object({
    ...pluginUpdateJobFields,
    state: z.literal("failed"),
    error: z.string(),
  }),
]);

export type PluginUpdateJob = z.infer<typeof pluginUpdateJobSchema>;

export const pluginUpdateJobResponseSchema = z.object({
  job: pluginUpdateJobSchema,
});

export const pluginUpdateJobListResponseSchema = z.object({
  jobs: z.array(pluginUpdateJobSchema),
});

export const pluginSourceHistoryEntrySchema = z.object({
  version: z.string(),
  activatedAt: z.number(),
});

export const pluginSourceDetailSchema = z.object({
  activeArtifactId: z.string().nullable().default(null),
  requested: z.string(),
  resolved: z.string(),
  subdirectory: z.string().optional(),
  range: z.string().optional(),
  tagPrefix: z.string().optional(),
  resolvedTag: z.string().optional(),
  integrity: z.string().optional(),
  registry: z.string().optional(),
  engines: z
    .object({
      omnyo: z.string().optional(),
      omnyoPluginSdk: z.string().optional(),
    })
    .strict(),
  installedAt: z.number().optional(),
  history: z.array(pluginSourceHistoryEntrySchema),
});

export type PluginSourceDetail = z.infer<typeof pluginSourceDetailSchema>;

export const pluginUpdateStateSchema = z.object({
  outcome: pluginUpdateOutcomeSchema.optional(),
  detail: z.string().optional(),
  availableVersion: z.string().optional(),
  blockedVersion: z.string().optional(),
  blockedReasons: z.array(z.string()).optional(),
  lastCheckAt: z.number().optional(),
  lastFailure: z
    .object({ version: z.string(), at: z.number(), detail: z.string() })
    .optional(),
});

export const pluginHandlerStatsSchema = z.object({
  count: z.number(),
  totalMs: z.number(),
  maxMs: z.number(),
  errorCount: z.number(),
});

export type PluginHandlerStats = z.infer<typeof pluginHandlerStatsSchema>;

export const pluginServiceEntrySchema = z.object({
  name: z.string(),
  state: z.enum(["running", "backoff", "stopped"]),
});

export const pluginScheduleEntrySchema = z.object({
  name: z.string(),
  cron: z.string(),
  nextRunAt: z.number(),
  lastRunAt: z.number().nullable(),
  lastStatus: z.enum(["running", "ok", "error"]).nullable(),
  lastError: z.string().nullable(),
});

export const pluginAppStateSchema = z.object({
  hasApp: z.boolean(),
  bundle: z
    .object({
      jsUrl: z.string(),
      cssUrl: z.string().nullable(),
      jsBytes: z.number().int().nonnegative(),
      hash: z.string(),
      sdkMajor: z.number(),
      sdkVersion: z.string(),
      compatible: z.boolean(),
    })
    .nullable(),
});

export const pluginCapabilitySchema = z.object({
  kind: z.enum(["skill", "theme", "agent-tool", "thread-integration"]),
  id: z.string(),
  label: z.string(),
  detail: z.string().nullable(),
});

export type PluginCapability = z.infer<typeof pluginCapabilitySchema>;

export const pluginCapabilitySummarySchema = z.array(pluginCapabilitySchema);

export type PluginCapabilitySummary = z.infer<
  typeof pluginCapabilitySummarySchema
>;

export const installedPluginSchema = z.object({
  id: z.string(),
  source: z.string(),
  rootDir: z.string(),
  version: z.string(),
  provenance: z.enum(["builtin", "direct", "catalog"]),
  isOrphanedBuiltin: z.boolean(),
  removable: z.boolean().default(false),
  catalogEntryId: z.string().optional(),
  catalogMarketplaceName: z.string().optional(),
  publisherLabel: z.string().nullable().default(null),
  official: z.boolean().default(false),
  author: z
    .lazy(() => pluginCatalogAuthorSchema)
    .nullable()
    .optional(),
  repositoryUrl: z.string().nullable().default(null),
  sourceDisplay: z.string(),
  updateState: pluginUpdateStateSchema,
  enabled: z.boolean(),
  consolidatedInto: z.string().optional(),
  description: z.string().nullable(),
  name: z.string().nullable(),
  shortName: z.string().nullable().default(null),
  categoryId: pluginCatalogCategoryIdSchema.optional(),
  category: z.string().optional(),
  screenshots: z.array(z.string()),
  collections: z.array(
    z.object({
      id: pluginMarketplaceCollectionIdSchema,
      rank: z.number().int().nonnegative(),
    }),
  ),
  publishedAt: z.iso.datetime({ offset: true }).optional(),
  updatedAt: z.iso.datetime({ offset: true }).optional(),
  icon: z.string().nullable(),
  iconUrl: z.string().nullable(),
  status: pluginRuntimeStatusSchema,
  statusDetail: z.string().nullable(),
  handlerStats: pluginHandlerStatsSchema,
  services: z.array(pluginServiceEntrySchema),
  schedules: z.array(pluginScheduleEntrySchema),
  cliCommand: z.object({ name: z.string(), summary: z.string() }).nullable(),
  capabilities: pluginCapabilitySummarySchema.default([]),
  hasSettings: z.boolean(),
  app: pluginAppStateSchema,
  logoUrl: z.string().nullable(),
  logoDarkUrl: z.string().nullable(),
  providerIds: z.array(z.string()),

  icons: z.record(z.string(), z.string()),
});

export type InstalledPlugin = z.infer<typeof installedPluginSchema>;

export const pluginListResponseSchema = z.object({
  plugins: z.array(installedPluginSchema),
});

export type PluginListResponse = z.infer<typeof pluginListResponseSchema>;

export const pluginSourceSelectionSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("root") }).strict(),
  z
    .object({ kind: z.literal("subdirectory"), path: z.string().min(1) })
    .strict(),
  z.object({ kind: z.literal("entry"), name: z.string().min(1) }).strict(),
]);

export type PluginSourceSelection = z.infer<typeof pluginSourceSelectionSchema>;

export const ROOT_PLUGIN_SOURCE_SELECTION: PluginSourceSelection = {
  kind: "root",
};

export const pluginInstallRequestSchema = z
  .object({
    source: z.string().min(1),
    selection: pluginSourceSelectionSchema.default(
      ROOT_PLUGIN_SOURCE_SELECTION,
    ),
  })
  .strict();

export const PLUGIN_MARKETPLACE_NAME_PATTERN = /^[a-z0-9][a-z0-9-]*$/u;

export const pluginMarketplaceNameSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(PLUGIN_MARKETPLACE_NAME_PATTERN);

export const pluginCatalogInstallRequestSchema = z
  .object({
    entryId: z.string().min(1),
    marketplace: pluginMarketplaceNameSchema.optional(),
    confirmedSource: z.lazy(() => pluginCatalogResolvedSourceSchema).optional(),
  })
  .strict();

export const pluginInstallJobTargetSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("catalog"),
      entryId: z.string().min(1),
      marketplace: pluginMarketplaceNameSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("source"),
      source: z.string().min(1),
      selection: pluginSourceSelectionSchema,
    })
    .strict(),
]);

export type PluginInstallJobTarget = z.infer<
  typeof pluginInstallJobTargetSchema
>;

const pluginInstallJobFields = {
  id: z.string().min(1),
  target: pluginInstallJobTargetSchema,
  displayName: z.string().min(1),
};

export const pluginInstallJobSchema = z.discriminatedUnion("state", [
  z.object({ ...pluginInstallJobFields, state: z.literal("queued") }),
  z.object({ ...pluginInstallJobFields, state: z.literal("running") }),
  z.object({ ...pluginInstallJobFields, state: z.literal("cancelling") }),
  z.object({
    ...pluginInstallJobFields,
    state: z.literal("succeeded"),
    plugin: installedPluginSchema,
  }),
  z.object({
    ...pluginInstallJobFields,
    state: z.literal("failed"),
    error: z.string(),
  }),
  z.object({ ...pluginInstallJobFields, state: z.literal("cancelled") }),
]);

export type PluginInstallJob = z.infer<typeof pluginInstallJobSchema>;

export type PluginInstallJobState = PluginInstallJob["state"];

export const pluginInstallJobStartResponseSchema = z.object({
  ok: z.literal(true),
  job: pluginInstallJobSchema,
});

export const pluginInstallJobResponseSchema = z.object({
  job: pluginInstallJobSchema,
});

export const pluginInstallJobListResponseSchema = z.object({
  jobs: z.array(pluginInstallJobSchema),
});

export const pluginReloadResponseSchema = z.object({
  ok: z.literal(true),
  plugins: z.array(installedPluginSchema),
});

export type PluginReloadResponse = z.infer<typeof pluginReloadResponseSchema>;

export const pluginRemoveResponseSchema = z.object({ ok: z.literal(true) });

export type PluginRemoveResponse = z.infer<typeof pluginRemoveResponseSchema>;

const pluginSettingBaseSchema = {
  label: z.string().min(1),
  description: z.string().min(1).optional(),
  experimental_section: z
    .object({
      title: z.string().min(1),
      description: z.string().min(1).optional(),
    })
    .strict()
    .optional(),
};

export const pluginSettingDescriptorSchema = z.discriminatedUnion("type", [
  z
    .object({
      ...pluginSettingBaseSchema,
      type: z.literal("string"),
      secret: z.literal(true).optional(),
      experimental_multiline: z.boolean().optional(),
      experimental_placeholder: z.string().min(1).optional(),
      default: z.string().optional(),
    })
    .strict(),
  z
    .object({
      ...pluginSettingBaseSchema,
      type: z.literal("boolean"),
      default: z.boolean().optional(),
    })
    .strict(),
  z
    .object({
      ...pluginSettingBaseSchema,
      type: z.literal("number"),
      experimental_placeholder: z.string().min(1).optional(),
      default: z.number().finite().optional(),
    })
    .strict(),
  z
    .object({
      ...pluginSettingBaseSchema,
      type: z.literal("select"),
      options: z.array(z.string().min(1)).min(1),
      experimental_optionLabels: z
        .record(z.string().min(1), z.string().min(1))
        .optional(),
      default: z.string().optional(),
    })
    .strict(),
  z
    .object({
      ...pluginSettingBaseSchema,
      type: z.literal("project"),
      default: z.string().optional(),
    })
    .strict(),
]);

export type PluginSettingDescriptor = z.infer<
  typeof pluginSettingDescriptorSchema
>;

export const pluginSettingsResponseSchema = z.object({
  ok: z.literal(true),
  schema: z.record(z.string(), pluginSettingDescriptorSchema),
  values: z.record(z.string(), jsonValueSchema),
});

export type PluginSettingsResponse = z.infer<
  typeof pluginSettingsResponseSchema
>;

export const pluginSettingsUpdateRequestSchema = z
  .object({ values: z.record(z.string(), jsonValueSchema) })
  .strict();

export const pluginSafeModeRequestSchema = z
  .object({ enabled: z.boolean() })
  .strict();

export const pluginSafeModeResponseSchema = z.object({
  enabled: z.boolean(),
});

export type PluginSafeModeResponse = z.infer<
  typeof pluginSafeModeResponseSchema
>;

export const pluginSafeModeUpdateResponseSchema = z.object({
  enabled: z.boolean(),
  problems: z.array(z.string()),
});

export type PluginSafeModeUpdateResponse = z.infer<
  typeof pluginSafeModeUpdateResponseSchema
>;

export const pluginCachePruneRequestSchema = z
  .object({
    dryRun: z.boolean().optional().default(false),
    maxItems: z.number().int().min(1).max(1000).optional(),
    maxBytes: z
      .number()
      .int()
      .min(1)
      .max(100 * 1024 ** 3)
      .optional(),
  })
  .strict();

export type PluginCachePruneRequest = z.infer<
  typeof pluginCachePruneRequestSchema
>;

export const pluginCachePruneEntrySchema = z.object({
  pluginId: z.string().nullable(),
  version: z.string(),
  path: z.string(),
  bytes: z.number().int().nonnegative(),
});

export type PluginCachePruneEntry = z.infer<typeof pluginCachePruneEntrySchema>;

export const pluginCachePruneResponseSchema = z.object({
  dryRun: z.boolean(),
  removed: z.array(pluginCachePruneEntrySchema),
  bytes: z.number().int().nonnegative(),
  budget: z
    .object({
      maxItems: z.number().int().positive().nullable(),
      maxBytes: z.number().int().positive().nullable(),
    })
    .optional(),
});

export type PluginCachePruneResponse = z.infer<
  typeof pluginCachePruneResponseSchema
>;

export const pluginPathRelocationRequestSchema = z
  .object({
    from: z.string().min(1),
    to: z.string().min(1),
    dryRun: z.boolean().optional().default(false),
  })
  .strict();

export const pluginPathRelocationEntrySchema = z.object({
  pluginId: z.string(),
  from: z.string(),
  to: z.string(),
  mode: z.enum(["snapshot", "checkout"]),
  reloaded: z.boolean(),
});

export type PluginPathRelocationEntry = z.infer<
  typeof pluginPathRelocationEntrySchema
>;

export const pluginPathRelocationResponseSchema = z.object({
  dryRun: z.boolean(),
  relocated: z.array(pluginPathRelocationEntrySchema),
});

export type PluginPathRelocationResponse = z.infer<
  typeof pluginPathRelocationResponseSchema
>;

export const pluginTokenRequestSchema = z
  .object({ rotate: z.boolean().optional().default(false) })
  .strict();

export const pluginTokenResponseSchema = z.object({
  ok: z.literal(true),
  token: z.string(),
});

export type PluginTokenResponse = z.infer<typeof pluginTokenResponseSchema>;

export const pluginCatalogStatusSchema = z.object({
  pluginCount: z.number(),
  includedPluginCount: z.number(),
  optionalPluginCount: z.number(),
});

export type PluginCatalogStatus = z.infer<typeof pluginCatalogStatusSchema>;

export const pluginCatalogStatusResponseSchema = z.object({
  catalog: pluginCatalogStatusSchema,
});

export const pluginCatalogAuthorSchema = z.object({
  name: z.string(),
  github: z.string().nullable().default(null),
  url: z.string().nullable(),
});

export type PluginCatalogAuthor = z.infer<typeof pluginCatalogAuthorSchema>;

export const pluginCatalogCollectionMembershipSchema = z.object({
  id: pluginMarketplaceCollectionIdSchema,
  rank: z.number().int().nonnegative(),
});

export type PluginCatalogCollectionMembership = z.infer<
  typeof pluginCatalogCollectionMembershipSchema
>;

export const pluginCatalogCollectionSchema = z.object({
  id: pluginMarketplaceCollectionIdSchema,
  displayName: z.string(),
  pluginIds: z.array(pluginMarketplaceCollectionPluginIdSchema),
});

export type PluginCatalogCollection = z.infer<
  typeof pluginCatalogCollectionSchema
>;

export const pluginCatalogSearchResultSchema = z.object({
  entryId: z.string(),
  pluginId: z.string(),
  displayName: z.string(),
  description: z.string(),
  icon: z.string().nullable(),
  iconUrl: z.string().nullable(),
  iconTinted: z.boolean().default(false),
  categoryId: pluginCatalogCategoryIdSchema.optional(),
  category: z.string().optional(),
  screenshots: z.array(z.string()).default([]),
  overview: z.string().optional(),
  collections: z.array(pluginCatalogCollectionMembershipSchema).default([]),
  publishedAt: z.iso.datetime({ offset: true }).optional(),
  updatedAt: z.iso.datetime({ offset: true }).optional(),
  source: z.string(),
  repositoryUrl: z.string().nullable().default(null),
  marketplace: z.string(),
  marketplaceDisplayName: z.string(),
  publisherKey: z.string(),
  publisherLabel: z.string(),
  official: z.boolean(),
  author: pluginCatalogAuthorSchema.nullable(),
  installed: z.boolean(),
  installedByDefault: z.boolean().default(false),
  conflictingInstallSource: z.string().nullable(),
  compatible: z.boolean(),
  incompatibleReason: z.string().nullable(),
});

export type PluginCatalogSearchResult = z.infer<
  typeof pluginCatalogSearchResultSchema
>;

export const pluginCatalogSearchResponseSchema = z.object({
  results: z.array(pluginCatalogSearchResultSchema),
  collections: z.array(pluginCatalogCollectionSchema),
  categories: z.array(pluginMarketplaceCategorySchema).default([]),
});

export type PluginCatalogSearchResponse = z.infer<
  typeof pluginCatalogSearchResponseSchema
>;

export const pluginCatalogResolvedSourceSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("npm"),
      package: z.string(),
      range: z.string().optional(),
      tag: z.string().optional(),
      registry: z.string().optional(),
      resolvedVersion: z.string().optional(),
      resolvedIntegrity: z.string().optional(),
      unresolvedReason: z.string().optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("git"),
      url: z.string(),
      subdir: z.string().optional(),
      ref: z.string().optional(),
      range: z.string().optional(),
      tagPrefix: z.string().optional(),
      resolvedTag: z.string().optional(),
      resolvedCommit: z.string().optional(),
      unresolvedReason: z.string().optional(),
    })
    .strict(),
]);

export type PluginCatalogResolvedSource = z.infer<
  typeof pluginCatalogResolvedSourceSchema
>;

export const pluginCatalogInstallPlanSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("bundled"),
    entryId: z.string(),
    pluginId: z.string(),
    displayName: z.string(),
    source: z.string(),
    compatible: z.boolean(),
    incompatibleReason: z.string().nullable(),
  }),
  z.object({
    kind: z.literal("marketplace"),
    entryId: z.string(),
    pluginId: z.string(),
    displayName: z.string(),
    marketplace: z.string(),
    marketplaceDisplayName: z.string(),
    official: z.boolean(),
    author: pluginCatalogAuthorSchema,
    source: z.string(),
    resolvedSource: pluginCatalogResolvedSourceSchema,
    compatible: z.boolean(),
    incompatibleReason: z.string().nullable(),
  }),
]);

export type PluginCatalogInstallPlan = z.infer<
  typeof pluginCatalogInstallPlanSchema
>;

export const pluginCatalogInstallPlanResponseSchema = z.object({
  plan: pluginCatalogInstallPlanSchema,
});

export const pluginMarketplaceSourceKindSchema = z.enum([
  "https",
  "git",
  "path",
]);

export const pluginMarketplaceSchema = z.object({
  name: z.string(),
  displayName: z.string(),
  description: z.string().nullable(),
  official: z.boolean(),
  sourceKind: pluginMarketplaceSourceKindSchema,
  source: z.string(),
  subdirectory: z.string().nullable().default(null),
  resolvedCommit: z.string().nullable(),
  entryCount: z.number(),
  lastRefreshAt: z.number().nullable(),
  lastAttemptAt: z.number().nullable(),
  lastError: z.string().nullable(),
});

export type PluginMarketplace = z.infer<typeof pluginMarketplaceSchema>;

export const pluginMarketplaceListResponseSchema = z.object({
  marketplaces: z.array(pluginMarketplaceSchema),
});

export const pluginMarketplaceAddRequestSchema = z
  .object({
    source: z.string().min(1),
    subdirectory: z.string().min(1).optional(),
  })
  .strict();

export const pluginMarketplaceMutationResponseSchema = z.object({
  ok: z.literal(true),
  marketplace: pluginMarketplaceSchema,
});

export const pluginMarketplaceRemoveResponseSchema = z.object({
  ok: z.literal(true),
  convertedPluginIds: z.array(z.string()),
});

export const pluginMarketplaceRefreshRequestSchema = z
  .object({
    name: pluginMarketplaceNameSchema.optional(),
  })
  .strict();

export const pluginMarketplaceRefreshResultSchema = z.object({
  name: z.string(),
  ok: z.boolean(),
  error: z.string().nullable(),
  marketplace: pluginMarketplaceSchema,
});

export type PluginMarketplaceRefreshResult = z.infer<
  typeof pluginMarketplaceRefreshResultSchema
>;

export const pluginMarketplaceRefreshResponseSchema = z.object({
  results: z.array(pluginMarketplaceRefreshResultSchema),
});

export const pluginRpcDiscoveryQuerySchema = z.object({
  pluginId: z.string().min(1).optional(),
  method: z.string().min(1).optional(),
});

export type PluginRpcDiscoveryQuery = z.infer<
  typeof pluginRpcDiscoveryQuerySchema
>;

export const publishedPluginRpcMethodSchema = z.object({
  pluginId: z.string().min(1),
  displayName: z.string().min(1),
  method: z.string().min(1),
  registrationDescription: z.string().nullable(),
  methodDescription: z.string().nullable(),
  inputSchema: z.record(z.string(), jsonValueSchema),
  outputSchema: z.record(z.string(), jsonValueSchema),
});

export type PublishedPluginRpcMethod = z.infer<
  typeof publishedPluginRpcMethodSchema
>;

export const pluginRpcDiscoveryResponseSchema = z.array(
  publishedPluginRpcMethodSchema,
);
