import { access } from "node:fs/promises";
import { resolve } from "node:path";
import { pruneUnreferencedChunks } from "../../../scripts/build-utils.mjs";

const packageRoot = process.cwd();

const distDir = resolve(packageRoot, "host-daemon", "dist");

const entry = resolve(distDir, "omnyo");

const chunkDir = resolve(distDir, "omnyo-chunks");

for (const [label, pathToCheck] of [
  ["bundled Omnyo CLI", entry],
  ["bundled Omnyo CLI chunks", chunkDir],
]) {
  try {
    await access(pathToCheck);
  } catch {
    throw new Error(
      `Missing ${label} at ${pathToCheck}: run from the runtime package after building it.`,
    );
  }
}

const removed = await pruneUnreferencedChunks({ chunkDir, entry });

if (removed.length > 0) {
  process.stderr.write(
    `omnyo-app: pruned ${removed.length} stale Omnyo CLI chunk file(s)\n`,
  );
}
