import { expect, it } from "vitest";
import { createPluginArtifactMeta } from "./plugin-artifact-meta.js";

it("emits version-two metadata with canonical core version", () => {
  const meta = createPluginArtifactMeta({
    packageName: "omnyo-plugin-fixture",
    pluginVersion: "1.0.0",
    coreVersion: "1.2.3",
  });

  expect(meta).toMatchObject({
    artifactFormatVersion: 2,
    sdkPackage: "@omnyo/plugin-sdk",
    runtimeAbi: 1,
    pluginId: "fixture",
    builtWith: { coreVersion: "1.2.3" },
  });
  expect(meta.builtWith).not.toHaveProperty("bbVersion");
});
