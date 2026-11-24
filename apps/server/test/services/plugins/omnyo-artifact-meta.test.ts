import { expect, it } from "vitest";
import { PLUGIN_SDK_MAJOR, PLUGIN_SDK_VERSION } from "@omnyo/domain";
import {
  parsePluginAppBundleMeta,
  validatePluginArtifactMeta,
} from "../../../src/services/plugins/app-bundle.js";

const legacy = {
  sdkMajor: PLUGIN_SDK_MAJOR,
  sdkVersion: PLUGIN_SDK_VERSION,
  artifactFormatVersion: 1,
  pluginId: "fixture",
  pluginVersion: "1.0.0",
  builtWith: { bbVersion: "1.2.3", pluginSdkVersion: PLUGIN_SDK_VERSION },
};

it("imports immutable version-one metadata into a canonical projection", () => {
  expect(parsePluginAppBundleMeta(JSON.stringify(legacy))).toMatchObject({
    artifactFormatVersion: 1,
    builtWith: { coreVersion: "1.2.3" },
  });
  expect(
    parsePluginAppBundleMeta(
      JSON.stringify({
        ...legacy,
        builtWith: { ...legacy.builtWith, coreVersion: "1.2.3" },
      }),
    ),
  ).not.toBeNull();
});

it("refuses conflicting dual versions and old fields in new artifacts", () => {
  expect(
    parsePluginAppBundleMeta(
      JSON.stringify({
        ...legacy,
        builtWith: { ...legacy.builtWith, coreVersion: "9.9.9" },
      }),
    ),
  ).toBeNull();
  expect(
    parsePluginAppBundleMeta(
      JSON.stringify({ ...legacy, artifactFormatVersion: 2 }),
    ),
  ).toBeNull();
  expect(
    parsePluginAppBundleMeta(
      JSON.stringify({ ...legacy, artifactFormatVersion: 3 }),
    ),
  ).toBeNull();
});

it.each(["server", "app", "host"] as const)(
  "keeps identity and version guards for canonical %s artifacts",
  (artifact) => {
    const raw = JSON.stringify({
      ...legacy,
      artifactFormatVersion: 2,
      sdkPackage: "@omnyo/plugin-sdk",
      runtimeAbi: 1,
      builtWith: { coreVersion: "1.2.3", pluginSdkVersion: PLUGIN_SDK_VERSION },
    });

    expect(
      validatePluginArtifactMeta({
        artifact,
        raw,
        pluginId: "fixture",
        pluginVersion: "1.0.0",
      }),
    ).toBeNull();
    expect(
      validatePluginArtifactMeta({
        artifact,
        raw,
        pluginId: "foreign",
        pluginVersion: "1.0.0",
      }),
    ).toMatch(/does not match manifest pluginId/);
    expect(
      validatePluginArtifactMeta({
        artifact,
        raw,
        pluginId: "fixture",
        pluginVersion: "9.9.9",
      }),
    ).toMatch(/does not match manifest version/);
  },
);
