import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { build } from "esbuild";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CommandHost } from "../src/host/commands.js";
import type { CommandReceipt, CommandSpec } from "../src/contracts/host.js";

let directory: string;

let host: CommandHost;

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "state-machines-host-"));
  const runtime = join(directory, "host.mjs");
  await build({
    entryPoints: [resolve("host.ts")],
    outfile: runtime,
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node22",
    logLevel: "silent",
  });
  host = new CommandHost(directory, runtime);
});

afterAll(async () => {
  await host.dispose();
  await rm(directory, { recursive: true });
  await expect(stat(directory)).rejects.toMatchObject({ code: "ENOENT" });
});

function spec(source: string, timeout = 10000): CommandSpec {
  return {
    attemptId: `try_${randomUUID()}`,
    specHash: "a".repeat(64),
    rootPath: directory,
    cwd: ".",
    argv: [process.execPath, "-e", source],
    deadlineAt: Date.now() + timeout,
    outputBytes: 1024,
  };
}

async function terminal(input: CommandSpec, runner = host): Promise<CommandReceipt> {
  const until = Date.now() + 12000;

  while (Date.now() < until) {
    const receipt = await runner.inspect(input.attemptId, input.specHash);

    if (receipt?.quiescent || receipt?.status === "uncertain") return receipt;
    await delay(30);
  }

  throw new Error("Supervisor did not settle within 12 seconds");
}

async function running(input: CommandSpec, runner = host): Promise<void> {
  const until = Date.now() + 3000;

  while (Date.now() < until) {
    const receipt = await runner.inspect(input.attemptId, input.specHash);

    if (receipt?.status === "running") return;

    if (receipt?.quiescent)
      throw new Error("The command settled before running readiness was observed");
    await delay(20);
  }

  throw new Error("Supervisor did not report running within 3 seconds");
}

