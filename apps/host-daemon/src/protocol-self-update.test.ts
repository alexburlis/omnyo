import { spawn } from "node:child_process";
import { createProcessStop, execPortableFile } from "@omnyo/process-utils";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, open, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { HOST_DAEMON_PROTOCOL_VERSION } from "@omnyo/host-daemon-contract";
import {
  hostArtifactSignatureMessage,
  hostArtifactSigningKeyId,
} from "@omnyo/host-daemon-contract/host-artifact-signature";
import { afterEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { z } from "zod";
import type { HostDaemonLogger } from "./logger.js";
import {
  PENDING_RUNTIME_INSTALL_FILE_NAME,
  PENDING_RUNTIME_INSTALL_TARBALL_NAME,
} from "@omnyo/config/machine-service";
import {
  createProtocolSelfUpdater,
  SELF_UPDATE_IDLE_RETRY_MS,
  SELF_UPDATE_INITIAL_RETRY_DELAY_MS,
  SELF_UPDATE_MAX_RETRY_DELAY_MS,
  defaultInstallTarball,
  type ProtocolSelfUpdateInstallMode,
  type ProtocolSelfUpdateTarget,
} from "./protocol-self-update.js";

const roots: string[] = [];

const tarballDigest = createHash("sha256").update("tarball").digest("hex");

function createSigningKey() {
  const pair = generateKeyPairSync("ed25519");

  const raw = pair.publicKey
    .export({ format: "der", type: "spki" })
    .subarray(-32);

  const field = (bytes: Buffer) => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(bytes.length);

    return Buffer.concat([length, bytes]);
  };

  const line = `ssh-ed25519 ${Buffer.concat([field(Buffer.from("ssh-ed25519")), field(raw)]).toString("base64")}`;

  return {
    line,
    keyId: hostArtifactSigningKeyId(line),
    sign(subject: {
      version: string;
      protocolVersion: number;
      digest: string;
    }): string {
      return sign(
        null,
        Buffer.from(hostArtifactSignatureMessage(subject)),
        pair.privateKey,
      ).toString("base64");
    },
  };
}

const releaseKey = createSigningKey();

const unlistedKey = createSigningKey();

function signedVersionBody(
  body: { version: string; protocolVersion: number; artifactDigest: string },
  key = releaseKey,
) {
  return {
    ...body,
    artifactSignature: key.sign({
      version: body.version,
      protocolVersion: body.protocolVersion,
      digest: body.artifactDigest,
    }),
    artifactSignatureKeyId: key.keyId,
  };
}

function versionResponse(
  body: { version: string; protocolVersion: number; artifactDigest: string },
  key = releaseKey,
): Response {
  return Response.json(signedVersionBody(body, key));
}

function logger() {
  return {
    debug: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
  } satisfies HostDaemonLogger;
}

async function createFixture(
  args: {
    currentVersion?: string;
    acquireUpdate?: () => boolean;
    isIdle?: () => boolean;
    onInstalled?: () => void;
    onBeforeRestart?: (target: ProtocolSelfUpdateTarget) => Promise<void>;
    releaseUpdate?: () => void;
    prepareUpdate?: (signal: AbortSignal) => Promise<void>;
    resumeDelivery?: () => void;
    enabled?: boolean;
    protocolVersion?: number;
    installFailure?: Error;
    now?: () => number;
    serverUrl?: string;
    useDefaultInstaller?: boolean;
    installMode?: ProtocolSelfUpdateInstallMode;
    machineCredential?: string;
    signingPublicKeys?: readonly string[] | "pinned";
  } = {},
) {
  const dataDir = await mkdtemp(join(tmpdir(), "omnyo-self-update-test-"));
  roots.push(dataDir);

  const installTarball = vi.fn(async () => {
    if (args.installFailure)
      throw Object.assign(args.installFailure, {
        treeTermination:
          Reflect.get(args.installFailure, "treeTermination") ?? "confirmed",
      });
  });

  const runProcess = vi.fn(async () => undefined);

  const fetchFn = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);

    if (url.endsWith("/install/version")) {
      return versionResponse({
        version: "9.0.0-test",
        protocolVersion:
          args.protocolVersion ?? HOST_DAEMON_PROTOCOL_VERSION + 1,
        artifactDigest: tarballDigest,
      });
    }

    if (url.endsWith("/install/omnyo-app.tgz")) {
      return new Response("tarball", {
        headers: { "x-omnyo-artifact-sha256": tarballDigest },
      });
    }

    throw new Error(`Unexpected URL: ${url}`);
  });

  const testLogger = logger();

  const updater = createProtocolSelfUpdater({
    currentVersion: args.currentVersion,
    acquireUpdate: args.acquireUpdate,
    isIdle: args.isIdle,
    onInstalled: args.onInstalled,
    onBeforeRestart: args.onBeforeRestart,
    installMode: args.installMode,
    releaseUpdate: args.releaseUpdate,
    prepareUpdate: args.prepareUpdate,
    resumeDelivery: args.resumeDelivery,
    dataDir,
    enabled: args.enabled ?? true,
    fetchFn,
    ...(args.useDefaultInstaller ? { runProcess } : { installTarball }),
    logger: testLogger,
    now: args.now,
    serverUrl: args.serverUrl ?? "https://server.example.test",
    machineCredential: args.machineCredential,
    ...(args.signingPublicKeys === "pinned"
      ? {}
      : { signingPublicKeys: args.signingPublicKeys ?? [releaseKey.line] }),
  });

  return {
    dataDir,
    fetchFn,
    installTarball,
    logger: testLogger,
    runProcess,
    updater,
  };
}

afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true })),
  );
});

