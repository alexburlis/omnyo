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
import { pathToFileURL } from "node:url";
import { afterEach, expect, it } from "vitest";
import { PLUGIN_SDK_VERSION } from "@omnyo/domain";
import {
  installPrivateSdkArtifact,
  readPrivateSdkArtifact,
  resolvePrivateSdkArtifact,
} from "../src/private-sdk-artifact.js";

const roots: string[] = [];

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "omnyo-private-sdk-"));
  roots.push(root);
  const directory = join(root, "dist", "plugin-sdk");
  await mkdir(directory, { recursive: true });
  const bytes = Buffer.from("synthetic-sdk-artifact-for-boundary-check");
  const sha256 = createHash("sha256").update(bytes).digest("hex");

  const manifest = {
    schema: 1,
    packageName: "@omnyo/plugin-sdk",
    version: PLUGIN_SDK_VERSION,
    file: `omnyo-plugin-sdk-${PLUGIN_SDK_VERSION}-${sha256.slice(0, 12)}.tgz`,
    sha256,
  };

  await writeFile(
    join(root, "package.json"),
    JSON.stringify({ name: "omnyo-app", private: true }),
  );
  await writeFile(join(directory, "manifest.json"), JSON.stringify(manifest));
  await writeFile(join(directory, manifest.file), bytes);

  return { root, directory, manifest, bytes };
}

afterEach(async () => {
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});

it("resolves the selected runtime artifact and copies identical bytes idempotently into plugin vendor", async () => {
  const f = await fixture();

  const artifact = await resolvePrivateSdkArtifact({
    cliDirectory: join(f.root, "host-daemon", "dist"),
    sourceUrl: pathToFileURL(join(f.root, "host-daemon", "dist", "omnyo")).href,
  });

  const target = join(f.root, "plugin");
  const first = await installPrivateSdkArtifact(target, artifact);
  expect(await installPrivateSdkArtifact(target, artifact)).toBe(first);
  expect(first).toBe(`file:./vendor/${f.manifest.file}`);
  expect(await readFile(join(target, "vendor", f.manifest.file))).toEqual(
    f.bytes,
  );
});

it("refuses corruption and a destination collision without overwriting either payload", async () => {
  const f = await fixture();
  const artifact = await readPrivateSdkArtifact(f.directory);
  const target = join(f.root, "plugin");
  await mkdir(join(target, "vendor"), { recursive: true });
  const destination = join(target, "vendor", f.manifest.file);
  await writeFile(destination, "user-owned-collision");
  await expect(installPrivateSdkArtifact(target, artifact)).rejects.toThrow(
    /digest/,
  );
  expect(await readFile(destination, "utf8")).toBe("user-owned-collision");
  await writeFile(artifact.artifactPath, "corrupt-source");
  await expect(readPrivateSdkArtifact(f.directory)).rejects.toThrow(/digest/);
});

it("refuses artifact symlinks and unsafe filenames in runtime manifests", async () => {
  const f = await fixture();
  const path = join(f.directory, f.manifest.file);
  const other = join(f.root, "other.tgz");
  await writeFile(other, f.bytes);
  await rm(path);
  await symlink(other, path);
  await expect(readPrivateSdkArtifact(f.directory)).rejects.toThrow(
    /regular file/,
  );
  await writeFile(
    join(f.directory, "manifest.json"),
    JSON.stringify({ ...f.manifest, file: "../other.tgz" }),
  );
  await expect(readPrivateSdkArtifact(f.directory)).rejects.toThrow(/identity/);
});

it("fails at a selected runtime with no artifact rather than searching another source owner", async () => {
  const f = await fixture();
  await rm(join(f.directory, "manifest.json"));
  await expect(
    resolvePrivateSdkArtifact({
      cliDirectory: join(f.root, "host-daemon", "dist"),
      sourceUrl: import.meta.url,
    }),
  ).rejects.toMatchObject({ code: "ENOENT" });
});
