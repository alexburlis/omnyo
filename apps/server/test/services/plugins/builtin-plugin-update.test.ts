import { createHash } from "node:crypto";
import { createServer } from "node:http";
import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import {
  createConnection,
  getInstalledPlugin,
  getPluginArtifact,
  migrate,
  setPluginSettingsValues,
  setInstalledPluginEnabled,
  getPluginSettingsValues,
} from "@omnyo/db";
import {
  PLUGIN_SDK_MAJOR,
  PLUGIN_SDK_VERSION,
  PLUGIN_SDK_PACKAGE_NAME,
  PLUGIN_RUNTIME_ABI,
} from "@omnyo/domain";
import type { PluginApplyUpdateRequest } from "@omnyo/server-contract";
import {
  createPluginService,
  type PluginService,
} from "../../../src/services/plugins/plugin-service.js";
import { createAiServiceRegistry } from "../../../src/services/ai/ai-service-registry.js";
import { createNoopTelemetryService } from "../../../src/services/system/telemetry.js";
import { setServerUpdateDraining } from "../../../src/services/system/server-update-drain.js";

import { verifyBuiltinPluginArtifact } from "../../../src/services/plugins/builtin-plugin-artifacts.js";
import { openSecretVault } from "@omnyo/secret-storage";

const disposers: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const dispose of disposers.splice(0).reverse()) await dispose();
});

function files(
  version: string,
  source = `export default function plugin(api) {
    const schema = { "~standard": { version: 1, vendor: "fixture", validate: value => ({ value }) } };
    api.rpc.register({ version: { input: schema, output: schema } }, { version: () => ${JSON.stringify(version)} });
  }`,
  engines = {},
) {
  return {
    "package.json": JSON.stringify({
      name: "omnyo-plugin-omnyo--fixture",
      type: "module",
      version,
      engines,
      omnyo: {
        name: "Builtin fixture",
        description: "Independent artifact fixture",
        branding: { icon: "Zap" },
        server: "./dist/server.js",
        app: "./dist/app.js",
      },
    }),
    "dist/server.js": source,
    "dist/app.js": `export default function app() { return ${JSON.stringify(version)}; }`,
    "dist/server.meta.json": JSON.stringify({
      artifactFormatVersion: 2,
      sdkPackage: PLUGIN_SDK_PACKAGE_NAME,
      runtimeAbi: PLUGIN_RUNTIME_ABI,
      pluginId: "omnyo--fixture",
      pluginVersion: version,
      sdkMajor: PLUGIN_SDK_MAJOR,
      sdkVersion: PLUGIN_SDK_VERSION,
      builtWith: { coreVersion: "1.0.0", pluginSdkVersion: PLUGIN_SDK_VERSION },
    }),
    "dist/app.meta.json": JSON.stringify({
      artifactFormatVersion: 2,
      sdkPackage: PLUGIN_SDK_PACKAGE_NAME,
      runtimeAbi: PLUGIN_RUNTIME_ABI,
      pluginId: "omnyo--fixture",
      pluginVersion: version,
      sdkMajor: PLUGIN_SDK_MAJOR,
      sdkVersion: PLUGIN_SDK_VERSION,
      builtWith: { coreVersion: "1.0.0", pluginSdkVersion: PLUGIN_SDK_VERSION },
    }),
  };
}

