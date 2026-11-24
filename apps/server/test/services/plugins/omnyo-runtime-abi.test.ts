import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { PLUGIN_SDK_MAJOR, PLUGIN_SDK_VERSION } from "@omnyo/domain";
import {
  loadPluginAppBundle,
  parsePluginAppBundleMeta,
  validatePluginArtifactMeta,
} from "../../../src/services/plugins/app-bundle.js";

const roots: string[] = [];

const canonical = {
  sdkMajor: PLUGIN_SDK_MAJOR,
  sdkVersion: PLUGIN_SDK_VERSION,
  artifactFormatVersion: 2,
  sdkPackage: "@omnyo/plugin-sdk",
  runtimeAbi: 1,
  pluginId: "fixture",
  pluginVersion: "1.0.0",
  builtWith: { coreVersion: "1.2.3", pluginSdkVersion: PLUGIN_SDK_VERSION },
};

function legacyRuntimeScriptV1(): string {
  return "globalThis.__bbPluginRuntime.executed = true;";
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

it.each(["server", "app", "host"] as const)("refuses same-version pre-ABI %s artifacts before execution", (artifact) => {
  const preAbi = { ...canonical, sdkPackage: undefined, runtimeAbi: undefined };

  expect(parsePluginAppBundleMeta(JSON.stringify(preAbi))).not.toBeNull();
  expect(validatePluginArtifactMeta({ artifact, raw: JSON.stringify(preAbi), pluginId: "fixture", pluginVersion: "1.0.0" })).toMatch(/runtime ABI.*rebuild/);
  expect(validatePluginArtifactMeta({ artifact, raw: JSON.stringify(canonical), pluginId: "fixture", pluginVersion: "1.0.0" })).toBeNull();
});

it.each([
  { sdkPackage: "@get-bb/plugin-sdk" },
  { runtimeAbi: 0 },
  { runtimeAbi: 2 },
])("refuses an incompatible SDK runtime identity %j", (identity) => {
  expect(validatePluginArtifactMeta({ artifact: "app", raw: JSON.stringify({ ...canonical, ...identity }), pluginId: "fixture", pluginVersion: "1.0.0" })).toMatch(/runtime ABI.*rebuild/);
});

it("does not expose legacy frontend bytes as loadable assets", async () => {
  const root = await mkdtemp(join(tmpdir(), "omnyo-runtime-abi-"));
  roots.push(root);
  await mkdir(join(root, "dist"));
  const { sdkPackage, runtimeAbi, ...preAbi } = canonical;

  await writeFile(join(root, "dist", "app.js"), legacyRuntimeScriptV1());
  await writeFile(join(root, "dist", "app.meta.json"), JSON.stringify(preAbi));
  const legacy = await loadPluginAppBundle("fixture", root);

  expect(legacy.state.bundle?.compatible).toBe(false);
  expect(legacy.assets).toBeNull();
  await writeFile(join(root, "dist", "app.js"), 'export const marker = "canonical-runtime";');
  await writeFile(join(root, "dist", "app.meta.json"), JSON.stringify({ ...preAbi, sdkPackage, runtimeAbi }));
  const current = await loadPluginAppBundle("fixture", root);

  expect(current.state.bundle?.compatible).toBe(true);
  expect(current.assets?.jsPath).toBe(join(root, "dist", "app.js"));
});
