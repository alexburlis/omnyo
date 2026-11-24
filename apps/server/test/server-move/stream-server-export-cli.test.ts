import Database from "better-sqlite3";
import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { once } from "node:events";
import { existsSync, readdirSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import { createRequire } from "node:module";
import net from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createConnection, migrate, setExperiments } from "@omnyo/db";
import { defaultExperiments } from "@omnyo/domain";
import { extractServerArchive } from "@omnyo/server-archive";
import { createRuntimeIdentity } from "@omnyo/server-archive/runtime-identity";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const testDir = dirname(fileURLToPath(import.meta.url));

const serverRoot = resolve(testDir, "../..");

const helperEntry = join(serverRoot, "scripts", "stream-server-export.ts");

const sqliteModule = dirname(
  createRequire(import.meta.url).resolve("better-sqlite3/package.json"),
);

const FIXTURE_APP_VERSION = "0.46.3";

const FIXTURE_PROTOCOL_VERSION = 236;

const ATTACHMENT_PATH = "attachments/project-1/recording.bin";

const MARGIN_BYTES = 1024 * 1024;

const HELPER_TIMEOUT_MS = 60_000;

interface Fixture {
  root: string;
  dataDir: string;
  omnyoAppDir: string;
}

interface ServeSecret {
  tokenFile: string;
  bearerValue: string;
}

let fixture: Fixture;

async function writeFixtureFile(
  path: string,
  content: string | Buffer,
): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content);
}

async function createDataDir(dataDir: string): Promise<void> {
  await mkdir(dataDir, { recursive: true });
  const db = createConnection(join(dataDir, "app.db"));

  try {
    migrate(db);
    setExperiments(db, { ...defaultExperiments, serverMove: true });
  } finally {
    db.$client.close();
  }

  await writeFixtureFile(join(dataDir, "host-id"), "host-vps\n");
  await writeFixtureFile(join(dataDir, "config.json"), '{"config":{}}\n');
  await writeFixtureFile(
    join(dataDir, ...ATTACHMENT_PATH.split("/")),
    randomBytes(16 * 1024 * 1024),
  );
  await mkdir(join(dataDir, "plugins", "tasks"), { recursive: true });

  const pluginDatabase = new Database(
    join(dataDir, "plugins", "tasks", "data.db"),
  );

  try {
    pluginDatabase.exec("CREATE TABLE items (name TEXT NOT NULL)");
    pluginDatabase.prepare("INSERT INTO items (name) VALUES (?)").run("one");
  } finally {
    pluginDatabase.close();
  }
}

async function createOmnyoApp(omnyoAppDir: string): Promise<void> {
  await writeFixtureFile(
    join(omnyoAppDir, "package.json"),
    JSON.stringify({ name: "omnyo-app", version: FIXTURE_APP_VERSION }),
  );
  await writeFixtureFile(
    join(omnyoAppDir, "dist", "omnyo-app.js"),
    "export {};\n",
  );
  await writeFixtureFile(
    join(omnyoAppDir, "server", "dist", "start-server.js"),
    "export {};\n",
  );
  await writeFixtureFile(
    join(omnyoAppDir, "host-daemon", "dist", "omnyo-host-daemon.js"),
    "export {};\n",
  );
  await writeFixtureFile(
    join(omnyoAppDir, "app", "dist", "index.html"),
    "<html/>",
  );

  const identity = await createRuntimeIdentity(omnyoAppDir, {
    runtimeVersion: FIXTURE_APP_VERSION,
    hostDaemonProtocolVersion: FIXTURE_PROTOCOL_VERSION,
  });

  await writeFile(
    join(omnyoAppDir, "dist", "runtime-identity.json"),
    `${JSON.stringify(identity)}\n`,
  );
}

beforeAll(async () => {
  const root = await mkdtemp(join(tmpdir(), "omnyo-stream-export-cli-"));
  fixture = {
    root,
    dataDir: join(root, "data"),
    omnyoAppDir: join(root, "omnyo-app"),
  };
  await createDataDir(fixture.dataDir);
  await createOmnyoApp(fixture.omnyoAppDir);
}, 2 * HELPER_TIMEOUT_MS);

afterAll(async () => {
  await rm(fixture.root, { force: true, recursive: true });
});

