import { readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join } from "node:path";
import {
  createRuntimeIdentity,
  readServerConnectHoldFile,
  readServerImportFile,
  readServerMovedFile,
  writeServerConnectHoldFile,
  writeServerImportFile,
  writeServerMovedFile,
} from "@omnyo/server-archive";
import { HOST_DAEMON_PROTOCOL_VERSION } from "@omnyo/host-daemon-contract";
import { maintenanceStatusSchema } from "@omnyo/server-contract";
import { describe, expect, it } from "vitest";
import { readIncomingMoveState, writeIncomingMoveState } from "./move-state.js";
import { isProcessGroupAlive } from "./pending-server.js";
import {
  ACTIVATION_TOKEN,
  createFixture,
  exists,
  freePort,
  HOST_KEY,
  LAUNCHER_ENTRY_PATH,
  launcherProcessOps,
  listen,
  MOVE_ID,
  prepareCommand,
  readJson,
  registerServerMoveFixtureCleanup,
  writeOmnyoAppRuntime,
  writeFileWithDirs,
  writeLauncherMovedMode,
  type Fixture,
} from "./test-fixture.js";

registerServerMoveFixtureCleanup();

const idleDirectActivity = {
  commands: 0,
  runtimes: 0,
  terminals: 0,
  pluginHosts: 0,
  interactions: 0,
};

const directProbeCommand = {
  type: "server_access.probe_direct" as const,
  serverUrl: "https://direct.example.test",
  challenge: "test-direct-probe",
  instanceId: "test-coordinator-instance",
};

describe("ServerMoveService direct probe ownership", () => {
  it.each([null, { ...idleDirectActivity, commands: 1 }])(
    "releases already-cleared busy probes idempotently: %j",
    async (activity) => {
      const fixture = await createFixture();

      const service = fixture.createService({
        getDirectAccessActivity: () => activity,
        fetchFn: async () => {
          throw new Error("Busy admission must not reach the network");
        },
      });

      await expect(service.probeDirect(directProbeCommand)).rejects.toThrow(
        activity === null
          ? "Worker activity is unknown"
          : "Worker owners are busy",
      );

      for (let attempt = 0; attempt < 2; attempt++)
        await expect(
          service.releaseDirectProbe({
            type: "server_access.release_direct_probe",
            challenge: directProbeCommand.challenge,
          }),
        ).resolves.toEqual({ ok: true });
      expect(() => service.assertDirectAccessAdmission()).not.toThrow();
    },
  );

  it("refuses foreign and committed releases without opening worker admission", async () => {
    const fixture = await createFixture();

    const service = fixture.createService({
      getDirectAccessActivity: () => idleDirectActivity,
      fetchFn: async () => {
        throw new Error("Direct route is unavailable");
      },
    });

    await expect(service.probeDirect(directProbeCommand)).rejects.toThrow(
      "Direct route is unavailable",
    );
    await expect(
      service.releaseDirectProbe({
        type: "server_access.release_direct_probe",
        challenge: "different-probe-owner",
      }),
    ).rejects.toThrow("owner does not match or is committed");
    expect(() =>
      service.assertDirectAccessAdmission("host.paths_exist"),
    ).toThrow("Worker admission is held");
    await service.releaseDirectProbe({
      type: "server_access.release_direct_probe",
      challenge: directProbeCommand.challenge,
    });
    expect(() => service.assertDirectAccessAdmission()).not.toThrow();
    await expect(service.probeDirect(directProbeCommand)).rejects.toThrow(
      "Direct route is unavailable",
    );
    await service.handleServerMoved({
      source: "message",
      serverUrl: fixture.options.serverUrl,
      headers: { "x-omnyo-direct-proof": directProbeCommand.challenge },
    });
    await expect(
      service.releaseDirectProbe({
        type: "server_access.release_direct_probe",
        challenge: directProbeCommand.challenge,
      }),
    ).rejects.toThrow("owner does not match or is committed");
    expect(() => service.assertDirectAccessAdmission()).toThrow(
      "Worker admission is held",
    );
  });

  it("allows only read-only probe inspection while held and reports actual owner/session linkage", async () => {
    const fixture = await createFixture();
    let sessionId = "worker-session-at-probe";

    const service = fixture.createService({
      instanceId: "worker-instance",
      getServerSessionId: () => sessionId,
      getDirectAccessActivity: () => idleDirectActivity,
      fetchFn: async () => {
        throw new Error("Direct route is unavailable");
      },
    });

    const absent = {
      hostId: fixture.options.hostId,
      workerInstanceId: "worker-instance",
      sessionId,
      probe: null,
    };

    await expect(service.inspectDirectProbe()).resolves.toEqual(absent);
    await expect(service.probeDirect(directProbeCommand)).rejects.toThrow(
      "Direct route is unavailable",
    );
    expect(() =>
      service.assertDirectAccessAdmission("server_access.inspect_direct_probe"),
    ).not.toThrow();

    for (const commandType of ["host.paths_exist", "server_move.inspect"])
      expect(() => service.assertDirectAccessAdmission(commandType)).toThrow(
        "Worker admission is held",
      );
    sessionId = "worker-session-after-reconnect";
    const uncommitted = await service.inspectDirectProbe();
    expect(uncommitted).toEqual({
      ...absent,
      sessionId,
      probe: {
        phase: "uncommitted",
        ownerFingerprint: createHash("sha256")
          .update(directProbeCommand.challenge)
          .digest("hex"),
        coordinatorInstanceId: directProbeCommand.instanceId,
        sessionId: "worker-session-at-probe",
      },
    });
    expect(JSON.stringify(uncommitted)).not.toContain(
      directProbeCommand.challenge,
    );
    await service.handleServerMoved({
      source: "message",
      serverUrl: fixture.options.serverUrl,
      headers: { "x-omnyo-direct-proof": directProbeCommand.challenge },
    });
    const committed = await service.inspectDirectProbe();
    expect(committed).toEqual({
      ...uncommitted,
      probe: { ...uncommitted.probe, phase: "committed" },
    });
    await expect(service.inspectDirectProbe()).resolves.toEqual(committed);
    expect(() => service.assertDirectAccessAdmission()).toThrow(
      "Worker admission is held",
    );
  });
});

