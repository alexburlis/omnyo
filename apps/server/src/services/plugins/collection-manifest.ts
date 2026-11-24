import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import type { PluginSourceSelection } from "@omnyo/server-contract";
import {
  normalizePluginSubdirectory,
  realPathInside,
} from "./install-sources.js";
import { readPluginManifest } from "./manifest.js";

const COLLECTION_MANIFEST_PATH = ".omnyo/plugins.json";

export const COLLECTION_SCHEMA_URL =
  "https://app.example.invalid/schemas/plugins.schema.json";

const COLLECTION_NAME_PATTERN = /^[a-z0-9][a-z0-9-]*$/;

function subdirectoryFromCollectionSource(source: string): string {
  if (!source.startsWith("./")) {
    throw new Error(`source "${source}" must start with "./"`);
  }

  return normalizePluginSubdirectory(source);
}

const collectionEntrySchema = z
  .object({
    name: z.string().regex(COLLECTION_NAME_PATTERN),
    source: z.string(),
  })
  .strict()
  .superRefine((entry, ctx) => {
    try {
      subdirectoryFromCollectionSource(entry.source);
    } catch (error) {
      ctx.addIssue({
        code: "custom",
        path: ["source"],
        message: error instanceof Error ? error.message : String(error),
      });
    }
  });

const pluginCollectionManifestSchema = z
  .object({
    $schema: z
      .enum([
        COLLECTION_SCHEMA_URL,
        "https://app.example.invalid/schemas/plugins.schema.json",
      ])
      .optional(),
    schemaVersion: z.literal(1),
    name: z.string().regex(COLLECTION_NAME_PATTERN),
    plugins: z.array(collectionEntrySchema).min(1),
  })
  .strict()
  .superRefine((manifest, ctx) => {
    const seen = new Set<string>();
    manifest.plugins.forEach((entry, index) => {
      if (seen.has(entry.name)) {
        ctx.addIssue({
          code: "custom",
          path: ["plugins", index, "name"],
          message: `duplicate plugin name "${entry.name}"`,
        });
      }

      seen.add(entry.name);
    });
  });

type PluginCollectionManifest = z.infer<typeof pluginCollectionManifestSchema>;

export function formatIssues(error: z.ZodError): string {
  return error.issues
    .map((issue) => {
      const path = issue.path.join(".");

      return path.length === 0 ? issue.message : `${path}: ${issue.message}`;
    })
    .join("; ");
}

export function parseJsonDocument(raw: string, location: string): unknown {
  try {
    return JSON.parse(raw);
  } catch (error) {
    throw new Error(
      `invalid ${location}: not valid JSON (${error instanceof Error ? error.message : String(error)})`,
    );
  }
}

export function parsePluginCollectionManifest(
  raw: string,
  location: string,
): PluginCollectionManifest {
  const json = parseJsonDocument(raw, location);
  const parsed = pluginCollectionManifestSchema.safeParse(json);

  if (!parsed.success) {
    throw new Error(`invalid ${location}: ${formatIssues(parsed.error)}`);
  }

  return parsed.data;
}

function parseLegacyPluginCollectionManifestV1(
  raw: string,
): PluginCollectionManifest {
  const location = ".bb/plugins.json";
  const input = parseJsonDocument(raw, location);

  const normalized =
    typeof input === "object" &&
    input !== null &&
    !Array.isArray(input) &&
    "$schema" in input &&
    input.$schema === "https://getbb.app/schemas/plugins.schema.json"
      ? { ...input, $schema: COLLECTION_SCHEMA_URL }
      : input;

  const parsed = pluginCollectionManifestSchema.safeParse(normalized);

  if (!parsed.success)
    throw new Error(`invalid ${location}: ${formatIssues(parsed.error)}`);

  return parsed.data;
}

async function readCollectionFile(
  checkoutDir: string,
  location: string,
): Promise<string | null> {
  let realPath: string;

  try {
    realPath = await realPathInside(
      checkoutDir,
      join(checkoutDir, location),
      location,
    );
  } catch (error) {
    if (
      error instanceof Error &&
      "code" in error &&
      (error.code === "ENOENT" || error.code === "ENOTDIR")
    )
      return null;

    throw error;
  }

  return readFile(realPath, "utf8");
}

export async function readPluginCollectionManifest(
  checkoutDir: string,
): Promise<PluginCollectionManifest | null> {
  const [canonical, legacy] = await Promise.all([
    readCollectionFile(checkoutDir, COLLECTION_MANIFEST_PATH),
    readCollectionFile(checkoutDir, ".bb/plugins.json"),
  ]);

  if (canonical !== null && legacy !== null)
    throw new Error(
      "Plugin collection collision: both .omnyo/plugins.json and legacy .bb/plugins.json exist; select and preserve the intended manifest before installing.",
    );

  if (canonical !== null)
    return parsePluginCollectionManifest(canonical, COLLECTION_MANIFEST_PATH);

  if (legacy !== null) return parseLegacyPluginCollectionManifestV1(legacy);

  return null;
}

export function subdirectoryForCollectionEntry(
  manifest: PluginCollectionManifest,
  name: string,
): string {
  const entry = manifest.plugins.find((plugin) => plugin.name === name);

  if (entry === undefined) {
    throw new Error(
      `${COLLECTION_MANIFEST_PATH} has no plugin "${name}" — available: ${manifest.plugins
        .map((plugin) => plugin.name)
        .join(", ")}`,
    );
  }

  return subdirectoryFromCollectionSource(entry.source);
}

export async function resolveSelectedSubdirectory(args: {
  checkoutDir: string;
  selection: PluginSourceSelection;
  sourceLabel: string;
}): Promise<string | null> {
  if (args.selection.kind === "subdirectory") {
    return normalizePluginSubdirectory(args.selection.path);
  }

  const manifest = await readPluginCollectionManifest(args.checkoutDir);

  if (args.selection.kind === "entry") {
    if (manifest === null) {
      throw new Error(
        `${args.sourceLabel} has no ${COLLECTION_MANIFEST_PATH} collection manifest — install it with --subdirectory instead`,
      );
    }

    return subdirectoryForCollectionEntry(manifest, args.selection.name);
  }

  if (manifest === null) return null;

  const rootIsPlugin = await readPluginManifest(args.checkoutDir)
    .then(() => true)
    .catch(() => false);

  if (rootIsPlugin) return null;
  throw new Error(
    `${args.sourceLabel} contains several plugins — select one with --plugin <name> (${manifest.plugins
      .map((plugin) => plugin.name)
      .join(", ")}) or --subdirectory <path>`,
  );
}
