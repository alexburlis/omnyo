import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, expect, it, vi } from "vitest";
import { experimental_createHostEntryHarness } from "@omnyo/plugin-sdk/testing/host";
import hostEntry from "./host.js";

const run = promisify(execFile);

const directories: string[] = [];

afterEach(async () => {
  for (const directory of directories.splice(0)) {
    await run("chmod", ["-R", "u+rwx", directory]);
    await fs.rm(directory, { recursive: true, force: true });
  }
});

async function temporaryDirectory() {
  const directory = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), "omnyo-storage-trash-")),
  );

  directories.push(directory);

  return directory;
}

async function modeOf(target: string) {
  return (await fs.lstat(target)).mode & 0o777;
}

function silenceErrors() {
  return vi.spyOn(console, "error").mockImplementation(() => {});
}

it.skipIf(process.platform === "win32")(
  "removes discarded storage whose directories lack owner write, search or read permission and leaves neighbors alone",
  async () => {
    const root = await temporaryDirectory();
    const thread = path.join(root, "thr_readonly");
    const neighbor = path.join(root, "thr_neighbor");
    const rootMode = await modeOf(root);

    await fs.mkdir(path.join(thread, "cache", "deep"), { recursive: true });
    await fs.mkdir(path.join(thread, "locked"));
    await fs.mkdir(path.join(thread, "node_modules", "package"), {
      recursive: true,
    });
    await fs.mkdir(path.join(neighbor, "kept"), { recursive: true });
    await fs.writeFile(path.join(thread, "browser-worker.mjs"), "worker");
    await fs.writeFile(path.join(thread, "cache", "deep", "entry"), "cached");
    await fs.writeFile(path.join(thread, "locked", "entry"), "locked");

    for (let index = 0; index < 50; index++)
      await fs.writeFile(
        path.join(thread, "node_modules", "package", `module-${index}.js`),
        "module",
      );

    await fs.writeFile(path.join(neighbor, "kept", "data"), "keep");
    await fs.chmod(path.join(thread, "cache", "deep"), 0o555);
    await fs.chmod(path.join(thread, "cache"), 0o500);
    await fs.chmod(path.join(thread, "locked"), 0o000);
    await fs.chmod(thread, 0o555);
    await fs.chmod(path.join(neighbor, "kept"), 0o500);
    const errors = silenceErrors();
    const worker = experimental_createHostEntryHarness(hostEntry);

    try {
      expect(
        await worker.experimental_call("discard", {
          rootPath: root,
          names: ["thr_readonly"],
          recreate: false,
        }),
      ).toEqual({ removed: ["thr_readonly"] });
      await expect
        .poll(() => worker.experimental_getRetainedWorkerLeaseCount(), {
          timeout: 10_000,
        })
        .toBe(0);
      expect(await fs.readdir(root)).toEqual(["thr_neighbor"]);
      expect(await modeOf(root)).toBe(rootMode);
      expect(await modeOf(path.join(neighbor, "kept"))).toBe(0o500);
      expect(
        await fs.readFile(path.join(neighbor, "kept", "data"), "utf8"),
      ).toBe("keep");
      expect(errors).not.toHaveBeenCalled();
    } finally {
      errors.mockRestore();
      await worker.experimental_dispose();
    }
  },
);

