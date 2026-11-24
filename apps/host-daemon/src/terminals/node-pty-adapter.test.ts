import { execFile } from "node:child_process";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it, vi } from "vitest";
import { nodePtyAdapter } from "./terminal-manager.js";

const execFileAsync = promisify(execFile);

const probePath = fileURLToPath(
  new URL("./node-pty-windows-lifecycle.probe.ts", import.meta.url),
);

describe.runIf(process.platform === "win32")(
  "Windows native PTY resource ownership",
  () => {
    it.each(["natural", "close", "force", "before-ready"])(
      "survives %s cleanup in a real child process",
      async (mode) => {
        const result = await execFileAsync(
          process.execPath,
          ["--conditions=source", "--import=tsx", probePath, mode],
          { timeout: 30_000 },
        );

        expect(result.stderr).toBe("");
        expect(JSON.parse(result.stdout)).toEqual({
          mode,
          cycles: 5,
          completed: true,
        });
      },
      35_000,
    );
  },
);

describe.runIf(process.platform !== "win32")("shell foreground", () => {
  it("reports a running command and the idle prompt after Ctrl+C", async () => {
    const pty = nodePtyAdapter.spawn({
      args: ["-i"],
      cols: 80,
      cwd: os.tmpdir(),
      env: { PATH: process.env.PATH, PS1: "$ ", TERM: "xterm-256color" },
      file: "/bin/sh",
      logger: { debug: vi.fn(), error: vi.fn(), info: vi.fn(), warn: vi.fn() },
      rows: 24,
    });

    try {
      await expect.poll(() => pty.foreground()).toEqual({ state: "idle" });

      pty.write("sleep 30\r");
      await expect
        .poll(() => pty.foreground())
        .toEqual({ state: "busy", command: "sleep 30" });

      pty.write("\u0003");
      await expect.poll(() => pty.foreground()).toEqual({ state: "idle" });
    } finally {
      pty.kill("SIGKILL");
      pty.dispose();
    }
  });
});