describe("ServerMoveService.prepare", () => {
  it("owns the packaged launcher server child and refuses mismatched endpoint and process identities", async () => {
    const fixture = await createFixture({ packagedPendingServer: true });
    const command = await prepareCommand(fixture);
    const result = await fixture.service.prepare(command);

    const response = await fetch(
      `${result.localServerUrl}/api/v1/server/maintenance`,
    );

    const maintenance = maintenanceStatusSchema.parse(await response.json());
    expect(maintenance.runtime.processId).not.toBe(result.pid);
    expect(maintenance.runtime.parentProcessId).toBe(result.pid);
    await expect(fixture.service.prepare(command)).resolves.toEqual(result);
    expect(fixture.source.archiveRequests).toHaveLength(1);

    for (const identity of [
      { runtime: { parentProcessId: process.pid } },
      { runtime: { launchId: "wrong-launch" } },
      { moveId: "wrong-move" },
      { runtime: { dataDir: fixture.root } },
    ]) {
      await writeFile(
        join(fixture.dataDir, "pending-identity.json"),
        JSON.stringify(identity),
      );
      await expect(
        fixture.service.abort({ type: "server_move.abort", moveId: MOVE_ID }),
      ).rejects.toThrow(
        "Pending process endpoint ownership identity does not match",
      );
      expect(isProcessGroupAlive(result.pid)).toBe(true);
      expect(await exists(join(fixture.dataDir, "app.db"))).toBe(true);
    }

    await writeFile(join(fixture.dataDir, "pending-identity.json"), "{}");
    const state = await readIncomingMoveState(fixture.dataDir, MOVE_ID);

    if (state?.pendingServer == null || state.pendingServer.startedAt == null)
      throw new Error("Pending process receipt is missing");
    const startedAt = state.pendingServer.startedAt;
    state.pendingServer.startedAt = startedAt - 60_000;
    await writeIncomingMoveState(fixture.dataDir, state);
    await expect(
      fixture.service.abort({ type: "server_move.abort", moveId: MOVE_ID }),
    ).rejects.toThrow("Pending process start identity does not match");
    expect(isProcessGroupAlive(result.pid)).toBe(true);
    state.pendingServer.startedAt = startedAt;
    await writeIncomingMoveState(fixture.dataDir, state);
    await expect(
      fixture.service.abort({ type: "server_move.abort", moveId: MOVE_ID }),
    ).resolves.toEqual({ ok: true, moveId: MOVE_ID, fenced: true });
    expect(isProcessGroupAlive(result.pid)).toBe(false);
    expect(await exists(join(fixture.dataDir, "app.db"))).toBe(false);
  });

  it("installs omnyo-app, imports the archive, keeps this machine's credentials, starts the pending server, and answers a repeated prepare with the same server", async () => {
    const installed: Buffer[] = [];

    const fixture = await createFixture({
      installOmnyoApp: async (tarballPath) => {
        installed.push(await readFile(tarballPath));
      },
    });

    await writeFile(
      join(fixture.dataDir, "host-artifact.sha256"),
      "a".repeat(64),
    );
    await writeFile(
      join(fixture.dataDir, "config.json"),
      JSON.stringify({
        serverUrl: "https://omnyo.example.test",
        serverHeaders: { "x-omnyo-connect-machine": "bbcm_target" },
        machineCredential: "bbcm_target",
        connectMachineId: "machine-target",
      }),
    );

    const identity = await createRuntimeIdentity(fixture.packageRoot, {
      runtimeVersion: "1.0.0",
      hostDaemonProtocolVersion: HOST_DAEMON_PROTOCOL_VERSION,
    });

    await writeFile(
      join(fixture.packageRoot, "dist", "runtime-identity.json"),
      JSON.stringify(identity),
    );

    const command = await prepareCommand(fixture, {
      appRuntime: {
        downloadPath: `/internal/server-move/${MOVE_ID}/app-runtime.tgz`,
        sha256: fixture.source.omnyoAppSha256,
        sizeBytes: fixture.source.omnyoAppSizeBytes,
        version: "1.0.0",
        runtimeSha256: identity.runtimeSha256,
      },
    });

    const result = await fixture.service.prepare(command);

    expect(result).toEqual({
      localServerUrl: `http://127.0.0.1:${command.serverPort}`,
      pid: expect.any(Number),
    });
    expect(isProcessGroupAlive(result.pid)).toBe(true);
    expect(installed.map((bytes) => bytes.toString("utf8"))).toEqual([
      "full omnyo-app package",
    ]);
    expect(await exists(join(fixture.dataDir, "host-artifact.sha256"))).toBe(
      false,
    );
    expect(await readFile(join(fixture.dataDir, "app.db"), "utf8")).toBe(
      "sqlite database bytes",
    );
    expect(
      await readFile(
        join(fixture.dataDir, "attachments", "project", "a.txt"),
        "utf8",
      ),
    ).toBe("attachment");
    expect(await readJson(join(fixture.dataDir, "config.json"))).toEqual({
      config: { OMNYO_LOG_LEVEL: "info" },
      serverUrl: "https://omnyo.example.test",
      serverHeaders: { "x-omnyo-connect-machine": "bbcm_target" },
      machineCredential: "bbcm_target",
      connectMachineId: "machine-target",
    });
    expect(await readServerImportFile(fixture.dataDir)).toEqual({
      version: 1,
      kind: "move",
      moveId: MOVE_ID,
      activationToken: ACTIVATION_TOKEN,
      sourceDataDir: "/Users/me/.omnyo",
      sourceServerHostId: "host-source",
      targetHostId: "host-target",
      serverUrl: "https://omnyo.example.test",
      importedEntries: expect.arrayContaining([
        "app.db",
        "config.json",
        "attachments/project/a.txt",
        "plugins/tasks/data.db",
      ]),
      createdAt: expect.any(Number),
      fixupsAppliedAt: null,
    });
    expect(await readServerConnectHoldFile(fixture.dataDir)).toBeNull();
    expect(fixture.launches).toEqual([
      {
        omnyoServerEntry: join(fixture.packageRoot, "dist", "omnyo-server.js"),
        dataDir: fixture.dataDir,
        serverPort: command.serverPort,
        bindHost: null,
        hostDaemonPort: 38_887,
        env: expect.objectContaining({ OMNYO_HOST_DAEMON_PORT: "38887" }),
        logPath: join(
          fixture.dataDir,
          "logs",
          "server-move-pending-server.log",
        ),
      },
    ]);
    expect(fixture.source.archiveRequests[0]?.headers).toMatchObject({
      authorization: `Bearer ${HOST_KEY}`,
      "x-test-access": "opaque",
    });
    const steps = fixture.progress.map((message) => message.step);
    expect(steps[0]).toBe("update-target");
    expect(steps.indexOf("transfer")).toBeGreaterThan(
      steps.lastIndexOf("update-target"),
    );
    expect(fixture.progress.at(-1)).toEqual({
      type: "server_move.progress",
      moveId: MOVE_ID,
      step: "start-target",
      message: "The imported server is running",
    });
    expect(
      await readdir(join(fixture.dataDir, "server-move-incoming", MOVE_ID)),
    ).toEqual(["state.json"]);

    await expect(fixture.service.prepare(command)).resolves.toEqual(result);
    expect(fixture.source.archiveRequests).toHaveLength(1);
    expect(fixture.launches).toHaveLength(1);
  });

  it("fails on a digest mismatch and leaves the target data dir untouched", async () => {
    const fixture = await createFixture();

    const originalConfig = JSON.stringify({
      serverUrl: "https://omnyo.example.test",
    });

    await writeFile(join(fixture.dataDir, "config.json"), originalConfig);
    const command = await prepareCommand(fixture);

    await expect(
      fixture.service.prepare({
        ...command,
        archive: { ...command.archive, sha256: "0".repeat(64) },
      }),
    ).rejects.toMatchObject({ code: "server_move_digest_mismatch" });

    expect(await exists(join(fixture.dataDir, "app.db"))).toBe(false);
    expect(await exists(join(fixture.dataDir, "server-import.json"))).toBe(
      false,
    );
    expect(await exists(join(fixture.dataDir, "server-move-incoming"))).toBe(
      false,
    );
    expect(await readFile(join(fixture.dataDir, "config.json"), "utf8")).toBe(
      originalConfig,
    );
    expect(fixture.launches).toEqual([]);
  });

  it("abort stops the pending server, restores config backups, and un-archives standalone data", async () => {
    const fixture = await createFixture();

    const originalConfig = {
      config: { OMNYO_LOG_LEVEL: "debug" },
      serverUrl: "https://omnyo.example.test",
      machineCredential: "bbcm_target",
    };

    await writeFile(
      join(fixture.dataDir, "config.json"),
      JSON.stringify(originalConfig),
    );
    await writeFileWithDirs(
      join(fixture.homeDir, ".omnyo", "app.db"),
      "standalone server",
    );

    const command = await prepareCommand(fixture, {
      archiveExistingServerData: true,
    });

    const result = await fixture.service.prepare(command);
    expect(await exists(join(fixture.homeDir, ".omnyo"))).toBe(false);
    expect(
      (await readdir(fixture.homeDir)).some((name) =>
        name.startsWith(".omnyo.before-move-"),
      ),
    ).toBe(true);

    await expect(
      fixture.service.abort({ type: "server_move.abort", moveId: MOVE_ID }),
    ).resolves.toEqual({ ok: true, moveId: MOVE_ID, fenced: true });

    expect(isProcessGroupAlive(result.pid)).toBe(false);
    expect(await readJson(join(fixture.dataDir, "config.json"))).toEqual(
      originalConfig,
    );
    expect(await exists(join(fixture.dataDir, "app.db"))).toBe(false);
    expect(await exists(join(fixture.dataDir, "attachments"))).toBe(false);
    expect(await exists(join(fixture.dataDir, "server-import-backup"))).toBe(
      false,
    );
    expect(await exists(join(fixture.dataDir, "server-import.json"))).toBe(
      false,
    );
    expect(await exists(join(fixture.dataDir, "server-move-incoming"))).toBe(
      false,
    );
    expect(
      await readFile(join(fixture.homeDir, ".omnyo", "app.db"), "utf8"),
    ).toBe("standalone server");
    await expect(
      fixture.service.abort({ type: "server_move.abort", moveId: MOVE_ID }),
    ).resolves.toEqual({ ok: true, moveId: MOVE_ID, fenced: true });
  });

  it("abort removes a legacy Connect hold left beside the imported server", async () => {
    const fixture = await createFixture();
    await fixture.service.prepare(await prepareCommand(fixture));
    await writeServerConnectHoldFile(fixture.dataDir, {
      version: 1,
      reason: "manual-import",
      createdAt: 1,
    });

    await expect(
      fixture.service.abort({ type: "server_move.abort", moveId: MOVE_ID }),
    ).resolves.toEqual({ ok: true, moveId: MOVE_ID, fenced: true });

    expect(await exists(join(fixture.dataDir, "app.db"))).toBe(false);
    expect(await readServerConnectHoldFile(fixture.dataDir)).toBeNull();
  });

  it("refuses to archive ~/.omnyo while Omnyo is running from it", async () => {
    const fixture = await createFixture();
    await writeFileWithDirs(
      join(fixture.homeDir, ".omnyo", "app.db"),
      "standalone server",
    );
    await writeOmnyoAppRuntime({
      dataDir: join(fixture.homeDir, ".omnyo"),
      serverPort: 38_886,
    });

    const command = await prepareCommand(fixture, {
      archiveExistingServerData: true,
    });

    await expect(fixture.service.prepare(command)).rejects.toMatchObject({
      code: "server_move_rejected",
      message: `Omnyo is running from ${join(fixture.homeDir, ".omnyo")} on this machine (pid ${process.pid}). Quit Omnyo there first, then start the move again.`,
    });
    expect(fixture.source.archiveRequests).toEqual([]);
    expect(
      await readFile(join(fixture.homeDir, ".omnyo", "app.db"), "utf8"),
    ).toBe("standalone server");

    const stopped = await createFixture({
      processOps: {
        isRunning: () => false,
        readIdentity: async () => ({
          command: `node ${LAUNCHER_ENTRY_PATH} start`,
          startedAt: null,
        }),
      },
    });

    await writeFileWithDirs(
      join(stopped.homeDir, ".omnyo", "app.db"),
      "standalone server",
    );
    await writeOmnyoAppRuntime({
      dataDir: join(stopped.homeDir, ".omnyo"),
      serverPort: 38_886,
    });
    await expect(
      stopped.service.prepare(
        await prepareCommand(stopped, { archiveExistingServerData: true }),
      ),
    ).resolves.toMatchObject({ pid: expect.any(Number) });
    expect(await exists(join(stopped.homeDir, ".omnyo"))).toBe(false);
  });
});

