import { once } from "node:events";
import {
  chmod,
  link,
  lstat,
  mkdir,
  readFile,
  readlink,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import {
  createConnection as connectSocket,
  createServer,
  type Server,
} from "node:net";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { z } from "zod";
import { createConnection as createDatabaseConnection } from "@omnyo/db";
import {
  admitConfiguredOmnyoStateWrites,
  readConfiguredOmnyoStateAdmission,
} from "@omnyo/config/omnyo-state-startup";
import {
  assertOmnyoStateWriteAdmission,
  readOmnyoStateAdmission,
} from "@omnyo/config/omnyo-state-admission";
import {
  inspectOmnyoStateRootForAdoptionV2,
  OmnyoStateWorkPendingError,
  readOmnyoStateRootJobBindingV2,
  rollBackOmnyoStateRoot,
  stageOmnyoStateRoot,
  verifyOmnyoStateRootDatabaseV2,
} from "../src/omnyo-state-root.js";
import {
  createOmnyoRootFixture,
  omnyoRootFixtureOwners,
} from "./omnyo-root-fixture.js";

const roots: string[] = [];

const servers: Server[] = [];

const macTest = test.skipIf(process.platform !== "darwin");

type PendingPhase = OmnyoStateWorkPendingError["progress"]["phase"];

afterEach(async () => {
  for (const server of servers.splice(0))
    if (server.listening)
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );

  for (const root of roots.splice(0)) {
    await rm(root, { recursive: true, force: true });
    await expect(lstat(root)).rejects.toMatchObject({ code: "ENOENT" });
  }
});

async function continuePending<T>(
  operation: () => Promise<T>,
  phases: PendingPhase[] = [],
): Promise<T> {
  for (let calls = 0; calls < 64; calls++) {
    try {
      return await operation();
    } catch (error) {
      if (!(error instanceof OmnyoStateWorkPendingError)) throw error;
      expect(error.progress.entries).toBeGreaterThanOrEqual(0);
      expect(error.progress.bytes).toBeGreaterThanOrEqual(0);
      phases.push(error.progress.phase);
    }
  }

  throw new Error(
    "Owned v2 fixture did not advance within its continuation bound",
  );
}

async function fixture() {
  const value = await createOmnyoRootFixture(undefined, "/private/tmp");
  roots.push(value.root);
  value.input.digestAlgorithm = "state-tree-v2";

  return value;
}

async function bindSource(f: Awaited<ReturnType<typeof fixture>>) {
  const source = await continuePending(() =>
    inspectOmnyoStateRootForAdoptionV2(f.input, f.input.sourceDataDir, {
      role: "source-digest",
    }),
  );

  f.input.expectedSourceDigest = source.digest;

  return source;
}

function destinationAdmission(path: string) {
  const request = readConfiguredOmnyoStateAdmission(path);

  if (request === undefined)
    throw new Error("Missing fixture write-admission owner");

  return request;
}

