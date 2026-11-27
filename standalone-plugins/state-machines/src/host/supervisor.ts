import { spawn, type ChildProcess } from "node:child_process";
import { openSync, writeSync, closeSync } from "node:fs";
import { join } from "node:path";
import { atomicWrite, readSpec } from "./journal.js";
import type { CommandReceipt } from "../contracts/host.js";

export async function runSupervisor(directory: string): Promise<void> {
  const spec = await readSpec(directory);
  const output = openSync(join(directory, "output.log"), "a", 0o600);
  let child: ChildProcess | undefined;
  let stopping = false;
  let done = false;
  let bytes = 0;
  let reason: CommandReceipt["status"] | null = null;
  let reasonDetail: string | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let finalKill: ReturnType<typeof setTimeout> | undefined;

  const base: CommandReceipt = {
    attemptId: spec.attemptId,
    specHash: spec.specHash,
    status: "running",
    pid: process.pid,
    startedAt: Date.now(),
    finishedAt: null,
    exitCode: null,
    reason: null,
    quiescent: false,
    bytes: 0,
  };

  async function save(
    status: CommandReceipt["status"],
    exitCode: number | null,
    detail: string | null,
  ) {
    await atomicWrite(
      join(directory, "receipt.json"),
      JSON.stringify({ ...base, status, exitCode, reason: detail, finishedAt: Date.now(), bytes }),
    );
  }

  async function stop(status: CommandReceipt["status"], detail: string) {
    if (stopping || done) return;
    stopping = true;
    reason = status;
    reasonDetail = detail;
    clearTimeout(timer);
    await save(status, child?.exitCode ?? null, detail);
    finalKill = setTimeout(() => process.kill(-process.pid, "SIGKILL"), 1000);
    process.kill(-process.pid, "SIGTERM");
  }

  process.on("SIGTERM", () => {
    if (!stopping) void stop("cancelled", "Command cancelled");
  });
  process.on("disconnect", () => {
    void stop("cancelled", "Host worker disconnected");
  });
  process.on("message", (value) => {
    if (value === "cancel") void stop("cancelled", "Command cancelled");
  });
  await atomicWrite(join(directory, "receipt.json"), JSON.stringify(base));
  const program = spec.argv[0];

  if (!program) throw new Error("Missing executable");
  child = spawn(program, spec.argv.slice(1), {
    cwd: spec.cwd,
    shell: false,
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      LANG: process.env.LANG,
      TMPDIR: process.env.TMPDIR,
    },
  });
  timer = setTimeout(
    () => {
      void stop("timed-out", "Command deadline exceeded");
    },
    Math.max(1, spec.deadlineAt - Date.now()),
  );

  function accept(chunk: Buffer) {
    const available = Math.max(0, spec.outputBytes - bytes);
    const portion = chunk.subarray(0, available);

    if (portion.length) writeSync(output, portion);
    bytes += portion.length;

    if (chunk.length > available) void stop("failed", "OUTPUT_LIMIT");
  }

  child.stdout?.on("data", accept);
  child.stderr?.on("data", accept);
  child.once("error", () => {
    void stop("failed", "Unable to start executable");
  });
  child.once("close", (code) => {
    if (done) return;
    done = true;
    clearTimeout(timer);
    void save(reason ?? (code === 0 ? "succeeded" : "failed"), code, reasonDetail).then(() => {
      closeSync(output);
      process.kill(-process.pid, "SIGTERM");
      clearTimeout(finalKill);
      setTimeout(() => process.kill(-process.pid, "SIGKILL"), 100);
    });
  });
}
