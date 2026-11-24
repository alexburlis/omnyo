import { execFile, spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { closeSync, existsSync, openSync } from "node:fs";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, expect, it } from "vitest";
import {
  createPluginProcessTempAllocation,
  inspectProcessPrivateTemps,
  recoverProcessPrivateTemps,
} from "../src/process-private-temp.js";

const directories: string[] = [];

const children: ChildProcess[] = [];

const orphanedPids: number[] = [];

const source = new URL("../src/process-private-temp.ts", import.meta.url).href;

afterEach(async () => {
  for (const pid of orphanedPids.splice(0)) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {}

    const deadline = Date.now() + 2_000;
    let stopped = false;

    while (Date.now() < deadline) {
      try {
        process.kill(pid, 0);
      } catch {
        stopped = true;
        break;
      }

      await new Promise((resolve) => setTimeout(resolve, 20));
    }

    expect(stopped).toBe(true);
  }

  await Promise.all(
    children.splice(0).map(async (child) => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      const closed = once(child, "close");
      child.kill("SIGKILL");
      await closed;
    }),
  );
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function fixture() {
  const directory = await mkdtemp(
    join(tmpdir(), "omnyo-process-private-test-"),
  );

  directories.push(directory);

  return { registryDirectory: join(directory, "registry") };
}

async function realProducer(
  options: { registryDirectory: string },
  descendant = false,
) {
  const descendantSource = `
    const fs = require('node:fs');
    const path = require('node:path');
    const descriptor = fs.openSync('consumer-open.txt', 'w+');
    process.stdout.write(JSON.stringify({ pid: process.pid }) + String.fromCharCode(10));
    setInterval(() => {
      if (fs.existsSync(${JSON.stringify(join(options.registryDirectory, "consumer-request"))})) {
        fs.writeSync(descriptor, 'open-file-canary');
        fs.writeFileSync('consumer-cwd-canary', 'cwd-canary');
        fs.writeFileSync(${JSON.stringify(join(options.registryDirectory, "consumer-response"))}, 'canaries-written');
      }
    }, 20);
  `;

  const child = spawn(
    process.execPath,
    [
      "--conditions=source",
      "--import",
      import.meta.resolve("tsx"),
      "--input-type=module",
      "-e",
      `import { createPluginProcessTempAllocation } from ${JSON.stringify(source)};
    import { spawn } from 'node:child_process';
    import { once } from 'node:events';
    const allocation = await createPluginProcessTempAllocation(${JSON.stringify({ ...options, pluginId: "private-fixture", prefix: "omnyo-private-test", origin: "provider-bridge", owner: "self" })});
    let descendantPid = null;
    if (${descendant}) {
      const consumer = spawn(process.execPath, ['-e', ${JSON.stringify(descendantSource)}], { cwd: allocation.tempDir, detached: true, stdio: ['ignore', 'pipe', 'ignore'] });
      const [output] = await once(consumer.stdout, 'data');
      descendantPid = JSON.parse(output.toString()).pid;
      consumer.unref();
    }
    process.stdout.write(JSON.stringify({ tempDir: allocation.tempDir, allocationId: allocation.allocationId, descendantPid }) + String.fromCharCode(10));
    setInterval(() => {}, 1000);`,
    ],
    { stdio: ["ignore", "pipe", "pipe"] },
  );

  children.push(child);
  let stdout = "";
  let stderr = "";
  child.stderr?.setEncoding("utf8").on("data", (chunk: string) => {
    stderr += chunk;
  });

  const allocation = await new Promise<{
    tempDir: string;
    allocationId: string;
    descendantPid: number | null;
  }>((resolve, reject) => {
    child.stdout?.setEncoding("utf8").on("data", (chunk: string) => {
      stdout += chunk;

      if (stdout.includes("\n")) resolve(JSON.parse(stdout));
    });
    child.once("error", reject);
    child.once("exit", () =>
      reject(new Error(`Fixture producer exited before allocation: ${stderr}`)),
    );
  });

  directories.push(allocation.tempDir);

  if (allocation.descendantPid !== null)
    orphanedPids.push(allocation.descendantPid);

  return { child, ...allocation };
}

async function stop(child: ChildProcess) {
  const closed = once(child, "close");
  child.kill("SIGKILL");
  await closed;
}

