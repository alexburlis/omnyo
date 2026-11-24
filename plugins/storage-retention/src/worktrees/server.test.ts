import { createFakePluginHost } from "@omnyo/plugin-sdk/testing";
import { expect, it } from "vitest";
import plugin from "../server.js";

it("imports the standalone worktree history once without approving cleanup", async () => {
  const { api, harness } = createFakePluginHost({
    pluginId: "omnyo--storage-retention",
    experimental_hostEntry: true,
  });

  plugin(api);

  const item = {
    projectId: "proj_fixture",
    projectName: "Fixture",
    repo: "/fixture/repo",
    kind: "branch",
    target: "merged",
    head: "ab".repeat(20),
    base: "main",
    estimatedBytes: null,
  };

  const previous = {
    snapshot: {
      id: "imported-scan",
      scannedAt: "2026-11-23T12:00:00Z",
      durationMs: 150,
      entries: [],
      issues: [],
      items: [item],
    },
    lastError: "Previous scan error",
    lastCleanup: {
      finishedAt: "2026-11-23T12:01:00Z",
      removed: [{ ...item, freedBytes: null }],
      skipped: [],
    },
  };

  try {
    await expect(
      harness.behavior.callRpc("importWorktreeHistory", previous),
    ).resolves.toEqual({ snapshot: true, receipt: true });
    await expect(
      harness.behavior.callRpc("savedScan", null),
    ).resolves.toMatchObject({
      ...previous,
      snapshot: { ...previous.snapshot, items: [] },
    });
    await expect(
      harness.behavior.callRpc("cleanSaved", {
        snapshotId: previous.snapshot.id,
      }),
    ).rejects.toThrow("No safe items remain");
    await expect(
      harness.behavior.callRpc("importWorktreeHistory", {
        ...previous,
        lastCleanup: {
          ...previous.lastCleanup,
          finishedAt: "2025-01-01T00:00:00Z",
        },
      }),
    ).resolves.toEqual({ snapshot: false, receipt: false });
    expect(
      api.storage.database().prepare("SELECT imported FROM saved_scan").get(),
    ).toEqual({
      imported: 1,
    });
  } finally {
    await harness.lifecycle.dispose();
  }
});
