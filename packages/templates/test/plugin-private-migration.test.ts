import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { PLUGIN_SDK_VERSION } from "@omnyo/domain";
import {
  migratePluginToPackageLayout,
  setPluginSdkPin,
} from "../src/plugin-scaffold.js";
import {
  readPrivateSdkArtifact,
  type PrivateSdkArtifact,
} from "../src/private-sdk-artifact.js";

let root: string;

let plugin: string;

let artifact: PrivateSdkArtifact;

const userDeclaration =
  "export interface UserWork { title: 'BB user text'; }\n";

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "omnyo-private-migration-"));
  plugin = join(root, "plugin");
  const sdk = join(root, "sdk");
  await mkdir(plugin);
  await mkdir(sdk);
  const bytes = Buffer.from("private SDK boundary fixture");
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const file = `omnyo-plugin-sdk-${PLUGIN_SDK_VERSION}-${sha256.slice(0, 12)}.tgz`;
  await writeFile(join(sdk, file), bytes);
  await writeFile(
    join(sdk, "manifest.json"),
    JSON.stringify({
      schema: 1,
      packageName: "@omnyo/plugin-sdk",
      version: PLUGIN_SDK_VERSION,
      file,
      sha256,
    }),
  );
  artifact = await readPrivateSdkArtifact(sdk);
  await writeFile(
    join(plugin, "package.json"),
    JSON.stringify({
      name: "user-plugin",
      version: "1.0.0",
      bb: {
        name: "User plugin",
        description: "Author content",
        branding: { icon: "ListTodo" },
        server: "./server.ts",
      },
      permissions: { network: true },
      engines: { bb: ">=0.40", bbPluginSdk: ">=0.4.8" },
      devDependencies: { "@get-bb/plugin-sdk": "0.4.8" },
      userText: "BB remains my project name",
    }),
  );
  await writeFile(
    join(plugin, "server.ts"),
    'import type { BbPluginApi } from "@get-bb/plugin-sdk"; const prose = "@bb/plugin-sdk"; export default function plugin(bb: BbPluginApi) { return bb; }',
  );
});

afterEach(async () => {
  await rm(root, { recursive: true });
});

it("migrates exact metadata and SDK inputs while preserving plugin identity, permissions and user bindings", async () => {
  const result = await migratePluginToPackageLayout({
    rootDir: plugin,
    sdkArtifact: artifact,
  });

  const manifest = JSON.parse(
    await readFile(join(plugin, "package.json"), "utf8"),
  );

  expect(result.changed).toBe(true);
  expect(manifest.name).toBe("user-plugin");
  expect(manifest.permissions).toEqual({ network: true });
  expect(manifest.userText).toBe("BB remains my project name");
  expect(manifest.bb).toBeUndefined();
  expect(manifest.engines.bb).toBeUndefined();
  expect(manifest.engines.omnyoPluginSdk).toBe(`>=${PLUGIN_SDK_VERSION}`);
  expect(manifest.devDependencies["@omnyo/plugin-sdk"]).toBe(
    `file:./vendor/${artifact.file}`,
  );
  expect(manifest.devDependencies["@get-bb/plugin-sdk"]).toBeUndefined();
  expect(await readFile(join(plugin, "server.ts"), "utf8")).toContain(
    'PluginApi as BbPluginApi } from "@omnyo/plugin-sdk"',
  );
  expect(await readFile(join(plugin, "server.ts"), "utf8")).toContain(
    'const prose = "@bb/plugin-sdk"',
  );
  expect(
    (
      await migratePluginToPackageLayout({
        rootDir: plugin,
        sdkArtifact: artifact,
      })
    ).changed,
  ).toBe(false);
});

it("dry run returns the digest pin without copying or changing any input", async () => {
  const before = await readFile(join(plugin, "package.json"));

  const plan = await migratePluginToPackageLayout({
    rootDir: plugin,
    sdkArtifact: artifact,
    dryRun: true,
  });

  expect(plan.pin?.to).toBe(`file:./vendor/${artifact.file}`);
  expect(await readFile(join(plugin, "package.json"))).toEqual(before);
  expect(await readdir(plugin)).toEqual(["package.json", "server.ts"]);
});

