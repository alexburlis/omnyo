import Database from "better-sqlite3";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import {
  copyFile,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, sep } from "node:path";
import { Writable } from "node:stream";
import {
  createConnection,
  type DbConnection,
  migrate,
  setExperiments,
} from "@omnyo/db";
import { defaultExperiments } from "@omnyo/domain";
import { HOST_DAEMON_PROTOCOL_VERSION } from "@omnyo/host-daemon-contract";
import { extractServerArchive } from "@omnyo/server-archive";
import {
  openSecretVault,
  writeSecretFile,
  type SecretVault,
} from "@omnyo/secret-storage";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { exportDataDirArchive } from "../../scripts/stream-server-export-core.js";
import {
  exportServerArchive,
  streamServerExport,
} from "../../src/services/server-move/export.js";
import type { ServerExportFreeSpace } from "../../src/services/server-move/export-snapshot.js";

const tempDirs: string[] = [];

async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "omnyo-server-export-stream-"));
  tempDirs.push(dir);

  return dir;
}

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((dir) => rm(dir, { force: true, recursive: true })),
  );
});

const CREATED_AT = 1_760_000_000_000;

const MARGIN_BYTES = 64 * 1024;

const PLENTY_OF_SPACE = Number.MAX_SAFE_INTEGER;

const EXPORT_TEST_TIMEOUT_MS = 60_000;

let templateDatabasePath = "";

beforeAll(async () => {
  const templateDir = await mkdtemp(
    join(tmpdir(), "omnyo-server-export-template-"),
  );

  templateDatabasePath = join(templateDir, "app.db");
  const db = createConnection(templateDatabasePath);

  try {
    migrate(db);
    setExperiments(db, { ...defaultExperiments, serverMove: true });
    db.$client.exec("CREATE TABLE export_padding (body BLOB NOT NULL)");

    const insertPadding = db.$client.prepare(
      "INSERT INTO export_padding (body) VALUES (?)",
    );

    for (let index = 0; index < 56; index += 1) {
      insertPadding.run(randomBytes(64 * 1024));
    }
  } finally {
    db.$client.close();
  }
}, 2 * EXPORT_TEST_TIMEOUT_MS);

afterAll(async () => {
  await rm(dirname(templateDatabasePath), { force: true, recursive: true });
});

class CollectingWritable extends Writable {
  readonly chunks: Buffer[] = [];

  constructor(private readonly onWrite: (count: number) => void = () => {}) {
    super();
  }

  override _write(
    chunk: Buffer,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ): void {
    this.chunks.push(chunk);
    this.onWrite(this.chunks.length);
    callback();
  }

  bytes(): Buffer {
    return Buffer.concat(this.chunks);
  }
}

interface FakeFreeSpace extends ServerExportFreeSpace {
  probedPaths: string[];
}

function fakeFreeSpace(
  freeBytesForCall: (call: number) => number,
): FakeFreeSpace {
  const probedPaths: string[] = [];

  return {
    marginBytes: MARGIN_BYTES,
    probedPaths,
    readFreeBytes(path) {
      probedPaths.push(path);

      return freeBytesForCall(probedPaths.length);
    },
  };
}

function sha256(body: Buffer): string {
  return createHash("sha256").update(body).digest("hex");
}

async function writeDataFile(
  dataDir: string,
  relativePath: string,
  content: string | Buffer,
): Promise<void> {
  const path = join(dataDir, ...relativePath.split("/"));
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content);
}

const APP_VERSION = "0.46.3";

const quietLogger = {
  warn(): void {},
};

interface ExportFixture {
  dataDir: string;
  db: DbConnection;
  vault: SecretVault;
}

