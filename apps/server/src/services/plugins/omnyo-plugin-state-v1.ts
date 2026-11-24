import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  lstat,
  open,
  readFile,
  readdir,
  realpath,
  rename,
} from "node:fs/promises";
import { join, relative } from "node:path";
import { z } from "zod";
import { withFileLock } from "@omnyo/config/file-lock";
import {
  createConnection,
  migrate,
  rerootServerOwnedPluginPaths,
  type DbConnection,
} from "@omnyo/db";
import {
  AI_TASKS,
  aiServiceSelectionsSchema,
  appKeybindingOverridesSchema,
  importLegacyOwnedPluginIdV1,
  importLegacyNavigationKeyV1,
  legacyOwnedPluginIdsV1,
} from "@omnyo/domain";
import { threadTabsSchema } from "@omnyo/server-contract";
import {
  assertOmnyoStagedStateRoot,
  writeJsonFileAtomically,
  type OmnyoStagedStateRoot,
} from "@omnyo/server-archive";

import {
  adoptLegacyBundledMarketplaceV1,
  assertLegacyBundledMarketplaceAdoptedV1,
  prepareLegacyBundledMarketplaceV1,
} from "./legacy-bundled-marketplace-v1.js";

export const omnyoPluginStateReceiptKeyV1 = "omnyo.plugin-state.v1";

const pathBindingSchema = z
  .object({ from: z.string(), to: z.string() })
  .strict();

export const omnyoPluginStateReceiptSchemaV1 = z
  .object({
    version: z.literal(1),
    migrationId: z.string(),
    sourceDigest: z.string(),
    artifactDigest: z.string(),
    paths: z.array(pathBindingSchema),
  })
  .strict();

const moveSchema = z
  .object({
    oldId: z.string(),
    id: z.string(),
    digest: z.string().nullable(),
  })
  .strict();

const journalSchema = z
  .object({
    version: z.literal(1),
    migrationId: z.string(),
    dataDir: z.string(),
    sourceDigest: z.string(),
    artifactDigest: z.string(),
    moves: z.array(moveSchema),
  })
  .strict();

const namespaceColumns = [
  ["plugins", "id"],
  ["plugin_artifacts", "plugin_id"],
  ["plugin_state_snapshots", "plugin_id"],
  ["plugin_kv", "plugin_id"],
  ["plugin_settings", "plugin_id"],
  ["plugin_schedules", "plugin_id"],
  ["thread_plugin_metadata", "plugin_id"],
  ["thread_attention_imports", "plugin_id"],
  ["pending_interactions", "plugin_id"],
  ["environments", "environment_provider_plugin_id"],
  ["threads", "origin_plugin_id"],
  ["queued_thread_messages", "origin_plugin_id"],
] as const;

const scopedSettings = ["pluginProviders:", "pluginHostGeneration:"] as const;

function namespacePopulated(db: DbConnection, id: string): boolean {
  return (
    namespaceColumns.some(
      ([table, column]) =>
        db.$client
          .prepare(`SELECT 1 FROM ${table} WHERE ${column} = ? LIMIT 1`)
          .get(id) !== undefined,
    ) ||
    scopedSettings.some(
      (prefix) =>
        db.$client
          .prepare("SELECT 1 FROM app_settings_values WHERE key = ? LIMIT 1")
          .get(`${prefix}${id}`) !== undefined,
    ) ||
    db.$client
      .prepare(
        "SELECT 1 FROM queued_thread_messages WHERE wait_holder = ? OR (json_valid(waiting_on) AND json_extract(waiting_on, '$.kind') = 'plugin' AND json_extract(waiting_on, '$.pluginId') = ?) LIMIT 1",
      )
      .get(`plugin:${id}`, id) !== undefined
  );
}