describe("ServerMoveService in launcher-managed moved mode", () => {
  it("reports the launcher's own responder port as available and other busy ports as in use", async () => {
    const fixture = await createFixture({
      checkPortAvailable: async () => false,
    });

    await writeLauncherMovedMode({
      dataDir: fixture.dataDir,
      serverPort: 38_886,
    });

    const inspect = (port: number) =>
      fixture.service.inspect({ type: "server_move.inspect", paths: [], port });

    expect((await inspect(38_886)).portAvailable).toBe(true);
    expect((await inspect(39_886)).portAvailable).toBe(false);
    expect((await inspect(38_886)).dataDirHasServerData).toBe(false);
  });

  it.each([
    {
      name: "the launcher pid is not running",
      processOps: {
        isRunning: () => false,
        readIdentity: async () => ({
          command: `node ${LAUNCHER_ENTRY_PATH} start`,
          startedAt: null,
        }),
      },
      movedFile: true,
    },
    {
      name: "the recorded pid is not omnyo-app",
      processOps: {
        isRunning: () => true,
        readIdentity: async () => ({
          command: "/usr/bin/python3 http.server 38886",
          startedAt: null,
        }),
      },
      movedFile: true,
    },
    {
      name: "the data dir has no moved-server lock",
      processOps: launcherProcessOps,
      movedFile: false,
    },
  ])(
    "does not treat the port as the launcher's when $name",
    async ({ processOps, movedFile }) => {
      const fixture = await createFixture({
        checkPortAvailable: async () => false,
        processOps,
      });

      await writeLauncherMovedMode({
        dataDir: fixture.dataDir,
        serverPort: 38_886,
      });

      if (!movedFile) {
        await rm(join(fixture.dataDir, "server-moved.json"));
      }

      const result = await fixture.service.inspect({
        type: "server_move.inspect",
        paths: [],
        port: 38_886,
      });

      expect(result.portAvailable).toBe(false);
    },
  );

  it("waits for the launcher to release the old server port after writing server-import.json", async () => {
    const portChecks: boolean[] = [];
    let busyChecks = 3;
    let fixture: Fixture | null = null;
    fixture = await createFixture({
      portReleaseTimeoutMs: 10_000,
      checkPortAvailable: async () => {
        if (fixture === null) {
          throw new Error("Expected the fixture");
        }

        portChecks.push(
          await exists(join(fixture.dataDir, "server-import.json")),
        );
        busyChecks -= 1;

        return busyChecks < 0;
      },
    });
    const command = await prepareCommand(fixture);
    await writeLauncherMovedMode({
      dataDir: fixture.dataDir,
      serverPort: command.serverPort,
    });

    const result = await fixture.service.prepare(command);

    expect(result.localServerUrl).toBe(
      `http://127.0.0.1:${command.serverPort}`,
    );
    expect(portChecks).toEqual([true, true, true, true]);
    expect(fixture.launches).toHaveLength(1);
    expect(fixture.progress.map((message) => message.message)).toContain(
      `Waiting for this machine's old server address on port ${command.serverPort} to close`,
    );
  });

  it("fails and cleans up when the old server port stays busy", async () => {
    const fixture = await createFixture({
      checkPortAvailable: async () => false,
    });

    const command = await prepareCommand(fixture);
    await writeLauncherMovedMode({
      dataDir: fixture.dataDir,
      serverPort: command.serverPort,
    });

    await expect(fixture.service.prepare(command)).rejects.toMatchObject({
      code: "server_move_start_failed",
      message: expect.stringContaining(
        `Port ${command.serverPort} is still in use on this machine`,
      ),
    });

    expect(fixture.launches).toEqual([]);
    expect(await exists(join(fixture.dataDir, "server-import.json"))).toBe(
      false,
    );
    expect(await exists(join(fixture.dataDir, "app.db"))).toBe(false);
    expect(await exists(join(fixture.dataDir, "server-moved.json"))).toBe(true);
    expect(await exists(join(fixture.dataDir, "server-move-incoming"))).toBe(
      false,
    );
  });
});