async function withExportFixture(
  run: (fixture: ExportFixture) => Promise<void>,
): Promise<void> {
  const dataDir = await makeTempDir();
  await copyFile(templateDatabasePath, join(dataDir, "app.db"));
  const db = createConnection(join(dataDir, "app.db"));
  const pluginDatabasePath = join(dataDir, "plugins", "tasks", "data.db");
  await mkdir(dirname(pluginDatabasePath), { recursive: true });
  const pluginDatabase = new Database(pluginDatabasePath);

  try {
    const insertPadding = db.$client.prepare(
      "INSERT INTO export_padding (body) VALUES (?)",
    );

    for (let index = 0; index < 8; index += 1) {
      insertPadding.run(randomBytes(64 * 1024));
    }

    await writeDataFile(dataDir, "host-id", "host-old\n");
    await writeDataFile(dataDir, "config.json", '{"config":{}}\n');
    await writeDataFile(
      dataDir,
      "attachments/project-1/screenshot.png",
      randomBytes(2 * 1024 * 1024),
    );
    pluginDatabase.pragma("journal_mode = WAL");
    pluginDatabase.pragma("wal_autocheckpoint = 0");
    pluginDatabase.exec("CREATE TABLE items (name TEXT NOT NULL)");
    pluginDatabase
      .prepare("INSERT INTO items (name) VALUES (?)")
      .run("written only to the WAL");
    await run({ dataDir, db, vault: await openSecretVault(dataDir) });
  } finally {
    pluginDatabase.close();
    db.$client.close();
  }
}

function exportSource(fixture: ExportFixture) {
  return {
    appVersion: APP_VERSION,
    dataDir: fixture.dataDir,
    db: fixture.db,
    logger: quietLogger,
    now: CREATED_AT,
    sourceServerHostId: "host-old",
    vault: fixture.vault,
  };
}

async function sqliteDatabaseBytes(dataDir: string): Promise<number> {
  let total = 0;

  for (const relativePath of ["app.db", "plugins/tasks/data.db"]) {
    for (const suffix of ["", "-wal"]) {
      const path = join(dataDir, ...`${relativePath}${suffix}`.split("/"));

      if (existsSync(path)) {
        total += (await stat(path)).size;
      }
    }
  }

  return total;
}

async function frozenServerFileBytes(dataDir: string): Promise<number> {
  return (await stat(join(dataDir, "config.json"))).size;
}

function listFiles(root: string): string[] {
  if (!existsSync(root)) {
    return [];
  }

  return readdirSync(root, { recursive: true, withFileTypes: true })
    .filter((entry) => !entry.isDirectory())
    .map((entry) =>
      relative(root, join(entry.parentPath, entry.name)).split(sep).join("/"),
    )
    .sort();
}

async function extractBytes(bytes: Buffer) {
  const root = await makeTempDir();
  const archivePath = join(root, "archive.tar.gz");
  await writeFile(archivePath, bytes);

  return extractServerArchive({
    archivePath,
    destinationDir: join(root, "staging"),
  });
}

