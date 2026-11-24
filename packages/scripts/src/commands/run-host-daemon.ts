import { access, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  OMNYO_PROD_HOST_DAEMON_PORT,
  resolvePortFromEnv,
  resolveRuntimeDataDir,
  resolveRuntimeMode,
  type AppRuntimeMode,
} from "@omnyo/config/runtime";
import { loadServerUrlValue } from "@omnyo/config/server-url";
import {
  HOST_AUTH_FILE_NAME,
  HOST_ID_FILE_NAME,
  hostDaemonEnrollKeyResponseSchema,
  type HostDaemonEnrollKeyRequest,
} from "@omnyo/host-daemon-contract";
import { loadHostDaemonEntrypointConfig } from "@omnyo/config/host-daemon-entrypoint";
import type { HostDaemonRuntimeEnvironment } from "../lib/host-daemon-runtime.js";
import { toHostDaemonProcessEnv } from "../lib/host-daemon-runtime.js";
import { resolveDevHostDaemonPort } from "../lib/dev-restart-utils.js";
import { runScriptProcess } from "../lib/process-helpers.js";
import { repoRoot, runMainIfEntrypoint } from "../lib/script-entry.js";
import { waitForServerHealth } from "../lib/wait-for-server-health.js";

async function pathExists(pathToCheck: string): Promise<boolean> {
  try {
    await access(pathToCheck);

    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return false;
    }

    throw error;
  }
}

interface HostDaemonProcessCommand {
  args: string[];
  command: string;
}

interface CreateAutoJoinRequestArgs {
  requestedHostId: string | null;
}

interface ResolveHostDaemonPortArgs {
  mode: AppRuntimeMode;
  requiresExplicitPort: boolean;
}

function resolveHostDaemonPort(args: ResolveHostDaemonPortArgs): number {
  if (
    args.requiresExplicitPort &&
    process.env.OMNYO_HOST_DAEMON_PORT === undefined
  ) {
    throw new Error(
      "OMNYO_HOST_DAEMON_PORT is required when running a dev extra-host daemon without OMNYO_DATA_DIR. Set it to a port distinct from pnpm dev's host daemon port.",
    );
  }

  return resolvePortFromEnv({
    defaultPort:
      args.mode === "dev"
        ? resolveDevHostDaemonPort()
        : OMNYO_PROD_HOST_DAEMON_PORT,
    env: process.env,
    name: "OMNYO_HOST_DAEMON_PORT",
  });
}

function ensureDevOverridePair(mode: AppRuntimeMode): void {
  if (mode !== "dev") {
    return;
  }

  const hasDataDirOverride = process.env.OMNYO_DATA_DIR !== undefined;
  const hasServerUrlOverride = process.env.OMNYO_SERVER_URL !== undefined;

  if (hasDataDirOverride !== hasServerUrlOverride) {
    throw new Error(
      "Dev host-daemon overrides must set both OMNYO_DATA_DIR and OMNYO_SERVER_URL, or neither.",
    );
  }
}

export function resolveHostDaemonRuntimeEnvironment(
  mode: AppRuntimeMode,
): HostDaemonRuntimeEnvironment {
  ensureDevOverridePair(mode);

  const usesDefaultDevExtraHost =
    mode === "dev" && process.env.OMNYO_DATA_DIR === undefined;

  const devDataDirSuffix = usesDefaultDevExtraHost ? "extra-host" : undefined;

  const dataDir = resolveRuntimeDataDir({
    env: process.env,
    homeDir: homedir(),
    mode,
    repoRoot: mode === "dev" ? repoRoot : undefined,
  });

  const hostDaemonEntrypointConfig = loadHostDaemonEntrypointConfig();

  return {
    ...hostDaemonEntrypointConfig,
    OMNYO_DATA_DIR:
      devDataDirSuffix === undefined
        ? dataDir
        : join(dataDir, devDataDirSuffix),
    OMNYO_HOST_DAEMON_PORT: String(
      resolveHostDaemonPort({
        mode,
        requiresExplicitPort: usesDefaultDevExtraHost,
      }),
    ),
    OMNYO_SERVER_URL: loadServerUrlValue({
      env: process.env,
      homeDir: homedir(),
      mode,
      repoRoot,
    }),
    NODE_ENV: mode === "dev" ? "development" : "production",
  };
}

export function resolveHostDaemonProcessCommand(
  mode: AppRuntimeMode,
): HostDaemonProcessCommand {
  if (mode === "dev") {
    return {
      args: [
        "--conditions=source",
        "--import",
        "tsx",
        "apps/host-daemon/src/index.ts",
      ],
      command: process.execPath,
    };
  }

  return {
    args: ["apps/host-daemon/dist/index.js"],
    command: process.execPath,
  };
}

async function readPersistedHostId(dataDir: string): Promise<string | null> {
  try {
    const value = (
      await readFile(join(dataDir, HOST_ID_FILE_NAME), "utf8")
    ).trim();

    return value.length > 0 ? value : null;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return null;
    }

    throw error;
  }
}

function createAutoJoinRequest(
  args: CreateAutoJoinRequestArgs,
): HostDaemonEnrollKeyRequest {
  const request: HostDaemonEnrollKeyRequest = {};

  if (args.requestedHostId !== null) {
    request.hostId = args.requestedHostId;
  }

  return request;
}

export async function maybeAddAutoJoinEnv(
  env: HostDaemonRuntimeEnvironment,
  autoJoin: boolean,
): Promise<HostDaemonRuntimeEnvironment> {
  if (!autoJoin || env.OMNYO_HOST_ENROLL_KEY) {
    return env;
  }

  if (await pathExists(join(env.OMNYO_DATA_DIR, HOST_AUTH_FILE_NAME))) {
    return env;
  }

  await waitForServerHealth(env.OMNYO_SERVER_URL);

  const requestedHostId =
    env.OMNYO_HOST_ID?.trim() ||
    (await readPersistedHostId(env.OMNYO_DATA_DIR));

  const response = await fetch(
    `${env.OMNYO_SERVER_URL}/internal/hosts/enroll-key`,
    {
      body: JSON.stringify(createAutoJoinRequest({ requestedHostId })),
      headers: {
        "content-type": "application/json",
      },
      method: "POST",
    },
  );

  if (response.status !== 201) {
    const detail = await response.text();
    throw new Error(
      `Failed to request host enroll key: ${response.status} ${response.statusText}${detail ? ` - ${detail}` : ""}`,
    );
  }

  const enrollKeyResponse = hostDaemonEnrollKeyResponseSchema.parse(
    await response.json(),
  );

  if (requestedHostId && enrollKeyResponse.hostId !== requestedHostId) {
    throw new Error(
      `Enroll key response host ID ${enrollKeyResponse.hostId} does not match persisted host ID ${requestedHostId}`,
    );
  }

  return {
    ...env,
    OMNYO_HOST_ENROLL_KEY: enrollKeyResponse.enrollKey,
    OMNYO_HOST_ID: enrollKeyResponse.hostId,
  };
}

async function main(): Promise<void> {
  const mode = resolveRuntimeMode();
  const autoJoin = process.argv.includes("--auto-join");

  const env = await maybeAddAutoJoinEnv(
    resolveHostDaemonRuntimeEnvironment(mode),
    autoJoin,
  );

  const daemonProcessCommand = resolveHostDaemonProcessCommand(mode);
  process.exitCode = await runScriptProcess({
    args: daemonProcessCommand.args,
    command: daemonProcessCommand.command,
    cwd: repoRoot,
    env: toHostDaemonProcessEnv(env),
    stdio: "inherit",
  });
}

runMainIfEntrypoint(import.meta.url, main);
