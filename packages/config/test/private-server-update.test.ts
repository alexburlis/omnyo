import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  formatPrivateServerUpdateManifestPath,
  readPrivateServerUpdateManifest,
} from "../src/app-update.js";

const dataDirs: string[] = [];

async function createDataDir(): Promise<string> {
  const dataDir = await mkdtemp(join(tmpdir(), "omnyo-private-server-update-"));
  dataDirs.push(dataDir);

  return dataDir;
}

async function writeManifest(dataDir: string, text: string): Promise<void> {
  const path = formatPrivateServerUpdateManifestPath(dataDir);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, text);
}

const manifest = {
  schema: 1,
  version: "0.46.20+private.1",
  protocolVersion: 237,
  sourceCommit: "a".repeat(40),
  runtimeSha256: "b".repeat(64),
  stagedAt: "2026-10-18T10:00:00.000Z",
};

afterEach(async () => {
  await Promise.all(
    dataDirs
      .splice(0)
      .map((dataDir) => rm(dataDir, { force: true, recursive: true })),
  );
});

describe("private server update manifest", () => {
  it("reports no update when nothing has been staged", async () => {
    expect(
      await readPrivateServerUpdateManifest(await createDataDir()),
    ).toEqual({ kind: "none" });
  });

  it("returns a staged runtime's identity", async () => {
    const dataDir = await createDataDir();
    await writeManifest(dataDir, JSON.stringify(manifest));
    expect(await readPrivateServerUpdateManifest(dataDir)).toEqual({
      kind: "available",
      manifest,
    });
  });

  it("returns a staged untagged 1.x runtime's identity", async () => {
    const dataDir = await createDataDir();
    const untagged = { ...manifest, version: "1.0.1" };
    await writeManifest(dataDir, JSON.stringify(untagged));
    expect(await readPrivateServerUpdateManifest(dataDir)).toEqual({
      kind: "available",
      manifest: untagged,
    });
  });

  it.each([
    { name: "malformed JSON", text: "{" },
    {
      name: "a two-part version",
      text: JSON.stringify({ ...manifest, version: "1.0" }),
    },
    {
      name: "an unknown build tag",
      text: JSON.stringify({ ...manifest, version: "1.0.1+build.1" }),
    },
    {
      name: "a prerelease version",
      text: JSON.stringify({ ...manifest, version: "1.0.1-beta" }),
    },
    {
      name: "a short runtime digest",
      text: JSON.stringify({ ...manifest, runtimeSha256: "b".repeat(63) }),
    },
    {
      name: "an unknown field",
      text: JSON.stringify({ ...manifest, approved: true }),
    },
  ])("reports $name visibly instead of ignoring it", async ({ text }) => {
    const dataDir = await createDataDir();
    await writeManifest(dataDir, text);
    expect(await readPrivateServerUpdateManifest(dataDir)).toMatchObject({
      kind: "invalid",
    });
  });
});
