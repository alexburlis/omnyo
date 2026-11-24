import os from "node:os";
import { nodePtyAdapter } from "./terminal-manager.js";

const mode = process.argv[2];

if (!["natural", "close", "force", "before-ready"].includes(mode ?? "")) {
  throw new Error("Unknown Windows PTY lifecycle mode");
}

const shell = process.env.ComSpec ?? "C:\\Windows\\System32\\cmd.exe";

const logger = { debug() {}, info() {}, warn() {}, error() {} };

for (let cycle = 0; cycle < 5; cycle += 1) {
  await new Promise<void>((resolve, reject) => {
    const terminal = nodePtyAdapter.spawn({
      file: shell,
      args: ["/d"],
      cols: 80,
      rows: 24,
      cwd: os.tmpdir(),
      env: {
        SystemRoot: process.env.SystemRoot,
        ComSpec: shell,
        PATH: process.env.PATH,
      },
      logger,
    });

    let closing = false;

    const timeout = setTimeout(() => {
      terminal.kill();
      terminal.dispose();
      reject(new Error("Timed out waiting for Windows PTY exit"));
    }, 5_000);

    terminal.onExit(() => {
      clearTimeout(timeout);
      terminal.dispose();
      resolve();
    });
    terminal.onData(() => {
      if (closing) return;
      closing = true;

      if (mode === "natural") {
        terminal.write("exit 0\r");

        return;
      }

      terminal.kill();

      if (mode === "force") terminal.kill("SIGKILL");
      terminal.dispose();
    });

    if (mode === "before-ready") {
      closing = true;
      terminal.kill();
      terminal.dispose();
    }
  });
}

await new Promise((resolve) => setTimeout(resolve, 1_500));

process.stdout.write(JSON.stringify({ mode, cycles: 5, completed: true }));
