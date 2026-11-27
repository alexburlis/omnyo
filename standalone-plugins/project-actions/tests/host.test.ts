import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { experimental_createHostEntryHarness } from "@omnyo/plugin-sdk/testing/host";
import host, { parseActivity } from "../host";
import type { Action } from "../contract";

const action = {
  id: "test",
  label: "Test",
  kind: "command",
  hostId: "local",
  cwd: "/private/tmp",
  argv: [process.execPath, "-e", "process.exit(0)"],
  timeoutMs: 1000,
} satisfies Action;

const node = (script: string) => ({ ...action, argv: [process.execPath, "-e", script] });

const root = mkdtempSync(join(tmpdir(), "project-actions-"));

const tempDir = join(root, "host-temp");

after(() => rmSync(root, { recursive: true, force: true }));

const harnessFor = () =>
  experimental_createHostEntryHarness(host, { experimental_paths: { dataDir: root, tempDir } });

test("host executes exact argv, exposes nonzero exit, and enforces timeout", async () => {
  const harness = harnessFor();
  assert.deepEqual(await harness.experimental_call("execute", { runId: "a", action }), {
    exitCode: 0,
    signal: null,
    stopped: false,
  });
  assert.deepEqual(
    await harness.experimental_call("execute", { runId: "b", action: node("process.exit(7)") }),
    { exitCode: 7, signal: null, stopped: false },
  );

  const timed = await harness.experimental_call("execute", {
    runId: "c",
    action: node("setTimeout(()=>{},10000)"),
  });

  assert.equal(timed.signal, "SIGKILL");
  await assert.rejects(
    harness.experimental_call("execute", {
      runId: "d",
      action: { ...action, argv: ["/nonexistent-project-actions"] },
    }),
  );
  await harness.experimental_dispose();
});

test("stop force quits the whole process tree, including detached grandchildren", async () => {
  const harness = harnessFor();
  const pidFile = join(root, "grandchild.pid");

  const grandchild = `require("node:fs").writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setInterval(()=>{},1000)`;

  const parent = `require("node:child_process").spawn(process.execPath, ["-e", ${JSON.stringify(grandchild)}], { stdio: "ignore" }); setInterval(()=>{},1000)`;

  const running = harness.experimental_call("execute", {
    runId: "tree",
    action: { ...node(parent), timeoutMs: 30000 },
  });

  while (!existsSync(pidFile) || !readFileSync(pidFile, "utf8"))
    await new Promise((resolve) => setTimeout(resolve, 20));
  const grandchildPid = Number(readFileSync(pidFile, "utf8"));

  assert.deepEqual(await harness.experimental_call("stop", { runId: "tree" }), { stopped: true });
  assert.equal((await running).stopped, true);
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.throws(() => process.kill(grandchildPid, 0));
  assert.deepEqual(await harness.experimental_call("stop", { runId: "tree" }), { stopped: false });
  await harness.experimental_dispose();
});

test("parseActivity keeps the last printable line and reads a leading step", () => {
  assert.equal(parseActivity(""), null);
  assert.equal(parseActivity("\n  \n"), null);
  assert.deepEqual(parseActivity("1/4 Checking\r\n2/4 Building\n\n"), {
    text: "Building",
    progress: { current: 2, total: 4 },
  });
  assert.deepEqual(parseActivity("Downloading 10%\rDownloading 80%"), {
    text: "Downloading 80%",
    progress: null,
  });
  assert.deepEqual(parseActivity("5/4 Too far"), { text: "5/4 Too far", progress: null });
  assert.deepEqual(parseActivity("0/4 Not started"), { text: "0/4 Not started", progress: null });
  assert.deepEqual(parseActivity("\u001b[1mBold\u001b[0m"), { text: "[1mBold[0m", progress: null });

  const long = parseActivity("x".repeat(400));

  assert.equal(long?.text.length, 160);
  assert.ok(long?.text.endsWith("…"));
});

test("a running command reports status lines it writes to OMNYO_ACTION_STATUS", async () => {
  const harness = harnessFor();

  const script = `const fs = require("node:fs");
    const write = (line) => fs.writeFileSync(process.env.OMNYO_ACTION_STATUS, line + "\\n");
    write("1/2 First step");
    setTimeout(() => write("Second step"), 1300);
    setTimeout(() => process.exit(0), 2600);`;

  const result = await harness.experimental_call("execute", {
    runId: "status",
    action: { ...node(script), timeoutMs: 10000 },
  });

  assert.equal(result.exitCode, 0);
  assert.deepEqual(harness.experimental_getSignals(), [
    {
      signal: "activity",
      payload: { runId: "status", text: "First step", progress: { current: 1, total: 2 } },
    },
    { signal: "activity", payload: { runId: "status", text: "Second step", progress: null } },
  ]);
  assert.deepEqual(readdirSync(tempDir), []);
  await harness.experimental_dispose();
});

test("a status check returns its exit, its last line or why it could not start, and is killed at its timeout", async () => {
  const harness = harnessFor();

  const write = (line: string, code: number) =>
    `require("node:fs").writeFileSync(process.env.OMNYO_ACTION_STATUS, ${JSON.stringify(line)} + "\\n"); process.exit(${code})`;

  assert.deepEqual(
    await harness.experimental_call("check", {
      cwd: "/private/tmp",
      argv: [process.execPath, "-e", write("Older build running", 2)],
      timeoutMs: 5000,
    }),
    {
      exitCode: 2,
      signal: null,
      activity: { text: "Older build running", progress: null },
      startError: null,
    },
  );
  assert.deepEqual(
    await harness.experimental_call("check", {
      cwd: "/private/tmp",
      argv: [process.execPath, "-e", "process.exit(1)"],
      timeoutMs: 5000,
    }),
    { exitCode: 1, signal: null, activity: null, startError: null },
  );

  const slow = await harness.experimental_call("check", {
    cwd: "/private/tmp",
    argv: [process.execPath, "-e", "setInterval(()=>{},1000)"],
    timeoutMs: 300,
  });

  assert.equal(slow.signal, "SIGKILL");
  assert.equal(
    (
      await harness.experimental_call("check", {
        cwd: "/private/tmp",
        argv: ["/nonexistent-project-actions"],
        timeoutMs: 5000,
      })
    ).startError,
    "ENOENT",
    "A check that cannot start answers with why, not as an unreachable machine.",
  );
  assert.deepEqual(
    readdirSync(tempDir).filter((name) => name.startsWith("activity-")),
    [],
    "Each check removes its status file.",
  );
  await harness.experimental_dispose();
});
