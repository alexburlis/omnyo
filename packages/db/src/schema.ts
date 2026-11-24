import {
  blob,
  check,
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";
import type { AnySQLiteColumn } from "drizzle-orm/sqlite-core";
import type { QueuedMessageDeliveryMode } from "@omnyo/domain";
import { threadStatusValues } from "@omnyo/domain/thread-status";
import { startedOnBehalfOfInitiatorValues } from "@omnyo/domain/started-on-behalf-of";
import { threadCreateOriginValues } from "@omnyo/domain/thread-create-origin";
import { threadOriginKindValues } from "@omnyo/domain/thread-origin-kind";
import { threadVisibilityValues } from "@omnyo/domain/thread-visibility";
import type {
  EnvironmentProviderSelection,
  InboxConditionKind,
  InboxFailureState,
  InboxOwnerInputKind,
  InboxOwnerInputState,
  InboxProducerKind,
  InboxProposalKind,
  InboxReceiptCause,
  InboxWaitCreator,
  InboxWaitKind,
  InboxWaitStatus,
  JsonValue,
  EnvironmentStatus,
  FaviconColorPreference,
  PendingInteractionStatus,
  PermissionMode,
  PromptHistoryScope,
  ProjectSourceType,
  QueuedMessagePayloadKind,
  QueuedMessageWaitHolder,
  ReasoningLevel,
  ServiceTier,
  TerminalSessionCloseReason,
  TerminalSessionStatus,
  ThreadDynamicContextFileStatus,
  ThreadSearchSourceKind,
  ThreadEventItemType,
  ThreadEventScopeKind,
  ThreadEventType,
  ProjectKind,
} from "@omnyo/domain";
import type { RetainedEventOutputPath } from "./retained-event-output.js";

export const authUsers = sqliteTable(
  "user",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    email: text("email").notNull(),
    emailVerified: integer("emailVerified", { mode: "boolean" }).notNull(),
    image: text("image"),
    createdAt: integer("createdAt", { mode: "timestamp_ms" }).notNull(),
    updatedAt: integer("updatedAt", { mode: "timestamp_ms" }).notNull(),
  },
  (table) => [uniqueIndex("user_email_unique").on(table.email)],
);

export const authApiKeys = sqliteTable(
  "apikey",
  {
    id: text("id").primaryKey(),
    name: text("name"),
    start: text("start"),
    prefix: text("prefix"),
    key: text("key").notNull(),
    referenceId: text("referenceId")
      .notNull()
      .references(() => authUsers.id, { onDelete: "cascade" }),
    refillInterval: integer("refillInterval"),
    refillAmount: integer("refillAmount"),
    lastRefillAt: integer("lastRefillAt", { mode: "timestamp_ms" }),
    enabled: integer("enabled", { mode: "boolean" }).notNull(),
    rateLimitEnabled: integer("rateLimitEnabled", {
      mode: "boolean",
    }).notNull(),
    rateLimitTimeWindow: integer("rateLimitTimeWindow").notNull(),
    rateLimitMax: integer("rateLimitMax").notNull(),
    requestCount: integer("requestCount").notNull(),
    remaining: integer("remaining"),
    lastRequest: integer("lastRequest", { mode: "timestamp_ms" }),
    expiresAt: integer("expiresAt", { mode: "timestamp_ms" }),
    createdAt: integer("createdAt", { mode: "timestamp_ms" }).notNull(),
    updatedAt: integer("updatedAt", { mode: "timestamp_ms" }).notNull(),
    permissions: text("permissions"),
    metadata: text("metadata"),
    configId: text("configId").notNull(),
  },
  (table) => [
    uniqueIndex("apikey_key_unique").on(table.key),
    index("apikey_reference_id_idx").on(table.referenceId),
    index("apikey_config_id_idx").on(table.configId),
  ],
);

export const hosts = sqliteTable(
  "hosts",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    type: text("type").$type<"persistent" | "ephemeral">().notNull(),
    connectMachineId: text("connect_machine_id"),
    machineProviderId: text("machine_provider_id"),
    launchKey: text("launch_key"),
    inputs: text("machine_inputs", { mode: "json" }).$type<JsonValue>(),
    attempt: integer("machine_attempt").notNull().default(0),
    pendingLog: text("pending_log").notNull().default(""),
    machineOperationId: text("machine_operation_id"),
    serverAccessProviderId: text("server_access_provider_id"),
    serverAccessGrantId: text("server_access_grant_id"),
    resource: text("resource", { mode: "json" }).$type<JsonValue>(),
    phase: text("phase")
      .$type<
        | "creating"
        | "active"
        | "suspending"
        | "suspended"
        | "resuming"
        | "removing"
        | "destroyed"
      >()
      .notNull()
      .default("active"),
    suspendedAt: integer("suspended_at"),
    statusMessage: text("status_message"),
    suspendRetryAt: integer("suspend_retry_at"),
    removeRetryAt: integer("remove_retry_at"),
    teardownAttempt: integer("teardown_attempt").notNull().default(0),
    teardownStatus: text("teardown_status").$type<
      "running" | "failed" | "removed"
    >(),
    maxPermissionMode: text("max_permission_mode")
      .$type<PermissionMode>()
      .notNull()
      .default("full"),
    availability: text("availability")
      .$type<"available" | "away">()
      .notNull()
      .default("available"),
    destroyedAt: integer("destroyed_at"),
    lastSeenAt: integer("last_seen_at"),
    lastRejectedProtocolVersion: integer("last_rejected_protocol_version"),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => [
    index("hosts_last_seen_idx").on(table.lastSeenAt),
    index("hosts_pending_provider_idx")
      .on(table.machineProviderId)
      .where(
        sql`${table.destroyedAt} IS NULL AND ${table.phase} <> 'destroyed'`,
      ),
    uniqueIndex("hosts_live_launch_key_idx")
      .on(table.launchKey)
      .where(sql`${table.destroyedAt} is null`),
  ],
);

export const serverAccessRetirements = sqliteTable(
  "server_access_retirements",
  {
    hostId: text("host_id")
      .primaryKey()
      .references(() => hosts.id, { onDelete: "cascade" }),
    providerId: text("provider_id"),
    grantId: text("grant_id"),
    acquisitionKey: text("acquisition_key").notNull(),
    serverUrl: text("server_url").notNull(),
    challenge: text("challenge").notNull(),
    primaryProofRuntimeId: text("primary_proof_runtime_id"),
    createdAt: integer("created_at").notNull(),
  },
);

