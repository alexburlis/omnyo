import { readFile } from "node:fs/promises";

export {
  LEGACY_APP_UPDATE_STATE_FILE_V1,
  LEGACY_APP_UPDATE_SHIM_FILE_V1,
} from "./legacy-app-update-v1.js";

import { join } from "node:path";
import { z } from "zod";
import { mutateManagedJsonFile } from "./managed-json-file.js";
import { RELEASE_VERSION_PATTERN } from "./release-version.mjs";

export const APP_UPDATE_SHIM_PROTOCOL_ENV_NAME =
  "OMNYO_APP_UPDATE_SHIM_PROTOCOL";

export const APP_UPDATE_SHIM_PROTOCOL_VERSION = 1;

export const APP_UPDATE_MODE_ENV_NAME = "OMNYO_APP_UPDATE_MODE";

export const APP_UPDATE_RESTART_EXIT_CODE = 75;

export const APP_UPDATE_STATE_FILE_NAME = "omnyo-app-update.json";

export const APP_UPDATE_SHIM_LOCK_FILE_NAME = "omnyo-app-update-shim.json";

export const APP_UPDATE_VERSIONS_DIR_NAME = "app-versions";

export const APP_UPDATE_PASSIVE_MODE = "passive";

export const APP_UPDATE_STATE_SCHEMA_VERSION = 1;

export const appUpdateModeSchema = z.enum(["npm", "source", "private"]);

export type AppUpdateMode = z.infer<typeof appUpdateModeSchema>;

export const appUpdateShimLockFileSchema = z
  .object({
    entryPath: z.string().min(1),
    pid: z.number().int().positive(),
    startedAt: z.string().min(1),
  })
  .passthrough();

export type AppUpdateShimLockFile = z.infer<typeof appUpdateShimLockFileSchema>;

const gitCommitSchema = z.string().regex(/^[0-9a-f]{40}$/u);

export const npmAppRevisionSchema = z
  .object({
    kind: z.literal("npm"),
    packageRoot: z.string().min(1),
    version: z.string().min(1),
  })
  .passthrough();

export type NpmAppRevision = z.infer<typeof npmAppRevisionSchema>;

export const sourceAppRevisionSchema = z
  .object({
    commit: gitCommitSchema,
    kind: z.literal("source"),
    version: z.string().min(1),
  })
  .passthrough();

export type SourceAppRevision = z.infer<typeof sourceAppRevisionSchema>;

export const appRevisionSchema = z.discriminatedUnion("kind", [
  npmAppRevisionSchema,
  sourceAppRevisionSchema,
]);

export type AppRevision = z.infer<typeof appRevisionSchema>;

export const appUpdateFailurePhaseSchema = z.enum([
  "prepare",
  "install",
  "startup",
]);

export type AppUpdateFailurePhase = z.infer<typeof appUpdateFailurePhaseSchema>;

export const appUpdatePendingSchema = z
  .object({
    from: appRevisionSchema,
    id: z.string().min(1),
    requestedAt: z.string().min(1),
    to: appRevisionSchema,
  })
  .passthrough();

export type AppUpdatePending = z.infer<typeof appUpdatePendingSchema>;

export const appUpdateOutcomeSchema = z.enum([
  "updated",
  "failed",
  "cancelled",
]);

export const appUpdateResultSchema = z
  .object({
    acknowledged: z.boolean(),
    errorCode: z.string().min(1).nullable().optional(),
    finishedAt: z.string().min(1),
    from: appRevisionSchema,
    id: z.string().min(1),
    logTail: z.array(z.string()),
    message: z.string().nullable(),
    outcome: appUpdateOutcomeSchema,
    phase: appUpdateFailurePhaseSchema.nullable(),
    to: appRevisionSchema,
  })
  .passthrough();

export type AppUpdateResult = z.infer<typeof appUpdateResultSchema>;

export const installedNpmAppRevisionSchema = npmAppRevisionSchema
  .extend({ nodeAbi: z.string().min(1) })
  .passthrough();

export type InstalledNpmAppRevision = z.infer<
  typeof installedNpmAppRevisionSchema
>;

export const appUpdateStateSchema = z
  .object({
    current: installedNpmAppRevisionSchema.nullable(),
    lastResult: appUpdateResultSchema.nullable(),
    pending: appUpdatePendingSchema.nullable(),
    schemaVersion: z.literal(APP_UPDATE_STATE_SCHEMA_VERSION),
  })
  .passthrough();

