import { createHash } from "node:crypto";
import {
  mkdtemp,
  mkdir,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PLUGIN_SDK_VERSION } from "@omnyo/domain";
import {
  scaffoldEventSourcePlugin,
  scaffoldPlugin,
} from "../src/plugin-scaffold.js";
import {
  readPrivateSdkArtifact,
  type PrivateSdkArtifact,
} from "../src/private-sdk-artifact.js";

let root: string;

let artifact: PrivateSdkArtifact;

const sdkBytes = Buffer.from("selected private SDK transport fixture");

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "omnyo-private-scaffold-"));
  const directory = join(root, "sdk");
  await mkdir(directory);
  const sha256 = createHash("sha256").update(sdkBytes).digest("hex");
  const file = `omnyo-plugin-sdk-${PLUGIN_SDK_VERSION}-${sha256.slice(0, 12)}.tgz`;
  await writeFile(join(directory, file), sdkBytes);
  await writeFile(
    join(directory, "manifest.json"),
    JSON.stringify({
      schema: 1,
      packageName: "@omnyo/plugin-sdk",
      version: PLUGIN_SDK_VERSION,
      file,
      sha256,
    }),
  );
  artifact = await readPrivateSdkArtifact(directory);
});

afterEach(async () => {
  await rm(root, { recursive: true });
});

describe.each([
  { variant: "ordinary", scaffold: scaffoldPlugin },
  { variant: "event source", scaffold: scaffoldEventSourcePlugin },
])("$variant private SDK admission", ({ scaffold }) => {
  it("creates a canonical private scaffold pinned to the selected SDK bytes", async () => {
    const targetDir = join(root, "omnyo-plugin-example");
    await scaffold({
      targetDir,
      packageName: "omnyo-plugin-example",
      appVersion: "0.46.242+private.1",
      sdkArtifact: artifact,
    });

    const manifest = JSON.parse(
      await readFile(join(targetDir, "package.json"), "utf8"),
    );

    expect(manifest.private).toBe(true);
    expect(manifest.omnyo.server).toBe("./server.ts");
    expect(manifest.engines.omnyoPluginSdk).toBe(`>=${PLUGIN_SDK_VERSION}`);
    expect(manifest.devDependencies["@omnyo/plugin-sdk"]).toBe(
      `file:./vendor/${artifact.file}`,
    );
    expect(manifest.devDependencies["@get-bb/plugin-sdk"]).toBeUndefined();
    expect(await readFile(join(targetDir, "vendor", artifact.file))).toEqual(
      sdkBytes,
    );
  });

  it("refuses corrupted selected SDK bytes before creating the plugin directory", async () => {
    const targetDir = join(root, "omnyo-plugin-corrupt");
    await writeFile(artifact.artifactPath, "changed");
    await expect(
      scaffold({
        targetDir,
        packageName: "omnyo-plugin-corrupt",
        appVersion: "0.46.242+private.1",
        sdkArtifact: artifact,
      }),
    ).rejects.toThrow(/digest/);
    await expect(stat(targetDir)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("refuses a missing selected SDK manifest before creating the plugin directory", async () => {
    const targetDir = join(root, "omnyo-plugin-missing");
    await rm(join(root, "sdk", "manifest.json"));
    await expect(
      scaffold({
        targetDir,
        packageName: "omnyo-plugin-missing",
        appVersion: "0.46.242+private.1",
        sdkArtifact: artifact,
      }),
    ).rejects.toThrow();
    await expect(stat(targetDir)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("preserves an existing destination and its opaque user work", async () => {
    const targetDir = join(root, "omnyo-plugin-existing");
    await mkdir(targetDir);
    await writeFile(
      join(targetDir, "user-work"),
      "BB user literal remains unchanged",
    );
    await expect(
      scaffold({
        targetDir,
        packageName: "omnyo-plugin-existing",
        appVersion: "0.46.242+private.1",
        sdkArtifact: artifact,
      }),
    ).rejects.toThrow(/already exists/);
    expect(await readFile(join(targetDir, "user-work"), "utf8")).toBe(
      "BB user literal remains unchanged",
    );
  });
});