async function newServeSecret(): Promise<ServeSecret> {
  const secretsDir = await mkdtemp(join(fixture.root, "secrets-"));
  const bearerValue = randomBytes(24).toString("hex");
  const tokenFile = join(secretsDir, "export.token");
  await writeFile(tokenFile, `${bearerValue}\n`, { mode: 0o600 });

  return { tokenFile, bearerValue };
}

async function newWorkDir(): Promise<string> {
  const workDir = await mkdtemp(join(fixture.root, "work-"));

  return workDir;
}

function exportArgs(workDir: string, marginBytes = MARGIN_BYTES): string[] {
  return [
    "--data-dir",
    fixture.dataDir,
    "--work-dir",
    workDir,
    "--margin-bytes",
    String(marginBytes),
    "--sqlite-module",
    sqliteModule,
    "--omnyo-app",
    fixture.omnyoAppDir,
  ];
}

function serveArgs(
  workDir: string,
  secret: ServeSecret,
  listen = "127.0.0.1:0",
  maxWaitSeconds = 30,
): string[] {
  return [
    ...exportArgs(workDir),
    "--listen",
    listen,
    "--token-file",
    secret.tokenFile,
    "--max-wait-seconds",
    String(maxWaitSeconds),
  ];
}

interface HelperRun {
  child: ChildProcessWithoutNullStreams;
  stderrText(): string;
  stderrEvents(): Array<Record<string, unknown>>;
  exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
}

function startHelper(args: string[]): HelperRun {
  const child = spawn(
    process.execPath,
    ["--conditions=source", "--import", "tsx", helperEntry, ...args],
    { cwd: serverRoot, stdio: ["pipe", "pipe", "pipe"] },
  );

  child.stdin.end();
  const stderrChunks: Buffer[] = [];
  child.stderr.on("data", (chunk: Buffer) => {
    stderrChunks.push(chunk);
  });

  const exited = once(child, "exit").then(([code, signal]) => ({
    code: typeof code === "number" ? code : null,
    signal: typeof signal === "string" ? (signal as NodeJS.Signals) : null,
  }));

  const stderrText = () => Buffer.concat(stderrChunks).toString("utf8");

  return {
    child,
    exited,
    stderrText,
    stderrEvents: () =>
      stderrText()
        .split("\n")
        .filter((line) => line.trim().length > 0)
        .map((line) => JSON.parse(line) as Record<string, unknown>),
  };
}

async function readAll(stream: NodeJS.ReadableStream): Promise<Buffer> {
  const chunks: Buffer[] = [];

  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
  }

  return Buffer.concat(chunks);
}

async function waitFor(
  condition: () => boolean,
  timeoutMs = HELPER_TIMEOUT_MS,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;

  while (!condition()) {
    if (Date.now() > deadline) {
      throw new Error("Timed out waiting for the helper");
    }

    await new Promise((resolveWait) => setTimeout(resolveWait, 10));
  }
}

function sha256(body: Buffer): string {
  return createHash("sha256").update(body).digest("hex");
}

async function extractBytes(bytes: Buffer) {
  const root = await mkdtemp(join(fixture.root, "extract-"));
  const archivePath = join(root, "archive.tar.gz");
  await writeFile(archivePath, bytes);

  return extractServerArchive({
    archivePath,
    destinationDir: join(root, "staging"),
  });
}

async function listeningPort(run: HelperRun): Promise<number> {
  let port = 0;
  await waitFor(() => {
    const listening = run
      .stderrEvents()
      .find((event) => event.event === "listening");

    port = typeof listening?.port === "number" ? listening.port : 0;

    return port > 0;
  });

  return port;
}

interface ExportGet {
  request: http.ClientRequest;
  response: Promise<http.IncomingMessage>;
}

function getExport(
  port: number,
  headers: Record<string, string>,
  args: { method?: string; path?: string } = {},
): ExportGet {
  const request = http.request({
    host: "127.0.0.1",
    port,
    path: args.path ?? "/export",
    method: args.method ?? "GET",
    headers,
  });

  const response = new Promise<http.IncomingMessage>(
    (resolveResponse, reject) => {
      request.once("response", resolveResponse);
      request.once("error", reject);
    },
  );

  response.catch(() => undefined);
  request.end();

  return { request, response };
}

async function statusOf(get: ExportGet): Promise<number> {
  const response = await get.response;
  response.resume();

  return response.statusCode ?? 0;
}

function bearer(token: string): Record<string, string> {
  return { authorization: `Bearer ${token}` };
}

function sidecarPath(secret: ServeSecret): string {
  return `${secret.tokenFile}.result.json`;
}

