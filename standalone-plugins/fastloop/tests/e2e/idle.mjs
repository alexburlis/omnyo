import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, readdir, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { DatabaseSync } from "node:sqlite";

const [helper, projectRoot, threadId, runId, output] = process.argv.slice(2);

assert(
  helper && projectRoot && threadId && runId && output,
  "Explicit owned source scope is required",
);

const timer = setTimeout(() => {
  console.error("IDLE_BOUND_EXCEEDED");
  process.exit(1);
}, 75000);

const exec = promisify(execFile);

const projectKey = createHash("sha256").update(projectRoot).digest("hex").slice(0, 32);

const recordPath = join(homedir(), ".fastloop/coordinators", `${projectKey}.json`);

const snapshot = async () => {
  const { stdout } = await exec("ps", ["-axo", "pid=,ppid=,ucomm=,time=,rss="], {
    timeout: 1000,
    maxBuffer: 1048576,
  });

  return stdout
    .trim()
    .split("\n")
    .map((line) => {
      const parts = line.trim().split(/\s+/);

      return {
        pid: Number(parts[0]),
        ppid: Number(parts[1]),
        command: parts[2],
        cpuTime: parts[3],
        rssKiB: Number(parts[4]),
      };
    });
};

const inventory = async (root) => {
  const entries = [];

  async function walk(path) {
    for (const item of await readdir(path, { withFileTypes: true })) {
      const name = join(path, item.name);

      if (item.isDirectory()) await walk(name);
      else {
        const info = await stat(name);
        entries.push({ path: name.slice(root.length), size: info.size, mtime: info.mtimeMs });
      }
    }
  }

  await walk(root);

  return entries.sort((a, b) => a.path.localeCompare(b.path));
};

const counts = () => {
  const db = new DatabaseSync(join(projectRoot, ".fastloop/journal.sqlite"), { readOnly: true });

  try {
    return db
      .prepare("SELECT name FROM sqlite_master WHERE type='table'")
      .all()
      .map(({ name }) => ({
        table: name,
        count: db.prepare('SELECT count(*) AS n FROM "' + name.replaceAll('"', '""') + '"').get().n,
      }));
  } finally {
    db.close();
  }
};

try {
  const response = await exec(
    process.execPath,
    [helper, "fastloop", "result", "--thread", threadId, "--run", runId],
    { timeout: 14000, maxBuffer: 1048576 },
  ).catch((error) => {
    if (error.code === 130 || error.code === 1 || error.code === 2) return { stdout: error.stdout };
    throw error;
  });

  const job = JSON.parse(response.stdout.trim());
  assert.equal(job.runId, runId);
  assert(["completed", "cancelled", "interrupted"].includes(job.state));
  const record = JSON.parse(await readFile(recordPath, "utf8"));
  const startProcesses = await snapshot();
  const coordinator = startProcesses.find((p) => p.pid === record.owner.pid);
  assert(coordinator, "Owned coordinator PID must exist");

  const owned = [coordinator];
  let current = coordinator;

  for (let depth = 0; depth < 2; depth++) {
    const parent = startProcesses.find((process) => process.pid === current.ppid);

    if (!parent || parent.pid === 1) break;
    owned.push(parent);
    current = parent;
  }

  assert(owned.length >= 2, "Owned SDK bridge parent must be measured");
  const started = performance.now();
  const startedAt = new Date().toISOString();
  const beforeFiles = await inventory(join(projectRoot, ".fastloop/runs"));
  const beforeCounts = counts();
  await new Promise((resolve) => setTimeout(resolve, 60000));
  const elapsedMs = performance.now() - started;
  assert(elapsedMs >= 60000);
  const afterFiles = await inventory(join(projectRoot, ".fastloop/runs"));
  const afterCounts = counts();
  assert.deepEqual(afterFiles, beforeFiles, "Idle scope changed retained capture/artifact files");
  assert.deepEqual(afterCounts, beforeCounts, "Idle scope appended journal activity");
  const endProcesses = await snapshot();

  const receipt = {
    schema: 1,
    surface: "isolated source Omnyo CLI/host bridge plus public SDK idle scope",
    threadId,
    runId,
    startedAt,
    elapsedMs,
    viewer: false,
    providerConfigured: false,
    admission: false,
    browserStarted: false,
    providerRequests: 0,
    screenshots: 0,
    recording: false,
    measurementLimit:
      "Host worker may serve other plugin RPCs; CPU/RSS are process totals, not exclusive FastLoop overhead",
    method:
      "terminal read only; unchanged complete artifact inventory and journal table counts over full observation",
    ownedProcesses: owned.map((start) => ({
      start,
      end: endProcesses.find((p) => p.pid === start.pid) ?? null,
      endState: endProcesses.some((p) => p.pid === start.pid) ? "alive" : "natural_idle_exit",
    })),
    beforeCounts,
    afterCounts,
  };

  await writeFile(output, JSON.stringify(receipt, null, 2) + "\n", { flag: "wx" });
  console.log(JSON.stringify({ elapsedMs, ownedPids: owned.map((p) => p.pid), output }));
} finally {
  clearTimeout(timer);
}
