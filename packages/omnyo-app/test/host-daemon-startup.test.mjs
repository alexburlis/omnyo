import { spawn } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, expect, it } from "vitest";
import { buildNodeEsmEntry } from "../../../scripts/build-utils.mjs";

const idleMachineLoad = fileURLToPath(
  new URL("fixtures/idle-machine-load.cjs", import.meta.url),
);

let root;

let launcher;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "omnyo-daemon-startup-"));
  launcher = join(root, "dist", "omnyo-app.js");
  await writeFile(join(root, "package.json"), '{"type":"module"}');
  await buildNodeEsmEntry({
    cleanDist: false,
    entryPoint: fileURLToPath(
      new URL("../src/bin/omnyo-app.ts", import.meta.url),
    ),
    outfile: launcher,
    packageRoot: root,
    sourcemap: false,
  });
  const bundleDir = join(root, "host-daemon", "dist");
  await mkdir(join(bundleDir, "omnyo-chunks"), { recursive: true });

  for (const name of [
    "omnyo",
    "omnyo-chunks/fixture.js",
    "omnyo-provider-bridge-worker.mjs",
    "omnyo-parcel-watcher-child.mjs",
    "omnyo-plugin-host-worker.mjs",
    "omnyo-file-search-worker.mjs",
    "omnyo-process-launcher-worker.mjs",
    "omnyo-workspace-observer-child.mjs",
    "omnyo-workspace-read-child.mjs",
  ]) {
    await writeFile(join(bundleDir, name), "");
  }

  await writeFile(
    join(bundleDir, "daemon-bundle.mjs"),
    `
import { appendFileSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
const starts = join(process.env.OMNYO_DATA_DIR, "starts");
appendFileSync(starts, "started\\n");
const firstStart = readFileSync(starts, "utf8") === "started\\n";
const freeze = firstStart && process.env.TEST_FIRST_EXIT === "freeze";
const unhealthy = firstStart && process.env.TEST_FIRST_EXIT === "unhealthy";
if (freeze || unhealthy) process.on("SIGTERM", () => process.exit(0));
if (firstStart && !freeze && !unhealthy) {
  if (process.env.TEST_FIRST_EXIT === "signal") {
    process.on("SIGTERM", () => process.exit(0));
    process.kill(process.ppid, "SIGTERM");
    await new Promise(() => setInterval(() => {}, 1000));
  }
  process.exit(Number(process.env.TEST_FIRST_EXIT));
}
createServer((request, response) => {
  if (request.url === "/health") {
    if (!unhealthy) {
      response.end("ok");
      if (!firstStart) setTimeout(() => process.exit(0), 200);
    }
    return;
  }
  response.end(JSON.stringify({
    connected: true,
    hostId: process.env.OMNYO_HOST_ID,
    serverUrl: process.env.OMNYO_SERVER_URL,
  }));
  if (freeze && request.url === "/status") {
    setTimeout(() => {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
    }, 100);
  } else if (!freeze && !unhealthy) {
    setTimeout(() => process.exit(0), 200);
  }
}).listen(Number(process.env.OMNYO_HOST_DAEMON_PORT), "127.0.0.1");
`,
  );
}, 30_000);

afterAll(async () => {
  if (root) await rm(root, { recursive: true, force: true });
});