describe(
  "stream-server-export helper, stdout mode",
  { timeout: HELPER_TIMEOUT_MS },
  () => {
    it("streams the archive to stdout and reports its sha256 and size on stderr as JSON", async () => {
      const workDir = await newWorkDir();
      const run = startHelper(exportArgs(workDir));

      const bytes = await readAll(run.child.stdout);
      const { code } = await run.exited;

      expect(code).toBe(0);
      expect(run.stderrEvents().at(-1)).toEqual({
        sha256: sha256(bytes),
        sizeBytes: bytes.length,
      });
      const manifest = await extractBytes(bytes);
      expect(manifest).toMatchObject({
        appVersion: FIXTURE_APP_VERSION,
        protocolVersion: FIXTURE_PROTOCOL_VERSION,
        sourceDataDir: fixture.dataDir,
        sourceServerHostId: "host-vps",
        serverMoveExperiment: true,
      });
      expect(manifest.migrationCount).toBeGreaterThan(100);
      expect(manifest.entries.map((entry) => entry.path)).toEqual(
        expect.arrayContaining([
          "app.db",
          "config.json",
          ATTACHMENT_PATH,
          "plugins/tasks/data.db",
        ]),
      );
      expect(readdirSync(workDir)).toEqual([]);
    });

    it("removes its snapshot and exits non-zero when the reader closes the pipe early", async () => {
      const workDir = await newWorkDir();
      const run = startHelper(exportArgs(workDir));
      await once(run.child.stdout, "data");

      run.child.stdout.destroy();
      const { code } = await run.exited;

      expect(code).toBe(1);
      expect(readdirSync(workDir)).toEqual([]);
    });

    it.each([
      { signal: "SIGTERM" as const, code: 143 },
      { signal: "SIGINT" as const, code: 130 },
      { signal: "SIGHUP" as const, code: 129 },
    ])(
      "removes its snapshot and exits $code on $signal mid-export",
      async ({ signal, code }) => {
        const workDir = await newWorkDir();
        const run = startHelper(exportArgs(workDir));
        await waitFor(() => readdirSync(workDir).length > 0);

        run.child.kill(signal);
        const exit = await run.exited;

        expect(exit).toEqual({ code, signal: null });
        expect(readdirSync(workDir)).toEqual([]);
      },
    );

    it("refuses to start when free space is below the snapshot estimate plus --margin-bytes", async () => {
      const workDir = await newWorkDir();
      const run = startHelper(exportArgs(workDir, 9_000_000_000_000_000));

      const bytes = await readAll(run.child.stdout);
      const { code } = await run.exited;

      expect(code).toBe(1);
      expect(bytes.length).toBe(0);
      expect(run.stderrEvents().at(-1)).toMatchObject({
        event: "error",
        code: "server_export_disk_space",
      });
      expect(readdirSync(workDir)).toEqual([]);
    });

    it("lets two runs share a --work-dir without disturbing or leaking each other's snapshot", async () => {
      const workDir = await newWorkDir();
      const first = startHelper(exportArgs(workDir));
      await waitFor(() => readdirSync(workDir).length === 1);
      const [firstSnapshot] = readdirSync(workDir);

      const second = startHelper(exportArgs(workDir));
      const secondBytes = await readAll(second.child.stdout);
      expect((await second.exited).code).toBe(0);
      expect(second.stderrEvents().at(-1)).toMatchObject({
        sha256: sha256(secondBytes),
      });
      expect(readdirSync(workDir)).toEqual([firstSnapshot]);

      const firstBytes = await readAll(first.child.stdout);
      expect((await first.exited).code).toBe(0);
      expect(first.stderrEvents().at(-1)).toMatchObject({
        sha256: sha256(firstBytes),
      });
      expect(readdirSync(workDir)).toEqual([]);
    });

    it("fails before taking a snapshot when --sqlite-module cannot be loaded", async () => {
      const workDir = await newWorkDir();
      const missingModule = join(fixture.root, "missing", "better-sqlite3");
      const args = exportArgs(workDir);
      args[args.indexOf("--sqlite-module") + 1] = missingModule;
      const run = startHelper(args);

      const bytes = await readAll(run.child.stdout);
      const { code } = await run.exited;

      expect(code).toBe(2);
      expect(bytes.length).toBe(0);
      expect(run.stderrText()).toContain(missingModule);
      expect(readdirSync(workDir)).toEqual([]);
    });
  },
);

