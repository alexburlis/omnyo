import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { runtimeInfo } from "../generated/runtime-info.ts";
import { runtimeMetadata, packageArchiveBase64 } from "../generated/runtime-payload.ts";

const lock = JSON.parse(await readFile(new URL("../runtime.lock.json", import.meta.url), "utf8"));

if (
  JSON.stringify(lock) !== JSON.stringify(runtimeInfo.lock) ||
  JSON.stringify(lock) !== JSON.stringify(runtimeMetadata.lock) ||
  createHash("sha256").update(Buffer.from(packageArchiveBase64, "base64")).digest("hex") !==
    lock.packageSha256
)
  throw new Error("Runtime preparation is stale. Run runtime:prepare with the pinned archive.");

const child = spawn("omnyo", ["plugin", "build", "."], { stdio: "inherit", detached: true });

const deadline = setTimeout(() => {
  if (child.pid) process.kill(-child.pid, "SIGKILL");
}, 14000);

child.on("error", () => {
  clearTimeout(deadline);
  process.exitCode = 1;
});

child.on("exit", (code) => {
  clearTimeout(deadline);
  process.exitCode = code ?? 1;
});
