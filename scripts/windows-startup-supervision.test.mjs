import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { createServer } from "node:net";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";

const installer = fileURLToPath(
  new URL(
    "../apps/server/src/assets/install-machine-windows.mjs",
    import.meta.url,
  ),
);

async function availablePort() {
  const server = createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  await new Promise((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );

  return address.port;
}

for (const adopted of [false, true]) {
  for (const exitCode of [0, 23]) {
    test(
      `Windows task owner ${adopted ? "adopts" : "starts"} its launcher and preserves exit ${exitCode}`,
      { skip: process.platform !== "win32", timeout: 15_000 },
      async () => {
        const root = await mkdtemp(join(tmpdir(), "omnyo-startup-contract-"));
        let child;
        let existing;

        try {
          const prefix = join(root, "npm");
          const dist = join(prefix, "node_modules", "omnyo-app", "dist");
          await mkdir(dist, { recursive: true });
          const port = await availablePort();
          await writeFile(
            join(root, "machine-service.json"),
            JSON.stringify({
              hostId: "host_startup_fixture",
              serverUrl: "https://omnyo.example.invalid",
              npmPrefix: prefix,
              hostDaemonPort: port,
            }),
          );
          const ready = join(root, "ready");
          await writeFile(
            join(dist, "omnyo-app.js"),
            `require('node:fs').appendFileSync(${JSON.stringify(ready)}, 'ready\\n'); setTimeout(() => process.exit(${exitCode}), ${adopted ? 5000 : 1200});`,
          );

          if (adopted) {
            existing = spawn(
              process.execPath,
              [
                join(dist, "omnyo-app.js"),
                "host-daemon",
                "--host-daemon-port",
                String(port),
              ],
              { stdio: "ignore", windowsHide: true },
            );
            assert.ok(existing.pid);
            await writeFile(
              join(root, "install-daemon.pid"),
              `${existing.pid}\n`,
            );
            const deadline = Date.now() + 2000;

            while (
              !(await readFile(ready, "utf8").catch(() => "")) &&
              Date.now() < deadline
            )
              await delay(20);
            assert.equal(await readFile(ready, "utf8"), "ready\n");
          }

          const started = Date.now();
          child = spawn(
            process.execPath,
            [
              installer,
              "--run",
              "--host-id",
              "host_startup_fixture",
              "--data-dir",
              root,
            ],
            { stdio: "pipe", windowsHide: true },
          );
          let diagnostics = "";
          child.stderr.on("data", (chunk) => {
            diagnostics += chunk.toString();
          });

          const result = await new Promise((resolve, reject) => {
            child.once("error", reject);
            child.once("exit", (code) => resolve(code));
          });

          assert.equal(result, exitCode, diagnostics);
          assert.ok(
            Date.now() - started >= 1100,
            "Task owner exited while its launcher was still alive",
          );
          assert.equal(
            await readFile(ready, "utf8"),
            "ready\n",
            "A second launcher was started during adoption",
          );
        } finally {
          if (child?.exitCode === null) child.kill();

          if (existing?.exitCode === null) existing.kill();

          const pidText = await readFile(
            join(root, "install-daemon.pid"),
            "utf8",
          ).catch(() => "");

          const launcherPid = Number(pidText.trim());

          if (Number.isInteger(launcherPid) && launcherPid > 1) {
            const deadline = Date.now() + 5_000;

            while (Date.now() < deadline) {
              try {
                process.kill(launcherPid, 0);
              } catch {
                break;
              }

              await delay(50);
            }
          }

          await rm(root, { recursive: true, force: true });
        }
      },
    );
  }
}