async function stateDigest(path: string): Promise<string | null> {
  const root = await lstat(path).catch((error: unknown) => {
    if (error instanceof Error && "code" in error && error.code === "ENOENT")
      return null;
    throw error;
  });

  if (root === null) return null;
  const hash = createHash("sha256");

  async function visit(current: string): Promise<void> {
    const entry = await lstat(current);

    if (!entry.isDirectory() && !entry.isFile())
      throw new Error(
        "Plugin namespace contains an unsupported link or special file",
      );
    hash.update(
      JSON.stringify([
        relative(path, current),
        entry.mode,
        entry.isDirectory() ? "directory" : "file",
      ]),
    );

    if (entry.isDirectory()) {
      for (const name of (await readdir(current)).sort())
        await visit(join(current, name));
    } else
      for await (const bytes of createReadStream(current)) hash.update(bytes);
  }

  await visit(path);

  return hash.digest("hex");
}

async function syncDirectory(path: string): Promise<void> {
  const handle = await open(path, "r");

  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function writeJournal(
  path: string,
  journal: z.infer<typeof journalSchema>,
): Promise<void> {
  await writeJsonFileAtomically(path, journal, true);
}

function remapPath(
  path: string,
  bindings: readonly z.infer<typeof pathBindingSchema>[],
): string {
  const binding = bindings.find(
    (item) => path === item.from || path.startsWith(`${item.from}/`),
  );

  return binding === undefined
    ? path
    : binding.to + path.slice(binding.from.length);
}

export function projectOmnyoSnapshotPathV1(
  db: DbConnection,
  path: string,
): string {
  const row = z
    .object({ value: z.string() })
    .optional()
    .parse(
      db.$client
        .prepare("SELECT value FROM app_settings_values WHERE key = ?")
        .get(omnyoPluginStateReceiptKeyV1),
    );

  if (row === undefined) return path;

  return remapPath(
    path,
    omnyoPluginStateReceiptSchemaV1.parse(JSON.parse(row.value)).paths,
  );
}

export function projectLegacyBundledMarketplaceSnapshotV1(
  db: DbConnection,
  name: string | null,
  entryId: string | null,
): { catalogMarketplaceName: string | null; catalogEntryId: string | null } {
  if (name !== "bb-official")
    return { catalogMarketplaceName: name, catalogEntryId: entryId };

  const receipt = z
    .object({ value: z.string() })
    .optional()
    .parse(
      db.$client
        .prepare("SELECT value FROM app_settings_values WHERE key = ?")
        .get(omnyoPluginStateReceiptKeyV1),
    );

  if (receipt === undefined)
    throw new Error(
      "Legacy bundled marketplace snapshot requires the stopped Omnyo migration",
    );
  omnyoPluginStateReceiptSchemaV1.parse(JSON.parse(receipt.value));
  assertLegacyBundledMarketplaceAdoptedV1(db);

  if (
    db.$client
      .prepare(
        "SELECT 1 FROM plugin_marketplaces WHERE name = 'omnyo-official'",
      )
      .get() === undefined
  )
    throw new Error(
      "Legacy bundled marketplace snapshot has no adopted catalog owner",
    );

  return {
    catalogMarketplaceName: "omnyo-official",
    catalogEntryId:
      entryId === null ? null : importLegacyOwnedPluginIdV1(entryId),
  };
}

function assertEmptyTarget(db: DbConnection, id: string): void {
  if (namespacePopulated(db, id))
    throw new Error(`Omnyo plugin namespace collision: ${id}`);
}

export function assertOmnyoPluginNamespacesAdopted(db: DbConnection): void {
  assertLegacyBundledMarketplaceAdoptedV1(db);

  if (
    db.$client
      .prepare(
        "SELECT 1 FROM plugin_settings WHERE plugin_id = 'omnyo-guide' AND key = 'bbCli' LIMIT 1",
      )
      .get() !== undefined
  )
    throw new Error(
      "Guide preferences require the stopped Omnyo state migration before registration",
    );

  for (const [oldId] of legacyOwnedPluginIdsV1)
    if (namespacePopulated(db, oldId))
      throw new Error(
        `Plugin namespace ${oldId} requires the stopped Omnyo state migration before registration`,
      );

  if (
    db.$client
      .prepare(
        "SELECT 1 FROM thread_plugin_metadata WHERE plugin_id = 'bb-core-work' LIMIT 1",
      )
      .get() !== undefined
  )
    throw new Error(
      "Core work state requires the stopped Omnyo state migration before registration",
    );
}

function assertLegacyGuidePreferencesV1(db: DbConnection): void {
  for (const pluginId of ["bb-guide", "omnyo-guide"]) {
    const rows = z
      .array(z.object({ key: z.string(), value: z.string() }))
      .parse(
        db.$client
          .prepare(
            "SELECT key,value FROM plugin_settings WHERE plugin_id = ? AND key IN ('bbCli','omnyoCli')",
          )
          .all(pluginId),
      );

    const legacy = rows.find((row) => row.key === "bbCli");

    if (legacy === undefined) continue;
    z.boolean().parse(JSON.parse(legacy.value));

    if (rows.some((row) => row.key === "omnyoCli"))
      throw new Error(
        "Omnyo guide CLI preference collision; preserve both values",
      );
  }
}

function projectCommand(command: string): string {
  for (const [oldId, id] of legacyOwnedPluginIdsV1)
    if (command.startsWith(`plugin:${oldId}/`))
      return `plugin:${id}/` + command.slice(`plugin:${oldId}/`.length);

  return command;
}

function updateStructuredReferences(db: DbConnection): void {
  db.$client
    .prepare(
      "UPDATE plugin_settings SET key = 'omnyoCli' WHERE plugin_id = 'omnyo-guide' AND key = 'bbCli'",
    )
    .run();

  db.$client
    .prepare(
      "UPDATE app_settings_values SET value = ? WHERE key = 'managedBranchPrefix' AND value = ?",
    )
    .run(JSON.stringify("omnyo/"), JSON.stringify("bb/"));

  for (const table of ["ui_preferences", "ui_preference_defaults"]) {
    const rows = z
      .array(z.object({ key: z.string(), value_json: z.string() }))
      .parse(
        db.$client
          .prepare(
            `SELECT key, value_json FROM ${table} WHERE key IN ('sidebar.footerOrder','sidebar.hiddenFooterItems','sidebar.pluginPanelOrder','sidebar.visiblePluginPanels','sidebar.threadListProvider')`,
          )
          .all(),
      );

    for (const row of rows) {
      const value =
        row.key === "sidebar.threadListProvider"
          ? importLegacyNavigationKeyV1(
              z.string().parse(JSON.parse(row.value_json)),
            )
          : (z
              .array(z.string())
              .nullable()
              .parse(JSON.parse(row.value_json))
              ?.map(importLegacyNavigationKeyV1) ?? null);

      const text = JSON.stringify(value);

      if (text !== row.value_json)
        db.$client
          .prepare(`UPDATE ${table} SET value_json = ? WHERE key = ?`)
          .run(text, row.key);
    }
  }

  const settingsRows = z
    .array(z.object({ key: z.string(), value: z.string() }))
    .parse(
      db.$client
        .prepare(
          "SELECT key, value FROM app_settings_values WHERE key IN ('aiServiceSelections','keybindingOverrides')",
        )
        .all(),
    );

  for (const row of settingsRows) {
    let value: string;

    if (row.key === "aiServiceSelections") {
      const selections = aiServiceSelectionsSchema.parse(JSON.parse(row.value));

      for (const task of AI_TASKS) {
        const selection = selections[task];

        if (selection.mode === "service") {
          selection.pluginId = importLegacyOwnedPluginIdV1(selection.pluginId);

          if (selection.pluginId === "omnyo-ai" && selection.serviceId === "bb")
            selection.serviceId = "omnyo";
        }
      }

      value = JSON.stringify(selections);
    } else {
      const overrides = appKeybindingOverridesSchema.parse(
        JSON.parse(row.value),
      );

      value = JSON.stringify(
        appKeybindingOverridesSchema.parse(
          overrides.map((override) => ({
            ...override,
            command: projectCommand(override.command),
          })),
        ),
      );
    }

    if (value !== row.value)
      db.$client
        .prepare("UPDATE app_settings_values SET value = ? WHERE key = ?")
        .run(value, row.key);
  }

  const bindings = z
    .array(z.object({ id: z.string(), value: z.string() }))
    .parse(
      db.$client
        .prepare(
          "SELECT id, keybinding_overrides AS value FROM app_settings WHERE keybinding_overrides <> '[]'",
        )
        .all(),
    );

  for (const row of bindings) {
    const overrides = appKeybindingOverridesSchema.parse(JSON.parse(row.value));

    const value = JSON.stringify(
      appKeybindingOverridesSchema.parse(
        overrides.map((override) => ({
          ...override,
          command: projectCommand(override.command),
        })),
      ),
    );

    if (value !== row.value)
      db.$client
        .prepare(
          "UPDATE app_settings SET keybinding_overrides = ? WHERE id = ?",
        )
        .run(value, row.id);
  }

  for (const [oldId, id] of legacyOwnedPluginIdsV1) {
    db.$client
      .prepare(
        "UPDATE app_theme SET theme_id = ? || substr(theme_id, ?) WHERE substr(theme_id, 1, ?) = ?",
      )
      .run(
        `plugin:${id}:`,
        `plugin:${oldId}:`.length + 1,
        `plugin:${oldId}:`.length,
        `plugin:${oldId}:`,
      );
    db.$client
      .prepare(
        "UPDATE projects SET custom_icon = ? || substr(custom_icon, ?) WHERE substr(custom_icon, 1, ?) = ?",
      )
      .run(`${id}/`, oldId.length + 2, oldId.length + 1, `${oldId}/`);
  }

  const tabs = z
    .array(z.object({ thread_id: z.string(), tabs_json: z.string() }))
    .parse(
      db.$client
        .prepare(
          "SELECT thread_id, tabs_json FROM thread_tabs WHERE EXISTS (SELECT 1 FROM json_each(tabs_json) WHERE json_extract(value, '$.kind') = 'plugin-panel')",
        )
        .all(),
    );

  for (const row of tabs) {
    const original = threadTabsSchema.parse(JSON.parse(row.tabs_json));

    const projected = original.map((tab) =>
      tab.kind === "plugin-panel"
        ? { ...tab, pluginId: importLegacyOwnedPluginIdV1(tab.pluginId) }
        : tab,
    );

    if (
      original.some(
        (tab) =>
          tab.kind === "plugin-panel" &&
          importLegacyOwnedPluginIdV1(tab.pluginId) !== tab.pluginId,
      )
    )
      db.$client
        .prepare("UPDATE thread_tabs SET tabs_json = ? WHERE thread_id = ?")
        .run(JSON.stringify(projected), row.thread_id);
  }
}

function updateNamespaces(
  db: DbConnection,
  moves: z.infer<typeof moveSchema>[],
): void {
  for (const { oldId, id } of moves) {
    assertEmptyTarget(db, id);

    for (const [table, column] of namespaceColumns)
      db.$client
        .prepare(`UPDATE ${table} SET ${column} = ? WHERE ${column} = ?`)
        .run(id, oldId);

    for (const prefix of scopedSettings)
      db.$client
        .prepare("UPDATE app_settings_values SET key = ? WHERE key = ?")
        .run(`${prefix}${id}`, `${prefix}${oldId}`);
    db.$client
      .prepare(
        "UPDATE queued_thread_messages SET wait_holder = ? WHERE wait_holder = ?",
      )
      .run(`plugin:${id}`, `plugin:${oldId}`);
    db.$client
      .prepare(
        "UPDATE queued_thread_messages SET waiting_on = json_set(waiting_on, '$.pluginId', ?) WHERE json_valid(waiting_on) AND json_extract(waiting_on, '$.kind') = 'plugin' AND json_extract(waiting_on, '$.pluginId') = ?",
      )
      .run(id, oldId);
  }

  const oldCore = "bb-core-work";
  const core = "omnyo-core-work";

  if (
    db.$client
      .prepare(
        "SELECT 1 FROM thread_plugin_metadata WHERE plugin_id = ? LIMIT 1",
      )
      .get(oldCore) !== undefined
  ) {
    if (
      db.$client
        .prepare(
          "SELECT 1 FROM thread_plugin_metadata WHERE plugin_id = ? LIMIT 1",
        )
        .get(core) !== undefined
    )
      throw new Error("Omnyo core work namespace collision");
    db.$client
      .prepare(
        "UPDATE thread_plugin_metadata SET plugin_id = ? WHERE plugin_id = ?",
      )
      .run(core, oldCore);
  }

  for (const [oldName, name] of [
    ["bb-account", "omnyo-account"],
    ["bb-ai", "omnyo-ai"],
    ["bb-guide", "omnyo-guide"],
  ])
    db.$client
      .prepare(
        "UPDATE plugins SET source_builtin_name = ?, source = CASE WHEN source = ? THEN ? ELSE source END WHERE source_kind = 'builtin' AND source_builtin_name = ?",
      )
      .run(name, `builtin:${oldName}`, `builtin:${name}`, oldName);
}

async function adoptStagedPluginState(
  stage: OmnyoStagedStateRoot,
): Promise<void> {
  await assertOmnyoStagedStateRoot(stage);

  if (
    (await realpath(stage.databasePath)) !== stage.databasePath ||
    !(await lstat(stage.databasePath)).isFile()
  )
    throw new Error("Omnyo staged database must be an exact ordinary file");
  const pluginsDir = join(stage.dataDir, "plugins");

  const pluginsInfo = await lstat(pluginsDir).catch((error: unknown) => {
    if (error instanceof Error && "code" in error && error.code === "ENOENT")
      return null;
    throw error;
  });

  if (
    pluginsInfo !== null &&
    (!pluginsInfo.isDirectory() ||
      pluginsInfo.isSymbolicLink() ||
      (await realpath(pluginsDir)) !== pluginsDir)
  )
    throw new Error("Omnyo plugin parent must be an exact ordinary directory");
  const db = createConnection(stage.databasePath);

  try {
    migrate(db);
    assertLegacyGuidePreferencesV1(db);
    const marketplace = await prepareLegacyBundledMarketplaceV1(db, stage);

    const journalPath = join(stage.jobDir, "plugin-state-v1.json");

    let journal = await readFile(journalPath, "utf8").then(
      (bytes) => journalSchema.parse(JSON.parse(bytes)),
      (error: unknown) => {
        if (
          error instanceof Error &&
          "code" in error &&
          error.code === "ENOENT"
        )
          return null;
        throw error;
      },
    );

    if (journal === null) {
      const moves: z.infer<typeof moveSchema>[] = [];

      for (const [oldId, id] of legacyOwnedPluginIdsV1) {
        const digest = await stateDigest(join(stage.dataDir, "plugins", oldId));

        if (digest === null && !namespacePopulated(db, oldId)) continue;
        assertEmptyTarget(db, id);

        if ((await stateDigest(join(stage.dataDir, "plugins", id))) !== null)
          throw new Error(`Omnyo plugin directory collision: ${id}`);
        moves.push({ oldId, id, digest });
      }

      journal = {
        version: 1,
        migrationId: stage.migrationId,
        dataDir: stage.dataDir,
        sourceDigest: stage.expectedSourceDigest,
        artifactDigest: stage.artifactDigest,
        moves,
      };
      await writeJournal(journalPath, journal);
    }

    if (
      journal.migrationId !== stage.migrationId ||
      journal.dataDir !== stage.dataDir ||
      journal.sourceDigest !== stage.expectedSourceDigest ||
      journal.artifactDigest !== stage.artifactDigest ||
      journal.moves.some(
        (move) =>
          !legacyOwnedPluginIdsV1.some(
            ([oldId, id]) => oldId === move.oldId && id === move.id,
          ),
      ) ||
      new Set(journal.moves.map((move) => move.id)).size !==
        journal.moves.length
    )
      throw new Error("Omnyo plugin journal binding mismatch");

    for (const [oldId] of legacyOwnedPluginIdsV1) {
      if (
        !journal.moves.some((move) => move.oldId === oldId) &&
        (namespacePopulated(db, oldId) ||
          (await stateDigest(join(stage.dataDir, "plugins", oldId))) !== null)
      )
        throw new Error("Omnyo plugin journal omits populated legacy state");
    }

    const receipt = {
      version: 1,
      migrationId: stage.migrationId,
      sourceDigest: stage.expectedSourceDigest,
      artifactDigest: stage.artifactDigest,
      paths: [
        ...journal.moves.map((move) => ({
          from: join(stage.sourceDataDir, "plugins", move.oldId),
          to: join(stage.destinationDataDir, "plugins", move.id),
        })),
        { from: stage.sourceDataDir, to: stage.destinationDataDir },
      ],
    } satisfies z.infer<typeof omnyoPluginStateReceiptSchemaV1>;

    const receiptText = JSON.stringify(receipt);

    const applied = z
      .object({ value: z.string() })
      .optional()
      .parse(
        db.$client
          .prepare("SELECT value FROM app_settings_values WHERE key = ?")
          .get(omnyoPluginStateReceiptKeyV1),
      );

    if (applied !== undefined && applied.value !== receiptText)
      throw new Error("Omnyo plugin migration receipt collision");

    for (const move of journal.moves) {
      const from = join(stage.dataDir, "plugins", move.oldId);
      const to = join(stage.dataDir, "plugins", move.id);
      const source = await stateDigest(from);
      const target = await stateDigest(to);

      if (move.digest === null) {
        if (source !== null || target !== null)
          throw new Error("Omnyo plugin namespace changed after preflight");
      } else if (
        source === move.digest &&
        target === null &&
        applied === undefined
      ) {
        await rename(from, to);
        await syncDirectory(join(stage.dataDir, "plugins"));
      } else if (source !== null || target !== move.digest)
        throw new Error("Omnyo plugin directory journal mismatch");
    }

    if (applied !== undefined) return;
    const moves = journal.moves;
    db.$client.transaction(() => {
      updateNamespaces(db, moves);
      updateStructuredReferences(db);
      adoptLegacyBundledMarketplaceV1(db, marketplace);

      for (const paths of receipt.paths)
        db.$client
          .prepare(
            "UPDATE plugins SET source = 'path:' || ? || substr(source_path, length(?) + 1) WHERE source_kind = 'path' AND source = 'path:' || source_path AND (source_path = ? OR substr(source_path, 1, length(?) + 1) = ? || '/')",
          )
          .run(paths.to, paths.from, paths.from, paths.from, paths.from);
      rerootServerOwnedPluginPaths(db, {
        fromRoot: stage.sourceDataDir,
        toRoot: stage.destinationDataDir,
      });

      for (const move of moves)
        rerootServerOwnedPluginPaths(db, {
          fromRoot: join(stage.destinationDataDir, "plugins", move.oldId),
          toRoot: join(stage.destinationDataDir, "plugins", move.id),
        });
      db.$client
        .prepare(
          "INSERT INTO app_settings_values (key, value, updated_at) VALUES (?, ?, ?)",
        )
        .run(omnyoPluginStateReceiptKeyV1, receiptText, Date.now());
    })();
  } finally {
    db.$client.close();
  }
}

export async function adoptOmnyoPluginStateV1(
  stage: OmnyoStagedStateRoot,
): Promise<void> {
  await assertOmnyoStagedStateRoot(stage);

  if (stage.databaseState !== "present")
    throw new Error(
      "Coordinator plugin adoption requires its existing database",
    );
  await withFileLock({
    path: join(stage.jobDir, "plugin-state-v1.lock"),
    timeoutMs: 1000,
    work: () => adoptStagedPluginState(stage),
  });
}
