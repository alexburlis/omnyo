import { installPrivateSdkArtifact } from "../src/private-sdk-artifact.js";
import { PLUGIN_SDK_VERSION } from "@omnyo/domain";
import { resolvePrivateSdkArtifact } from "../src/plugin-scaffold.js";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  migratePluginToPackageLayout,
  resolvePluginSdkLayout,
  setPluginSdkPin,
} from "../src/plugin-scaffold.js";
import { PLUGIN_SHIMMED_TYPE_DEPENDENCIES } from "../src/generated/plugin-starter-files.generated.js";

const SDK_VERSION = PLUGIN_SDK_VERSION;

const SDK_ARTIFACT = await resolvePrivateSdkArtifact({
  sourceUrl: import.meta.url,
});

const SDK_PIN = `file:./vendor/${SDK_ARTIFACT.file}`;

async function writeVendoredPlugin(
  rootDir: string,
  overrides: {
    manifest?: Record<string, unknown>;
    tsconfig?: Record<string, unknown>;
    declarations?: string[];
  } = {},
): Promise<void> {
  await writeFile(
    join(rootDir, "package.json"),
    `${JSON.stringify(
      overrides.manifest ?? {
        name: "bb-plugin-legacy",
        version: "0.1.0",
        engines: { bb: ">=0.9", bbPluginSdk: ">=0.2.0" },
        bb: { server: "./server.ts" },
        dependencies: { zod: "^4.3.6" },
        devDependencies: { "@types/node": "^22.0.0", typescript: "^5.7.0" },
      },
      null,
      2,
    )}\n`,
  );
  await writeFile(
    join(rootDir, "tsconfig.json"),
    `${JSON.stringify(
      overrides.tsconfig ?? {
        compilerOptions: {
          strict: true,
          paths: {
            "@get-bb/plugin-sdk": ["./types/bb-plugin-sdk.d.ts"],
            "@get-bb/plugin-sdk/app": ["./types/bb-plugin-sdk-app.d.ts"],
            "@/*": ["./*"],
          },
        },
        include: ["server.ts", "app.tsx", "types"],
      },
      null,
      2,
    )}\n`,
  );

  const declarations = overrides.declarations ?? [
    "bb-plugin-sdk.d.ts",
    "bb-plugin-sdk-app.d.ts",
  ];

  if (declarations.length > 0) {
    await mkdir(join(rootDir, "types"), { recursive: true });

    for (const name of declarations) {
      await writeFile(join(rootDir, "types", name), "// vendored\n");
    }
  }
}

async function readJson(path: string): Promise<Record<string, unknown>> {
  const parsed: unknown = JSON.parse(await readFile(path, "utf8"));

  return parsed as Record<string, unknown>;
}

async function exists(path: string): Promise<boolean> {
  return stat(path)
    .then(() => true)
    .catch(() => false);
}

