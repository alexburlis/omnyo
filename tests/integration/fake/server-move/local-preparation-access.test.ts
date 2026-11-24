import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import {
  createConnection,
  getAppSettings,
  getHost,
  hostDaemonSessions,
  hosts,
  setAppSettings,
} from "@omnyo/db";
import { HOST_DAEMON_PROTOCOL_VERSION } from "@omnyo/host-daemon-contract";
import {
  freePort,
  registerServerMoveFixtureCleanup,
} from "../../../../apps/host-daemon/src/server-move/test-fixture.js";
import {
  seedHost,
  seedHostSession,
  seedPrimaryHost,
} from "../../../../apps/server/test/helpers/seed.js";
import {
  startTestServer,
  withTestHarness,
} from "../../../../apps/server/test/helpers/test-app.js";
import { registerFakeDaemon } from "../../../../apps/server/test/helpers/server-move.js";
import { connectIssuedWorker } from "./access-fixture.js";
import {
  disableBundledOwners,
  launchOwnedServer,
  writeInertPlugin,
  type OwnedServerProcess,
} from "./preparation-fixture.js";

registerServerMoveFixtureCleanup();

const SOURCE = "host-inert-access-source",
  WORKER = "host-inert-access-worker";

async function setup(server: Awaited<ReturnType<typeof startTestServer>>) {
  seedHost(server.deps, { id: SOURCE });
  seedPrimaryHost(server.deps, SOURCE);
  seedHost(server.deps, { id: WORKER, name: "Retained inert identity" });
  server.db
    .update(hosts)
    .set({
      serverAccessProviderId: "inert-relay",
      serverAccessGrantId: "old-owned-grant",
    })
    .where(eq(hosts.id, WORKER))
    .run();
  setAppSettings(server.db, {
    ...getAppSettings(server.db),
    machineServerUrl: server.baseUrl,
  });
}