it("holds the live generation and recovers a real crashed producer once", async () => {
  const options = await fixture();
  const producer = await realProducer(options);
  await writeFile(
    join(producer.tempDir, "payload"),
    "private ephemeral output",
  );
  expect(await recoverProcessPrivateTemps(options)).toMatchObject([
    { status: "active" },
  ]);
  expect(existsSync(producer.tempDir)).toBe(true);
  await stop(producer.child);

  if (process.platform === "win32") {
    expect(await recoverProcessPrivateTemps(options)).toMatchObject([
      { status: "held" },
    ]);

    return;
  }

  expect(await inspectProcessPrivateTemps(options)).toMatchObject([
    { status: "recoverable" },
  ]);
  expect(await recoverProcessPrivateTemps(options)).toMatchObject([
    { status: "removed" },
  ]);
  expect(existsSync(producer.tempDir)).toBe(false);
  expect(await recoverProcessPrivateTemps(options)).toEqual([]);

  const receipt = JSON.parse(
    await readFile(
      join(
        options.registryDirectory,
        "closed",
        `${producer.allocationId}.json`,
      ),
      "utf8",
    ),
  );

  expect(receipt.result).toMatchObject({
    status: "removed",
    reason: "stopped-generation-recovery",
  });
});

it.skipIf(process.platform === "win32")(
  "holds a surviving descendant with an open file and working directory after its owner crashes",
  async () => {
    const options = await fixture();
    const producer = await realProducer(options, true);
    expect(producer.descendantPid).toBeGreaterThan(0);
    await stop(producer.child);
    expect(await recoverProcessPrivateTemps(options)).toMatchObject([
      { status: "held" },
    ]);
    expect(existsSync(producer.tempDir)).toBe(true);
    await writeFile(
      join(options.registryDirectory, "consumer-request"),
      "write",
    );
    const deadline = Date.now() + 1_000;

    while (
      !existsSync(join(options.registryDirectory, "consumer-response")) &&
      Date.now() < deadline
    )
      await new Promise((resolve) => setTimeout(resolve, 20));
    expect(
      await readFile(
        join(options.registryDirectory, "consumer-response"),
        "utf8",
      ),
    ).toBe("canaries-written");
    expect(
      await readFile(join(producer.tempDir, "consumer-open.txt"), "utf8"),
    ).toContain("open-file-canary");
    expect(
      await readFile(join(producer.tempDir, "consumer-cwd-canary"), "utf8"),
    ).toBe("cwd-canary");
  },
);

it.skipIf(process.platform === "win32")(
  "holds a special file before any recovery deletion",
  async () => {
    const options = await fixture();
    const producer = await realProducer(options);
    await stop(producer.child);
    const canary = join(producer.tempDir, "regular-canary");
    await writeFile(canary, "keep");
    await promisify(execFile)("mkfifo", [join(producer.tempDir, "pipe")], {
      timeout: 2_000,
    });
    expect(await recoverProcessPrivateTemps(options)).toMatchObject([
      { status: "held", reason: "process-temporary-special-file-held" },
    ]);
    expect(await readFile(canary, "utf8")).toBe("keep");
  },
);

it.skipIf(process.platform === "win32")(
  "does not exclude the inspecting process when it holds an allocation file",
  async () => {
    const options = await fixture();
    const producer = await realProducer(options);
    await stop(producer.child);
    const descriptor = openSync(join(producer.tempDir, "self-consumer"), "w");

    try {
      expect(await recoverProcessPrivateTemps(options)).toMatchObject([
        { status: "held" },
      ]);
      expect(existsSync(producer.tempDir)).toBe(true);
    } finally {
      closeSync(descriptor);
    }

    expect(await recoverProcessPrivateTemps(options)).toMatchObject([
      { status: "removed" },
    ]);
  },
);

it.skipIf(process.platform === "win32")(
  "holds a process that only has its working directory in the allocation",
  async () => {
    const options = await fixture();
    const producer = await realProducer(options);
    await stop(producer.child);

    const child = spawn(
      process.execPath,
      ["-e", "process.stdout.write('ready');setInterval(() => {}, 1000)"],
      { cwd: producer.tempDir, stdio: ["ignore", "pipe", "ignore"] },
    );

    children.push(child);
    await once(child.stdout!, "data");
    expect(await recoverProcessPrivateTemps(options)).toMatchObject([
      { status: "held" },
    ]);
    expect(existsSync(producer.tempDir)).toBe(true);
    await stop(child);
    expect(await recoverProcessPrivateTemps(options)).toMatchObject([
      { status: "removed" },
    ]);
  },
);

it("holds an unknown owner and cleans a fresh unstarted allocation locally", async () => {
  const options = await fixture();

  const allocation = await createPluginProcessTempAllocation({
    ...options,
    pluginId: "host-fixture",
    prefix: "omnyo-private-test",
    origin: "host-worker",
    owner: "child",
  });

  directories.push(allocation.tempDir);
  expect(await recoverProcessPrivateTemps(options)).toMatchObject([
    { status: "held", reason: "process-identity-unknown" },
  ]);
  allocation.closeUnstarted();
  expect(existsSync(allocation.tempDir)).toBe(false);
  expect(await inspectProcessPrivateTemps(options)).toEqual([]);
});

