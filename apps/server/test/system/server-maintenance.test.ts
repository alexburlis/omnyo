import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createConnection, migrate, upsertInstalledPlugin } from "@omnyo/db";
import { HOST_ID_FILE_NAME } from "@omnyo/host-daemon-contract";
import {
  readMaintenanceHold,
  writeMaintenanceHold,
} from "@omnyo/server-archive";
import {
  maintenanceStatusSchema,
  serverRuntimeIdentitySchema,
  type MaintenanceHold,
} from "@omnyo/server-contract";
import { createDeferredPromise } from "@omnyo/test-helpers";
import { createServerMaintenance } from "../../src/services/maintenance/server-maintenance.js";
import { createPluginService } from "../../src/services/plugins/plugin-service.js";
import {
  isServerMoveFrozen,
  setServerMoveFrozen,
} from "../../src/services/server-move/freeze-state.js";
import { createTestAppHarness } from "../helpers/test-app.js";

async function createFixture() {
  const harness = await createTestAppHarness();
  const db = createConnection(":memory:");
  migrate(db);
  const deps = { ...harness.deps, db };

  const plugins = createPluginService({
    aiServices: deps.aiServices,
    telemetry: deps.telemetry,
    db,
    hub: deps.hub,
    logger: deps.logger,
    dataDir: deps.config.dataDir,
    vault: deps.vault,
    appVersion: deps.config.appVersion,
    bundledPlugins: [],
  });

  const hold: MaintenanceHold = {
    version: 1,
    id: "maintenance-release-fixture",
    ownerId: "maintenance-owner",
    kind: "desktop-update",
    phase: "held",
    serverHostId: "host-maintenance-fixture",
    createdAt: Date.now(),
    artifact: null,
  };

  await writeFile(
    join(deps.config.dataDir, HOST_ID_FILE_NAME),
    hold.serverHostId,
  );
  await writeMaintenanceHold(deps.config.dataDir, hold);
  const maintenance = createServerMaintenance(deps, plugins);

  const input = {
    id: hold.id,
    ownerId: hold.ownerId,
    expectedServerHostId: hold.serverHostId,
  };

  return {
    app: harness.app,
    db,
    deps,
    plugins,
    hold,
    input,
    maintenance,
    async cleanup() {
      setServerMoveFrozen(db, false);
      await plugins.stop();
      db.$client.close();
      await harness.cleanup();
    },
  };
}

async function installFixturePlugin(
  fixture: Awaited<ReturnType<typeof createFixture>>,
  id: string,
  fails: boolean,
) {
  const rootDir = join(fixture.deps.config.dataDir, "release-fixtures", id);
  await mkdir(rootDir, { recursive: true });
  await writeFile(
    join(rootDir, "package.json"),
    JSON.stringify({
      name: `omnyo-plugin-${id}`,
      type: "module",
      version: "0.1.0",
      omnyo: {
        name: id,
        description: "Maintenance release fixture",
        branding: { icon: "Zap" },
        server: "./server.js",
      },
    }),
  );
  const loads = join(rootDir, "loads.txt");
  await writeFile(
    join(rootDir, "server.js"),
    `import { appendFileSync } from "node:fs";
export default function plugin() {
  appendFileSync(${JSON.stringify(loads)}, ${JSON.stringify("loaded\n")});
  ${fails ? 'throw new Error("Fixture plugin failed to start");' : ""}
}
`,
  );
  upsertInstalledPlugin(fixture.db, {
    id,
    source: `path:${rootDir}`,
    provenance: { kind: "direct" },
    sourceIntent: { kind: "path", canonicalPath: rootDir },
    exactResolution: { kind: "path" },
    updateState: {
      lastCheckAt: null,
      availableCompatibleVersion: null,
      newestIncompatibleVersion: null,
      statusDetail: null,
    },
    activeArtifactId: null,
    rootDir,
    version: "0.1.0",
    enabled: true,
    enabledFollowsDefault: false,
  });

  return loads;
}