describe("finite host invocation ownership", () => {
  it("runs literal argv once, returns the durable receipt and rejects conflicting resubmission", async () => {
    const marker = join(directory, "effects");

    const input = spec(
      `require('node:fs').appendFileSync(${JSON.stringify(marker)},'x');console.log('literal $(nothing)');`,
    );

    await host.submit(input);
    const result = await terminal(input);
    expect(result).toMatchObject({ status: "succeeded", quiescent: true, exitCode: 0 });
    await host.submit(input);
    expect(await host.submit({ ...input, deadlineAt: Date.now() - 1 })).toMatchObject({
      attemptId: input.attemptId,
      status: "succeeded",
      quiescent: true,
    });
    expect(await readFile(marker, "utf8")).toBe("x");
    expect((await host.log(input.attemptId, 0, 1024)).text).toContain("literal $(nothing)");
    await expect(host.submit({ ...input, specHash: "b".repeat(64) })).rejects.toThrow(
      "REVISION_CONFLICT",
    );
  });

  it("terminates its child process group on deadline without killing an unrelated sentinel", async () => {
    const sentinel = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], {
      stdio: "ignore",
    });

    const input = spec(
      "require('node:child_process').spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'inherit'});setInterval(()=>{},1000)",
      500,
    );

    try {
      await host.submit(input);
      expect(await terminal(input)).toMatchObject({ status: "timed-out", quiescent: true });
      expect(sentinel.exitCode).toBeNull();
      expect(sentinel.signalCode).toBeNull();
    } finally {
      const ended = new Promise<void>((done) => sentinel.once("exit", () => done()));
      sentinel.kill();
      await ended;
    }
  });

  it("cancels exact work and reports output overflow without unbounded logs", async () => {
    const cancel = spec("setInterval(()=>{},1000)");
    await host.submit(cancel);
    await running(cancel);
    await host.cancel(cancel.attemptId, cancel.specHash);
    expect(await terminal(cancel)).toMatchObject({ status: "cancelled", quiescent: true });
    const overflow = spec("process.stdout.write('x'.repeat(100000));setInterval(()=>{},1000)");
    await host.submit(overflow);
    expect(await terminal(overflow)).toMatchObject({
      status: "failed",
      reason: "OUTPUT_LIMIT",
      quiescent: true,
    });
    expect((await host.log(overflow.attemptId, 0, 32768)).text.length).toBeLessThanOrEqual(1024);
  });

  it("refuses escaped cwd and preserves interrupted ownership as uncertain", async () => {
    await expect(host.submit({ ...spec(""), cwd: ".." })).rejects.toThrow("SCOPE_MISMATCH");
    const input = spec("setInterval(()=>{},1000)");
    await host.submit(input);
    await delay(150);
    const reopened = new CommandHost(directory, join(directory, "host.mjs"));
    expect(await reopened.inspect(input.attemptId, input.specHash)).toMatchObject({
      status: "uncertain",
      quiescent: false,
    });
    await host.cancel(input.attemptId, input.specHash);
    await terminal(input);
    await writeFile(join(directory, "closed-proof.json"), JSON.stringify({ closed: true }));
  });

  it("accounts settled journal bytes instead of retaining theoretical output reservations", async () => {
    const dataDir = join(directory, `actual-${randomUUID()}`);

    const runner = new CommandHost(dataDir, join(directory, "host.mjs"), () => {}, {
      storageLimitBytes: 40_000,
    });

    const completed: CommandSpec[] = [];

    try {
      for (let index = 0; index < 3; index++) {
        const input = spec("console.log('small retained output')");
        await runner.submit(input);
        expect(await terminal(input, runner)).toMatchObject({
          status: "succeeded",
          quiescent: true,
        });
        completed.push(input);
      }

      const reopened = new CommandHost(dataDir, join(directory, "host.mjs"), () => {}, {
        storageLimitBytes: 40_000,
      });

      try {
        const next = spec("console.log('after reopen')");
        await reopened.submit(next);
        expect(await terminal(next, reopened)).toMatchObject({ quiescent: true });
        await reopened.acknowledge(next.attemptId, next.specHash);

        for (const input of completed) {
          await reopened.acknowledge(input.attemptId, input.specHash);
          await expect(stat(join(dataDir, "invocations", input.attemptId))).rejects.toMatchObject({
            code: "ENOENT",
          });
          expect(await reopened.log(input.attemptId, 0, 1024)).toEqual({
            text: "",
            nextCursor: 0,
            truncated: false,
          });
        }
      } finally {
        await reopened.dispose();
      }
    } finally {
      await runner.dispose();
    }
  });

  it("serializes admission before mkdir and leaves rejected attempts safe to resubmit", async () => {
    const dataDir = join(directory, `admission-${randomUUID()}`);

    const runner = new CommandHost(dataDir, join(directory, "host.mjs"), () => {}, {
      storageLimitBytes: 40_000,
    });

    const first = spec("setInterval(()=>{},1000)");
    const second = spec("console.log('admitted after cleanup')");

    try {
      const submissions = await Promise.allSettled([runner.submit(first), runner.submit(second)]);
      expect(submissions[0]?.status).toBe("fulfilled");
      expect(submissions[1]).toMatchObject({ status: "rejected", reason: expect.any(Error) });
      expect(submissions[1]?.status === "rejected" && submissions[1].reason.message).toContain(
        "BACKPRESSURE",
      );
      await expect(stat(join(dataDir, "invocations", second.attemptId))).rejects.toMatchObject({
        code: "ENOENT",
      });
      expect(await runner.submit(first)).toMatchObject({ attemptId: first.attemptId });

      const reopened = new CommandHost(dataDir, join(directory, "host.mjs"), () => {}, {
        storageLimitBytes: 40_000,
      });

      await expect(reopened.submit(second)).rejects.toThrow("BACKPRESSURE");
      await expect(reopened.acknowledge(first.attemptId, first.specHash)).rejects.toThrow(
        "STOP_PENDING",
      );
      await reopened.dispose();

      await runner.cancel(first.attemptId, first.specHash);
      expect(await terminal(first, runner)).toMatchObject({ quiescent: true });
      await runner.acknowledge(first.attemptId, first.specHash);
      await runner.submit(second);
      expect(await terminal(second, runner)).toMatchObject({
        status: "succeeded",
        quiescent: true,
      });
      await runner.acknowledge(second.attemptId, second.specHash);
    } finally {
      await runner.dispose();
    }
  });

  it("bounds retained output and reclaims capacity only after exact acknowledgement", async () => {
    const dataDir = join(directory, `retained-${randomUUID()}`);

    const runner = new CommandHost(dataDir, join(directory, "host.mjs"), () => {}, {
      storageLimitBytes: 40_000,
    });

    const completed: CommandSpec[] = [];
    let rejected: CommandSpec | null = null;

    try {
      for (let index = 0; index < 8; index++) {
        const input = spec("process.stdout.write('x'.repeat(1000))");

        try {
          await runner.submit(input);
        } catch (error) {
          expect(error).toBeInstanceOf(Error);
          expect(error instanceof Error && error.message).toContain("BACKPRESSURE");
          rejected = input;
          break;
        }

        expect(await terminal(input, runner)).toMatchObject({
          status: "succeeded",
          quiescent: true,
        });
        completed.push(input);
      }

      if (!rejected)
        throw new Error("Retained output did not reach the configured bounded capacity");
      expect(completed.length).toBeGreaterThan(1);
      const oldest = completed[0]!;

      const reopened = new CommandHost(dataDir, join(directory, "host.mjs"), () => {}, {
        storageLimitBytes: 40_000,
      });

      try {
        await expect(reopened.submit(rejected)).rejects.toThrow("BACKPRESSURE");
        await expect(reopened.acknowledge(oldest.attemptId, "b".repeat(64))).rejects.toThrow(
          "REVISION_CONFLICT",
        );
        await expect(reopened.submit(rejected)).rejects.toThrow("BACKPRESSURE");
        await reopened.acknowledge(oldest.attemptId, oldest.specHash);
        await reopened.submit(rejected);
        expect(await terminal(rejected, reopened)).toMatchObject({
          status: "succeeded",
          quiescent: true,
        });
      } finally {
        await reopened.dispose();
      }
    } finally {
      await runner.dispose();
    }
  });

  it("retires only the exact quiescent attempt and never deletes live work after reopening", async () => {
    const input = spec("console.log('owned output');setInterval(()=>{},1000)");
    await host.submit(input);

    try {
      await expect(host.acknowledge(input.attemptId, "b".repeat(64))).rejects.toThrow(
        "REVISION_CONFLICT",
      );
      await expect(host.acknowledge(input.attemptId, input.specHash)).rejects.toThrow(
        "STOP_PENDING",
      );
      const reopened = new CommandHost(directory, join(directory, "host.mjs"));
      await expect(reopened.acknowledge(input.attemptId, input.specHash)).rejects.toThrow(
        "STOP_PENDING",
      );
      expect(
        await readFile(join(directory, "invocations", input.attemptId, "spec.json"), "utf8"),
      ).toContain(input.specHash);
      await reopened.dispose();
    } finally {
      await host.cancel(input.attemptId, input.specHash);
      await terminal(input);
    }

    await expect(host.acknowledge(input.attemptId, "b".repeat(64))).rejects.toThrow(
      "REVISION_CONFLICT",
    );
    expect(await host.acknowledge(input.attemptId, input.specHash)).toEqual({ acknowledged: true });
    expect(await host.inspect(input.attemptId, input.specHash)).toBeNull();
    expect(await host.log(input.attemptId, 0, 1024)).toEqual({
      text: "",
      nextCursor: 0,
      truncated: false,
    });
    await expect(stat(join(directory, "invocations", input.attemptId))).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect(await host.acknowledge(input.attemptId, input.specHash)).toEqual({ acknowledged: true });
  });

  it("preserves ambiguous incomplete journals instead of acknowledging or replaying them", async () => {
    const dataDir = join(directory, `incomplete-${randomUUID()}`);
    const input = spec("");
    const journal = join(dataDir, "invocations", input.attemptId);
    await mkdir(journal, { recursive: true });
    const runner = new CommandHost(dataDir, join(directory, "host.mjs"));

    try {
      await expect(runner.acknowledge(input.attemptId, input.specHash)).rejects.toThrow(
        "INVOCATION_UNCERTAIN",
      );
      await expect(runner.submit(input)).rejects.toThrow("INVOCATION_UNCERTAIN");
      const unrelated = spec("");
      await expect(runner.submit(unrelated)).rejects.toThrow("INVOCATION_UNCERTAIN");
      expect((await stat(journal)).isDirectory()).toBe(true);
      await expect(stat(join(dataDir, "invocations", unrelated.attemptId))).rejects.toMatchObject({
        code: "ENOENT",
      });
    } finally {
      await runner.dispose();
    }
  });
});
