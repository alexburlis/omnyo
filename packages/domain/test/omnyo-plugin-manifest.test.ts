import { describe, expect, it } from "vitest";
import { pluginPackageJsonSchema } from "../src/plugin-manifest.js";
import { derivePluginId } from "../src/plugin-id.js";

const manifest = {
  name: "Fixture",
  description: "Preserves the same plugin capability declarations.",
  branding: { icon: "Zap" },
  server: "./server.js",
};

describe("Omnyo manifest boundary", () => {
  it("accepts canonical metadata without legacy keys", () => {
    const parsed = pluginPackageJsonSchema.parse({
      name: "omnyo-plugin-fixture",
      version: "1.0.0",
      omnyo: manifest,
      engines: { omnyo: ">=1", omnyoPluginSdk: "^1", node: ">=22" },
    });

    expect(parsed).toMatchObject({
      omnyo: manifest,
      engines: { omnyo: ">=1", omnyoPluginSdk: "^1", node: ">=22" },
    });
    expect(parsed).not.toHaveProperty("bb");
  });

  it("imports version-one metadata once into canonical fields and preserves package identity", () => {
    const parsed = pluginPackageJsonSchema.parse({
      name: "bb-plugin-fixture",
      version: "1.0.0",
      bb: manifest,
      engines: { bb: ">=1", bbPluginSdk: "^1" },
    });

    expect(parsed).toMatchObject({
      name: "bb-plugin-fixture",
      omnyo: manifest,
      engines: { omnyo: ">=1", omnyoPluginSdk: "^1" },
    });
    expect(parsed).not.toHaveProperty("bb");
    expect(parsed.engines).not.toHaveProperty("bb");
    expect(parsed.engines).not.toHaveProperty("bbPluginSdk");
    expect(pluginPackageJsonSchema.parse(parsed)).toEqual(parsed);
  });

  it("collapses equal dual metadata independently of object key order", () => {
    const parsed = pluginPackageJsonSchema.parse({
      name: "omnyo-plugin-fixture",
      version: "1.0.0",
      omnyo: manifest,
      bb: {
        server: manifest.server,
        branding: manifest.branding,
        description: manifest.description,
        name: manifest.name,
      },
      engines: { bb: ">=1", omnyo: ">=1" },
    });

    expect(parsed).not.toHaveProperty("bb");
    expect(parsed).toHaveProperty("engines.omnyo", ">=1");
  });

  it.each([
    { bb: { ...manifest, server: "./other.js" }, omnyo: manifest },
    { bb: { ...manifest, permissions: ["all"] }, omnyo: manifest },
    { bb: manifest, engines: { bb: ">=1", omnyo: ">=2" } },
    { bb: manifest, engines: { bbPluginSdk: "^1", omnyoPluginSdk: "^2" } },
    { bb: null, omnyo: manifest },
  ])("refuses conflicting or malformed legacy metadata", (fields) => {
    expect(
      pluginPackageJsonSchema.safeParse({
        name: "omnyo-plugin-fixture",
        version: "1.0.0",
        ...fields,
      }).success,
    ).toBe(false);
  });

  it("derives injective neutral and reserved plugin IDs", () => {
    expect(derivePluginId("omnyo-plugin-tasks")).toBe("tasks");
    expect(derivePluginId("omnyo-plugin-omnyo--account-usage")).toBe(
      "omnyo--account-usage",
    );
    expect(derivePluginId("omnyo-plugin-account-usage")).toBe("account-usage");
    expect(derivePluginId("bb-plugin-bb--account-usage")).toBe(
      "omnyo--account-usage",
    );
  });
});
