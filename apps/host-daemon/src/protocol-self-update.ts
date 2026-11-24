import { readFileSync } from "node:fs";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { delimiter, dirname, isAbsolute, join } from "node:path";
import { z } from "zod";
import { calculateExponentialBackoffDelay } from "@omnyo/domain";
import {
  compareReleaseVersions,
  parseReleaseVersion,
} from "@omnyo/config/release-version";
import {
  PENDING_RUNTIME_INSTALL_FILE_NAME,
  PENDING_RUNTIME_INSTALL_TARBALL_NAME,
} from "@omnyo/config/machine-service";
import { HOST_DAEMON_PROTOCOL_VERSION } from "@omnyo/host-daemon-contract";
import { verifyHostArtifactSignature } from "@omnyo/host-daemon-contract/host-artifact-signature";
import { execPortableFile, isProcessGroupAlive } from "@omnyo/process-utils";
import type { HostDaemonLogger } from "./logger.js";
import type { FetchFn } from "./server-client.js";
import { usesSecureInternalFetchTransport } from "./server-client.js";
import { sha256Hex } from "./sha256-hex.js";
import { waitForUpdateCheckpoint } from "./update-delivery-checkpoint.js";

export const SELF_UPDATE_INITIAL_RETRY_DELAY_MS = 5_000;

export const SELF_UPDATE_MAX_RETRY_DELAY_MS = 5 * 60 * 1000;

export const SELF_UPDATE_IDLE_RETRY_MS = 60 * 1000;

const ATTEMPT_FILE_NAME = "host-daemon-update-attempt.json";

const INSTALLED_ARTIFACT_DIGEST_FILE_NAME = "host-artifact.sha256";

const ARTIFACT_DIGEST_HEADER = "x-omnyo-artifact-sha256";

const MACHINE_CREDENTIAL_HEADER = "x-omnyo-connect-machine";

const ARTIFACT_DIGEST_PATTERN = /^[a-f0-9]{64}$/u;

class UpdateAccessRefusedError extends Error {
  readonly path: string;

  constructor(path: string) {
    super(`Update request refused: HTTP 403 ${path}`);
    this.name = "UpdateAccessRefusedError";
    this.path = path;
  }
}

const updateVersionSchema = z.object({
  protocolVersion: z.number().int().positive(),
  version: z.string().min(1),
  artifactDigest: z.string().regex(ARTIFACT_DIGEST_PATTERN),
});

const updateVersionResponseSchema = updateVersionSchema.extend({
  artifactSignature: z.string().min(1).nullish(),
  artifactSignatureKeyId: z.string().min(1).nullish(),
});

interface ServerArtifactSignature {
  signature: string;
  keyId: string;
}

interface ServerUpdateOffer {
  target: z.infer<typeof updateVersionSchema>;
  signature: ServerArtifactSignature | null;
}

const installerUncertaintySchema = z.object({
  treeTermination: z.literal("unverified"),
  processGroupId: z.number().int().positive().nullable(),
  processPlatform: z.string().nullable(),
});

const updateAttemptSchema = z.object({
  installer: installerUncertaintySchema.optional(),
  attemptedAt: z.number(),
  attemptCount: z.number().int().positive(),
  protocolVersion: z.number().int().positive(),
  version: z.string().optional(),
  artifactDigest: z.string().regex(ARTIFACT_DIGEST_PATTERN).optional(),
});

type UpdateAttempt = z.infer<typeof updateAttemptSchema>;

export type ProtocolSelfUpdateTarget = z.infer<typeof updateVersionSchema>;

export type ProtocolSelfUpdateResult = "failed" | "skipped" | "updated";