describe("ServerMoveService own data dir guards", () => {
  it("blocks while an old server copy is still listed, then clears after delete_old_copy", async () => {
    const fixture = await createFixture();
    await writeFile(join(fixture.dataDir, "app.db"), "old server");
    await writeFileWithDirs(
      join(fixture.dataDir, "attachments", "a.txt"),
      "old attachment",
    );
    await writeLauncherMovedMode({
      dataDir: fixture.dataDir,
      serverPort: 38_886,
      oldCopyEntries: ["app.db", "attachments"],
    });

    const inspect = () =>
      fixture.service.inspect({
        type: "server_move.inspect",
        paths: [],
        port: 38_886,
      });

    expect((await inspect()).dataDirHasServerData).toBe(true);
    await rm(join(fixture.dataDir, "app.db"));
    expect((await inspect()).dataDirHasServerData).toBe(true);

    await expect(fixture.service.deleteOldCopy()).resolves.toEqual({
      deleted: true,
    });
    expect((await inspect()).dataDirHasServerData).toBe(false);
  });

  it("reports a leftover server-import-backup as server data when no move is in progress", async () => {
    const fixture = await createFixture();
    await writeFileWithDirs(
      join(fixture.dataDir, "server-import-backup", "config.json"),
      "{}",
    );

    const inspect = () =>
      fixture.service.inspect({
        type: "server_move.inspect",
        paths: [],
        port: 38_886,
      });

    expect((await inspect()).dataDirHasServerData).toBe(true);
    await writeFileWithDirs(
      join(fixture.dataDir, "server-move-incoming", "move-other", "state.json"),
      "{}",
    );
    expect((await inspect()).dataDirHasServerData).toBe(false);
  });

  it("rolls back an import that crashed before the move recorded it, so the next prepare succeeds", async () => {
    const fixture = await createFixture();
    const { dataDir } = fixture;

    const originalConfig = {
      config: { OMNYO_LOG_LEVEL: "debug" },
      serverUrl: "https://omnyo.example.test",
      machineCredential: "bbcm_target",
    };

    await writeFileWithDirs(join(dataDir, "app.db"), "crashed import database");
    await writeFileWithDirs(
      join(dataDir, "attachments", "crashed", "a.txt"),
      "crashed attachment",
    );
    await writeFileWithDirs(
      join(dataDir, "config.json"),
      JSON.stringify({
        config: { OMNYO_LOG_LEVEL: "info" },
        serverUrl: "http://127.0.0.1:39999",
      }),
    );
    await writeFileWithDirs(
      join(dataDir, "server-import-backup", "config.json"),
      JSON.stringify(originalConfig),
    );
    await writeFileWithDirs(
      join(dataDir, "server-import-journal.json"),
      JSON.stringify({
        version: 1,
        entries: ["attachments/crashed/a.txt", "config.json", "app.db"],
        preexistingEntries: ["config.json"],
      }),
    );
    await writeIncomingMoveState(dataDir, {
      version: 1,
      moveId: "move-crashed",
      activationToken: ACTIVATION_TOKEN,
      serverPort: 39_999,
      bindHost: null,
      importedEntries: null,
      archivedServerData: null,
      pendingServer: null,
      runtime: null,
      preparedAt: null,
      activation: null,
    });

    const inspected = await fixture.service.inspect({
      type: "server_move.inspect",
      paths: [],
      port: 38_886,
    });

    expect(inspected.dataDirHasServerData).toBe(false);

    await expect(
      fixture.service.prepare(await prepareCommand(fixture)),
    ).resolves.toMatchObject({ pid: expect.any(Number) });

    expect(await readdir(join(dataDir, "server-move-incoming"))).toEqual([
      MOVE_ID,
    ]);
    expect(await exists(join(dataDir, "attachments", "crashed"))).toBe(false);
    expect(await exists(join(dataDir, "server-import-journal.json"))).toBe(
      false,
    );
    expect(await readFile(join(dataDir, "app.db"), "utf8")).toBe(
      "sqlite database bytes",
    );
    expect(
      await readJson(join(dataDir, "server-import-backup", "config.json")),
    ).toEqual(originalConfig);
    expect(await readJson(join(dataDir, "config.json"))).toEqual({
      config: { OMNYO_LOG_LEVEL: "info" },
      serverUrl: "https://omnyo.example.test",
      machineCredential: "bbcm_target",
    });
  });

  it("rolls back a crashed manual import in this data directory so it doesn't block a move", async () => {
    const fixture = await createFixture();
    const { dataDir } = fixture;
    await writeFileWithDirs(join(dataDir, "app.db"), "half-imported database");
    await writeFileWithDirs(
      join(dataDir, "attachments", "project", "a.txt"),
      "half-imported attachment",
    );
    await writeFileWithDirs(
      join(dataDir, "server-import-journal.json"),
      JSON.stringify({
        version: 1,
        entries: ["attachments/project/a.txt", "app.db"],
        preexistingEntries: [],
      }),
    );

    const inspected = await fixture.service.inspect({
      type: "server_move.inspect",
      paths: [],
      port: 38_886,
    });

    expect(inspected.dataDirHasServerData).toBe(false);

    await expect(
      fixture.service.prepare(await prepareCommand(fixture)),
    ).resolves.toMatchObject({ pid: expect.any(Number) });

    expect(await readFile(join(dataDir, "app.db"), "utf8")).toBe(
      "sqlite database bytes",
    );
    expect(
      await readFile(join(dataDir, "attachments", "project", "a.txt"), "utf8"),
    ).toBe("attachment");
    expect(await exists(join(dataDir, "server-import-journal.json"))).toBe(
      false,
    );
  });

  it("removes the legacy Connect hold of an interrupted manual import it rolls back before a move", async () => {
    const fixture = await createFixture();
    const { dataDir } = fixture;
    await writeFileWithDirs(join(dataDir, "app.db"), "half-imported database");
    await writeFileWithDirs(
      join(dataDir, "server-import-journal.json"),
      JSON.stringify({
        version: 1,
        entries: ["app.db"],
        preexistingEntries: [],
      }),
    );
    await writeServerConnectHoldFile(dataDir, {
      version: 1,
      reason: "manual-import",
      createdAt: 1,
    });

    await expect(
      fixture.service.prepare(await prepareCommand(fixture)),
    ).resolves.toMatchObject({ pid: expect.any(Number) });

    expect(await readFile(join(dataDir, "app.db"), "utf8")).toBe(
      "sqlite database bytes",
    );
    expect(await readServerConnectHoldFile(dataDir)).toBeNull();
  });

  it("keeps a finished manual import whose journal outlived its marker and refuses the move", async () => {
    const fixture = await createFixture();
    const { dataDir } = fixture;
    const importedEntries = ["attachments/project/a.txt", "app.db"];
    await writeFileWithDirs(join(dataDir, "app.db"), "imported database");
    await writeFileWithDirs(
      join(dataDir, "attachments", "project", "a.txt"),
      "imported attachment",
    );
    await writeFileWithDirs(
      join(dataDir, "server-import-journal.json"),
      JSON.stringify({
        version: 1,
        entries: importedEntries,
        preexistingEntries: [],
      }),
    );
    await writeServerImportFile(dataDir, {
      version: 1,
      kind: "manual",
      moveId: null,
      activationToken: null,
      sourceDataDir: "/Users/me/.omnyo",
      sourceServerHostId: "host-source",
      targetHostId: null,
      serverUrl: null,
      importedEntries,
      createdAt: 1,
      fixupsAppliedAt: null,
    });
    await writeServerConnectHoldFile(dataDir, {
      version: 1,
      reason: "manual-import",
      createdAt: 1,
    });

    const inspected = await fixture.service.inspect({
      type: "server_move.inspect",
      paths: [],
      port: 38_886,
    });

    expect(inspected.dataDirHasServerData).toBe(true);

    await expect(
      fixture.service.prepare(await prepareCommand(fixture)),
    ).rejects.toMatchObject({ code: "server_move_archive_server_data_exists" });

    expect(await readFile(join(dataDir, "app.db"), "utf8")).toBe(
      "imported database",
    );
    expect(
      await readFile(join(dataDir, "attachments", "project", "a.txt"), "utf8"),
    ).toBe("imported attachment");
    expect(await readServerImportFile(dataDir)).toMatchObject({
      kind: "manual",
      importedEntries,
    });
    expect(await readServerConnectHoldFile(dataDir)).not.toBeNull();
    expect(await exists(join(dataDir, "server-import-journal.json"))).toBe(
      false,
    );
    expect(fixture.launches).toEqual([]);
  });

  it("hides ~/.omnyo when it is this daemon's data dir and refuses to archive it", async () => {
    const fixture = await createFixture();
    await writeFile(join(fixture.dataDir, "app.db"), "old server");
    await symlink(fixture.dataDir, join(fixture.homeDir, ".omnyo"));

    const result = await fixture.service.inspect({
      type: "server_move.inspect",
      paths: [],
      port: 38_886,
    });

    expect(result.existingServerData).toBeNull();
    expect(result.dataDirHasServerData).toBe(true);

    const command = await prepareCommand(fixture, {
      archiveExistingServerData: true,
    });

    await expect(fixture.service.prepare(command)).rejects.toMatchObject({
      code: "server_move_rejected",
      message: "The target's own data directory cannot be archived",
    });
    expect(fixture.source.archiveRequests).toEqual([]);
    expect(await exists(join(fixture.dataDir, "server-move-incoming"))).toBe(
      false,
    );
    expect(
      (await readdir(fixture.homeDir)).filter((name) =>
        name.startsWith(".omnyo.before-move-"),
      ),
    ).toEqual([]);
    expect(await readFile(join(fixture.dataDir, "app.db"), "utf8")).toBe(
      "old server",
    );
  });
});

