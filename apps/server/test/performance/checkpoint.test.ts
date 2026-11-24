import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { writeCheckpoint } from "./checkpoint.js";

it("preserves the last complete checkpoint when staging the next one fails", async () => {
  const root = await mkdtemp(join(tmpdir(), "omnyo-performance-checkpoint-"));
  const path = join(root, "progress.json");

  try {
    await writeCheckpoint(path, '{"completed":3}');
    await mkdir(path + ".pending");
    await expect(writeCheckpoint(path, '{"completed":4}')).rejects.toThrow();
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual({ completed: 3 });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it("replaces a checkpoint with the next complete payload", async () => {
  const root = await mkdtemp(join(tmpdir(), "omnyo-performance-checkpoint-"));
  const path = join(root, "progress.json");

  try {
    await writeCheckpoint(path, '{"completed":3}');
    await writeCheckpoint(path, '{"completed":4}');
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual({ completed: 4 });
    await expect(readFile(path + ".pending", "utf8")).rejects.toThrow();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
