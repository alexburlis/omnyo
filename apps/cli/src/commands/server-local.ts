import { createHash, randomBytes } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { identityAdoptionControlRequestSchemaV1 } from "@omnyo/domain";
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { assertConfiguredOmnyoStateWriteAdmission } from "@omnyo/config/omnyo-state-startup";
import {
  type AppManagedConfig,
  formatAppConfigPath,
  parseAppManagedConfig,
} from "@omnyo/config/managed-app-config";
import {
  parseDataDirEnvValue,
  resolveProdDataDir,
} from "@omnyo/config/runtime";
import {
  assertServerArchiveFormat,
  extractServerArchive,
  installImportedServerFiles,
  discardImportBackups,
  readServerImportFile,
  readServerImportJournalStatus,
  removeServerConnectHoldFile,
  removeServerImportJournalFile,
  rollBackServerImport,
  SERVER_IMPORT_FILE_NAME,
  SERVER_MOVED_FILE_NAME,
  ServerArchiveError,
  type ServerMovedFile,
  writeServerConnectHoldFile,
  writeServerImportFile,
  readRuntimeIdentity,
  verifyRuntimeIdentity,
  assertStoppedIdentityRuntimeOwnersV1,
} from "@omnyo/server-archive";
import { z } from "zod";

const SERVER_DATABASE_FILE_NAME = "app.db";

export async function runIdentityAdoptionLocal(args: {
  requestFile: string;
  phase: "preflight" | "stage" | "rollback";
}): Promise<unknown> {
  const path = resolve(args.requestFile);
  const raw = await readFile(path, "utf8");
  const sha256 = createHash("sha256").update(raw).digest("hex");
  const request = identityAdoptionControlRequestSchemaV1.parse(JSON.parse(raw));

  const identity = await verifyRuntimeIdentity(
    request.binding.runtimeRoot,
    await readRuntimeIdentity(request.binding.runtimeRoot),
  );

  if (identity.runtimeSha256 !== request.binding.runtimeSha256)
    throw new Error(
      "Selected identity control runtime differs from the approved artifact",
    );

  const entry = join(
    request.binding.runtimeRoot,
    "server/dist/omnyo-identity-adoption.js",
  );

  const execute = promisify(execFile);

  const invoke = async (phase: string) => {
    const result = await execute(
      process.execPath,
      [
        entry,
        "--phase",
        phase,
        "--request-file",
        path,
        "--request-sha256",
        sha256,
      ],
      { timeout: 60000, maxBuffer: 1024 * 1024 },
    );

    return JSON.parse(result.stdout);
  };

  if (args.phase !== "preflight") await invoke("preflight");

  return invoke(args.phase);
}

const MOVED_DAEMON_CONFIG_KEYS: readonly string[] = [
  "serverUrl",
  "serverHeaders",
  "machineCredential",
  "connectMachineId",
];

const managedConfigObjectSchema = z.record(z.string(), z.unknown());

const MOVED_SERVER_PROBE_TIMEOUT_MS = 5_000;

const VERSION_PATTERN =
  /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/u;

const NUMERIC_IDENTIFIER_PATTERN = /^\d+$/u;

const healthResponseSchema = z.object({
  ok: z.literal(true),
  serverMove: z.object({ state: z.string() }).optional(),
});

export interface ServerImportArgs {
  archivePath: string;
  dataDir: string;
  confirm: (message: string) => Promise<boolean>;
  now: () => number;
  cliVersion: string;
}

interface ParsedVersion {
  core: number[];
  prerelease: string[];
}

function parseVersion(value: string): ParsedVersion | null {
  const match = VERSION_PATTERN.exec(value.trim());

  if (match === null) return null;

  return {
    core: [Number(match[1]), Number(match[2]), Number(match[3])],
    prerelease: match[4] === undefined ? [] : match[4].split("."),
  };
}