export type AppUpdateState = z.infer<typeof appUpdateStateSchema>;

const appUpdateBootstrapStateSchema = appUpdateStateSchema.pick({
  current: true,
  schemaVersion: true,
});

export type AppUpdateBootstrapState = z.infer<
  typeof appUpdateBootstrapStateSchema
>;

export const EMPTY_APP_UPDATE_STATE: AppUpdateState = {
  current: null,
  lastResult: null,
  pending: null,
  schemaVersion: APP_UPDATE_STATE_SCHEMA_VERSION,
};

export const PRIVATE_SERVER_UPDATE_DIR_NAME = "private-server-update";

const privateServerUpdateManifestFields = {
  version: z.string().regex(RELEASE_VERSION_PATTERN),
  protocolVersion: z.number().int().positive(),
  sourceCommit: gitCommitSchema,
  runtimeSha256: z.string().regex(/^[0-9a-f]{64}$/u),
  stagedAt: z.string().min(1),
};

export const privateServerUpdateManifestSchema = z.discriminatedUnion(
  "schema",
  [
    z
      .object({ schema: z.literal(1), ...privateServerUpdateManifestFields })
      .strict(),
    z
      .object({
        schema: z.literal(2),
        activation: z.literal("idle-only"),
        ...privateServerUpdateManifestFields,
      })
      .strict(),
  ],
);

export type PrivateServerUpdateManifest = z.infer<
  typeof privateServerUpdateManifestSchema
>;

export type PrivateServerUpdateManifestRead =
  | { kind: "none" }
  | { kind: "available"; manifest: PrivateServerUpdateManifest }
  | { kind: "invalid"; message: string };

export function formatPrivateServerUpdateManifestPath(dataDir: string): string {
  return join(dataDir, PRIVATE_SERVER_UPDATE_DIR_NAME, "approved.json");
}

export async function readPrivateServerUpdateManifest(
  dataDir: string,
): Promise<PrivateServerUpdateManifestRead> {
  const path = formatPrivateServerUpdateManifestPath(dataDir);
  let raw: string;

  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT")
      return { kind: "none" };

    return {
      kind: "invalid",
      message: `${path} could not be read: ${error instanceof Error ? error.message : String(error)}`,
    };
  }

  let value: unknown;

  try {
    value = JSON.parse(raw);
  } catch {
    return { kind: "invalid", message: `${path} is not valid JSON` };
  }

  const parsed = privateServerUpdateManifestSchema.safeParse(value);

  return parsed.success
    ? { kind: "available", manifest: parsed.data }
    : {
        kind: "invalid",
        message: `${path} does not describe a staged private runtime`,
      };
}

export function formatAppUpdateStatePath(dataDir: string): string {
  return join(dataDir, APP_UPDATE_STATE_FILE_NAME);
}

export function formatAppUpdateVersionsDir(dataDir: string): string {
  return join(dataDir, APP_UPDATE_VERSIONS_DIR_NAME);
}

export function formatAppUpdateShimLockPath(dataDir: string): string {
  return join(dataDir, APP_UPDATE_SHIM_LOCK_FILE_NAME);
}

export class AppUpdateStateUnreadableError extends Error {
  constructor(path: string) {
    super(
      `${path} was written by a newer or incompatible Omnyo; in-app updates are paused until a matching omnyo-app runs.`,
    );
  }
}

async function readAppUpdateStateValue(dataDir: string): Promise<unknown> {
  let raw: string;

  try {
    raw = await readFile(formatAppUpdateStatePath(dataDir), "utf8");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return EMPTY_APP_UPDATE_STATE;
    }

    return null;
  }

  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export async function readAppUpdateStateFile(
  dataDir: string,
): Promise<AppUpdateState | null> {
  const parsed = appUpdateStateSchema.safeParse(
    await readAppUpdateStateValue(dataDir),
  );

  return parsed.success ? parsed.data : null;
}

export async function readAppUpdateBootstrapStateFile(
  dataDir: string,
): Promise<AppUpdateBootstrapState | null> {
  const parsed = appUpdateBootstrapStateSchema.safeParse(
    await readAppUpdateStateValue(dataDir),
  );

  return parsed.success ? parsed.data : null;
}

export async function readAppUpdateState(
  dataDir: string,
): Promise<AppUpdateState> {
  return (await readAppUpdateStateFile(dataDir)) ?? EMPTY_APP_UPDATE_STATE;
}

