import { describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import {
  managedMountInspection,
  parseManagedDarwinMountTable,
  parseManagedMountInfo,
} from "./managed-mount-inspection.js";
import { MANAGED_HOLDING_MS } from "./managed-contract.js";
import { managedFixture } from "./managed-test-fixture.js";

function mountPath(value: string) {
  return value
    .replace(/\\/g, "\\134")
    .replace(/ /g, "\\040")
    .replace(/\t/g, "\\011")
    .replace(/\n/g, "\\012");
}

function table(mountPoint: string | null) {
  return (
    "22 1 8:1 / / rw,relatime - ext4 /dev/root rw\n" +
    (mountPoint === null
      ? ""
      : `23 22 8:1 /external\\040source ${mountPath(mountPoint)} rw,relatime shared:4 - ext4 /dev/root rw\n`)
  );
}

describe("managed mount admission", () => {
  it("parses same-device Linux bind records and kernel escaped paths", () => {
    const point = "/owned/a b\tline\nback\\slash";
    expect(parseManagedMountInfo(table(point))).toEqual(["/", point]);

    for (const malformed of [
      "",
      table(null).trimEnd(),
      "23 22 8:1 / /owned rw - ext4 /dev/root\n",
      table(null) + "22 1 8:1 / /other rw - ext4 /dev/root rw\n",
      "22 1 8:1 / /bad\\777path rw - ext4 /dev/root rw\n",
    ]) {
      expect(() => parseManagedMountInfo(malformed)).toThrow();
    }

    expect(() =>
      parseManagedMountInfo("x".repeat(1024 * 1024 + 1) + "\n"),
    ).toThrow();
  });
  it("parses normal Darwin paths but holds ambiguous or unverifiable encoding", () => {
    expect(
      parseManagedDarwinMountTable(
        "/dev/disk3 on / (apfs, local, read-only)\nmap auto_home on /System/Volumes/Data/home (autofs, automounted)\nvolume on /Volumes/With Space (apfs, local)\n",
      ),
    ).toEqual(["/", "/System/Volumes/Data/home", "/Volumes/With Space"]);

    for (const malformed of [
      "volume on /owned on /other (apfs)\n",
      "volume on /owned\\040path (apfs)\n",
      "volume on /owned (ambiguous (apfs))\n",
      "volume on /owned (apfs)",
    ]) {
      expect(() => parseManagedDarwinMountTable(malformed)).toThrow();
    }
  });
  it("captures the current native mount table without claiming an actual injected mount", async () => {
    const snapshot = await managedMountInspection.inspect();
    expect(snapshot.kind).toBe(
      process.platform === "darwin" || process.platform === "linux"
        ? "known"
        : "unsupported",
    );

    if (snapshot.kind === "known")
      expect(snapshot.mountPoints.length).toBeGreaterThan(0);
  });
  it("holds a same-device mounted-directory canary before traversal", async () => {
    let mountPoint: string | null = null;

    const fixture = await managedFixture({
      mountInspection: {
        recheck: "per-unlink",
        inspect: async () => ({
          kind: "known",
          mountPoints: parseManagedMountInfo(table(mountPoint)),
        }),
      },
    });

    try {
      const allocation = await fixture.allocate();
      mountPoint = path.join(allocation.path, "mounted folder");
      await fs.mkdir(mountPoint);
      await fs.writeFile(
        path.join(mountPoint, "canary"),
        "simulated mounted bytes",
      );
      expect((await fs.stat(mountPoint)).dev).toBe(
        (await fs.stat(allocation.path)).dev,
      );
      const held = await fixture.host.managedInspect({ id: allocation.id });
      expect(held.snapshot).toBeNull();
      expect(held.hold?.code).toBe("mount-boundary");
      expect(await fs.readFile(path.join(mountPoint, "canary"), "utf8")).toBe(
        "simulated mounted bytes",
      );
    } finally {
      await fixture.cleanup();
    }
  });
  it("rechecks snapshot mount admission after intent before rename", async () => {
    let mountPoint: string | null = null;
    let latePoint: string | null = null;

    const fixture = await managedFixture({
      mountInspection: {
        recheck: "transition",
        inspect: async () => ({
          kind: "known",
          mountPoints: mountPoint === null ? ["/"] : ["/", mountPoint],
        }),
      },
      fault: async (stage) => {
        if (stage === "after-intent") mountPoint = latePoint;
      },
    });

    try {
      const allocation = await fixture.allocate();
      latePoint = path.join(allocation.path, "mounted");
      await fs.mkdir(latePoint);
      await fs.writeFile(path.join(latePoint, "canary"), "late mounted bytes");
      const approved = await fixture.approve(allocation);
      const held = await fixture.transition(approved, "quarantine");
      expect(held.phase).toBe("quarantine-intent");
      expect(held.hold?.code).toBe("mount-boundary");
      expect(await fs.readFile(path.join(latePoint, "canary"), "utf8")).toBe(
        "late mounted bytes",
      );
      await expect(
        fs.lstat(path.join(path.dirname(allocation.path), "quarantine")),
      ).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await fixture.cleanup();
    }
  });
  it("rechecks Linux mountinfo before each unlink and conserves the newly mounted canary", async () => {
    let mountPoint: string | null = null;
    let quarantinedPath: string | null = null;
    let beforeUnlinks = 0;

    const fixture = await managedFixture({
      mountInspection: {
        recheck: "per-unlink",
        inspect: async () => ({
          kind: "known",
          mountPoints: parseManagedMountInfo(table(mountPoint)),
        }),
      },
      fault: async (stage) => {
        if (
          stage === "before-unlink" &&
          ++beforeUnlinks === 2 &&
          quarantinedPath !== null
        )
          mountPoint = path.join(quarantinedPath, "mounted");
      },
    });

    try {
      const allocation = await fixture.allocate();
      const outside = path.join(fixture.root, "external-canary");
      await fs.writeFile(outside, "external mounted contents");
      await fs.mkdir(path.join(allocation.path, "mounted"));
      await fs.link(outside, path.join(allocation.path, "mounted", "canary"));
      await fs.mkdir(path.join(allocation.path, "z-owned"));
      await fs.writeFile(
        path.join(allocation.path, "z-owned", "work"),
        "owned removable file",
      );

      const quarantined = await fixture.transition(
        await fixture.approve(allocation),
        "quarantine",
      );

      quarantinedPath = quarantined.path;
      fixture.advance(MANAGED_HOLDING_MS + 1);
      const held = await fixture.transition(quarantined, "purge");
      expect(held.phase).toBe("purge-intent");
      expect(held.hold?.code).toBe("mount-boundary");
      expect(held.removedLogicalBytes).toBe(0);
      expect(beforeUnlinks).toBe(2);
      expect(
        await fs.readFile(
          path.join(quarantined.path, "mounted", "canary"),
          "utf8",
        ),
      ).toBe("external mounted contents");
      expect(await fs.readFile(outside, "utf8")).toBe(
        "external mounted contents",
      );
      await expect(
        fs.lstat(path.join(quarantined.path, "z-owned", "work")),
      ).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await fixture.cleanup();
    }
  });
  it("holds incomplete mount inspection rather than interpreting an unavailable table as no mounts", async () => {
    const fixture = await managedFixture({
      mountInspection: {
        recheck: "per-unlink",
        inspect: async () => {
          throw new Error("Incomplete proc metadata");
        },
      },
    });

    try {
      const allocation = await fixture.allocate();
      await fs.writeFile(path.join(allocation.path, "canary"), "held bytes");
      const held = await fixture.host.managedInspect({ id: allocation.id });
      expect(held.hold?.code).toBe("mount-inspection-unknown");
      expect(held.snapshot).toBeNull();
      expect(
        await fs.readFile(path.join(allocation.path, "canary"), "utf8"),
      ).toBe("held bytes");
    } finally {
      await fixture.cleanup();
    }
  });
});