it.skipIf(process.platform === "win32")(
  "repairs permissions inside the trash without following symbolic links out of it",
  async () => {
    const root = await temporaryDirectory();
    const outside = await temporaryDirectory();
    const target = path.join(outside, "target");
    const thread = path.join(root, "thr_links");

    await fs.mkdir(target);
    await fs.writeFile(path.join(target, "keep"), "keep");
    await fs.mkdir(path.join(thread, "readonly"), { recursive: true });
    await fs.symlink(target, path.join(thread, "readonly", "directory-link"));
    await fs.symlink(target, path.join(thread, "directory-link"));
    await fs.symlink(
      target,
      path.join(root, `.omnyo-trash-thr_linked-${randomUUID()}`),
    );
    await fs.chmod(target, 0o500);
    await fs.chmod(path.join(thread, "readonly"), 0o500);
    await fs.chmod(thread, 0o555);
    const errors = silenceErrors();
    const worker = experimental_createHostEntryHarness(hostEntry);

    try {
      expect(
        await worker.experimental_call("discard", {
          rootPath: root,
          names: ["thr_links"],
          recreate: false,
        }),
      ).toEqual({ removed: ["thr_links"] });
      await expect
        .poll(() => worker.experimental_getRetainedWorkerLeaseCount(), {
          timeout: 10_000,
        })
        .toBe(0);
      expect(await fs.readdir(root)).toEqual([]);
      expect(await modeOf(target)).toBe(0o500);
      expect(await fs.readdir(target)).toEqual(["keep"]);
      expect(await fs.readFile(path.join(target, "keep"), "utf8")).toBe("keep");
      expect(errors).not.toHaveBeenCalled();
    } finally {
      errors.mockRestore();
      await worker.experimental_dispose();
    }
  },
);

it.skipIf(process.platform === "win32")(
  "retries trash left by an earlier failed removal on the next discard and keeps thread folders it was not asked to clear",
  async () => {
    const root = await temporaryDirectory();

    const leftover = path.join(
      root,
      `.omnyo-trash-thr_seqww2kuj9-${randomUUID()}`,
    );

    const receipted = path.join(root, "thr_receipt");
    const receipt = JSON.stringify({ version: 1, keep: ["evidence"] });

    for (let index = 0; index < 20; index++) {
      await fs.mkdir(path.join(leftover, `browser-${index}`, "dist"), {
        recursive: true,
      });
      await fs.writeFile(
        path.join(leftover, `browser-${index}`, "dist", "browser-worker.mjs"),
        "worker",
      );
    }

    await fs.mkdir(path.join(receipted, "evidence"), { recursive: true });
    await fs.writeFile(path.join(receipted, "storage-retention.json"), receipt);
    await fs.writeFile(path.join(receipted, "evidence", "report.json"), "{}");
    await fs.mkdir(path.join(root, "thr_live"));
    await fs.mkdir(path.join(root, "thr_done"));
    await fs.writeFile(path.join(root, "thr_done", "data"), "done");

    for (let index = 0; index < 20; index++) {
      await fs.chmod(path.join(leftover, `browser-${index}`, "dist"), 0o555);
      await fs.chmod(path.join(leftover, `browser-${index}`), 0o500);
    }

    await fs.chmod(path.join(receipted, "evidence"), 0o500);
    const errors = silenceErrors();
    const worker = experimental_createHostEntryHarness(hostEntry);

    try {
      expect(
        await worker.experimental_call("discard", {
          rootPath: root,
          names: ["thr_done"],
          recreate: true,
        }),
      ).toEqual({ removed: ["thr_done"] });
      await expect
        .poll(() => worker.experimental_getRetainedWorkerLeaseCount(), {
          timeout: 10_000,
        })
        .toBe(0);
      expect((await fs.readdir(root)).sort()).toEqual([
        "thr_done",
        "thr_live",
        "thr_receipt",
      ]);
      expect(await fs.readdir(path.join(root, "thr_done"))).toEqual([]);
      expect(
        await fs.readFile(
          path.join(receipted, "storage-retention.json"),
          "utf8",
        ),
      ).toBe(receipt);
      expect(await modeOf(path.join(receipted, "evidence"))).toBe(0o500);
      expect(errors).not.toHaveBeenCalled();
    } finally {
      errors.mockRestore();
      await worker.experimental_dispose();
    }
  },
);

