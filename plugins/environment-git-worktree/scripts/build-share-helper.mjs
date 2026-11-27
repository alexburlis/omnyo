import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";

const root = fileURLToPath(new URL("../", import.meta.url));

const identity = process.argv[2];

if (process.platform !== "darwin" || !identity) {
  throw new Error(
    "Run on macOS with the signing identity as the first argument.",
  );
}

const dir = await mkdtemp(join(tmpdir(), "omnyo-worktree-share-"));

try {
  const binary = join(dir, "worktree-share");
  execFileSync(
    "xcrun",
    [
      "clang",
      "-arch",
      "arm64",
      "-arch",
      "x86_64",
      "-mmacosx-version-min=15.0",
      "-std=c11",
      "-O2",
      "-Wall",
      "-Wextra",
      "-Werror",
      "-o",
      binary,
      join(root, "native/worktree-share.c"),
    ],
    { stdio: "inherit" },
  );
  execFileSync(
    "/usr/bin/codesign",
    [
      "--force",
      "--sign",
      identity,
      "--options",
      "runtime",
      "--identifier",
      "com.omnyohq.worktree-share",
      binary,
    ],
    { stdio: "inherit" },
  );
  execFileSync("/usr/bin/codesign", [
    "--verify",
    "--strict",
    "--all-architectures",
    binary,
  ]);
  const bytes = await readFile(binary);
  const source = await readFile(join(root, "native/worktree-share.c"));

  const payload = {
    sourceSha256: createHash("sha256").update(source).digest("hex"),
    sha256: createHash("sha256").update(bytes).digest("hex"),
    gzipBase64: gzipSync(bytes, { level: 9 }).toString("base64"),
  };

  await writeFile(
    join(root, "host/share-helper-payload.json"),
    JSON.stringify(payload, null, 2) + "\n",
  );
} finally {
  await rm(dir, { recursive: true, force: true });
}
