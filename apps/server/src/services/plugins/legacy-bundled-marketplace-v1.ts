import { lstat, readFile, realpath } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { isDeepStrictEqual } from "node:util";
import semver from "semver";
import { z } from "zod";
import type { DbConnection } from "@omnyo/db";
import { importLegacyOwnedPluginIdV1 } from "@omnyo/domain";
import type { OmnyoStagedStateRoot } from "@omnyo/server-archive";
import {
  BUNDLED_MARKETPLACE_NAME,
  parseBundledMarketplaceManifest,
} from "../plugin-catalog/marketplace-manifest.js";

const legacyNameV1 = "bb-official";

const currentNameV1 = "omnyo-official";

const legacyRowSchemaV1 = z
  .object({
    name: z.literal(legacyNameV1),
    sourceKind: z.literal("path"),
    manifestUrl: z.string(),
    manifestJson: z.string(),
    sourceGitRef: z.null(),
    sourceGitSubdirectory: z.null(),
    sourceGitCommit: z.null(),
    etag: z.null(),
    lastModified: z.null(),
  })
  .strict();

export function assertLegacyBundledMarketplaceAdoptedV1(
  db: DbConnection,
): void {
  if (
    db.$client
      .prepare(
        "SELECT 1 FROM plugin_marketplaces WHERE name = ? UNION ALL SELECT 1 FROM plugin_marketplace_icons WHERE marketplace_name = ? UNION ALL SELECT 1 FROM plugins WHERE catalog_marketplace_name = ? LIMIT 1",
      )
      .get(legacyNameV1, legacyNameV1, legacyNameV1) !== undefined
  )
    throw new Error(
      "Bundled marketplace requires the stopped Omnyo state migration before catalog registration",
    );
}

export async function prepareLegacyBundledMarketplaceV1(
  db: DbConnection,
  stage: OmnyoStagedStateRoot,
): Promise<{ manifestJson: string } | null> {
  const raw = db.$client
    .prepare(
      "SELECT name,source_kind AS sourceKind,manifest_url AS manifestUrl,manifest_json AS manifestJson,source_git_ref AS sourceGitRef,source_git_subdirectory AS sourceGitSubdirectory,source_git_commit AS sourceGitCommit,etag,last_modified AS lastModified FROM plugin_marketplaces WHERE name = ?",
    )
    .get(legacyNameV1);

  if (raw === undefined) {
    assertLegacyBundledMarketplaceAdoptedV1(db);

    return null;
  }

  if (
    db.$client
      .prepare(
        "SELECT 1 FROM plugin_marketplaces WHERE name = ? UNION ALL SELECT 1 FROM plugin_marketplace_icons WHERE marketplace_name = ? UNION ALL SELECT 1 FROM plugins WHERE catalog_marketplace_name = ? LIMIT 1",
      )
      .get(currentNameV1, currentNameV1, currentNameV1) !== undefined
  )
    throw new Error("Omnyo bundled marketplace namespace collision");
  const row = legacyRowSchemaV1.parse(raw);

  const parts = z
    .tuple([
      z.literal("app-versions"),
      z.string().refine((value) => semver.valid(value) !== null),
      z.literal("node_modules"),
      z.literal("bb-app"),
      z.literal("server"),
      z.literal("dist"),
      z.literal("builtin-plugins"),
    ])
    .safeParse(relative(stage.sourceDataDir, row.manifestUrl).split(sep));

  if (!parts.success)
    throw new Error(
      "Legacy bundled marketplace has no exact installed source owner",
    );

  const [resolvedDirectory, directoryInfo, packageBytes, installedBytes] =
    await Promise.all([
      realpath(row.manifestUrl),
      lstat(row.manifestUrl),
      readFile(join(row.manifestUrl, "../../../package.json"), "utf8"),
      readFile(join(row.manifestUrl, "marketplace.json"), "utf8"),
    ]);

  if (
    resolvedDirectory !== row.manifestUrl ||
    !directoryInfo.isDirectory() ||
    directoryInfo.isSymbolicLink()
  )
    throw new Error("Legacy bundled marketplace directory owner changed");
  z.object({ name: z.literal("bb-app"), version: z.literal(parts.data[1]) })
    .passthrough()
    .parse(JSON.parse(packageBytes));

  const document = z
    .record(z.string(), z.unknown())
    .parse(JSON.parse(row.manifestJson));

  z.object({ name: z.literal(legacyNameV1) })
    .passthrough()
    .parse(document);
  const installed: unknown = JSON.parse(installedBytes);

  if (!isDeepStrictEqual(document, installed))
    throw new Error(
      "Legacy bundled marketplace differs from its installed source",
    );
  parseBundledMarketplaceManifest(
    { ...document, name: BUNDLED_MARKETPLACE_NAME },
    "legacy bundled marketplace V1",
  );

  const icons = z
    .array(z.object({ entryId: z.string() }))
    .parse(
      db.$client
        .prepare(
          "SELECT entry_id AS entryId FROM plugin_marketplace_icons WHERE marketplace_name = ?",
        )
        .all(legacyNameV1),
    );

  const mapped = icons.map(({ entryId }) =>
    importLegacyOwnedPluginIdV1(entryId),
  );

  if (new Set(mapped).size !== mapped.length)
    throw new Error("Omnyo bundled marketplace icon collision");

  return {
    manifestJson: JSON.stringify({
      ...document,
      name: currentNameV1,
      ...(document.displayName === "BB Official"
        ? { displayName: "Omnyo Official" }
        : {}),
      ...(document.description === "Plugins that ship with bb."
        ? { description: "Plugins that ship with Omnyo." }
        : {}),
    }),
  };
}

export function adoptLegacyBundledMarketplaceV1(
  db: DbConnection,
  prepared: { manifestJson: string } | null,
): void {
  if (prepared === null) return;

  const plugins = z
    .array(z.object({ id: z.string(), entryId: z.string().nullable() }))
    .parse(
      db.$client
        .prepare(
          "SELECT id,catalog_entry_id AS entryId FROM plugins WHERE catalog_marketplace_name = ?",
        )
        .all(legacyNameV1),
    );

  for (const row of plugins)
    db.$client
      .prepare(
        "UPDATE plugins SET catalog_marketplace_name = ?,catalog_entry_id = ? WHERE id = ?",
      )
      .run(
        currentNameV1,
        row.entryId === null ? null : importLegacyOwnedPluginIdV1(row.entryId),
        row.id,
      );

  const icons = z
    .array(z.object({ entryId: z.string() }))
    .parse(
      db.$client
        .prepare(
          "SELECT entry_id AS entryId FROM plugin_marketplace_icons WHERE marketplace_name = ?",
        )
        .all(legacyNameV1),
    );

  for (const row of icons)
    db.$client
      .prepare(
        "UPDATE plugin_marketplace_icons SET marketplace_name = ?,entry_id = ? WHERE marketplace_name = ? AND entry_id = ?",
      )
      .run(
        currentNameV1,
        importLegacyOwnedPluginIdV1(row.entryId),
        legacyNameV1,
        row.entryId,
      );
  db.$client
    .prepare(
      "UPDATE plugin_marketplaces SET name = ?,manifest_json = ? WHERE name = ?",
    )
    .run(currentNameV1, prepared.manifestJson, legacyNameV1);
}