it.each([
  ["omnyo-file-search-worker.mjs", "file search worker"],
  ["omnyo-workspace-observer-child.mjs", "workspace observer child"],
  ["omnyo-workspace-read-child.mjs", "workspace read child"],
])(
  "requires %s before starting the host daemon",
  async (workerName, workerLabel) => {
    const fixture = await mkdtemp(join(root, "required-worker-"));
    await writeFile(join(fixture, "package.json"), '{"type":"module"}');

    for (const directory of ["dist", "host-daemon"])
      await cp(join(root, directory), join(fixture, directory), {
        recursive: true,
        mode: constants.COPYFILE_FICLONE,
      });
    const worker = join(fixture, "host-daemon/dist", workerName);
    await rm(worker);
    const dataDir = join(fixture, "data");
    await mkdir(dataDir);
    await writeFile(join(dataDir, "preserved.txt"), "existing workspace data");
    const listener = createServer();
    await new Promise((resolve) => listener.listen(0, "127.0.0.1", resolve));
    const port = listener.address().port;
    await new Promise((resolve) => listener.close(resolve));

    const attempt = async () => {
      const child = spawn(
        process.execPath,
        [
          join(fixture, "dist/omnyo-app.js"),
          "host-daemon",
          "--supervise",
          "--data-dir",
          dataDir,
          "--host-daemon-port",
          String(port),
          "--host-id",
          "required-worker-test",
          "--enroll-key",
          "test-enrollment",
          "--server-url",
          "https://server.example.test",
        ],
        {
          env: {
            ...Object.fromEntries(
              Object.entries(process.env).filter(
                ([key]) => !key.startsWith("OMNYO_"),
              ),
            ),
            TEST_FIRST_EXIT: "0",
          },
          stdio: ["ignore", "pipe", "pipe"],
        },
      );

      let output = "";
      child.stdout.on("data", (chunk) => {
        output += chunk;
      });
      child.stderr.on("data", (chunk) => {
        output += chunk;
      });

      const exited = new Promise((resolve, reject) => {
        child.once("error", reject);
        child.once("exit", resolve);
      });

      const timeout = setTimeout(() => child.kill("SIGTERM"), 8000);

      try {
        return { exitCode: await exited, output };
      } finally {
        clearTimeout(timeout);
        child.kill("SIGTERM");
        await exited;
      }
    };

    try {
      const missing = await attempt();
      expect(missing.exitCode, missing.output).toBe(1);
      expect(missing.output).toContain(`Missing ${workerLabel}`);
      await expect(
        readFile(join(dataDir, "starts"), "utf8"),
      ).rejects.toMatchObject({ code: "ENOENT" });
      await writeFile(worker, "");
      const present = await attempt();
      expect(present.exitCode, present.output).toBe(0);
      expect(await readFile(join(dataDir, "starts"), "utf8")).toBe("started\n");
      expect(await readFile(join(dataDir, "preserved.txt"), "utf8")).toBe(
        "existing workspace data",
      );
    } finally {
      await rm(fixture, { recursive: true, force: true });
    }
  },
);

it.concurrent.for([
  { firstExit: 75, supervise: true, restarts: true, expectedExit: 0 },
  { firstExit: 1, supervise: true, restarts: true, expectedExit: 0 },
  { firstExit: 0, supervise: true, restarts: false, expectedExit: 0 },
  { firstExit: "signal", supervise: true, restarts: false, expectedExit: 0 },
  { firstExit: "freeze", supervise: true, restarts: true, expectedExit: 0 },
  { firstExit: "unhealthy", supervise: true, restarts: true, expectedExit: 0 },
  { firstExit: "freeze", supervise: false, restarts: false, expectedExit: 1 },
])(
  "handles $firstExit with supervise=$supervise through the launcher",
  async ({ firstExit, supervise, restarts, expectedExit }, { skip }) => {
    skip(
      process.platform === "win32" && firstExit === "signal",
      "Windows cannot deliver a catchable SIGTERM to the launcher",
    );
    const dataDir = await mkdtemp(join(root, "data-"));
    await writeFile(join(dataDir, "preserved.txt"), "existing workspace data");
    const listener = createServer();
    await new Promise((resolve) => listener.listen(0, "127.0.0.1", resolve));
    const port = listener.address().port;
    await new Promise((resolve) => listener.close(resolve));

    const child = spawn(
      process.execPath,
      [
        "--require",
        idleMachineLoad,
        launcher,
        "host-daemon",
        ...(supervise ? ["--supervise"] : []),
        "--data-dir",
        dataDir,
        "--host-daemon-port",
        String(port),
        "--host-id",
        "startup-test",
        "--enroll-key",
        "test-enrollment",
        "--server-url",
        "https://server.example.test",
      ],
      {
        env: {
          ...Object.fromEntries(
            Object.entries(process.env).filter(
              ([key]) => !key.startsWith("OMNYO_"),
            ),
          ),
          TEST_FIRST_EXIT: String(firstExit),
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );

    let output = "";
    child.stdout.on("data", (chunk) => {
      output += chunk;
    });
    child.stderr.on("data", (chunk) => {
      output += chunk;
    });

    const exited = new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", (code) => resolve(code));
    });

    const timeout = setTimeout(
      () => child.kill("SIGTERM"),
      firstExit === "freeze" || firstExit === "unhealthy" ? 110_000 : 10_000,
    );

    try {
      const exitCode = await exited;
      expect(await readFile(join(dataDir, "starts"), "utf8")).toBe(
        restarts ? "started\nstarted\n" : "started\n",
      );
      expect(exitCode, output).toBe(expectedExit);
      expect(await readFile(join(dataDir, "preserved.txt"), "utf8")).toBe(
        "existing workspace data",
      );
      expect(output.includes("omnyo host-daemon is ready")).toBe(
        restarts || firstExit === "freeze",
      );
    } finally {
      clearTimeout(timeout);
      child.kill("SIGTERM");
      await exited;
    }
  },
  120_000,
);