describe("protocol self-update", () => {
  it("waits for durable worker identity adoption before announcing restart", async () => {
    let release: () => void = () => undefined;
    let ready: () => void = () => undefined;

    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });

    const persisted = new Promise<void>((resolve) => {
      ready = resolve;
    });

    const restarted = vi.fn();

    const fixture = await createFixture({
      acquireUpdate: () => true,
      onInstalled: restarted,
      async onBeforeRestart(target) {
        const file = await open(
          join(fixture.dataDir, "identity-receipt.json"),
          "wx",
        );

        try {
          await file.writeFile(JSON.stringify(target));
          await file.sync();
        } finally {
          await file.close();
        }

        ready();
        await blocked;
      },
    });

    const update = fixture.updater.handleProtocolMismatch();
    await persisted;
    expect(restarted).not.toHaveBeenCalled();
    expect(
      JSON.parse(
        await readFile(join(fixture.dataDir, "identity-receipt.json"), "utf8"),
      ),
    ).toMatchObject({ artifactDigest: tarballDigest });
    release();
    await expect(update).resolves.toBe("updated");
    expect(restarted).toHaveBeenCalledOnce();
  });

  it("reconciles a lost worker identity receipt acknowledgement without replaying installation", async () => {
    let now = 10_000;
    let first = true;
    const restarted = vi.fn();

    const fixture = await createFixture({
      acquireUpdate: () => true,
      onInstalled: restarted,
      now: () => now,
      async onBeforeRestart(target) {
        const path = join(fixture.dataDir, "identity-receipt.json");

        if (first) {
          const file = await open(path, "wx");

          try {
            await file.writeFile(JSON.stringify(target));
            await file.sync();
          } finally {
            await file.close();
          }

          first = false;
          throw new Error("identity receipt acknowledgement lost");
        }

        expect(JSON.parse(await readFile(path, "utf8"))).toEqual(target);
      },
    });

    await expect(fixture.updater.handleProtocolMismatch()).resolves.toBe(
      "failed",
    );
    expect(restarted).not.toHaveBeenCalled();
    fixture.fetchFn.mockImplementation(async (input, init?: RequestInit) => {
      if (String(input).endsWith("/install/version"))
        return versionResponse({
          version: "9.0.0-test",
          protocolVersion: HOST_DAEMON_PROTOCOL_VERSION + 1,
          artifactDigest: tarballDigest,
        });
      expect(new Headers(init?.headers).get("if-none-match")).toBe(
        `"sha256-${tarballDigest}"`,
      );

      return new Response(null, {
        status: 304,
        headers: { "x-omnyo-artifact-sha256": tarballDigest },
      });
    });
    now += 100_000;
    await expect(fixture.updater.handleProtocolMismatch()).resolves.toBe(
      "updated",
    );
    expect(fixture.installTarball).toHaveBeenCalledOnce();
    expect(restarted).toHaveBeenCalledOnce();
  });

  it("installer deadline is passed to the owned portable process runner", async () => {
    const runProcess = vi.fn(async () => undefined);
    await defaultInstallTarball("/synthetic/package.tgz", runProcess);
    expect(runProcess).toHaveBeenCalledWith(
      "npm",
      expect.any(Array),
      expect.objectContaining({ timeout: 600_000 }),
    );
  });

  it("installer deadline settles a hanging attempt without overlap and leaves its digest unchanged", async () => {
    const fixture = await createFixture();
    const controller = new AbortController();
    let ready: () => void = () => undefined;

    const started = new Promise<void>((resolve) => {
      ready = resolve;
    });

    const releaseUpdate = vi.fn();
    const resumeDelivery = vi.fn();

    const runProcess = vi.fn(
      async (
        _command: string,
        _args: string[],
        options: { env: NodeJS.ProcessEnv; timeout?: number },
      ) => {
        await execPortableFile(
          process.execPath,
          ["-e", "process.stderr.write('ready'); setInterval(() => {}, 1000)"],
          {
            cwd: process.cwd(),
            env: options.env,
            maxBuffer: 1024,
            timeout: options.timeout === undefined ? undefined : 100,
            signal: controller.signal,
            onStderr: () => ready(),
          },
        );
      },
    );

    const updater = createProtocolSelfUpdater({
      dataDir: fixture.dataDir,
      enabled: true,
      fetchFn: fixture.fetchFn,
      runProcess,
      acquireUpdate: () => true,
      releaseUpdate,
      resumeDelivery,
      logger: fixture.logger,
      serverUrl: "https://server.example.test",
      signingPublicKeys: [releaseKey.line],
    });

    const update = updater.handleProtocolMismatch();
    let timer: ReturnType<typeof setTimeout> | undefined;

    try {
      await started;
      expect(updater.handleProtocolMismatch()).toBe(update);
      expect(
        await updater.requestUpdate({
          version: "9.0.0-test",
          protocolVersion: HOST_DAEMON_PROTOCOL_VERSION + 1,
          artifactDigest: tarballDigest,
        }),
      ).toBe("skipped");

      const result = await Promise.race([
        update,
        new Promise<"pending">((resolve) => {
          timer = setTimeout(() => resolve("pending"), 3500);
        }),
      ]);

      expect(result).toBe("failed");
      expect(updater.getStatus().phase).toBe("failed");
      expect(runProcess).toHaveBeenCalledOnce();
      expect(resumeDelivery).toHaveBeenCalledOnce();
      expect(releaseUpdate).toHaveBeenCalledOnce();
      await expect(
        readFile(join(fixture.dataDir, "host-artifact.sha256"), "utf8"),
      ).rejects.toMatchObject({ code: "ENOENT" });
      expect(await updater.handleProtocolMismatch()).toBe("skipped");
      expect(runProcess).toHaveBeenCalledOnce();
    } finally {
      clearTimeout(timer);
      controller.abort();
      await update;
    }
  });

  it.each(["invalid JSON", JSON.stringify({ attemptedAt: 1 })])(
    "installer failure recovery fences an invalid existing attempt before restart: %s",
    async (contents) => {
      const fixture = await createFixture();
      await writeFile(
        join(fixture.dataDir, "host-daemon-update-attempt.json"),
        contents,
      );

      let held = false;
      const install = vi.fn(async () => undefined);
      const acquire = vi.fn(() => false);

      const protect = vi.fn(() => {
        held = true;

        return true;
      });

      const updater = createProtocolSelfUpdater({
        dataDir: fixture.dataDir,
        enabled: true,
        installTarball: install,
        fetchFn: fixture.fetchFn,
        acquireUpdate: acquire,
        protectUpdate: protect,
        logger: fixture.logger,
        serverUrl: "https://server.example.test",
        signingPublicKeys: [releaseKey.line],
      });

      expect(held).toBe(true);
      expect(protect).toHaveBeenCalledOnce();
      expect(updater.getStatus()).toMatchObject({
        phase: "failed",
        reason: "installer_unverified",
      });
      expect(await updater.handleProtocolMismatch({ force: true })).toBe(
        "failed",
      );
      expect(install).not.toHaveBeenCalled();
      expect(
        await readFile(
          join(fixture.dataDir, "host-daemon-update-attempt.json"),
          "utf8",
        ),
      ).toBe(contents);
      expect(held).toBe(true);
    },
  );

  it("installer failure recovery retains unsafe admission, survives restart, and repairs only after tree clearance", async () => {
    const child = spawn(
      process.execPath,
      ["-e", "setInterval(() => {}, 1000)"],
      { detached: process.platform !== "win32", stdio: "ignore" },
    );

    const stop = createProcessStop(child);
    onTestFinished(async () => {
      await stop();
    });
    await once(child, "spawn");
    let held = false;
    let clock = 10_000;

    const releaseUpdate = vi.fn(() => {
      held = false;
    });

    const resumeDelivery = vi.fn();

    const acquireUpdate = vi.fn(() => {
      held = true;

      return true;
    });

    const failure = Object.assign(
      new Error("installer timeout: tree cleanup unverified"),
      {
        treeTermination: "unverified",
        processGroupId: child.pid,
        processPlatform: process.platform,
      },
    );

    const fixture = await createFixture({
      acquireUpdate,
      releaseUpdate,
      resumeDelivery,
      installFailure: failure,
      now: () => clock,
    });

    expect(await fixture.updater.handleProtocolMismatch()).toBe("failed");
    expect(held).toBe(true);
    expect(releaseUpdate).not.toHaveBeenCalled();
    expect(resumeDelivery).toHaveBeenCalledOnce();
    expect(fixture.updater.getStatus()).toMatchObject({
      phase: "failed",
      reason: "installer_unverified",
    });

    const attemptPath = join(
      fixture.dataDir,
      "host-daemon-update-attempt.json",
    );

    const attempt = JSON.parse(await readFile(attemptPath, "utf8"));
    expect(attempt.installer).toMatchObject({ treeTermination: "unverified" });
    clock += SELF_UPDATE_MAX_RETRY_DELAY_MS;
    const restartedInstall = vi.fn(async () => undefined);

    const restarted = createProtocolSelfUpdater({
      dataDir: fixture.dataDir,
      enabled: true,
      fetchFn: fixture.fetchFn,
      installTarball: restartedInstall,
      acquireUpdate,
      releaseUpdate,
      resumeDelivery,
      logger: fixture.logger,
      now: () => clock,
      serverUrl: "https://server.example.test",
      signingPublicKeys: [releaseKey.line],
    });

    expect(restarted.getStatus()).toMatchObject({
      phase: "failed",
      reason: "installer_unverified",
    });
    expect(held).toBe(true);
    expect(await restarted.handleProtocolMismatch({ force: true })).toBe(
      "failed",
    );
    expect(restartedInstall).not.toHaveBeenCalled();
    expect(releaseUpdate).not.toHaveBeenCalled();
    await stop();

    if (process.platform !== "win32") {
      expect(await restarted.handleProtocolMismatch()).toBe("updated");
      expect(restartedInstall).toHaveBeenCalledOnce();
    }
  });

  it("does not install when checkpointing fails under its owned hold and resumes delivery before releasing", async () => {
    const actions: string[] = [];

    const fixture = await createFixture({
      acquireUpdate: () => {
        actions.push("acquired");

        return true;
      },
      prepareUpdate: async (signal) => {
        expect(signal.aborted).toBe(false);
        actions.push("checkpoint");
        throw new Error("checkpoint disk failure");
      },
      resumeDelivery: () => {
        actions.push("resumed");
      },
      releaseUpdate: () => {
        actions.push("released");
      },
    });

    expect(await fixture.updater.handleProtocolMismatch()).toBe("failed");
    expect(fixture.installTarball).not.toHaveBeenCalled();
    expect(fixture.updater.getStatus()?.phase).toBe("failed");
    expect(actions).toEqual(["acquired", "checkpoint", "resumed", "released"]);
  });

  it("does not install after the checkpoint deadline and releases its owned hold", async () => {
    const expired = new AbortController();
    const nativeTimeout = AbortSignal.timeout.bind(AbortSignal);

    const timeout = vi
      .spyOn(AbortSignal, "timeout")
      .mockImplementation((milliseconds) =>
        milliseconds === 60_000 ? expired.signal : nativeTimeout(milliseconds),
      );

    const prepareUpdate = vi.fn(async () => new Promise<void>(() => undefined));
    const releaseUpdate = vi.fn();
    const resumeDelivery = vi.fn();

    try {
      const fixture = await createFixture({
        acquireUpdate: () => true,
        prepareUpdate,
        releaseUpdate,
        resumeDelivery,
      });

      const update = fixture.updater.handleProtocolMismatch();
      await vi.waitFor(() => expect(prepareUpdate).toHaveBeenCalledOnce());
      expired.abort(new Error("checkpoint deadline"));
      expect(await update).toBe("failed");
      expect(fixture.installTarball).not.toHaveBeenCalled();
      expect(releaseUpdate).toHaveBeenCalledOnce();
      expect(resumeDelivery).toHaveBeenCalledOnce();
    } finally {
      timeout.mockRestore();
    }
  });

  it.each(["ordinary", "mismatch"] as const)(
    "stages %s transfers without holding admission and rejects a changed artifact",
    async (mode) => {
      const advertisedDigest = createHash("sha256")
        .update("advertised")
        .digest("hex");

      const changedDigest = createHash("sha256")
        .update("changed")
        .digest("hex");

      const acquireUpdate = vi.fn(() => true);
      let response: ServerResponse | undefined;
      let notifyDownload: () => void = () => undefined;

      const downloadStarted = new Promise<void>((resolve) => {
        notifyDownload = resolve;
      });

      const server = createServer((request, reply) => {
        if (request.url === "/install/version") {
          reply.setHeader("content-type", "application/json");
          reply.end(
            JSON.stringify(
              signedVersionBody({
                version: "0.46.4+private.1",
                protocolVersion:
                  HOST_DAEMON_PROTOCOL_VERSION + (mode === "mismatch" ? 1 : 0),
                artifactDigest: advertisedDigest,
              }),
            ),
          );

          return;
        }

        response = reply;
        reply.writeHead(200, { "x-omnyo-artifact-sha256": advertisedDigest });
        reply.write("cha");
        notifyDownload();
      });

      server.listen(0, "127.0.0.1");
      await once(server, "listening");
      const address = server.address();

      if (typeof address !== "object" || address === null)
        throw new Error("Expected a loopback listener");

      const test = await createFixture({
        acquireUpdate,
        currentVersion: "0.46.3+private.1",
        serverUrl: `http://127.0.0.1:${address.port}`,
      });

      test.fetchFn.mockImplementation(fetch);

      const operation =
        mode === "ordinary"
          ? test.updater.checkForUpdates()
          : test.updater.handleProtocolMismatch();

      try {
        await downloadStarted;
        expect(acquireUpdate).not.toHaveBeenCalled();
        await expect(
          test.updater.requestUpdate({
            version: "0.46.5+private.1",
            protocolVersion: HOST_DAEMON_PROTOCOL_VERSION,
            artifactDigest: changedDigest,
          }),
        ).resolves.toBe("skipped");
        expect(test.updater.getStatus().reason).toBe("in_progress");

        if (response && !response.writableEnded && !response.destroyed)
          response.end("nged");
        await expect(operation).resolves.toBe("failed");
        expect(test.installTarball).not.toHaveBeenCalled();
        expect(acquireUpdate).not.toHaveBeenCalled();
      } finally {
        if (response && !response.writableEnded && !response.destroyed)
          response.end("nged");
        await operation;
        server.closeAllConnections();
        await new Promise<void>((resolve, reject) => {
          server.close((error) => (error ? reject(error) : resolve()));
        });
      }
    },
  );

  it.each(["staging", "admission"] as const)(
    "refuses a target that changes during %s before installation",
    async (changedDuring) => {
      let changed = false;
      const releaseUpdate = vi.fn();

      const acquireUpdate = vi.fn(() => {
        if (changedDuring === "admission") changed = true;

        return true;
      });

      const test = await createFixture({
        acquireUpdate,
        releaseUpdate,
        currentVersion: "0.46.3+private.1",
      });

      test.fetchFn.mockImplementation(async (input: RequestInfo | URL) => {
        if (String(input).endsWith("/install/version")) {
          return versionResponse({
            version: changed ? "0.46.5+private.1" : "0.46.4+private.1",
            protocolVersion: HOST_DAEMON_PROTOCOL_VERSION,
            artifactDigest: tarballDigest,
          });
        }

        if (changedDuring === "staging") changed = true;

        return new Response("tarball", {
          headers: { "x-omnyo-artifact-sha256": tarballDigest },
        });
      });

      await expect(test.updater.checkForUpdates()).resolves.toBe("skipped");
      expect(test.updater.getStatus().reason).toBe("target_changed");
      expect(test.installTarball).not.toHaveBeenCalled();
      expect(acquireUpdate).toHaveBeenCalledTimes(
        changedDuring === "admission" ? 1 : 0,
      );
      expect(releaseUpdate).toHaveBeenCalledTimes(
        changedDuring === "admission" ? 1 : 0,
      );
    },
  );

  it("updates a changed same-protocol private artifact only after idle admission", async () => {
    let idle = false;
    const releaseUpdate = vi.fn();

    const test = await createFixture({
      currentVersion: "0.46.3+private.1",
      acquireUpdate: () => idle,
      releaseUpdate,
    });

    const bytes = new TextEncoder().encode("private-next");
    const digest = createHash("sha256").update(bytes).digest("hex");
    test.fetchFn.mockImplementation(async (input: RequestInfo | URL) =>
      String(input).endsWith("/install/version")
        ? versionResponse({
            version: "0.46.3+private.2",
            protocolVersion: HOST_DAEMON_PROTOCOL_VERSION,
            artifactDigest: digest,
          })
        : new Response(bytes, {
            headers: { "x-omnyo-artifact-sha256": digest },
          }),
    );
    await expect(test.updater.checkForUpdates()).resolves.toBe("skipped");
    expect(test.installTarball).not.toHaveBeenCalled();
    expect(test.updater.getStatus()).toMatchObject({
      phase: "waiting-for-idle",
      reason: "busy",
    });
    await expect(
      test.updater.requestUpdate({
        version: "0.46.3+private.2",
        protocolVersion: HOST_DAEMON_PROTOCOL_VERSION,
        artifactDigest: "a".repeat(64),
      }),
    ).resolves.toBe("skipped");
    expect(test.updater.getStatus().reason).toBe("target_changed");
    idle = true;
    await expect(
      test.updater.requestUpdate({
        version: "0.46.3+private.2",
        protocolVersion: HOST_DAEMON_PROTOCOL_VERSION,
        artifactDigest: digest,
      }),
    ).resolves.toBe("updated");
    expect(test.installTarball).toHaveBeenCalledOnce();
    expect(releaseUpdate).not.toHaveBeenCalled();
  });

  it("waits for idle without downloading, then retries and installs once running work finishes", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    onTestFinished(() => {
      vi.useRealTimers();
    });
    let idle = false;
    const onInstalled = vi.fn();

    const test = await createFixture({
      currentVersion: "0.46.3+private.1",
      acquireUpdate: () => idle,
      isIdle: () => idle,
      onInstalled,
    });

    const bytes = new TextEncoder().encode("private-next");
    const digest = createHash("sha256").update(bytes).digest("hex");
    test.fetchFn.mockImplementation(async (input: RequestInfo | URL) =>
      String(input).endsWith("/install/version")
        ? versionResponse({
            version: "0.46.3+private.2",
            protocolVersion: HOST_DAEMON_PROTOCOL_VERSION,
            artifactDigest: digest,
          })
        : new Response(bytes, {
            headers: { "x-omnyo-artifact-sha256": digest },
          }),
    );

    const downloads = () =>
      test.fetchFn.mock.calls.filter(([input]) =>
        String(input).endsWith("/install/omnyo-app.tgz"),
      ).length;

    await expect(test.updater.checkForUpdates()).resolves.toBe("skipped");
    expect(test.updater.getStatus()).toMatchObject({
      phase: "waiting-for-idle",
      reason: "busy",
    });
    expect(downloads()).toBe(0);

    const versionChecks = test.fetchFn.mock.calls.length;
    await vi.advanceTimersByTimeAsync(SELF_UPDATE_IDLE_RETRY_MS);
    await vi.waitFor(() =>
      expect(test.fetchFn.mock.calls.length).toBe(versionChecks + 1),
    );
    expect(downloads()).toBe(0);
    expect(
      test.logger.info.mock.calls.filter(
        ([, message]) =>
          message ===
          "Daemon self-update is waiting for running work to finish.",
      ),
    ).toHaveLength(1);

    idle = true;
    await vi.advanceTimersByTimeAsync(SELF_UPDATE_IDLE_RETRY_MS);
    await vi.waitFor(() => expect(onInstalled).toHaveBeenCalledOnce());
    expect(test.installTarball).toHaveBeenCalledOnce();
    expect(downloads()).toBe(1);
    expect(test.updater.getStatus().phase).toBe("updated");
  });

  it.each(["9.0.0-nightly.1", "9.0.0+build.1", "9.0"])(
    "does not reinstall an identical private artifact or accept the non-release version %s",
    async (version) => {
      const test = await createFixture({
        currentVersion: "0.46.3+private.1",
        acquireUpdate: () => true,
      });

      const digest = "c".repeat(64);
      await writeFile(
        join(test.dataDir, "host-artifact.sha256"),
        digest + "\n",
      );
      test.fetchFn.mockImplementation(async () =>
        versionResponse({
          version: "0.46.3+private.1",
          protocolVersion: HOST_DAEMON_PROTOCOL_VERSION,
          artifactDigest: digest,
        }),
      );
      await expect(test.updater.checkForUpdates()).resolves.toBe("skipped");
      test.fetchFn.mockImplementation(async () =>
        versionResponse({
          version,
          protocolVersion: HOST_DAEMON_PROTOCOL_VERSION,
          artifactDigest: "d".repeat(64),
        }),
      );
      await expect(test.updater.checkForUpdates()).resolves.toBe("failed");
      expect(test.updater.getStatus().reason).toBe("invalid_target");
      expect(test.installTarball).not.toHaveBeenCalled();
    },
  );

  it.each([
    ["0.46.378+private.1", "1.0.0+private.1", "updated"],
    ["1.0.0+private.1", "1.0.1", "updated"],
    ["1.0.1", "1.0.2", "updated"],
    ["0.46.3+private.1", "0.46.3+private.2", "updated"],
    ["1.0.0+private.1", "1.0.0", "skipped"],
    ["1.0.1", "1.0.0+private.1", "skipped"],
    ["0.46.3+private.2", "0.46.3+private.1", "skipped"],
  ] as const)(
    "moves a worker on %s to an offered %s as %s",
    async (currentVersion, version, expected) => {
      const test = await createFixture({
        currentVersion,
        acquireUpdate: () => true,
      });

      const bytes = new TextEncoder().encode(`runtime-${version}`);
      const digest = createHash("sha256").update(bytes).digest("hex");
      test.fetchFn.mockImplementation(async (input: RequestInfo | URL) =>
        String(input).endsWith("/install/version")
          ? versionResponse({
              version,
              protocolVersion: HOST_DAEMON_PROTOCOL_VERSION,
              artifactDigest: digest,
            })
          : new Response(bytes, {
              headers: { "x-omnyo-artifact-sha256": digest },
            }),
      );
      await expect(test.updater.checkForUpdates()).resolves.toBe(expected);
      expect(test.installTarball).toHaveBeenCalledTimes(
        expected === "updated" ? 1 : 0,
      );
    },
  );

  it("refuses an invalid installed version visibly", async () => {
    const test = await createFixture({
      currentVersion: "1.0",
      acquireUpdate: () => true,
    });

    test.fetchFn.mockImplementation(async () =>
      versionResponse({
        version: "1.0.1",
        protocolVersion: HOST_DAEMON_PROTOCOL_VERSION,
        artifactDigest: "d".repeat(64),
      }),
    );
    await expect(test.updater.checkForUpdates()).resolves.toBe("failed");
    expect(test.updater.getStatus().reason).toBe("invalid_target");
    expect(test.installTarball).not.toHaveBeenCalled();
  });
  it("installs exactly once when the server protocol is newer and enabled", async () => {
    const test = await createFixture();
    await expect(test.updater.handleProtocolMismatch()).resolves.toBe(
      "updated",
    );
    expect(test.fetchFn).toHaveBeenCalledTimes(4);
    expect(test.installTarball).toHaveBeenCalledOnce();
  });

  it("hands a verified package to the Windows service instead of replacing loaded files", async () => {
    const onInstalled = vi.fn();
    const releaseUpdate = vi.fn();

    const test = await createFixture({
      acquireUpdate: () => true,
      installMode: "service-handoff",
      now: () => 1_000,
      onInstalled,
      releaseUpdate,
    });

    await expect(test.updater.handleProtocolMismatch()).resolves.toBe(
      "updated",
    );

    expect(test.installTarball).not.toHaveBeenCalled();
    expect(test.updater.serviceInstallPending()).toBe(true);
    expect(onInstalled).toHaveBeenCalledOnce();
    expect(releaseUpdate).not.toHaveBeenCalled();
    await expect(
      readFile(
        join(test.dataDir, PENDING_RUNTIME_INSTALL_TARBALL_NAME),
        "utf8",
      ),
    ).resolves.toBe("tarball");
    expect(
      JSON.parse(
        await readFile(
          join(test.dataDir, PENDING_RUNTIME_INSTALL_FILE_NAME),
          "utf8",
        ),
      ),
    ).toEqual({
      schema: 1,
      requestedAt: 1_000,
      protocolVersion: HOST_DAEMON_PROTOCOL_VERSION + 1,
      version: "9.0.0-test",
      artifactDigest: tarballDigest,
      tarball: PENDING_RUNTIME_INSTALL_TARBALL_NAME,
    });

    const attempt = JSON.parse(
      await readFile(
        join(test.dataDir, "host-daemon-update-attempt.json"),
        "utf8",
      ),
    );

    expect(attempt.installer).toBeUndefined();
    await expect(
      readFile(join(test.dataDir, "host-artifact.sha256"), "utf8"),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("withdraws a service handoff when the restart cannot be prepared", async () => {
    const test = await createFixture({
      acquireUpdate: () => true,
      installMode: "service-handoff",
      onBeforeRestart: async () => {
        throw new Error("identity receipt unavailable");
      },
    });

    await expect(test.updater.handleProtocolMismatch()).resolves.toBe("failed");

    expect(test.updater.serviceInstallPending()).toBe(false);

    for (const name of [
      PENDING_RUNTIME_INSTALL_FILE_NAME,
      PENDING_RUNTIME_INSTALL_TARBALL_NAME,
    ])
      await expect(readFile(join(test.dataDir, name))).rejects.toMatchObject({
        code: "ENOENT",
      });
  });

  it("refuses to replace loaded files on Windows without a service installer", async () => {
    const acquireUpdate = vi.fn(() => true);

    const test = await createFixture({
      acquireUpdate,
      installMode: "unsupported",
    });

    await expect(test.updater.handleProtocolMismatch()).resolves.toBe("failed");

    expect(test.installTarball).not.toHaveBeenCalled();
    expect(acquireUpdate).not.toHaveBeenCalled();
    expect(test.fetchFn).toHaveBeenCalledOnce();
    expect(test.updater.getStatus()).toMatchObject({
      phase: "failed",
      reason: "failed",
    });
  });

  it("verifies and persists the server artifact digest", async () => {
    const test = await createFixture();
    const bytes = new TextEncoder().encode("verified-tarball");
    const digest = createHash("sha256").update(bytes).digest("hex");
    test.fetchFn.mockImplementation(async (input: RequestInfo | URL) => {
      if (String(input).endsWith("/install/version")) {
        return versionResponse({
          version: "9.0.0-test",
          protocolVersion: HOST_DAEMON_PROTOCOL_VERSION + 1,
          artifactDigest: digest,
        });
      }

      return new Response(bytes, {
        headers: { "x-omnyo-artifact-sha256": digest },
      });
    });

    await expect(test.updater.handleProtocolMismatch()).resolves.toBe(
      "updated",
    );
    await expect(
      readFile(join(test.dataDir, "host-artifact.sha256"), "utf8"),
    ).resolves.toBe(`${digest}\n`);
    expect(test.installTarball).toHaveBeenCalledOnce();
  });

  it.each(["bytes", "advertisement"] as const)(
    "rejects a downloaded artifact whose %s digest does not match",
    async (mismatch) => {
      const test = await createFixture();

      const digest =
        mismatch === "bytes"
          ? "a".repeat(64)
          : createHash("sha256").update("tampered").digest("hex");

      test.fetchFn.mockImplementation(async (input: RequestInfo | URL) => {
        if (String(input).endsWith("/install/version")) {
          return versionResponse({
            version: "9.0.0-test",
            protocolVersion: HOST_DAEMON_PROTOCOL_VERSION + 1,
            artifactDigest: mismatch === "bytes" ? digest : tarballDigest,
          });
        }

        return new Response("tampered", {
          headers: { "x-omnyo-artifact-sha256": digest },
        });
      });

      await expect(test.updater.handleProtocolMismatch()).resolves.toBe(
        "failed",
      );
      expect(test.installTarball).not.toHaveBeenCalled();
      expect(test.logger.error).toHaveBeenCalledWith(
        expect.objectContaining({ err: expect.any(Error) }),
        expect.stringContaining("self-update failed"),
      );
    },
  );

  it.each(["ordinary", "mismatch"] as const)(
    "restarts the %s older process without reinstalling its already installed target",
    async (mode) => {
      const test = await createFixture({ currentVersion: "0.46.3+private.1" });
      const digest = "b".repeat(64);
      await writeFile(
        join(test.dataDir, "host-artifact.sha256"),
        `${digest}\n`,
      );
      test.fetchFn.mockImplementation(
        async (input: RequestInfo | URL, init?: RequestInit) => {
          if (String(input).endsWith("/install/version")) {
            return versionResponse({
              version: "0.46.4+private.1",
              protocolVersion:
                HOST_DAEMON_PROTOCOL_VERSION + (mode === "mismatch" ? 1 : 0),
              artifactDigest: digest,
            });
          }

          expect(init?.headers).toEqual({
            "if-none-match": `"sha256-${digest}"`,
          });

          return new Response(null, {
            headers: { "x-omnyo-artifact-sha256": digest },
            status: 304,
          });
        },
      );

      await expect(
        mode === "ordinary"
          ? test.updater.checkForUpdates()
          : test.updater.handleProtocolMismatch(),
      ).resolves.toBe("updated");
      expect(test.installTarball).not.toHaveBeenCalled();
      expect(test.logger.info).toHaveBeenCalledWith(
        { artifactDigest: digest },
        expect.stringContaining("already installed"),
      );
    },
  );

  it("finds npm beside the running Node executable when the service PATH omits it", async () => {
    vi.stubEnv("PATH", "/usr/bin:/bin");
    const test = await createFixture({ useDefaultInstaller: true });

    await expect(test.updater.handleProtocolMismatch()).resolves.toBe(
      "updated",
    );

    expect(test.runProcess).toHaveBeenCalledOnce();
    expect(test.runProcess).toHaveBeenCalledWith(
      "npm",
      [
        "install",
        "-g",
        "--allow-scripts=better-sqlite3,node-pty,@parcel/watcher",
        expect.stringContaining("omnyo-app-update-"),
      ],
      {
        timeout: 600_000,
        env: expect.objectContaining({
          PATH: `${dirname(process.execPath)}${delimiter}/usr/bin:/bin`,
        }),
      },
    );
  });

  it("updates an installer-managed omnyo-app inside its machine-specific prefix", async () => {
    vi.stubEnv("OMNYO_APP_NPM_PREFIX", "/machine-data/npm");
    const test = await createFixture({ useDefaultInstaller: true });

    await expect(test.updater.handleProtocolMismatch()).resolves.toBe(
      "updated",
    );

    expect(test.runProcess).toHaveBeenCalledWith(
      "npm",
      [
        "install",
        "-g",
        "--allow-scripts=better-sqlite3,node-pty,@parcel/watcher",
        "--prefix",
        "/machine-data/npm",
        expect.stringContaining("omnyo-app-update-"),
      ],
      expect.any(Object),
    );
  });

  it("keeps legacy global updates when the installer prefix is blank", async () => {
    vi.stubEnv("OMNYO_APP_NPM_PREFIX", " ");
    const test = await createFixture({ useDefaultInstaller: true });

    await expect(test.updater.handleProtocolMismatch()).resolves.toBe(
      "updated",
    );

    expect(test.runProcess).toHaveBeenCalledWith(
      "npm",
      [
        "install",
        "-g",
        "--allow-scripts=better-sqlite3,node-pty,@parcel/watcher",
        expect.stringContaining("omnyo-app-update-"),
      ],
      expect.any(Object),
    );
  });

  it("does nothing when auto-update is disabled", async () => {
    const test = await createFixture({ enabled: false });
    await expect(test.updater.handleProtocolMismatch()).resolves.toBe(
      "skipped",
    );
    expect(test.fetchFn).not.toHaveBeenCalled();
    expect(test.installTarball).not.toHaveBeenCalled();
  });

  it("refuses auto-update over non-loopback HTTP", async () => {
    const test = await createFixture({
      serverUrl: "http://server.example.test",
    });

    await expect(test.updater.handleProtocolMismatch()).resolves.toBe("failed");
    expect(test.fetchFn).not.toHaveBeenCalled();
    expect(test.installTarball).not.toHaveBeenCalled();
    expect(test.logger.error).toHaveBeenCalledWith(
      { serverUrl: "http://server.example.test" },
      expect.stringContaining("insecure transport"),
    );
  });

  it("allows auto-update over loopback HTTP", async () => {
    const test = await createFixture({ serverUrl: "http://127.0.0.1:38886" });
    await expect(test.updater.handleProtocolMismatch()).resolves.toBe(
      "updated",
    );
    expect(test.installTarball).toHaveBeenCalledOnce();
  });

  it("refuses equal protocol reinstalls and downgrades", async () => {
    for (const protocolVersion of [
      HOST_DAEMON_PROTOCOL_VERSION,
      HOST_DAEMON_PROTOCOL_VERSION - 1,
    ]) {
      const test = await createFixture({ protocolVersion });
      await expect(test.updater.handleProtocolMismatch()).resolves.toBe(
        "skipped",
      );
      expect(test.installTarball).not.toHaveBeenCalled();
    }
  });

  it("persists a short exponential retry backoff capped at five minutes", async () => {
    let now = 10_000;
    const test = await createFixture({ now: () => now });
    await expect(test.updater.handleProtocolMismatch()).resolves.toBe(
      "updated",
    );
    now += SELF_UPDATE_INITIAL_RETRY_DELAY_MS - 1;
    await expect(test.updater.handleProtocolMismatch()).resolves.toBe(
      "skipped",
    );
    expect(test.installTarball).toHaveBeenCalledOnce();

    now += 1;
    await expect(test.updater.handleProtocolMismatch()).resolves.toBe(
      "updated",
    );
    expect(test.installTarball).toHaveBeenCalledTimes(2);

    for (let attemptCount = 2; attemptCount < 8; attemptCount += 1) {
      now += Math.min(
        SELF_UPDATE_INITIAL_RETRY_DELAY_MS * 2 ** (attemptCount - 1),
        SELF_UPDATE_MAX_RETRY_DELAY_MS,
      );
      await expect(test.updater.handleProtocolMismatch()).resolves.toBe(
        "updated",
      );
    }

    now += SELF_UPDATE_MAX_RETRY_DELAY_MS - 1;
    await expect(test.updater.handleProtocolMismatch()).resolves.toBe(
      "skipped",
    );
  });

  it("contains install failures and rate-limits their retry", async () => {
    const test = await createFixture({
      installFailure: new Error("npm failed"),
      now: () => 25_000,
    });

    await expect(test.updater.handleProtocolMismatch()).resolves.toBe("failed");
    await expect(test.updater.handleProtocolMismatch()).resolves.toBe(
      "skipped",
    );
    expect(test.installTarball).toHaveBeenCalledOnce();
    expect(test.logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ err: expect.any(Error) }),
      expect.stringContaining("self-update failed"),
    );
  });

  it("lets a user-requested retry bypass and reset the current backoff", async () => {
    let now = 25_000;

    const test = await createFixture({
      installFailure: new Error("download failed"),
      now: () => now,
    });

    await expect(test.updater.handleProtocolMismatch()).resolves.toBe("failed");
    await expect(test.updater.handleProtocolMismatch()).resolves.toBe(
      "skipped",
    );

    await expect(
      test.updater.handleProtocolMismatch({ force: true }),
    ).resolves.toBe("failed");
    expect(test.installTarball).toHaveBeenCalledTimes(2);

    now += SELF_UPDATE_INITIAL_RETRY_DELAY_MS;
    await expect(test.updater.handleProtocolMismatch()).resolves.toBe("failed");
    expect(test.installTarball).toHaveBeenCalledTimes(3);
  });

  it("tries immediately when the server advances to another protocol", async () => {
    let now = 30_000;
    let protocolVersion = HOST_DAEMON_PROTOCOL_VERSION + 1;
    const test = await createFixture({ now: () => now });
    test.fetchFn.mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input);

      if (url.endsWith("/install/version")) {
        return versionResponse({
          version: "test",
          protocolVersion,
          artifactDigest: tarballDigest,
        });
      }

      return new Response("tarball", {
        headers: { "x-omnyo-artifact-sha256": tarballDigest },
      });
    });

    await expect(test.updater.handleProtocolMismatch()).resolves.toBe(
      "updated",
    );
    protocolVersion += 1;
    await expect(test.updater.handleProtocolMismatch()).resolves.toBe(
      "updated",
    );
    expect(test.installTarball).toHaveBeenCalledTimes(2);
  });
});

