import { execFileSync, fork } from "node:child_process";
import { constants, closeSync, openSync } from "node:fs";
import fs from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { prepareWorkspaceIoFixture } from "./test/fixtures/prepare-workspace-io-fixture.mjs";

function trace(phase: string): void {
  process.stderr.write(`[workspace-io] ${Date.now()} ${phase}\n`);
}

trace(
  `module-loaded node=${process.version} tmp=${tmpdir()} uv=${process.env.UV_THREADPOOL_SIZE ?? "default"}`,
);

const messageSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("fault-active") }),
  z.object({
    kind: z.literal("passed"),
    first: z.string(),
    followUp: z.string(),
  }),
  z.object({ kind: z.literal("failed"), message: z.string() }),
  z.object({ kind: z.literal("release-required") }),
  z.object({ kind: z.literal("cas-preserved") }),
  z.object({ kind: z.literal("mutation-disposed") }),
  z.object({ kind: z.literal("writes-drained") }),
  z.object({ kind: z.literal("successor-fenced") }),
  z.object({ kind: z.literal("successor-recovered") }),
]);

describe.skipIf(process.platform === "win32")("workspace I/O isolation", () => {
  let packet: { directory: string; entry: string } | undefined;

  beforeAll(async () => {
    const directory = await fs.mkdtemp(
      path.join(tmpdir(), "omnyo-workspace-io-packet-"),
    );

    try {
      trace("packet-build-start");
      packet = { directory, entry: await prepareWorkspaceIoFixture(directory) };
      trace("packet-build-complete");
    } catch (error) {
      await fs.rm(directory, { recursive: true, force: true });
      throw error;
    }
  });

  afterAll(async () => {
    if (packet) {
      await fs.rm(packet.directory, { recursive: true, force: true });
      trace("packet-removed");
    }
  });

  it.each(["watch", "paths-exist", "write-file"])(
    "starts a chat and completes its follow-up while an external %s syscall is blocked",
    async (scenario) => {
      const compiled = packet;

      if (!compiled)
        throw new Error("Native isolation fixture packet was not prepared");
      const base = await fs.mkdtemp(path.join(tmpdir(), "omnyo-workspace-io-"));

      try {
        trace(`${scenario} case-start`);
        const fifo = path.join(base, "external-open.fifo");
        execFileSync("mkfifo", [fifo]);
        const marker = path.join(base, "fault-entered.json");

        const faultPreloader = new URL(
          "./test/fixtures/workspace-io-fault.mjs",
          import.meta.url,
        ).href;

        const child = fork(
          compiled.entry,
          [
            path.join(compiled.directory, "scripted-echo-provider.mjs"),
            scenario,
          ],
          {
            execArgv: [],
            detached: true,
            env: {
              ...process.env,
              NODE_OPTIONS:
                `${process.env.NODE_OPTIONS ?? ""} --import=${faultPreloader}`.trim(),
              NODE_PATH: "",
              UV_THREADPOOL_SIZE: scenario === "watch" ? "1" : "4",
              WORKSPACE_IO_FAULT_ROOT: path.join(base, "external"),
              WORKSPACE_IO_FAULT_FIFO: fifo,
              WORKSPACE_IO_FAULT_MARKER: marker,
              WORKSPACE_IO_FAULT_ARMED: path.join(base, "armed"),
            },
            stdio: ["ignore", "pipe", "pipe", "ipc"],
          },
        );

        trace(`${scenario} fork pid=${child.pid}`);
        let output = "";
        let faultActive = false;
        let casPreserved = false;
        let mutationDisposed = false;
        let writesDrained = false;
        let successorFenced = false;
        let successorRecovered = false;
        let passed: { first: string; followUp: string } | undefined;
        let failure: string | undefined;
        let released = false;
        let writer: number | undefined;

        const capture = (data: Buffer) => {
          output = (output + data.toString()).slice(-8_000);
        };

        child.stdout?.on("data", capture);
        child.stderr?.on("data", capture);
        child.on("exit", (code, signal) => {
          trace(`${scenario} exit code=${code} signal=${signal}`);
        });

        const closed = new Promise<void>((resolve) =>
          child.once("close", resolve),
        );

        const release = () => {
          if (released) return;
          released = true;
          writer = openSync(fifo, constants.O_RDWR | constants.O_NONBLOCK);

          if (child.connected)
            child.send({ kind: "released" }, () => undefined);
        };

        const stopOwnedGroup = () => {
          if (child.pid === undefined) return;

          try {
            process.kill(-child.pid, "SIGKILL");
          } catch (error) {
            if (
              !(
                error instanceof Error &&
                "code" in error &&
                error.code === "ESRCH"
              )
            ) {
              throw error;
            }
          }
        };

        child.on("message", (value: unknown) => {
          const parsed = messageSchema.safeParse(value);

          if (!parsed.success) return;
          const message = parsed.data;
          trace(`${scenario} ${message.kind}`);

          switch (message.kind) {
            case "fault-active":
              faultActive = true;
              break;
            case "passed":
              passed = message;
              break;
            case "failed":
              failure = message.message;
              break;
            case "release-required":
              release();
              break;
            case "cas-preserved":
              casPreserved = true;
              break;
            case "mutation-disposed":
              mutationDisposed = true;
              break;
            case "writes-drained":
              writesDrained = true;
              break;
            case "successor-fenced":
              successorFenced = true;
              break;
            case "successor-recovered":
              successorRecovered = true;
          }
        });

        const timeout = setTimeout(() => {
          failure ??=
            "The isolated daemon fixture exceeded its 10-second bound";
          release();
          stopOwnedGroup();
        }, 10_000);

        try {
          await closed;
          expect(failure, output).toBeUndefined();
          expect(child.exitCode, output).toBe(0);
          expect(faultActive).toBe(true);
          expect(passed?.first).toContain("internal-start");
          expect(passed?.followUp).toContain("internal-follow-up");

          if (scenario === "write-file") {
            expect(casPreserved).toBe(true);
            expect(mutationDisposed).toBe(true);
            expect(writesDrained).toBe(true);
            expect(successorFenced).toBe(true);
            expect(successorRecovered).toBe(true);
          }
        } finally {
          clearTimeout(timeout);

          if (child.exitCode === null && child.signalCode === null) {
            release();
            stopOwnedGroup();
            await closed;
          }

          stopOwnedGroup();

          if (writer !== undefined) closeSync(writer);
        }
      } finally {
        await fs.rm(base, { recursive: true, force: true });
        trace(`${scenario} base-removed`);
      }
    },
  );
});
