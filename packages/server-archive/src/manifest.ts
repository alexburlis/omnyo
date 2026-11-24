import { z } from "zod";
import { ServerArchiveError } from "./errors.js";
import {
  findRelativePathConflict,
  safeRelativePathSchema,
} from "./relative-path.js";

export const SERVER_ARCHIVE_FORMAT = "omnyo-server-archive";

export const SERVER_ARCHIVE_VERSION = 3;

export const SERVER_ARCHIVE_MANIFEST_PATH = "manifest.json";

export const SERVER_ARCHIVE_FILES_DIR_NAME = "files";

export const serverArchiveManifestEntrySchema = z
  .object({
    path: safeRelativePathSchema,
    size: z.number().int().nonnegative(),
    sha256: z.string().regex(/^[0-9a-f]{64}$/u),
  })
  .strict();

export type ServerArchiveManifestEntry = z.infer<
  typeof serverArchiveManifestEntrySchema
>;

export const serverArchiveManifestSchema = z
  .object({
    format: z.literal(SERVER_ARCHIVE_FORMAT),
    version: z.literal(SERVER_ARCHIVE_VERSION),
    createdAt: z.number().int().nonnegative(),
    appVersion: z.string().min(1),
    protocolVersion: z.number().int().nonnegative(),
    migrationCount: z.number().int().nonnegative(),
    sourceDataDir: z.string().min(1),
    sourceServerHostId: z.string().min(1).nullable(),
    serverMoveExperiment: z.boolean(),
    entries: z.array(serverArchiveManifestEntrySchema),
  })
  .strict()
  .superRefine((manifest, context) => {
    const conflict = findRelativePathConflict(
      manifest.entries.map((entry) => entry.path),
    );

    if (conflict !== null) {
      context.addIssue({
        code: "custom",
        message: `Archive path ${conflict} conflicts with another entry`,
        path: ["entries"],
      });
    }
  });

export type ServerArchiveManifest = z.infer<typeof serverArchiveManifestSchema>;

export type ServerArchiveManifestInput = Omit<
  ServerArchiveManifest,
  "entries" | "format" | "version"
>;

const manifestVersionProbeSchema = z.object({
  format: z.string(),
  version: z.number(),
});

const legacyServerArchiveV2Schema = z
  .object({
    format: z.literal("bb-server-archive"),
    version: z.literal(2),
    createdAt: z.number().int().nonnegative(),
    bbVersion: z.string().min(1),
    appVersion: z.string().min(1).optional(),
    protocolVersion: z.number().int().nonnegative(),
    migrationCount: z.number().int().nonnegative(),
    sourceDataDir: z.string().min(1),
    sourceServerHostId: z.string().min(1).nullable(),
    serverMoveExperiment: z.boolean(),
    entries: z.array(serverArchiveManifestEntrySchema),
  })
  .strict();

export function isLegacyServerArchiveV2(value: unknown): boolean {
  const probe = manifestVersionProbeSchema.safeParse(value);

  return (
    probe.success &&
    probe.data.format === "bb-server-archive" &&
    probe.data.version === 2
  );
}

export function normalizeLegacyServerArchiveV2Path(path: string): string {
  return path === "bb.db" ? "app.db" : path;
}

function decodeLegacyServerArchiveV2(value: unknown): unknown {
  const parsed = legacyServerArchiveV2Schema.parse(value);

  if (
    parsed.appVersion !== undefined &&
    parsed.appVersion !== parsed.bbVersion
  ) {
    throw new ServerArchiveError(
      "corrupt",
      "Legacy archive version fields conflict",
    );
  }

  const { bbVersion: legacyAppVersion, ...rest } = parsed;

  return {
    ...rest,
    format: SERVER_ARCHIVE_FORMAT,
    version: SERVER_ARCHIVE_VERSION,
    appVersion: legacyAppVersion,
    entries: parsed.entries.map((entry) => ({
      ...entry,
      path: normalizeLegacyServerArchiveV2Path(entry.path),
    })),
  };
}

export function parseServerArchiveManifest(
  value: unknown,
): ServerArchiveManifest {
  const probe = manifestVersionProbeSchema.safeParse(value);

  if (
    !probe.success ||
    ![SERVER_ARCHIVE_FORMAT, "bb-server-archive"].includes(probe.data.format)
  ) {
    throw new ServerArchiveError(
      "corrupt",
      "Archive manifest is not an Omnyo server archive manifest",
    );
  }

  const legacy = isLegacyServerArchiveV2(value);

  if (
    !legacy &&
    (probe.data.format !== SERVER_ARCHIVE_FORMAT ||
      probe.data.version !== SERVER_ARCHIVE_VERSION)
  ) {
    throw new ServerArchiveError(
      "unsupported_version",
      `Unsupported server archive version ${String(probe.data.version)}`,
    );
  }

  let decoded: unknown;

  try {
    decoded = legacy ? decodeLegacyServerArchiveV2(value) : value;
  } catch (error) {
    if (error instanceof ServerArchiveError) throw error;
    throw new ServerArchiveError(
      "corrupt",
      "Legacy archive manifest is invalid",
      { cause: error },
    );
  }

  const parsed = serverArchiveManifestSchema.safeParse(decoded);

  if (!parsed.success) {
    throw new ServerArchiveError(
      "corrupt",
      `Archive manifest is invalid: ${parsed.error.message}`,
    );
  }

  return parsed.data;
}
