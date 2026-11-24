import {
  mkdtemp,
  mkdir,
  readdir,
  readFile,
  realpath,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createConnection,
  migrate,
  createPluginArtifact,
  upsertInstalledPlugin,
  type DbConnection,
} from "@omnyo/db";
import {
  derivePluginId,
  PLUGIN_RUNTIME_ABI,
  PLUGIN_SDK_MAJOR,
  PLUGIN_SDK_PACKAGE_NAME,
  PLUGIN_SDK_VERSION,
} from "@omnyo/domain";
import type { Logger } from "@omnyo/logger";
import { createAiServiceRegistry } from "../../../src/services/ai/ai-service-registry.js";
import {
  createPluginService,
  type PluginService,
} from "../../../src/services/plugins/plugin-service.js";
import { testLogger } from "../../helpers/test-app.js";
import { createNoopTelemetryService } from "../../../src/services/system/telemetry.js";
import {
  buildPluginServer,
  buildPluginApp,
  buildPluginHost,
  resolvePluginBuildToolchain,
} from "@omnyo/plugin-build";
import { hashInstallDir } from "../../../src/services/plugins/install-sources.js";
import { openSecretVault } from "@omnyo/secret-storage";

const logger = testLogger as unknown as Logger;

function gitPersistence(url: string, requestedRef: string) {
  return {
    provenance: { kind: "direct" } as const,
    sourceIntent: {
      kind: "git" as const,
      url,
      subdirectory: null,
      selector: {
        kind: "ref" as const,
        ref: requestedRef,
        refKind: "branch" as const,
      },
    },
    exactResolution: { kind: "git" as const, commit: "test-commit" },
    updateState: {
      lastCheckAt: null,
      availableCompatibleVersion: null,
      newestIncompatibleVersion: null,
      statusDetail: null,
    },
    activeArtifactId: null,
  };
}

const THROWING_SERVER_TS = `throw new Error("source must not load");\n`;

const PREBUILT_SERVER_JS = `export default async function plugin(api) {
  api.log.info("dist");
  globalThis.__prebuiltDistLoads = (globalThis.__prebuiltDistLoads ?? 0) + 1;
}
`;