it("keeps recovering when a producer closes its journal during the scan", async () => {
  const options = await fixture();

  const allocations = await Promise.all(
    [0, 1].map(() =>
      createPluginProcessTempAllocation({
        ...options,
        pluginId: "host-fixture",
        prefix: "omnyo-private-test",
        origin: "host-worker",
        owner: "child",
      }),
    ),
  );

  for (const allocation of allocations) directories.push(allocation.tempDir);

  const [first, closing] = [...allocations].sort((a, b) =>
    a.allocationId < b.allocationId ? -1 : 1,
  );

  const recovery = recoverProcessPrivateTemps(options);
  closing!.closeUnstarted();

  expect(await recovery).toMatchObject([
    {
      allocationId: first!.allocationId,
      status: "held",
      reason: "process-identity-unknown",
    },
  ]);
  expect(existsSync(first!.tempDir)).toBe(true);
  first!.closeUnstarted();
});

it.skipIf(process.platform === "win32")(
  "preserves self-owned output on explicit exit for the existing recovery owner",
  async () => {
    const options = await fixture();

    const result = await promisify(execFile)(
      process.execPath,
      [
        "--conditions=source",
        "--import",
        import.meta.resolve("tsx"),
        "--input-type=module",
        "-e",
        `
    import { createPluginProcessTempAllocation } from ${JSON.stringify(source)};
    import { writeFileSync } from 'node:fs';
    import { join } from 'node:path';
    const allocation = await createPluginProcessTempAllocation(${JSON.stringify({ ...options, pluginId: "explicit-exit-fixture", prefix: "omnyo-private-test", origin: "provider-bridge", owner: "self" })});
    writeFileSync(join(allocation.tempDir, 'keeper'), 'pending recovery');
    process.stdout.write(JSON.stringify(allocation));
    process.exit(0);
  `,
      ],
      { timeout: 5_000 },
    );

    const allocation = JSON.parse(result.stdout);
    directories.push(allocation.tempDir);
    expect(await readFile(join(allocation.tempDir, "keeper"), "utf8")).toBe(
      "pending recovery",
    );
    expect(await recoverProcessPrivateTemps(options)).toMatchObject([
      { status: "removed" },
    ]);
    expect(existsSync(allocation.tempDir)).toBe(false);
  },
);

it("keeps child-owned output until real child close and records automatic closeout", async () => {
  const options = await fixture();

  const allocation = await createPluginProcessTempAllocation({
    ...options,
    pluginId: "host-fixture",
    prefix: "omnyo-private-test",
    origin: "host-worker",
    owner: "child",
  });

  directories.push(allocation.tempDir);

  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    stdio: "ignore",
  });

  children.push(child);
  const cleanup = allocation.attachChild(child);
  expect(existsSync(allocation.tempDir)).toBe(true);
  await stop(child);
  await cleanup;
  expect(existsSync(allocation.tempDir)).toBe(false);
  expect(await readdir(join(options.registryDirectory, "closed"))).toEqual([
    `${allocation.allocationId}.json`,
  ]);
});

it("observes a child that exits during asynchronous owner binding", async () => {
  const options = await fixture();

  const allocation = await createPluginProcessTempAllocation({
    ...options,
    pluginId: "fast-host-fixture",
    prefix: "omnyo-private-test",
    origin: "host-worker",
    owner: "child",
  });

  directories.push(allocation.tempDir);

  const child = spawn(process.execPath, ["-e", "process.exit(7)"], {
    stdio: "ignore",
  });

  children.push(child);
  await allocation.attachChild(child);
  expect(child.exitCode).toBe(7);
  expect(existsSync(allocation.tempDir)).toBe(false);
  expect(await inspectProcessPrivateTemps(options)).toEqual([]);
});

