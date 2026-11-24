import { createHash } from "node:crypto";
import {
  mkdtemp,
  mkdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readBundledPluginCandidate } from "../bundled-plugin-candidate.js";

describe("bundled plugin local runtime upload", () => {
  const scratch: string[] = [];
  afterEach(async () => {
    await Promise.all(
      scratch
        .splice(0)
        .map((path) => rm(path, { recursive: true, force: true })),
    );
  });

  async function runtime() {
    const root = await mkdtemp(join(tmpdir(), "omnyo-plugin-upload-"));
    scratch.push(root);
    await mkdir(join(root, "dist"));
    await mkdir(join(root, "skills"));
    await writeFile(
      join(root, "package.json"),
      JSON.stringify({
        name: "omnyo-plugin-omnyo--fixture",
        version: "2.0.0",
        omnyo: {
          name: "Fixture",
          description: "Upload fixture",
          branding: { icon: "Zap" },
          server: "./dist/server.js",
          skills: ["skills"],
        },
      }),
    );
    await writeFile(join(root, "dist/server.js"), "export default () => {};\n");
    await writeFile(join(root, "skills/SKILL.md"), "Fixture skill\n");
    await mkdir(join(root, "skills/scripts"));
    await writeFile(join(root, "skills/scripts/action.mjs"), "export {};\n");

    return root;
  }

  const args = (directory: string) => ({
    directory,
    expectedVersion: "1.0.0",
    expectedArtifactId: null,
    sourceIdentity: null,
  });

  it("uploads prepared bytes with their digests and prior-registration binding, excluding checkout files", async () => {
    const directory = await runtime();
    await writeFile(join(directory, ".env"), "private fixture content");
    const candidate = await readBundledPluginCandidate(args(directory));
    expect(candidate.expectedVersion).toBe("1.0.0");
    expect(candidate.expectedArtifactId).toBeNull();
    expect(candidate.files.map((file) => file.path)).toEqual([
      "package.json",
      "dist/server.js",
      "skills/SKILL.md",
      "skills/scripts/action.mjs",
    ]);

    const server = candidate.files.find(
      (file) => file.path === "dist/server.js",
    );

    expect(server?.base64).toBe(
      Buffer.from("export default () => {};\n").toString("base64"),
    );
    expect(server?.sha256).toBe(
      createHash("sha256").update("export default () => {};\n").digest("hex"),
    );
  });

  it("appends the source identity to the upload without writing it to disk", async () => {
    const directory = await runtime();

    const sourceIdentity = {
      schema: 1 as const,
      sourceCommit: "a".repeat(40),
      path: "plugins/fixture",
    };

    const candidate = await readBundledPluginCandidate({
      ...args(directory),
      sourceIdentity,
    });

    const identity = candidate.files.find(
      (file) => file.path === "dist/omnyo-source.json",
    );

    expect(
      JSON.parse(Buffer.from(identity?.base64 ?? "", "base64").toString()),
    ).toEqual(sourceIdentity);
    await expect(
      readFile(join(directory, "dist/omnyo-source.json")),
    ).rejects.toThrow("ENOENT");
  });

  it("refuses a prepared runtime that already carries a source identity", async () => {
    const directory = await runtime();
    await writeFile(join(directory, "dist/omnyo-source.json"), "{}");
    await expect(readBundledPluginCandidate(args(directory))).rejects.toThrow(
      "must not contain dist/omnyo-source.json",
    );
  });

  it("rejects symlinked runtime files before reading their target", async () => {
    const directory = await runtime();
    await symlink("../package.json", join(directory, "dist/link.json"));
    await expect(readBundledPluginCandidate(args(directory))).rejects.toThrow(
      "symlinks are refused",
    );
  });

  it("rejects declared paths escaping the runtime", async () => {
    const directory = await runtime();
    await writeFile(
      join(directory, "package.json"),
      JSON.stringify({
        name: "omnyo-plugin-omnyo--fixture",
        version: "2.0.0",
        omnyo: {
          name: "Fixture",
          description: "Fixture",
          branding: { icon: "Zap" },
          server: "./dist/server.js",
          skills: ["../outside"],
        },
      }),
    );
    await expect(readBundledPluginCandidate(args(directory))).rejects.toThrow(
      "Unsafe runtime file path",
    );
  });
});
