import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  createConnection,
  getInstalledPlugin,
  getPluginKvValue,
  listPluginSchedules,
  setPluginKvValue,
} from "@omnyo/db";
import { HOST_DAEMON_PROTOCOL_VERSION } from "@omnyo/host-daemon-contract";
import {
  startTestServer,
  withTestHarness,
  type RunningTestServer,
  type TestAppHarness,
} from "../../../../apps/server/test/helpers/test-app.js";
import {
  seedHost,
  seedPrimaryHost,
  seedThreadFixture,
} from "../../../../apps/server/test/helpers/seed.js";
import { freePort } from "../../../../apps/host-daemon/src/server-move/test-fixture.js";
import {
  disableBundledOwners,
  launchOwnedServer,
  readJsonIfPresent,
  writeInertPlugin,
  type OwnedServerProcess,
} from "./preparation-fixture.js";

import { setServerMoveFrozen } from "../../../../apps/server/src/services/server-move/freeze-state.js";

const HOST = "host-inert-maintenance";

const ID = "hold-inert-update";

const OWNER = "desktop-inert-owner";

const runtimeSchema = z.object({
  runtimeId: z.string(),
  processId: z.number(),
  parentProcessId: z.number(),
  launchId: z.string().nullable(),
  dataDir: z.string(),
  serverHostId: z.string(),
  appVersion: z.string(),
  protocolVersion: z.number(),
});

const statusSchema = z.object({
  contractVersion: z.literal(1),
  runtime: runtimeSchema,
  hold: z.record(z.string(), z.unknown()).nullable(),
  activity: z.record(z.string(), z.number()),
});

async function status(baseUrl: string) {
  const response = await fetch(`${baseUrl}/api/v1/server/maintenance`);
  expect(response.status).toBe(200);

  return statusSchema.parse(await response.json());
}

async function waitForPluginStartup(baseUrl: string) {
  const response = await fetch(`${baseUrl}/api/v1/system/providers/catalog`, {
    signal: AbortSignal.timeout(30_000),
  });

  expect(response.status).toBe(200);
  await response.arrayBuffer();
}

async function acquire(
  baseUrl: string,
  runtime: z.infer<typeof runtimeSchema>,
) {
  return fetch(`${baseUrl}/api/v1/server/maintenance/acquire`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      id: ID,
      ownerId: OWNER,
      expectedRuntimeId: runtime.runtimeId,
      expectedServerHostId: HOST,
      expectedDataDir: runtime.dataDir,
    }),
  });
}

async function close(server: RunningTestServer) {
  await server.pluginService.stop();
  await server.close();
}

async function authority(server: RunningTestServer) {
  seedHost(server.deps, { id: HOST });
  seedPrimaryHost(server.deps, HOST);
}

function serviceSource(trace: string) {
  return `import {appendFileSync} from 'node:fs'; export default function plugin(api) { appendFileSync(${JSON.stringify(trace)}, 'factory\\n'); api.background.service('owned', { start(signal) { appendFileSync(${JSON.stringify(trace)}, 'service\\n'); return new Promise(resolve => signal.addEventListener('abort', resolve, {once:true})); } }); api.background.schedule('cadence', '0 0 * * *', () => appendFileSync(${JSON.stringify(trace)}, 'schedule\\n')); }`;
}

async function saveFreshStore(harness: TestAppHarness) {
  await writeFile(
    join(harness.config.dataDir, "app.db"),
    harness.db.$client.serialize(),
  );
}

async function traceLines(path: string) {
  try {
    return (await readFile(path, "utf8")).split("\n").filter(Boolean);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT")
      return [];
    throw error;
  }
}

