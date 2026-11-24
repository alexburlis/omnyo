import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import {
  inspectProcessPrivateTemps,
  recoverProcessPrivateTemps,
  type DirectoryProcessInspection,
  type DirectoryProcessInspector,
} from "@omnyo/process-utils";
import { PluginHostManager } from "./plugin-host-manager.js";

const inspection = vi.hoisted(() => {
  const state: { result: DirectoryProcessInspection | null } = {
    result: null,
  };

  return state;
});

vi.mock(
  "../../../packages/process-utils/src/directory-process-inspection.js",
  async (importOriginal) => {
    const actual = await importOriginal<{
      inspectDirectoryProcesses: DirectoryProcessInspector;
    }>();

    const inspectDirectoryProcesses: DirectoryProcessInspector = (
      directory,
      signal,
    ) =>
      inspection.result === null
        ? actual.inspectDirectoryProcesses(directory, signal)
        : Promise.resolve(inspection.result);

    return { ...actual, inspectDirectoryProcesses };
  },
);

const directories: string[] = [];

const managers: PluginHostManager[] = [];

const consumerPids: number[] = [];

async function stopConsumer(pid: number): Promise<void> {
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    return;
  }

  const deadline = Date.now() + 5_000;

  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
    } catch {
      return;
    }

    await new Promise((resolve) => setTimeout(resolve, 20));
  }

  throw new Error(`Consumer ${pid} did not stop`);
}

afterEach(async () => {
  inspection.result = null;
  await Promise.all(consumerPids.splice(0).map(stopConsumer));
  await Promise.all(managers.splice(0).map((manager) => manager.shutdown()));
  await Promise.all(
    directories
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

async function callRetainedHostWorker(args: {
  pluginId: string;
  hold: string;
  warn?: (...args: unknown[]) => void;
}) {
  const dataDir = await mkdtemp(join(tmpdir(), "omnyo-host-private-test-"));
  directories.push(dataDir);
  const registryDirectory = join(dataDir, "temp-registry");

  const bytes = new TextEncoder().encode(`
    import { spawn } from "node:child_process";
    import { writeFileSync } from "node:fs";
    import { join } from "node:path";
    const any = { "~standard": { version: 1, vendor: "test", validate: value => ({ value }) } };
    export default {
      experimental_apiVersion: 1,
      contract: { hold: { input: any, output: any } },
      handlers: { async hold(input, context) {
        context.experimental_retainWorker();
        ${args.hold}
      } },
    };
  `);

  const manager = new PluginHostManager({
    dataDir,
    processPrivateTempRegistryDirectory: registryDirectory,
    logger: { debug() {}, info() {}, warn: args.warn ?? (() => {}) },
    fetchArtifact: async () => bytes,
  });

  managers.push(manager);

  const result = await manager.call({
    type: "plugin.host.call",
    contributedEnv: [],
    pluginId: args.pluginId,
    generation: `${args.pluginId}-generation`,
    artifact: {
      digest: createHash("sha256").update(bytes).digest("hex"),
      byteLength: bytes.byteLength,
    },
    callId: `${args.pluginId}-call`,
    method: "hold",
    input: {},
    timeoutMs: 5_000,
    replacementKey: null,
  });

  return { manager, registryDirectory, output: result.output };
}

function heldTempDir(output: unknown): string {
  if (
    typeof output !== "object" ||
    output === null ||
    !("tempDir" in output) ||
    typeof output.tempDir !== "string"
  )
    throw new Error("Host fixture has no temporary directory");
  directories.push(output.tempDir);

  return output.tempDir;
}

it("registers the actual host worker generation and closes its exact temporary allocation", async () => {
  const { manager, registryDirectory, output } = await callRetainedHostWorker({
    pluginId: "private-host-fixture",
    hold: "return { pid: process.pid };",
  });

  if (typeof output !== "object" || output === null || !("pid" in output))
    throw new Error("Host fixture has no process identity");
  const entries = await inspectProcessPrivateTemps({ registryDirectory });
  expect(entries).toMatchObject([
    {
      pluginId: "private-host-fixture",
      origin: "host-worker",
      status: process.platform === "win32" ? "held" : "active",
    },
  ]);
  const allocation = entries[0];

  if (allocation === undefined)
    throw new Error("Host fixture has no allocation");

  const journal = JSON.parse(
    await readFile(
      join(registryDirectory, `${allocation.allocationId}.json`),
      "utf8",
    ),
  );

  expect(journal.owner.pid).toBe(output.pid);
  expect(existsSync(allocation.tempDir)).toBe(true);
  await manager.shutdown();
  expect(existsSync(allocation.tempDir)).toBe(false);
  expect(await recoverProcessPrivateTemps({ registryDirectory })).toEqual([]);
  const receipts = await readdir(join(registryDirectory, "closed"));
  expect(receipts).toEqual([`${allocation.allocationId}.json`]);
});

it.skipIf(process.platform === "win32")(
  "finishes shutdown and keeps a temporary directory that a live consumer still uses",
  async () => {
    const { manager, registryDirectory, output } = await callRetainedHostWorker(
      {
        pluginId: "consumer-host-fixture",
        hold: `
          const { tempDir } = context.experimental_paths;
          writeFileSync(join(tempDir, "keeper"), "consumer bytes");
          const consumer = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { cwd: tempDir, detached: true, stdio: "ignore" });
          consumer.unref();
          return { consumerPid: consumer.pid, tempDir };
        `,
      },
    );

    const tempDir = heldTempDir(output);

    if (
      typeof output !== "object" ||
      output === null ||
      !("consumerPid" in output) ||
      typeof output.consumerPid !== "number"
    )
      throw new Error("Host fixture has no consumer");
    consumerPids.push(output.consumerPid);

    await expect(manager.shutdown()).resolves.toBeUndefined();
    expect(await readFile(join(tempDir, "keeper"), "utf8")).toBe(
      "consumer bytes",
    );
    expect(
      await inspectProcessPrivateTemps({ registryDirectory }),
    ).toMatchObject([{ status: "held", tempDir }]);

    await stopConsumer(output.consumerPid);
    expect(
      await recoverProcessPrivateTemps({ registryDirectory }),
    ).toMatchObject([{ status: "removed", tempDir }]);
    expect(existsSync(tempDir)).toBe(false);
  },
);

it("finishes shutdown and visibly holds cleanup when process inspection is unavailable", async () => {
  const warn = vi.fn();

  const { manager, registryDirectory, output } = await callRetainedHostWorker({
    pluginId: "uninspectable-host-fixture",
    hold: `
      const { tempDir } = context.experimental_paths;
      writeFileSync(join(tempDir, "keeper"), "unverified bytes");
      return { tempDir };
    `,
    warn,
  });

  const tempDir = heldTempDir(output);

  inspection.result = {
    kind: "unknown",
    message:
      "Complete native process inspection is unsupported on this platform; physical cleanup is held.",
  };

  await expect(manager.shutdown()).resolves.toBeUndefined();
  expect(await readFile(join(tempDir, "keeper"), "utf8")).toBe(
    "unverified bytes",
  );
  expect(await inspectProcessPrivateTemps({ registryDirectory })).toMatchObject(
    [{ status: "held", tempDir }],
  );
  expect(warn).toHaveBeenCalledWith(
    expect.objectContaining({
      pluginId: "uninspectable-host-fixture",
      err: expect.objectContaining({
        message: expect.stringContaining("unsupported on this platform"),
      }),
    }),
    "Host plugin temporary directory cleanup was held or failed",
  );
});
