import { spawn } from "node:child_process";
import { lstat } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));

const args = process.argv.slice(2);

if (args[0] === "--") args.shift();

if (
  !args.length ||
  args.some(
    (value) =>
      !/^tests\/[A-Za-z0-9_./-]+\.test\.tsx?$/.test(value) || value.split("/").includes(".."),
  )
)
  throw new Error("Select explicit package test files under tests/.");

for (const value of args)
  if (!(await lstat(resolve(root, value))).isFile())
    throw new Error("The selected test is not a file.");

const child = spawn(
  process.execPath,
  [resolve(root, "node_modules/vitest/vitest.mjs"), "run", ...args],
  { cwd: root, stdio: "inherit", detached: true },
);

let escalation;

const deadline = setTimeout(() => {
  if (child.pid) process.kill(-child.pid, "SIGTERM");
  escalation = setTimeout(() => {
    if (child.pid) {
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {}
    }
  }, 500);
}, 13500);

child.on("error", (error) => {
  clearTimeout(deadline);
  clearTimeout(escalation);
  throw error;
});

child.on("exit", (code) => {
  clearTimeout(deadline);
  clearTimeout(escalation);
  process.exitCode = code ?? 1;
});
