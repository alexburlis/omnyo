import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { writeAppRuntimeFile } from "@omnyo/config/app-runtime-file";
import { writeServerMovedFile } from "@omnyo/server-archive";
import { installMachineService } from "../commands/server-machine-service.js";

afterEach(() => vi.unstubAllEnvs());

describe("machine service installation admission", () => {
  it("requires a verified private installer before confirmation or stopping the runtime", async ({
    skip,
  }) => {
    skip(process.platform === "win32", "machine service is POSIX-only");
    const root = await mkdtemp(join(tmpdir(), "omnyo-machine-refusal-"));

    const child = spawn(
      process.execPath,
      ["-e", "setInterval(() => {}, 1000)"],
      { stdio: "ignore" },
    );

    try {
      await once(child, "spawn");

      if (child.pid === undefined)
        throw new Error("Fixture runtime has no process identity");
      const entryPath = join(root, "omnyo-app.js");
      await writeFile(entryPath, "owned synthetic runtime");
      await writeFile(
        join(root, "auth.json"),
        JSON.stringify({ hostId: "host-fixture", hostKey: "synthetic" }),
      );
      await writeFile(
        join(root, "config.json"),
        JSON.stringify({ serverUrl: "http://127.0.0.1:9" }),
      );
      await writeServerMovedFile(root, {
        version: 1,
        moveId: "move-fixture",
        movedAt: 1700000000000,
        fromHostId: "host-fixture",
        toHostId: "host-target",
        toHostName: "fixture",
        serverUrl: "http://127.0.0.1:9",
        mode: "direct",
        connectHandle: null,
        oldCopyEntries: ["app.db"],
      });
      await writeAppRuntimeFile({
        dataDir: root,
        entryPath,
        pid: child.pid,
        serverUrl: "http://127.0.0.1:9",
        startedAt: new Date().toISOString(),
        surface: "fixture",
        version: "0.46.242+private.1",
      });
      vi.stubEnv("OMNYO_MACHINE_INSTALLER", join(root, "missing-installer"));

      const before = await Promise.all(
        (await readdir(root)).sort().map(async (name) => ({
          name,
          bytes: await readFile(join(root, name)),
        })),
      );

      const confirm = vi.fn(async () => true);
      const report = vi.fn();

      await expect(
        installMachineService({
          dataDir: root,
          confirm,
          report,
          installerOutput: "stderr",
        }),
      ).rejects.toThrow(
        "This Omnyo installation doesn't include the machine installer. Install the verified private runtime, then run omnyo server install-machine-service.",
      );

      expect(confirm).not.toHaveBeenCalled();
      expect(report).not.toHaveBeenCalled();
      expect(child.exitCode).toBeNull();
      expect(child.signalCode).toBeNull();

      const after = await Promise.all(
        (await readdir(root)).sort().map(async (name) => ({
          name,
          bytes: await readFile(join(root, name)),
        })),
      );

      expect(after).toEqual(before);
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        const exited = once(child, "exit");
        child.kill("SIGTERM");
        await exited;
      }

      await rm(root, { recursive: true, force: true });
    }
  });
});