macTest(
  "resumes v2 staging through typed phase boundaries while retaining opaque bytes, links and one IPC owner",
  async () => {
    const f = await fixture();
    f.input.databaseVerification = "release-producer-v1";
    const outside = join(f.root, "external");
    await mkdir(outside);
    const privateFile = join(outside, "unreadable");
    await writeFile(privateFile, "external user work", { mode: 0o000 });

    const links = {
      external: outside,
      historical: join(f.input.sourceDataDir, "user-file.txt"),
      broken: "absent",
      "cycle-a": "cycle-b",
      "cycle-b": "cycle-a",
    };

    for (const [name, target] of Object.entries(links))
      await symlink(target, join(f.input.sourceDataDir, name));
    const opaque = Buffer.from([0, 255, 1, 128, 13, 10, 0]);
    await writeFile(join(f.input.sourceDataDir, "unknown.blob"), opaque, {
      mode: 0o640,
    });
    await link(
      join(f.input.sourceDataDir, "unknown.blob"),
      join(f.input.sourceDataDir, "unknown.alias"),
    );
    await mkdir(join(f.input.sourceDataDir, "run/mcp"), {
      recursive: true,
      mode: 0o700,
    });
    const socketPath = join(f.input.sourceDataDir, "run/mcp/sentry.sock");
    const server = createServer((socket) => socket.end("original IPC owner"));
    servers.push(server);
    server.listen(socketPath);
    await once(server, "listening");
    await chmod(socketPath, 0o600);
    const originalSocket = await lstat(socketPath);
    const sourceDatabase = join(f.input.sourceDataDir, "bb.db");
    const originalDatabaseBytes = await readFile(sourceDatabase);

    function databaseState(path: string) {
      const database = createDatabaseConnection(path, {
        readonly: true,
      }).$client;

      try {
        return {
          ledger: z
            .array(
              z.object({
                id: z.number().nullable(),
                hash: z.string(),
                created_at: z.number(),
              }),
            )
            .parse(
              database
                .prepare(
                  "SELECT id, hash, created_at FROM __drizzle_migrations ORDER BY id",
                )
                .all(),
            ),
          rows: z
            .array(
              z.object({
                plugin_id: z.string(),
                key: z.string(),
                value: z.string(),
                updated_at: z.number(),
              }),
            )
            .parse(
              database
                .prepare(
                  "SELECT plugin_id, key, value, updated_at FROM plugin_kv ORDER BY plugin_id, key",
                )
                .all(),
            ),
        };
      } finally {
        database.close();
      }
    }

    const originalDatabaseState = databaseState(sourceDatabase);
    await bindSource(f);
    let conversions = 0;
    let inlineDatabaseOpens = 0;

    const owners = {
      ...omnyoRootFixtureOwners,
      openDatabase(path: string) {
        inlineDatabaseOpens++;

        return omnyoRootFixtureOwners.openDatabase(path);
      },
      async prepareDestination(
        stage: Parameters<typeof omnyoRootFixtureOwners.prepareDestination>[0],
      ) {
        conversions++;
        await omnyoRootFixtureOwners.prepareDestination(stage);
        expect(databaseState(stage.databasePath)).toEqual(
          originalDatabaseState,
        );
      },
    };

    const phases: PendingPhase[] = [];

    const interruptedOwners = {
      ...owners,
      async prepareDestination(
        stage: Parameters<typeof omnyoRootFixtureOwners.prepareDestination>[0],
      ) {
        await owners.prepareDestination(stage);
        throw new Error("conversion acknowledgment interrupted");
      },
    };

    await expect(
      continuePending(
        () => stageOmnyoStateRoot(f.input, interruptedOwners),
        phases,
      ),
    ).rejects.toThrow("conversion acknowledgment interrupted");
    expect(conversions).toBe(1);
    const stagedDatabase = join(f.input.jobDir, "root-staging", "app.db");
    const interruptedDatabase = await lstat(stagedDatabase);
    expect(databaseState(stagedDatabase)).toEqual(originalDatabaseState);
    expect(
      z
        .object({ phase: z.literal("copied") })
        .parse(
          JSON.parse(
            await readFile(join(f.input.jobDir, "root-adoption.json"), "utf8"),
          ),
        ).phase,
    ).toBe("copied");

    for (const path of [
      f.input.destinationDataDir,
      join(f.input.jobDir, "write-admission.json"),
    ])
      await expect(lstat(path)).rejects.toMatchObject({ code: "ENOENT" });
    const resumedOwners = { ...owners };
    let releaseDatabaseOpens = 0;

    const binding = await continuePending(async () => {
      try {
        return await stageOmnyoStateRoot(f.input, resumedOwners);
      } catch (error) {
        if (
          error instanceof OmnyoStateWorkPendingError &&
          error.progress.phase === "database-verification"
        ) {
          expect(conversions).toBe(2);
          expect(databaseState(stagedDatabase)).toEqual(originalDatabaseState);
          await expect(
            lstat(join(f.input.jobDir, "write-admission.json")),
          ).rejects.toMatchObject({ code: "ENOENT" });

          const verification = await verifyOmnyoStateRootDatabaseV2(f.input, {
            openReadonlyDatabase(path) {
              releaseDatabaseOpens++;

              return createDatabaseConnection(path, { readonly: true }).$client;
            },
          });

          expect(verification).toMatchObject({
            version: 2,
            verified: true,
            capacityOnly: false,
          });
        }

        throw error;
      }
    }, phases);

    expect(phases).toEqual(
      expect.arrayContaining([
        "clone",
        "clone-verification",
        "acl",
        "database-verification",
        "destination-seal",
        "source-verification",
      ]),
    );
    expect(
      await continuePending(() => stageOmnyoStateRoot(f.input, resumedOwners)),
    ).toEqual(binding);
    expect(conversions).toBe(2);
    expect(releaseDatabaseOpens).toBe(1);
    expect(inlineDatabaseOpens).toBe(0);
    const request = destinationAdmission(f.input.destinationDataDir);
    expect(request.binding).toEqual(binding);
    expect(readOmnyoStateAdmission(request).admission).toBe(0);
    expect(() => assertOmnyoStateWriteAdmission(request)).toThrow(/durable/);
    expect(
      await readFile(join(f.input.destinationDataDir, "unknown.blob")),
    ).toEqual(opaque);
    expect(await readFile(join(f.input.sourceDataDir, "unknown.blob"))).toEqual(
      opaque,
    );

    const [sourceFile, stagedFile, stagedAlias] = await Promise.all([
      lstat(join(f.input.sourceDataDir, "unknown.blob")),
      lstat(join(f.input.destinationDataDir, "unknown.blob")),
      lstat(join(f.input.destinationDataDir, "unknown.alias")),
    ]);

    expect(stagedFile.ino).toBe(stagedAlias.ino);
    expect(stagedFile.ino).not.toBe(sourceFile.ino);

    for (const [name, target] of Object.entries(links))
      expect(await readlink(join(f.input.destinationDataDir, name))).toBe(
        target,
      );
    const bridge = join(f.input.destinationDataDir, "run/mcp/sentry.sock");
    expect(await readlink(bridge)).toBe(socketPath);
    const client = connectSocket(bridge);
    const [response] = await once(client, "data");
    expect(response.toString()).toBe("original IPC owner");
    client.destroy();
    const retainedSocket = await lstat(socketPath);
    expect([
      retainedSocket.dev,
      retainedSocket.ino,
      retainedSocket.mode,
      retainedSocket.uid,
    ]).toEqual([
      originalSocket.dev,
      originalSocket.ino,
      originalSocket.mode,
      originalSocket.uid,
    ]);

    const nativeProof = z
      .object({
        operation: z.literal("digest"),
        fingerprint: z.object({ digest: z.string() }),
      })
      .parse(
        JSON.parse(
          await readFile(
            join(f.input.jobDir, "root-destination-seal-v2.json"),
            "utf8",
          ),
        ),
      );

    expect(nativeProof.fingerprint.digest).toBe(binding.destinationDigest);
    expect(await readOmnyoStateRootJobBindingV2(f.input)).toMatchObject({
      digestAlgorithm: "state-tree-v2",
      sourceDigest: f.input.expectedSourceDigest,
      destinationDigest: binding.destinationDigest,
    });
    await chmod(privateFile, 0o600);
    expect(await readFile(privateFile, "utf8")).toBe("external user work");
    const publishedDatabase = join(f.input.destinationDataDir, "app.db");
    expect((await lstat(publishedDatabase)).ino).toBe(interruptedDatabase.ino);
    expect(databaseState(publishedDatabase)).toEqual(originalDatabaseState);
    expect(await readFile(sourceDatabase)).toEqual(originalDatabaseBytes);
    await admitConfiguredOmnyoStateWrites(f.input.destinationDataDir);
    expect(readOmnyoStateAdmission(request).admission).toBe(1);
    await writeFile(
      join(f.input.destinationDataDir, "new-user-work"),
      "work after admission",
    );
    const database = createDatabaseConnection(publishedDatabase).$client;

    try {
      database
        .prepare(
          "INSERT INTO plugin_kv (plugin_id, key, value, updated_at) VALUES (?, ?, ?, ?)",
        )
        .run(
          "tasks",
          "post-admission",
          JSON.stringify({ id: "new-work", draft: "work after admission" }),
          18,
        );
    } finally {
      database.close();
    }

    await expect(
      continuePending(() => rollBackOmnyoStateRoot(f.input)),
    ).rejects.toThrow(/admitted|forward repair/);
    expect(
      await readFile(join(f.input.destinationDataDir, "new-user-work"), "utf8"),
    ).toBe("work after admission");
    const admittedDatabaseState = databaseState(publishedDatabase);
    expect(admittedDatabaseState.ledger).toEqual(originalDatabaseState.ledger);
    expect(admittedDatabaseState.rows).toEqual(
      expect.arrayContaining([
        ...originalDatabaseState.rows,
        {
          plugin_id: "tasks",
          key: "post-admission",
          value: JSON.stringify({
            id: "new-work",
            draft: "work after admission",
          }),
          updated_at: 18,
        },
      ]),
    );
    expect(readOmnyoStateAdmission(request).admission).toBe(1);
    expect(conversions).toBe(2);
  },
);

