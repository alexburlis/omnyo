import { fork, spawn, execFile, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import { createRequire } from "node:module";
import { promisify } from "node:util";
import { join } from "node:path";
import { describe, expect, it, vi, afterEach } from "vitest";
import { z } from "zod";
import { getAppSettings } from "@omnyo/db";
import { createDeferredPromise } from "@omnyo/test-helpers";
import { maintenanceStatusSchema } from "@omnyo/server-contract";
import {
  createFixture,
  prepareCommand,
  registerServerMoveFixtureCleanup,
} from "../../../../apps/host-daemon/src/server-move/test-fixture.js";
import { CommandRouter } from "../../../../apps/host-daemon/src/command-router.js";
import {
  createHarness,
  createTestWorkspaceReads,
  noopEventSink,
  unexpectedProjectAttachmentFetch,
  unexpectedProviderMaintenance,
} from "../../../../apps/host-daemon/test/command/dispatch-helpers.js";
import {
  withTestHarness,
  type TestAppHarness,
} from "../../../../apps/server/test/helpers/test-app.js";
import {
  seedHost,
  seedPrimaryHost,
} from "../../../../apps/server/test/helpers/seed.js";
import {
  createTestServerMoveEnvironment,
  inspectResult,
  registerFakeDaemon,
} from "../../../../apps/server/test/helpers/server-move.js";
import { createServerMoveCoordinator } from "../../../../apps/server/src/services/server-move/coordinator.js";
import { isServerMoveFrozen } from "../../../../apps/server/src/services/server-move/freeze-state.js";
import {
  readIncomingMoveState,
  writeIncomingMoveState,
} from "../../../../apps/host-daemon/src/server-move/move-state.js";

const boundary = vi.hoisted(() => ({
  pausedWrite: "",
  entered: () => {},
  barrier: Promise.resolve(),
  syncPath: "",
  syncDirectory: false,
}));

// oxlint-disable-next-line anti-slop/no-module-mocking -- Inject only filesystem sync/persist failures through the production atomic writers.
vi.mock("node:fs/promises", async (original) => {
  const actual = await original<typeof import("node:fs/promises")>();

  const beforeWrite = async (path: Parameters<typeof actual.writeFile>[0]) => {
    if (boundary.pausedWrite && String(path).includes(boundary.pausedWrite)) {
      boundary.entered();
      await boundary.barrier;
    }
  };

  return {
    ...actual,
    default: actual,
    writeFile: async (...args: Parameters<typeof actual.writeFile>) => {
      await beforeWrite(args[0]);

      return actual.writeFile(...args);
    },
    open: async (...args: Parameters<typeof actual.open>) => {
      const handle = await actual.open(...args);
      const write = handle.writeFile.bind(handle);
      const sync = handle.sync.bind(handle);
      handle.writeFile = async (...writeArgs) => {
        await beforeWrite(args[0]);

        return write(...writeArgs);
      };

      handle.sync = async () => {
        const directory = (await handle.stat()).isDirectory();

        if (
          boundary.syncPath &&
          String(args[0]).includes(boundary.syncPath) &&
          directory === boundary.syncDirectory
        )
          throw new Error("RR1 injected sync failure");

        return sync();
      };

      return handle;
    },
  };
});

registerServerMoveFixtureCleanup();

afterEach(() => {
  boundary.pausedWrite = "";
  boundary.syncPath = "";
  boundary.barrier = Promise.resolve();
});

const require = createRequire(import.meta.url);

const HOST = "host-rr1-source";

const launchReceiptSchema = z
  .object({
    root: z.string(),
    homeDir: z.string(),
    dataDir: z.string(),
    daemonEntryPath: z.string(),
    pid: z.number().int().positive(),
    port: z.number().int().positive(),
  })
  .strict();

type LaunchReceipt = z.infer<typeof launchReceiptSchema>;

interface LaunchObservation {
  current: LaunchReceipt | null;
}

function alive(pid: number) {
  try {
    process.kill(pid, 0);

    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ESRCH")
      return false;
    throw error;
  }
}

async function stop(child: ChildProcess) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((resolve) => {
    child.once("exit", resolve);
    child.kill("SIGKILL");
  });
}

