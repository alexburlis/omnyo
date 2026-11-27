import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { experimental_createHostEntryHarness } from "@omnyo/plugin-sdk/testing/host";
import entry from "../host";

it("creates and restores an isolated coordinator directory, preserves unexpected content and removes only an empty workspace", async () => {
  const root = await mkdtemp(join(tmpdir(), "sentry-coordinator-test-"));

  const harness = experimental_createHostEntryHarness(entry, {
    experimental_paths: { dataDir: root, tempDir: root },
  });

  try {
    const input = { pathKey: "thread-1", action: "ensure" as const };
    const created = await harness.experimental_call("coordinatorWorkspace", input);
    expect(created.path).toBe(join(root, "coordinators", "thread-1"));
    await access(created.path);
    expect(await harness.experimental_call("coordinatorWorkspace", input)).toEqual(created);
    await expect(
      harness.experimental_call("coordinatorWorkspace", { ...input, pathKey: "../foreign" }),
    ).rejects.toThrow();
    const sentinel = join(created.path, "unique.txt");
    await writeFile(sentinel, "preserve");
    await expect(
      harness.experimental_call("coordinatorWorkspace", { ...input, action: "remove" }),
    ).rejects.toThrow();
    expect(await readFile(sentinel, "utf8")).toBe("preserve");
    await rm(sentinel);
    await harness.experimental_call("coordinatorWorkspace", { ...input, action: "remove" });
    await expect(access(created.path)).rejects.toThrow();
    await harness.experimental_call("coordinatorWorkspace", { ...input, action: "remove" });
  } finally {
    await harness.experimental_dispose();
    await rm(root, { recursive: true, force: true });
  }
});
