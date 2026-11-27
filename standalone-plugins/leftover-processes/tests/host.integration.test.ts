import { execFile, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import { experimental_createHostEntryHarness } from "@omnyo/plugin-sdk/testing/host";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ObservedProcess, ProcessIdentity, HostUsage } from "../contract";
import hostEntry from "../host";
import { emptySystemUsage } from "../system-usage";

const exec = promisify(execFile);

const CANARY = "canary-value-integration-5d1e";

const THREAD_ID = "thr_integration";

async function identityOf(pid: number): Promise<ProcessIdentity | null> {
  try {
    const { stdout } = await exec("/bin/ps", ["-p", String(pid), "-o", "lstart="], {
      env: { ...process.env, LC_ALL: "C" },
    });

    const startedAt = stdout.trim().replace(/\s+/g, " ");

    return startedAt === "" ? null : { pid, startedAt };
  } catch {
    return null;
  }
}

async function parentOf(pid: number): Promise<number> {
  const { stdout } = await exec("/bin/ps", ["-p", String(pid), "-o", "ppid="]);

  return Number(stdout.trim());
}

const SLEEPER = "setInterval(() => {}, 1000);";

const TERM_IGNORING = "process.on('SIGTERM', () => {});";

const READY = "require('node:fs').writeFileSync(process.argv[1], '');";

const RETITLING = "process.title = 'dev-server (v1)';";

async function startOrphan(
  markerDir: string,
  name: string,
  env: NodeJS.ProcessEnv,
  prelude = "",
  extraArgument = "",
): Promise<number> {
  const marker = join(markerDir, name);
  const program = `${prelude}${READY}${SLEEPER}`;

  const pid = await new Promise<number>((resolve, reject) => {
    const shell = spawn(
      "/bin/sh",
      [
        "-c",
        `"$0" -e "$1" "$2" "$3" >/dev/null 2>&1 & echo $!`,
        process.execPath,
        program,
        marker,
        extraArgument,
      ],
      { env, stdio: ["ignore", "pipe", "ignore"] },
    );

    let output = "";

    shell.stdout.on("data", (chunk: Buffer) => {
      output += chunk.toString();
    });

    shell.once("error", reject);
    shell.once("close", () => resolve(Number(output.trim())));
  });

  for (let attempt = 0; attempt < 200 && !existsSync(marker); attempt += 1) await delay(25);

  if (!existsSync(marker)) throw new Error(`fixture ${name} did not start`);

  return pid;
}

const baseEnvironment = () => {
  const environment = { ...process.env };

  delete environment.OMNYO_THREAD_ID;
  delete environment.OMNYO_THREAD_STORAGE;
  delete environment.OMNYO_KEEP_RUNNING;
  delete environment.BB_THREAD_ID;
  delete environment.BB_THREAD_STORAGE;
  delete environment.BB_KEEP_RUNNING;

  return { ...environment, FIXTURE_CANARY: CANARY };
};

