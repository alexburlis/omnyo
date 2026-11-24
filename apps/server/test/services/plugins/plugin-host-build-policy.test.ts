import {
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createConnection, migrate, type DbConnection } from "@omnyo/db";
import { PLUGIN_SDK_VERSION } from "@omnyo/domain";
import type { Logger } from "@omnyo/logger";
import { createAiServiceRegistry } from "../../../src/services/ai/ai-service-registry.js";
import {
  createPluginService,
  type PluginService,
} from "../../../src/services/plugins/plugin-service.js";
import { createNoopTelemetryService } from "../../../src/services/system/telemetry.js";
import { testLogger } from "../../helpers/test-app.js";
import { openSecretVault } from "@omnyo/secret-storage";

describe("mutable plugin host build policy", () => {
  let service: PluginService;
  let db: DbConnection;
  let workDir: string;
  let rootDir: string;
  let dependency: string;
  let alternate: string;
  let artifactPath: string;
  let metaPath: string;

  beforeEach(async () => {
    db = createConnection(":memory:");
    migrate(db);
    workDir = await mkdtemp(join(tmpdir(), "omnyo-host-build-policy-"));
    rootDir = join(workDir, "plugin");
    dependency = join(workDir, "dependency");
    alternate = join(workDir, "alternate");
    artifactPath = join(rootDir, "dist", "host.js");
    metaPath = join(rootDir, "dist", "host.meta.json");
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
    });
    await mkdir(join(rootDir, "node_modules"), { recursive: true });
    await writeFile(
      join(rootDir, "package.json"),
      JSON.stringify({
        name: "omnyo-plugin-host-policy",
        version: "0.1.0",
        type: "module",
        omnyo: {
          name: "Host policy fixture",
          description: "Host build lifecycle fixture.",
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
      'import { value } from "host-policy-dependency"; export default { experimental_apiVersion: 1, value };',
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

    for (const [path, value] of [
      [dependency, "initial"],
      [alternate, "updated"],
    ] as const) {
      await mkdir(path);
      await writeFile(
        join(path, "package.json"),
        JSON.stringify({
          name: "host-policy-dependency",
          type: "module",
          exports: "./index.js",
        }),
      );
      await writeFile(
        join(path, "index.js"),
        `export const value = "${value}";`,
      );
      await writeFile(join(path, "next.js"), 'export const value = "updated";');
    }

    await symlink(
      dependency,
      join(rootDir, "node_modules", "host-policy-dependency"),
      "dir",
    );
  });

  afterEach(async () => {
    await service.stop();
    db.$client.close();
    await rm(workDir, { recursive: true, force: true });
  });

  async function install() {
    expect((await service.installPath(rootDir)).status).toBe("running");
  }

  async function reload() {
    expect((await service.reload("host-policy")).ok).toBe(true);
    expect(
      service.list().find((entry) => entry.id === "host-policy")?.status,
    ).toBe("running");
  }

  async function expectReused() {
    const before = await stat(artifactPath, { bigint: true });
    const bytes = await readFile(artifactPath);
    await reload();
    expect(await readFile(artifactPath)).toEqual(bytes);
    expect((await stat(artifactPath, { bigint: true })).mtimeNs).toBe(
      before.mtimeNs,
    );
  }

  it.each(["reload", "restart"])(
    "reuses unchanged host bytes on %s",
    async (operation) => {
      await install();
      const before = await stat(artifactPath, { bigint: true });

      if (operation === "restart") {
        await service.stop();
        await service.start();
      } else {
        await reload();
      }

      expect(
        service.list().find((entry) => entry.id === "host-policy")?.status,
      ).toBe("running");
      expect((await stat(artifactPath, { bigint: true })).mtimeNs).toBe(
        before.mtimeNs,
      );
    },
  );

  it.each(["source", "dependency", "exports", "symlink"])(
    "rebuilds when the %s changes",
    async (target) => {
      await install();

      if (target === "source") {
        await writeFile(
          join(rootDir, "host.ts"),
          'export default { experimental_apiVersion: 1, value: "updated" };',
        );
      } else if (target === "dependency") {
        await writeFile(
          join(dependency, "index.js"),
          'export const value = "updated";',
        );
      } else if (target === "exports") {
        await writeFile(
          join(dependency, "package.json"),
          JSON.stringify({
            name: "host-policy-dependency",
            type: "module",
            exports: "./next.js",
          }),
        );
      } else {
        const link = join(rootDir, "node_modules", "host-policy-dependency");
        await rm(link);
        await symlink(alternate, link, "dir");
      }

      await reload();
      expect(await readFile(artifactPath, "utf8")).toContain("updated");
      await expectReused();
    },
  );

  it.each([
    "artifact",
    "metadata",
    "invalid metadata",
    "SDK",
    "input metadata",
  ])("rebuilds missing or invalid %s", async (target) => {
    await install();

    if (target === "artifact") await rm(artifactPath);
    else if (target === "metadata") await rm(metaPath);
    else if (target === "invalid metadata")
      await writeFile(metaPath, "not json");
    else {
      const metadata = JSON.parse(await readFile(metaPath, "utf8"));

      if (target === "SDK") metadata.sdkVersion = "0.0.0-stale";
      else delete metadata.buildInputs;
      await writeFile(metaPath, JSON.stringify(metadata));
    }

    await reload();
    expect(JSON.parse(await readFile(metaPath, "utf8"))).toMatchObject({
      sdkVersion: PLUGIN_SDK_VERSION,
    });
    expect(await readFile(artifactPath, "utf8")).toContain("initial");
    await expectReused();
  });

  it("rebuilds when an inherited tsconfig changes dependency resolution", async () => {
    const config = join(workDir, "base.json");
    await writeFile(
      join(rootDir, "tsconfig.json"),
      JSON.stringify({ extends: "../base.json" }),
    );
    await writeFile(
      config,
      JSON.stringify({
        compilerOptions: {
          baseUrl: ".",
          paths: { "host-policy-dependency": ["./dependency/index.js"] },
        },
      }),
    );
    await install();
    await writeFile(
      config,
      JSON.stringify({
        compilerOptions: {
          baseUrl: ".",
          paths: { "host-policy-dependency": ["./alternate/index.js"] },
        },
      }),
    );
    await reload();
    expect(await readFile(artifactPath, "utf8")).toContain("updated");
    await expectReused();
  });

  it("rebuilds when a newly installed nearer package changes resolution", async () => {
    await rename(join(rootDir, "node_modules"), join(workDir, "node_modules"));
    await mkdir(join(rootDir, "node_modules"));
    await install();
    await symlink(
      alternate,
      join(rootDir, "node_modules", "host-policy-dependency"),
      "dir",
    );
    await reload();
    expect(await readFile(artifactPath, "utf8")).toContain("updated");
    await expectReused();
  });
});