async function fixture(
  options: {
    stabilizationWindowMs?: number;
    scheduleStabilizationWindow?: (
      durationMs: number,
      onElapsed: () => void,
    ) => () => void;
  } = {},
) {
  const root = await mkdtemp(join(tmpdir(), "omnyo-builtin-update-"));
  disposers.push(() => rm(root, { recursive: true, force: true }));
  const packaged = join(root, "packaged");

  const bundled = {
    name: "fixture",
    pluginId: "omnyo--fixture",
    rootDir: packaged,
    autoInstall: true,
    defaultEnabled: true,
  };

  for (const [path, content] of Object.entries(files("1.0.0"))) {
    await mkdir(join(packaged, path, ".."), { recursive: true });
    await writeFile(join(packaged, path), content);
  }

  const db = createConnection(":memory:");
  migrate(db);
  disposers.push(async () => {
    db.$client.close();
  });
  let service: PluginService | undefined;

  const restart = async () => {
    await service?.stop();

    const current = createPluginService({
      db,
      aiServices: createAiServiceRegistry(),
      telemetry: createNoopTelemetryService(),
      hub: {
        getDaemonSessionIdForHost: () => null,
        notifyPluginSignal: () => 0,
        notifySystem: () => {},
      },
      logger: {
        debug() {},
        error() {},
        info() {},
        warn() {},
      },
      dataDir: join(root, "data"),
      vault: await openSecretVault(join(root, "data")),
      appVersion: "1.0.0",
      bundledPlugins: [bundled],
      stabilizationWindowMs: options.stabilizationWindowMs ?? 0,
      ...(options.scheduleStabilizationWindow === undefined
        ? {}
        : { scheduleStabilizationWindow: options.scheduleStabilizationWindow }),
    });

    service = current;
    await current.start();

    return current;
  };

  const initialService = await restart();
  expect(
    initialService.list().find((plugin) => plugin.id === "omnyo--fixture")
      ?.status,
    JSON.stringify(initialService.list()),
  ).toBe("running");
  disposers.push(async () => {
    await service?.stop();
  });

  function candidate(contents = files("1.0.1")): PluginApplyUpdateRequest {
    const row = getInstalledPlugin(db, "omnyo--fixture");

    if (row === undefined) throw new Error("Fixture not registered");

    return {
      bundledCandidate: {
        expectedVersion: row.version,
        expectedArtifactId: row.activeArtifactId,
        files: Object.entries(contents).map(([path, content]) => ({
          path,
          base64: Buffer.from(content).toString("base64"),
          sha256: createHash("sha256").update(content).digest("hex"),
        })),
      },
    };
  }

  return {
    db,
    dataDir: join(root, "data"),
    service: initialService,
    restart,
    candidate,
    bundled,
  };
}

async function version(service: PluginService) {
  const handler = service.getRpcHandler("omnyo--fixture", "version");

  if (handler.outcome !== "found") throw new Error("Version RPC missing");

  return service.invokeRpcHandler(
    handler.owner,
    "version",
    handler.value,
    null,
    { kind: "client" },
    null,
  );
}

it("retains delivered builtin fixes while a runtime restart fences activation", async () => {
  const f = await fixture();
  setServerUpdateDraining(f.db, true);

  try {
    expect(
      await f.service.applyUpdate("omnyo--fixture", f.candidate()),
    ).toMatchObject({
      ok: false,
      error: expect.stringContaining("runtime is restarting"),
    });
    await f.service.flushRegistrationOperations();
    expect(getInstalledPlugin(f.db, "omnyo--fixture")).toMatchObject({
      version: "1.0.0",
      activeArtifactId: null,
    });
    expect(await version(f.service)).toEqual({ ok: true, result: "1.0.0" });
  } finally {
    setServerUpdateDraining(f.db, false);
  }

  expect(
    (await f.service.applyUpdate("omnyo--fixture", f.candidate())).ok,
  ).toBe(true);
  expect(await version(f.service)).toEqual({ ok: true, result: "1.0.1" });
});

it("flushes a failed in-flight builtin activation through rollback before runtime delivery verification", async () => {
  let failService = () => {};

  let received = () => {};

  const requested = new Promise<void>((resolve) => {
    received = resolve;
  });

  const failure = createServer((_request, response) => {
    failService = () => {
      response.statusCode = 500;
      response.end();
    };

    received();
  });

  await new Promise<void>((resolve) => failure.listen(0, "127.0.0.1", resolve));
  disposers.push(async () => {
    failure.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      failure.close((error) => (error ? reject(error) : resolve())),
    );
  });
  const address = failure.address();

  if (address === null || typeof address === "string")
    throw new Error("Failure fixture did not listen");
  let reachedWindow = () => {};

  const stabilizing = new Promise<void>((resolve) => {
    reachedWindow = resolve;
  });

  const f = await fixture({
    stabilizationWindowMs: 1,
    scheduleStabilizationWindow: () => {
      reachedWindow();

      return () => {};
    },
  });

  const updating = f.service.applyUpdate(
    "omnyo--fixture",
    f.candidate(
      files(
        "1.0.1",
        `export default function plugin(api) {
      api.background.service("pending-rollback", { async start() {
        const response = await fetch("http://127.0.0.1:${address.port}/");
        if (!response.ok) throw new Error("candidate failed while restart waited");
      }});
    }`,
      ),
    ),
  );

  await Promise.all([stabilizing, requested]);
  expect(getInstalledPlugin(f.db, "omnyo--fixture")?.version).toBe("1.0.1");
  setServerUpdateDraining(f.db, true);
  let flushed = false;

  const flushing = f.service.flushRegistrationOperations().then(() => {
    flushed = true;
  });

  await Promise.resolve();
  expect(flushed).toBe(false);
  failService();

  try {
    expect((await updating).ok).toBe(false);
    await flushing;
    expect(getInstalledPlugin(f.db, "omnyo--fixture")).toMatchObject({
      version: "1.0.0",
      activeArtifactId: null,
    });
    expect(await version(f.service)).toEqual({ ok: true, result: "1.0.0" });
  } finally {
    setServerUpdateDraining(f.db, false);
  }
});

