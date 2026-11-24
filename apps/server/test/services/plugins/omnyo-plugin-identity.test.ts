import { describe, expect, it } from "vitest";
import {
  derivePluginId,
  PLUGIN_SDK_MAJOR,
  PLUGIN_SDK_VERSION,
} from "@omnyo/domain";
import { validatePluginArtifactMeta } from "../../../src/services/plugins/app-bundle.js";

describe("finite legacy plugin identity inputs", () => {
  it("projects known owned legacy package IDs without changing neutral IDs", () => {
    expect(derivePluginId("bb-plugin-bb--git")).toBe("omnyo--git");
    expect(derivePluginId("bb-plugin-account-pool")).toBe("account-pool");
    expect(derivePluginId("bb-plugin-foreign-bb-data")).toBe("foreign-bb-data");
  });

  it.each(["server", "app", "host"] as const)(
    "validates an immutable V1 %s identity but requires rebuilding before execution",
    (artifact) => {
      const input = {
        sdkMajor: PLUGIN_SDK_MAJOR,
        sdkVersion: PLUGIN_SDK_VERSION,
        artifactFormatVersion: 1,
        pluginId: "bb--git",
        pluginVersion: "1.0.0",
        builtWith: {
          bbVersion: "0.46.238",
          pluginSdkVersion: PLUGIN_SDK_VERSION,
        },
      };

      expect(
        validatePluginArtifactMeta({
          artifact,
          raw: JSON.stringify(input),
          pluginId: "omnyo--git",
          pluginVersion: "1.0.0",
        }),
      ).toMatch(/runtime ABI.*rebuild/);
      expect(
        validatePluginArtifactMeta({
          artifact,
          raw: JSON.stringify(input),
          pluginId: "omnyo--provider-usage",
          pluginVersion: "1.0.0",
        }),
      ).toMatch(/pluginId/);
      expect(
        validatePluginArtifactMeta({
          artifact,
          raw: JSON.stringify({
            ...input,
            artifactFormatVersion: 2,
            builtWith: {
              coreVersion: "1.0.0",
              pluginSdkVersion: PLUGIN_SDK_VERSION,
            },
          }),
          pluginId: "omnyo--git",
          pluginVersion: "1.0.0",
        }),
      ).toMatch(/pluginId/);
    },
  );
});