describe("durable maintenance and framework-owned admission", () => {
  it.each(["acquiring", "held", "releasing"])(
    "boots and restarts %s without firing copied owners or altering their state",
    async (phase) => {
      await withTestHarness(
        { seedFirstPartyProviders: false },
        async (harness) => {
          await disableBundledOwners(harness);
          seedHost(harness.deps, { id: HOST });
          seedPrimaryHost(harness.deps, HOST);
          const trace = join(harness.config.dataDir, "owner-trace.txt");

          const root = await writeInertPlugin(
            harness.config.dataDir,
            "state-owner",
            serviceSource(trace),
          );

          await harness.pluginService.installPath(root);

          const intent = {
            body: "inert loop body",
            owner: "inert owner",
            enabled: true,
            cadence: "daily",
            offset: 7,
          };

          setPluginKvValue(
            harness.db,
            "state-owner",
            "loop",
            JSON.stringify(intent),
          );
          const beforePlugin = getInstalledPlugin(harness.db, "state-owner");
          const beforeSchedule = listPluginSchedules(harness.db, "state-owner");
          await harness.pluginService.stop();
          await writeFile(trace, "");
          await saveFreshStore(harness);
          await writeFile(
            join(harness.config.dataDir, "server-maintenance-hold.json"),
            JSON.stringify({
              version: 1,
              id: ID,
              ownerId: OWNER,
              kind: "desktop-update",
              phase,
              serverHostId: HOST,
              createdAt: Date.now(),
              artifact: null,
            }),
          );
          let child: OwnedServerProcess | undefined;

          try {
            for (let boot = 0; boot < 2; boot++) {
              child = await launchOwnedServer({
                dataDir: harness.config.dataDir,
                port: await freePort(),
              });
              await sleep(100);
              expect(await traceLines(trace)).toEqual([]);
              const actual = await status(child.baseUrl);
              expect(actual.hold).toMatchObject({
                id: ID,
                ownerId: OWNER,
                phase,
              });
              expect(actual.runtime.processId).toBe(child.child.pid);
              expect(actual.runtime.parentProcessId).toBe(process.pid);
              expect(actual.runtime.protocolVersion).toBe(
                HOST_DAEMON_PROTOCOL_VERSION,
              );

              const mutation = await fetch(`${child.baseUrl}/api/v1/projects`, {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ name: "held must refuse" }),
              });

              expect(mutation.status).toBe(503);
              await child.stop();
              child = undefined;
            }

            const disk = createConnection(
              join(harness.config.dataDir, "app.db"),
            );

            try {
              expect(getPluginKvValue(disk, "state-owner", "loop")).toBe(
                JSON.stringify(intent),
              );
              expect(getInstalledPlugin(disk, "state-owner")).toEqual(
                beforePlugin,
              );
              expect(listPluginSchedules(disk, "state-owner")).toEqual(
                beforeSchedule,
              );
            } finally {
              disk.$client.close();
            }
          } finally {
            await child?.stop();
          }
        },
      );
    },
  );

  it("acquires against the actual owned process, survives restart and releases only the exact owner once", async () => {
    await withTestHarness(
      { seedFirstPartyProviders: false },
      async (harness) => {
        await disableBundledOwners(harness);
        seedHost(harness.deps, { id: HOST });
        seedPrimaryHost(harness.deps, HOST);
        await saveFreshStore(harness);
        let child: OwnedServerProcess | undefined;

        try {
          child = await launchOwnedServer({
            dataDir: harness.config.dataDir,
            port: await freePort(),
          });
          await waitForPluginStartup(child.baseUrl);
          const before = await status(child.baseUrl);
          const response = await acquire(child.baseUrl, before.runtime);
          const responseBody = await response.json();

          const errorCode = z
            .object({ code: z.string() })
            .safeParse(responseBody);

          expect(
            response.status,
            errorCode.success ? errorCode.data.code : undefined,
          ).toBe(200);
          expect(responseBody).toMatchObject({
            acquired: true,
            hold: { id: ID, ownerId: OWNER, phase: "held" },
          });
          await child.stop();
          child = await launchOwnedServer({
            dataDir: harness.config.dataDir,
            port: await freePort(),
          });
          const reboot = await status(child.baseUrl);
          expect(reboot.runtime.runtimeId).not.toBe(before.runtime.runtimeId);
          expect(reboot.hold).toMatchObject({
            id: ID,
            ownerId: OWNER,
            phase: "held",
          });

          const release = (ownerId: string) =>
            fetch(`${child?.baseUrl}/api/v1/server/maintenance/release`, {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({
                id: ID,
                ownerId,
                expectedServerHostId: HOST,
              }),
            });

          expect((await release("foreign-owner")).status).toBe(409);
          expect((await status(child.baseUrl)).hold).not.toBeNull();
          expect((await release(OWNER)).status).toBe(200);
          expect((await release(OWNER)).status).toBe(200);
          expect((await status(child.baseUrl)).hold).toBeNull();
          expect(
            await readJsonIfPresent(
              join(harness.config.dataDir, "server-maintenance-hold.json"),
            ),
          ).toMatchObject({ phase: "released", id: ID });
        } finally {
          await child?.stop();
        }
      },
    );
  });

  it.each(["busy", "unknown", "wrong-runtime", "machine"])(
    "refuses %s update acquisition without stopping owners or persisting success",
    async (kind) => {
      const server = await startTestServer({ seedFirstPartyProviders: false });

      try {
        if (kind !== "unknown") await authority(server);
        let runningThread: ReturnType<typeof seedThreadFixture> | undefined;

        if (kind === "busy")
          runningThread = seedThreadFixture(server, {
            session: { id: "host-inert-busy" },
            thread: { status: "active" },
          });

        const probe = await fetch(
          `${server.baseUrl}/api/v1/server/maintenance`,
        );

        expect(probe.status).toBe(kind === "unknown" ? 503 : 200);

        const actual =
          kind === "unknown"
            ? { runtimeId: "inert-unknown", dataDir: server.config.dataDir }
            : statusSchema.parse(await probe.json()).runtime;

        const headers = new Headers({ "content-type": "application/json" });

        if (kind === "machine")
          headers.set(
            "authorization",
            "Bearer " +
              (await server.deps.machineAuth.issueDaemonHostKey({
                hostId: HOST,
              })),
          );

        const response = await fetch(
          `${server.baseUrl}/api/v1/server/maintenance/acquire`,
          {
            method: "POST",
            headers,
            body: JSON.stringify({
              id: ID,
              ownerId: OWNER,
              expectedRuntimeId:
                kind === "wrong-runtime" ? "wrong" : actual.runtimeId,
              expectedServerHostId: HOST,
              expectedDataDir: actual.dataDir,
            }),
          },
        );

        expect(response.status).toBe(
          kind === "unknown" ? 503 : kind === "machine" ? 403 : 409,
        );
        expect(
          await readJsonIfPresent(
            join(server.config.dataDir, "server-maintenance-hold.json"),
          ),
        ).toBeNull();

        if (runningThread)
          expect(
            server.db.$client
              .prepare("SELECT status FROM threads WHERE id = ?")
              .get(runningThread.thread.id),
          ).toMatchObject({ status: "active" });
      } finally {
        await close(server);
      }
    },
  );

  it("refuses a pending factory before cancelling it or admitting native install", async () => {
    const server = await startTestServer({ seedFirstPartyProviders: false });
    const unlock = join(server.config.dataDir, "factory-unlock");
    const entered = join(server.config.dataDir, "factory-entered");
    let loading: Promise<unknown> | undefined;

    try {
      await authority(server);

      const root = await writeInertPlugin(
        server.config.dataDir,
        "pending-owner",
        `import {existsSync,writeFileSync} from 'node:fs'; export default async function plugin() { writeFileSync(${JSON.stringify(entered)}, 'entered'); while(!existsSync(${JSON.stringify(unlock)})) await new Promise(r=>setTimeout(r,10)); }`,
      );

      loading = server.pluginService.installPath(root);
      await expect.poll(() => traceLines(entered)).toEqual(["entered"]);
      const actual = await status(server.baseUrl);
      expect(actual.activity.pluginLoads).toBeGreaterThan(0);
      const response = await acquire(server.baseUrl, actual.runtime);
      expect(response.status).toBe(409);
      expect(
        await readJsonIfPresent(
          join(server.config.dataDir, "server-maintenance-hold.json"),
        ),
      ).toBeNull();
    } finally {
      await writeFile(unlock, "released");
      await loading;
      await close(server);
    }
  });

  it("retains an acquiring hold when registered disposal fails", async () => {
    const server = await startTestServer({ seedFirstPartyProviders: false });

    try {
      await authority(server);

      const root = await writeInertPlugin(
        server.config.dataDir,
        "broken-dispose",
        `export default function plugin(api) { api.onDispose(() => { throw new Error('inert disposal refusal'); }); }`,
      );

      await server.pluginService.installPath(root);
      const actual = await status(server.baseUrl);
      const response = await acquire(server.baseUrl, actual.runtime);
      expect(response.status).toBe(503);
      expect(
        await readJsonIfPresent(
          join(server.config.dataDir, "server-maintenance-hold.json"),
        ),
      ).toMatchObject({ id: ID, ownerId: OWNER, phase: "acquiring" });
      expect((await status(server.baseUrl)).hold).not.toBeNull();
    } finally {
      await close(server);
    }
  });

  it("migration suspension waits for a pending load and prevents late registered work", async () => {
    const server = await startTestServer({ seedFirstPartyProviders: false });

    const entered = join(server.config.dataDir, "migration-factory-entered"),
      unlock = join(server.config.dataDir, "migration-factory-unlock"),
      trace = join(server.config.dataDir, "migration-late-service");

    let loading: Promise<unknown> | undefined,
      suspending: Promise<unknown> | undefined;

    try {
      await authority(server);

      const root = await writeInertPlugin(
        server.config.dataDir,
        "late-migration-owner",
        `import {existsSync,writeFileSync} from 'node:fs'; export default async function plugin(api) { writeFileSync(${JSON.stringify(entered)},'entered'); while(!existsSync(${JSON.stringify(unlock)})) await new Promise(r=>setTimeout(r,10)); api.background.service('late', {start(signal){writeFileSync(${JSON.stringify(trace)},'fired');return new Promise(resolve=>signal.addEventListener('abort',resolve,{once:true}));}}); }`,
      );

      loading = server.pluginService.installPath(root);
      await expect.poll(() => traceLines(entered)).toEqual(["entered"]);
      setServerMoveFrozen(server.db, true);
      let settled = false;
      suspending = server.pluginService
        .suspendPlugins({ keep: () => false })
        .then((value) => {
          settled = true;

          return value;
        });
      await sleep(20);
      expect(settled).toBe(false);
      await writeFile(unlock, "released");
      await loading;
      await suspending;
      expect(await traceLines(trace)).toEqual([]);
      expect(
        server.pluginService.getApi("late-migration-owner"),
      ).toBeUndefined();
      expect(
        getInstalledPlugin(server.db, "late-migration-owner")?.enabled,
      ).toBe(true);
    } finally {
      await writeFile(unlock, "released");
      await Promise.allSettled([loading, suspending]);
      setServerMoveFrozen(server.db, false);
      await close(server);
    }
  });

  it("never reports a held install receipt while a registered service remains hung", async () => {
    const server = await startTestServer({ seedFirstPartyProviders: false });

    try {
      await authority(server);

      const root = await writeInertPlugin(
        server.config.dataDir,
        "hung-owner",
        `export default function plugin(api){api.background.service('hung',{start(){return new Promise(()=>{});}});}`,
      );

      await server.pluginService.installPath(root);
      const actual = await status(server.baseUrl);
      const response = await acquire(server.baseUrl, actual.runtime);
      expect(response.status).toBe(503);
      expect(
        await readJsonIfPresent(
          join(server.config.dataDir, "server-maintenance-hold.json"),
        ),
      ).toMatchObject({ phase: "acquiring", id: ID });
      expect(
        (await status(server.baseUrl)).activity.hungServices,
      ).toBeGreaterThan(0);
    } finally {
      await close(server);
    }
  });

  it("fails startup visibly on malformed durable ownership state", async () => {
    await withTestHarness(
      { seedFirstPartyProviders: false },
      async (harness) => {
        await disableBundledOwners(harness);
        await saveFreshStore(harness);
        await writeFile(
          join(harness.config.dataDir, "server-maintenance-hold.json"),
          "{invalid",
        );
        let child: OwnedServerProcess | undefined;

        try {
          await expect(
            launchOwnedServer({
              dataDir: harness.config.dataDir,
              port: await freePort(),
            }).then((value) => {
              child = value;

              return value;
            }),
          ).rejects.toThrow(/maintenance|hold|Unexpected|JSON/iu);
        } finally {
          await child?.stop();
        }
      },
    );
  });
});