describe("streaming server export", { timeout: EXPORT_TEST_TIMEOUT_MS }, () => {
  it("streams the same archive bytes as the file export of the same data, measuring them before the stream starts", () =>
    withExportFixture(async (fixture) => {
      const freeSpace = fakeFreeSpace(() => PLENTY_OF_SPACE);
      const output = new CollectingWritable();
      const measured: Array<{ sha256: string; sizeBytes: number }> = [];

      const streamed = await streamServerExport({
        ...exportSource(fixture),
        freeSpace,
        onMeasured: (archive) => {
          expect(output.chunks).toEqual([]);
          measured.push(archive);
        },
        output,
        signal: new AbortController().signal,
        workDir: join(fixture.dataDir, "server-export"),
      });

      const fileExport = await exportServerArchive({
        ...exportSource(fixture),
        fileName: "server.tar.gz",
        freeSpace,
        workDir: join(fixture.dataDir, "server-move", "move-1"),
      });

      const streamedBytes = output.bytes();
      expect(measured).toEqual([
        { sha256: streamed.sha256, sizeBytes: streamed.sizeBytes },
      ]);
      expect(sha256(streamedBytes)).toBe(streamed.sha256);
      expect(streamedBytes.length).toBe(streamed.sizeBytes);
      expect(streamedBytes.equals(await readFile(fileExport.path))).toBe(true);
      const manifest = await extractBytes(streamedBytes);
      expect(manifest).toMatchObject({
        createdAt: CREATED_AT,
        serverMoveExperiment: true,
        sourceServerHostId: "host-old",
      });
      expect(manifest.entries.map((entry) => entry.path)).toEqual(
        expect.arrayContaining([
          "app.db",
          "attachments/project-1/screenshot.png",
          "plugins/tasks/data.db",
        ]),
      );
      expect(listFiles(join(fixture.dataDir, "server-export"))).toEqual([]);
    }));

  it("archives the bytes it measured when a small server file changes before it is streamed", () =>
    withExportFixture(async (fixture) => {
      const tokenPath =
        "plugins/account-pool/secrets/accounts/hub-token-host_mac.json";

      const measuredToken = Buffer.from('{"token":"before-refresh"}\n');
      await writeDataFile(fixture.dataDir, tokenPath, measuredToken);
      const livePath = join(fixture.dataDir, ...tokenPath.split("/"));
      const workDir = join(fixture.dataDir, "server-export");
      const output = new CollectingWritable();

      const streamed = await streamServerExport({
        ...exportSource(fixture),
        freeSpace: fakeFreeSpace(() => PLENTY_OF_SPACE),
        onMeasured: () => {
          writeFileSync(livePath, '{"token":"after-refresh","rotated":true}\n');
        },
        output,
        signal: new AbortController().signal,
        workDir,
      });

      expect(sha256(output.bytes())).toBe(streamed.sha256);
      const manifest = await extractBytes(output.bytes());
      expect(manifest.entries).toContainEqual({
        path: tokenPath,
        size: measuredToken.length,
        sha256: sha256(measuredToken),
      });
      expect(await readFile(livePath, "utf8")).toContain("after-refresh");
      expect(listFiles(workDir)).toEqual([]);
    }));

  it("streams dependency package files live instead of freezing them", () =>
    withExportFixture(async (fixture) => {
      const packageFile =
        "plugins/cutover-sources/account-usage/node_modules/left-pad/index.js";

      const packageBytes = Buffer.from("module.exports = () => {};\n");
      await writeDataFile(fixture.dataDir, packageFile, packageBytes);
      const workDir = join(fixture.dataDir, "server-export");
      const seenFiles = new Set<string>();

      const output = new CollectingWritable(() => {
        for (const file of listFiles(workDir)) {
          seenFiles.add(file.replace(/^snapshot-[^/]+\//u, "snapshot-*/"));
        }
      });

      await streamServerExport({
        ...exportSource(fixture),
        freeSpace: fakeFreeSpace(() => PLENTY_OF_SPACE),
        onMeasured: () => {},
        output,
        signal: new AbortController().signal,
        workDir,
      });

      expect([...seenFiles]).not.toContain(`snapshot-*/${packageFile}`);
      const manifest = await extractBytes(output.bytes());
      expect(manifest.entries).toContainEqual({
        path: packageFile,
        size: packageBytes.length,
        sha256: sha256(packageBytes),
      });
    }));

  it("removes the snapshot and leaves nothing in the work dir when the consumer disconnects mid-stream", () =>
    withExportFixture(async (fixture) => {
      const workDir = join(fixture.dataDir, "server-export");

      const output = new Writable({
        write(_chunk: Buffer, _encoding, callback) {
          callback(Object.assign(new Error("write EPIPE"), { code: "EPIPE" }));
        },
      });

      await expect(
        streamServerExport({
          ...exportSource(fixture),
          freeSpace: fakeFreeSpace(() => PLENTY_OF_SPACE),
          onMeasured: () => {},
          output,
          signal: new AbortController().signal,
          workDir,
        }),
      ).rejects.toMatchObject({ code: "EPIPE" });

      expect(listFiles(workDir)).toEqual([]);
      expect(await readdir(workDir)).toEqual([]);
    }));

  it("removes the partial snapshot when the export is aborted during the database backup", () =>
    withExportFixture(async (fixture) => {
      const workDir = join(fixture.dataDir, "server-export");
      const controller = new AbortController();
      const snapshotFilesAtAbort: string[][] = [];

      const freeSpace = fakeFreeSpace((call) => {
        if (call === 3) {
          snapshotFilesAtAbort.push(listFiles(workDir));
          controller.abort(new Error("client disconnected"));
        }

        return PLENTY_OF_SPACE;
      });

      await expect(
        streamServerExport({
          ...exportSource(fixture),
          freeSpace,
          onMeasured: () => {},
          output: new CollectingWritable(),
          signal: controller.signal,
          workDir,
        }),
      ).rejects.toThrow("client disconnected");

      expect(snapshotFilesAtAbort).toHaveLength(1);

      const filesAtAbort = (snapshotFilesAtAbort[0] ?? []).map((file) =>
        file.replace(/^snapshot-[^/]+\//u, "snapshot-*/"),
      );

      expect(filesAtAbort).toContain("snapshot-*/app.db");
      expect(
        filesAtAbort.every((file) => file.startsWith("snapshot-*/app.db")),
      ).toBe(true);
      expect(await readdir(workDir)).toEqual([]);
    }));

  it("refuses to start, before writing any snapshot, when free space is below the estimated snapshot plus the margin", () =>
    withExportFixture(async (fixture) => {
      const dataDir = fixture.dataDir;
      const workDir = join(dataDir, "server-export");

      const estimatedSnapshotBytes =
        (await sqliteDatabaseBytes(dataDir)) +
        (await frozenServerFileBytes(dataDir));

      const output = new CollectingWritable();

      const freeSpace = fakeFreeSpace(
        () => estimatedSnapshotBytes + MARGIN_BYTES - 1,
      );

      await expect(
        streamServerExport({
          ...exportSource(fixture),
          freeSpace,
          onMeasured: () => {},
          output,
          signal: new AbortController().signal,
          workDir,
        }),
      ).rejects.toMatchObject({
        status: 507,
        body: { code: "server_export_disk_space" },
      });

      expect(freeSpace.probedPaths).toHaveLength(1);
      expect(output.chunks).toEqual([]);
      expect(await readdir(workDir)).toEqual([]);
    }));

  it("starts when free space exactly covers the estimated snapshot plus the margin", () =>
    withExportFixture(async (fixture) => {
      const dataDir = fixture.dataDir;

      const estimatedSnapshotBytes =
        (await sqliteDatabaseBytes(dataDir)) +
        (await frozenServerFileBytes(dataDir));

      const freeSpace = fakeFreeSpace((call) =>
        call === 1 ? estimatedSnapshotBytes + MARGIN_BYTES : PLENTY_OF_SPACE,
      );

      await expect(
        streamServerExport({
          ...exportSource(fixture),
          freeSpace,
          onMeasured: () => {},
          output: new CollectingWritable(),
          signal: new AbortController().signal,
          workDir: join(dataDir, "server-export"),
        }),
      ).resolves.toMatchObject({ sizeBytes: expect.any(Number) });
    }));

  it("aborts the backup and removes the partial snapshot when free space falls below the margin", () =>
    withExportFixture(async (fixture) => {
      const workDir = join(fixture.dataDir, "server-export");

      const freeSpace = fakeFreeSpace((call) =>
        call < 4 ? PLENTY_OF_SPACE : MARGIN_BYTES - 1,
      );

      await expect(
        streamServerExport({
          ...exportSource(fixture),
          freeSpace,
          onMeasured: () => {},
          output: new CollectingWritable(),
          signal: new AbortController().signal,
          workDir,
        }),
      ).rejects.toMatchObject({
        status: 507,
        body: { code: "server_export_disk_space" },
      });

      expect(freeSpace.probedPaths.length).toBe(4);
      expect(await readdir(workDir)).toEqual([]);
    }));

  it("never creates an archive or temp file while streaming", () =>
    withExportFixture(async (fixture) => {
      const workDir = join(fixture.dataDir, "server-export");
      const seenFiles = new Set<string>();

      const output = new CollectingWritable(() => {
        for (const file of listFiles(workDir)) {
          seenFiles.add(file.replace(/^snapshot-[^/]+\//u, "snapshot-*/"));
        }
      });

      await streamServerExport({
        ...exportSource(fixture),
        freeSpace: fakeFreeSpace(() => PLENTY_OF_SPACE),
        onMeasured: () => {},
        output,
        signal: new AbortController().signal,
        workDir,
      });

      expect(output.chunks.length).toBeGreaterThan(1);
      expect([...seenFiles].sort()).toEqual([
        "snapshot-*/app.db",
        "snapshot-*/config.json",
        "snapshot-*/plugins/tasks/data.db",
      ]);
      expect(await readdir(workDir)).toEqual([]);
    }));

  it("lets a second concurrent export in the same work dir finish without disturbing or leaking the first one's snapshot", () =>
    withExportFixture(async (fixture) => {
      const workDir = join(fixture.dataDir, "server-export");
      let releaseFirst: () => void = () => {};

      const firstReleased = new Promise<void>((resolve) => {
        releaseFirst = resolve;
      });

      let reportFirstHeld: () => void = () => {};

      const firstHeld = new Promise<void>((resolve) => {
        reportFirstHeld = resolve;
      });

      const firstChunks: Buffer[] = [];

      const heldOutput = new Writable({
        write(chunk: Buffer, _encoding, callback) {
          firstChunks.push(chunk);

          if (firstChunks.length === 1) {
            reportFirstHeld();
            void firstReleased.then(() => {
              callback();
            });

            return;
          }

          callback();
        },
      });

      const first = streamServerExport({
        ...exportSource(fixture),
        freeSpace: fakeFreeSpace(() => PLENTY_OF_SPACE),
        onMeasured: () => {},
        output: heldOutput,
        signal: new AbortController().signal,
        workDir,
      });

      await firstHeld;
      const [firstSnapshotDir] = await readdir(workDir);

      const secondOutput = new CollectingWritable();

      const second = await streamServerExport({
        ...exportSource(fixture),
        freeSpace: fakeFreeSpace(() => PLENTY_OF_SPACE),
        onMeasured: () => {},
        output: secondOutput,
        signal: new AbortController().signal,
        workDir,
      });

      expect(await readdir(workDir)).toEqual([firstSnapshotDir]);
      expect(sha256(secondOutput.bytes())).toBe(second.sha256);
      releaseFirst();
      const firstResult = await first;
      const firstBytes = Buffer.concat(firstChunks);
      expect(sha256(firstBytes)).toBe(firstResult.sha256);
      expect((await extractBytes(firstBytes)).entries.length).toBeGreaterThan(
        2,
      );
      expect(await readdir(workDir)).toEqual([]);
    }));
});

describe(
  "standalone data dir export for the stream-server-export helper",
  { timeout: EXPORT_TEST_TIMEOUT_MS },
  () => {
    const serverRuntime = {
      appVersion: APP_VERSION,
      protocolVersion: HOST_DAEMON_PROTOCOL_VERSION,
    };

    function openReadonly(path: string): Database.Database {
      return new Database(path, { fileMustExist: true, readonly: true });
    }

    it("produces the same archive bytes as the server export of the same data", () =>
      withExportFixture(async (fixture) => {
        const serverOutput = new CollectingWritable();
        await streamServerExport({
          ...exportSource(fixture),
          freeSpace: fakeFreeSpace(() => PLENTY_OF_SPACE),
          onMeasured: () => {},
          output: serverOutput,
          signal: new AbortController().signal,
          workDir: join(fixture.dataDir, "server-export"),
        });
        const helperWorkDir = await makeTempDir();
        const helperOutput = new CollectingWritable();

        const helperResult = await exportDataDirArchive({
          dataDir: fixture.dataDir,
          freeSpace: fakeFreeSpace(() => PLENTY_OF_SPACE),
          logger: quietLogger,
          now: CREATED_AT,
          openDatabase: openReadonly,
          output: helperOutput,
          runtime: serverRuntime,
          signal: new AbortController().signal,
          workDir: helperWorkDir,
        });

        expect(helperOutput.bytes().equals(serverOutput.bytes())).toBe(true);
        expect(helperResult).toEqual({
          sha256: sha256(helperOutput.bytes()),
          sizeBytes: helperOutput.bytes().length,
        });
        expect(await readdir(helperWorkDir)).toEqual([]);
      }));

    it("decrypts sealed secrets and their plugin snapshot copies in memory, and archives no vault entry", () =>
      withExportFixture(async (fixture) => {
        const largeSecret = randomBytes(800 * 1024).toString("base64");

        const secrets = {
          "auth-secret": "a".repeat(64),
          "plugins/tasks/secrets/token": "live-token-5d1e",
          "plugins/tasks/secrets/nested/large": largeSecret,
          "plugins/snapshots/tasks/snap-1/secrets/token": "snapshot-token-9b2c",
        };

        for (const [path, value] of Object.entries(secrets)) {
          await writeSecretFile(
            fixture.vault,
            join(fixture.dataDir, ...path.split("/")),
            value,
          );
        }

        expect(
          (
            await stat(
              join(fixture.dataDir, "plugins/tasks/secrets/nested/large"),
            )
          ).size,
        ).toBeGreaterThan(1024 ** 2);
        const workDir = join(fixture.dataDir, "server-export");
        const plaintextOnDisk: string[] = [];
        const serverOutput = new CollectingWritable();

        await streamServerExport({
          ...exportSource(fixture),
          freeSpace: fakeFreeSpace(() => PLENTY_OF_SPACE),
          onMeasured: () => {
            for (const file of listFiles(workDir)) {
              const text = readFileSync(join(workDir, file), "utf8");

              if (Object.values(secrets).some((value) => text.includes(value)))
                plaintextOnDisk.push(file);
            }
          },
          output: serverOutput,
          signal: new AbortController().signal,
          workDir,
        });

        const helperOutput = new CollectingWritable();
        await exportDataDirArchive({
          dataDir: fixture.dataDir,
          freeSpace: fakeFreeSpace(() => PLENTY_OF_SPACE),
          logger: quietLogger,
          now: CREATED_AT,
          openDatabase: openReadonly,
          output: helperOutput,
          runtime: serverRuntime,
          signal: new AbortController().signal,
          workDir: await makeTempDir(),
        });

        expect(plaintextOnDisk).toEqual([]);
        expect(helperOutput.bytes().equals(serverOutput.bytes())).toBe(true);
        expect(existsSync(join(fixture.dataDir, "vault", "vault.json"))).toBe(
          true,
        );
        const root = await makeTempDir();
        const archivePath = join(root, "archive.tar.gz");
        await writeFile(archivePath, serverOutput.bytes());
        const destination = join(root, "staging");

        const manifest = await extractServerArchive({
          archivePath,
          destinationDir: destination,
        });

        expect(
          manifest.entries.filter((entry) => entry.path.startsWith("vault/")),
        ).toEqual([]);

        for (const [path, value] of Object.entries(secrets)) {
          expect(
            await readFile(
              join(destination, "files", ...path.split("/")),
              "utf8",
            ),
          ).toBe(value);
        }
      }));

    it("takes one consistent snapshot while the server keeps writing through its own connection", () =>
      withExportFixture(async (fixture) => {
        fixture.db.$client.exec(
          "CREATE TABLE export_writes (id INTEGER PRIMARY KEY, body BLOB NOT NULL)",
        );

        const insertWrite = fixture.db.$client.prepare(
          "INSERT INTO export_writes (body) VALUES (?)",
        );

        const writer = setInterval(() => {
          insertWrite.run(randomBytes(512));
        }, 1);

        const helperOutput = new CollectingWritable();

        try {
          await exportDataDirArchive({
            dataDir: fixture.dataDir,
            freeSpace: fakeFreeSpace(() => PLENTY_OF_SPACE),
            logger: quietLogger,
            now: CREATED_AT,
            openDatabase: openReadonly,
            output: helperOutput,
            runtime: serverRuntime,
            signal: AbortSignal.timeout(45_000),
            workDir: await makeTempDir(),
          });
        } finally {
          clearInterval(writer);
        }

        const root = await makeTempDir();
        const archivePath = join(root, "archive.tar.gz");
        await writeFile(archivePath, helperOutput.bytes());
        const destination = join(root, "staging");
        await extractServerArchive({
          archivePath,
          destinationDir: destination,
        });

        const snapshot = new Database(join(destination, "files", "app.db"), {
          readonly: true,
        });

        try {
          expect(snapshot.pragma("integrity_check", { simple: true })).toBe(
            "ok",
          );

          const { count, maxId } = snapshot
            .prepare<[], { count: number; maxId: number | null }>(
              "SELECT COUNT(*) AS count, MAX(id) AS maxId FROM export_writes",
            )
            .get() ?? { count: -1, maxId: null };

          expect(count).toBe(maxId ?? 0);
        } finally {
          snapshot.close();
        }
      }));
  },
);