it("refuses differing dual SDK identities before touching plugin source or manifest", async () => {
  const path = join(plugin, "package.json");
  const value = JSON.parse(await readFile(path, "utf8"));
  value.devDependencies["@omnyo/plugin-sdk"] = "file:./vendor/another.tgz";
  await writeFile(path, JSON.stringify(value));
  const before = await readFile(path);
  await expect(
    migratePluginToPackageLayout({ rootDir: plugin, sdkArtifact: artifact }),
  ).rejects.toThrow(/conflict/i);
  expect(await readFile(path)).toEqual(before);
  expect(await readdir(plugin)).toEqual(["package.json", "server.ts"]);
});

it("refuses malformed source before copying the SDK or writing metadata", async () => {
  await writeFile(
    join(plugin, "server.ts"),
    'import { BbPluginApi from "@get-bb/plugin-sdk";',
  );
  const before = await readFile(join(plugin, "package.json"));
  await expect(
    migratePluginToPackageLayout({ rootDir: plugin, sdkArtifact: artifact }),
  ).rejects.toThrow(/Cannot parse/);
  expect(await readFile(join(plugin, "package.json"))).toEqual(before);
  expect(await readdir(plugin)).toEqual(["package.json", "server.ts"]);
});

it("retains vendored declarations byte for byte in a finite archive instead of deleting user work", async () => {
  await mkdir(join(plugin, "types"));
  await writeFile(join(plugin, "types", "bb-plugin-sdk.d.ts"), userDeclaration);
  await writeFile(
    join(plugin, "types", "user.d.ts"),
    "export type Author = string;\n",
  );
  await migratePluginToPackageLayout({
    rootDir: plugin,
    sdkArtifact: artifact,
  });
  expect(
    await readFile(
      join(plugin, "vendor", "legacy-plugin-sdk-v1", "bb-plugin-sdk.d.ts"),
      "utf8",
    ),
  ).toBe(userDeclaration);
  expect(await readFile(join(plugin, "types", "user.d.ts"), "utf8")).toBe(
    "export type Author = string;\n",
  );
});

it("types repins current SDK bytes idempotently without a registry lookup", async () => {
  const changed = await setPluginSdkPin({
    rootDir: plugin,
    sdkArtifact: artifact,
  });

  expect(changed?.pin?.to).toBe(`file:./vendor/${artifact.file}`);
  expect(await readFile(join(plugin, "vendor", artifact.file))).toEqual(
    await readFile(artifact.artifactPath),
  );
  expect(
    await setPluginSdkPin({ rootDir: plugin, sdkArtifact: artifact }),
  ).toBeNull();
});

it("check reports a missing owned copy without writing and apply repairs only that copy", async () => {
  await migratePluginToPackageLayout({
    rootDir: plugin,
    sdkArtifact: artifact,
  });
  await rm(join(plugin, "vendor", artifact.file));
  const before = await readFile(join(plugin, "package.json"));

  const check = await setPluginSdkPin({
    rootDir: plugin,
    sdkArtifact: artifact,
    dryRun: true,
  });

  expect(check?.artifactCopyRequired).toBe(true);
  expect(await readdir(join(plugin, "vendor"))).toEqual([]);
  expect(await readFile(join(plugin, "package.json"))).toEqual(before);
  await setPluginSdkPin({ rootDir: plugin, sdkArtifact: artifact });
  expect(await readFile(join(plugin, "package.json"))).toEqual(before);
  expect(
    await setPluginSdkPin({
      rootDir: plugin,
      sdkArtifact: artifact,
      dryRun: true,
    }),
  ).toBeNull();
});

it("refuses an archive collision before copying the SDK or changing the manifest", async () => {
  await mkdir(join(plugin, "types"));
  await writeFile(join(plugin, "types", "bb-plugin-sdk.d.ts"), userDeclaration);
  await mkdir(join(plugin, "vendor", "legacy-plugin-sdk-v1"), {
    recursive: true,
  });

  const archived = join(
    plugin,
    "vendor",
    "legacy-plugin-sdk-v1",
    "bb-plugin-sdk.d.ts",
  );

  await writeFile(archived, "Different author declaration");
  const before = await readFile(join(plugin, "package.json"));
  await expect(
    migratePluginToPackageLayout({ rootDir: plugin, sdkArtifact: artifact }),
  ).rejects.toThrow(/collision/);
  expect(await readFile(join(plugin, "package.json"))).toEqual(before);
  expect(
    await readFile(join(plugin, "types", "bb-plugin-sdk.d.ts"), "utf8"),
  ).toBe(userDeclaration);
  expect(await readFile(archived, "utf8")).toBe("Different author declaration");
  expect(await readdir(join(plugin, "vendor"))).toEqual([
    "legacy-plugin-sdk-v1",
  ]);
});