macTest(
  "rolls back a sealed v2 profile before the first-write latch idempotently",
  async () => {
    const f = await fixture();
    await bindSource(f);

    const originalDatabase = await readFile(
      join(f.input.sourceDataDir, "bb.db"),
    );

    await continuePending(() =>
      stageOmnyoStateRoot(f.input, omnyoRootFixtureOwners),
    );
    const request = destinationAdmission(f.input.destinationDataDir);
    expect(readOmnyoStateAdmission(request).admission).toBe(0);
    await continuePending(() => rollBackOmnyoStateRoot(f.input));
    await continuePending(() => rollBackOmnyoStateRoot(f.input));
    expect(readOmnyoStateAdmission(request).admission).toBe(2);
    expect(
      await readFile(join(f.input.sourceDataDir, "config.json"), "utf8"),
    ).toBe(f.originalConfig);
    expect(await readFile(join(f.input.sourceDataDir, "bb.db"))).toEqual(
      originalDatabase,
    );
    expect(
      readConfiguredOmnyoStateAdmission(f.input.sourceDataDir),
    ).toBeUndefined();
    await expect(
      admitConfiguredOmnyoStateWrites(f.input.destinationDataDir),
    ).rejects.toThrow(/rollback/);
  },
);

macTest(
  "refuses v2 rollback after the first-write latch while preserving newly admitted user work",
  async () => {
    const f = await fixture();
    await bindSource(f);
    await continuePending(() =>
      stageOmnyoStateRoot(f.input, omnyoRootFixtureOwners),
    );
    const request = destinationAdmission(f.input.destinationDataDir);
    expect(readOmnyoStateAdmission(request).admission).toBe(0);
    await admitConfiguredOmnyoStateWrites(f.input.destinationDataDir);
    await writeFile(
      join(f.input.destinationDataDir, "new-user-work"),
      "work after admission",
    );
    expect(readOmnyoStateAdmission(request).admission).toBe(1);
    await expect(
      continuePending(() => rollBackOmnyoStateRoot(f.input)),
    ).rejects.toThrow(/admitted|forward repair/);
    expect(
      await readFile(join(f.input.destinationDataDir, "new-user-work"), "utf8"),
    ).toBe("work after admission");
    expect(readOmnyoStateAdmission(request).admission).toBe(1);
  },
);