describe("server maintenance release", () => {
  let fixture: Awaited<ReturnType<typeof createFixture>>;

  beforeEach(async () => {
    fixture = await createFixture();
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await fixture.cleanup();
  });

  it.each(["held", "releasing"] as const)(
    "survives interruption while restoring plugins from %s maintenance",
    async (phase) => {
      await writeMaintenanceHold(fixture.deps.config.dataDir, {
        ...fixture.hold,
        phase,
      });

      const maintenance = createServerMaintenance(
        fixture.deps,
        fixture.plugins,
      );

      const entered = createDeferredPromise<void>();
      const resume = createDeferredPromise<void>();
      vi.spyOn(fixture.plugins, "resumeMaintenancePlugins").mockImplementation(
        async () => {
          entered.resolve();
          await resume.promise;
        },
      );
      const releasing = maintenance.release(fixture.input);
      await entered.promise;

      try {
        expect(readMaintenanceHold(fixture.deps.config.dataDir)?.phase).toBe(
          "released",
        );
        expect(maintenance.status().hold).toBeNull();
        expect(isServerMoveFrozen(fixture.db)).toBe(false);

        const restartedDb = createConnection(":memory:");
        migrate(restartedDb);

        try {
          const restarted = createServerMaintenance(
            { ...fixture.deps, db: restartedDb },
            fixture.plugins,
          );

          expect(restarted.status().hold).toBeNull();
          expect(restarted.isHeld()).toBe(false);
        } finally {
          restartedDb.$client.close();
        }
      } finally {
        resume.resolve();
        await releasing;
      }
    },
  );

  it("isolates a failed plugin and does not repeat successful factories on release retry", async () => {
    await installFixturePlugin(fixture, "a-failing", true);

    const healthyLoads = await installFixturePlugin(
      fixture,
      "z-healthy",
      false,
    );

    await expect(fixture.maintenance.release(fixture.input)).resolves.toEqual({
      released: true,
      id: fixture.hold.id,
    });
    expect(fixture.maintenance.status().hold).toBeNull();
    expect(isServerMoveFrozen(fixture.db)).toBe(false);
    expect(fixture.plugins.list()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "a-failing", status: "error" }),
        expect.objectContaining({ id: "z-healthy", status: "running" }),
      ]),
    );
    expect(await readFile(healthyLoads, "utf8")).toBe("loaded\n");

    await fixture.maintenance.release(fixture.input);
    expect(await readFile(healthyLoads, "utf8")).toBe("loaded\n");
  });

  it("keeps maintenance held when another owner requests release", async () => {
    await expect(
      fixture.maintenance.release({
        ...fixture.input,
        ownerId: "another-owner",
      }),
    ).rejects.toMatchObject({
      body: { code: "maintenance_ownership_mismatch" },
    });
    expect(readMaintenanceHold(fixture.deps.config.dataDir)).toEqual(
      fixture.hold,
    );
    expect(fixture.maintenance.isHeld()).toBe(true);
  });

  it("denies bearer credentials on every maintenance control without changing the protected hold", async () => {
    for (const [path, method] of [
      ["", "GET"],
      ["/acquire", "POST"],
      ["/prepare", "POST"],
      ["/release", "POST"],
    ] as const) {
      const response = await fixture.app.request(
        "/api/v1/server/maintenance" + path,
        {
          method,
          headers: {
            authorization: "Bearer denied-machine-fixture",
            "content-type": "application/json",
          },
          ...(method === "POST" ? { body: "{}" } : {}),
        },
      );

      expect(response.status).toBe(403);
      expect(await response.json()).toMatchObject({
        code: "machine_host_management_forbidden",
      });
    }

    expect(readMaintenanceHold(fixture.deps.config.dataDir)).toEqual(
      fixture.hold,
    );
  });

  it("serves the runtime identity to machine sessions that cannot read maintenance status", async () => {
    const owner = maintenanceStatusSchema.parse(
      await (await fixture.app.request("/api/v1/server/maintenance")).json(),
    );

    const machineHeaders = { "x-omnyo-gate-auth": "machine" };

    const denied = await fixture.app.request("/api/v1/server/maintenance", {
      headers: machineHeaders,
    });

    expect(denied.status).toBe(403);

    const identity = await fixture.app.request("/api/v1/server/runtime", {
      headers: machineHeaders,
    });

    expect(identity.status).toBe(200);
    expect(serverRuntimeIdentitySchema.parse(await identity.json())).toEqual({
      runtimeId: owner.runtime.runtimeId,
    });
  });

  it("keeps maintenance held while a source move owns admission", async () => {
    setServerMoveFrozen(fixture.db, true);
    await expect(
      fixture.maintenance.release(fixture.input),
    ).rejects.toMatchObject({ body: { code: "maintenance_conflict" } });
    expect(readMaintenanceHold(fixture.deps.config.dataDir)).toEqual(
      fixture.hold,
    );
    expect(fixture.maintenance.isHeld()).toBe(true);
  });

  it("keeps an unconfirmed migration held", async () => {
    const hold: MaintenanceHold = { ...fixture.hold, kind: "migration" };
    await writeMaintenanceHold(fixture.deps.config.dataDir, hold);
    const maintenance = createServerMaintenance(fixture.deps, fixture.plugins);
    await expect(maintenance.release(fixture.input)).rejects.toMatchObject({
      body: { code: "maintenance_conflict" },
    });
    expect(readMaintenanceHold(fixture.deps.config.dataDir)).toEqual(hold);
    expect(maintenance.isHeld()).toBe(true);
  });
});
