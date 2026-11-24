import { spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import {
  createFakePluginHost,
  makeHostResponse,
  makeThreadResponse,
} from "@omnyo/plugin-sdk/testing";
import { experimental_createHostEntryHarness } from "@omnyo/plugin-sdk/testing/host";
import hostEntry from "./host.js";
import { hostStorageContract } from "./host-contract.js";
import plugin from "./server.js";

it("retention receipts preserve owners and running children at destructive host boundaries", async () => {
  const root = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), "omnyo-retained-owner-")),
  );

  const names = ["thr_valid", "thr_malformed", "thr_plain"];

  for (const name of names) await fs.mkdir(path.join(root, name));
  await fs.writeFile(
    path.join(root, names[0]!, "storage-retention.json"),
    JSON.stringify({ keepers: ["evidence"] }),
  );
  await fs.writeFile(
    path.join(root, names[1]!, "storage-retention.json"),
    "unreadable receipt format",
  );

  for (const name of names)
    await fs.writeFile(
      path.join(root, name, "evidence"),
      "unique retained content",
    );

  const child = spawn(
    process.execPath,
    [
      "-e",
      "setInterval(() => {}, 1000); process.on('disconnect', () => process.exit()); process.send('ready');",
    ],
    {
      cwd: path.join(root, names[0]!),
      stdio: ["ignore", "ignore", "inherit", "ipc"],
    },
  );

  const ready = once(child, "message");
  const harness = experimental_createHostEntryHarness(hostEntry);

  try {
    await ready;

    const large = await harness.experimental_call("discardLargeFiles", {
      rootPath: root,
      names: names.slice(0, 2),
      minBytes: 1,
    });

    expect(large.removed).toEqual([]);

    for (const name of names.slice(0, 2))
      await expect(
        fs.readFile(path.join(root, name, "evidence"), "utf8"),
      ).resolves.toBe("unique retained content");

    const result = await harness.experimental_call("discard", {
      rootPath: root,
      names,
      recreate: false,
    });

    expect(result.removed).toEqual(["thr_plain"]);
    expect(child.exitCode).toBeNull();
    expect(child.signalCode).toBeNull();

    for (const name of names.slice(0, 2))
      await expect(
        fs.readFile(path.join(root, name, "evidence"), "utf8"),
      ).resolves.toBe("unique retained content");
    await expect(fs.stat(path.join(root, "thr_plain"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, "exit");
      child.kill("SIGKILL");
      await exited;
    }

    await harness.experimental_dispose();
    await fs.rm(root, { recursive: true, force: true });
  }
});

it("automatic deletion preserves an entire group with any retained member and still deletes ordinary owners", async () => {
  const root = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), "omnyo-retained-group-")),
  );

  const ids = ["thr_root", "thr_owned", "thr_plain"];

  for (const id of ids) await fs.mkdir(path.join(root, id));
  await fs.writeFile(
    path.join(root, "thr_owned", "storage-retention.json"),
    "malformed but protective",
  );

  const rows = ids.map((id) =>
    makeThreadResponse({
      id,
      environmentId: "env_test",
      archivedAt: 1,
      updatedAt: 1,
      lifecycleOwnerThreadId: id === "thr_owned" ? "thr_root" : null,
    }),
  );

  const worker = experimental_createHostEntryHarness(hostEntry);

  const host = createFakePluginHost({
    pluginId: "omnyo--storage-retention",
    experimental_hostEntry: true,
    experimental_callHostRpc: async ({ method, input }) => {
      if (method !== "retainedEntries")
        throw new Error("Unexpected host method in retention fixture");

      return worker.experimental_call(
        method,
        hostStorageContract.retainedEntries.input.parse(input),
      );
    },
    sdk: {
      threads: {
        list: async () => rows,
        get: async ({ threadId }) => rows.find((row) => row.id === threadId)!,
        storageLocation: async ({ threadId }) => ({
          hostId: "host_test",
          storageRootPath: path.join(root, threadId),
        }),
        delete: async () => ({ ok: true }),
      },
      hosts: {
        get: async () => ({
          ...makeHostResponse({ id: "host_test", status: "connected" }),
          threadStorageRootPath: root,
        }),
      },
    },
  });

  try {
    plugin(host.api);
    await host.harness.behavior.callRpc("configure", {
      archiveAfterDays: null,
      deleteAfterDays: 7,
      deleteStorageOnArchive: true,
      deleteDevDataOnCheckoutRemoval: false,
    });
    await host.harness.behavior.runSchedule("retention");
    expect(host.harness.inspection.sdk.callsTo("threads.delete")).toEqual([
      [{ threadId: "thr_plain", childThreadsConfirmed: true }],
    ]);
    await expect(
      fs.readFile(
        path.join(root, "thr_owned", "storage-retention.json"),
        "utf8",
      ),
    ).resolves.toBe("malformed but protective");
    expect(await host.harness.behavior.callRpc("state", null)).toMatchObject({
      lastRun: { deletedCount: 1, failedCount: 0 },
    });
  } finally {
    await host.harness.lifecycle.dispose();
    await worker.experimental_dispose();
    await fs.rm(root, { recursive: true, force: true });
  }
});
