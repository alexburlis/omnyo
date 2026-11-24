import { describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { inspectManagedProcesses } from "./managed-process-inspection.js";
import { parseDirectoryLsof as parseManagedLsof } from "@omnyo/process-utils";
import { managedFixture } from "./managed-test-fixture.js";

describe("managed process and bounded filesystem inspection", () => {
  it("rejects malformed, empty and truncated native tables", () => {
    const directory = "/owned/allocation";
    expect(
      parseManagedLsof(
        Buffer.from("p42\0\nf3\0n/owned/allocation/work\0\n"),
        directory,
      ).kind,
    ).toBe("busy");
    expect(
      parseManagedLsof(Buffer.from("p42\0\nf3\0n/outside/work\0\n"), directory)
        .kind,
    ).toBe("idle");

    for (const output of [
      "",
      "p42\0\nf3\0n/outside/work",
      "n/outside/work\0\n",
      "p42\0\nf3\0x/outside/work\0\n",
    ]) {
      expect(parseManagedLsof(Buffer.from(output), directory).kind).toBe(
        "unknown",
      );
    }

    expect(
      parseManagedLsof(Buffer.alloc(8 * 1024 * 1024 + 1), directory).kind,
    ).toBe("unknown");
  });
  it("observes a real owned open file and preserves it while busy", async () => {
    const fixture = await managedFixture({
      inspectProcesses: inspectManagedProcesses,
    });

    let child: ReturnType<typeof spawn> | null = null;

    try {
      const allocation = await fixture.allocate();
      const file = path.join(allocation.path, "work");
      await fs.writeFile(file, "busy bytes");
      const approved = await fixture.approve(allocation);
      child = spawn(
        process.execPath,
        [
          "-e",
          "const fs=require('node:fs');fs.openSync(process.argv[1],'r');process.stdout.write('ready');setInterval(()=>{},1000)",
          file,
        ],
        { stdio: ["ignore", "pipe", "pipe"] },
      );
      await once(child.stdout!, "data");
      const observed = await inspectManagedProcesses(allocation.path);

      if (process.platform === "darwin" || process.platform === "linux")
        expect(observed.kind).toBe("busy");
      else expect(observed.kind).toBe("unknown");
      const held = await fixture.transition(approved, "quarantine");
      expect(held.hold?.code).toBe(
        process.platform === "darwin" || process.platform === "linux"
          ? "process-busy"
          : "process-inspection-unknown",
      );
      expect(await fs.readFile(file, "utf8")).toBe("busy bytes");
      const closed = once(child, "close");
      child.kill();
      await closed;
      child = null;
      const after = await inspectManagedProcesses(allocation.path);
      expect(after.kind).toBe(
        process.platform === "darwin" || process.platform === "linux"
          ? "idle"
          : "unknown",
      );
    } finally {
      if (child) {
        const closed = once(child, "close");
        child.kill();
        await closed;
      }

      await fixture.cleanup();
    }
  }, 10000);
  it("retains unknown inspector results and over-bound trees", async () => {
    const fixture = await managedFixture({
      maxEntries: 2,
      inspectProcesses: async () => ({
        kind: "unknown",
        message: "Native warnings prevent a complete result.",
      }),
    });

    try {
      const allocation = await fixture.allocate();
      const approved = await fixture.approve(allocation);
      const held = await fixture.transition(approved, "quarantine");
      expect(held.hold?.code).toBe("process-inspection-unknown");
      await fs.writeFile(path.join(allocation.path, "a"), "first");
      await fs.writeFile(path.join(allocation.path, "b"), "second");
      const bounded = await fixture.host.managedInspect({ id: allocation.id });
      expect(bounded.hold?.code).toBe("inspection-bound");
      expect(await fs.readFile(path.join(allocation.path, "a"), "utf8")).toBe(
        "first",
      );
      expect(await fs.readFile(path.join(allocation.path, "b"), "utf8")).toBe(
        "second",
      );
    } finally {
      await fixture.cleanup();
    }
  });
});