it.skipIf(process.platform === "win32")(
  "holds a surviving real consumer after normal child close",
  async () => {
    const options = await fixture();

    const allocation = await createPluginProcessTempAllocation({
      ...options,
      pluginId: "consumer-host-fixture",
      prefix: "omnyo-private-test",
      origin: "host-worker",
      owner: "child",
    });

    directories.push(allocation.tempDir);
    await writeFile(join(allocation.tempDir, "keeper"), "consumer bytes");

    const child = spawn(
      process.execPath,
      [
        "-e",
        `
    const { spawn } = require('node:child_process');
    const consumer = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { cwd: ${JSON.stringify(allocation.tempDir)}, detached: true, stdio: 'ignore' });
    consumer.unref();
    process.stdout.write(JSON.stringify({ pid: consumer.pid }) + '\\n');
    process.stdin.once('data', () => process.exit(0));
  `,
      ],
      { stdio: ["pipe", "pipe", "pipe"] },
    );

    children.push(child);
    const cleanup = allocation.attachChild(child);

    if (child.stdout === null || child.stdin === null)
      throw new Error("The fixture requires piped process streams");
    const [output] = await once(child.stdout, "data");
    const consumer = JSON.parse(String(output));
    orphanedPids.push(consumer.pid);
    child.stdin.end("finish");
    await expect(cleanup).rejects.toThrow("consumer");
    expect(await readFile(join(allocation.tempDir, "keeper"), "utf8")).toBe(
      "consumer bytes",
    );
    expect(await inspectProcessPrivateTemps(options)).toMatchObject([
      { status: "held" },
    ]);
  },
);

it("holds a replaced physical root without deleting the replacement", async () => {
  const options = await fixture();
  const producer = await realProducer(options);
  await stop(producer.child);
  const original = `${producer.tempDir}-original`;
  await rename(producer.tempDir, original);
  directories.push(original);
  await mkdir(producer.tempDir, { mode: 0o700 });
  await writeFile(join(producer.tempDir, "foreign"), "keep");
  expect(await recoverProcessPrivateTemps(options)).toMatchObject([
    { status: "held" },
  ]);
  expect(await readFile(join(producer.tempDir, "foreign"), "utf8")).toBe(
    "keep",
  );
});

it("holds changed markers, reused process identities and uncertain closeouts", async () => {
  const options = await fixture();
  const producer = await realProducer(options);
  const path = join(options.registryDirectory, `${producer.allocationId}.json`);
  const journal = JSON.parse(await readFile(path, "utf8"));
  journal.owner.startIdentity = "different-start";
  await writeFile(path, JSON.stringify(journal), { mode: 0o600 });
  expect(await recoverProcessPrivateTemps(options)).toMatchObject([
    { status: "held", reason: "process-identity-unknown" },
  ]);
  await stop(producer.child);
  await writeFile(
    join(producer.tempDir, ".omnyo-process-private.json"),
    "changed",
  );
  expect(await recoverProcessPrivateTemps(options)).toMatchObject([
    {
      status: "held",
      reason: "Process temporary storage allocation marker changed",
    },
  ]);
  await rename(
    path,
    join(options.registryDirectory, `${producer.allocationId}.removing`),
  );
  expect(await recoverProcessPrivateTemps(options)).toMatchObject([
    { status: "held", reason: "closeout-outcome-unknown" },
  ]);
  expect(existsSync(producer.tempDir)).toBe(true);
});

it("never adopts an unmarked existing directory", async () => {
  const options = await fixture();
  await mkdir(options.registryDirectory, { mode: 0o700 });
  const unmarked = join(options.registryDirectory, "legacy-output");
  await mkdir(unmarked);
  await writeFile(join(unmarked, "payload"), "keep");
  expect(await recoverProcessPrivateTemps(options)).toEqual([]);
  expect(await readFile(join(unmarked, "payload"), "utf8")).toBe("keep");
});

it.skipIf(process.platform === "win32")(
  "respects recovery item and byte budgets and never follows payload symlinks",
  async () => {
    const options = await fixture();
    const producer = await realProducer(options);
    const protectedPath = join(options.registryDirectory, "protected-payload");
    await writeFile(protectedPath, "keep");
    await symlink(protectedPath, join(producer.tempDir, "outside"));
    await writeFile(join(producer.tempDir, "payload"), "remove");
    await stop(producer.child);
    expect(
      await recoverProcessPrivateTemps({ ...options, limit: 0 }),
    ).toMatchObject([{ status: "recoverable" }]);
    const held = await recoverProcessPrivateTemps({ ...options, maxBytes: 0 });
    expect(held).toMatchObject([
      { status: "held", reason: "process-temporary-byte-budget-exhausted" },
    ]);
    expect(held[0]?.sizeBytes).toBeGreaterThan(0);

    const recovered = await recoverProcessPrivateTemps({
      ...options,
      maxBytes: held[0]?.sizeBytes ?? 0,
    });

    expect(recovered).toMatchObject([
      { status: "removed", sizeBytes: held[0]?.sizeBytes },
    ]);
    expect(await readFile(protectedPath, "utf8")).toBe("keep");
  },
);
