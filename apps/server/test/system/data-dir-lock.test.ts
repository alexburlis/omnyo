import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadServerConfig } from "@omnyo/config/server";
import { expect, it, onTestFinished } from "vitest";
import { runServer } from "../../src/start-server.js";
import {
  ServerDataDirInUseError,
  lockServerDataDir,
} from "../../src/services/system/data-dir-lock.js";

async function fixture() {
  const dataDir = await mkdtemp(join(tmpdir(), "omnyo-server-data-dir-lock-"));
  onTestFinished(() => rm(dataDir, { recursive: true, force: true }));

  return dataDir;
}

it("refuses another server until the directory is released and allows independent profiles", async () => {
  const dataDir = await fixture();
  const otherDataDir = await fixture();
  const releaseFirst = await lockServerDataDir({ dataDir, timeoutMs: 100 });
  onTestFinished(releaseFirst);

  const releaseOther = await lockServerDataDir({
    dataDir: otherDataDir,
    timeoutMs: 100,
  });

  onTestFinished(releaseOther);
  await expect(
    lockServerDataDir({ dataDir, timeoutMs: 100 }),
  ).rejects.toBeInstanceOf(ServerDataDirInUseError);
  await Promise.all([releaseFirst(), releaseFirst()]);
  const releaseSecond = await lockServerDataDir({ dataDir, timeoutMs: 100 });
  await releaseSecond();
});

it("releases the directory when startup fails before database work", async () => {
  const dataDir = await fixture();

  const config = loadServerConfig({
    env: {
      NODE_ENV: "test",
      OMNYO_DATA_DIR: dataDir,
      OMNYO_SERVER_PORT: "49161",
      OMNYO_HOST_DAEMON_PORT: "49162",
    },
    homeDir: dataDir,
  });

  config.OMNYO_SERVER_STARTUP_HOLD = {
    id: "test",
    ownerId: "test",
    expectedServerHostId: "absent-host",
    expectedDataDir: dataDir,
  };
  await expect(runServer(config)).rejects.toThrow(
    "Startup maintenance ownership does not match this server",
  );
  const release = await lockServerDataDir({ dataDir, timeoutMs: 100 });
  await release();
});

it("releases the directory when startup fails after opening the database", async () => {
  const dataDir = await fixture();
  await writeFile(join(dataDir, "server-import.json"), "{invalid");

  const config = loadServerConfig({
    env: {
      NODE_ENV: "test",
      OMNYO_DATA_DIR: dataDir,
      OMNYO_SERVER_PORT: "49161",
      OMNYO_HOST_DAEMON_PORT: "49162",
    },
    homeDir: dataDir,
  });

  await expect(runServer(config)).rejects.toThrow();
  expect((await stat(config.databasePath)).isFile()).toBe(true);
  const release = await lockServerDataDir({ dataDir, timeoutMs: 100 });
  await release();
});

it("holds a real server's directory through startup and releases it on graceful shutdown", async () => {
  const dataDir = await fixture();
  await writeFile(join(dataDir, "host-id"), "host-lock-test");
  const moduleUrl = new URL("../../src/start-server.ts", import.meta.url).href;

  const child = spawn(
    process.execPath,
    [
      "--conditions=source",
      "--import",
      "tsx",
      "-e",
      `
    void (async () => {
    const { runServer } = await import(${JSON.stringify(moduleUrl)});
    const { loadServerConfig } = await import("@omnyo/config/server");
    const config = loadServerConfig();
    config.OMNYO_SERVER_PORT = 0;
    config.OMNYO_SERVER_STARTUP_HOLD = { id: "lock-test", ownerId: "lock-test", expectedServerHostId: "host-lock-test", expectedDataDir: config.OMNYO_DATA_DIR };
    await runServer(config);
    process.send("started");
    })().catch((error) => { process.stderr.write(String(error)); process.exitCode = 1; });
  `,
    ],
    {
      cwd: new URL("../..", import.meta.url),
      env: {
        NODE_ENV: "test",
        OMNYO_DATA_DIR: dataDir,
        OMNYO_SERVER_PORT: "49161",
        OMNYO_HOST_DAEMON_PORT: "49162",
        OMNYO_VAULT_KEY_STORE: "key-file",
        OMNYO_TELEMETRY: "false",
      },
      stdio: ["ignore", "ignore", "pipe", "ipc"],
    },
  );

  let startupError = "";
  child.stderr?.on("data", (chunk: Buffer) => {
    startupError = (startupError + chunk.toString()).slice(0, 8_192);
  });

  const closed = once(child, "close");
  onTestFinished(async () => {
    child.kill("SIGKILL");
    await closed;
  });

  const ready = await Promise.race([
    once(child, "message").then(([message]) => message),
    closed.then(([code]) => {
      throw new Error(
        `Server exited before startup completed (${String(code)}): ${startupError}`,
      );
    }),
  ]);

  expect(ready).toBe("started");
  await expect(
    lockServerDataDir({ dataDir, timeoutMs: 100 }),
  ).rejects.toBeInstanceOf(ServerDataDirInUseError);
  child.kill("SIGTERM");
  expect(await closed).toEqual([0, null]);
  const release = await lockServerDataDir({ dataDir, timeoutMs: 100 });
  await release();
}, 20_000);
