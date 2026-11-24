import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, test } from "vitest";
import { artifactPiece, prepareCohortPluginArtifactV1 } from "../../../scripts/private-plugin-cohort-artifact.mjs";
import { createPluginArtifactMeta } from "../../plugin-build/src/plugin-artifact-meta.ts";

const roots = [];

test("reads actual builder sidecars without changing the cohort manifest format field", async () => {
  const { outputRoot } = await fixture();
  await mkdir(join(outputRoot, "dist"));
  const code = "export default {};\n";
  const metadata = JSON.stringify(createPluginArtifactMeta({ packageName: "omnyo-plugin-cohort-proof", pluginVersion: "1.2.3", coreVersion: "0.46.242+private.1" }));
  await writeFile(join(outputRoot, "dist/server.js"), code);
  await writeFile(join(outputRoot, "dist/server.meta.json"), metadata);
  await expect(artifactPiece(outputRoot, "server")).resolves.toEqual({ path: "dist/server.js", sha256: createHash("sha256").update(code).digest("hex"), metadataPath: "dist/server.meta.json", metadataSha256: createHash("sha256").update(metadata).digest("hex"), formatVersion: 2 });
  expect(await readFile(join(outputRoot, "dist/server.meta.json"), "utf8")).toBe(metadata);
});

test("rejects a manifest projection passed as a sidecar without mutating it", async () => {
  const { outputRoot } = await fixture();
  await mkdir(join(outputRoot, "dist"));
  const metadata = JSON.stringify({ formatVersion: 2 });
  await writeFile(join(outputRoot, "dist/server.js"), "export default {};\n");
  await writeFile(join(outputRoot, "dist/server.meta.json"), metadata);
  await expect(artifactPiece(outputRoot, "server")).rejects.toThrow();
  expect(await readFile(join(outputRoot, "dist/server.meta.json"), "utf8")).toBe(metadata);
});

afterEach(async () => {
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});

async function fixture() {
  const outputRoot = await realpath(
    await mkdtemp(join(tmpdir(), "omnyo-cohort-producer-")),
  );

  roots.push(outputRoot);

  const binding = {
    coreSourceCommit: "a".repeat(40),
    pluginSourceCommit: "b".repeat(40),
    runtimeSha256: "c".repeat(64),
    installedInventorySha256: "d".repeat(64),
  };

  const args = {
    outputRoot,
    id: "owned-plugin",
    binding,
    produce: async (stage) => {
      await mkdir(stage);
      await writeFile(join(stage, "artifact.js"), "export const value = 42;\n");
    },
    inspect: async (stage, artifactRoot) => ({
      artifactRoot,
      digest: createHash("sha256")
        .update(await readFile(join(stage, "artifact.js")))
        .digest("hex"),
    }),
  };

  return {
    outputRoot,
    args,
    journalPath: join(outputRoot, "entries/owned-plugin.producer.json"),
  };
}

test("reuses exact promoted bytes after lost completion acknowledgement and refuses source drift or tampering", async () => {
  const f = await fixture();
  const first = await prepareCohortPluginArtifactV1(f.args);

  const produce = async () => {
    throw new Error("A completed artifact must not be rebuilt");
  };

  expect(await prepareCohortPluginArtifactV1({ ...f.args, produce })).toEqual(
    first,
  );
  const journalBefore = await readFile(f.journalPath, "utf8");
  await expect(
    prepareCohortPluginArtifactV1({
      ...f.args,
      binding: { ...f.args.binding, runtimeSha256: "e".repeat(64) },
    }),
  ).rejects.toThrow("different source");
  expect(await readFile(f.journalPath, "utf8")).toBe(journalBefore);
  await writeFile(join(first.artifactRoot, "artifact.js"), "changed");
  await expect(
    prepareCohortPluginArtifactV1({ ...f.args, produce }),
  ).rejects.toThrow("bytes differ");
});