function comparePrerelease(left: string[], right: string[]): number {
  if (left.length === 0 || right.length === 0) {
    return right.length - left.length;
  }

  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const a = left[index];
    const b = right[index];

    if (a === undefined) return -1;

    if (b === undefined) return 1;
    const aNumeric = NUMERIC_IDENTIFIER_PATTERN.test(a);
    const bNumeric = NUMERIC_IDENTIFIER_PATTERN.test(b);

    if (aNumeric && bNumeric) {
      const delta = Number(a) - Number(b);

      if (delta !== 0) return delta;
      continue;
    }

    if (aNumeric !== bNumeric) return aNumeric ? -1 : 1;

    if (a !== b) return a < b ? -1 : 1;
  }

  return 0;
}

export function isNewerAppVersion(candidate: string, current: string): boolean {
  const a = parseVersion(candidate);
  const b = parseVersion(current);

  if (a === null || b === null) return false;

  for (let index = 0; index < 3; index += 1) {
    const delta = (a.core[index] ?? 0) - (b.core[index] ?? 0);

    if (delta !== 0) return delta > 0;
  }

  return comparePrerelease(a.prerelease, b.prerelease) > 0;
}

export type MovedServerProbeResult =
  | { kind: "running" }
  | { kind: "not-running" }
  | { kind: "unconfirmed"; status: number };

export interface ProbeMovedServerArgs {
  dataDir: string;
  lock: ServerMovedFile;
}

async function isHealthyServer(serverUrl: string): Promise<boolean> {
  try {
    const response = await fetch(`${serverUrl}/health`, {
      signal: AbortSignal.timeout(MOVED_SERVER_PROBE_TIMEOUT_MS),
    });

    if (response.status !== 200) return false;
    const health = healthResponseSchema.safeParse(await response.json());

    return health.success && health.data.serverMove?.state !== "pending";
  } catch {
    return false;
  }
}

async function readMovedServerHeaders(
  dataDir: string,
): Promise<Record<string, string> | null> {
  const configPath = formatAppConfigPath(dataDir);
  const text = await readOptionalText(configPath);

  if (text === null) return null;
  const headers = parseManagedConfigText(configPath, text).config.serverHeaders;

  return headers === undefined || Object.keys(headers).length === 0
    ? null
    : headers;
}

export async function probeMovedServer(
  args: ProbeMovedServerArgs,
): Promise<MovedServerProbeResult> {
  const serverUrl = args.lock.serverUrl.replace(/\/+$/u, "");

  const headers =
    args.lock.mode === "connect"
      ? await readMovedServerHeaders(args.dataDir)
      : null;

  if (headers === null) {
    return (await isHealthyServer(serverUrl))
      ? { kind: "running" }
      : { kind: "not-running" };
  }

  let response: Response;

  try {
    response = await fetch(`${serverUrl}/api/v1/system/version`, {
      headers,
      signal: AbortSignal.timeout(MOVED_SERVER_PROBE_TIMEOUT_MS),
    });
  } catch {
    return { kind: "not-running" };
  }

  await response.body?.cancel().catch(() => undefined);

  if (response.status === 200) return { kind: "running" };

  if (response.status === 503) return { kind: "not-running" };

  return { kind: "unconfirmed", status: response.status };
}

export interface ServerImportResult {
  dataDir: string;
  archivePath: string;
  appVersion: string;
  sourceDataDir: string;
  sourceServerHostId: string | null;
  importedEntries: string[];
  rolledBackInterruptedImport: boolean;
}

function hasErrorCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);

    return true;
  } catch (error) {
    if (hasErrorCode(error, "ENOENT")) return false;
    throw error;
  }
}

export function isDefaultDataDir(dataDir: string): boolean {
  return dataDir === resolve(resolveProdDataDir({ homeDir: homedir() }));
}

export function resolveLocalDataDir(dataDirOption: string | undefined): string {
  const homeDir = homedir();

  if (dataDirOption !== undefined) {
    if (dataDirOption.trim().length === 0) {
      throw new Error("--data-dir must not be empty.");
    }

    return resolve(
      parseDataDirEnvValue({ homeDir, rawDataDir: dataDirOption }),
    );
  }

  const configured = process.env.OMNYO_DATA_DIR;

  return resolve(
    configured === undefined || configured.trim().length === 0
      ? resolveProdDataDir({ homeDir })
      : parseDataDirEnvValue({ homeDir, rawDataDir: configured }),
  );
}

