import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  startWindowsHostJob,
  type WindowsHostJob,
} from "./windows-host-job.js";

const MIB = 1024 * 1024;

const FIXTURE = String.raw`
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const [dir, name, mode] = process.argv.slice(1);
fs.writeFileSync(path.join(dir, name + ".pid"), String(process.pid));
const held = [];
const child = (n, m, detached) =>
  spawn(process.execPath, ["-e", process.env.WINDOWS_HOST_JOB_FIXTURE, dir, n, m], { detached, stdio: "ignore", env: process.env }).unref();
if (mode === "root") process.stdin.once("data", () => { child("middle", "middle", false); child("detached", "leaf", true); });
if (mode === "middle") child("leaf", "leaf", false);
if (mode === "alloc") {
  const timer = setInterval(() => {
    try { held.push(Buffer.alloc(64 * 1024 * 1024, 1)); }
    catch { fs.writeFileSync(path.join(dir, name + ".failed"), String(held.length * 64)); clearInterval(timer); }
  }, 20);
}
setInterval(() => {}, 1000);
`;

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);

    return true;
  } catch {
    return false;
  }
}

async function until(
  predicate: () => boolean,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;

  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("Timed out");
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

describe.runIf(process.platform === "win32")("Windows host job", () => {
  let dir: string;
  let job: WindowsHostJob | undefined;
  const started: number[] = [];

  afterEach(async () => {
    job?.close();
    await job?.closed;

    for (const pid of started) {
      try {
        process.kill(pid);
      } catch {}
    }

    rmSync(dir, { recursive: true, force: true });
  });

  it("caps every descendant and kills them when the helper closes", async () => {
    dir = mkdtempSync(path.join(tmpdir(), "omnyo-host-job-test-"));
    const env = { ...process.env, WINDOWS_HOST_JOB_FIXTURE: FIXTURE };

    const pidOf = (name: string): number =>
      Number(readFileSync(path.join(dir, `${name}.pid`), "utf8"));

    job = await startWindowsHostJob({ memoryLimitBytes: 512 * MIB });

    const outside = spawn(
      process.execPath,
      ["-e", FIXTURE, dir, "outside", "leaf"],
      {
        env,
        stdio: "ignore",
      },
    );

    const root = spawn(process.execPath, ["-e", FIXTURE, dir, "root", "root"], {
      env,
      stdio: ["pipe", "ignore", "ignore"],
    });

    const alloc = spawn(
      process.execPath,
      ["-e", FIXTURE, dir, "alloc", "alloc"],
      {
        env,
        stdio: ["pipe", "ignore", "ignore"],
      },
    );

    started.push(outside.pid ?? 0, root.pid ?? 0, alloc.pid ?? 0);
    await job.adopt(root.pid ?? 0);
    await job.adopt(alloc.pid ?? 0);
    root.stdin.write("go\n");

    const names = ["root", "middle", "detached", "leaf", "outside"];

    await until(
      () => names.every((name) => existsSync(path.join(dir, `${name}.pid`))),
      10_000,
    );
    started.push(...names.map(pidOf));

    const status = await job.status();
    const owned = ["root", "middle", "detached", "leaf"].map(pidOf);

    expect(owned.filter((pid) => !status.pids.includes(pid))).toEqual([]);
    expect(status.pids).not.toContain(pidOf("outside"));

    await until(() => existsSync(path.join(dir, "alloc.failed")), 20_000);
    expect(
      Number(readFileSync(path.join(dir, "alloc.failed"), "utf8")),
    ).toBeLessThan(512);

    job.close();
    await job.closed;
    job = undefined;
    await until(
      () => [...owned, alloc.pid ?? 0].every((pid) => !alive(pid)),
      5_000,
    );
    expect(alive(pidOf("outside"))).toBe(true);
  });
});