it("activates a built builtin artifact and retains state and served bytes across restart and reload", async () => {
  const f = await fixture();
  expect(await version(f.service)).toEqual({ ok: true, result: "1.0.0" });
  setPluginSettingsValues(f.db, "omnyo--fixture", { retained: "value" });
  const outcome = await f.service.applyUpdate("omnyo--fixture", f.candidate());
  expect(outcome.ok, JSON.stringify(outcome)).toBe(true);
  expect(outcome).toMatchObject({
    ok: true,
    result: { applied: true, to: { version: "1.0.1" } },
  });
  expect(await version(f.service)).toEqual({ ok: true, result: "1.0.1" });
  await f.service.resumeMaintenancePlugins();
  expect(await version(f.service)).toEqual({ ok: true, result: "1.0.1" });
  const row = getInstalledPlugin(f.db, "omnyo--fixture");
  expect(row).toMatchObject({
    sourceKind: "builtin",
    version: "1.0.1",
    enabled: true,
  });
  expect(row?.activeArtifactId).not.toBeNull();
  expect(
    (await f.service.getSource("omnyo--fixture"))?.history[0]?.version,
  ).toMatch(/^builtin:[a-f0-9]{64}$/u);

  if (row === undefined) throw new Error("missing row");
  expect(await readFile(join(row.rootDir, "dist/app.js"), "utf8")).toContain(
    "1.0.1",
  );
  expect(getPluginSettingsValues(f.db, "omnyo--fixture")).toEqual({
    retained: "value",
  });
  const service = await f.restart();
  expect(getInstalledPlugin(f.db, "omnyo--fixture")?.activeArtifactId).toBe(
    row?.activeArtifactId,
  );
  expect((await service.reload("omnyo--fixture")).ok).toBe(true);
  expect(await version(service)).toEqual({ ok: true, result: "1.0.1" });
  expect(
    service.list().find((plugin) => plugin.id === "omnyo--fixture")?.status,
  ).toBe("running");
  f.bundled.defaultEnabled = false;
  await f.restart();
  expect(getInstalledPlugin(f.db, "omnyo--fixture")).toMatchObject({
    enabled: false,
    enabledFollowsDefault: true,
    activeArtifactId: row.activeArtifactId,
  });
  setInstalledPluginEnabled(f.db, "omnyo--fixture", true);
  await f.restart();
  expect(getInstalledPlugin(f.db, "omnyo--fixture")).toMatchObject({
    enabled: true,
    enabledFollowsDefault: false,
    activeArtifactId: row.activeArtifactId,
  });
});

it("retires an override once a different runtime bundles its own copy", async () => {
  const f = await fixture();
  setPluginSettingsValues(f.db, "omnyo--fixture", { retained: "value" });
  const outcome = await f.service.applyUpdate("omnyo--fixture", f.candidate());
  expect(outcome.ok, JSON.stringify(outcome)).toBe(true);
  const override = getInstalledPlugin(f.db, "omnyo--fixture")?.activeArtifactId;
  expect(override).not.toBeNull();
  const nextRuntime = join(f.bundled.rootDir, "..", "next-runtime");

  for (const [path, content] of Object.entries(files("1.0.2"))) {
    await mkdir(join(nextRuntime, path, ".."), { recursive: true });
    await writeFile(join(nextRuntime, path), content);
  }

  f.bundled.rootDir = nextRuntime;
  const service = await f.restart();
  expect(await version(service)).toEqual({ ok: true, result: "1.0.2" });
  expect(getInstalledPlugin(f.db, "omnyo--fixture")).toMatchObject({
    activeArtifactId: null,
    rootDir: nextRuntime,
    version: "1.0.2",
    enabled: true,
  });
  expect(getPluginSettingsValues(f.db, "omnyo--fixture")).toEqual({
    retained: "value",
  });
});

