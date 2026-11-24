import {
  mkdir,
  mkdtemp,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createConnection,
  createPluginArtifact,
  getInstalledPlugin,
  migrate,
  upsertInstalledPlugin,
  type DbConnection,
} from "@omnyo/db";
import type { Logger } from "@omnyo/logger";
import {
  buildPluginServer,
  resolvePluginBuildToolchain,
} from "@omnyo/plugin-build";
import { createAiServiceRegistry } from "../../../src/services/ai/ai-service-registry.js";
import { hashInstallDir } from "../../../src/services/plugins/install-sources.js";
import {
  createPluginService,
  type PluginService,
} from "../../../src/services/plugins/plugin-service.js";
import { createNoopTelemetryService } from "../../../src/services/system/telemetry.js";
import { testLogger } from "../../helpers/test-app.js";
import { openSecretVault } from "@omnyo/secret-storage";

const logger = testLogger as unknown as Logger;

const LOAD_COUNTERS = ["__relocateSnapshotLoads", "__relocateCheckoutLoads"];

function loads(counter: string): unknown {
  return Reflect.get(globalThis, counter);
}

async function writeCheckoutPlugin(dir: string, name: string): Promise<string> {
  const rootDir = join(dir, name);
  await mkdir(rootDir, { recursive: true });
  await writeFile(
    join(rootDir, "package.json"),
    JSON.stringify({
      name,
      version: "0.1.0",
      omnyo: {
        name: "Relocation fixture",
        description: "Plugin relocation fixture.",
        branding: { icon: "Zap" },
        server: "./server.ts",
      },
    }),
  );
  await writeFile(
    join(rootDir, "server.ts"),
    "export default function plugin() { globalThis.__relocateCheckoutLoads = (globalThis.__relocateCheckoutLoads ?? 0) + 1; }\n",
  );

  return rootDir;
}

