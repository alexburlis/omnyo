import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  PLUGIN_SDK_MAJOR,
  PLUGIN_SDK_VERSION,
  PLUGIN_SDK_PACKAGE_NAME,
  PLUGIN_RUNTIME_ABI,
} from "@omnyo/domain";
import {
  buildPluginServer,
  resolvePluginBuildToolchain,
} from "@omnyo/plugin-build";

function testToolchain() {
  return resolvePluginBuildToolchain(join(tmpdir(), "omnyo-toolchain-unused"));
}

const TEST_CORE_VERSION = "0.9.0-test";

const FIXTURE_PACKAGE_JSON = JSON.stringify(
  {
    name: "omnyo-plugin-server-fixture",
    version: "0.1.0",
    type: "module",
    omnyo: {
      name: "Server fixture",
      description: "Plugin server build fixture.",
      branding: { icon: "Zap" },
      server: "./server.ts",
    },
  },
  null,
  2,
);

const FIXTURE_LIB_TS = `export const greeting = "PREBUILT_LIB_MARKER";\n`;

const FIXTURE_SERVER_TS = `
import type { PluginApi } from "@omnyo/plugin-sdk";
import { greeting } from "./lib.ts";

export default function plugin(api: PluginApi): void {
  api.log.info(greeting);
}
`;

describe("buildPluginServer", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "omnyo-plugin-server-build-"));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  async function writeFixture(): Promise<void> {
    await writeFile(join(root, "package.json"), FIXTURE_PACKAGE_JSON);
    await writeFile(join(root, "lib.ts"), FIXTURE_LIB_TS);
    await writeFile(join(root, "server.ts"), FIXTURE_SERVER_TS);
  }

  it("bundles the server entry into a self-contained ESM dist/server.js with a meta sidecar", async () => {
    await writeFixture();

    const result = await buildPluginServer(
      root,
      TEST_CORE_VERSION,
      await testToolchain(),
    );

    expect(result.jsPath).toBe(join(root, "dist", "server.js"));
    const js = await readFile(result.jsPath, "utf8");
    expect(js).toMatch(/export\s*\{|export default/);
    expect(js).toContain("PREBUILT_LIB_MARKER");
    expect(js).not.toContain("@omnyo/plugin-sdk");
    expect(js).toContain("createRequire");

    const map = await readFile(result.mapPath, "utf8");
    expect(JSON.parse(map)).toMatchObject({ version: 3 });

    const meta = JSON.parse(await readFile(result.metaPath, "utf8"));
    expect(meta).toEqual({
      sdkMajor: PLUGIN_SDK_MAJOR,
      sdkVersion: PLUGIN_SDK_VERSION,
      artifactFormatVersion: 2,
      sdkPackage: PLUGIN_SDK_PACKAGE_NAME,
      runtimeAbi: PLUGIN_RUNTIME_ABI,
      pluginId: "server-fixture",
      pluginVersion: "0.1.0",
      builtWith: {
        coreVersion: TEST_CORE_VERSION,
        pluginSdkVersion: PLUGIN_SDK_VERSION,
      },
    });
  });

  it("keeps a runtime @omnyo/plugin-sdk import external (bare specifier survives)", async () => {
    await writeFixture();
    await writeFile(
      join(root, "server.ts"),
      `
      import { greeting } from "./lib.ts";
      import * as sdk from "@omnyo/plugin-sdk";

      export default function plugin(api: { log: { info(msg: string): void } }): void {
        api.log.info(greeting + Object.keys(sdk).length);
      }
      `,
    );

    const result = await buildPluginServer(
      root,
      TEST_CORE_VERSION,
      await testToolchain(),
    );

    const js = await readFile(result.jsPath, "utf8");
    expect(js).toMatch(/from\s*"@omnyo\/plugin-sdk"/);
  });

  it("errors clearly when package.json has no omnyo.server entry", async () => {
    const packageJsonPath = join(root, "package.json");

    await writeFile(
      packageJsonPath,
      JSON.stringify({ name: "omnyo-plugin-headless", version: "0.1.0" }),
    );
    await expect(
      buildPluginServer(root, TEST_CORE_VERSION, await testToolchain()),
    ).rejects.toThrowError(
      `invalid plugin package.json (omnyo) at ${packageJsonPath}: must declare omnyo plugin metadata`,
    );

    await writeFile(
      packageJsonPath,
      JSON.stringify({
        name: "omnyo-plugin-headless",
        version: "0.1.0",
        omnyo: {
          name: "Headless",
          description: "Plugin without a server entry.",
          branding: { icon: "Zap" },
        },
      }),
    );
    await expect(
      buildPluginServer(root, TEST_CORE_VERSION, await testToolchain()),
    ).rejects.toThrowError(
      `invalid plugin package.json (omnyo.server) at ${packageJsonPath}`,
    );
  });

  it("rejects a legacy manifest without required identity and branding", async () => {
    await writeFixture();
    await writeFile(
      join(root, "package.json"),
      JSON.stringify({
        name: "bb-plugin-legacy",
        version: "0.1.0",
        bb: { server: "./server.ts" },
      }),
    );
    await expect(
      buildPluginServer(root, TEST_CORE_VERSION, await testToolchain()),
    ).rejects.toThrowError(/bb\.name/);
  });

  it("preserves the previous dist/server.js when a rebuild fails", async () => {
    await writeFixture();

    const first = await buildPluginServer(
      root,
      TEST_CORE_VERSION,
      await testToolchain(),
    );

    const before = await readFile(first.jsPath, "utf8");
    const metaBefore = await readFile(first.metaPath, "utf8");

    await writeFile(join(root, "server.ts"), "export default function ( {\n");
    await expect(
      buildPluginServer(root, TEST_CORE_VERSION, await testToolchain()),
    ).rejects.toThrowError();

    expect(await readFile(first.jsPath, "utf8")).toBe(before);
    expect(await readFile(first.metaPath, "utf8")).toBe(metaBefore);
  });
});