describe("migratePluginToPackageLayout", () => {
  let rootDir: string;

  beforeEach(async () => {
    rootDir = await mkdtemp(join(tmpdir(), "omnyo-plugin-migrate-"));
  });

  afterEach(async () => {
    await rm(rootDir, { recursive: true, force: true });
  });

  it("converts a vendored plugin and leaves the author's own config alone", async () => {
    await writeVendoredPlugin(rootDir);

    const result = await migratePluginToPackageLayout({
      rootDir,
      sdkArtifact: SDK_ARTIFACT,
    });

    expect(result.changed).toBe(true);
    expect(result.pin).toEqual({ from: null, to: SDK_PIN });
    expect(result.archivedFiles).toEqual([
      "types/bb-plugin-sdk.d.ts",
      "types/bb-plugin-sdk-app.d.ts",
    ]);
    expect(result.removedTypesDir).toBe(true);

    const manifest = await readJson(join(rootDir, "package.json"));
    const devDependencies = manifest.devDependencies as Record<string, string>;
    expect(devDependencies["@omnyo/plugin-sdk"]).toBe(SDK_PIN);
    expect(devDependencies.typescript).toBe("^5.7.0");
    expect(manifest.dependencies).toEqual({ zod: "^4.3.6" });

    const tsconfig = await readJson(join(rootDir, "tsconfig.json"));
    const compilerOptions = tsconfig.compilerOptions as Record<string, unknown>;
    expect(compilerOptions.paths).toEqual({ "@/*": ["./*"] });
    expect(compilerOptions.strict).toBe(true);
    expect(tsconfig.include).toEqual(["server.ts", "app.tsx"]);

    expect(await exists(join(rootDir, "types"))).toBe(false);
    expect((await resolvePluginSdkLayout(rootDir)).kind).toBe("package");
  });

  it("raises an older engines floor but never lowers a newer one", async () => {
    await writeVendoredPlugin(rootDir);

    const raised = await migratePluginToPackageLayout({
      rootDir,
      sdkArtifact: SDK_ARTIFACT,
    });

    expect(raised.enginesFloor).toEqual({
      from: ">=0.2.0",
      to: `>=${SDK_VERSION}`,
    });
    expect(
      (
        (await readJson(join(rootDir, "package.json"))).engines as
          | Record<string, string>
          | undefined
      )?.omnyoPluginSdk,
    ).toBe(`>=${SDK_VERSION}`);

    const newer = await mkdtemp(join(tmpdir(), "omnyo-plugin-migrate-newer-"));

    try {
      await writeVendoredPlugin(newer, {
        manifest: {
          name: "bb-plugin-newer",
          engines: { bbPluginSdk: ">=9.1.0" },
          bb: { server: "./server.ts" },
        },
      });

      const result = await migratePluginToPackageLayout({
        rootDir: newer,
        sdkArtifact: SDK_ARTIFACT,
      });

      expect(result.enginesFloor).toBeNull();
      expect(
        (
          (await readJson(join(newer, "package.json"))).engines as Record<
            string,
            string
          >
        ).omnyoPluginSdk,
      ).toBe(">=9.1.0");
    } finally {
      await rm(newer, { recursive: true, force: true });
    }
  });

  it.each([
    [">=0.6.44-beta.9", SDK_VERSION, true],
    [">=0.6.45-rc.10", SDK_VERSION, true],
    [">=0.6.44-beta.10", SDK_VERSION, true],
    [">=0.6.44+build.1", SDK_VERSION, true],
    [`>=${SDK_VERSION}+build.1`, SDK_VERSION, false],
    [`>=${SDK_VERSION}-rc.10`, SDK_VERSION, true],
    [">=0.2", SDK_VERSION, true],
    ["^0.2.0", SDK_VERSION, true],
    [">=9.0.0 || >=0.2.0", SDK_VERSION, true],
    ["garbage 0.2.0", SDK_VERSION, false],
    [">=0.2.0 trailing", SDK_VERSION, false],
    [">=0.2.0-beta..1", SDK_VERSION, false],
  ])(
    "evaluates the complete SDK range %s against %s",
    async (range, sdkVersion, raises) => {
      await writeVendoredPlugin(rootDir, {
        manifest: {
          name: "bb-plugin-range",
          engines: { bbPluginSdk: range },
          bb: { server: "./server.ts" },
        },
      });

      const result = await migratePluginToPackageLayout({
        rootDir,
        sdkArtifact: SDK_ARTIFACT,
      });

      expect(result.enginesFloor).toEqual(
        raises ? { from: range, to: `>=${sdkVersion}` } : null,
      );
      const manifest = await readJson(join(rootDir, "package.json"));
      expect(manifest.engines).toEqual({
        omnyoPluginSdk: raises ? `>=${sdkVersion}` : range,
      });
    },
  );

  it("is a no-op the second time", async () => {
    await writeVendoredPlugin(rootDir);
    await migratePluginToPackageLayout({ rootDir, sdkArtifact: SDK_ARTIFACT });

    const manifestAfterFirst = await readFile(
      join(rootDir, "package.json"),
      "utf8",
    );

    const tsconfigAfterFirst = await readFile(
      join(rootDir, "tsconfig.json"),
      "utf8",
    );

    const second = await migratePluginToPackageLayout({
      rootDir,
      sdkArtifact: SDK_ARTIFACT,
    });

    expect(second).toMatchObject({
      changed: false,
      pin: null,
      movedFromDependencies: false,
      enginesFloor: null,
      removedPathMaps: [],
      removedIncludes: [],
      archivedFiles: [],
      removedTypesDir: false,
      rewrittenImports: [],
    });
    expect(await readFile(join(rootDir, "package.json"), "utf8")).toBe(
      manifestAfterFirst,
    );
    expect(await readFile(join(rootDir, "tsconfig.json"), "utf8")).toBe(
      tsconfigAfterFirst,
    );
  });

  it("converges a half-migrated plugin instead of rejecting it", async () => {
    await writeVendoredPlugin(rootDir, {
      manifest: {
        name: "bb-plugin-half",
        engines: { bbPluginSdk: `>=${SDK_VERSION}` },
        bb: { server: "./server.ts" },
        devDependencies: { "@get-bb/plugin-sdk": SDK_VERSION },
      },
    });

    const result = await migratePluginToPackageLayout({
      rootDir,
      sdkArtifact: SDK_ARTIFACT,
    });

    expect(result.changed).toBe(true);
    expect(result.pin).toEqual({ from: SDK_VERSION, to: SDK_PIN });
    expect(result.enginesFloor).toBeNull();
    expect(result.removedPathMaps).toEqual([
      "@get-bb/plugin-sdk",
      "@get-bb/plugin-sdk/app",
    ]);
    expect(await exists(join(rootDir, "types"))).toBe(false);
    expect((await resolvePluginSdkLayout(rootDir)).kind).toBe("package");
  });

  it("keeps a types/ directory that still holds the author's own files", async () => {
    await writeVendoredPlugin(rootDir);
    await writeFile(join(rootDir, "types", "custom.d.ts"), "// mine\n");

    const result = await migratePluginToPackageLayout({
      rootDir,
      sdkArtifact: SDK_ARTIFACT,
    });

    expect(result.removedTypesDir).toBe(false);
    expect(await exists(join(rootDir, "types", "custom.d.ts"))).toBe(true);
    expect(await exists(join(rootDir, "types", "bb-plugin-sdk.d.ts"))).toBe(
      false,
    );
    expect(result.removedIncludes).toEqual([]);
    const tsconfig = await readJson(join(rootDir, "tsconfig.json"));
    expect(tsconfig.include).toEqual(["server.ts", "app.tsx", "types"]);
  });

  it("removes the pre-rename @bb/plugin-sdk path maps too", async () => {
    await writeVendoredPlugin(rootDir, {
      tsconfig: {
        compilerOptions: {
          paths: {
            "@bb/plugin-sdk": ["./types/bb-plugin-sdk.d.ts"],
            "@bb/plugin-sdk/app": ["./types/bb-plugin-sdk-app.d.ts"],
            "@/*": ["./*"],
          },
        },
        include: ["server.ts", "types"],
      },
    });

    const result = await migratePluginToPackageLayout({
      rootDir,
      sdkArtifact: SDK_ARTIFACT,
    });

    expect(result.removedPathMaps).toEqual([
      "@bb/plugin-sdk",
      "@bb/plugin-sdk/app",
    ]);
    const tsconfig = await readJson(join(rootDir, "tsconfig.json"));
    expect((tsconfig.compilerOptions as Record<string, unknown>).paths).toEqual(
      { "@/*": ["./*"] },
    );
    expect((await resolvePluginSdkLayout(rootDir)).kind).toBe("package");
  });

  it("moves an exact pin out of dependencies and collapses a duplicate", async () => {
    await writeVendoredPlugin(rootDir, {
      declarations: [],
      manifest: {
        name: "bb-plugin-runtime-pin",
        engines: { bbPluginSdk: `>=${SDK_VERSION}` },
        bb: { server: "./server.ts" },
        dependencies: { "@get-bb/plugin-sdk": SDK_VERSION, zod: "^4.3.6" },
        devDependencies: { "@get-bb/plugin-sdk": SDK_VERSION },
      },
      tsconfig: { compilerOptions: { strict: true }, include: ["server.ts"] },
    });

    const result = await migratePluginToPackageLayout({
      rootDir,
      sdkArtifact: SDK_ARTIFACT,
    });

    expect(result.changed).toBe(true);
    expect(result.movedFromDependencies).toBe(true);
    const manifest = await readJson(join(rootDir, "package.json"));
    expect(manifest.dependencies).toEqual({ zod: "^4.3.6" });
    expect(manifest.devDependencies).toEqual({
      "@omnyo/plugin-sdk": SDK_PIN,
    });
  });

  it("adds the pin and floor to a plugin with no vendored artifacts left", async () => {
    await writeVendoredPlugin(rootDir, {
      declarations: [],
      manifest: {
        name: "bb-plugin-pinless",
        bb: { server: "./server.ts" },
        devDependencies: { typescript: "^5.7.0" },
      },
      tsconfig: { compilerOptions: { strict: true }, include: ["server.ts"] },
    });

    const result = await migratePluginToPackageLayout({
      rootDir,
      sdkArtifact: SDK_ARTIFACT,
    });

    expect(result.changed).toBe(true);
    expect(result.pin).toEqual({ from: null, to: SDK_PIN });
    expect(result.enginesFloor).toEqual({ from: null, to: `>=${SDK_VERSION}` });
    const manifest = await readJson(join(rootDir, "package.json"));
    expect(
      (manifest.devDependencies as Record<string, string>)["@omnyo/plugin-sdk"],
    ).toBe(SDK_PIN);
  });

  it("rewrites pre-rename SDK imports across the plugin's sources", async () => {
    await writeVendoredPlugin(rootDir);
    await writeFile(
      join(rootDir, "server.ts"),
      [
        'import { defineRpcContract, type BbPluginApi } from "@bb/plugin-sdk";',
        "import type { Something } from '@bb/plugin-sdk/testing';",
        'import { helper } from "@bb/plugin-sdk-extras";',
        "// The @bb/plugin-sdk types are unquoted prose and stay as written.",
        "export const contract = defineRpcContract({});",
      ].join("\n") + "\n",
    );
    await writeFile(
      join(rootDir, "app.tsx"),
      'import { definePluginApp } from "@bb/plugin-sdk/app";\n',
    );
    await mkdir(join(rootDir, "lib"), { recursive: true });
    await writeFile(
      join(rootDir, "lib", "rpc.ts"),
      'export type { RpcContract } from "@bb/plugin-sdk";\n',
    );
    await mkdir(join(rootDir, "dist"), { recursive: true });
    await writeFile(
      join(rootDir, "dist", "server.ts"),
      'import "@bb/plugin-sdk";\n',
    );
    await mkdir(join(rootDir, "node_modules", "dep"), { recursive: true });
    await writeFile(
      join(rootDir, "node_modules", "dep", "index.ts"),
      'import "@bb/plugin-sdk";\n',
    );

    const result = await migratePluginToPackageLayout({
      rootDir,
      sdkArtifact: SDK_ARTIFACT,
    });

    expect(
      result.rewrittenImports.map(({ path, imports }) => ({ path, imports })),
    ).toEqual([
      { path: "app.tsx", imports: 1 },
      { path: "lib/rpc.ts", imports: 1 },
      { path: "server.ts", imports: 3 },
    ]);
    const server = await readFile(join(rootDir, "server.ts"), "utf8");
    expect(server).toContain(
      'import { defineRpcContract, type PluginApi as BbPluginApi } from "@omnyo/plugin-sdk";',
    );
    expect(server).toContain("from '@omnyo/plugin-sdk/testing';");
    expect(server).toContain('from "@bb/plugin-sdk-extras";');
    expect(server).toContain("// The @bb/plugin-sdk types are unquoted prose");
    expect(await readFile(join(rootDir, "app.tsx"), "utf8")).toBe(
      'import { definePluginApp } from "@omnyo/plugin-sdk/app";\n',
    );
    expect(await readFile(join(rootDir, "lib", "rpc.ts"), "utf8")).toBe(
      'export type { RpcContract } from "@omnyo/plugin-sdk";\n',
    );
    expect(await readFile(join(rootDir, "dist", "server.ts"), "utf8")).toBe(
      'import "@bb/plugin-sdk";\n',
    );
    expect(
      await readFile(join(rootDir, "node_modules", "dep", "index.ts"), "utf8"),
    ).toBe('import "@bb/plugin-sdk";\n');

    const second = await migratePluginToPackageLayout({
      rootDir,
      sdkArtifact: SDK_ARTIFACT,
    });

    expect(second.rewrittenImports).toEqual([]);
    expect(second.changed).toBe(false);
  });

  it("reports the import rewrites in a dry run without writing them", async () => {
    await writeVendoredPlugin(rootDir);
    const source = 'import type { BbPluginApi } from "@bb/plugin-sdk";\n';
    await writeFile(join(rootDir, "server.ts"), source);

    const plan = await migratePluginToPackageLayout({
      rootDir,
      sdkArtifact: SDK_ARTIFACT,
      dryRun: true,
    });

    expect(
      plan.rewrittenImports.map(({ path, imports }) => ({ path, imports })),
    ).toEqual([{ path: "server.ts", imports: 2 }]);
    expect(await readFile(join(rootDir, "server.ts"), "utf8")).toBe(source);
  });

  it("migrates legacy metadata and package pins together with pre-rename imports", async () => {
    await writeVendoredPlugin(rootDir, {
      declarations: [],
      manifest: {
        name: "bb-plugin-imports-only",
        engines: { bbPluginSdk: `>=${SDK_VERSION}` },
        bb: { server: "./server.ts" },
        devDependencies: { "@get-bb/plugin-sdk": SDK_VERSION },
      },
      tsconfig: { compilerOptions: { strict: true }, include: ["server.ts"] },
    });
    await writeFile(join(rootDir, "server.ts"), 'import "@bb/plugin-sdk";\n');

    const result = await migratePluginToPackageLayout({
      rootDir,
      sdkArtifact: SDK_ARTIFACT,
    });

    expect(result.changed).toBe(true);
    expect(
      result.rewrittenImports.map(({ path, imports }) => ({ path, imports })),
    ).toEqual([{ path: "server.ts", imports: 1 }]);
    expect(await readFile(join(rootDir, "server.ts"), "utf8")).toBe(
      'import "@omnyo/plugin-sdk";\n',
    );
  });

  it("migrates an otherwise-current plugin whose only legacy artifact is its imports", async () => {
    const manifest = {
      name: "bb-plugin-imports-only",
      engines: { omnyoPluginSdk: `>=${SDK_VERSION}` },
      omnyo: { server: "./server.ts" },
      devDependencies: { "@omnyo/plugin-sdk": SDK_PIN },
    };

    await writeVendoredPlugin(rootDir, {
      declarations: [],
      manifest,
      tsconfig: { compilerOptions: { strict: true }, include: ["server.ts"] },
    });
    await installPrivateSdkArtifact(rootDir, SDK_ARTIFACT);
    const before = await readFile(join(rootDir, "package.json"));
    await writeFile(join(rootDir, "server.ts"), 'import "@bb/plugin-sdk";\n');

    const result = await migratePluginToPackageLayout({
      rootDir,
      sdkArtifact: SDK_ARTIFACT,
    });

    expect(result.changed).toBe(true);
    expect(result.pin).toBeNull();
    expect(result.enginesFloor).toBeNull();
    expect(result.archivedFiles).toEqual([]);
    expect(result.removedPathMaps).toEqual([]);
    expect(result.artifactCopyRequired).toBe(false);
    expect(
      result.rewrittenImports.map(({ path, imports }) => ({ path, imports })),
    ).toEqual([{ path: "server.ts", imports: 1 }]);
    expect(await readFile(join(rootDir, "server.ts"), "utf8")).toBe(
      'import "@omnyo/plugin-sdk";\n',
    );
    expect(await readFile(join(rootDir, "package.json"))).toEqual(before);
    expect(
      (
        await migratePluginToPackageLayout({
          rootDir,
          sdkArtifact: SDK_ARTIFACT,
        })
      ).changed,
    ).toBe(false);
  });

  it("dry runs report the plan and touch nothing", async () => {
    await writeVendoredPlugin(rootDir);
    const before = await readFile(join(rootDir, "package.json"), "utf8");

    const plan = await migratePluginToPackageLayout({
      rootDir,
      sdkArtifact: SDK_ARTIFACT,
      dryRun: true,
    });

    expect(plan.changed).toBe(true);
    expect(plan.archivedFiles.length).toBe(2);
    expect(await readFile(join(rootDir, "package.json"), "utf8")).toBe(before);
    expect(await exists(join(rootDir, "types", "bb-plugin-sdk.d.ts"))).toBe(
      true,
    );
  });

  it("refuses a symlinked types/ and changes nothing at all", async () => {
    await writeVendoredPlugin(rootDir, { declarations: [] });
    const outside = await mkdtemp(join(tmpdir(), "omnyo-plugin-outside-"));

    try {
      await writeFile(join(outside, "bb-plugin-sdk.d.ts"), "PRECIOUS\n");
      await symlink(outside, join(rootDir, "types"));

      const manifestBefore = await readFile(
        join(rootDir, "package.json"),
        "utf8",
      );

      await expect(
        migratePluginToPackageLayout({ rootDir, sdkArtifact: SDK_ARTIFACT }),
      ).rejects.toThrow(/symbolic link/);

      expect(await readFile(join(outside, "bb-plugin-sdk.d.ts"), "utf8")).toBe(
        "PRECIOUS\n",
      );
      expect(await readFile(join(rootDir, "package.json"), "utf8")).toBe(
        manifestBefore,
      );
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  it("refuses a tsconfig it cannot parse rather than rewriting it", async () => {
    await writeVendoredPlugin(rootDir);
    await writeFile(
      join(rootDir, "tsconfig.json"),
      '{\n  // paths\n  "compilerOptions": { "paths": {} }\n}\n',
    );

    const manifestBefore = await readFile(
      join(rootDir, "package.json"),
      "utf8",
    );

    await expect(
      migratePluginToPackageLayout({ rootDir, sdkArtifact: SDK_ARTIFACT }),
    ).rejects.toThrow(/tsconfig\.json is not valid JSON/);

    expect(await readFile(join(rootDir, "package.json"), "utf8")).toBe(
      manifestBefore,
    );
    expect(await exists(join(rootDir, "types", "bb-plugin-sdk.d.ts"))).toBe(
      true,
    );
  });
});

describe("setPluginSdkPin", () => {
  let rootDir: string;

  beforeEach(async () => {
    rootDir = await mkdtemp(join(tmpdir(), "omnyo-plugin-pin-"));
  });

  afterEach(async () => {
    await rm(rootDir, { recursive: true, force: true });
  });

  it("repoints an outdated pin and leaves the engines floor alone", async () => {
    await writeFile(
      join(rootDir, "package.json"),
      `${JSON.stringify(
        {
          name: "bb-plugin-pinned",
          engines: { bbPluginSdk: ">=0.2.0" },
          bb: { server: "./server.ts" },
          devDependencies: {
            "@get-bb/plugin-sdk": "0.2.0",
            typescript: "^5.7.0",
          },
        },
        null,
        2,
      )}\n`,
    );

    const result = await setPluginSdkPin({
      rootDir,
      sdkArtifact: SDK_ARTIFACT,
    });

    expect(result).toMatchObject({
      pin: { from: "0.2.0", to: SDK_PIN },
      movedFromDependencies: false,
      shimmedTypePins: [],
    });
    const manifest = await readJson(join(rootDir, "package.json"));
    expect(
      (manifest.devDependencies as Record<string, string>)["@omnyo/plugin-sdk"],
    ).toBe(SDK_PIN);
    expect((manifest.engines as Record<string, string>).omnyoPluginSdk).toBe(
      ">=0.2.0",
    );
    expect(
      await setPluginSdkPin({ rootDir, sdkArtifact: SDK_ARTIFACT }),
    ).toBeNull();
  });

  it("moves an already-exact pin out of dependencies", async () => {
    await writeFile(
      join(rootDir, "package.json"),
      `${JSON.stringify(
        {
          name: "bb-plugin-exact-runtime-dep",
          bb: { server: "./server.ts" },
          dependencies: { "@get-bb/plugin-sdk": SDK_VERSION },
        },
        null,
        2,
      )}\n`,
    );

    const result = await setPluginSdkPin({
      rootDir,
      sdkArtifact: SDK_ARTIFACT,
    });

    expect(result).toMatchObject({
      pin: { from: SDK_VERSION, to: SDK_PIN },
      movedFromDependencies: true,
      shimmedTypePins: [],
    });
    const manifest = await readJson(join(rootDir, "package.json"));
    expect(manifest.dependencies).toBeUndefined();
    expect(manifest.devDependencies).toEqual({
      "@omnyo/plugin-sdk": SDK_PIN,
    });
    expect(
      await setPluginSdkPin({ rootDir, sdkArtifact: SDK_ARTIFACT }),
    ).toBeNull();
  });

  it("brings an app plugin's shimmed packages to the host's versions in devDependencies", async () => {
    const hostSonner = PLUGIN_SHIMMED_TYPE_DEPENDENCIES.sonner!;
    const hostVaul = PLUGIN_SHIMMED_TYPE_DEPENDENCIES.vaul!;
    await writeFile(
      join(rootDir, "package.json"),
      `${JSON.stringify(
        {
          name: "bb-plugin-toasty",
          bb: { server: "./server.ts", app: "./app.tsx" },
          dependencies: { vaul: "^0.9.0", zod: "^4.3.6" },
          devDependencies: {
            "@get-bb/plugin-sdk": SDK_VERSION,
            sonner: "^0.3.0",
            typescript: "^5.7.0",
          },
        },
        null,
        2,
      )}\n`,
    );

    const original = await readFile(join(rootDir, "package.json"), "utf8");

    const pending = await setPluginSdkPin({
      rootDir,
      sdkArtifact: SDK_ARTIFACT,
      dryRun: true,
    });

    expect(await readFile(join(rootDir, "package.json"), "utf8")).toBe(
      original,
    );

    const result = await setPluginSdkPin({
      rootDir,
      sdkArtifact: SDK_ARTIFACT,
    });

    expect(result).toEqual(pending);
    expect(result?.pin).toEqual({ from: SDK_VERSION, to: SDK_PIN });
    expect(result?.shimmedTypePins).toContainEqual({
      name: "sonner",
      from: "^0.3.0",
      to: hostSonner,
      movedFromDependencies: false,
    });
    expect(result?.shimmedTypePins).toContainEqual({
      name: "vaul",
      from: "^0.9.0",
      to: hostVaul,
      movedFromDependencies: true,
    });
    expect(result?.shimmedTypePins).toHaveLength(2);
    const manifest = await readJson(join(rootDir, "package.json"));
    expect(manifest.dependencies).toEqual({ zod: "^4.3.6" });
    expect(manifest.devDependencies).toEqual({
      "@omnyo/plugin-sdk": SDK_PIN,
      sonner: hostSonner,
      vaul: hostVaul,
      typescript: "^5.7.0",
    });
    expect(
      await setPluginSdkPin({ rootDir, sdkArtifact: SDK_ARTIFACT }),
    ).toBeNull();
  });

  it.each([true, false])(
    "allows an app plugin with no shim packages (dryRun: %s)",
    async (dryRun) => {
      const original = JSON.stringify({
        name: "bb-plugin-pruned",
        omnyo: { server: "./server.ts", app: "./app.tsx" },
        devDependencies: { "@omnyo/plugin-sdk": SDK_PIN },
      });

      await writeFile(join(rootDir, "package.json"), original);
      await installPrivateSdkArtifact(rootDir, SDK_ARTIFACT);

      expect(
        await setPluginSdkPin({
          rootDir,
          sdkArtifact: SDK_ARTIFACT,
          dryRun,
        }),
      ).toBeNull();
      expect(await readFile(join(rootDir, "package.json"), "utf8")).toBe(
        original,
      );
    },
  );

  it("only repins the shimmed packages a headless plugin already declares", async () => {
    await writeFile(
      join(rootDir, "package.json"),
      `${JSON.stringify(
        {
          name: "bb-plugin-headless",
          bb: { server: "./server.ts" },
          devDependencies: {
            "@get-bb/plugin-sdk": SDK_VERSION,
            clsx: "^1.0.0",
          },
        },
        null,
        2,
      )}\n`,
    );

    const result = await setPluginSdkPin({
      rootDir,
      sdkArtifact: SDK_ARTIFACT,
    });

    expect(result?.shimmedTypePins).toEqual([
      {
        name: "clsx",
        from: "^1.0.0",
        to: PLUGIN_SHIMMED_TYPE_DEPENDENCIES.clsx,
        movedFromDependencies: false,
      },
    ]);
    const manifest = await readJson(join(rootDir, "package.json"));
    expect(manifest.devDependencies).toEqual({
      "@omnyo/plugin-sdk": SDK_PIN,
      clsx: PLUGIN_SHIMMED_TYPE_DEPENDENCIES.clsx,
    });
  });
});