it("rejects stale, incompatible, corrupt and traversing candidates before switching the builtin", async () => {
  const f = await fixture();
  const bad = f.candidate();

  if (bad.bundledCandidate === undefined) throw new Error("missing candidate");
  bad.bundledCandidate.files[0].path = "../package.json";

  const incompatible = f.candidate(
    files("1.0.1", undefined, { omnyoPluginSdk: ">=999.0.0" }),
  );

  const corrupt = f.candidate();

  if (corrupt.bundledCandidate === undefined)
    throw new Error("missing candidate");
  corrupt.bundledCandidate.files[0].sha256 = "0".repeat(64);
  const stale = f.candidate();

  if (stale.bundledCandidate === undefined)
    throw new Error("missing candidate");
  stale.bundledCandidate.expectedVersion = "0.0.0";
  const wrong = files("1.0.1");
  wrong["package.json"] = wrong["package.json"].replace(
    "omnyo-plugin-omnyo--fixture",
    "omnyo-plugin-omnyo--other",
  );
  const missing = f.candidate();

  if (missing.bundledCandidate === undefined)
    throw new Error("missing candidate");
  missing.bundledCandidate.files = missing.bundledCandidate.files.filter(
    (file) => file.path !== "dist/server.js",
  );
  const host = f.candidate();

  if (host.bundledCandidate === undefined) throw new Error("missing candidate");
  const hostPackage = JSON.parse(files("1.0.1")["package.json"]);
  hostPackage.omnyo.host = "./dist/host.js";

  const hostFiles = {
    "package.json": JSON.stringify(hostPackage),
    "dist/host.js": "export default function host() {}",
    "dist/host.meta.json": JSON.stringify({
      ...JSON.parse(files("1.0.1")["dist/server.meta.json"]),
      artifactDigest: "0".repeat(64),
    }),
  };

  const hostCandidate = f.candidate({ ...files("1.0.1"), ...hostFiles });

  for (const request of [
    bad,
    incompatible,
    corrupt,
    stale,
    f.candidate(wrong),
    missing,
    hostCandidate,
  ]) {
    expect((await f.service.applyUpdate("omnyo--fixture", request)).ok).toBe(
      false,
    );
    expect(getInstalledPlugin(f.db, "omnyo--fixture")?.version).toBe("1.0.0");
    expect(
      f.service.list().find((plugin) => plugin.id === "omnyo--fixture")?.status,
    ).toBe("running");
    expect(await version(f.service)).toEqual({ ok: true, result: "1.0.0" });
  }
});

it("restores the previous builtin after failed activation and refuses tampered bytes on restart", async () => {
  const f = await fixture();
  expect(
    (
      await f.service.applyUpdate(
        "omnyo--fixture",
        f.candidate(
          files(
            "1.0.1",
            "export default function plugin() { throw new Error('candidate failure'); }",
          ),
        ),
      )
    ).ok,
  ).toBe(false);
  expect(getInstalledPlugin(f.db, "omnyo--fixture")?.version).toBe("1.0.0");
  expect(
    (await f.service.applyUpdate("omnyo--fixture", f.candidate())).ok,
  ).toBe(true);
  const row = getInstalledPlugin(f.db, "omnyo--fixture");

  if (row === undefined) throw new Error("missing row");
  await writeFile(
    join(row.rootDir, "dist/server.js"),
    "throw new Error('tampered');",
  );
  const service = await f.restart();
  expect(getInstalledPlugin(f.db, "omnyo--fixture")?.activeArtifactId).toBe(
    row.activeArtifactId,
  );
  expect(
    service.list().find((plugin) => plugin.id === "omnyo--fixture")?.status,
  ).toBe("error");
});