describe("prebuilt server bundle loading", () => {
  let db: DbConnection;
  let workDir: string;
  let service: PluginService;

  beforeEach(async () => {
    db = createConnection(":memory:");
    migrate(db);
    workDir = await realpath(
      await mkdtemp(join(tmpdir(), "omnyo-plugin-prebuilt-")),
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
    Reflect.deleteProperty(globalThis, "__immutablePathLoads");
    Reflect.deleteProperty(globalThis, "__hostZodParse");
    Reflect.deleteProperty(globalThis, "__ownZodOwner");
    await service.stop();
    await rm(workDir, { recursive: true, force: true });
  });

  it("executes verified immutable path server bytes and preserves checked app and host bundles without rebuilding sources", async () => {
    const selected = join(workDir, "data/plugins/cache/selected-path");
    await mkdir(selected, { recursive: true });
    const rootDir = await realpath(selected);
    await writeFile(
      join(rootDir, "package.json"),
      JSON.stringify({
        name: "omnyo-plugin-immutable-path",
        version: "1.0.0",
        type: "module",
        omnyo: {
          name: "Immutable fixture",
          description: "Actual rebuilt artifacts",
          branding: { icon: "Zap" },
          server: "server.ts",
          app: "app.ts",
          host: "host.ts",
        },
      }),
    );
    await writeFile(
      join(rootDir, "server.ts"),
      "export default function setup(){globalThis.__immutablePathLoads=(globalThis.__immutablePathLoads??0)+1};\n",
    );
    await writeFile(
      join(rootDir, "app.ts"),
      "export default function app(){}\n",
    );
    await writeFile(
      join(rootDir, "host.ts"),
      "export default function host(){}\n",
    );

    const toolchain = await resolvePluginBuildToolchain(
      join(workDir, "toolchain"),
    );

    await buildPluginServer(rootDir, "0.9.0", toolchain);
    await buildPluginApp(rootDir, "0.9.0", toolchain);
    await buildPluginHost(rootDir, "0.9.0", toolchain);

    for (const surface of ["server", "app", "host"])
      await writeFile(
        join(rootDir, `${surface}.ts`),
        'throw new Error("immutable source must never rebuild")\n',
      );
    const contentHash = await hashInstallDir(rootDir);
    createPluginArtifact(db, {
      id: "selected-immutable-path",
      pluginId: "immutable-path",
      sourceKind: "path",
      npmResolvedVersion: null,
      gitResolvedCommit: null,
      gitCheckoutRoot: null,
      integrity: null,
      path: rootDir,
      contentHash,
      validationResult: "valid",
      validatedAt: 17,
    });
    upsertInstalledPlugin(db, {
      id: "immutable-path",
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
      activeArtifactId: "selected-immutable-path",
      rootDir,
      version: "1.0.0",
      enabled: true,
      enabledFollowsDefault: false,
    });
    Reflect.set(globalThis, "__immutablePathLoads", 0);
    await service.reload("immutable-path");
    expect(
      service.list().find((plugin) => plugin.id === "immutable-path")
        ?.statusDetail,
    ).toBeNull();
    expect(
      service.list().find((plugin) => plugin.id === "immutable-path"),
    ).toMatchObject({ status: "running", statusDetail: null });
    expect(Reflect.get(globalThis, "__immutablePathLoads")).toBe(1);
    expect(await hashInstallDir(rootDir)).toBe(contentHash);
    await service.reload("immutable-path");
    expect(Reflect.get(globalThis, "__immutablePathLoads")).toBe(2);
    await writeFile(
      join(rootDir, "dist/server.js"),
      'throw new Error("tampered bundle must not run")\n',
    );
    await service.reload("immutable-path");
    expect(Reflect.get(globalThis, "__immutablePathLoads")).toBe(2);
    expect(
      service.list().find((plugin) => plugin.id === "immutable-path")
        ?.statusDetail,
    ).toMatch(/Immutable installed plugin bytes/);
  });

  async function installImmutableZodArtifact(args: {
    id: string;
    hostProvidedZod: boolean;
    serverSource: string;
    pluginZod?: string;
  }): Promise<string> {
    const cacheDir = join(workDir, `data/plugins/cache/${args.id}`);
    await mkdir(cacheDir, { recursive: true });
    const rootDir = await realpath(cacheDir);
    await writeFile(
      join(rootDir, "package.json"),
      JSON.stringify({
        name: `omnyo-plugin-${args.id}`,
        version: "1.0.0",
        type: "module",
        omnyo: {
          name: "Immutable zod fixture",
          description: "Installed artifact importing zod",
          branding: { icon: "Zap" },
          server: "server.ts",
        },
      }),
    );
    await writeFile(join(rootDir, "server.ts"), args.serverSource);

    if (args.pluginZod !== undefined) {
      const zodDir = join(rootDir, "node_modules/zod");
      await mkdir(zodDir, { recursive: true });
      await writeFile(
        join(zodDir, "package.json"),
        JSON.stringify({
          name: "zod",
          type: "module",
          exports: { ".": "./index.js" },
        }),
      );
      await writeFile(join(zodDir, "index.js"), args.pluginZod);
    }

    await buildPluginServer(
      rootDir,
      "0.9.0",
      await resolvePluginBuildToolchain(join(workDir, "toolchain")),
      { hostProvidedZod: args.hostProvidedZod },
    );
    await rm(join(rootDir, "node_modules"), { recursive: true, force: true });
    await writeFile(
      join(rootDir, "server.ts"),
      'throw new Error("immutable source must never rebuild")\n',
    );
    const contentHash = await hashInstallDir(rootDir);
    createPluginArtifact(db, {
      id: `identity_v1_${args.id}`,
      pluginId: args.id,
      sourceKind: "path",
      npmResolvedVersion: null,
      gitResolvedCommit: null,
      gitCheckoutRoot: null,
      integrity: null,
      path: rootDir,
      contentHash,
      validationResult: "valid",
      validatedAt: 17,
    });
    upsertInstalledPlugin(db, {
      id: args.id,
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
      activeArtifactId: `identity_v1_${args.id}`,
      rootDir,
      version: "1.0.0",
      enabled: true,
      enabledFollowsDefault: false,
    });

    return rootDir;
  }

  function runServerNatively(rootDir: string): void {
    const loaded: unknown = createRequire(import.meta.url)(
      join(rootDir, "dist/server.js"),
    );

    const factory: unknown =
      typeof loaded === "object" && loaded !== null
        ? Reflect.get(loaded, "default")
        : undefined;

    if (typeof factory !== "function")
      throw new Error("server bundle has no default factory");
    factory();
  }

  it("serves the server's zod to an immutable artifact built to import it from the host", async () => {
    const rootDir = await installImmutableZodArtifact({
      id: "host-zod",
      hostProvidedZod: true,
      serverSource:
        'import { z } from "zod";\nexport default function setup(){globalThis.__hostZodParse=z.string().parse("host-zod")};\n',
    });

    expect(await readFile(join(rootDir, "dist/server.js"), "utf8")).toMatch(
      /from\s*"zod"/,
    );
    await expect(
      stat(join(rootDir, "node_modules")).catch(() => null),
    ).resolves.toBeNull();

    await service.reload("host-zod");

    expect(
      service.list().find((plugin) => plugin.id === "host-zod"),
    ).toMatchObject({ status: "running", statusDetail: null });
    expect(Reflect.get(globalThis, "__hostZodParse")).toBe("host-zod");
    Reflect.deleteProperty(globalThis, "__hostZodParse");
    runServerNatively(rootDir);
    expect(Reflect.get(globalThis, "__hostZodParse")).toBe("host-zod");
  });

  it("leaves an immutable artifact that bundled its own zod on that zod", async () => {
    const rootDir = await installImmutableZodArtifact({
      id: "own-zod",
      hostProvidedZod: false,
      serverSource:
        'import { z } from "zod";\nexport default function setup(){globalThis.__ownZodOwner=z.owner};\n',
      pluginZod: 'export const z = { owner: "plugin" };\n',
    });

    expect(await readFile(join(rootDir, "dist/server.js"), "utf8")).not.toMatch(
      /from\s*"zod"/,
    );

    await service.reload("own-zod");

    expect(
      service.list().find((plugin) => plugin.id === "own-zod"),
    ).toMatchObject({ status: "running", statusDetail: null });
    expect(Reflect.get(globalThis, "__ownZodOwner")).toBe("plugin");
    Reflect.deleteProperty(globalThis, "__ownZodOwner");
    runServerNatively(rootDir);
    expect(Reflect.get(globalThis, "__ownZodOwner")).toBe("plugin");
  });

  async function writePrebuiltPlugin(
    name: string,
    options: { sdkMajor?: number; sdkVersion?: string } = {},
  ): Promise<string> {
    const rootDir = join(workDir, name);
    await mkdir(join(rootDir, "dist"), { recursive: true });
    await writeFile(
      join(rootDir, "package.json"),
      JSON.stringify({
        name,
        version: "0.1.0",
        type: "commonjs",
        omnyo: {
          name: "Prebuilt server fixture",
          description: "Prebuilt plugin server fixture.",
          branding: { icon: "Zap" },
          server: "./server.ts",
        },
      }),
    );
    await writeFile(join(rootDir, "server.ts"), THROWING_SERVER_TS);
    await writeFile(join(rootDir, "dist", "server.js"), PREBUILT_SERVER_JS);
    const sdkVersion = options.sdkVersion ?? PLUGIN_SDK_VERSION;
    await writeFile(
      join(rootDir, "dist", "server.meta.json"),
      JSON.stringify({
        sdkMajor: options.sdkMajor ?? PLUGIN_SDK_MAJOR,
        sdkVersion,
        artifactFormatVersion: 2,
        sdkPackage: PLUGIN_SDK_PACKAGE_NAME,
        runtimeAbi: PLUGIN_RUNTIME_ABI,
        pluginId: derivePluginId(name),
        pluginVersion: "0.1.0",
        builtWith: { coreVersion: "0.0.0-test", pluginSdkVersion: sdkVersion },
      }),
    );

    return rootDir;
  }

  it("loads a compatible ESM prebuild from a CommonJS plugin package", async () => {
    const rootDir = await writePrebuiltPlugin("omnyo-plugin-gitdist");
    upsertInstalledPlugin(db, {
      ...gitPersistence("https://github.com/acme/omnyo-plugin-gitdist", "v1"),
      id: "gitdist",
      source: "git:github.com/acme/omnyo-plugin-gitdist@v1",
      rootDir,
      version: "0.1.0",
      enabled: true,
      enabledFollowsDefault: false,
    });

    const before =
      ((globalThis as Record<string, unknown>).__prebuiltDistLoads as
        | number
        | undefined) ?? 0;

    await service.reload("gitdist");

    const entry = service.list().find((plugin) => plugin.id === "gitdist");
    expect(entry?.status).toBe("running");
    expect(entry?.statusDetail).toBeNull();
    expect((globalThis as Record<string, unknown>).__prebuiltDistLoads).toBe(
      before + 1,
    );

    await service.reload("gitdist");
    expect((globalThis as Record<string, unknown>).__prebuiltDistLoads).toBe(
      before + 2,
    );
  });

  it("compiles path source into a reusable cache and rebuilds after edits", async () => {
    const rootDir = await writePrebuiltPlugin("omnyo-plugin-pathcache");
    const sourcePath = join(rootDir, "server.ts");
    await writeFile(
      sourcePath,
      `const value: string = "first";
export default function plugin() {
  globalThis.__pathCacheValue = value;
  globalThis.__pathCacheLoads = (globalThis.__pathCacheLoads ?? 0) + 1;
}
`,
    );

    const installed = await service.installPath(rootDir);
    expect(installed.status).toBe("running");
    expect((globalThis as Record<string, unknown>).__pathCacheValue).toBe(
      "first",
    );

    const cacheRoot = join(workDir, "data", "plugins", "runtime", "server");
    const firstFiles = await readdir(cacheRoot, { recursive: true });
    const firstServer = firstFiles.find((file) => file.endsWith("server.cjs"));
    expect(firstServer).toBeDefined();
    const firstServerPath = join(cacheRoot, firstServer!);
    const firstMtime = (await stat(firstServerPath)).mtimeMs;

    await service.reload("pathcache");
    expect((await stat(firstServerPath)).mtimeMs).toBe(firstMtime);
    expect((globalThis as Record<string, unknown>).__pathCacheLoads).toBe(2);

    await writeFile(
      sourcePath,
      `const value: string = "second";
export default function plugin() {
  globalThis.__pathCacheValue = value;
  globalThis.__pathCacheLoads = (globalThis.__pathCacheLoads ?? 0) + 1;
}
`,
    );
    await service.reload("pathcache");

    expect((globalThis as Record<string, unknown>).__pathCacheValue).toBe(
      "second",
    );
    expect((globalThis as Record<string, unknown>).__pathCacheLoads).toBe(3);
    const updatedFiles = await readdir(cacheRoot, { recursive: true });
    expect(
      updatedFiles.filter((file) => file.endsWith("server.cjs")),
    ).toHaveLength(2);
  });

  it("bounds compiled artifacts and evicts loaded source modules", async () => {
    const rootDir = await writePrebuiltPlugin("omnyo-plugin-reload-retention");
    const sourcePath = join(rootDir, "server.ts");
    const cacheRoot = join(workDir, "data", "plugins", "runtime", "server");

    for (let generation = 0; generation < 8; generation += 1) {
      await writeFile(
        sourcePath,
        `export default function plugin() { globalThis.__reloadRetention = ${generation}; }\n`,
      );

      if (generation === 0) await service.installPath(rootDir);
      else await service.reload("reload-retention");
    }

    expect((globalThis as Record<string, unknown>).__reloadRetention).toBe(7);
    const files = await readdir(cacheRoot, { recursive: true });
    expect(files.filter((file) => file.endsWith("server.cjs"))).toHaveLength(4);
    const cache = createRequire(import.meta.url).cache;
    expect(
      Object.keys(cache).filter((path) => path.startsWith(cacheRoot)),
    ).toEqual([]);
    expect(
      Object.values(cache)
        .flatMap((entry) => entry?.children ?? [])
        .filter((entry) => entry.filename.startsWith(cacheRoot)),
    ).toEqual([]);
  });

  it("re-evaluates and evicts compiled modules when the data directory is a symlink", async () => {
    const realDataDir = join(workDir, "real-data");
    const linkedDataDir = join(workDir, "linked-data");
    await mkdir(realDataDir);
    await symlink(realDataDir, linkedDataDir, "dir");
    const linkedDb = createConnection(":memory:");
    migrate(linkedDb);

    const linkedService = createPluginService({
      aiServices: createAiServiceRegistry(),
      telemetry: createNoopTelemetryService(),
      db: linkedDb,
      hub: {
        getDaemonSessionIdForHost: () => null,
        notifyPluginSignal: () => 0,
        notifySystem: () => {},
      },
      logger,
      dataDir: linkedDataDir,
      vault: await openSecretVault(linkedDataDir),
      appVersion: "0.9.0",
      loadTimeoutMs: 2000,
    });

    const state = globalThis as Record<string, unknown>;
    state.__symlinkEvaluations = 0;

    try {
      const rootDir = await writePrebuiltPlugin("omnyo-plugin-symlink-data");
      const sourcePath = join(rootDir, "server.ts");
      await writeFile(
        sourcePath,
        `globalThis.__symlinkEvaluations += 1;\nexport default function plugin() {}\n`,
      );
      await linkedService.installPath(rootDir);
      await linkedService.reload("symlink-data");
      await linkedService.reload("symlink-data");
      expect(state.__symlinkEvaluations).toBe(3);

      for (let generation = 0; generation < 3; generation += 1) {
        await writeFile(
          sourcePath,
          `globalThis.__symlinkEvaluations += 1;\nexport const generation = ${generation};\nexport default function plugin() {}\n`,
        );
        await linkedService.reload("symlink-data");
      }

      expect(state.__symlinkEvaluations).toBe(6);

      const cacheRoot = await realpath(
        join(realDataDir, "plugins", "runtime", "server"),
      );

      const cache = createRequire(import.meta.url).cache;
      expect(
        Object.keys(cache).filter((path) => path.startsWith(cacheRoot)),
      ).toEqual([]);
      expect(
        Object.values(cache)
          .flatMap((entry) => entry?.children ?? [])
          .filter((entry) => entry.filename.startsWith(cacheRoot)),
      ).toEqual([]);
    } finally {
      await linkedService.stop();
      delete state.__symlinkEvaluations;
    }
  });

  it("pre-1.0: falls back to source when the dist SDK version differs within major 0", async () => {
    const rootDir = await writePrebuiltPlugin("omnyo-plugin-minordist", {
      sdkMajor: PLUGIN_SDK_MAJOR,
      sdkVersion: `${PLUGIN_SDK_MAJOR}.999.0`,
    });

    upsertInstalledPlugin(db, {
      ...gitPersistence("https://github.com/acme/omnyo-plugin-minordist", "v1"),
      id: "minordist",
      source: "git:github.com/acme/omnyo-plugin-minordist@v1",
      rootDir,
      version: "0.1.0",
      enabled: true,
      enabledFollowsDefault: false,
    });
    await service.reload("minordist");

    const entry = service.list().find((plugin) => plugin.id === "minordist");
    expect(entry?.status).toBe("error");
    expect(entry?.statusDetail).toContain("source must not load");
  });

  it("falls back to source when the dist meta's SDK major mismatches", async () => {
    const rootDir = await writePrebuiltPlugin("omnyo-plugin-staledist", {
      sdkMajor: 999,
      sdkVersion: "999.0.0",
    });

    upsertInstalledPlugin(db, {
      ...gitPersistence("https://github.com/acme/omnyo-plugin-staledist", "v1"),
      id: "staledist",
      source: "git:github.com/acme/omnyo-plugin-staledist@v1",
      rootDir,
      version: "0.1.0",
      enabled: true,
      enabledFollowsDefault: false,
    });
    await service.reload("staledist");

    const entry = service.list().find((plugin) => plugin.id === "staledist");
    expect(entry?.status).toBe("error");
    expect(entry?.statusDetail).toContain("source must not load");
  });
});
