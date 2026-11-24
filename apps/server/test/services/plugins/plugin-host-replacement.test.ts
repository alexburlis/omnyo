import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createConnection, migrate, type DbConnection } from "@omnyo/db";
import type { Logger } from "@omnyo/logger";
import { createAiServiceRegistry } from "../../../src/services/ai/ai-service-registry.js";
import {
  createPluginService,
  type PluginService,
} from "../../../src/services/plugins/plugin-service.js";
import { createNoopTelemetryService } from "../../../src/services/system/telemetry.js";
import { testLogger } from "../../helpers/test-app.js";
import { openSecretVault } from "@omnyo/secret-storage";

describe("plugin host workers across replacement and removal", () => {
  let db: DbConnection;
  let workDir: string;
  let rootDir: string;
  let service: PluginService;
  let disposed: { pluginId: string; generation: string }[];

  beforeEach(async () => {
    db = createConnection(":memory:");
    migrate(db);
    disposed = [];
    workDir = await mkdtemp(join(tmpdir(), "omnyo-host-replacement-"));
    rootDir = join(workDir, "plugin");
    await mkdir(rootDir, { recursive: true });
    await writeFile(
      join(rootDir, "package.json"),
      JSON.stringify({
        name: "omnyo-plugin-host-replacement",
        version: "0.1.0",
        type: "module",
        omnyo: {
          name: "Host replacement fixture",
          description: "Host worker replacement fixture.",
          branding: { icon: "Zap" },
          server: "./server.ts",
          host: "./host.ts",
        },
      }),
    );
    await writeFile(
      join(rootDir, "server.ts"),
      "export default function plugin() {}",
    );
    await writeFile(
      join(rootDir, "host.ts"),
      "export default { experimental_apiVersion: 1, contract: {}, handlers: {} };",
    );
    await writeFile(
      join(rootDir, "tsconfig.json"),
      JSON.stringify({
        compilerOptions: {
          target: "ES2022",
          module: "ESNext",
          moduleResolution: "bundler",
          strict: true,
        },
      }),
    );
    service = createPluginService({
      db,
      dataDir: join(workDir, "data"),
      vault: await openSecretVault(join(workDir, "data")),
      appVersion: "0.9.0",
      bundledPlugins: [],
      aiServices: createAiServiceRegistry(),
      telemetry: createNoopTelemetryService(),
      logger: testLogger as unknown as Logger,
      hub: {
        getDaemonSessionIdForHost: () => null,
        notifyPluginSignal: () => 0,
        notifySystem: () => {},
      },
      disposePluginHost: async (args) => {
        disposed.push(args);
      },
    });
    await service.start();
  });

  afterEach(async () => {
    await service.stop();
    db.$client.close();
    await rm(workDir, { recursive: true, force: true });
  });

  async function installed(): Promise<string> {
    const plugin = await service.installPath(rootDir);

    expect(service.list().find((row) => row.id === plugin.id)?.status).toBe(
      "running",
    );

    return plugin.id;
  }

  it("keeps machines' host workers through a reload and an install over the same plugin", async () => {
    const id = await installed();

    await expect(service.reload(id)).resolves.toMatchObject({ ok: true });
    await service.installPath(rootDir);

    expect(disposed).toEqual([]);
  });

  it("stops machines' host workers when the plugin is disabled or removed", async () => {
    const id = await installed();

    await service.setEnabled(id, false);
    expect(disposed).toEqual([
      { pluginId: id, generation: expect.any(String) },
    ]);

    await service.setEnabled(id, true);
    await service.remove(id);
    expect(disposed.map((entry) => entry.pluginId)).toEqual([id, id]);
  });
});
