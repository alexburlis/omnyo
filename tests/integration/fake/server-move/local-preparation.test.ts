import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  getAppSettings,
  getHost,
  getThread,
  hosts,
  setAppSettings,
} from "@omnyo/db";
import { createDeferredPromise } from "@omnyo/test-helpers";
import { eq } from "drizzle-orm";
import { createServerMoveCoordinator } from "../../../../apps/server/src/services/server-move/coordinator.js";
import { serverAccess } from "../../../../apps/server/src/services/machines/server-access.js";
import { setServerAccessBridge } from "../../../../apps/server/src/services/plugins/plugin-server-access-registry.js";
import {
  createTestServerMoveEnvironment,
  inspectResult,
  registerFakeDaemon,
} from "../../../../apps/server/test/helpers/server-move.js";
import {
  seedHost,
  seedPrimaryHost,
  seedThreadFixture,
} from "../../../../apps/server/test/helpers/seed.js";
import {
  startTestServer,
  withTestHarness,
} from "../../../../apps/server/test/helpers/test-app.js";
import {
  activateCommand,
  createFixture,
  prepareCommand,
  registerServerMoveFixtureCleanup,
} from "../../../../apps/host-daemon/src/server-move/test-fixture.js";

import { readJsonIfPresent } from "./preparation-fixture.js";
import { connectIssuedWorker } from "./access-fixture.js";
import { callHostOnlineRpcForWork } from "../../../../apps/server/src/services/hosts/online-rpc.js";

const SOURCE = "host-inert-source";

const TARGET = "host-inert-target";

const WORKER = "host-inert-worker";

const MOVE_URL = "https://inert.example.test";

registerServerMoveFixtureCleanup();