describe("ServerMoveService.deleteOldCopy", () => {
  it("deletes only the listed old server entries and keeps the lock", async () => {
    const fixture = await createFixture();
    const { dataDir } = fixture;

    for (const file of [
      "app.db",
      "app.db-wal",
      "attachments/project/a.txt",
      "plugins/tasks/data.db",
      "plugins/tasks/host-data/cache.json",
      "skills/review/SKILL.md",
      "host-id",
      "auth.json",
      "thread-storage/thread-1/notes.md",
      "config.json",
    ]) {
      await writeFileWithDirs(
        join(dataDir, ...file.split("/")),
        file === "config.json" ? "{}" : "content",
      );
    }

    const marker = {
      version: 1 as const,
      moveId: MOVE_ID,
      movedAt: 1_700_000_000_000,
      fromHostId: "host-source",
      toHostId: "host-target",
      toHostName: "studio",
      serverUrl: "https://studio.example.test",
      mode: "direct" as const,
      connectHandle: null,
      oldCopyEntries: ["app.db", "attachments", "plugins/tasks/data.db"],
    };

    await writeServerMovedFile(dataDir, marker);

    await expect(fixture.service.deleteOldCopy()).resolves.toEqual({
      deleted: true,
    });

    for (const removed of [
      "app.db",
      "app.db-wal",
      "attachments",
      "plugins/tasks/data.db",
    ]) {
      expect(await exists(join(dataDir, ...removed.split("/")))).toBe(false);
    }

    for (const kept of [
      "plugins/tasks/host-data/cache.json",
      "skills/review/SKILL.md",
      "host-id",
      "auth.json",
      "thread-storage/thread-1/notes.md",
      "config.json",
    ]) {
      expect(await exists(join(dataDir, ...kept.split("/")))).toBe(true);
    }

    expect(await readServerMovedFile(dataDir)).toEqual({
      ...marker,
      oldCopyEntries: [],
    });
    await expect(fixture.service.deleteOldCopy()).resolves.toEqual({
      deleted: true,
    });
  });

  it("reports nothing deleted when this data dir has no moved-server lock", async () => {
    const fixture = await createFixture();
    await writeFile(join(fixture.dataDir, "app.db"), "content");

    await expect(fixture.service.deleteOldCopy()).resolves.toEqual({
      deleted: false,
    });
    expect(await exists(join(fixture.dataDir, "app.db"))).toBe(true);
  });
});