describe("protocol self-update machine credential", () => {
  const machineCredential = "machine-credential-for-test";

  const tarballPathFor = (dataDir: string) =>
    join(dataDir, `omnyo-app-update-${process.pid}.tgz`);

  function serveUpdate(
    test: Awaited<ReturnType<typeof createFixture>>,
    refusedRequest: number | null = null,
  ) {
    const requests: Array<{ path: string; headers: Headers }> = [];

    test.fetchFn.mockImplementation(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const path = new URL(String(input)).pathname;
        requests.push({ path, headers: new Headers(init?.headers) });

        if (requests.length === refusedRequest)
          return new Response("Machine not authorized\n", { status: 403 });

        if (path === "/install/version")
          return versionResponse({
            version: "9.0.0-test",
            protocolVersion: HOST_DAEMON_PROTOCOL_VERSION + 1,
            artifactDigest: tarballDigest,
          });

        if (requests.at(-1)?.headers.get("if-none-match") !== null)
          return new Response(null, {
            status: 304,
            headers: { "x-omnyo-artifact-sha256": tarballDigest },
          });

        return new Response("tarball", {
          headers: { "x-omnyo-artifact-sha256": tarballDigest },
        });
      },
    );

    return requests;
  }

  it("sends the machine credential on every version and package request", async () => {
    const test = await createFixture({
      machineCredential: ` ${machineCredential} `,
    });

    const requests = serveUpdate(test);
    await expect(test.updater.handleProtocolMismatch()).resolves.toBe(
      "updated",
    );
    await writeFile(
      join(test.dataDir, "host-artifact.sha256"),
      `${tarballDigest}\n`,
    );
    await expect(
      test.updater.handleProtocolMismatch({ force: true }),
    ).resolves.toBe("updated");

    expect(requests.map((request) => request.path)).toEqual([
      "/install/version",
      "/install/omnyo-app.tgz",
      "/install/version",
      "/install/version",
      "/install/version",
      "/install/omnyo-app.tgz",
      "/install/version",
      "/install/version",
    ]);

    for (const request of requests)
      expect(request.headers.get("x-omnyo-connect-machine")).toBe(
        machineCredential,
      );
    expect(requests[5]?.headers.get("if-none-match")).toBe(
      `"sha256-${tarballDigest}"`,
    );
    expect(test.installTarball).toHaveBeenCalledOnce();
  });

  it.each([undefined, "   "])(
    "sends no credential header when the machine has none (%j)",
    async (configured) => {
      const test = await createFixture({ machineCredential: configured });
      const requests = serveUpdate(test);

      await expect(test.updater.handleProtocolMismatch()).resolves.toBe(
        "updated",
      );
      expect(requests).toHaveLength(4);

      for (const request of requests)
        expect(request.headers.has("x-omnyo-connect-machine")).toBe(false);
    },
  );

  it.each([
    ["the version check", 1, "/install/version", false],
    ["the package download", 2, "/install/omnyo-app.tgz", false],
    ["the version recheck after download", 3, "/install/version", false],
    ["the version recheck under admission", 4, "/install/version", true],
  ] as const)(
    "skips the update cycle with one warning when %s answers 403",
    async (_stage, refusedRequest, path, admitted) => {
      const releaseUpdate = vi.fn();
      const resumeDelivery = vi.fn();

      const test = await createFixture({
        acquireUpdate: () => true,
        machineCredential,
        releaseUpdate,
        resumeDelivery,
      });

      const requests = serveUpdate(test, refusedRequest);

      await expect(test.updater.handleProtocolMismatch()).resolves.toBe(
        "skipped",
      );
      expect(requests).toHaveLength(refusedRequest);
      expect(test.installTarball).not.toHaveBeenCalled();
      expect(test.logger.error).not.toHaveBeenCalled();
      expect(test.logger.warn).toHaveBeenCalledOnce();
      expect(test.logger.warn).toHaveBeenCalledWith(
        { path, machineCredentialSent: true },
        expect.stringContaining("HTTP 403"),
      );
      expect(test.updater.getStatus()).toMatchObject({
        phase: "failed",
        reason: "access_refused",
      });
      expect(releaseUpdate).toHaveBeenCalledTimes(admitted ? 1 : 0);
      expect(resumeDelivery).toHaveBeenCalledTimes(admitted ? 1 : 0);

      for (const leftover of [
        join(test.dataDir, "host-daemon-update-attempt.json"),
        tarballPathFor(test.dataDir),
      ])
        await expect(readFile(leftover)).rejects.toMatchObject({
          code: "ENOENT",
        });

      serveUpdate(test);
      await expect(test.updater.handleProtocolMismatch()).resolves.toBe(
        "updated",
      );
      expect(test.installTarball).toHaveBeenCalledOnce();
    },
  );
});