describe.skipIf(process.platform !== "darwin")("host entry on this Mac", () => {
  const spawned: number[] = [];
  let root = "";
  let tagged = 0;
  let untagged = 0;
  let foreign = 0;
  let stubborn = 0;
  let retitled = 0;
  let lookalike = 0;
  let kept = 0;
  let found: ObservedProcess[] = [];
  let scanJson = "";

  let measured: HostUsage = {
    hostName: "",
    system: emptySystemUsage(),
    coverage: "failed",
    threads: [],
  };

  let dispose: () => Promise<void> = async () => {};

  let stop: (
    identities: ProcessIdentity[],
    graceMs: number,
  ) => Promise<{
    results: Array<ProcessIdentity & { outcome: string; detail: string | null }>;
  }> = async () => ({ results: [] });

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "lp-host-"));

    const dataDir = join(root, "data");
    const hostData = join(dataDir, "plugins", "leftover-processes", "host-data");
    const tempDir = join(root, "temp");

    await Promise.all([mkdir(hostData, { recursive: true }), mkdir(tempDir)]);

    const native = experimental_createHostEntryHarness(hostEntry, {
      experimental_paths: { dataDir: hostData, tempDir },
    });

    dispose = () => native.experimental_dispose();

    stop = (identities, graceMs) => native.experimental_call("stop", { identities, graceMs });

    const tagEnvironment = {
      ...baseEnvironment(),
      OMNYO_THREAD_ID: THREAD_ID,
      OMNYO_THREAD_STORAGE: join(dataDir, "thread-storage", THREAD_ID),
    };

    const markers = join(root, "markers");

    await mkdir(markers);

    tagged = await startOrphan(markers, "tagged", tagEnvironment);
    spawned.push(tagged);
    stubborn = await startOrphan(markers, "stubborn", tagEnvironment, TERM_IGNORING);
    spawned.push(stubborn);
    retitled = await startOrphan(markers, "retitled", tagEnvironment, RETITLING);
    spawned.push(retitled);
    lookalike = await startOrphan(
      markers,
      "lookalike",
      tagEnvironment,
      "",
      "OMNYO_THREAD_ID=thr_argv",
    );
    spawned.push(lookalike);
    kept = await startOrphan(markers, "kept", { ...tagEnvironment, OMNYO_KEEP_RUNNING: "1" });
    spawned.push(kept);
    untagged = await startOrphan(markers, "untagged", baseEnvironment());
    spawned.push(untagged);

    foreign = await startOrphan(markers, "foreign", {
      ...baseEnvironment(),
      OMNYO_THREAD_ID: "thr_foreign",
      OMNYO_THREAD_STORAGE: join(root, "other-omnyo", "thread-storage", "thr_foreign"),
    });

    spawned.push(foreign);

    const scan = await native.experimental_call("scan", {});

    if (!scan.supported) throw new Error(`scan is unsupported: ${scan.reason}`);

    found = scan.processes;
    scanJson = JSON.stringify(scan);
    measured = await native.experimental_call("usage", {});
  });

  afterAll(async () => {
    for (const pid of spawned) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        continue;
      }
    }

    await dispose();
    await rm(root, { recursive: true, force: true });
  });

  it("measures live owned processes without returning commands, tags or environment", () => {
    expect(measured.coverage).toBe("complete");
    expect(measured.threads).toHaveLength(1);
    expect(measured.threads[0]).toMatchObject({ threadId: THREAD_ID });
    expect(measured.threads[0]?.memoryBytes).toBeGreaterThan(0);
    expect(measured.threads[0]?.cpuPercent).toBeGreaterThanOrEqual(0);
    expect(JSON.stringify(measured)).not.toContain(CANARY);
    expect(measured.hostName.length).toBeGreaterThan(0);
    expect(measured.system.cpuPercent).toBeGreaterThanOrEqual(0);
    expect(measured.system.cpuPercent).toBeLessThanOrEqual(100);
    expect(measured.system.memoryUsedBytes).toBeGreaterThan(0);
    expect(measured.system.memoryTotalBytes).toBeGreaterThanOrEqual(
      measured.system.memoryUsedBytes ?? 0,
    );
    const tasks = measured.threads[0]?.tasks ?? [];
    expect(tasks.map((task) => task.pid).sort()).toEqual(
      [tagged, stubborn, retitled, lookalike, kept].sort(),
    );

    for (const task of tasks) {
      expect(Object.keys(task).sort()).toEqual(["cpuPercent", "memoryBytes", "name", "pid"]);
      expect(task.name).not.toContain("/");
      expect(task.name).not.toContain("OMNYO_THREAD_ID");
      expect(task.name).toBe("node");
    }

    expect(Object.keys(measured.threads[0] ?? {}).sort()).toEqual([
      "cpuPercent",
      "memoryBytes",
      "tasks",
      "threadId",
    ]);
  });

  it("starts the fixtures reparented to launchd", async () => {
    expect(await parentOf(tagged)).toBe(1);
  });

  it("finds only the tagged processes, as workloads with real memory", () => {
    const row = found.find((process) => process.pid === tagged);

    expect(found.map((process) => process.pid).sort()).toEqual(
      [tagged, stubborn, retitled, lookalike, kept].sort(),
    );
    expect(row).toMatchObject({
      threadId: THREAD_ID,
      role: "workload",
      executable: "node",
      keepRequested: false,
      memorySource: "footprint",
    });

    expect(row?.memoryBytes).toBeGreaterThan(0);
  });

  it("still finds a server that rewrote its process title", () => {
    expect(found.find((process) => process.pid === retitled)).toMatchObject({
      threadId: THREAD_ID,
      role: "workload",
    });
  });

  it("trusts the environment over a look-alike argument", () => {
    expect(found.find((process) => process.pid === lookalike)?.threadId).toBe(THREAD_ID);
  });

  it("reads a launch-time keep request", () => {
    expect(found.find((process) => process.pid === kept)?.keepRequested).toBe(true);
    expect(found.find((process) => process.pid === tagged)?.keepRequested).toBe(false);
  });

  it("does not let the fixture's environment reach the scan result", () => {
    expect(scanJson.length).toBeGreaterThan(0);
    expect(scanJson).not.toContain(CANARY);
    expect(scanJson).not.toContain("FIXTURE_CANARY");
  });

  it("refuses a wrong startedAt and leaves the process running", async () => {
    const { results } = await stop([{ pid: tagged, startedAt: "Thu Jan 1 00:00:00 2026" }], 100);

    expect(results).toEqual([
      {
        pid: tagged,
        startedAt: "Thu Jan 1 00:00:00 2026",
        outcome: "refused",
        detail: "process identity changed",
      },
    ]);

    expect(await identityOf(tagged)).not.toBeNull();
  });

  it("refuses to signal this worker or pid 1", async () => {
    const self = await identityOf(process.pid);

    if (self === null) throw new Error("own identity must be readable");

    const { results } = await stop([self, { pid: 1, startedAt: "Thu Jan 1 00:00:00 2026" }], 0);

    expect(results.map((result) => result.outcome)).toEqual(["refused", "refused"]);
  });

  it("terminates the right identity with SIGTERM", async () => {
    const identity = await identityOf(tagged);

    if (identity === null) throw new Error("fixture must be running");

    const { results } = await stop([identity], 5000);

    expect(results[0]).toMatchObject({ pid: tagged, outcome: "terminated" });
    expect(await identityOf(tagged)).toBeNull();
  });

  it("reports an already gone process as gone", async () => {
    const { results } = await stop([{ pid: tagged, startedAt: "Thu Jan 1 00:00:00 2026" }], 0);

    expect(results[0]?.outcome).toBe("gone");
  });

  it("kills a TERM-ignoring child after the grace period", async () => {
    const identity = await identityOf(stubborn);

    if (identity === null) throw new Error("fixture must be running");

    const startedAt = Date.now();
    const { results } = await stop([identity], 300);

    expect(results[0]).toMatchObject({ pid: stubborn, outcome: "killed" });
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(300);
    expect(await identityOf(stubborn)).toBeNull();
  });
});