async function acquire(harness: TestAppHarness) {
  const status = maintenanceStatusSchema.parse(
    await (await harness.app.request("/api/v1/server/maintenance")).json(),
  );

  return harness.app.request("/api/v1/server/maintenance/acquire", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      id: "hold-rr1",
      ownerId: "owner-rr1",
      expectedRuntimeId: status.runtime.runtimeId,
      expectedServerHostId: HOST,
      expectedDataDir: status.runtime.dataDir,
    }),
  });
}

describe("RR1 runtime recovery through production owners", () => {
  it("keeps source frozen and imported bytes after actual daemon death between detached launch and PID persistence", async () => {
    const fixture = await createFixture();
    const entry = join(fixture.root, "crash-window.mjs");

    const fixtureUrl = new URL(
      "../../../../apps/host-daemon/src/server-move/test-fixture.ts",
      import.meta.url,
    ).href;

    await fs.writeFile(
      entry,
      `import {createFixture,prepareCommand} from ${JSON.stringify(fixtureUrl)}; const f=await createFixture(); const s=f.createService({launchPendingServer:async request=>{const pid=await f.options.launchPendingServer(request); process.send({root:f.root,homeDir:f.homeDir,dataDir:f.dataDir,daemonEntryPath:f.options.daemonEntryPath,pid,port:request.serverPort}); return new Promise(()=>{});}}); await s.prepare(await prepareCommand(f,{moveId:process.argv[2],activationToken:process.argv[3]}));`,
    );
    await withTestHarness(
      { seedFirstPartyProviders: false },
      async (harness) => {
        seedHost(harness.deps, { id: HOST });
        seedPrimaryHost(harness.deps, HOST);
        seedHost(harness.deps, { id: "host-target" });
        const bytes = Buffer.from("inert RR1 package transport");
        const file = join(harness.config.dataDir, "rr1-package.tgz");
        await fs.writeFile(file, bytes);

        const { environment } = createTestServerMoveEnvironment(harness, {
          fullArtifact: {
            availability: async () => ({
              available: true,
              unpackedSizeBytes: bytes.length,
              version: harness.config.appVersion,
            }),
            build: async () => ({
              path: file,
              sizeBytes: bytes.length,
              version: harness.config.appVersion,
              sha256: createHash("sha256").update(bytes).digest("hex"),
              runtimeSha256: "0".repeat(64),
            }),
          },
        });

        const coordinator = createServerMoveCoordinator(environment);
        const preparing = createDeferredPromise<void>();
        const releasePrepare = createDeferredPromise<void>();
        let daemon: ChildProcess | null = null;

        const launch: LaunchObservation = { current: null };

        let database: Buffer | null = null;
        registerFakeDaemon(harness, {
          hostId: "host-target",
          events: [],
          handle: async (message) => {
            if (message.command.type === "server_move.inspect")
              return {
                ok: true,
                result: inspectResult({
                  coreVersion: harness.config.appVersion,
                }),
              };

            if (message.command.type === "server_move.prepare") {
              daemon = fork(
                entry,
                [message.command.moveId, message.command.activationToken],
                {
                  execArgv: [
                    "--conditions=source",
                    "--import",
                    require.resolve("tsx"),
                  ],
                  env: { PATH: process.env.PATH },
                  stdio: ["ignore", "ignore", "ignore", "ipc"],
                },
              );
              const child = daemon;

              const launched = await new Promise<
                z.infer<typeof launchReceiptSchema>
              >((resolve, reject) => {
                child.once("error", reject);
                child.once("exit", () =>
                  reject(new Error("Crash fixture exited before launch")),
                );
                child.once("message", (message) => {
                  try {
                    resolve(launchReceiptSchema.parse(message));
                  } catch (error) {
                    reject(error);
                  }
                });
              });

              launch.current = launched;
              await stop(child);

              if (launched === null) throw new Error("Missing detached launch");
              expect(alive(launched.pid)).toBe(true);
              expect(
                (
                  await readIncomingMoveState(
                    launched.dataDir,
                    message.command.moveId,
                  )
                )?.pendingServer,
              ).toBeNull();
              database = await fs.readFile(join(launched.dataDir, "app.db"));
              preparing.resolve();
              await releasePrepare.promise;
              throw new Error("Inert daemon died");
            }

            if (message.command.type === "server_move.abort") {
              const launched = launch.current;

              if (launched === null) throw new Error("Missing detached launch");

              const restarted = fixture.createService({
                dataDir: launched.dataDir,
                homeDir: launched.homeDir,
                daemonEntryPath: launched.daemonEntryPath,
              });

              return {
                ok: true,
                result: await restarted.abort(message.command),
              };
            }

            if (message.command.type === "server_move.probe")
              return {
                ok: true,
                result: {
                  reachable: false,
                  state: null,
                  message: "Inert uncertain owner",
                },
              };
            throw new Error("Unexpected RR1 command");
          },
        });

        try {
          await coordinator.start({
            targetHostId: "host-target",
            serverUrl: "https://rr1.example.test",
            stopRunningWork: true,
            archiveExistingTargetServerData: false,
          });
          await preparing.promise;
          await coordinator.cancel();
          await expect
            .poll(() => coordinator.getStatus()?.state)
            .toBe("recovery_required");
          expect(isServerMoveFrozen(harness.db)).toBe(true);
          const process = launch.current;

          if (process === null)
            throw new Error("Missing owned detached server");
          expect(alive(process.pid)).toBe(true);
          expect(await fs.readFile(join(process.dataDir, "app.db"))).toEqual(
            database,
          );
          expect(
            await readIncomingMoveState(
              process.dataDir,
              coordinator.getStatus()!.moveId,
            ),
          ).not.toBeNull();
        } finally {
          releasePrepare.resolve();
          coordinator.dispose();

          if (daemon !== null) await stop(daemon);
          const process = launch.current;

          if (process !== null) {
            if (alive(process.pid))
              globalThis.process.kill(-process.pid, "SIGKILL");
            await expect.poll(() => alive(process.pid)).toBe(false);
            await fs.rm(process.root, { recursive: true, force: true });
          }
        }
      },
    );
  });

  it("refuses a real sentinel substituted for the persisted pending PID after restart", async () => {
    const fixture = await createFixture();
    const command = await prepareCommand(fixture);
    const pending = await fixture.service.prepare(command);

    const sentinel = spawn(
      process.execPath,
      ["-e", "setInterval(()=>{},1000)"],
      { detached: true, env: { PATH: process.env.PATH }, stdio: "ignore" },
    );

    await new Promise<void>((resolve, reject) => {
      sentinel.once("spawn", resolve);
      sentinel.once("error", reject);
    });

    try {
      const state = await readIncomingMoveState(
        fixture.dataDir,
        command.moveId,
      );

      if (
        state === null ||
        state.pendingServer === null ||
        sentinel.pid === undefined
      )
        throw new Error("Missing owned fixture process");
      await writeIncomingMoveState(fixture.dataDir, {
        ...state,
        pendingServer: { ...state.pendingServer, pid: sentinel.pid },
      });
      await expect(
        fixture
          .createService()
          .abort({ type: "server_move.abort", moveId: command.moveId }),
      ).rejects.toThrow(/identity|ownership/u);
      expect(alive(sentinel.pid)).toBe(true);
      expect(alive(pending.pid)).toBe(true);
      expect(await fs.readFile(join(fixture.dataDir, "app.db"), "utf8")).toBe(
        "sqlite database bytes",
      );
    } finally {
      await stop(sentinel);
    }
  });

  it.each([false, true])(
    "refuses update admission while a real write survives RPC timeout (disconnect=%s)",
    async (disconnect) => {
      const fixture = await createFixture();
      const runtime = createHarness();

      const router = new CommandRouter({
        dataDir: fixture.dataDir,
        runtimeManager: runtime.manager,
        workspaceReads: createTestWorkspaceReads(runtime.manager),
        eventSink: noopEventSink,
        fetchProjectAttachment: unexpectedProjectAttachmentFetch,
        ...unexpectedProviderMaintenance,
        threadStorageRootPath: join(fixture.root, "threads"),
        logger: { debug() {}, warn() {} },
      });

      const target = join(fixture.root, "slow-write.txt");
      await promisify(execFile)("mkfifo", [target]);
      const completed = createDeferredPromise<void>();
      await withTestHarness(
        { seedFirstPartyProviders: false },
        async (harness) => {
          seedHost(harness.deps, { id: HOST });
          seedPrimaryHost(harness.deps, HOST);

          const daemon = registerFakeDaemon(harness, {
            hostId: HOST,
            events: [],
            handle: async (message) => {
              const response = await router.handleOnlineRpcRequest(message);
              completed.resolve();

              return response;
            },
          });

          const result = harness.hub
            .requestHostOnlineRpc({
              hostId: HOST,
              timeoutMs: 30,
              message: {
                type: "host-rpc.request",
                requestId: "rr1-slow-write",
                command: {
                  type: "host.write_file",
                  path: target,
                  content: "completed bytes",
                  contentEncoding: "utf8",
                  createParents: false,
                },
              },
            })
            .catch(() => "timed-out");

          try {
            expect(await result).toBe("timed-out");
            expect(router.getDirectAccessActivityCount()).toBe(1);

            if (disconnect) harness.hub.unregisterDaemon(daemon.sessionId);
            const denied = await acquire(harness);
            expect([409, 503]).toContain(denied.status);
            const input = await fs.open(target, "w");
            await input.writeFile("prior bytes");
            await input.close();
            expect(await fs.readFile(target, "utf8")).toBe("completed bytes");
            await completed.promise;
            await expect
              .poll(() => router.getDirectAccessActivityCount())
              .toBe(0);

            if (!disconnect) {
              await expect
                .poll(() => harness.hub.countPendingHostRpcs())
                .toBe(0);
              expect((await acquire(harness)).status).toBe(200);
            } else expect((await acquire(harness)).status).toBe(409);
          } finally {
            if (router.getDirectAccessActivityCount() > 0) {
              const input = await fs.open(target, "w");
              await input.writeFile("prior bytes");
              await input.close();
              await fs.readFile(target, "utf8");
              await completed.promise;
            }
          }
        },
      );
    },
  );

  it.each(["file", "directory"] as const)(
    "issues no hold acknowledgement on %s sync failure",
    async (mode) => {
      await withTestHarness(
        { seedFirstPartyProviders: false },
        async (harness) => {
          seedHost(harness.deps, { id: HOST });
          seedPrimaryHost(harness.deps, HOST);
          boundary.syncDirectory = mode === "directory";
          boundary.syncPath =
            mode === "directory"
              ? harness.config.dataDir
              : "server-maintenance-hold.json";
          const response = await acquire(harness);
          expect(response.status).not.toBe(200);

          const status = maintenanceStatusSchema.parse(
            await (
              await harness.app.request("/api/v1/server/maintenance")
            ).json(),
          );

          expect(status.hold?.phase).not.toBe("held");

          if (mode === "directory")
            expect(isServerMoveFrozen(harness.db)).toBe(true);
        },
      );
    },
  );

  it.each(["file", "directory"] as const)(
    "issues no positive fence acknowledgement on %s sync failure",
    async (mode) => {
      const fixture = await createFixture();
      const command = await prepareCommand(fixture);
      boundary.syncDirectory = mode === "directory";
      boundary.syncPath = "server-move-fences";
      await expect(
        fixture.service.abort({
          type: "server_move.abort",
          moveId: command.moveId,
        }),
      ).rejects.toThrow(/sync failure/u);
      boundary.syncPath = "";
      await expect(
        fixture.service.abort({
          type: "server_move.abort",
          moveId: command.moveId,
        }),
      ).resolves.toMatchObject({ fenced: true });
    },
  );

  it("rejects actual settings mutation while first hold persistence is paused", async () => {
    await withTestHarness(
      { seedFirstPartyProviders: false },
      async (harness) => {
        seedHost(harness.deps, { id: HOST });
        seedPrimaryHost(harness.deps, HOST);
        const before = getAppSettings(harness.db);
        const entered = createDeferredPromise<void>();
        const release = createDeferredPromise<void>();
        boundary.pausedWrite = "server-maintenance-hold.json";
        boundary.entered = entered.resolve;
        boundary.barrier = release.promise;
        const acquiring = acquire(harness);

        try {
          await entered.promise;

          const response = await harness.app.request(
            "/api/v1/settings/general",
            {
              method: "PUT",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({
                ...before,
                showKeyboardHints: !before.showKeyboardHints,
              }),
            },
          );

          expect(response.status).toBe(503);
          expect(getAppSettings(harness.db)).toEqual(before);
        } finally {
          boundary.pausedWrite = "";
          release.resolve();
          expect((await acquiring).status).toBe(200);
        }
      },
    );
  });
});