describe("protocol self-update release signature", () => {
  const mismatchOffer = {
    version: "9.0.0-test",
    protocolVersion: HOST_DAEMON_PROTOCOL_VERSION + 1,
    artifactDigest: tarballDigest,
  };

  const privateOffer = {
    version: "0.46.4+private.1",
    protocolVersion: HOST_DAEMON_PROTOCOL_VERSION,
    artifactDigest: tarballDigest,
  };

  type Offer = typeof mismatchOffer;

  type Fixture = Awaited<ReturnType<typeof createFixture>>;

  const entryPoints: Array<
    [string, (test: Fixture) => Promise<string>, Offer, string | undefined]
  > = [
    [
      "a protocol mismatch",
      (test) => test.updater.handleProtocolMismatch(),
      mismatchOffer,
      undefined,
    ],
    [
      "an ordinary check",
      (test) => test.updater.checkForUpdates(),
      privateOffer,
      "0.46.3+private.1",
    ],
    [
      "a requested update",
      (test) => test.updater.requestUpdate(privateOffer),
      privateOffer,
      "0.46.3+private.1",
    ],
  ];

  const flipped = (signature: string) =>
    `${signature[0] === "A" ? "B" : "A"}${signature.slice(1)}`;

  const unacceptable: Array<
    [string, (offer: Offer) => Record<string, unknown>, RegExp]
  > = [
    ["has no signature", (offer) => ({ ...offer }), /without a release/u],
    [
      "has null signature fields",
      (offer) => ({
        ...offer,
        artifactSignature: null,
        artifactSignatureKeyId: null,
      }),
      /without a release/u,
    ],
    [
      "has a signature without a key id",
      (offer) => ({
        ...offer,
        artifactSignature: signedVersionBody(offer).artifactSignature,
      }),
      /without a release/u,
    ],
    [
      "is signed for another version",
      (offer) => ({
        ...offer,
        ...signedVersionBody({ ...offer, version: "0.46.9+private.1" }),
        version: offer.version,
      }),
      /not valid/u,
    ],
    [
      "is signed for another protocol",
      (offer) => ({
        ...offer,
        ...signedVersionBody({ ...offer, protocolVersion: 1 }),
        protocolVersion: offer.protocolVersion,
      }),
      /not valid/u,
    ],
    [
      "is signed for another digest",
      (offer) => ({
        ...offer,
        ...signedVersionBody({ ...offer, artifactDigest: "e".repeat(64) }),
        artifactDigest: offer.artifactDigest,
      }),
      /not valid/u,
    ],
    [
      "is signed by a key that is not listed",
      (offer) => signedVersionBody(offer, unlistedKey),
      /not valid/u,
    ],
    [
      "has a damaged signature",
      (offer) => {
        const body = signedVersionBody(offer);

        return { ...body, artifactSignature: flipped(body.artifactSignature) };
      },
      /not valid/u,
    ],
    [
      "has a malformed signature",
      (offer) => ({ ...signedVersionBody(offer), artifactSignature: "!!!" }),
      /not valid/u,
    ],
  ];

  function serve(test: Fixture, version: Record<string, unknown>) {
    const requests: string[] = [];

    test.fetchFn.mockImplementation(async (input: RequestInfo | URL) => {
      const path = new URL(String(input)).pathname;
      requests.push(path);

      if (path === "/install/version") return Response.json(version);

      return new Response("tarball", {
        headers: { "x-omnyo-artifact-sha256": tarballDigest },
      });
    });

    return requests;
  }

  async function expectNothingStaged(test: Fixture) {
    for (const leftover of [
      join(test.dataDir, "host-daemon-update-attempt.json"),
      join(test.dataDir, PENDING_RUNTIME_INSTALL_FILE_NAME),
      join(test.dataDir, PENDING_RUNTIME_INSTALL_TARBALL_NAME),
      join(test.dataDir, "host-artifact.sha256"),
      join(test.dataDir, `omnyo-app-update-${process.pid}.tgz`),
    ])
      await expect(readFile(leftover)).rejects.toMatchObject({
        code: "ENOENT",
      });
  }

  describe.each(entryPoints)("%s", (_name, run, offer, currentVersion) => {
    it.each(unacceptable)(
      "installs nothing when the offer %s",
      async (_case, body, message) => {
        const acquireUpdate = vi.fn(() => true);
        const onInstalled = vi.fn();

        const test = await createFixture({
          acquireUpdate,
          currentVersion,
          onInstalled,
        });

        const requests = serve(test, body(offer));

        await expect(run(test)).resolves.toBe("skipped");
        expect(requests).toEqual(["/install/version"]);
        expect(test.installTarball).not.toHaveBeenCalled();
        expect(acquireUpdate).not.toHaveBeenCalled();
        expect(onInstalled).not.toHaveBeenCalled();
        expect(test.logger.warn).toHaveBeenCalledOnce();
        expect(test.logger.warn).toHaveBeenCalledWith(
          expect.objectContaining({
            serverUrl: "https://server.example.test",
            artifactDigest: tarballDigest,
          }),
          expect.stringMatching(message),
        );
        expect(test.logger.error).not.toHaveBeenCalled();
        expect(test.updater.getStatus()).toMatchObject({
          phase: "failed",
          reason: "signature_unverified",
        });
        await expectNothingStaged(test);
      },
    );

    it("installs once a later cycle offers a valid signature", async () => {
      const test = await createFixture({ currentVersion });
      serve(test, { ...offer });
      await expect(run(test)).resolves.toBe("skipped");
      serve(test, signedVersionBody(offer));
      await expect(run(test)).resolves.toBe("updated");
      expect(test.installTarball).toHaveBeenCalledOnce();
    });
  });

  it("warns on every refused cycle and keeps the daemon running", async () => {
    const test = await createFixture();

    serve(test, { ...mismatchOffer });
    await test.updater.handleProtocolMismatch();
    await test.updater.handleProtocolMismatch();
    expect(test.logger.warn).toHaveBeenCalledTimes(2);
    expect(test.installTarball).not.toHaveBeenCalled();
  });

  it("verifies against the compiled-in release keys by default", async () => {
    const test = await createFixture({ signingPublicKeys: "pinned" });
    const requests = serve(test, signedVersionBody(mismatchOffer));

    await expect(test.updater.handleProtocolMismatch()).resolves.toBe(
      "skipped",
    );
    expect(requests).toEqual(["/install/version"]);
    expect(test.installTarball).not.toHaveBeenCalled();
    expect(test.logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ signaturePresent: true }),
      expect.stringMatching(/not valid/u),
    );
  });

  it("accepts a valid signature next to unknown response fields", async () => {
    const test = await createFixture();

    serve(test, { ...signedVersionBody(mismatchOffer), futureField: [1, 2] });
    await expect(test.updater.handleProtocolMismatch()).resolves.toBe(
      "updated",
    );
    expect(test.installTarball).toHaveBeenCalledOnce();
  });

  it("keeps the tarball digest check for a signed offer", async () => {
    const test = await createFixture();

    test.fetchFn.mockImplementation(async (input: RequestInfo | URL) =>
      new URL(String(input)).pathname === "/install/version"
        ? versionResponse(mismatchOffer)
        : new Response("different bytes", {
            headers: { "x-omnyo-artifact-sha256": tarballDigest },
          }),
    );
    await expect(test.updater.handleProtocolMismatch()).resolves.toBe("failed");
    expect(test.installTarball).not.toHaveBeenCalled();
    expect(test.logger.error).toHaveBeenCalledOnce();
  });

  it("restarts into an already installed artifact only with a valid signature", async () => {
    const onInstalled = vi.fn();
    const test = await createFixture({ onInstalled });

    await writeFile(
      join(test.dataDir, "host-artifact.sha256"),
      `${tarballDigest}\n`,
    );

    const requests: string[] = [];

    const serveInstalled = (version: Record<string, unknown>) =>
      test.fetchFn.mockImplementation(async (input: RequestInfo | URL) => {
        const path = new URL(String(input)).pathname;
        requests.push(path);

        return path === "/install/version"
          ? Response.json(version)
          : new Response(null, {
              status: 304,
              headers: { "x-omnyo-artifact-sha256": tarballDigest },
            });
      });

    serveInstalled({ ...mismatchOffer });
    await expect(test.updater.handleProtocolMismatch()).resolves.toBe(
      "skipped",
    );
    expect(requests).toEqual(["/install/version"]);
    expect(onInstalled).not.toHaveBeenCalled();
    serveInstalled(signedVersionBody(mismatchOffer));
    await expect(test.updater.handleProtocolMismatch()).resolves.toBe(
      "updated",
    );
    expect(onInstalled).toHaveBeenCalledOnce();
    expect(test.installTarball).not.toHaveBeenCalled();
  });

  it("hands nothing to the Windows service without a valid signature", async () => {
    const test = await createFixture({ installMode: "service-handoff" });

    serve(test, { ...mismatchOffer });
    await expect(test.updater.handleProtocolMismatch()).resolves.toBe(
      "skipped",
    );
    expect(test.updater.serviceInstallPending()).toBe(false);
    await expectNothingStaged(test);
    serve(test, signedVersionBody(mismatchOffer));
    await expect(test.updater.handleProtocolMismatch()).resolves.toBe(
      "updated",
    );
    expect(test.updater.serviceInstallPending()).toBe(true);
  });

  it("keeps the extended version response readable by the previous daemon schema", () => {
    const previousSchema = z.object({
      protocolVersion: z.number().int().positive(),
      version: z.string().min(1),
      artifactDigest: z.string().regex(/^[a-f0-9]{64}$/u),
    });

    expect(previousSchema.parse(signedVersionBody(mismatchOffer))).toEqual(
      mismatchOffer,
    );
    expect(
      previousSchema.parse({
        ...mismatchOffer,
        artifactSignature: null,
        artifactSignatureKeyId: null,
      }),
    ).toEqual(mismatchOffer);
  });

  it("does not ask for a signature when no update is needed", async () => {
    const test = await createFixture({ currentVersion: "0.46.4+private.1" });

    await writeFile(
      join(test.dataDir, "host-artifact.sha256"),
      `${tarballDigest}\n`,
    );
    serve(test, { ...privateOffer });
    await expect(test.updater.checkForUpdates()).resolves.toBe("skipped");
    expect(test.logger.warn).not.toHaveBeenCalled();
    expect(test.updater.getStatus()).toMatchObject({
      phase: "current",
      reason: "current",
    });
  });
});