describe("host entry preconditions", () => {
  const paths = { dataDir: "/x/plugins/leftover-processes/host-data", tempDir: "/x/temp" };

  it("returns a visible reason on a machine that is not macOS", async () => {
    const native = experimental_createHostEntryHarness(hostEntry, { experimental_paths: paths });
    const platform = Object.getOwnPropertyDescriptor(process, "platform");

    Object.defineProperty(process, "platform", { configurable: true, value: "win32" });

    try {
      const usage = await native.experimental_call("usage", {});
      expect(usage).toMatchObject({ coverage: "unsupported", threads: [] });
      expect(usage.hostName.length).toBeGreaterThan(0);
      expect(usage.system.cpuPercent).toBeGreaterThanOrEqual(0);
      expect(usage.system.memoryTotalBytes).toBeGreaterThan(0);
      expect(await native.experimental_call("scan", {})).toEqual({
        supported: false,
        reason: "Process tracking is only available on macOS.",
      });
    } finally {
      if (platform !== undefined) Object.defineProperty(process, "platform", platform);

      await native.experimental_dispose();
    }
  });

  it.skipIf(process.platform !== "darwin")(
    "returns a visible reason when it cannot find Omnyo's data folder",
    async () => {
      const native = experimental_createHostEntryHarness(hostEntry, {
        experimental_paths: { dataDir: "/somewhere/else", tempDir: "/x/temp" },
      });

      try {
        expect(await native.experimental_call("scan", {})).toEqual({
          supported: false,
          reason: "Omnyo's data folder could not be found on this machine.",
        });
      } finally {
        await native.experimental_dispose();
      }
    },
  );

  it.skipIf(process.platform !== "darwin")(
    "honors cancellation before it runs a command",
    async () => {
      const native = experimental_createHostEntryHarness(hostEntry, { experimental_paths: paths });
      const controller = new AbortController();

      controller.abort(new Error("cancelled by the caller"));

      try {
        await expect(
          native.experimental_call("scan", {}, { signal: controller.signal }),
        ).rejects.toThrow();
      } finally {
        await native.experimental_dispose();
      }
    },
  );
});