macTest(
  "aborts an actual partial v2 conversion before admission and restores the source idempotently",
  async () => {
    const f = await fixture();
    await bindSource(f);

    const originalDatabase = await readFile(
      join(f.input.sourceDataDir, "bb.db"),
    );

    let conversions = 0;

    const owners = {
      ...omnyoRootFixtureOwners,
      async prepareDestination(
        stage: Parameters<typeof omnyoRootFixtureOwners.prepareDestination>[0],
      ) {
        conversions++;
        await omnyoRootFixtureOwners.prepareDestination(stage);
        const db = createDatabaseConnection(stage.databasePath);

        try {
          db.$client
            .prepare(
              "INSERT INTO plugin_kv (plugin_id, key, value, updated_at) VALUES (?, ?, ?, ?)",
            )
            .run(
              "tasks",
              "partial-conversion",
              JSON.stringify({ changed: true }),
              18,
            );
        } finally {
          db.$client.close();
        }

        await writeFile(
          join(stage.dataDir, "partial-conversion-output"),
          "owned incomplete conversion",
        );
        throw new Error("partial conversion fixture");
      },
    };

    await expect(
      continuePending(() => stageOmnyoStateRoot(f.input, owners)),
    ).rejects.toThrow("partial conversion fixture");
    expect(conversions).toBe(1);
    const staging = join(f.input.jobDir, "root-staging");
    expect(
      await readFile(join(staging, "partial-conversion-output"), "utf8"),
    ).toBe("owned incomplete conversion");
    await expect(
      lstat(join(f.input.jobDir, "write-admission.json")),
    ).rejects.toMatchObject({ code: "ENOENT" });
    await continuePending(() => rollBackOmnyoStateRoot(f.input));
    await continuePending(() => rollBackOmnyoStateRoot(f.input));
    expect(
      await readFile(join(f.input.sourceDataDir, "config.json"), "utf8"),
    ).toBe(f.originalConfig);
    expect(await readFile(join(f.input.sourceDataDir, "bb.db"))).toEqual(
      originalDatabase,
    );
    expect(
      await readFile(join(f.input.sourceDataDir, "user-file.txt"), "utf8"),
    ).toBe("unchanged user work");

    for (const path of [
      staging,
      f.input.destinationDataDir,
      join(f.input.jobDir, "write-admission.json"),
    ])
      await expect(lstat(path)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readOmnyoStateRootJobBindingV2(f.input)).toMatchObject({
      phase: "aborted-before-admission",
      digestAlgorithm: "state-tree-v2",
    });
    await expect(stageOmnyoStateRoot(f.input, owners)).rejects.toThrow(
      /abort|rollback/,
    );
    expect(conversions).toBe(1);
  },
);

macTest(
  "refuses a foreign v2 destination before fencing or creating the first-write latch",
  async () => {
    const f = await fixture();
    await bindSource(f);
    await mkdir(f.input.destinationDataDir, { mode: 0o700 });
    await writeFile(
      join(f.input.destinationDataDir, "foreign-work"),
      "preserve collision",
    );
    await expect(
      stageOmnyoStateRoot(f.input, omnyoRootFixtureOwners),
    ).rejects.toThrow(/collision/);
    expect(
      await readFile(join(f.input.destinationDataDir, "foreign-work"), "utf8"),
    ).toBe("preserve collision");
    expect(
      await readFile(join(f.input.sourceDataDir, "config.json"), "utf8"),
    ).toBe(f.originalConfig);

    for (const name of ["write-admission.json", "root-staging"])
      await expect(lstat(join(f.input.jobDir, name))).rejects.toMatchObject({
        code: "ENOENT",
      });
  },
);