test("recovers a prepared stage without replaying production and cleans only its bound source workspace", async () => {
  const f = await fixture();
  const first = await prepareCohortPluginArtifactV1(f.args);
  const journal = JSON.parse(await readFile(f.journalPath, "utf8"));
  await rename(first.artifactRoot, journal.stagingRoot);
  await mkdir(journal.workRoot);
  await writeFile(
    join(journal.workRoot, "temporary-input"),
    "owned disposable source copy",
  );
  expect(
    await prepareCohortPluginArtifactV1({
      ...f.args,
      produce: async () => {
        throw new Error("Unexpected rebuild");
      },
    }),
  ).toEqual(first);
  expect(existsSync(journal.stagingRoot)).toBe(false);
  expect(existsSync(journal.workRoot)).toBe(false);
});

test("cleans failed owned partial production and refuses an unclaimed destination", async () => {
  const f = await fixture();
  await expect(
    prepareCohortPluginArtifactV1({
      ...f.args,
      produce: async (stage) => {
        await mkdir(stage);
        await writeFile(join(stage, "partial"), "incomplete");
        throw new Error("Producer failed");
      },
    }),
  ).rejects.toThrow("Producer failed");
  const journal = JSON.parse(await readFile(f.journalPath, "utf8"));
  expect(existsSync(journal.stagingRoot)).toBe(false);
  expect(existsSync(journal.workRoot)).toBe(false);
  await prepareCohortPluginArtifactV1(f.args);
  const other = await fixture();
  await mkdir(join(other.outputRoot, "owned-plugin"));
  await writeFile(
    join(other.outputRoot, "owned-plugin/user-file"),
    "preserved",
  );
  await expect(prepareCohortPluginArtifactV1(other.args)).rejects.toThrow(
    "Unclaimed",
  );
  expect(
    await readFile(join(other.outputRoot, "owned-plugin/user-file"), "utf8"),
  ).toBe("preserved");
});

test("recovers after actual producer death releases its native lock", async () => {
  const f = await fixture();

  const moduleUrl = new URL(
    "../../../scripts/private-plugin-cohort-artifact.mjs",
    import.meta.url,
  ).href;

  const code = `import {prepareCohortPluginArtifactV1} from ${JSON.stringify(moduleUrl)};import {mkdir,writeFile} from 'node:fs/promises';import{join}from'node:path';await prepareCohortPluginArtifactV1({outputRoot:${JSON.stringify(f.outputRoot)},id:'owned-plugin',binding:${JSON.stringify(f.args.binding)},produce:async(stage)=>{await mkdir(stage);await writeFile(join(stage,'partial'),'interrupted');setInterval(()=>{},1000);process.stdout.write('ready\\n');await new Promise(()=>{});},inspect:async()=>{throw Error('unreachable')}});`;

  const child = spawn(
    process.execPath,
    [
      "--conditions=source",
      "--import",
      "tsx",
      "--input-type=module",
      "-e",
      code,
    ],
    {
      cwd: fileURLToPath(new URL("../../../", import.meta.url)),
      stdio: ["ignore", "pipe", "pipe"],
    },
  );

  const exited = new Promise((resolve) =>
    child.once("exit", (code, signal) => resolve({ code, signal })),
  );

  try {
    await new Promise((resolve, reject) => {
      let text = "";
      child.stdout.on("data", (chunk) => {
        text += chunk;

        if (text.includes("ready")) resolve();
      });
      child.once("error", reject);
      child.once("exit", () =>
        reject(new Error("Producer exited before its interrupted checkpoint")),
      );
      setTimeout(
        () => reject(new Error("Producer checkpoint exceeded 5 seconds")),
        5000,
      ).unref();
    });
    child.kill("SIGKILL");
    expect((await exited).signal).toBe("SIGKILL");
    const final = await prepareCohortPluginArtifactV1(f.args);
    expect(
      await readFile(join(final.artifactRoot, "artifact.js"), "utf8"),
    ).toContain("42");
    const journal = JSON.parse(await readFile(f.journalPath, "utf8"));
    expect(existsSync(journal.workRoot)).toBe(false);
    expect(existsSync(join(final.artifactRoot, "partial"))).toBe(false);
  } finally {
    if (child.exitCode === null && child.signalCode === null)
      child.kill("SIGKILL");
    await exited;
  }
});
