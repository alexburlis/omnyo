import { execFile } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import {
  PLUGIN_RUNTIME_ABI,
  PLUGIN_SDK_MAJOR,
  PLUGIN_SDK_PACKAGE_NAME,
  PLUGIN_SDK_VERSION,
} from "@omnyo/domain";
import { afterEach, describe, expect, it } from "vitest";

const run = promisify(execFile);

describe("native plugin server loading", () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    await Promise.all(
      tempDirs
        .splice(0)
        .map((dir) => rm(dir, { recursive: true, force: true })),
    );
  });

  it("resolves Omnyo-provided externals in a native Node import", async () => {
    const workDir = await mkdtemp(join(tmpdir(), "omnyo-native-plugin-load-"));
    tempDirs.push(workDir);
    const rootDir = join(workDir, "plugin");
    await mkdir(join(rootDir, "dist"), { recursive: true });
    await writeFile(
      join(rootDir, "package.json"),
      JSON.stringify({
        name: "omnyo-plugin-native-externals",
        version: "0.1.0",
        omnyo: {
          name: "Native externals fixture",
          description: "Exercises native plugin server loading.",
          branding: { icon: "Zap" },
          server: "./server.ts",
        },
      }),
    );
    await writeFile(join(rootDir, "server.ts"), "throw new Error('source');");
    await writeFile(
      join(rootDir, "dist", "server.js"),
      `import { defineRpcContract } from "@omnyo/plugin-sdk";
import Database from "better-sqlite3";
export default function plugin() {
  const database = new Database(":memory:");
  database.close();
  globalThis.__nativeExternalTypes = [typeof defineRpcContract, typeof Database];
}
`,
    );
    await writeFile(
      join(rootDir, "dist", "server.meta.json"),
      JSON.stringify({
        sdkMajor: PLUGIN_SDK_MAJOR,
        sdkVersion: PLUGIN_SDK_VERSION,
        artifactFormatVersion: 2,
        sdkPackage: PLUGIN_SDK_PACKAGE_NAME,
        runtimeAbi: PLUGIN_RUNTIME_ABI,
        pluginId: "native-externals",
        pluginVersion: "0.1.0",
        builtWith: {
          coreVersion: "0.0.0-test",
          pluginSdkVersion: PLUGIN_SDK_VERSION,
        },
      }),
    );

    const runtimeUrl = pathToFileURL(
      resolve(
        import.meta.dirname,
        "../../../src/services/plugins/plugin-service.ts",
      ),
    ).href;

    const aiRegistryUrl = pathToFileURL(
      resolve(
        import.meta.dirname,
        "../../../src/services/ai/ai-service-registry.ts",
      ),
    ).href;

    const telemetryUrl = pathToFileURL(
      resolve(import.meta.dirname, "../../../src/services/system/telemetry.ts"),
    ).href;

    const script = `
import pino from "pino";
import { createConnection, migrate, upsertInstalledPlugin } from "@omnyo/db";
import { openSecretVault } from "@omnyo/secret-storage";
import { createPluginService } from ${JSON.stringify(runtimeUrl)};
import { createAiServiceRegistry } from ${JSON.stringify(aiRegistryUrl)};
import { createNoopTelemetryService } from ${JSON.stringify(telemetryUrl)};
const [rootDir, dataDir] = process.argv.slice(1);
const db = createConnection(":memory:");
migrate(db);
upsertInstalledPlugin(db, {
  id: "native-externals",
  source: "git:github.com/acme/omnyo-plugin-native-externals@v1",
  rootDir,
  version: "0.1.0",
  enabled: true,
  provenance: { kind: "direct" },
  sourceIntent: {
    kind: "git",
    url: "https://github.com/acme/omnyo-plugin-native-externals",
    subdirectory: null,
    selector: { kind: "ref", ref: "v1", refKind: "branch" }
  },
  exactResolution: { kind: "git", commit: "test-commit" },
  updateState: {
    lastCheckAt: null,
    availableCompatibleVersion: null,
    newestIncompatibleVersion: null,
    statusDetail: null
  },
  activeArtifactId: null
});
const service = createPluginService({
  aiServices: createAiServiceRegistry(),
  telemetry: createNoopTelemetryService(),
  db,
  hub: {
    getDaemonSessionIdForHost: () => null,
    notifyPluginSignal: () => 0,
    notifySystem: () => {}
  },
  logger: pino({ enabled: false }),
  dataDir,
  vault: await openSecretVault(dataDir),
  appVersion: "0.9.0",
  loadTimeoutMs: 2000
});
await service.reload("native-externals");
const entry = service.list().find((plugin) => plugin.id === "native-externals");
const result = {
  status: entry?.status,
  statusDetail: entry?.statusDetail,
  types: globalThis.__nativeExternalTypes
};
await service.stop();
process.stdout.write(JSON.stringify(result));
`;

    const { stdout } = await run(
      process.execPath,
      [
        "--conditions=source",
        "--import",
        "tsx",
        "--input-type=module",
        "--eval",
        script,
        rootDir,
        join(workDir, "data"),
      ],
      { cwd: resolve(import.meta.dirname, "../../..") },
    );

    expect(JSON.parse(stdout)).toEqual({
      status: "running",
      statusDetail: null,
      types: ["function", "function"],
    });
  });

  it("loads a TypeScript source plugin through the cache in native Node", async () => {
    const workDir = await mkdtemp(join(tmpdir(), "omnyo-native-source-load-"));
    tempDirs.push(workDir);
    const rootDir = join(workDir, "plugin");
    await mkdir(rootDir, { recursive: true });
    await writeFile(
      join(rootDir, "package.json"),
      JSON.stringify({
        name: "omnyo-plugin-native-source",
        version: "0.1.0",
        omnyo: {
          name: "Native source fixture",
          description: "Exercises cached source plugin loading.",
          branding: { icon: "Zap" },
          server: "./server.ts",
        },
      }),
    );
    await writeFile(
      join(rootDir, "server.ts"),
      `import { defineRpcContract, type PluginApi } from "@omnyo/plugin-sdk";
const value: string = "loaded";
export default function plugin(api: PluginApi) {
  void api;
  globalThis.__nativeSourceResult = [value, typeof defineRpcContract];
}
`,
    );

    const serviceUrl = pathToFileURL(
      resolve(
        import.meta.dirname,
        "../../../src/services/plugins/plugin-service.ts",
      ),
    ).href;

    const aiRegistryUrl = pathToFileURL(
      resolve(
        import.meta.dirname,
        "../../../src/services/ai/ai-service-registry.ts",
      ),
    ).href;

    const telemetryUrl = pathToFileURL(
      resolve(import.meta.dirname, "../../../src/services/system/telemetry.ts"),
    ).href;

    const script = `
import pino from "pino";
import { createConnection, migrate } from "@omnyo/db";
import { openSecretVault } from "@omnyo/secret-storage";
import { createPluginService } from ${JSON.stringify(serviceUrl)};
import { createAiServiceRegistry } from ${JSON.stringify(aiRegistryUrl)};
import { createNoopTelemetryService } from ${JSON.stringify(telemetryUrl)};
const [rootDir, dataDir] = process.argv.slice(1);
const db = createConnection(":memory:");
migrate(db);
const service = createPluginService({
  aiServices: createAiServiceRegistry(),
  telemetry: createNoopTelemetryService(),
  db,
  hub: {
    getDaemonSessionIdForHost: () => null,
    notifyPluginSignal: () => 0,
    notifySystem: () => {}
  },
  logger: pino({ enabled: false }),
  dataDir,
  vault: await openSecretVault(dataDir),
  appVersion: "0.9.0",
  loadTimeoutMs: 2000
});
const entry = await service.installPath(rootDir);
const result = {
  status: entry.status,
  statusDetail: entry.statusDetail,
  value: globalThis.__nativeSourceResult
};
await service.stop();
process.stdout.write(JSON.stringify(result));
`;

    const { stdout } = await run(
      process.execPath,
      [
        "--conditions=source",
        "--import",
        "tsx",
        "--input-type=module",
        "--eval",
        script,
        rootDir,
        join(workDir, "data"),
      ],
      { cwd: resolve(import.meta.dirname, "../../..") },
    );

    expect(JSON.parse(stdout)).toEqual({
      status: "running",
      statusDetail: null,
      value: ["loaded", "function"],
    });
  });

  it("preserves cross-plugin dynamic imports across source reloads", async () => {
    const workDir = await mkdtemp(
      join(tmpdir(), "omnyo-native-source-reload-"),
    );

    tempDirs.push(workDir);
    const importedDir = join(workDir, "omnyo-plugin-imported");
    const importerDir = join(workDir, "omnyo-plugin-importer");
    await mkdir(importedDir, { recursive: true });
    await mkdir(importerDir, { recursive: true });

    const importedSharedSpecifier =
      process.platform === "win32"
        ? "../omnyo-plugin-imported/shared.js"
        : join(importedDir, "shared.js");

    const packageJson = (name: string) =>
      JSON.stringify({
        name,
        version: "0.1.0",
        type: "module",
        omnyo: {
          name,
          description: "Native reload fixture.",
          branding: { icon: "Zap" },
          server: "./server.js",
        },
      });

    await writeFile(
      join(importedDir, "package.json"),
      packageJson("omnyo-plugin-imported"),
    );
    await writeFile(
      join(importerDir, "package.json"),
      packageJson("omnyo-plugin-importer"),
    );
    await writeFile(
      join(importedDir, "server.js"),
      `export default function plugin() {}
`,
    );
    await writeFile(
      join(importedDir, "shared.js"),
      `export const value = "before";
`,
    );
    await writeFile(
      join(importerDir, "server.js"),
      `export default function plugin() {
  globalThis.__readImportedPlugin = async () =>
    (await import(${JSON.stringify(importedSharedSpecifier)})).value;
}
`,
    );

    const serviceUrl = pathToFileURL(
      resolve(
        import.meta.dirname,
        "../../../src/services/plugins/plugin-service.ts",
      ),
    ).href;

    const aiRegistryUrl = pathToFileURL(
      resolve(
        import.meta.dirname,
        "../../../src/services/ai/ai-service-registry.ts",
      ),
    ).href;

    const telemetryUrl = pathToFileURL(
      resolve(import.meta.dirname, "../../../src/services/system/telemetry.ts"),
    ).href;

    const script = `
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import pino from "pino";
import { createConnection, migrate } from "@omnyo/db";
import { openSecretVault } from "@omnyo/secret-storage";
import { createPluginService } from ${JSON.stringify(serviceUrl)};
import { createAiServiceRegistry } from ${JSON.stringify(aiRegistryUrl)};
import { createNoopTelemetryService } from ${JSON.stringify(telemetryUrl)};
const [importedDir, importerDir, dataDir] = process.argv.slice(1);
const db = createConnection(":memory:");
migrate(db);
const service = createPluginService({
  aiServices: createAiServiceRegistry(),
  telemetry: createNoopTelemetryService(),
  db,
  hub: {
    getDaemonSessionIdForHost: () => null,
    notifyPluginSignal: () => 0,
    notifySystem: () => {}
  },
  logger: pino({ enabled: false }),
  dataDir,
  vault: await openSecretVault(dataDir),
  appVersion: "0.9.0",
  loadTimeoutMs: 2000
});
await service.installPath(importedDir);
await service.installPath(importerDir);
const read = globalThis.__readImportedPlugin;
const before = await read();
await writeFile(join(importedDir, "shared.js"), 'export const value = "after";\\n');
await service.reload("imported");
const after = await read();
await service.stop();
process.stdout.write(JSON.stringify({ before, after }));
`;

    const { stdout } = await run(
      process.execPath,
      [
        "--conditions=source",
        "--import",
        "tsx",
        "--input-type=module",
        "--eval",
        script,
        importedDir,
        importerDir,
        join(workDir, "data"),
      ],
      { cwd: resolve(import.meta.dirname, "../../..") },
    );

    expect(JSON.parse(stdout)).toEqual({ before: "before", after: "after" });
  });
});