export function mutateAppUpdateState(
  dataDir: string,
  mutate: (current: AppUpdateState) => AppUpdateState,
): Promise<AppUpdateState> {
  return mutateManagedJsonFile({
    mutate,
    path: formatAppUpdateStatePath(dataDir),
    read: async () => {
      const state = await readAppUpdateStateFile(dataDir);

      if (state === null) {
        throw new AppUpdateStateUnreadableError(
          formatAppUpdateStatePath(dataDir),
        );
      }

      return state;
    },
  });
}

export function isNightlyAppVersion(version: string): boolean {
  return /-nightly\.\d+\.\d+$/u.test(version);
}

export const appUpdateTargetSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("npm"), version: z.string().min(1) }),
  z.object({ commit: gitCommitSchema, kind: z.literal("source") }),
  z.object({
    kind: z.literal("private"),
    runtimeSha256: z.string().regex(/^[0-9a-f]{64}$/u),
    version: z.string().min(1),
  }),
]);

export type AppUpdateTarget = z.infer<typeof appUpdateTargetSchema>;

export const appUpdateBlockReasonSchema = z.enum([
  "detached-head",
  "not-on-main",
  "uncommitted-changes",
  "diverged",
  "fetch-failed",
]);

export type AppUpdateBlockReason = z.infer<typeof appUpdateBlockReasonSchema>;

export const sourceUpdateCheckSchema = z.object({
  blocked: z
    .object({
      message: z.string(),
      reason: appUpdateBlockReasonSchema,
    })
    .nullable(),
  current: sourceAppRevisionSchema,
  incoming: z
    .object({
      commit: gitCommitSchema,
      commitCount: z.number().int().nonnegative(),
      subjects: z.array(z.string()),
      version: z.string().min(1),
    })
    .nullable(),
});

export type SourceUpdateCheck = z.infer<typeof sourceUpdateCheckSchema>;

export const appUpdateActivitySchema = z.discriminatedUnion("phase", [
  z.object({ phase: z.literal("idle") }),
  z.object({
    output: z.array(z.string()),
    phase: z.literal("preparing"),
    startedAt: z.string().min(1),
    step: z.string().min(1),
    target: appUpdateTargetSchema,
    targetVersion: z.string().min(1),
  }),
  z.object({
    phase: z.literal("ready"),
    startedAt: z.string().min(1),
    target: appUpdateTargetSchema,
    targetVersion: z.string().min(1),
  }),
  z.object({
    phase: z.literal("restarting"),
    startedAt: z.string().min(1),
    target: appUpdateTargetSchema,
    targetVersion: z.string().min(1),
  }),
]);

export type AppUpdateActivity = z.infer<typeof appUpdateActivitySchema>;

export const launcherAppUpdateStatusSchema = z.object({
  activity: appUpdateActivitySchema,
  current: appRevisionSchema,
  lastResult: appUpdateResultSchema.nullable(),
  mode: appUpdateModeSchema,
});

export type LauncherAppUpdateStatus = z.infer<
  typeof launcherAppUpdateStatusSchema
>;

export const appUpdateLauncherRequestSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("check-source") }),
  z.object({
    target: appUpdateTargetSchema,
    targetVersion: z.string().min(1),
    type: z.literal("apply"),
  }),
  z.object({ id: z.string().min(1), type: z.literal("acknowledge-result") }),
  z.object({ type: z.literal("restart") }),
  z.object({
    errorCode: z.string().min(1).optional(),
    message: z.string().min(1),
    type: z.literal("cancel"),
  }),
]);

export type AppUpdateLauncherRequest = z.infer<
  typeof appUpdateLauncherRequestSchema
>;

export const serverToLauncherMessageSchema = z.discriminatedUnion("channel", [
  z.object({
    channel: z.literal("omnyo-app-update/request"),
    request: appUpdateLauncherRequestSchema,
    requestId: z.string().min(1),
  }),
  z.object({ channel: z.literal("omnyo-app-update/hello") }),
]);

export type ServerToLauncherMessage = z.infer<
  typeof serverToLauncherMessageSchema
>;

export const launcherToServerMessageSchema = z.discriminatedUnion("channel", [
  z.object({
    channel: z.literal("omnyo-app-update/response"),
    error: z.string().nullable(),
    requestId: z.string().min(1),
    result: z.unknown(),
  }),
  z.object({
    channel: z.literal("omnyo-app-update/status"),
    status: launcherAppUpdateStatusSchema,
  }),
]);

export type LauncherToServerMessage = z.infer<
  typeof launcherToServerMessageSchema
>;