const PRE_CUTOVER_DATABASE_FILES_V1 = ["bb.db", "bb.db-wal", "bb.db-shm"];

async function assertNoPreCutoverDatabaseV1(dataDir: string): Promise<void> {
  const present = await Promise.all(
    PRE_CUTOVER_DATABASE_FILES_V1.map((name) =>
      pathExists(join(dataDir, name)),
    ),
  );

  if (present.includes(true)) {
    throw new Error(
      "Existing database requires the stopped-owner Omnyo migration before startup",
    );
  }
}

async function assertNoServerDatabase(dataDir: string): Promise<void> {
  await assertNoPreCutoverDatabaseV1(dataDir);
  assertConfiguredOmnyoStateWriteAdmission(dataDir);

  if (await pathExists(join(dataDir, SERVER_DATABASE_FILE_NAME))) {
    throw new Error(
      `${dataDir} already has an Omnyo server database (${SERVER_DATABASE_FILE_NAME}). Import into a data directory without a server, such as --data-dir ~/.omnyo-imported.`,
    );
  }
}

async function assertNoRunningApp(dataDir: string): Promise<void> {
  await assertStoppedIdentityRuntimeOwnersV1(dataDir);
}

async function assertArchiveFile(archivePath: string): Promise<void> {
  let stats;

  try {
    stats = await stat(archivePath);
  } catch (error) {
    if (hasErrorCode(error, "ENOENT")) {
      throw new Error(`${archivePath} does not exist.`);
    }

    throw error;
  }

  if (!stats.isFile()) throw new Error(`${archivePath} is not a file.`);
}

function describeUnsafeImport(archivePath: string, error: unknown): unknown {
  if (error instanceof ServerArchiveError && error.code === "unsafe_entry") {
    return new Error(
      `Refusing to import ${archivePath}: ${error.message}. Nothing was imported.`,
    );
  }

  return error;
}

async function rollBackInterruptedImport(dataDir: string): Promise<void> {
  await rollBackServerImport(dataDir);
  await removeServerConnectHoldFile(dataDir);
  const marker = await readServerImportFile(dataDir);

  if (marker?.kind === "manual") {
    await rm(join(dataDir, SERVER_IMPORT_FILE_NAME), { force: true });
  }
}

export async function importServerArchive(
  args: ServerImportArgs,
): Promise<ServerImportResult | null> {
  const { archivePath, dataDir } = args;
  await assertArchiveFile(archivePath);

  const interruptedImport =
    (await readServerImportJournalStatus(dataDir)).kind === "interrupted";

  if (!interruptedImport) {
    await assertNoServerDatabase(dataDir);
  }

  await assertNoRunningApp(dataDir);
  await assertServerArchiveFormat(archivePath);

  if (
    !(await args.confirm(
      interruptedImport
        ? `Roll back the interrupted import in ${dataDir}, then import the Omnyo server from ${archivePath}?`
        : `Import the Omnyo server from ${archivePath} into ${dataDir}?`,
    ))
  ) {
    return null;
  }

  if (interruptedImport) {
    await rollBackInterruptedImport(dataDir);
    await assertNoServerDatabase(dataDir);
  }

  const parentDir = dirname(dataDir);
  await mkdir(parentDir, { recursive: true });

  const stagingDir = await mkdtemp(
    join(parentDir, `.${basename(dataDir)}-server-import-`),
  );

  try {
    const manifest = await extractServerArchive({
      archivePath,
      destinationDir: stagingDir,
    }).catch((error: unknown) => {
      throw describeUnsafeImport(archivePath, error);
    });

    if (!manifest.serverMoveExperiment) {
      throw new Error(
        'This export came from a server with the "Server move" experiment off. Run omnyo settings experiment serverMove true on that server, then export again.',
      );
    }

    if (isNewerAppVersion(manifest.appVersion, args.cliVersion)) {
      throw new Error(
        `This export came from Omnyo ${manifest.appVersion}; install that version or newer before importing.`,
      );
    }

    const installed = await installImportedServerFiles({
      stagingDir,
      dataDir,
      manifest,
      localServerUrl: null,
    }).catch((error: unknown) => {
      throw describeUnsafeImport(archivePath, error);
    });

    try {
      await writeServerConnectHoldFile(dataDir, {
        version: 1,
        reason: "manual-import",
        createdAt: args.now(),
      });
      await writeServerImportFile(dataDir, {
        version: 1,
        kind: "manual",
        moveId: null,
        activationToken: null,
        sourceDataDir: manifest.sourceDataDir,
        sourceServerHostId: manifest.sourceServerHostId,
        targetHostId: null,
        serverUrl: null,
        importedEntries: installed.importedEntries,
        createdAt: args.now(),
        fixupsAppliedAt: null,
      });
    } catch (error) {
      await removeServerConnectHoldFile(dataDir);
      await rollBackServerImport(dataDir);
      throw error;
    }

    await removeServerImportJournalFile(dataDir);
    await discardImportBackups(dataDir);

    return {
      dataDir,
      archivePath,
      appVersion: manifest.appVersion,
      sourceDataDir: manifest.sourceDataDir,
      sourceServerHostId: manifest.sourceServerHostId,
      importedEntries: installed.importedEntries,
      rolledBackInterruptedImport: interruptedImport,
    };
  } finally {
    await rm(stagingDir, { force: true, recursive: true });
  }
}