describe("ServerMoveService.inspect and probe", () => {
  it("reports the target machine's server-move readiness", async () => {
    const fixture = await createFixture({
      env: {
        OMNYO_SERVER_MOVE_SERVICE_MANAGER: "none",
        OMNYO_APP_VERSION: "1.2.3",
      },
    });

    await writeFileWithDirs(join(fixture.homeDir, ".omnyo", "app.db"), "12345");
    await writeFileWithDirs(join(fixture.homeDir, ".codex", "auth.json"), "{}");
    await writeFileWithDirs(join(fixture.homeDir, "tools", "bin", "gh"), "");

    const result = await fixture.service.inspect({
      type: "server_move.inspect",
      paths: [
        fixture.dataDir,
        join(fixture.root, "missing"),
        "~",
        "~/tools/bin/gh",
        "~/tools/bin/missing",
        "~other/tools",
      ],
      port: 38_886,
    });

    expect(result).toEqual({
      dataDir: fixture.dataDir,
      platform: "linux",
      timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      coreVersion: "1.2.3",
      serverEntryAvailable: true,
      existingServerData: {
        path: join(fixture.homeDir, ".omnyo"),
        sizeBytes: 5,
      },
      dataDirHasServerData: false,
      portAvailable: true,
      ghAuthenticated: null,
      codexCredentialsPresent: true,
      pathsExist: {
        [fixture.dataDir]: true,
        [join(fixture.root, "missing")]: false,
        "~": true,
        "~/tools/bin/gh": true,
        "~/tools/bin/missing": false,
        "~other/tools": false,
      },
      diskFreeBytes: expect.any(Number),
    });
  });

  it("requires the new address to answer for this move and reports its state", async () => {
    const fixture = await createFixture();
    const health = { state: "pending" };

    const { url } = await listen((_request, response) => {
      response.setHeader("content-type", "application/json");
      response.end(
        JSON.stringify({
          ok: true,
          serverMove: { state: health.state, moveId: MOVE_ID },
        }),
      );
    });

    const closedPort = await freePort();

    await expect(
      fixture.service.probe({
        type: "server_move.probe",
        url,
        moveId: MOVE_ID,
      }),
    ).resolves.toEqual({ reachable: true, message: null, state: "pending" });
    health.state = "ready";
    await expect(
      fixture.service.probe({
        type: "server_move.probe",
        url,
        moveId: MOVE_ID,
      }),
    ).resolves.toEqual({ reachable: true, message: null, state: "ready" });
    await expect(
      fixture.service.probe({
        type: "server_move.probe",
        url,
        moveId: "other-move",
      }),
    ).resolves.toEqual({
      reachable: false,
      message: `${url} answered for a different server move`,
      state: null,
    });

    const unreachable = await fixture.service.probe({
      type: "server_move.probe",
      url: `http://127.0.0.1:${closedPort}`,
      moveId: MOVE_ID,
    });

    expect(unreachable.reachable).toBe(false);
    expect(unreachable.state).toBeNull();
    expect(unreachable.message).toContain(
      `Could not reach http://127.0.0.1:${closedPort}`,
    );
  });
});