it.runIf(process.platform === "darwin")(
  "logs one failure and stops when permission repair cannot make trash removable, then finishes it on a later discard",
  async () => {
    const root = await temporaryDirectory();
    const thread = path.join(root, "thr_immutable");
    const pinned = path.join(thread, "readonly", "pinned");

    await fs.mkdir(path.join(thread, "readonly"), { recursive: true });
    await fs.writeFile(pinned, "pinned");
    await run("chflags", ["uchg", pinned]);
    await fs.chmod(path.join(thread, "readonly"), 0o500);
    const errors = silenceErrors();
    const worker = experimental_createHostEntryHarness(hostEntry);

    try {
      expect(
        await worker.experimental_call("discard", {
          rootPath: root,
          names: ["thr_immutable"],
          recreate: false,
        }),
      ).toEqual({ removed: ["thr_immutable"] });
      await expect
        .poll(() => worker.experimental_getRetainedWorkerLeaseCount(), {
          timeout: 10_000,
        })
        .toBe(0);
      expect(errors).toHaveBeenCalledTimes(1);
      expect(errors).toHaveBeenCalledWith(
        "Storage trash cleanup failed",
        expect.objectContaining({ code: "EPERM" }),
      );
      const [trash] = await fs.readdir(root);

      expect(trash).toMatch(/^\.omnyo-trash-thr_immutable-/);
      await run("chflags", [
        "nouchg",
        path.join(root, trash!, "readonly", "pinned"),
      ]);
      expect(
        await worker.experimental_call("discard", {
          rootPath: root,
          names: ["thr_absent"],
          recreate: false,
        }),
      ).toEqual({ removed: [] });
      await expect
        .poll(() => worker.experimental_getRetainedWorkerLeaseCount(), {
          timeout: 10_000,
        })
        .toBe(0);
      expect(await fs.readdir(root)).toEqual([]);
      expect(errors).toHaveBeenCalledTimes(1);
    } finally {
      await run("chflags", ["-R", "nouchg", root]);
      errors.mockRestore();
      await worker.experimental_dispose();
    }
  },
);

it.skipIf(process.platform === "win32")(
  "removes development data and leftover development trash that contain read-only directories",
  async () => {
    const home = await temporaryDirectory();
    const rootPath = path.join(home, ".omnyo-dev");
    const checkout = path.join(home, "checkout");
    const stale = path.join(rootPath, "stale");
    const agentData = path.join(stale, "thread-storage", "thr_agent", "dist");

    const leftover = path.join(
      rootPath,
      `.omnyo-trash-earlier-${randomUUID()}`,
    );

    await fs.mkdir(checkout);
    await fs.mkdir(agentData, { recursive: true });
    await fs.writeFile(path.join(agentData, "browser-worker.mjs"), "worker");
    await fs.writeFile(
      path.join(stale, "dev-instance.json"),
      JSON.stringify({ repoRoot: path.join(home, "missing") }),
    );
    await fs.mkdir(path.join(rootPath, "kept"));
    await fs.writeFile(
      path.join(rootPath, "kept", "dev-instance.json"),
      JSON.stringify({ repoRoot: checkout }),
    );
    await fs.mkdir(path.join(leftover, "dist"), { recursive: true });
    await fs.writeFile(path.join(leftover, "dist", "browser-worker.mjs"), "x");
    await fs.chmod(agentData, 0o555);
    await fs.chmod(path.join(leftover, "dist"), 0o500);
    const errors = silenceErrors();
    const worker = experimental_createHostEntryHarness(hostEntry);

    try {
      expect(
        await worker.experimental_call("removeDeveloperEntries", {
          rootPath,
          names: ["stale", "kept"],
          candidatePaths: [],
          mode: { condition: "checkoutMissing" },
        }),
      ).toEqual({ removed: ["stale"], running: [], stoppedProcessCount: 0 });
      await expect
        .poll(() => worker.experimental_getRetainedWorkerLeaseCount(), {
          timeout: 10_000,
        })
        .toBe(0);
      expect(await fs.readdir(rootPath)).toEqual(["kept"]);
      expect(errors).not.toHaveBeenCalled();
    } finally {
      errors.mockRestore();
      await worker.experimental_dispose();
    }
  },
);