describe("local migration preparation through production owners", () => {
  it("proves the direct route before retiring a grant and keeps identity through repair", async () => {
    const server = await startTestServer({ seedFirstPartyProviders: false });
    const releases: string[] = [];

    try {
      seedHost(server.deps, { id: SOURCE, name: "Inert authority" });
      seedPrimaryHost(server.deps, SOURCE);
      seedHost(server.deps, { id: WORKER, name: "Inert worker" });
      server.db
        .update(hosts)
        .set({
          serverAccessProviderId: "inert-relay",
          serverAccessGrantId: "old-inert-grant",
        })
        .where(eq(hosts.id, WORKER))
        .run();
      setAppSettings(server.db, {
        ...getAppSettings(server.db),
        machineServerUrl: server.baseUrl,
        defaultMachineAccess: "direct",
      });
      setServerAccessBridge({
        list: () => [
          {
            pluginId: "inert-access-owner",
            provider: {
              id: "inert-relay",
              displayName: "Inert relay",
              description: "Fixture only",
              availability: async () => ({ status: "available" }),
              acquire: async () => ({
                id: "old-inert-grant",
                serverUrl: MOVE_URL,
              }),
              release: async ({ grantId }) => {
                releases.push(grantId ?? "none");
              },
            },
          },
        ],
        invoke: async (_id, run) => run(),
      });
      const before = getHost(server.db, WORKER);
      const issued = await connectIssuedWorker(server, WORKER);

      try {
        const response = await fetch(
          `${server.baseUrl}/api/v1/hosts/${WORKER}/direct-access`,
          { method: "POST" },
        );

        expect(response.status).toBe(200);
        expect(await response.json()).toMatchObject({
          hostId: WORKER,
          providerId: "direct",
          retirementPending: false,
        });
        const after = getHost(server.db, WORKER);
        expect(after).toMatchObject({
          id: before?.id,
          maxPermissionMode: before?.maxPermissionMode,
          name: before?.name,
          serverAccessProviderId: "direct",
          serverAccessGrantId: WORKER,
        });
        expect(releases).toEqual(["old-inert-grant"]);
        expect(issued.events).toContain("direct-http-ws-proved");
        expect(issued.events).toContain("config-persisted");
        expect(issued.sessionId()).not.toBe(issued.firstSessionId);

        const repaired = await serverAccess.repair(server.deps, {
          key: WORKER,
          hostId: WORKER,
          signal: AbortSignal.timeout(2_000),
        });

        expect(repaired).toEqual({ id: WORKER, serverUrl: server.baseUrl });
      } finally {
        await issued.stop();
      }
    } finally {
      setServerAccessBridge(undefined);
      await server.close();
    }
  });

  it("transfers exact artifact bytes when version labels are equal", async () => {
    await withTestHarness(
      { seedFirstPartyProviders: false },
      async (harness) => {
        seedHost(harness.deps, { id: SOURCE, name: "Inert source" });
        seedPrimaryHost(harness.deps, SOURCE);
        seedHost(harness.deps, { id: TARGET, name: "Inert target" });
        const artifactPath = join(harness.config.dataDir, "private-inert.tgz");

        const bytes = Buffer.from(
          "different private build with the same label",
        );

        await writeFile(artifactPath, bytes);
        const digest = createHash("sha256").update(bytes).digest("hex");
        const transfer = createDeferredPromise<string | null>();

        const { environment } = createTestServerMoveEnvironment(harness, {
          fullArtifact: {
            availability: async () => ({
              available: true,
              unpackedSizeBytes: 100,
              version: harness.config.appVersion,
            }),
            build: async () => ({
              path: artifactPath,
              version: harness.config.appVersion,
              sizeBytes: bytes.length,
              sha256: digest,
              runtimeSha256: "e".repeat(64),
            }),
          },
        });

        const coordinator = createServerMoveCoordinator(environment);
        registerFakeDaemon(harness, {
          hostId: TARGET,
          events: [],
          handle: async ({ command }) => {
            if (command.type === "server_move.inspect")
              return {
                ok: true,
                result: inspectResult({
                  coreVersion: harness.config.appVersion,
                  serverEntryAvailable: true,
                }),
              };

            if (command.type === "server_move.prepare") {
              transfer.resolve(command.appRuntime?.sha256 ?? null);
              throw new Error("End inert transfer observation");
            }

            if (command.type === "server_move.abort")
              return {
                ok: true,
                result: { ok: true, moveId: command.moveId, fenced: true },
              };
            throw new Error(`Unexpected inert target command ${command.type}`);
          },
        });

        try {
          await coordinator.start({
            targetHostId: TARGET,
            serverUrl: MOVE_URL,
            stopRunningWork: true,
            archiveExistingTargetServerData: false,
          });
          expect(await transfer.promise).toBe(digest);
        } finally {
          await expect
            .poll(() => coordinator.getStatus()?.state)
            .toMatch(/failed|recovery_required/u);
          coordinator.dispose();
        }
      },
    );
  });

  it("retains a durable target work hold through production activation and restart", async () => {
    const fixture = await createFixture();
    await fixture.service.prepare(await prepareCommand(fixture));
    await fixture.service.activate(activateCommand);
    await expect.poll(() => fixture.shutdownRequests.length).toBe(1);

    const held = await readJsonIfPresent(
      join(fixture.dataDir, "server-maintenance-hold.json"),
    );

    expect(held).toMatchObject({
      id: activateCommand.moveId,
      phase: "held",
      kind: "migration",
    });
    const restarted = fixture.createService();
    await restarted.resumeActivation();
    expect(
      await readJsonIfPresent(
        join(fixture.dataDir, "server-maintenance-hold.json"),
      ),
    ).toEqual(held);
  });

  it.each(["busy", "authoritative"] as const)(
    "refuses %s conversion without terminating work or changing the grant",
    async (kind) => {
      const server = await startTestServer({ seedFirstPartyProviders: false });
      const events: string[] = [];

      try {
        const seeded = seedThreadFixture(server, {
          session: { id: WORKER },
          thread: { status: kind === "busy" ? "active" : "idle" },
        });

        seedHost(server.deps, { id: SOURCE });
        seedPrimaryHost(
          server.deps,
          kind === "authoritative" ? WORKER : SOURCE,
        );
        server.db
          .update(hosts)
          .set({
            serverAccessProviderId: "inert-relay",
            serverAccessGrantId: "retained-inert-grant",
          })
          .where(eq(hosts.id, WORKER))
          .run();
        setAppSettings(server.db, {
          ...getAppSettings(server.db),
          machineServerUrl: server.baseUrl,
        });
        const before = getHost(server.db, WORKER);

        const daemon = registerFakeDaemon(server, {
          hostId: WORKER,
          events,
          handle: async () => {
            throw new Error("Busy/authority must refuse before worker RPC");
          },
        });

        const response = await fetch(
          `${server.baseUrl}/api/v1/hosts/${WORKER}/direct-access`,
          { method: "POST" },
        );

        expect(response.status).toBe(409);
        expect(getHost(server.db, WORKER)).toEqual(before);
        expect(getThread(server.db, seeded.thread.id)?.status).toBe(
          kind === "busy" ? "active" : "idle",
        );
        expect(daemon.requests).toEqual([]);
        expect(daemon.movedMessages).toEqual([]);
        expect(events).toEqual([]);
      } finally {
        await server.close();
      }
    },
  );

  it("closes late work admission through the direct primary handoff", async () => {
    const server = await startTestServer({ seedFirstPartyProviders: false });
    let issued: Awaited<ReturnType<typeof connectIssuedWorker>> | undefined;
    const barrier = createDeferredPromise<void>();

    try {
      seedHost(server.deps, { id: SOURCE });
      seedPrimaryHost(server.deps, SOURCE);
      seedHost(server.deps, { id: WORKER });
      setAppSettings(server.db, {
        ...getAppSettings(server.db),
        machineServerUrl: server.baseUrl,
      });
      issued = await connectIssuedWorker(server, WORKER);
      issued.pauseProbe(barrier.promise);

      const conversion = fetch(
        `${server.baseUrl}/api/v1/hosts/${WORKER}/direct-access`,
        { method: "POST" },
      );

      const reached = await Promise.race([
        issued.probeEntered.then(() => true),
        conversion.then(() => false),
      ]);

      expect(reached).toBe(true);
      await expect(
        callHostOnlineRpcForWork(server.deps, {
          hostId: WORKER,
          timeoutMs: 500,
          command: {
            type: "host.write_file",
            contentEncoding: "utf8",
            createParents: false,
            path: join(issued.fixture.dataDir, "late-work.txt"),
            content: "must not dispatch",
          },
        }),
      ).rejects.toThrow(/handoff|conversion|admission|maintenance/u);
      expect(
        await readJsonIfPresent(join(issued.fixture.dataDir, "late-work.txt")),
      ).toBeNull();
      barrier.resolve();
      expect((await conversion).status).toBe(200);
      expect(issued.sessionId()).not.toBe(issued.firstSessionId);
    } finally {
      barrier.resolve();
      await issued?.stop();
      await server.close();
    }
  });
});