describe(
  "stream-server-export helper, one-shot serve mode",
  { timeout: HELPER_TIMEOUT_MS },
  () => {
    it("refuses wrong tokens and other requests, then streams one archive and records its digest", async () => {
      const workDir = await newWorkDir();
      const secret = await newServeSecret();
      const run = startHelper(serveArgs(workDir, secret));
      const port = await listeningPort(run);

      expect(await statusOf(getExport(port, bearer("wrong-token")))).toBe(403);
      expect(await statusOf(getExport(port, {}))).toBe(403);
      expect(
        await statusOf(
          getExport(port, bearer(secret.bearerValue), { method: "POST" }),
        ),
      ).toBe(405);
      expect(
        await statusOf(
          getExport(port, bearer(secret.bearerValue), { path: "/other" }),
        ),
      ).toBe(404);
      const download = getExport(port, bearer(secret.bearerValue));
      const response = await download.response;
      expect(response.statusCode).toBe(200);
      expect(response.headers["content-type"]).toBe("application/gzip");
      expect(response.headers["content-length"]).toBeUndefined();
      expect(response.rawTrailers).toEqual([]);
      const bytes = await readAll(response);
      const { code } = await run.exited;

      expect(code).toBe(0);
      const digest = { sha256: sha256(bytes), sizeBytes: bytes.length };
      expect(run.stderrEvents().at(-1)).toEqual(digest);
      expect(JSON.parse(await readFile(sidecarPath(secret), "utf8"))).toEqual(
        digest,
      );
      expect((await extractBytes(bytes)).serverMoveExperiment).toBe(true);
      expect(run.stderrText()).not.toContain(secret.bearerValue);
      expect(readdirSync(workDir)).toEqual([]);
    });

    it("refuses a second GET during the transfer and removes the snapshot when the client disconnects mid-body", async () => {
      const workDir = await newWorkDir();
      const secret = await newServeSecret();
      const run = startHelper(serveArgs(workDir, secret));
      const port = await listeningPort(run);
      const first = getExport(port, bearer(secret.bearerValue));
      const response = await first.response;
      expect(response.statusCode).toBe(200);
      await once(response, "data");
      response.pause();

      expect(await statusOf(getExport(port, bearer(secret.bearerValue)))).toBe(
        409,
      );
      first.request.destroy();
      const { code } = await run.exited;

      expect(code).toBe(1);
      expect(readdirSync(workDir)).toEqual([]);
      expect(existsSync(sidecarPath(secret))).toBe(false);
      expect(run.stderrText()).not.toContain(secret.bearerValue);
    });

    it("exits 3 at --max-wait-seconds when no client arrives, without taking a snapshot", async () => {
      const workDir = await newWorkDir();

      const run = startHelper(
        serveArgs(workDir, await newServeSecret(), "127.0.0.1:0", 1),
      );

      const { code } = await run.exited;

      expect(code).toBe(3);
      expect(run.stderrEvents().at(-1)).toMatchObject({ event: "timeout" });
      expect(readdirSync(workDir)).toEqual([]);
    });

    it.each(["0.0.0.0:0", "[::]:0", "localhost:0"])(
      "refuses to listen on %s",
      async (listen) => {
        const workDir = await newWorkDir();

        const run = startHelper(
          serveArgs(workDir, await newServeSecret(), listen),
        );

        const { code } = await run.exited;

        expect(code).toBe(2);
        expect(run.stderrEvents().at(-1)).toMatchObject({
          event: "error",
          code: "usage",
        });
      },
    );

    it("binds only the given address", async () => {
      const workDir = await newWorkDir();
      const run = startHelper(serveArgs(workDir, await newServeSecret()));
      const port = await listeningPort(run);

      const ipv6Error = await new Promise<NodeJS.ErrnoException | null>(
        (resolveConnect) => {
          const socket = net.connect({ host: "::1", port });
          socket.once("connect", () => {
            socket.destroy();
            resolveConnect(null);
          });
          socket.once("error", resolveConnect);
        },
      );

      expect(ipv6Error?.code).toBe("ECONNREFUSED");
      expect(
        run.stderrEvents().find((event) => event.event === "listening"),
      ).toMatchObject({ address: "127.0.0.1", port });

      run.child.kill("SIGTERM");
      expect((await run.exited).code).toBe(143);
      expect(readdirSync(workDir)).toEqual([]);
    });
  },
);