describe("path plugin relocation", () => {
  let db: DbConnection;
  let workDir: string;
  let service: PluginService;

  beforeEach(async () => {
    db = createConnection(":memory:");
    migrate(db);
    workDir = await realpath(
      await mkdtemp(join(tmpdir(), "omnyo-plugin-relocate-")),
    );
    service = createPluginService({
      aiServices: createAiServiceRegistry(),
      telemetry: createNoopTelemetryService(),
      db,
      hub: {
        getDaemonSessionIdForHost: () => null,
        notifyPluginSignal: () => 0,
        notifySystem: () => {},
      },
      logger,
      dataDir: join(workDir, "data"),
      vault: await openSecretVault(join(workDir, "data")),
      appVersion: "0.9.0",
      loadTimeoutMs: 2000,
    });
  });

  afterEach(async () => {
    for (const counter of LOAD_COUNTERS)
      Reflect.deleteProperty(globalThis, counter);
    await service.stop();
    await rm(workDir, { recursive: true, force: true });
  });

  async function installSnapshotPlugin(
    sourcePath: string,
    enabled = true,
  ): Promise<string> {
    await mkdir(sourcePath, { recursive: true });
    await writeFile(
      join(sourcePath, "package.json"),
      JSON.stringify({ name: "omnyo-plugin-snapshot" }),
    );

    const artifactDir = join(
      workDir,
      "data/plugins/cache/identity-v1/snapshot/0001",
    );

    await mkdir(artifactDir, { recursive: true });
    await writeFile(
      join(artifactDir, "package.json"),
      JSON.stringify({
        name: "omnyo-plugin-snapshot",
        version: "1.0.0",
        type: "module",
        omnyo: {
          name: "Snapshot fixture",
          description: "Verified snapshot fixture.",
          branding: { icon: "Zap" },
          server: "server.ts",
        },
      }),
    );
    await writeFile(
      join(artifactDir, "server.ts"),
      "export default function setup() { globalThis.__relocateSnapshotLoads = (globalThis.__relocateSnapshotLoads ?? 0) + 1; }\n",
    );
    await buildPluginServer(
      artifactDir,
      "0.9.0",
      await resolvePluginBuildToolchain(join(workDir, "toolchain")),
    );
    createPluginArtifact(db, {
      id: "identity_v1_snapshot",
      pluginId: "snapshot",
      sourceKind: "path",
      npmResolvedVersion: null,
      gitResolvedCommit: null,
      gitCheckoutRoot: null,
      integrity: null,
      path: artifactDir,
      contentHash: await hashInstallDir(artifactDir),
      validationResult: "valid",
      validatedAt: 1,
    });
    upsertInstalledPlugin(db, {
      id: "snapshot",
      source: `path:${sourcePath}`,
      provenance: { kind: "direct" },
      sourceIntent: { kind: "path", canonicalPath: sourcePath },
      exactResolution: { kind: "path" },
      updateState: {
        lastCheckAt: null,
        availableCompatibleVersion: null,
        newestIncompatibleVersion: null,
        statusDetail: null,
      },
      activeArtifactId: "identity_v1_snapshot",
      rootDir: artifactDir,
      version: "1.0.0",
      enabled,
      enabledFollowsDefault: false,
    });
    await service.reload();

    return artifactDir;
  }

  async function writeSourceBeside(
    sourcePath: string,
    serverBody: string,
  ): Promise<void> {
    await writeFile(
      join(sourcePath, "package.json"),
      JSON.stringify({
        name: "omnyo-plugin-snapshot",
        version: "1.1.0",
        type: "module",
        omnyo: {
          name: "Snapshot fixture",
          description: "Verified snapshot fixture.",
          branding: { icon: "Zap" },
          server: "./server.ts",
        },
      }),
    );
    await writeFile(join(sourcePath, "server.ts"), serverBody);
  }

  it("reload <id> moves a snapshot path plugin onto its source folder, keeping its enabled state", async () => {
    const sourcePath = join(workDir, "plugins", "snapshot");
    const artifactDir = await installSnapshotPlugin(sourcePath);
    await writeSourceBeside(
      sourcePath,
      "export default function plugin() { globalThis.__relocateCheckoutLoads = (globalThis.__relocateCheckoutLoads ?? 0) + 1; }\n",
    );

    expect(await service.reload()).toMatchObject({ ok: true });
    expect(getInstalledPlugin(db, "snapshot")).toMatchObject({
      rootDir: artifactDir,
      activeArtifactId: "identity_v1_snapshot",
    });
    expect(loads("__relocateCheckoutLoads")).toBeUndefined();

    expect(await service.reload("snapshot")).toMatchObject({ ok: true });
    expect(getInstalledPlugin(db, "snapshot")).toMatchObject({
      rootDir: sourcePath,
      sourcePath,
      activeArtifactId: null,
      enabled: true,
      version: "1.1.0",
    });
    expect(loads("__relocateCheckoutLoads")).toBe(1);
    expect(
      service.list().find((plugin) => plugin.id === "snapshot")?.status,
    ).toBe("running");
  });

  it("reload <id> keeps a disabled snapshot plugin disabled on its source folder", async () => {
    const sourcePath = join(workDir, "plugins", "snapshot");
    await installSnapshotPlugin(sourcePath, false);
    await writeSourceBeside(
      sourcePath,
      "export default function plugin() { globalThis.__relocateCheckoutLoads = (globalThis.__relocateCheckoutLoads ?? 0) + 1; }\n",
    );

    expect(await service.reload("snapshot")).toMatchObject({ ok: true });
    expect(getInstalledPlugin(db, "snapshot")).toMatchObject({
      rootDir: sourcePath,
      enabled: false,
    });
    expect(loads("__relocateCheckoutLoads")).toBeUndefined();
  });

  it("reload <id> keeps the verified snapshot when the source folder cannot start", async () => {
    const sourcePath = join(workDir, "plugins", "snapshot");
    const artifactDir = await installSnapshotPlugin(sourcePath);
    await writeSourceBeside(
      sourcePath,
      'export default function plugin() { throw new Error("source broke"); }\n',
    );

    const outcome = await service.reload("snapshot");

    expect(outcome.ok).toBe(false);
    expect(outcome.ok ? "" : outcome.error).toContain(
      "it keeps running its verified snapshot",
    );
    expect(getInstalledPlugin(db, "snapshot")).toMatchObject({
      rootDir: artifactDir,
      activeArtifactId: "identity_v1_snapshot",
      enabled: true,
    });
    expect(
      service.list().find((plugin) => plugin.id === "snapshot")?.status,
    ).toBe("running");
  });

  it("moves snapshot, running and disabled path plugins to the renamed folder without rebuilding snapshots", async () => {
    const oldRoot = join(workDir, "old-plugins");
    const newRoot = join(workDir, "omnyo-plugins");
    const artifactDir = await installSnapshotPlugin(join(oldRoot, "snapshot"));
    await service.installPath(
      await writeCheckoutPlugin(oldRoot, "omnyo-plugin-running"),
    );
    await service.installPath(
      await writeCheckoutPlugin(oldRoot, "omnyo-plugin-dormant"),
    );
    expect(await service.setEnabled("dormant", false)).toMatchObject({
      status: "disabled",
    });
    expect(loads("__relocateSnapshotLoads")).toBe(1);
    expect(loads("__relocateCheckoutLoads")).toBe(2);

    await rename(oldRoot, newRoot);
    await symlink(newRoot, oldRoot);

    const preview = await service.relocatePathSources({
      from: oldRoot,
      to: newRoot,
      dryRun: true,
    });

    expect(preview).toEqual({
      dryRun: true,
      relocated: [
        {
          pluginId: "dormant",
          from: join(oldRoot, "omnyo-plugin-dormant"),
          to: join(newRoot, "omnyo-plugin-dormant"),
          mode: "checkout",
          reloaded: false,
        },
        {
          pluginId: "running",
          from: join(oldRoot, "omnyo-plugin-running"),
          to: join(newRoot, "omnyo-plugin-running"),
          mode: "checkout",
          reloaded: true,
        },
        {
          pluginId: "snapshot",
          from: join(oldRoot, "snapshot"),
          to: join(newRoot, "snapshot"),
          mode: "snapshot",
          reloaded: false,
        },
      ],
    });
    expect(getInstalledPlugin(db, "running")?.sourcePath).toBe(
      join(oldRoot, "omnyo-plugin-running"),
    );

    const result = await service.relocatePathSources({
      from: oldRoot,
      to: newRoot,
      dryRun: false,
    });

    expect(
      result.relocated.map((entry) => [entry.pluginId, entry.reloaded]),
    ).toEqual([
      ["dormant", false],
      ["running", true],
      ["snapshot", false],
    ]);
    expect(getInstalledPlugin(db, "snapshot")).toMatchObject({
      source: `path:${join(newRoot, "snapshot")}`,
      sourcePath: join(newRoot, "snapshot"),
      rootDir: artifactDir,
      activeArtifactId: "identity_v1_snapshot",
      enabled: true,
    });
    expect(getInstalledPlugin(db, "running")).toMatchObject({
      source: `path:${join(newRoot, "omnyo-plugin-running")}`,
      rootDir: join(newRoot, "omnyo-plugin-running"),
      activeArtifactId: null,
      enabled: true,
    });
    expect(getInstalledPlugin(db, "dormant")).toMatchObject({
      rootDir: join(newRoot, "omnyo-plugin-dormant"),
      enabled: false,
    });
    expect(loads("__relocateSnapshotLoads")).toBe(1);
    expect(loads("__relocateCheckoutLoads")).toBe(3);
    expect(
      Object.fromEntries(
        service
          .list()
          .map((plugin) => [plugin.id, [plugin.status, plugin.source]]),
      ),
    ).toMatchObject({
      snapshot: ["running", `path:${join(newRoot, "snapshot")}`],
      running: ["running", `path:${join(newRoot, "omnyo-plugin-running")}`],
      dormant: ["disabled", `path:${join(newRoot, "omnyo-plugin-dormant")}`],
    });

    await rm(oldRoot);
    await service.reload("snapshot");
    await service.reload("running");
    expect(
      service.list().find((plugin) => plugin.id === "snapshot")?.status,
    ).toBe("running");
    expect(
      service.list().find((plugin) => plugin.id === "running")?.status,
    ).toBe("running");
    expect(await service.setEnabled("dormant", true)).toMatchObject({
      status: "running",
    });
    await expect(
      service.relocatePathSources({
        from: newRoot,
        to: newRoot,
        dryRun: false,
      }),
    ).rejects.toThrow("The old and new folders are the same");
  });

  it("refuses a new folder that is a link or that the old folder does not lead to", async () => {
    const oldRoot = join(workDir, "old-plugins");
    const newRoot = join(workDir, "omnyo-plugins");
    const elsewhere = join(workDir, "elsewhere");
    await service.installPath(
      await writeCheckoutPlugin(oldRoot, "omnyo-plugin-running"),
    );
    await mkdir(elsewhere);
    await rename(oldRoot, newRoot);
    await symlink(newRoot, oldRoot);
    const linkedTarget = join(workDir, "linked");
    await symlink(newRoot, linkedTarget);

    await expect(
      service.relocatePathSources({
        from: oldRoot,
        to: linkedTarget,
        dryRun: false,
      }),
    ).rejects.toThrow("must be the folder's own path");
    await expect(
      service.relocatePathSources({
        from: oldRoot,
        to: elsewhere,
        dryRun: false,
      }),
    ).rejects.toThrow("does not lead to");
    await expect(
      service.relocatePathSources({
        from: "relative",
        to: newRoot,
        dryRun: false,
      }),
    ).rejects.toThrow("absolute paths");
    expect(getInstalledPlugin(db, "running")?.sourcePath).toBe(
      join(oldRoot, "omnyo-plugin-running"),
    );
  });
});