export interface ProtocolSelfUpdateStatus {
  phase:
    | "idle"
    | "checking"
    | "staging"
    | "waiting-for-idle"
    | "installing"
    | "updated"
    | "disabled"
    | "current"
    | "backoff"
    | "failed";
  target: ProtocolSelfUpdateTarget | null;
  reason:
    | "disabled"
    | "current"
    | "busy"
    | "backoff"
    | "target_changed"
    | "failed"
    | "in_progress"
    | "insecure_transport"
    | "invalid_target"
    | "installer_unverified"
    | "access_refused"
    | "signature_unverified"
    | null;
  retryAt: number | null;
}

export type ProtocolSelfUpdateInstallMode =
  | "in-place"
  | "service-handoff"
  | "unsupported";

export interface ProtocolSelfUpdater {
  checkForUpdates?(): Promise<ProtocolSelfUpdateResult>;
  getStatus?(): ProtocolSelfUpdateStatus;
  requestUpdate?(
    target: ProtocolSelfUpdateTarget,
  ): Promise<ProtocolSelfUpdateResult>;
  handleProtocolMismatch(options?: {
    force?: boolean;
  }): Promise<ProtocolSelfUpdateResult>;
}

interface ProtocolSelfUpdateInstaller {
  (tarballPath: string): Promise<void>;
}

interface SelfUpdateProcessRunner {
  (
    command: string,
    args: string[],
    options: { env: NodeJS.ProcessEnv; timeout: number },
  ): Promise<void>;
}

interface CreateProtocolSelfUpdaterOptions {
  currentVersion?: string;
  acquireUpdate?: () => boolean;
  isIdle?: () => boolean;
  onInstalled?: () => void;
  onBeforeRestart?: (target: ProtocolSelfUpdateTarget) => Promise<void>;
  installMode?: ProtocolSelfUpdateInstallMode;
  protectUpdate?: () => boolean;
  releaseUpdate?: () => void;
  prepareUpdate?: (signal: AbortSignal) => Promise<void>;
  resumeDelivery?: () => void;
  dataDir: string;
  enabled: boolean;
  logger: HostDaemonLogger;
  serverUrl: string;
  machineCredential?: string;
  signingPublicKeys?: readonly string[];
  fetchFn?: FetchFn;
  installTarball?: ProtocolSelfUpdateInstaller;
  runProcess?: SelfUpdateProcessRunner;
  now?: () => number;
}

async function readLastAttempt(path: string): Promise<UpdateAttempt | null> {
  try {
    return updateAttemptSchema.parse(JSON.parse(await readFile(path, "utf8")));
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT")
      return null;
    throw Object.assign(
      new Error(
        "Installer attempt state is unreadable or invalid; installation safety is unknown",
      ),
      { treeTermination: "unverified" },
    );
  }
}

