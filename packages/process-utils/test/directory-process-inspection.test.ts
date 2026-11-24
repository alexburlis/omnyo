import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { inspectDirectoryProcesses } from "../src/directory-process-inspection.js";

const directories: string[] = [];

const children: ChildProcess[] = [];

afterEach(async () => {
  for (const child of children.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) {
      const closed = once(child, "close");
      child.kill();
      await closed;
    }
  }

  await Promise.all(
    directories
      .splice(0)
      .map((directory) => fs.rm(directory, { recursive: true, force: true })),
  );
});

async function fixture() {
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), "omnyo-process-inspection-"),
  );

  directories.push(directory);
  await fs.mkdir(path.join(directory, "nested"));
  await fs.writeFile(path.join(directory, "nested", "file"), "kept");

  return directory;
}

describe.skipIf(process.platform !== "win32")(
  "Windows allocation inspection",
  () => {
    it("allows an idle tree and holds a live descendant file and working directory", async () => {
      const directory = await fixture();
      expect(await inspectDirectoryProcesses(directory)).toEqual({
        kind: "idle",
      });
      const file = await fs.open(path.join(directory, "nested", "file"), "r");

      try {
        expect(await inspectDirectoryProcesses(directory)).toMatchObject({
          kind: "busy",
        });
      } finally {
        await file.close();
      }

      const child = spawn(
        process.execPath,
        ["-e", "setInterval(() => {}, 1000)"],
        {
          cwd: path.join(directory, "nested"),
          stdio: "ignore",
        },
      );

      children.push(child);
      await once(child, "spawn");
      expect(await inspectDirectoryProcesses(directory)).toMatchObject({
        kind: "busy",
      });
      const closed = once(child, "close");
      child.kill();
      await closed;
      expect(await inspectDirectoryProcesses(directory)).toEqual({
        kind: "idle",
      });
    });

    it("holds missing paths, reparse points and cancelled inspections", async () => {
      const directory = await fixture();
      expect(
        await inspectDirectoryProcesses(path.join(directory, "missing")),
      ).toMatchObject({ kind: "unknown" });
      expect(
        await inspectDirectoryProcesses(directory, AbortSignal.abort()),
      ).toMatchObject({ kind: "unknown" });
      await fs.symlink(
        path.join(directory, "nested"),
        path.join(directory, "junction"),
        "junction",
      );
      expect(await inspectDirectoryProcesses(directory)).toMatchObject({
        kind: "unknown",
      });
    });
  },
);
