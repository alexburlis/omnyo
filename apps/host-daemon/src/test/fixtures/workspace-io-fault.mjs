import fs from "node:fs";
import promises from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";

const root = process.env.WORKSPACE_IO_FAULT_ROOT;

const fifo = process.env.WORKSPACE_IO_FAULT_FIFO;

const marker = process.env.WORKSPACE_IO_FAULT_MARKER;

const armed = process.env.WORKSPACE_IO_FAULT_ARMED;

if (root && fifo && marker && armed) {
  const access = promises.access;
  const realpath = promises.realpath;
  const stat = promises.stat;
  const open = promises.open;
  const roots = [root, `${root}-1`, `${root}-2`, `${root}-3`];

  const targets = new Set([
    ...roots,
    ...roots.map((target) => `${target}/fixture-output.txt`),
  ]);

  const pending = new Map();
  const requiredWorkers = Number(process.env.UV_THREADPOOL_SIZE ?? "1");

  const block = (target, operation) => {
    const key = String(target);

    if (!targets.has(key) || !fs.existsSync(armed)) return undefined;

    if (!pending.has(key)) {
      pending.set(
        key,
        open(fifo, "r").then(async (handle) => {
          await handle.close();
          fs.writeFileSync(`${marker}.released`, "released");
        }),
      );

      if (pending.size === requiredWorkers) {
        const stagedMarker = `${marker}.${process.pid}.tmp`;
        fs.writeFileSync(
          stagedMarker,
          JSON.stringify({
            pid: process.pid,
            operation,
            blockedCount: pending.size,
          }),
        );
        fs.renameSync(stagedMarker, marker);
      }
    }

    return pending.get(key);
  };

  promises.access = async (...args) => {
    await block(args[0], "access");

    return access(...args);
  };

  promises.realpath = async (...args) => {
    await block(args[0], "realpath");

    return realpath(...args);
  };

  promises.stat = async (...args) => {
    await block(args[0], "stat");

    return stat(...args);
  };

  syncBuiltinESMExports();
}
