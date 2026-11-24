import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readPluginManifest } from "../../../src/services/plugins/manifest.js";

describe("plugin manifest", () => {
  let rootDir: string;

  beforeEach(async () => {
    rootDir = await mkdtemp(join(tmpdir(), "omnyo-plugin-manifest-"));
    await writeFile(join(rootDir, "server.ts"), "export default () => {};\n");
  });

  afterEach(async () => {
    await rm(rootDir, { recursive: true, force: true });
  });

  const validMetadata = {
    name: "Contract fixture",
    description: "Plugin manifest contract fixture.",
    branding: { icon: "Zap" },
    server: "./server.ts",
  };

  async function writeManifest(
    omnyoPluginSdk?: string,
    metadata: Record<string, unknown> = validMetadata,
  ): Promise<void> {
    await writeFile(
      join(rootDir, "package.json"),
      JSON.stringify({
        name: "omnyo-plugin-contract",
        version: "2.3.4",
        ...(omnyoPluginSdk === undefined
          ? {}
          : { engines: { omnyoPluginSdk: omnyoPluginSdk } }),
        omnyo: metadata,
      }),
    );
  }

  async function writeLegacyManifestV1(
    omnyoPluginSdk?: string,
    legacyMetadata: Record<string, unknown> = validMetadata,
  ): Promise<void> {
    await writeFile(
      join(rootDir, "package.json"),
      JSON.stringify({
        name: "omnyo-plugin-contract",
        version: "2.3.4",
        ...(omnyoPluginSdk === undefined
          ? {}
          : { engines: { bbPluginSdk: omnyoPluginSdk } }),
        bb: legacyMetadata,
      }),
    );
  }

  it("writes and reads canonical metadata and SDK requirements without legacy fields", async () => {
    await writeManifest("^0.2.0 || >=2.0.0");

    const raw = JSON.parse(
      await readFile(join(rootDir, "package.json"), "utf8"),
    );

    expect(raw).toHaveProperty("omnyo");
    expect(raw).not.toHaveProperty("bb");
    expect(raw.engines).toEqual({ omnyoPluginSdk: "^0.2.0 || >=2.0.0" });
    expect((await readPluginManifest(rootDir)).pluginSdkRange).toBe(
      "^0.2.0 || >=2.0.0",
    );
  });

  it("accepts a valid engines.bbPluginSdk range", async () => {
    await writeLegacyManifestV1("^0.2.0 || >=2.0.0");
    expect((await readPluginManifest(rootDir)).pluginSdkRange).toBe(
      "^0.2.0 || >=2.0.0",
    );
  });

  it.each([
    ["alexburlis", { name: "alexburlis", github: null, url: null }],
    [
      {
        name: "alexburlis",
        url: "https://github.com/alexburlis",
        email: "private@example.test",
      },
      {
        name: "alexburlis",
        github: "alexburlis",
        url: "https://github.com/alexburlis",
      },
    ],
  ])(
    "preserves package author metadata without private contact fields",
    async (author, expected) => {
      await writeFile(
        join(rootDir, "package.json"),
        JSON.stringify({
          name: "omnyo-plugin-contract",
          version: "2.3.4",
          author,
          omnyo: validMetadata,
        }),
      );
      expect((await readPluginManifest(rootDir)).author).toEqual(expected);
    },
  );

  it.each([
    [
      {
        type: "git",
        url: "git+https://github.com/get-bb/bb.git",
        directory: "plugins/git",
      },
      "https://github.com/get-bb/bb/tree/HEAD/plugins/git",
    ],
    [{ type: "git" }, null],
    [undefined, null],
  ])(
    "links the package repository without rejecting a manifest it cannot link",
    async (repository, expected) => {
      await writeFile(
        join(rootDir, "package.json"),
        JSON.stringify({
          name: "omnyo-plugin-contract",
          version: "2.3.4",
          repository,
          omnyo: validMetadata,
        }),
      );
      expect((await readPluginManifest(rootDir)).repositoryUrl).toBe(expected);
    },
  );

  it("rejects an invalid engines.bbPluginSdk range clearly", async () => {
    await writeLegacyManifestV1("definitely not semver");
    await expect(readPluginManifest(rootDir)).rejects.toThrow(
      /engines\.omnyoPluginSdk.*valid semver range/,
    );
  });

  it("accepts an absent range as a legacy manifest", async () => {
    await writeLegacyManifestV1();
    expect((await readPluginManifest(rootDir)).pluginSdkRange).toBeUndefined();
  });

  it("accepts one optional host entry and resolves it inside the plugin", async () => {
    await writeFile(join(rootDir, "host.ts"), "export default {};\n");
    await writeManifest(undefined, {
      ...validMetadata,
      host: "./host.ts",
    });

    expect((await readPluginManifest(rootDir)).hostEntry).toBe(
      join(rootDir, "host.ts"),
    );
  });

  it("rejects a missing or escaping host entry", async () => {
    await writeManifest(undefined, {
      ...validMetadata,
      host: "./missing.ts",
    });
    await expect(readPluginManifest(rootDir)).rejects.toThrow(
      /omnyo\.host.*missing file/u,
    );

    await writeManifest(undefined, {
      ...validMetadata,
      host: "../host.ts",
    });
    await expect(readPluginManifest(rootDir)).rejects.toThrow(
      /omnyo\.host.*escapes the plugin directory/u,
    );
  });

  it.each(["name", "description"] as const)(
    "requires a non-empty omnyo.%s string",
    async (field: "name" | "description") => {
      const { [field]: _omitted, ...withoutField } = validMetadata;
      await writeManifest(undefined, withoutField);
      await expect(readPluginManifest(rootDir)).rejects.toThrow(
        new RegExp(`omnyo\\.${field}`),
      );

      await writeManifest(undefined, {
        ...validMetadata,
        [field]: "   ",
      });
      await expect(readPluginManifest(rootDir)).rejects.toThrow(
        new RegExp(`omnyo\\.${field}`),
      );

      await writeManifest(undefined, { ...validMetadata, [field]: null });
      await expect(readPluginManifest(rootDir)).rejects.toThrow(
        new RegExp(`omnyo\\.${field}`),
      );
    },
  );

  it("requires branding with an icon or light logo", async () => {
    for (const branding of [undefined, null, {}, { icon: "   " }]) {
      await writeManifest(undefined, { ...validMetadata, branding });
      await expect(readPluginManifest(rootDir)).rejects.toThrow(
        /omnyo\.branding/,
      );
    }
  });

  it("resolves a path-shaped branding.icon as a plugin-owned compact SVG", async () => {
    await mkdir(join(rootDir, "assets"));
    await writeFile(join(rootDir, "assets", "icon.svg"), "<svg/>");
    await writeManifest(undefined, {
      ...validMetadata,
      branding: { icon: "./assets/icon.svg" },
    });

    const manifest = await readPluginManifest(rootDir);
    expect(manifest.branding.icon).toBe("./assets/icon.svg");
    expect(manifest.branding.compactIconPath).toBe(
      join(rootDir, "assets", "icon.svg"),
    );
  });

  it("reads an optional short name for the Settings sidebar", async () => {
    await writeManifest();
    expect((await readPluginManifest(rootDir)).shortName).toBeNull();

    await writeManifest(undefined, { ...validMetadata, shortName: "Contract" });
    expect((await readPluginManifest(rootDir)).shortName).toBe("Contract");

    await writeManifest(undefined, { ...validMetadata, shortName: "" });
    await expect(readPluginManifest(rootDir)).rejects.toThrow(
      /omnyo\.shortName/u,
    );
  });

  it("keeps a named branding.icon as a host icon hint", async () => {
    await writeManifest();
    const manifest = await readPluginManifest(rootDir);
    expect(manifest.branding.icon).toBe("Zap");
    expect(manifest.branding.compactIconPath).toBeUndefined();
  });

  it("requires path-shaped branding.icon to be a readable SVG", async () => {
    await writeManifest(undefined, {
      ...validMetadata,
      branding: { icon: "./missing.svg" },
    });
    await expect(readPluginManifest(rootDir)).rejects.toThrow(/missing file/);

    await writeManifest(undefined, {
      ...validMetadata,
      branding: { icon: "./icon.png" },
    });
    await expect(readPluginManifest(rootDir)).rejects.toThrow(
      /branding\.icon.*\.svg/,
    );
  });

  it.each([
    ["non-SVG XML", "<html/>", /<svg> root element/],
    ["malformed XML", "<svg><path></svg>", /not valid SVG XML/],
    [
      "entity declarations",
      '<!DOCTYPE svg [<!ENTITY mark "x">]><svg>&mark;</svg>',
      /must not contain a doctype declaration/,
    ],
    ["a foreign namespace", '<x:svg xmlns:x="urn:not-svg"/>', /<svg> root/],
  ])(
    "rejects a path-shaped branding.icon with %s",
    async (_case, icon, error) => {
      await writeFile(join(rootDir, "icon.svg"), icon);
      await writeManifest(undefined, {
        ...validMetadata,
        branding: { icon: "./icon.svg" },
      });

      await expect(readPluginManifest(rootDir)).rejects.toThrow(error);
    },
  );

  it("rejects a dark logo without a light logo", async () => {
    await writeManifest(undefined, {
      ...validMetadata,
      branding: { logo: { dark: "./dark.svg" } },
    });
    await expect(readPluginManifest(rootDir)).rejects.toThrow(
      /omnyo\.branding\.logo\.light/,
    );
  });

  it("rejects null and empty branding asset paths", async () => {
    for (const light of [null, "   "]) {
      await writeManifest(undefined, {
        ...validMetadata,
        branding: { logo: { light } },
      });
      await expect(readPluginManifest(rootDir)).rejects.toThrow(
        /omnyo\.branding\.logo\.light/,
      );
    }

    for (const dark of [null, "   "]) {
      await writeManifest(undefined, {
        ...validMetadata,
        branding: { logo: { light: "./light.svg", dark } },
      });
      await expect(readPluginManifest(rootDir)).rejects.toThrow(
        /omnyo\.branding\.logo\.dark/,
      );
    }
  });

  it.each([
    ["displayName", "Legacy name"],
    ["icon", "Zap"],
    ["logo", "./logo.svg"],
    ["logoDark", "./logo-dark.svg"],
  ])(
    "rejects the legacy bb.%s field instead of ignoring it",
    async (field, value) => {
      await writeLegacyManifestV1(undefined, {
        ...validMetadata,
        [field]: value,
      });
      await expect(readPluginManifest(rootDir)).rejects.toThrow(
        /unrecognized key/i,
      );
    },
  );

  it("requires declared logo assets to be supported files", async () => {
    await writeManifest(undefined, {
      ...validMetadata,
      branding: { logo: { light: "./missing.svg" } },
    });
    await expect(readPluginManifest(rootDir)).rejects.toThrow(/missing file/);

    await mkdir(join(rootDir, "directory.svg"));
    await writeManifest(undefined, {
      ...validMetadata,
      branding: { logo: { light: "./directory.svg" } },
    });
    await expect(readPluginManifest(rootDir)).rejects.toThrow(
      /point at a file/,
    );

    await writeManifest(undefined, {
      ...validMetadata,
      branding: { logo: { light: "./logo.gif" } },
    });
    await expect(readPluginManifest(rootDir)).rejects.toThrow(
      /\.svg, \.png, or \.webp/,
    );
  });

  it("rejects a branding asset symlink that escapes the plugin directory", async () => {
    const outsideDir = await mkdtemp(
      join(tmpdir(), "omnyo-plugin-branding-outside-"),
    );

    try {
      const outsideAsset = join(outsideDir, "outside.svg");
      await writeFile(outsideAsset, "<svg/>");
      await symlink(outsideAsset, join(rootDir, "linked.svg"));
      await writeManifest(undefined, {
        ...validMetadata,
        branding: { logo: { light: "./linked.svg" } },
      });
      await expect(readPluginManifest(rootDir)).rejects.toThrow(
        /escapes the plugin directory through a symlink/,
      );
    } finally {
      await rm(outsideDir, { recursive: true, force: true });
    }
  });
});