async function writeAttempt(
  path: string,
  attempt: UpdateAttempt,
): Promise<void> {
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(attempt)}\n`, {
    mode: 0o600,
  });
  await rename(temporary, path);
}

async function writePendingServiceInstall(
  dataDir: string,
  stagedTarballPath: string,
  target: ProtocolSelfUpdateTarget,
  requestedAt: number,
): Promise<void> {
  await rename(
    stagedTarballPath,
    join(dataDir, PENDING_RUNTIME_INSTALL_TARBALL_NAME),
  );
  const path = join(dataDir, PENDING_RUNTIME_INSTALL_FILE_NAME);
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(
    temporary,
    `${JSON.stringify({
      schema: 1,
      requestedAt,
      protocolVersion: target.protocolVersion,
      version: target.version,
      artifactDigest: target.artifactDigest,
      tarball: PENDING_RUNTIME_INSTALL_TARBALL_NAME,
    })}\n`,
    { mode: 0o600 },
  );
  await rename(temporary, path);
}

async function readInstalledArtifactDigest(
  path: string,
): Promise<string | null> {
  try {
    const digest = (await readFile(path, "utf8")).trim();

    return ARTIFACT_DIGEST_PATTERN.test(digest) ? digest : null;
  } catch {
    return null;
  }
}

async function writeInstalledArtifactDigest(
  path: string,
  digest: string,
): Promise<void> {
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, `${digest}\n`, { mode: 0o600 });
  await rename(temporary, path);
}

function responseArtifactDigest(response: Response): string | null {
  const digest = response.headers.get(ARTIFACT_DIGEST_HEADER);

  return digest !== null && ARTIFACT_DIGEST_PATTERN.test(digest)
    ? digest
    : null;
}

const SELF_UPDATE_PROCESS_MAX_BUFFER_BYTES = 16 * 1024 * 1024;

export const defaultRunProcess: SelfUpdateProcessRunner = async (
  command,
  args,
  options,
) => {
  try {
    await execPortableFile(command, args, {
      cwd: process.cwd(),
      env: options.env,
      maxBuffer: SELF_UPDATE_PROCESS_MAX_BUFFER_BYTES,
      timeout: options.timeout,
    });
  } catch (error) {
    if (
      error instanceof Error &&
      Reflect.get(error, "treeTermination") === undefined
    ) {
      Object.assign(error, {
        treeTermination:
          Reflect.get(error, "code") === "ENOENT" ? "confirmed" : "unverified",
      });
    }

    throw error;
  }
};

const OMNYO_APP_ALLOW_SCRIPTS_ARG =
  "--allow-scripts=better-sqlite3,node-pty,@parcel/watcher";

export async function defaultInstallTarball(
  tarballPath: string,
  runProcess: SelfUpdateProcessRunner,
): Promise<void> {
  const executableDirectory = dirname(process.execPath);
  const inheritedPath = process.env.PATH;

  const path = inheritedPath
    ? `${executableDirectory}${delimiter}${inheritedPath}`
    : executableDirectory;

  const rawConfiguredPrefix = process.env.OMNYO_APP_NPM_PREFIX?.trim();

  const configuredPrefix =
    rawConfiguredPrefix === "" ? undefined : rawConfiguredPrefix;

  if (configuredPrefix !== undefined && !isAbsolute(configuredPrefix)) {
    throw Object.assign(
      new Error("OMNYO_APP_NPM_PREFIX must be an absolute path"),
      { treeTermination: "confirmed" },
    );
  }

  const prefixArgs =
    configuredPrefix === undefined ? [] : ["--prefix", configuredPrefix];

  await runProcess(
    "npm",
    ["install", "-g", OMNYO_APP_ALLOW_SCRIPTS_ARG, ...prefixArgs, tarballPath],
    {
      env: { ...process.env, PATH: path },
      timeout: 10 * 60 * 1000,
    },
  );
}

export function createProtocolSelfUpdater(
  options: CreateProtocolSelfUpdaterOptions,
): ProtocolSelfUpdater & {
  checkForUpdates(): Promise<ProtocolSelfUpdateResult>;
  getStatus(): ProtocolSelfUpdateStatus;
  requestUpdate(
    target: ProtocolSelfUpdateTarget,
  ): Promise<ProtocolSelfUpdateResult>;
  serviceInstallPending(): boolean;
} {
  const fetchFn = options.fetchFn ?? fetch;
  const machineCredential = options.machineCredential?.trim() ?? "";

  const credentialHeaders: Record<string, string> =
    machineCredential === ""
      ? {}
      : { [MACHINE_CREDENTIAL_HEADER]: machineCredential };

  const installTarball =
    options.installTarball ??
    ((tarballPath) =>
      defaultInstallTarball(
        tarballPath,
        options.runProcess ?? defaultRunProcess,
      ));

  const now = options.now ?? Date.now;
  const installMode = options.installMode ?? "in-place";
  const attemptPath = join(options.dataDir, ATTEMPT_FILE_NAME);
  let serviceInstallPending = false;

  const installedArtifactDigestPath = join(
    options.dataDir,
    INSTALLED_ARTIFACT_DIGEST_FILE_NAME,
  );

  let pending: Promise<ProtocolSelfUpdateResult> | null = null;
  let idleRetry: ReturnType<typeof setTimeout> | null = null;
  let idleWaitVersion: string | null = null;
  let unsafeProtectionHeld = false;

  let status: ProtocolSelfUpdateStatus = {
    phase: options.enabled ? "idle" : "disabled",
    target: null,
    reason: options.enabled ? null : "disabled",
    retryAt: null,
  };

  try {
    const restored = updateAttemptSchema.parse(
      JSON.parse(readFileSync(attemptPath, "utf8")),
    );

    if (restored.installer !== undefined) {
      unsafeProtectionHeld =
        (options.protectUpdate ?? options.acquireUpdate)?.() === true;
      status = { ...status, phase: "failed", reason: "installer_unverified" };
    }
  } catch (error) {
    if (
      !(error instanceof Error && "code" in error && error.code === "ENOENT")
    ) {
      unsafeProtectionHeld =
        (options.protectUpdate ?? options.acquireUpdate)?.() === true;
      status = { ...status, phase: "failed", reason: "installer_unverified" };
      options.logger.error(
        {},
        "Installer attempt state is unreadable or invalid; refusing new installation until the existing attempt is reconciled.",
      );
    }
  }

  function setStatus(
    phase: ProtocolSelfUpdateStatus["phase"],
    reason: ProtocolSelfUpdateStatus["reason"] = null,
    retryAt: number | null = null,
  ): void {
    status = { ...status, phase, reason, retryAt };
  }

  function sameTarget(
    first: ProtocolSelfUpdateTarget,
    second: ProtocolSelfUpdateTarget,
  ): boolean {
    return (
      first.protocolVersion === second.protocolVersion &&
      first.version === second.version &&
      first.artifactDigest === second.artifactDigest
    );
  }

  async function readOffer(timeoutMs = 30_000): Promise<ServerUpdateOffer> {
    const versionResponse = await fetchFn(
      new URL("/install/version", options.serverUrl),
      {
        method: "GET",
        headers: credentialHeaders,
        redirect: "error",
        signal: AbortSignal.timeout(timeoutMs),
      },
    );

    if (versionResponse.status === 403) {
      await versionResponse.body?.cancel();
      throw new UpdateAccessRefusedError("/install/version");
    }

    if (!versionResponse.ok) {
      throw new Error(
        `Version check failed: ${versionResponse.status} ${versionResponse.statusText}`,
      );
    }

    const parsed = updateVersionResponseSchema.safeParse(
      await versionResponse.json(),
    );

    if (!parsed.success) {
      setStatus("failed", "invalid_target");
      throw new Error("Update version or artifact digest is unavailable");
    }

    const { artifactSignature, artifactSignatureKeyId, ...target } =
      parsed.data;

    return {
      target,
      signature:
        artifactSignature && artifactSignatureKeyId
          ? { signature: artifactSignature, keyId: artifactSignatureKeyId }
          : null,
    };
  }

  function offerIsSigned(offer: ServerUpdateOffer): boolean {
    return (
      offer.signature !== null &&
      verifyHostArtifactSignature(
        {
          version: offer.target.version,
          protocolVersion: offer.target.protocolVersion,
          digest: offer.target.artifactDigest,
          signature: offer.signature.signature,
          keyId: offer.signature.keyId,
        },
        options.signingPublicKeys,
      )
    );
  }

  async function targetIsCurrent(
    target: ProtocolSelfUpdateTarget,
    timeoutMs?: number,
  ): Promise<boolean> {
    const current = (await readOffer(timeoutMs)).target;

    if (sameTarget(target, current)) return true;

    status = { ...status, target: current };
    setStatus("current", "target_changed");

    return false;
  }

  async function update(
    normal: boolean,
    handleOptions: { force?: boolean } = {},
    requestedTarget?: ProtocolSelfUpdateTarget,
  ): Promise<ProtocolSelfUpdateResult> {
    let acquired = false;
    let installed = false;
    let unsafeInstaller = false;
    let attempt: UpdateAttempt | null = null;
    let attemptRecorded = false;

    async function recordAttempt(): Promise<void> {
      if (attempt === null || attemptRecorded) return;
      await writeAttempt(attemptPath, attempt);
      attemptRecorded = true;
    }

    if (!options.enabled) {
      setStatus("disabled", "disabled");

      if (!normal)
        options.logger.error(
          { daemonProtocolVersion: HOST_DAEMON_PROTOCOL_VERSION },
          "Daemon auto-update is disabled; install the server's omnyo-app package manually.",
        );

      return "skipped";
    }

    if (!usesSecureInternalFetchTransport(options.serverUrl)) {
      setStatus("failed", "insecure_transport");
      options.logger.error(
        { serverUrl: options.serverUrl },
        "Refusing daemon auto-update over insecure transport; install the server's omnyo-app package manually. Keeping the current daemon running and retrying normally.",
      );

      return "failed";
    }

    try {
      await mkdir(options.dataDir, { recursive: true });
      const persistedAttempt = await readLastAttempt(attemptPath);

      if (persistedAttempt?.installer !== undefined) {
        const installer = persistedAttempt.installer;

        const cleared =
          installer.processPlatform === process.platform &&
          process.platform !== "win32" &&
          installer.processGroupId !== null &&
          !isProcessGroupAlive({ pid: installer.processGroupId });

        if (!cleared) {
          unsafeProtectionHeld =
            (options.protectUpdate ?? options.acquireUpdate)?.() === true ||
            unsafeProtectionHeld;
          options.resumeDelivery?.();
          setStatus("failed", "installer_unverified");
          options.logger.error(
            { installer },
            "Installer tree termination is unverified. Confirm the recorded owned tree is empty before repairing this installation; no new installer will start.",
          );

          return "failed";
        }

        delete persistedAttempt.installer;
        await writeAttempt(attemptPath, persistedAttempt);

        if (unsafeProtectionHeld) {
          options.releaseUpdate?.();
          unsafeProtectionHeld = false;
        }
      }

      setStatus("checking");
      const offer = await readOffer();
      const server = offer.target;
      status = { ...status, target: server };

      if (requestedTarget && !sameTarget(requestedTarget, server)) {
        setStatus("current", "target_changed");

        return "skipped";
      }

      if (normal) {
        const current = options.currentVersion;

        if (
          !current ||
          parseReleaseVersion(current) === null ||
          parseReleaseVersion(server.version) === null
        ) {
          setStatus("failed", "invalid_target");
          throw new Error("Private update version or digest is unavailable");
        }

        if (
          server.protocolVersion < HOST_DAEMON_PROTOCOL_VERSION ||
          compareReleaseVersions(server.version, current) < 0
        ) {
          setStatus("current", "current");

          return "skipped";
        }

        if (
          current === server.version &&
          server.protocolVersion === HOST_DAEMON_PROTOCOL_VERSION &&
          (await readInstalledArtifactDigest(installedArtifactDigestPath)) ===
            server.artifactDigest
        ) {
          setStatus("current", "current");

          return "skipped";
        }
      }

      if (!normal && server.protocolVersion <= HOST_DAEMON_PROTOCOL_VERSION) {
        setStatus("current", "current");
        options.logger.error(
          {
            daemonProtocolVersion: HOST_DAEMON_PROTOCOL_VERSION,
            serverProtocolVersion: server.protocolVersion,
            serverVersion: server.version,
          },
          server.protocolVersion < HOST_DAEMON_PROTOCOL_VERSION
            ? "Server protocol is older than this daemon; refusing to downgrade."
            : "Protocol mismatch did not require an upgrade; refusing to reinstall.",
        );

        return "skipped";
      }

      if (!offerIsSigned(offer)) {
        setStatus("failed", "signature_unverified");
        options.logger.warn(
          {
            serverUrl: options.serverUrl,
            serverVersion: server.version,
            serverProtocolVersion: server.protocolVersion,
            artifactDigest: server.artifactDigest,
            signaturePresent: offer.signature !== null,
          },
          offer.signature === null
            ? "The server offered an Omnyo host update without a release signature; installing nothing and keeping the current daemon running."
            : "The server offered an Omnyo host update whose release signature is not valid for any pinned Omnyo release key; installing nothing and keeping the current daemon running.",
        );

        return "skipped";
      }

      await mkdir(options.dataDir, { recursive: true });
      const attemptedAt = now();
      const lastAttempt = await readLastAttempt(attemptPath);

      const previousAttempt =
        lastAttempt?.protocolVersion === server.protocolVersion &&
        (lastAttempt.version === undefined ||
          lastAttempt.version === server.version) &&
        (lastAttempt.artifactDigest === undefined ||
          lastAttempt.artifactDigest === server.artifactDigest)
          ? lastAttempt
          : null;

      const delayMs =
        previousAttempt === null
          ? 0
          : calculateExponentialBackoffDelay({
              attempt: previousAttempt.attemptCount,
              baseDelayMs: SELF_UPDATE_INITIAL_RETRY_DELAY_MS,
              maxDelayMs: SELF_UPDATE_MAX_RETRY_DELAY_MS,
            });

      const retryAt =
        previousAttempt === null
          ? attemptedAt
          : previousAttempt.attemptedAt + delayMs;

      if (!handleOptions.force && attemptedAt < retryAt) {
        setStatus("backoff", "backoff", retryAt);
        options.logger.warn(
          {
            attemptCount: previousAttempt?.attemptCount ?? 0,
            retryAt,
            retryDelayMs: delayMs,
            serverProtocolVersion: server.protocolVersion,
          },
          "Daemon self-update is backing off; keeping the current daemon running.",
        );

        return "skipped";
      }

      if (installMode === "unsupported") {
        setStatus("failed", "failed");
        options.logger.error(
          { serverVersion: server.version },
          "This Windows worker cannot replace its own loaded runtime files. Run this machine's enrollment command again, so the machine service installs updates while the runtime is stopped.",
        );

        return "failed";
      }

      if (options.isIdle && !options.isIdle()) {
        waitForIdle(normal, server);

        return "skipped";
      }

      attempt = {
        attemptedAt,
        attemptCount:
          handleOptions.force || previousAttempt === null
            ? 1
            : previousAttempt.attemptCount + 1,
        protocolVersion: server.protocolVersion,
        version: server.version,
        artifactDigest: server.artifactDigest,
      };

      const tarballPath = join(
        options.dataDir,
        `omnyo-app-update-${process.pid}.tgz`,
      );

      try {
        setStatus("staging");
        const tarballUrl = new URL("/install/omnyo-app.tgz", options.serverUrl);

        const installedDigest = await readInstalledArtifactDigest(
          installedArtifactDigestPath,
        );

        const request: RequestInit = {
          method: "GET",
          headers:
            installedDigest === null
              ? credentialHeaders
              : {
                  ...credentialHeaders,
                  "if-none-match": `"sha256-${installedDigest}"`,
                },
          redirect: "error",
          signal: AbortSignal.timeout(5 * 60 * 1000),
        };

        const response = await fetchFn(tarballUrl, request);

        if (response.status === 403) {
          await response.body?.cancel();
          throw new UpdateAccessRefusedError("/install/omnyo-app.tgz");
        }

        const expectedDigest = responseArtifactDigest(response);

        const alreadyInstalled =
          response.status === 304 && installedDigest === server.artifactDigest;

        if (!response.ok && !alreadyInstalled) {
          await response.body?.cancel();
          throw new Error(
            `Package download failed: ${response.status} ${response.statusText}`,
          );
        }

        if (expectedDigest !== server.artifactDigest) {
          await response.body?.cancel();
          throw new Error("Update artifact changed during download");
        }

        if (!alreadyInstalled) {
          const bytes = new Uint8Array(await response.arrayBuffer());
          const actualDigest = sha256Hex(bytes);

          if (actualDigest !== expectedDigest) {
            throw new Error(
              `Package digest mismatch: expected ${expectedDigest}, received ${actualDigest}`,
            );
          }

          await writeFile(tarballPath, bytes, { mode: 0o600 });
        }

        setStatus("checking");

        if (!(await targetIsCurrent(server))) return "skipped";

        if (options.acquireUpdate && !options.acquireUpdate()) {
          waitForIdle(normal, server);

          return "skipped";
        }

        acquired = options.acquireUpdate !== undefined;
        setStatus("installing");

        if (!(await targetIsCurrent(server, 5_000))) return "skipped";

        if (options.prepareUpdate) {
          const signal = AbortSignal.timeout(60_000);
          await waitForUpdateCheckpoint(options.prepareUpdate(signal), signal);
        }

        await recordAttempt();

        if (alreadyInstalled) {
          options.logger.info(
            { artifactDigest: installedDigest },
            "The server-matched Omnyo host artifact is already installed; restarting the daemon.",
          );
        } else if (installMode === "service-handoff") {
          await writePendingServiceInstall(
            options.dataDir,
            tarballPath,
            server,
            attempt?.attemptedAt ?? now(),
          );
          serviceInstallPending = true;
          options.logger.info(
            { serverVersion: server.version },
            "Handed the verified Omnyo host package to the Windows machine service; it installs the package after this runtime stops.",
          );
        } else {
          if (attempt === null) throw new Error("Installer attempt is missing");
          attempt.installer = {
            treeTermination: "unverified",
            processGroupId: null,
            processPlatform: process.platform,
          };
          await writeAttempt(attemptPath, attempt);

          unsafeInstaller = true;
          unsafeProtectionHeld = acquired;

          try {
            await installTarball(tarballPath);
          } catch (error) {
            const uncertainty =
              error instanceof Error
                ? installerUncertaintySchema.safeParse({
                    treeTermination: Reflect.get(error, "treeTermination"),
                    processGroupId:
                      Reflect.get(error, "processGroupId") ?? null,
                    processPlatform:
                      Reflect.get(error, "processPlatform") ?? null,
                  })
                : null;

            if (
              error instanceof Error &&
              Reflect.get(error, "treeTermination") === "confirmed"
            ) {
              delete attempt.installer;
              unsafeInstaller = false;
              unsafeProtectionHeld = false;
            } else {
              attempt.installer = uncertainty?.success
                ? uncertainty.data
                : {
                    treeTermination: "unverified",
                    processGroupId: null,
                    processPlatform: process.platform,
                  };
            }

            await writeAttempt(attemptPath, attempt);
            throw error;
          }

          unsafeInstaller = false;
          unsafeProtectionHeld = false;
          delete attempt.installer;
          await writeAttempt(attemptPath, attempt);
          await writeInstalledArtifactDigest(
            installedArtifactDigestPath,
            expectedDigest,
          );
        }
      } finally {
        await rm(tarballPath, { force: true });
      }

      if (!serviceInstallPending)
        options.logger.info(
          {
            daemonProtocolVersion: HOST_DAEMON_PROTOCOL_VERSION,
            serverProtocolVersion: server.protocolVersion,
            serverVersion: server.version,
          },
          "Installed the server-matched Omnyo host package; restarting the daemon.",
        );
      await options.onBeforeRestart?.(server);
      installed = true;
      setStatus("updated");

      return "updated";
    } catch (error) {
      if (serviceInstallPending) {
        serviceInstallPending = false;
        await Promise.all(
          [
            PENDING_RUNTIME_INSTALL_FILE_NAME,
            PENDING_RUNTIME_INSTALL_TARBALL_NAME,
          ].map((name) => rm(join(options.dataDir, name), { force: true })),
        );
      }

      if (error instanceof UpdateAccessRefusedError) {
        setStatus("failed", "access_refused");
        options.logger.warn(
          {
            path: error.path,
            machineCredentialSent: machineCredential !== "",
          },
          "The server address refused this machine's update request (HTTP 403); it may now belong to another account, or this machine's credential was revoked. Skipping this update check and keeping the current daemon running.",
        );

        return "skipped";
      }

      if (
        error instanceof Error &&
        Reflect.get(error, "treeTermination") === "unverified"
      ) {
        unsafeInstaller = true;
        unsafeProtectionHeld =
          (options.protectUpdate ?? options.acquireUpdate)?.() === true ||
          unsafeProtectionHeld;
      }

      try {
        await recordAttempt();
      } catch (attemptError) {
        options.logger.error(
          { err: attemptError },
          "Failed to record daemon self-update backoff",
        );
      }

      setStatus(
        "failed",
        unsafeInstaller
          ? "installer_unverified"
          : status.reason === "invalid_target"
            ? "invalid_target"
            : "failed",
        attempt === null
          ? null
          : attempt.attemptedAt +
              calculateExponentialBackoffDelay({
                attempt: attempt.attemptCount,
                baseDelayMs: SELF_UPDATE_INITIAL_RETRY_DELAY_MS,
                maxDelayMs: SELF_UPDATE_MAX_RETRY_DELAY_MS,
              }),
      );
      options.logger.error(
        { err: error },
        "Daemon self-update failed; keeping the current daemon running and retrying normally.",
      );

      return "failed";
    } finally {
      if (acquired && !installed) {
        options.resumeDelivery?.();

        if (!unsafeInstaller) options.releaseUpdate?.();
      }
    }
  }

  function waitForIdle(normal: boolean, target: ProtocolSelfUpdateTarget) {
    if (idleWaitVersion !== target.version)
      options.logger.info(
        { serverVersion: target.version },
        "Daemon self-update is waiting for running work to finish.",
      );
    idleWaitVersion = target.version;
    setStatus("waiting-for-idle", "busy", now() + SELF_UPDATE_IDLE_RETRY_MS);

    if (idleRetry !== null) clearTimeout(idleRetry);
    idleRetry = setTimeout(() => {
      idleRetry = null;
      void run(normal);
    }, SELF_UPDATE_IDLE_RETRY_MS);
    idleRetry.unref?.();
  }

  function run(
    normal: boolean,
    handleOptions?: { force?: boolean },
    target?: ProtocolSelfUpdateTarget,
  ) {
    if (pending !== null) return pending;

    if (idleRetry !== null) {
      clearTimeout(idleRetry);
      idleRetry = null;
    }

    pending = Promise.resolve()
      .then(() => update(normal, handleOptions, target))
      .then((result) => {
        if (status.phase !== "waiting-for-idle") idleWaitVersion = null;

        if (result === "updated") options.onInstalled?.();

        return result;
      })
      .finally(() => {
        pending = null;
      });

    return pending;
  }

  return {
    handleProtocolMismatch: (handleOptions) => run(false, handleOptions),
    checkForUpdates: () => run(true),
    getStatus: () => ({
      ...status,
      target: status.target === null ? null : { ...status.target },
    }),
    serviceInstallPending: () => serviceInstallPending,
    requestUpdate: (target) => {
      if (pending !== null) {
        status = { ...status, reason: "in_progress" };

        return Promise.resolve("skipped");
      }

      const parsed = updateVersionSchema.safeParse(target);

      if (!parsed.success) {
        setStatus("failed", "invalid_target");

        return Promise.resolve("failed");
      }

      return run(true, {}, parsed.data);
    },
  };
}