async function readOptionalText(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if (hasErrorCode(error, "ENOENT")) return null;
    throw error;
  }
}

async function writeTextAtomically(path: string, text: string): Promise<void> {
  const tempPath = `${path}.${randomBytes(6).toString("hex")}.tmp`;

  try {
    await writeFile(tempPath, text, { encoding: "utf8", mode: 0o600 });
    await rename(tempPath, path);
  } catch (error) {
    await rm(tempPath, { force: true });
    throw error;
  }
}

interface ParsedManagedConfig {
  raw: Record<string, unknown>;
  config: AppManagedConfig;
}

function parseManagedConfigText(
  path: string,
  text: string,
): ParsedManagedConfig {
  let raw: unknown;

  try {
    raw = JSON.parse(text);
  } catch (error) {
    throw new Error(`${path} is not valid JSON. Fix it, then unlock again.`, {
      cause: error,
    });
  }

  let config: AppManagedConfig;

  try {
    config = parseAppManagedConfig(raw);
  } catch (error) {
    const detail =
      error instanceof z.ZodError ? z.prettifyError(error) : String(error);

    throw new Error(
      `${path} is not a valid omnyo-app config. Fix it, then unlock again.\n${detail}`,
    );
  }

  return { raw: managedConfigObjectSchema.parse(raw), config };
}

export async function unlockServerCopy(dataDir: string): Promise<string[]> {
  const lockPath = join(dataDir, SERVER_MOVED_FILE_NAME);
  const configPath = formatAppConfigPath(dataDir);
  const originalText = await readOptionalText(configPath);

  if (originalText === null) {
    await rm(lockPath, { force: true });

    return [];
  }

  const current = parseManagedConfigText(configPath, originalText).raw;

  const removedConfigKeys = MOVED_DAEMON_CONFIG_KEYS.filter((key) =>
    Object.hasOwn(current, key),
  );

  if (removedConfigKeys.length === 0) {
    await rm(lockPath, { force: true });

    return [];
  }

  const next = Object.fromEntries(
    Object.entries(current).filter(
      ([key]) => !MOVED_DAEMON_CONFIG_KEYS.includes(key),
    ),
  );

  parseAppManagedConfig(next);
  await writeTextAtomically(configPath, `${JSON.stringify(next, null, 2)}\n`);

  try {
    await rm(lockPath, { force: true });
  } catch (error) {
    await writeTextAtomically(configPath, originalText);
    throw error;
  }

  return removedConfigKeys;
}