describe("same-ID authentication and durable retirement", () => {
  it.each(["machine", "old-protocol", "unobserved-proof"])(
    "refuses %s without committing or releasing a persisted grant",
    async (kind) => {
      const server = await startTestServer({ seedFirstPartyProviders: false });

      try {
        await setup(server);
        const session = seedHostSession(server.deps, { id: WORKER }).session;

        if (kind === "old-protocol")
          server.db
            .update(hostDaemonSessions)
            .set({ protocolVersion: HOST_DAEMON_PROTOCOL_VERSION - 1 })
            .where(eq(hostDaemonSessions.id, session.id))
            .run();
        const before = getHost(server.db, WORKER);

        const daemon = registerFakeDaemon(server, {
          hostId: WORKER,
          events: [],
          handle: async () => ({ ok: true, result: { ok: true } }),
        });

        const headers: Record<string, string> = {};

        if (kind === "machine")
          headers.authorization = `Bearer ${await server.deps.machineAuth.issueDaemonHostKey({ hostId: WORKER })}`;

        const response = await fetch(
          `${server.baseUrl}/api/v1/hosts/${WORKER}/direct-access`,
          { method: "POST", headers },
        );

        expect(response.status).toBe(kind === "machine" ? 403 : 409);
        expect(getHost(server.db, WORKER)).toEqual(before);
        expect(daemon.movedMessages).toEqual([]);
      } finally {
        await server.close();
      }
    },
  );

  it("rejects a route to another real server despite a valid credential on the original primary", async () => {
    const server = await startTestServer({ seedFirstPartyProviders: false });
    const other = await startTestServer({ seedFirstPartyProviders: false });
    let worker: Awaited<ReturnType<typeof connectIssuedWorker>> | undefined;

    try {
      await setup(server);
      worker = await connectIssuedWorker(server, WORKER);
      setAppSettings(server.db, {
        ...getAppSettings(server.db),
        machineServerUrl: other.baseUrl,
      });
      const before = getHost(server.db, WORKER);

      const response = await fetch(
        `${server.baseUrl}/api/v1/hosts/${WORKER}/direct-access`,
        { method: "POST" },
      );

      expect(response.status).toBe(409);
      expect(getHost(server.db, WORKER)).toEqual(before);
      expect(worker.events).not.toContain("moved-handler");
    } finally {
      await worker?.stop();
      await other.close();
      await server.close();
    }
  });

  it("persists failed retirement across actual server restart and retires only after fresh primary proof", async () => {
    await withTestHarness(
      { seedFirstPartyProviders: false },
      async (harness) => {
        await disableBundledOwners(harness);
        seedHost(harness.deps, { id: SOURCE });
        seedPrimaryHost(harness.deps, SOURCE);
        seedHost(harness.deps, { id: WORKER, name: "Retained inert identity" });
        harness.db
          .update(hosts)
          .set({
            serverAccessProviderId: "inert-relay",
            serverAccessGrantId: "old-owned-grant",
          })
          .where(eq(hosts.id, WORKER))
          .run();
        const before = getHost(harness.db, WORKER);
        const port = await freePort();
        const baseUrl = `http://127.0.0.1:${port}`;
        setAppSettings(harness.db, {
          ...getAppSettings(harness.db),
          machineServerUrl: baseUrl,
        });

        const releases = join(harness.config.dataDir, "grant-releases.txt"),
          allowRelease = join(harness.config.dataDir, "grant-release-allowed"),
          loaded = join(harness.config.dataDir, "grant-owner-loaded.txt");

        const root = await writeInertPlugin(
          harness.config.dataDir,
          "inert-access-owner",
          `import {existsSync,appendFileSync} from 'node:fs'; export default function plugin(api) { appendFileSync(${JSON.stringify(loaded)}, 'loaded\\n'); api.experimental_serverAccess.register({ id:'inert-relay', displayName:'Owned inert relay',description:'No external provider',availability:async()=>({status:'available'}),acquire:async()=>({id:'old-owned-grant',serverUrl:${JSON.stringify(baseUrl)}}),release:async({grantId})=>{ if(!existsSync(${JSON.stringify(allowRelease)})) throw new Error('Inert release transport failure'); appendFileSync(${JSON.stringify(releases)},grantId+'\\n'); } }); }`,
        );

        await harness.pluginService.installPath(root);
        await harness.pluginService.stop();

        const key = await harness.deps.machineAuth.issueDaemonHostKey({
          hostId: WORKER,
        });

        await writeFile(
          join(harness.config.dataDir, "app.db"),
          harness.db.$client.serialize(),
        );
        let child: OwnedServerProcess | undefined;
        let worker: Awaited<ReturnType<typeof connectIssuedWorker>> | undefined;

        const inspect = () => {
          const db = createConnection(join(harness.config.dataDir, "app.db"));

          try {
            return getHost(db, WORKER);
          } finally {
            db.$client.close();
          }
        };

        try {
          child = await launchOwnedServer({
            dataDir: harness.config.dataDir,
            port,
          });
          await expect
            .poll(
              async () =>
                (await readFile(loaded, "utf8")).split("\n").filter(Boolean)
                  .length,
            )
            .toBe(2);
          worker = await connectIssuedWorker(
            { deps: harness.deps, baseUrl },
            WORKER,
            key,
          );

          const first = await fetch(
            `${baseUrl}/api/v1/hosts/${WORKER}/direct-access`,
            { method: "POST" },
          );

          expect(first.status).toBe(200);
          expect(await first.json()).toMatchObject({
            hostId: WORKER,
            providerId: "direct",
            retirementPending: true,
          });
          expect(inspect()).toMatchObject({
            id: before?.id,
            name: before?.name,
            maxPermissionMode: before?.maxPermissionMode,
            serverAccessProviderId: "direct",
            serverAccessGrantId: WORKER,
          });
          await worker.stop();
          worker = undefined;
          await child.stop();
          child = undefined;
          await writeFile(allowRelease, "allowed");
          child = await launchOwnedServer({
            dataDir: harness.config.dataDir,
            port,
          });
          await expect
            .poll(
              async () =>
                (await readFile(loaded, "utf8")).split("\n").filter(Boolean)
                  .length,
            )
            .toBe(3);
          await expect(readFile(releases, "utf8")).rejects.toMatchObject({
            code: "ENOENT",
          });
          worker = await connectIssuedWorker(
            { deps: harness.deps, baseUrl },
            WORKER,
            key,
          );

          const retry = await fetch(
            `${baseUrl}/api/v1/hosts/${WORKER}/direct-access`,
            { method: "POST" },
          );

          expect(retry.status).toBe(200);
          expect(await retry.json()).toMatchObject({
            retirementPending: false,
          });
          expect(await readFile(releases, "utf8")).toBe("old-owned-grant\n");
          expect(worker.events).toContain("current-primary-http-ws-proved");
          expect(worker.events).not.toContain("restart-requested");
          expect(worker.events).not.toContain("config-persisted");
          expect(worker.sessionId()).toBe(worker.firstSessionId);
          expect(inspect()).toMatchObject({
            id: before?.id,
            name: before?.name,
            maxPermissionMode: before?.maxPermissionMode,
            serverAccessProviderId: "direct",
            serverAccessGrantId: WORKER,
          });
        } finally {
          await worker?.stop();
          await child?.stop();
        }
      },
    );
  });
});