export const projects = sqliteTable(
  "projects",
  {
    id: text("id").primaryKey(),
    kind: text("kind").$type<ProjectKind>().notNull().default("standard"),
    name: text("name").notNull(),
    gitRemoteUrl: text("git_remote_url"),
    customIcon: text("custom_icon"),
    sortKey: text("sort_key").notNull().default("V"),
    deletedAt: integer("deleted_at"),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => [
    index("projects_updated_idx").on(table.updatedAt),
    index("projects_deleted_idx").on(table.deletedAt),
    index("projects_sort_idx").on(table.sortKey, table.id),
    uniqueIndex("projects_personal_singleton_idx")
      .on(table.kind)
      .where(sql`${table.kind} = 'personal'`),
  ],
);

export const projectExecutionDefaults = sqliteTable(
  "project_execution_defaults",
  {
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    providerId: text("provider_id").notNull(),
    model: text("model").notNull(),
    serviceTier: text("service_tier").$type<ServiceTier>().notNull(),
    reasoningLevel: text("reasoning_level").$type<ReasoningLevel>().notNull(),
    permissionMode: text("permission_mode").$type<PermissionMode>().notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => [
    uniqueIndex("project_execution_defaults_project_idx").on(table.projectId),
  ],
);

export const systemExperiments = sqliteTable("system_experiments", {
  key: text("key").primaryKey(),
  value: integer("value", { mode: "boolean" }).notNull(),
  updatedAt: integer("updated_at").notNull(),
});

export const environmentVariables = sqliteTable(
  "environment_variables",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    projectId: text("project_id").references(() => projects.id, {
      onDelete: "cascade",
    }),
    name: text("name").notNull(),
    ciphertext: text("ciphertext").notNull(),
    encryptionVersion: integer("encryption_version").notNull(),
    note: text("note"),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => [
    uniqueIndex("environment_variables_global_name")
      .on(table.name)
      .where(sql`${table.projectId} IS NULL`),
    uniqueIndex("environment_variables_project_name")
      .on(table.projectId, table.name)
      .where(sql`${table.projectId} IS NOT NULL`),
  ],
);

export const appSettingsValues = sqliteTable("app_settings_values", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
  updatedAt: integer("updated_at").notNull(),
});

export const uiPreferenceDefaults = sqliteTable("ui_preference_defaults", {
  key: text("key").primaryKey(),
  valueJson: text("value_json").notNull(),
});

export const uiPreferences = sqliteTable("ui_preferences", {
  key: text("key").primaryKey(),
  valueJson: text("value_json").notNull(),
  revision: integer("revision").notNull(),
  updatedAt: integer("updated_at").notNull(),
});

export const appSettings = sqliteTable("app_settings", {
  id: text("id").primaryKey(),
  caffeinate: integer("caffeinate", { mode: "boolean" })
    .notNull()
    .default(false),
  showKeyboardHints: integer("show_keyboard_hints", { mode: "boolean" })
    .notNull()
    .default(true),
  steerActiveThreadOnEnter: integer("steer_active_thread_on_enter", {
    mode: "boolean",
  })
    .notNull()
    .default(false),
  showUnhandledProviderEvents: integer("show_unhandled_provider_events", {
    mode: "boolean",
  })
    .notNull()
    .default(false),
  codexMemoryEnabled: integer("codex_memory_enabled", { mode: "boolean" })
    .notNull()
    .default(true),
  claudeCodeMemoryEnabled: integer("claude_code_memory_enabled", {
    mode: "boolean",
  })
    .notNull()
    .default(true),
  codexSubagentsDisabled: integer("codex_subagents_disabled", {
    mode: "boolean",
  })
    .notNull()
    .default(false),
  claudeCodeSubagentsDisabled: integer("claude_code_subagents_disabled", {
    mode: "boolean",
  })
    .notNull()
    .default(false),
  claudeCodeWorkflowsDisabled: integer("claude_code_workflows_disabled", {
    mode: "boolean",
  })
    .notNull()
    .default(false),
  keybindingOverrides: text("keybinding_overrides").notNull().default("[]"),
  onboardingCompletedAt: text("onboarding_completed_at"),
  updatedAt: integer("updated_at").notNull(),
});

export const installedPlugins = sqliteTable("plugins", {
  id: text("id").primaryKey(),
  source: text("source").notNull(),
  provenance: text("provenance", {
    enum: ["builtin", "direct", "catalog"],
  })
    .notNull()
    .default("direct"),
  catalogEntryId: text("catalog_entry_id"),
  catalogMarketplaceName: text("catalog_marketplace_name"),
  sourceKind: text("source_kind", {
    enum: ["path", "builtin", "npm", "git"],
  })
    .notNull()
    .default("path"),
  sourcePath: text("source_path"),
  sourceBuiltinName: text("source_builtin_name"),
  sourceNpmPackage: text("source_npm_package"),
  sourceNpmRegistry: text("source_npm_registry"),
  sourceNpmRequestedSpec: text("source_npm_requested_spec"),
  sourceNpmSpecKind: text("source_npm_spec_kind", {
    enum: ["default", "exact", "tag", "range"],
  }),
  sourceGitUrl: text("source_git_url"),
  sourceGitSubdirectory: text("source_git_subdirectory"),
  sourceGitRequestedRef: text("source_git_requested_ref"),
  sourceGitRefKind: text("source_git_ref_kind", {
    enum: ["branch", "tag", "commit"],
  }),
  sourceGitRange: text("source_git_range"),
  sourceGitTagPrefix: text("source_git_tag_prefix"),
  sourceGitResolvedTag: text("source_git_resolved_tag"),
  npmResolvedVersion: text("npm_resolved_version"),
  npmIntegrity: text("npm_integrity"),
  gitResolvedCommit: text("git_resolved_commit"),
  lastUpdateCheckAt: integer("last_update_check_at"),
  availableCompatibleVersion: text("available_compatible_version"),
  newestIncompatibleVersion: text("newest_incompatible_version"),
  updateStatusDetail: text("update_status_detail"),
  lastFailureVersion: text("last_failure_version"),
  lastFailureAt: integer("last_failure_at"),
  lastFailureDetail: text("last_failure_detail"),
  activeArtifactId: text("active_artifact_id").references(
    (): AnySQLiteColumn => pluginArtifacts.id,
  ),
  normalizationVersion: integer("normalization_version").notNull().default(0),
  rootDir: text("root_dir").notNull(),
  version: text("version").notNull(),
  enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
  enabledFollowsDefault: integer("enabled_follows_default", { mode: "boolean" })
    .notNull()
    .default(false),
  removedAt: integer("removed_at"),
  installedAt: integer("installed_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
});

export const pluginArtifacts = sqliteTable(
  "plugin_artifacts",
  {
    id: text("id").primaryKey(),
    pluginId: text("plugin_id").notNull(),
    sourceKind: text("source_kind", {
      enum: ["npm", "git", "builtin", "path"],
    }).notNull(),
    npmResolvedVersion: text("npm_resolved_version"),
    gitResolvedCommit: text("git_resolved_commit"),
    gitCheckoutRoot: text("git_checkout_root"),
    bundledRootDir: text("bundled_root_dir"),
    path: text("path").notNull(),
    integrity: text("integrity"),
    contentHash: text("content_hash"),
    validationResult: text("validation_result", {
      enum: ["pending", "valid"],
    }).notNull(),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
    validatedAt: integer("validated_at"),
  },
  (table) => [index("plugin_artifacts_plugin_idx").on(table.pluginId)],
);

export const pluginMarketplaces = sqliteTable("plugin_marketplaces", {
  name: text("name").primaryKey(),
  sourceKind: text("source_kind", { enum: ["https", "git", "path"] })
    .notNull()
    .default("https"),
  manifestUrl: text("manifest_url").notNull(),
  sourceGitRef: text("source_git_ref"),
  sourceGitSubdirectory: text("source_git_subdirectory"),
  sourceGitCommit: text("source_git_commit"),
  manifestJson: text("manifest_json").notNull(),
  etag: text("etag"),
  lastModified: text("last_modified"),
  lastSuccessfulRefreshAt: integer("last_successful_refresh_at"),
  lastAttemptedRefreshAt: integer("last_attempted_refresh_at"),
  lastError: text("last_error"),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
});

export const pluginMarketplaceIcons = sqliteTable(
  "plugin_marketplace_icons",
  {
    marketplaceName: text("marketplace_name").notNull(),
    entryId: text("entry_id").notNull(),
    sourceUrl: text("source_url").notNull(),
    contentType: text("content_type").notNull(),
    etag: text("etag"),
    contentHash: text("content_hash").notNull(),
    bytes: blob("bytes", { mode: "buffer" }).notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => [primaryKey({ columns: [table.marketplaceName, table.entryId] })],
);

export const pluginStateSnapshots = sqliteTable(
  "plugin_state_snapshots",
  {
    id: text("id").primaryKey(),
    pluginId: text("plugin_id").notNull(),
    fromArtifactId: text("from_artifact_id"),
    toArtifactId: text("to_artifact_id").notNull(),
    snapshotPath: text("snapshot_path").notNull(),
    databasePath: text("database_path"),
    statePath: text("state_path").notNull(),
    secretsPath: text("secrets_path"),
    registrationPath: text("registration_path"),
    status: text("status", {
      enum: [
        "pending",
        "ready",
        "rollback-pending",
        "restoring",
        "restored",
        "failed",
      ],
    }).notNull(),
    rollbackCandidateVersion: text("rollback_candidate_version"),
    rollbackSourceFingerprint: text("rollback_source_fingerprint"),
    rollbackCoreVersion: text("rollback_core_version"),
    rollbackSdkVersion: text("rollback_sdk_version"),
    rollbackDetail: text("rollback_detail"),
    createdAt: integer("created_at").notNull(),
    retainedUntil: integer("retained_until").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => [
    index("plugin_state_snapshots_plugin_idx").on(table.pluginId),
    index("plugin_state_snapshots_retention_idx").on(table.retainedUntil),
  ],
);

export const pluginKv = sqliteTable(
  "plugin_kv",
  {
    pluginId: text("plugin_id").notNull(),
    key: text("key").notNull(),
    value: text("value").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => [primaryKey({ columns: [table.pluginId, table.key] })],
);

export const pluginSettings = sqliteTable(
  "plugin_settings",
  {
    pluginId: text("plugin_id").notNull(),
    key: text("key").notNull(),
    value: text("value").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => [primaryKey({ columns: [table.pluginId, table.key] })],
);

export const pluginSchedules = sqliteTable(
  "plugin_schedules",
  {
    pluginId: text("plugin_id").notNull(),
    name: text("name").notNull(),
    cron: text("cron").notNull(),
    nextRunAt: integer("next_run_at").notNull(),
    lastRunAt: integer("last_run_at"),
    lastStatus: text("last_status").$type<"running" | "ok" | "error">(),
    lastError: text("last_error"),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => [primaryKey({ columns: [table.pluginId, table.name] })],
);

export const appTheme = sqliteTable("app_theme", {
  id: text("id").primaryKey(),
  themeId: text("theme_id").notNull(),
  faviconColor: text("favicon_color")
    .$type<FaviconColorPreference>()
    .notNull()
    .default("default"),
  updatedAt: integer("updated_at").notNull(),
});

export const projectSources = sqliteTable(
  "project_sources",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    type: text("type").$type<ProjectSourceType>().notNull(),
    hostId: text("host_id").references(() => hosts.id, { onDelete: "cascade" }),
    path: text("path"),
    ownsPath: integer("owns_path", { mode: "boolean" })
      .notNull()
      .default(false),
    isDefault: integer("is_default", { mode: "boolean" })
      .notNull()
      .default(false),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => [
    index("project_sources_project_idx").on(table.projectId),
    index("project_sources_host_idx").on(table.hostId),
    uniqueIndex("project_sources_project_host_idx").on(
      table.projectId,
      table.hostId,
    ),
    check(
      "project_sources_shape_check",
      sql`(
        ${table.type} = 'local_path' AND ${table.hostId} IS NOT NULL AND ${table.path} IS NOT NULL
      )`,
    ),
  ],
);

export const environments = sqliteTable(
  "environments",
  {
    id: text("id").primaryKey(),
    name: text("name"),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    hostId: text("host_id")
      .notNull()
      .references(() => hosts.id, { onDelete: "cascade" }),
    path: text("path"),
    isGitRepo: integer("is_git_repo", { mode: "boolean" })
      .notNull()
      .default(false),
    isWorktree: integer("is_worktree", { mode: "boolean" })
      .notNull()
      .default(false),
    branchName: text("branch_name"),
    baseBranch: text("base_branch"),
    defaultBranch: text("default_branch"),
    mergeBaseBranch: text("merge_base_branch"),
    environmentProviderId: text("environment_provider_id"),
    environmentProviderPluginId: text("environment_provider_plugin_id"),
    providerOwnsPath: integer("provider_owns_path", { mode: "boolean" })
      .notNull()
      .default(false),
    environmentProviderSelection: text("environment_provider_selection", {
      mode: "json",
    }).$type<EnvironmentProviderSelection>(),
    environmentProviderInstanceKey: text("environment_provider_instance_key"),
    retireAt: integer("retire_at"),
    teardownAttempt: integer("teardown_attempt").notNull().default(0),
    teardownStatus: text("teardown_status").$type<
      "running" | "failed" | "removed"
    >(),
    teardownMessage: text("teardown_message"),
    resource: text("resource", { mode: "json" }).$type<JsonValue>(),
    ownerThreadId: text("owner_thread_id"),
    attempt: integer("attempt").notNull().default(0),
    statusMessage: text("status_message"),
    pendingLog: text("pending_log").notNull().default(""),
    claimPath: text("claim_path"),
    status: text("status")
      .$type<EnvironmentStatus>()
      .notNull()
      .default("provisioning"),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => [
    uniqueIndex("environments_project_host_path_idx").on(
      table.projectId,
      table.hostId,
      table.path,
    ),
    index("environments_host_path_lookup_idx").on(table.hostId, table.path),
    uniqueIndex("environments_owner_thread_idx")
      .on(table.ownerThreadId)
      .where(sql`${table.ownerThreadId} IS NOT NULL`),
    index("environments_claim_idx").on(table.hostId, table.claimPath),
    index("environments_project_idx").on(table.projectId),
    index("environments_status_idx").on(table.status),
    index("environments_provider_instance_idx").on(
      table.environmentProviderId,
      table.environmentProviderInstanceKey,
    ),
    index("environments_provider_lifecycle_idx")
      .on(table.environmentProviderId)
      .where(
        sql`${table.status} <> 'destroyed' OR ${table.teardownStatus} IS NOT 'removed'`,
      ),
  ],
);

export const threads = sqliteTable(
  "threads",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    environmentId: text("environment_id").references(() => environments.id, {
      onDelete: "set null",
    }),
    providerId: text("provider_id").notNull(),
    modelOverride: text("model_override"),
    reasoningLevelOverride: text(
      "reasoning_level_override",
    ).$type<ReasoningLevel>(),
    title: text("title"),
    titleFallback: text("title_fallback"),
    sectionId: text("section_id").references(() => threadSections.id, {
      onDelete: "set null",
    }),
    groupId: text("group_id").references(() => threadGroups.id, {
      onDelete: "set null",
    }),
    status: text("status", { enum: threadStatusValues })
      .notNull()
      .default("starting"),
    statusChangedAt: integer("status_changed_at").notNull().default(0),
    startupContext: text("startup_context"),
    parentThreadId: text("parent_thread_id").references(
      (): AnySQLiteColumn => threads.id,
      { onDelete: "set null" },
    ),
    lifecycleOwnerThreadId: text("lifecycle_owner_thread_id").references(
      (): AnySQLiteColumn => threads.id,
      { onDelete: "restrict" },
    ),
    launchedByThreadId: text("launched_by_thread_id").references(
      (): AnySQLiteColumn => threads.id,
      { onDelete: "set null" },
    ),
    sourceThreadId: text("source_thread_id").references(
      (): AnySQLiteColumn => threads.id,
      { onDelete: "set null" },
    ),
    originKind: text("origin_kind", {
      enum: threadOriginKindValues,
    }),
    originPluginId: text("origin_plugin_id"),
    visibility: text("visibility", { enum: threadVisibilityValues })
      .notNull()
      .default("visible"),
    pluginHome: integer("plugin_home", { mode: "boolean" })
      .notNull()
      .default(false),
    quiet: integer("quiet", { mode: "boolean" }).notNull().default(false),
    archivedAt: integer("archived_at"),
    pinnedAt: integer("pinned_at"),
    pinSortKey: text("pin_sort_key"),
    shelvedAt: integer("shelved_at"),
    shelfSortKey: text("shelf_sort_key"),
    deletedAt: integer("deleted_at"),
    storageDeletedAt: integer("storage_deleted_at"),
    lastReadAt: integer("last_read_at"),
    latestAttentionAt: integer("latest_attention_at").notNull(),
    lastMessageAt: integer("last_message_at"),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => [
    index("threads_project_id_idx").on(table.projectId, table.id),
    index("threads_project_updated_idx").on(table.projectId, table.updatedAt),
    index("threads_project_archived_deleted_idx").on(
      table.projectId,
      table.archivedAt,
      table.deletedAt,
      table.id,
    ),
    index("threads_pin_sort_idx")
      .on(table.archivedAt, table.deletedAt, table.pinSortKey, table.id)
      .where(sql`${table.pinnedAt} IS NOT NULL`),
    index("threads_shelf_sort_idx")
      .on(table.archivedAt, table.deletedAt, table.shelvedAt, table.id)
      .where(sql`${table.shelvedAt} IS NOT NULL`),
    index("threads_environment_idx").on(table.environmentId),
    index("threads_lifecycle_owner_idx").on(table.lifecycleOwnerThreadId),
    index("threads_launched_by_idx").on(table.launchedByThreadId),
    index("threads_parent_idx").on(table.parentThreadId),
    index("threads_source_origin_idx").on(
      table.sourceThreadId,
      table.originKind,
    ),
    index("threads_origin_plugin_archived_idx").on(
      table.originPluginId,
      table.archivedAt,
    ),
    index("threads_section_archived_deleted_idx").on(
      table.sectionId,
      table.archivedAt,
      table.deletedAt,
      table.id,
    ),
    index("threads_group_idx").on(table.groupId),
    index("threads_archived_status_idx").on(table.archivedAt, table.status),
    index("threads_deleted_cleanup_idx")
      .on(table.deletedAt)
      .where(sql`${table.deletedAt} IS NOT NULL`),
    index("threads_environment_archived_deleted_idx").on(
      table.environmentId,
      table.archivedAt,
      table.deletedAt,
    ),
    index("threads_active_maintenance_idx")
      .on(table.status)
      .where(sql`${table.deletedAt} IS NULL`),
    index("threads_search_rank_idx").on(
      table.deletedAt,
      table.visibility,
      table.archivedAt,
      table.updatedAt,
      table.id,
      table.title,
    ),
  ],
);

export const threadPluginMetadata = sqliteTable(
  "thread_plugin_metadata",
  {
    threadId: text("thread_id")
      .notNull()
      .references(() => threads.id, { onDelete: "cascade" }),
    pluginId: text("plugin_id").notNull(),
    metadataJson: text("metadata_json").notNull(),
  },
  (table) => [primaryKey({ columns: [table.threadId, table.pluginId] })],
);

export const nativeThreadImports = sqliteTable(
  "native_thread_imports",
  {
    threadId: text("thread_id")
      .primaryKey()
      .references(() => threads.id, { onDelete: "cascade" }),
    hostId: text("host_id").notNull(),
    providerId: text("provider_id").notNull(),
    sourceProviderThreadId: text("source_provider_thread_id").notNull(),
    sourcePath: text("source_path").notNull(),
    importedAt: integer("imported_at").notNull(),
  },
  (table) => [
    uniqueIndex("native_thread_imports_source_idx").on(
      table.hostId,
      table.providerId,
      table.sourceProviderThreadId,
    ),
  ],
);

export const threadTabs = sqliteTable("thread_tabs", {
  threadId: text("thread_id")
    .primaryKey()
    .references(() => threads.id, { onDelete: "cascade" }),
  tabsJson: text("tabs_json").notNull(),
  revision: integer("revision").notNull(),
  updatedAt: integer("updated_at").notNull(),
});

export const threadSections = sqliteTable(
  "thread_sections",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => [uniqueIndex("thread_sections_name_idx").on(table.name)],
);

export const threadGroups = sqliteTable(
  "thread_groups",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => [index("thread_groups_project_idx").on(table.projectId)],
);

export const threadSearchSegments = sqliteTable(
  "thread_search_segments",
  {
    id: text("id").primaryKey(),
    threadId: text("thread_id")
      .notNull()
      .references(() => threads.id, { onDelete: "cascade" }),
    sourceKind: text("source_kind").$type<ThreadSearchSourceKind>().notNull(),
    sourceKey: text("source_key").notNull(),
    sourceSeq: integer("source_seq"),
    text: text("text").notNull(),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => [
    uniqueIndex("thread_search_segments_source_idx").on(
      table.threadId,
      table.sourceKind,
      table.sourceKey,
    ),
    index("thread_search_segments_thread_source_seq_idx").on(
      table.threadId,
      table.sourceSeq,
    ),
  ],
);

export const threadConversationOutlines = sqliteTable(
  "thread_conversation_outlines",
  {
    threadId: text("thread_id")
      .primaryKey()
      .references(() => threads.id, { onDelete: "cascade" }),
    projectionKey: text("projection_key").notNull(),
    itemsJson: text("items_json").notNull(),
  },
);

export const threadHistoryEpochs = sqliteTable("thread_history_epochs", {
  threadId: text("thread_id")
    .primaryKey()
    .references(() => threads.id, { onDelete: "cascade" }),
  epoch: text("epoch").notNull(),
  rewriteEpoch: text("rewrite_epoch").notNull().default(""),
  highWaterSequence: integer("high_water_sequence").notNull().default(0),
});

export const threadTimelineRecords = sqliteTable(
  "thread_timeline_records",
  {
    key: text("key").primaryKey(),
    threadId: text("thread_id")
      .notNull()
      .references(() => threads.id, { onDelete: "cascade" }),
    kind: text("kind", { enum: ["page", "root"] }).notNull(),
    body: text("body").notNull(),
    byteSize: integer("byte_size").notNull(),
    createdAt: integer("created_at").notNull(),
    expiresAt: integer("expires_at"),
  },
  (table) => [
    index("thread_timeline_records_created_key_idx").on(
      table.createdAt,
      table.key,
    ),
    check(
      "thread_timeline_records_kind_check",
      sql`${table.kind} IN ('page', 'root')`,
    ),
    check(
      "thread_timeline_records_byte_size_check",
      sql`${table.byteSize} >= 0`,
    ),
  ],
);

export const threadDynamicContextFileStates = sqliteTable(
  "thread_dynamic_context_file_states",
  {
    threadId: text("thread_id")
      .notNull()
      .references(() => threads.id, { onDelete: "cascade" }),
    fileKey: text("file_key").notNull(),
    contentStatus: text("content_status")
      .$type<ThreadDynamicContextFileStatus>()
      .notNull(),
    contentHash: text("content_hash").notNull(),
    shownAt: integer("shown_at").notNull(),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => [
    uniqueIndex("thread_dynamic_context_file_states_thread_file_idx").on(
      table.threadId,
      table.fileKey,
    ),
  ],
);

export const events = sqliteTable(
  "events",
  {
    id: text("id").primaryKey(),
    threadId: text("thread_id")
      .notNull()
      .references(() => threads.id, { onDelete: "cascade" }),
    environmentId: text("environment_id").references(() => environments.id, {
      onDelete: "set null",
    }),
    scopeKind: text("scope_kind").$type<ThreadEventScopeKind>().notNull(),
    turnId: text("turn_id"),
    providerThreadId: text("provider_thread_id"),
    sequence: integer("sequence").notNull(),
    type: text("type").$type<ThreadEventType>().notNull(),
    itemId: text("item_id"),
    itemKind: text("item_kind").$type<ThreadEventItemType>(),
    parentToolCallId: text("parent_tool_call_id"),
    data: text("data").notNull().default("{}"),
    createdAt: integer("created_at").notNull(),
  },
  (table) => [
    uniqueIndex("events_thread_sequence_idx").on(
      table.threadId,
      table.sequence,
    ),
    index("events_delegating_item_lookup_idx")
      .on(table.threadId, table.itemId, table.sequence, table.itemKind)
      .where(sql`${table.itemKind} IN ('toolCall', 'delegation')`),
    index("events_plan_steps_thread_sequence_idx")
      .on(table.threadId, table.sequence)
      .where(
        sql`(${table.itemKind} = 'planSteps' AND ${table.type} = 'item/completed') OR ${table.type} = 'turn/plan/updated'`,
      ),
    index("events_parent_tool_call_thread_parent_sequence_idx")
      .on(table.threadId, table.parentToolCallId, table.sequence)
      .where(sql`${table.parentToolCallId} IS NOT NULL`),
    index("events_thread_type_item_kind_sequence_idx").on(
      table.threadId,
      table.type,
      table.itemKind,
      table.sequence,
    ),
    index("events_background_task_thread_type_item_sequence_idx")
      .on(table.threadId, table.type, table.itemId, table.sequence)
      .where(sql`${table.itemKind} = 'backgroundTask'`),
    index("events_thread_type_sequence_idx").on(
      table.threadId,
      table.type,
      table.sequence,
    ),
    index("events_thread_turn_type_item_sequence_idx").on(
      table.threadId,
      table.turnId,
      table.type,
      table.itemId,
      table.sequence,
    ),
    index("events_item_lifecycle_thread_item_sequence_idx")
      .on(table.threadId, table.itemId, table.sequence)
      .where(
        sql`${table.type} IN ('item/started', 'item/completed', 'item/backgroundTask/completed')`,
      ),
    index("events_environment_idx").on(table.environmentId),
    index("events_provider_identity_idx")
      .on(table.providerThreadId, table.createdAt)
      .where(sql`${table.type} = 'thread/identity'`),
    index("events_completed_item_truncation_idx")
      .on(table.itemKind, table.createdAt, table.id)
      .where(sql`${table.type} = 'item/completed'`),
    index("events_thread_state_thread_sequence_idx")
      .on(table.threadId, table.sequence)
      .where(
        sql`${table.type} IN ('thread/goal/updated', 'thread/goal/cleared', 'thread/extensionState/updated')`,
      ),
    check(
      "events_scope_shape_check",
      sql`(
        (${table.scopeKind} = 'turn' AND ${table.turnId} IS NOT NULL)
        OR
        (${table.scopeKind} = 'thread' AND ${table.turnId} IS NULL)
      )`,
    ),
  ],
);

export const retainedEventOutputs = sqliteTable(
  "retained_event_outputs",
  {
    eventId: text("event_id")
      .primaryKey()
      .references(() => events.id, { onDelete: "cascade" }),
    outputPath: text("output_path").$type<RetainedEventOutputPath>().notNull(),
    value: text("value").notNull(),
    expiresAt: integer("expires_at").notNull(),
  },
  (table) => [
    index("retained_event_outputs_expiry_idx").on(
      table.expiresAt,
      table.eventId,
    ),
  ],
);

export const threadPruningCursors = sqliteTable(
  "thread_pruning_cursors",
  {
    policy: text("policy").notNull(),
    scope: text("scope").notNull().default(""),
    threadId: text("thread_id").references(() => threads.id, {
      onDelete: "cascade",
    }),
    version: integer("version").notNull(),
    lastThreadId: text("last_thread_id").notNull().default(""),
    currentThreadId: text("current_thread_id"),
    step: integer("step").notNull().default(0),
    sequence: integer("sequence").notNull().default(0),
    upperSequence: integer("upper_sequence").notNull().default(0),
    workRevision: integer("work_revision").notNull().default(0),
    cycle: integer("cycle").notNull().default(0),
    latestRootSequence: integer("latest_root_sequence").notNull().default(0),
    latestContextSequence: integer("latest_context_sequence")
      .notNull()
      .default(0),
    probeEventId: text("probe_event_id"),
    probePhase: integer("probe_phase").notNull().default(0),
    probeSequence: integer("probe_sequence").notNull().default(0),
    probeWitnessId: text("probe_witness_id"),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.policy, table.scope] }),
    index("thread_pruning_cursors_thread_idx").on(table.threadId),
    check(
      "thread_pruning_cursors_scope_check",
      sql`${table.scope} = coalesce(${table.threadId}, '')`,
    ),
  ],
);

export const maintenanceScanCursors = sqliteTable(
  "maintenance_scan_cursors",
  {
    id: text("id").primaryKey(),
    policy: text("policy").notNull(),
    version: integer("version").notNull(),
    itemKind: text("item_kind").$type<ThreadEventItemType>().notNull(),
    outputPath: text("output_path").notNull(),
    lastCreatedAt: integer("last_created_at").notNull().default(0),
    lastEventId: text("last_event_id").notNull().default(""),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => [
    uniqueIndex("maintenance_scan_cursors_path_idx").on(
      table.policy,
      table.version,
      table.itemKind,
      table.outputPath,
    ),
  ],
);

export const promptHistoryEntries = sqliteTable(
  "prompt_history_entries",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    threadId: text("thread_id")
      .notNull()
      .references(() => threads.id, { onDelete: "cascade" }),
    scope: text("scope").$type<PromptHistoryScope>().notNull(),
    requestSequence: integer("request_sequence").notNull(),
    input: text("input").notNull(),
    createdAt: integer("created_at").notNull(),
  },
  (table) => [
    uniqueIndex("prompt_history_entries_thread_request_idx").on(
      table.threadId,
      table.requestSequence,
    ),
    index("prompt_history_entries_project_scope_created_idx").on(
      table.projectId,
      table.scope,
      table.createdAt,
      table.requestSequence,
      table.id,
    ),
    index("prompt_history_entries_created_idx").on(
      table.createdAt,
      table.requestSequence,
      table.id,
    ),
    index("prompt_history_entries_thread_scope_created_idx").on(
      table.threadId,
      table.scope,
      table.createdAt,
      table.requestSequence,
      table.id,
    ),
  ],
);

export const queuedThreadMessages = sqliteTable(
  "queued_thread_messages",
  {
    id: text("id").primaryKey(),

    systemNotice: text("system_notice"),
    threadId: text("thread_id")
      .notNull()
      .references(() => threads.id, { onDelete: "cascade" }),
    content: text("content").notNull(),
    senderThreadId: text("sender_thread_id"),

    origin: text("origin", { enum: threadCreateOriginValues }),
    originPluginId: text("origin_plugin_id"),

    requestedByInitiator: text("requested_by_initiator", {
      enum: startedOnBehalfOfInitiatorValues,
    }),
    requestedByThreadId: text("requested_by_thread_id"),
    model: text("model").notNull(),
    reasoningLevel: text("reasoning_level").notNull(),
    permissionMode: text("permission_mode").$type<PermissionMode>().notNull(),
    serviceTier: text("service_tier").notNull(),
    groupWithNext: integer("group_with_next", { mode: "boolean" })
      .notNull()
      .default(false),

    sendAt: integer("send_at"),

    waitingOn: text("waiting_on"),

    waitHolder: text("wait_holder").$type<QueuedMessageWaitHolder>(),

    failureReason: text("failure_reason"),

    failureCount: integer("failure_count").notNull().default(0),
    nextAttemptAt: integer("next_attempt_at"),
    overridesFailureId: text("overrides_failure_id"),
    payloadKind: text("payload_kind")
      .$type<QueuedMessagePayloadKind>()
      .notNull()
      .default("inline"),

    retryOfTurnRequestId: text("retry_of_turn_request_id"),
    retryAttempt: integer("retry_attempt"),
    retryReason: text("retry_reason"),
    deliveryMode: text("delivery_mode")
      .$type<QueuedMessageDeliveryMode>()
      .notNull()
      .default("steer"),
    coalesceKey: text("coalesce_key"),
    coalesceState: text("coalesce_state"),
    claimedAt: integer("claimed_at"),
    claimToken: text("claim_token"),
    editHeldUntil: integer("edit_held_until"),
    sortKey: text("sort_key").notNull(),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => [
    index("queued_thread_messages_coalesce_idx")
      .on(table.threadId, table.coalesceKey)
      .where(sql`${table.coalesceKey} IS NOT NULL`),
    index("queued_thread_messages_thread_created_idx").on(
      table.threadId,
      table.createdAt,
      table.id,
    ),
    index("queued_thread_messages_thread_sort_idx").on(
      table.threadId,
      table.sortKey,
      table.id,
    ),

    index("queued_thread_messages_due_idx")
      .on(table.sendAt, table.id)
      .where(
        sql`${table.sendAt} IS NOT NULL AND ${table.claimedAt} IS NULL AND ${table.claimToken} IS NULL`,
      ),

    index("queued_thread_messages_wait_holder_idx")
      .on(table.waitHolder, table.id)
      .where(sql`${table.waitHolder} IS NOT NULL`),
  ],
);

export const dispatchedQueuedThreadMessages = sqliteTable(
  "dispatched_queued_thread_messages",
  {
    queuedMessageId: text("queued_message_id").primaryKey(),
    threadId: text("thread_id")
      .notNull()
      .references(() => threads.id, { onDelete: "cascade" }),
    dispatchedAt: integer("dispatched_at").notNull(),
  },
  (table) => [
    index("dispatched_queued_thread_messages_dispatched_at_idx").on(
      table.dispatchedAt,
    ),
  ],
);

export const hostDaemonSessions = sqliteTable(
  "host_daemon_sessions",
  {
    id: text("id").primaryKey(),
    hostId: text("host_id")
      .notNull()
      .references(() => hosts.id, { onDelete: "cascade" }),
    instanceId: text("instance_id").notNull(),
    hostName: text("host_name").notNull(),
    dataDir: text("data_dir").notNull(),
    protocolVersion: integer("protocol_version").notNull(),
    heartbeatIntervalMs: integer("heartbeat_interval_ms").notNull(),
    leaseTimeoutMs: integer("lease_timeout_ms").notNull(),
    status: text("status").notNull(),
    leaseExpiresAt: integer("lease_expires_at").notNull(),
    closedAt: integer("closed_at"),
    closeReason: text("close_reason"),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => [
    index("host_daemon_sessions_host_status_idx").on(
      table.hostId,
      table.status,
    ),
    index("host_daemon_sessions_host_latest_idx").on(
      table.hostId,
      table.updatedAt,
      table.createdAt,
      table.id,
    ),
    index("host_daemon_sessions_closed_prune_idx").on(
      table.status,
      table.closedAt,
      table.id,
    ),
  ],
);

export const daemonEventReceipts = sqliteTable(
  "daemon_event_receipts",
  {
    hostId: text("host_id")
      .notNull()
      .references(() => hosts.id, { onDelete: "cascade" }),
    instanceId: text("instance_id").notNull(),
    lastEventIndex: integer("last_event_index").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => [primaryKey({ columns: [table.hostId, table.instanceId] })],
);

export const coordinatorStore = sqliteTable("coordinator_store", {
  singleton: integer("singleton").primaryKey(),
  storeId: text("store_id").notNull(),
  createdAt: integer("created_at").notNull(),
});

export const submissionReceipts = sqliteTable(
  "submission_receipts",
  {
    actorKey: text("actor_key").notNull(),
    submissionId: text("submission_id").notNull(),
    action: text("action").$type<"thread-message" | "new-thread">().notNull(),
    intentDigest: text("intent_digest").notNull(),
    threadId: text("thread_id").notNull(),
    queuedMessageId: text("queued_message_id").notNull(),
    acceptedAt: integer("accepted_at").notNull(),
  },
  (table) => [primaryKey({ columns: [table.actorKey, table.submissionId] })],
);

export const providerModelCatalogs = sqliteTable(
  "provider_model_catalogs",
  {
    hostId: text("host_id")
      .notNull()
      .references(() => hosts.id, { onDelete: "cascade" }),
    providerId: text("provider_id").notNull(),
    scopeKey: text("scope_key").notNull(),
    fingerprint: text("fingerprint").notNull(),
    modelsJson: text("models_json").notNull(),
    selectedOnlyModelsJson: text("selected_only_models_json").notNull(),
    fetchedAt: integer("fetched_at").notNull(),
  },
  (table) => [
    primaryKey({
      columns: [table.hostId, table.providerId, table.scopeKey],
    }),
  ],
);

export const terminalSessions = sqliteTable(
  "terminal_sessions",
  {
    id: text("id").primaryKey(),
    threadId: text("thread_id").references(() => threads.id, {
      onDelete: "cascade",
    }),
    environmentId: text("environment_id").references(() => environments.id, {
      onDelete: "cascade",
    }),
    hostId: text("host_id")
      .notNull()
      .references(() => hosts.id, { onDelete: "cascade" }),
    daemonSessionId: text("daemon_session_id").references(
      () => hostDaemonSessions.id,
      { onDelete: "set null" },
    ),
    title: text("title").notNull(),
    initialCwd: text("initial_cwd").notNull(),
    cols: integer("cols").notNull(),
    rows: integer("rows").notNull(),
    status: text("status").$type<TerminalSessionStatus>().notNull(),
    exitCode: integer("exit_code"),
    closeReason: text("close_reason").$type<TerminalSessionCloseReason>(),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
    lastUserInputAt: integer("last_user_input_at"),
  },
  (table) => [
    index("terminal_sessions_thread_status_updated_idx").on(
      table.threadId,
      table.status,
      table.updatedAt,
    ),
    index("terminal_sessions_environment_status_idx").on(
      table.environmentId,
      table.status,
    ),
    index("terminal_sessions_status_thread_idx").on(
      table.status,
      table.threadId,
    ),
    index("terminal_sessions_host_status_idx").on(table.hostId, table.status),
    index("terminal_sessions_daemon_session_idx").on(table.daemonSessionId),
  ],
);

export const threadQuestions = sqliteTable(
  "thread_questions",
  {
    id: text("id").primaryKey(),
    threadId: text("thread_id")
      .notNull()
      .references(() => threads.id, { onDelete: "cascade" }),
    revision: integer("revision").notNull(),
    question: text("question").notNull(),
    mode: text("mode").$type<"required" | "optional">().notNull(),
    key: text("key"),
    state: text("state")
      .$type<"open" | "answered" | "skipped" | "withdrawn">()
      .notNull(),
    answer: text("answer"),
    queuedMessageId: text("queued_message_id"),
    answeredBy: text("answered_by"),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => [
    index("thread_questions_thread_state_idx").on(table.threadId, table.state),
  ],
);

export const threadCallbacks = sqliteTable(
  "thread_callbacks",
  {
    threadId: text("thread_id")
      .primaryKey()
      .references(() => threads.id, { onDelete: "cascade" }),
    id: text("id").notNull(),
    sourceThreadId: text("source_thread_id"),
    sourceTitle: text("source_title").notNull(),
    reason: text("reason").notNull(),
    createdAt: integer("created_at").notNull(),
    afterSeq: integer("after_seq").notNull(),
    matchText: text("match_text").notNull(),
  },
  (table) => [index("thread_callbacks_source_idx").on(table.sourceThreadId)],
);

export const threadOwnerInputs = sqliteTable(
  "thread_owner_inputs",
  {
    id: text("id").primaryKey(),
    threadId: text("thread_id")
      .notNull()
      .references(() => threads.id, { onDelete: "cascade" }),
    kind: text("kind").$type<InboxOwnerInputKind>().notNull(),
    state: text("state").$type<InboxOwnerInputState>().notNull(),
    requestId: text("request_id"),
    queuedMessageId: text("queued_message_id"),
    turnId: text("turn_id"),
    receiptId: text("receipt_id"),
    producerId: text("producer_id"),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => [
    index("thread_owner_inputs_thread_state_idx").on(
      table.threadId,
      table.state,
    ),
    index("thread_owner_inputs_request_idx").on(table.requestId),
    index("thread_owner_inputs_queued_idx").on(table.queuedMessageId),
    index("thread_owner_inputs_turn_idx").on(table.threadId, table.turnId),
  ],
);

export const threadWaits = sqliteTable(
  "thread_waits",
  {
    id: text("id").primaryKey(),
    threadId: text("thread_id")
      .notNull()
      .references(() => threads.id, { onDelete: "cascade" }),
    key: text("key").notNull(),
    generation: integer("generation").notNull(),
    kind: text("kind").$type<InboxWaitKind>().notNull(),
    status: text("status").$type<InboxWaitStatus>().notNull(),
    readiness: text("readiness").$type<"all" | "any">().notNull(),
    createdBy: text("created_by").$type<InboxWaitCreator>().notNull(),
    automationId: text("automation_id"),
    ownerAccepted: integer("owner_accepted", { mode: "boolean" }).notNull(),
    forText: text("for_text").notNull(),
    resumeText: text("resume_text"),
    marker: text("marker").notNull(),
    deadline: integer("deadline"),
    chainStartAt: integer("chain_start_at").notNull(),
    nextCheckAt: integer("next_check_at"),
    checkIntervalMs: integer("check_interval_ms"),
    checkCount: integer("check_count").notNull(),
    reminderAt: integer("reminder_at"),
    reminderReceiptId: text("reminder_receipt_id"),
    questionId: text("question_id"),
    questionRevision: integer("question_revision"),
    coversReceiptIds: text("covers_receipt_ids").notNull(),
    proposalKind: text("proposal_kind").$type<InboxProposalKind>(),
    proposalReceiptId: text("proposal_receipt_id"),
    afterWaitId: text("after_wait_id"),
    dispatchKey: text("dispatch_key"),
    dispatchQueuedMessageId: text("dispatch_queued_message_id"),
    dispatchRequestId: text("dispatch_request_id"),
    closedReason: text("closed_reason"),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
    closedAt: integer("closed_at"),
  },
  (table) => [
    uniqueIndex("thread_waits_key_generation_idx").on(
      table.threadId,
      table.key,
      table.generation,
    ),
    uniqueIndex("thread_waits_dispatch_key_idx").on(table.dispatchKey),
    index("thread_waits_thread_status_idx").on(table.threadId, table.status),
    index("thread_waits_status_deadline_idx").on(table.status, table.deadline),
    index("thread_waits_marker_idx").on(table.marker),
    index("thread_waits_dispatch_request_idx").on(table.dispatchRequestId),
    index("thread_waits_dispatch_queued_idx").on(table.dispatchQueuedMessageId),
  ],
);

export const threadWaitConditions = sqliteTable(
  "thread_wait_conditions",
  {
    waitId: text("wait_id")
      .notNull()
      .references(() => threadWaits.id, { onDelete: "cascade" }),
    conditionKey: text("condition_key").notNull(),
    kind: text("kind").$type<InboxConditionKind>().notNull(),
    target: text("target"),
    label: text("label").notNull(),
    state: text("state").$type<"pending" | "met">().notNull(),
    afterSeq: integer("after_seq"),
    result: text("result"),
    metAt: integer("met_at"),
    stallWokenAt: integer("stall_woken_at"),
    stallReceiptId: text("stall_receipt_id"),
  },
  (table) => [
    primaryKey({ columns: [table.waitId, table.conditionKey] }),
    index("thread_wait_conditions_target_idx").on(table.kind, table.target),
  ],
);

export const threadWaitResults = sqliteTable(
  "thread_wait_results",
  {
    id: text("id").primaryKey(),
    threadId: text("thread_id")
      .notNull()
      .references(() => threads.id, { onDelete: "cascade" }),
    marker: text("marker").notNull(),
    waitId: text("wait_id"),
    sourceThreadId: text("source_thread_id"),
    text: text("text").notNull(),
    late: integer("late", { mode: "boolean" }).notNull(),
    receivedAt: integer("received_at").notNull(),
    consumedAt: integer("consumed_at"),
  },
  (table) => [
    index("thread_wait_results_marker_idx").on(table.marker),
    index("thread_wait_results_thread_idx").on(table.threadId),
  ],
);

export const threadReceipts = sqliteTable(
  "thread_receipts",
  {
    id: text("id").primaryKey(),
    rootThreadId: text("root_thread_id")
      .notNull()
      .references(() => threads.id, { onDelete: "cascade" }),
    threadId: text("thread_id").notNull(),
    seq: integer("seq").notNull(),
    cause: text("cause").$type<InboxReceiptCause>().notNull(),
    summary: text("summary").notNull(),
    outcomeRef: text("outcome_ref"),
    waitId: text("wait_id"),
    coveredInputIds: text("covered_input_ids").notNull(),
    handledAt: integer("handled_at"),
    handledByMoveId: text("handled_by_move_id"),
    createdAt: integer("created_at").notNull(),
  },
  (table) => [
    index("thread_receipts_root_handled_idx").on(
      table.rootThreadId,
      table.handledAt,
    ),
    uniqueIndex("thread_receipts_root_seq_idx").on(
      table.rootThreadId,
      table.seq,
    ),
  ],
);

export const threadMoves = sqliteTable(
  "thread_moves",
  {
    id: text("id").primaryKey(),
    rootThreadId: text("root_thread_id")
      .notNull()
      .references(() => threads.id, { onDelete: "cascade" }),
    kind: text("kind").notNull(),
    handledReceiptIds: text("handled_receipt_ids").notNull(),
    writeSet: text("write_set").notNull(),
    createdAt: integer("created_at").notNull(),
    undoneAt: integer("undone_at"),
  },
  (table) => [index("thread_moves_created_idx").on(table.createdAt)],
);

export const threadFailures = sqliteTable(
  "thread_failures",
  {
    id: text("id").primaryKey(),
    threadId: text("thread_id")
      .notNull()
      .references(() => threads.id, { onDelete: "cascade" }),
    turnId: text("turn_id"),
    requestId: text("request_id"),
    waitId: text("wait_id"),
    state: text("state").$type<InboxFailureState>().notNull(),
    reason: text("reason").notNull(),
    decisionDeadline: integer("decision_deadline"),
    retryQueuedMessageId: text("retry_queued_message_id"),
    receiptId: text("receipt_id"),
    incidentKey: text("incident_key"),
    incidentLabel: text("incident_label"),
    resetAt: integer("reset_at"),
    resolvedBy: text("resolved_by"),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
    resolvedAt: integer("resolved_at"),
  },
  (table) => [
    index("thread_failures_thread_state_idx").on(table.threadId, table.state),
    index("thread_failures_state_deadline_idx").on(
      table.state,
      table.decisionDeadline,
    ),
  ],
);

export const threadProducers = sqliteTable(
  "thread_producers",
  {
    id: text("id").primaryKey(),
    threadId: text("thread_id")
      .notNull()
      .references(() => threads.id, { onDelete: "cascade" }),
    kind: text("kind").$type<InboxProducerKind>().notNull(),
    pluginId: text("plugin_id").notNull(),
    label: text("label").notNull(),
    status: text("status").$type<"active" | "ended">().notNull(),
    heldTurnId: text("held_turn_id"),
    heldSummary: text("held_summary"),
    heldUntil: integer("held_until"),
    endedReason: text("ended_reason"),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
    endedAt: integer("ended_at"),
  },
  (table) => [
    index("thread_producers_thread_status_idx").on(
      table.threadId,
      table.status,
    ),
    index("thread_producers_held_idx").on(table.heldUntil),
  ],
);

export const threadTurnMarks = sqliteTable(
  "thread_turn_marks",
  {
    threadId: text("thread_id")
      .notNull()
      .references(() => threads.id, { onDelete: "cascade" }),
    turnId: text("turn_id").notNull(),
    waitId: text("wait_id"),
    waitGeneration: integer("wait_generation"),
    evaluation: integer("evaluation", { mode: "boolean" }).notNull(),
    rearmed: integer("rearmed", { mode: "boolean" }).notNull(),
    metCondition: text("met_condition"),
    afterWaitId: text("after_wait_id"),
    endedOwnerWaitIds: text("ended_owner_wait_ids").notNull(),
    createdAt: integer("created_at").notNull(),
    endedAt: integer("ended_at"),
    endedOutcome: text("ended_outcome"),
  },
  (table) => [primaryKey({ columns: [table.threadId, table.turnId] })],
);

export const threadAttentionImports = sqliteTable("thread_attention_imports", {
  pluginId: text("plugin_id").primaryKey(),
  importedAt: integer("imported_at").notNull(),
});

export const pendingInteractions = sqliteTable(
  "pending_interactions",
  {
    id: text("id").primaryKey(),
    threadId: text("thread_id")
      .notNull()
      .references(() => threads.id, { onDelete: "cascade" }),
    originKind: text("origin_kind")
      .$type<"provider" | "plugin">()
      .notNull()
      .default("provider"),
    turnId: text("turn_id"),
    providerId: text("provider_id"),
    providerThreadId: text("provider_thread_id"),
    providerRequestId: text("provider_request_id"),
    pluginId: text("plugin_id"),
    rendererId: text("renderer_id"),
    status: text("status").$type<PendingInteractionStatus>().notNull(),
    payload: text("payload").notNull(),
    resolution: text("resolution"),
    statusReason: text("status_reason"),
    createdAt: integer("created_at").notNull(),
    expiresAt: integer("expires_at"),
    resolvedAt: integer("resolved_at"),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => [
    uniqueIndex("pending_interactions_provider_request_idx").on(
      table.providerId,
      table.providerThreadId,
      table.providerRequestId,
    ),
    index("pending_interactions_thread_created_idx").on(
      table.threadId,
      table.createdAt,
    ),
    index("pending_interactions_thread_status_created_idx").on(
      table.threadId,
      table.status,
      table.createdAt,
    ),
    index("pending_interactions_status_created_idx").on(
      table.status,
      table.createdAt,
    ),
    index("pending_interactions_plugin_status_created_idx").on(
      table.pluginId,
      table.status,
      table.createdAt,
    ),
  ],
);

export const environmentHookOperations = sqliteTable(
  "environment_hook_operations",
  {
    id: text("id").primaryKey(),
    operationId: text("operation_id").notNull(),
    hostId: text("host_id").notNull(),
    path: text("path").notNull(),
    kind: text("kind").$type<"setup" | "teardown">().notNull(),
    startedAt: integer("started_at").notNull(),
    finishedAt: integer("finished_at"),
    error: text("error"),
  },
);

export const projectAttachments = sqliteTable(
  "project_attachments",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    storedPath: text("stored_path").notNull(),
    originalName: text("original_name").notNull(),
    mimeType: text("mime_type"),
    sizeBytes: integer("size_bytes").notNull(),
    createdAt: integer("created_at").notNull(),
    readyAt: integer("ready_at"),
    deletionClaimedAt: integer("deletion_claimed_at"),
  },
  (table) => [
    uniqueIndex("project_attachments_project_path_idx").on(
      table.projectId,
      table.storedPath,
    ),
    index("project_attachments_project_created_idx").on(
      table.projectId,
      table.createdAt,
    ),
    index("project_attachments_deletion_idx")
      .on(table.projectId, table.deletionClaimedAt, table.id)
      .where(sql`${table.deletionClaimedAt} IS NOT NULL`),
    check("project_attachments_size_check", sql`${table.sizeBytes} >= 0`),
  ],
);

export const projectAttachmentThreads = sqliteTable(
  "project_attachment_threads",
  {
    attachmentId: text("attachment_id")
      .notNull()
      .references(() => projectAttachments.id, { onDelete: "cascade" }),
    threadId: text("thread_id")
      .notNull()
      .references(() => threads.id, { onDelete: "cascade" }),
  },
  (table) => [
    primaryKey({ columns: [table.attachmentId, table.threadId] }),
    index("project_attachment_threads_thread_idx").on(table.threadId),
  ],
);

export const threadPruningWork = sqliteTable(
  "thread_pruning_work",
  {
    policy: text("policy").notNull(),
    threadId: text("thread_id")
      .notNull()
      .references(() => threads.id, { onDelete: "cascade" }),
    revision: integer("revision").notNull().default(1),
  },
  (table) => [
    primaryKey({ columns: [table.policy, table.threadId] }),
    index("thread_pruning_work_thread_idx").on(table.threadId),
  ],
);

export const projectAttachmentBackfills = sqliteTable(
  "project_attachment_backfills",
  {
    projectId: text("project_id")
      .primaryKey()
      .references(() => projects.id, { onDelete: "cascade" }),
    phase: text("phase")
      .$type<
        | "files"
        | "events"
        | "queue"
        | "history-thread"
        | "history-project"
        | "done"
      >()
      .notNull(),
    threadCursor: text("thread_cursor").notNull(),
    inputCursor: integer("input_cursor").notNull(),
    inputId: text("input_id").notNull(),
    inputSequence: integer("input_sequence").notNull(),
    attemptedAt: integer("attempted_at").notNull(),
    error: text("error"),
  },
);

export const managedPreviews = sqliteTable(
  "managed_previews",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    threadId: text("thread_id")
      .notNull()
      .references(() => threads.id, { onDelete: "cascade" }),
    environmentId: text("environment_id")
      .notNull()
      .references(() => environments.id, { onDelete: "cascade" }),
    hostId: text("host_id")
      .notNull()
      .references(() => hosts.id, { onDelete: "cascade" }),
    url: text("url").notNull(),
    endpoint: text("endpoint").notNull(),
    cwd: text("cwd").notNull(),
    argv: text("argv", { mode: "json" }).$type<string[]>().notNull(),
    readinessPath: text("readiness_path").notNull(),
    createdAt: integer("created_at").notNull(),
  },
  (table) => [
    uniqueIndex("managed_previews_environment_endpoint_idx").on(
      table.environmentId,
      table.endpoint,
    ),
    index("managed_previews_thread_idx").on(table.threadId),
  ],
);