it("emits canonical builtin inventories and retains finite legacy bytes across restart", async () => {
  const f = await fixture();
  expect(
    (await f.service.applyUpdate("omnyo--fixture", f.candidate())).ok,
  ).toBe(true);
  const row = getInstalledPlugin(f.db, "omnyo--fixture");

  if (row === undefined || row.activeArtifactId === null)
    throw new Error("Missing artifact");
  const canonical = join(row.rootDir, ".omnyo-builtin-files.json");
  const legacyV1 = join(row.rootDir, ".bb-builtin-files.json");
  const raw = await readFile(canonical);
  await expect(readFile(legacyV1)).rejects.toMatchObject({ code: "ENOENT" });
  const artifact = getPluginArtifact(f.db, row.activeArtifactId);
  const history = (await f.service.getSource("omnyo--fixture"))?.history;
  expect(artifact?.contentHash).toBe(
    createHash("sha256").update(raw).digest("hex"),
  );
  await rename(canonical, legacyV1);
  const service = await f.restart();
  expect(await version(service)).toEqual({ ok: true, result: "1.0.1" });
  expect(await readFile(legacyV1)).toEqual(raw);
  await expect(readFile(canonical)).rejects.toMatchObject({ code: "ENOENT" });
  expect(getInstalledPlugin(f.db, "omnyo--fixture")).toMatchObject({
    activeArtifactId: row.activeArtifactId,
    rootDir: row.rootDir,
    version: row.version,
  });
  expect(getPluginArtifact(f.db, row.activeArtifactId)).toEqual(artifact);
  expect((await service.getSource("omnyo--fixture"))?.history).toEqual(history);
});

it("refuses dual builtin inventories before verification effects even when bytes match", async () => {
  const f = await fixture();
  expect(
    (await f.service.applyUpdate("omnyo--fixture", f.candidate())).ok,
  ).toBe(true);
  const row = getInstalledPlugin(f.db, "omnyo--fixture");

  if (row === undefined || row.activeArtifactId === null)
    throw new Error("Missing artifact");
  const raw = await readFile(join(row.rootDir, ".omnyo-builtin-files.json"));
  const artifact = getPluginArtifact(f.db, row.activeArtifactId);
  const history = (await f.service.getSource("omnyo--fixture"))?.history;
  await writeFile(join(row.rootDir, ".bb-builtin-files.json"), raw);
  await expect(
    verifyBuiltinPluginArtifact({ db: f.db, dataDir: f.dataDir, row }),
  ).rejects.toThrow("Ambiguous bundled plugin inventories");
  expect(getInstalledPlugin(f.db, "omnyo--fixture")).toMatchObject({
    activeArtifactId: row.activeArtifactId,
    rootDir: row.rootDir,
    version: row.version,
  });
  expect(getPluginArtifact(f.db, row.activeArtifactId)).toEqual(artifact);
  expect((await f.service.getSource("omnyo--fixture"))?.history).toEqual(
    history,
  );
  expect(
    await readFile(join(row.rootDir, ".omnyo-builtin-files.json")),
  ).toEqual(raw);
  expect(await readFile(join(row.rootDir, ".bb-builtin-files.json"))).toEqual(
    raw,
  );
});

it("rejects supplied inventory metadata before staging candidate files", async () => {
  const f = await fixture();
  const history = (await f.service.getSource("omnyo--fixture"))?.history;

  for (const names of [
    [".omnyo-builtin-files.json"],
    [".bb-builtin-files.json"],
    [".omnyo-builtin-files.json", ".bb-builtin-files.json"],
  ]) {
    const request = f.candidate({
      ...files("1.0.1"),
      ...Object.fromEntries(names.map((name) => [name, "[]"])),
    });

    expect((await f.service.applyUpdate("omnyo--fixture", request)).ok).toBe(
      false,
    );
    expect(getInstalledPlugin(f.db, "omnyo--fixture")).toMatchObject({
      activeArtifactId: null,
      rootDir: f.bundled.rootDir,
      version: "1.0.0",
    });
    expect((await f.service.getSource("omnyo--fixture"))?.history).toEqual(
      history,
    );

    const cache = await readdir(join(f.dataDir, "plugins/cache/builtin")).catch(
      (error: unknown) => {
        if (
          error instanceof Error &&
          "code" in error &&
          error.code === "ENOENT"
        )
          return [];
        throw error;
      },
    );

    expect(cache).toEqual([]);
  }
});
