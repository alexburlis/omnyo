import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createManagedHost } from "./managed-host.js";
import {
  managedExact,
  managedFixture,
  TEST_OWNER,
} from "./managed-test-fixture.js";

const VOLUME = "135c0e5f-21c1-455f-a136-e7a6a7d73654";

async function rewriteIdentities(dataDir: string, legacy: boolean) {
  const state = path.join(dataDir, "managed-cleanup");

  const paths = [
    path.join(state, "installation.json"),
    ...(await fs.readdir(path.join(state, "allocations"))).map((name) =>
      path.join(state, "allocations", name),
    ),
  ];

  for (const file of paths) {
    const value = JSON.parse(await fs.readFile(file, "utf8"));

    const encoded = JSON.stringify(value, (key, item) =>
      key === "dev"
        ? "old-device"
        : legacy && key === "volumeId"
          ? undefined
          : item,
    );

    await fs.writeFile(file, encoded);
  }
}

async function removeVolumeIdentities(dataDir: string) {
  const state = path.join(dataDir, "managed-cleanup");

  const paths = [
    path.join(state, "installation.json"),
    ...(await fs.readdir(path.join(state, "allocations"))).map((name) =>
      path.join(state, "allocations", name),
    ),
  ];

  for (const file of paths) {
    const value = JSON.parse(await fs.readFile(file, "utf8"));
    await fs.writeFile(
      file,
      JSON.stringify(value, (key, item) =>
        key === "volumeId" ? undefined : item,
      ),
    );
  }
}

describe("managed namespace identity", () => {
  it("keeps unchanged legacy device and inode identities compatible", async () => {
    const fixture = await managedFixture({
      volumeIdentity: async () => VOLUME,
    });

    try {
      const allocation = await fixture.allocate();
      await removeVolumeIdentities(fixture.options.dataDir);
      const legacy = createManagedHost(fixture.options);
      expect(
        (await legacy.managedInspect({ id: allocation.id })).hold,
      ).toBeNull();
    } finally {
      await fixture.cleanup();
    }
  });

  it("reads each volume once per operation and refreshes its identity next time", async () => {
    let reads = 0;
    let volume = VOLUME;

    const fixture = await managedFixture({
      volumeIdentity: async () => {
        reads++;

        return volume;
      },
    });

    try {
      const allocation = await fixture.allocate();
      expect(reads).toBe(1);
      await fixture.host.managedInspect({ id: allocation.id });
      expect(reads).toBe(2);
      volume = "another-volume";
      expect(
        (await fixture.host.managedInspect({ id: allocation.id })).hold?.code,
      ).toBe("path-identity");
      expect(reads).toBe(3);
    } finally {
      await fixture.cleanup();
    }
  });

  it("uses a verified volume identity across device renumbering but refuses another volume", async () => {
    const fixture = await managedFixture({
      volumeIdentity: async () => VOLUME,
    });

    try {
      const allocation = await fixture.allocate();
      await fs.writeFile(path.join(allocation.path, "proof"), "keep me");
      await rewriteIdentities(fixture.options.dataDir, false);
      const restored = createManagedHost(fixture.options);
      const inspected = await restored.managedInspect({ id: allocation.id });
      expect(inspected.hold).toBeNull();

      const wrongVolume = createManagedHost({
        ...fixture.options,
        volumeIdentity: async () => "different-volume",
      });

      expect(
        (await wrongVolume.managedInspect({ id: allocation.id })).hold?.code,
      ).toBe("path-identity");

      const unavailableVolume = createManagedHost({
        ...fixture.options,
        volumeIdentity: async () => null,
      });

      expect(
        (await unavailableVolume.managedInspect({ id: allocation.id })).hold
          ?.code,
      ).toBe("path-identity");
      expect(
        await fs.readFile(path.join(allocation.path, "proof"), "utf8"),
      ).toBe("keep me");
    } finally {
      await fixture.cleanup();
    }
  });

  it("requires an exact explicit reanchor for legacy identities and revokes captured authority", async () => {
    const fixture = await managedFixture({
      volumeIdentity: async () => VOLUME,
    });

    try {
      const allocation = await fixture.allocate();
      await fs.writeFile(path.join(allocation.path, "proof"), "keep me");
      await fixture.host.managedOwnerDecision({
        ...managedExact(allocation),
        actorThreadId: TEST_OWNER,
        decision: { action: "keep", reason: "Preserve proof" },
      });
      await rewriteIdentities(fixture.options.dataDir, true);
      const restored = createManagedHost(fixture.options);
      expect(
        (await restored.managedInspect({ id: allocation.id })).hold?.code,
      ).toBe("path-identity");
      const preview = await restored.managedReanchor({ previewDigest: null });
      await expect(
        restored.managedReanchor({ previewDigest: "a".repeat(64) }),
      ).rejects.toThrow("Preview reanchoring again");
      await restored.managedReanchor({ previewDigest: preview.digest });
      const repaired = await restored.managedInspect({ id: allocation.id });
      expect(repaired.hold).toBeNull();
      expect(repaired.phase).toBe("kept");
      expect(repaired.grant).toBeNull();
      expect(repaired.closeout).toBeNull();
      expect(
        await fs.readFile(path.join(allocation.path, "proof"), "utf8"),
      ).toBe("keep me");
    } finally {
      await fixture.cleanup();
    }
  });

  it("refuses active consumers and changed preview payloads without changing files", async () => {
    const fixture = await managedFixture({
      volumeIdentity: async () => VOLUME,
    });

    try {
      const allocation = await fixture.allocate();

      const preview = await fixture.host.managedReanchor({
        previewDigest: null,
      });

      await fs.writeFile(path.join(allocation.path, "proof"), "new bytes");
      await expect(
        fixture.host.managedReanchor({ previewDigest: preview.digest }),
      ).rejects.toThrow("Preview reanchoring again");
      await fixture.host.managedOwnerDecision({
        ...managedExact(allocation),
        actorThreadId: TEST_OWNER,
        decision: {
          action: "consumer-register",
          consumerThreadId: "thr_consumer",
        },
      });
      await expect(
        fixture.host.managedReanchor({ previewDigest: null }),
      ).rejects.toThrow("consumer");
      expect(
        await fs.readFile(path.join(allocation.path, "proof"), "utf8"),
      ).toBe("new bytes");
    } finally {
      await fixture.cleanup();
    }
  });

  it("refuses active processes and approved cleanup states", async () => {
    let busy = false;

    const fixture = await managedFixture({
      volumeIdentity: async () => VOLUME,
      inspectProcesses: async () =>
        busy
          ? { kind: "unknown", message: "Process identity is unavailable" }
          : { kind: "idle" },
    });

    try {
      const allocation = await fixture.allocate();
      busy = true;
      await expect(
        fixture.host.managedReanchor({ previewDigest: null }),
      ).rejects.toThrow("Process identity is unavailable");
      busy = false;
      await fixture.approve(allocation);
      await expect(
        fixture.host.managedReanchor({ previewDigest: null }),
      ).rejects.toThrow("active cleanup states");
    } finally {
      await fixture.cleanup();
    }
  });
});
