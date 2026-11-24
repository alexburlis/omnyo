import {
  lstat,
  readFile,
  rename,
  rm,
  unlink,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { z } from "zod";
import { createConnection } from "@omnyo/db";
import { writeJsonFileAtomically } from "../src/json-file.js";
import {
  inspectOmnyoStateRootForAdoptionV2,
  OmnyoStateWorkPendingError,
  readOmnyoStateRootJobBindingV2,
  rollBackOmnyoStateRoot,
  stageOmnyoStateRoot,
  type OmnyoStateRootInput,
} from "../src/omnyo-state-root.js";
import {
  createOmnyoRootFixture,
  omnyoRootFixtureOwners,
} from "./omnyo-root-fixture.js";

const roots: string[] = [];

const macTest = test.skipIf(process.platform !== "darwin");

const jobView = z.object({
  phase: z.string(),
  stagingCreationIntent: z.boolean(),
  stagingDevice: z.string().nullable(),
  stagingInode: z.string().nullable(),
  destinationDigest: z.string().nullable(),
  databaseRenames: z.array(
    z.object({
      suffix: z.string(),
      device: z.string(),
      inode: z.string(),
      mode: z.number(),
    }),
  ),
});

afterEach(async () => {
  for (const root of roots.splice(0)) {
    await rm(root, { recursive: true, force: true });
    await expect(lstat(root)).rejects.toMatchObject({ code: "ENOENT" });
  }
});

async function continuePending<T>(operation: () => Promise<T>): Promise<T> {
  for (let calls = 0; calls < 64; calls++) {
    try {
      return await operation();
    } catch (error) {
      if (!(error instanceof OmnyoStateWorkPendingError)) throw error;
    }
  }

  throw new Error(
    "Interruption fixture did not finish within its continuation bound",
  );
}

async function fixture() {
  const f = await createOmnyoRootFixture(undefined, "/private/tmp");
  roots.push(f.root);
  await writeFile(
    join(f.root, "interruption-owner.json"),
    JSON.stringify({ module: import.meta.url, root: f.root }),
    { flag: "wx", mode: 0o600 },
  );
  f.input.digestAlgorithm = "state-tree-v2";
  f.input.expectedSourceDigest = (
    await continuePending(() =>
      inspectOmnyoStateRootForAdoptionV2(f.input, f.input.sourceDataDir, {
        role: "source-digest",
      }),
    )
  ).digest;

  return f;
}

async function readJob(input: OmnyoStateRootInput) {
  const record = z
    .record(z.string(), z.unknown())
    .parse(
      JSON.parse(
        await readFile(join(input.jobDir, "root-adoption.json"), "utf8"),
      ),
    );

  return { record, job: jobView.parse(record) };
}

async function stageUntil(
  input: OmnyoStateRootInput,
  owners: Parameters<typeof stageOmnyoStateRoot>[1],
  phase: "copied" | "sealed",
) {
  for (let calls = 0; calls < 64; calls++) {
    try {
      await stageOmnyoStateRoot(input, owners);
    } catch (error) {
      if (!(error instanceof OmnyoStateWorkPendingError)) throw error;
      const observed = await readJob(input);

      if (observed.job.phase === phase) return observed;
      continue;
    }

    throw new Error(
      "Fixture published before its requested persisted interruption boundary",
    );
  }

  throw new Error("Interruption fixture did not reach its persisted boundary");
}

async function unpublished(input: OmnyoStateRootInput) {
  for (const path of [
    input.destinationDataDir,
    join(input.jobDir, "write-admission.json"),
  ])
    await expect(lstat(path)).rejects.toMatchObject({ code: "ENOENT" });
}

macTest(
  "reconciles real database rename receipts then refuses sealed drift or a replacement inode before admission",
  async () => {
    const f = await fixture();
    let conversions = 0;

    const owners = {
      ...omnyoRootFixtureOwners,
      async prepareDestination(
        stage: Parameters<typeof omnyoRootFixtureOwners.prepareDestination>[0],
      ) {
        conversions++;
        await omnyoRootFixtureOwners.prepareDestination(stage);
      },
    };

    const copied = await stageUntil(f.input, owners, "copied");
    const stage = join(f.input.jobDir, "root-staging");
    const database = join(stage, "app.db");
    const original = await lstat(database, { bigint: true });
    expect(copied.job.stagingCreationIntent).toBe(true);
    expect(copied.job.databaseRenames).toEqual(
      expect.arrayContaining([
        {
          suffix: "",
          device: original.dev.toString(),
          inode: original.ino.toString(),
          mode: Number(original.mode),
        },
      ]),
    );
    expect(conversions).toBe(0);
    await expect(lstat(join(stage, "bb.db"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    await writeJsonFileAtomically(join(f.input.jobDir, "root-adoption.json"), {
      ...copied.record,
      phase: "renaming-database",
    });
    const preserved = join(f.input.jobDir, "preserved-owner-database");
    await rename(database, preserved);
    await writeFile(database, "foreign replacement bytes", {
      mode: Number(original.mode & 0o7777n),
    });
    const foreign = await lstat(database, { bigint: true });
    expect(foreign.ino).not.toBe(original.ino);
    await expect(stageOmnyoStateRoot(f.input, owners)).rejects.toThrow(
      /database rename identity changed/,
    );
    expect(await readFile(database, "utf8")).toBe("foreign replacement bytes");
    expect((await lstat(preserved, { bigint: true })).ino).toBe(original.ino);
    expect(conversions).toBe(0);
    await unpublished(f.input);
    expect((await lstat(database, { bigint: true })).ino).toBe(foreign.ino);
    await unlink(database);
    await rename(preserved, database);
    expect((await lstat(database, { bigint: true })).ino).toBe(original.ino);
    const sealed = await stageUntil(f.input, owners, "sealed");
    expect(sealed.job.destinationDigest).toMatch(/^[a-f0-9]{64}$/);
    expect((await lstat(database, { bigint: true })).ino).toBe(original.ino);
    expect(conversions).toBe(1);
    await unpublished(f.input);
    await writeFile(
      join(stage, "user-file.txt"),
      "changed after durable sealing",
    );
    await expect(stageOmnyoStateRoot(f.input, owners)).rejects.toThrow(
      /metadata changed|sealed.*changed/,
    );
    expect(await readFile(join(stage, "user-file.txt"), "utf8")).toBe(
      "changed after durable sealing",
    );
    expect(
      await readFile(join(f.input.sourceDataDir, "user-file.txt"), "utf8"),
    ).toBe("unchanged user work");
    expect(conversions).toBe(1);
    await unpublished(f.input);
  },
);

macTest(
  "reconciles a lost final abort marker using the completed disposal receipt without recreating staged work",
  async () => {
    const f = await fixture();

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
        const db = createConnection(stage.databasePath);

        try {
          db.$client
            .prepare(
              "INSERT INTO plugin_kv (plugin_id, key, value, updated_at) VALUES (?, ?, ?, ?)",
            )
            .run(
              "tasks",
              "interrupted-owner",
              JSON.stringify({ changed: true }),
              19,
            );
        } finally {
          db.$client.close();
        }

        await writeFile(
          join(stage.dataDir, "partial-owner-output"),
          "incomplete owned conversion",
        );
        throw new Error("interrupted conversion fixture");
      },
    };

    await expect(
      continuePending(() => stageOmnyoStateRoot(f.input, owners)),
    ).rejects.toThrow("interrupted conversion fixture");
    const stage = join(f.input.jobDir, "root-staging");
    const originalStage = await lstat(stage, { bigint: true });
    expect(await readFile(join(stage, "partial-owner-output"), "utf8")).toBe(
      "incomplete owned conversion",
    );
    await continuePending(() => rollBackOmnyoStateRoot(f.input));
    const completed = await readJob(f.input);
    expect(completed.job.phase).toBe("aborted-before-admission");
    expect(completed.job.stagingDevice).toBeNull();
    expect(completed.job.stagingInode).toBeNull();
    const discardPath = join(f.input.jobDir, "root-abort-discard-v1.json");
    const discardBytes = await readFile(discardPath);

    const discard = z
      .object({
        complete: z.literal(true),
        device: z.string(),
        inode: z.string(),
        removed: z.number().positive(),
        stack: z.array(z.unknown()).length(0),
      })
      .parse(JSON.parse(discardBytes.toString()));

    expect([discard.device, discard.inode]).toEqual([
      originalStage.dev.toString(),
      originalStage.ino.toString(),
    ]);
    await writeJsonFileAtomically(join(f.input.jobDir, "root-adoption.json"), {
      ...completed.record,
      phase: "aborting-before-admission",
      stagingDevice: originalStage.dev.toString(),
      stagingInode: originalStage.ino.toString(),
      destinationDigest: null,
    });
    await continuePending(() => rollBackOmnyoStateRoot(f.input));
    await continuePending(() => rollBackOmnyoStateRoot(f.input));
    expect(await readOmnyoStateRootJobBindingV2(f.input)).toMatchObject({
      phase: "aborted-before-admission",
      destinationDigest: null,
    });
    expect(await readFile(discardPath)).toEqual(discardBytes);
    expect(
      await readFile(join(f.input.sourceDataDir, "config.json"), "utf8"),
    ).toBe(f.originalConfig);
    expect(await readFile(join(f.input.sourceDataDir, "bb.db"))).toEqual(
      originalDatabase,
    );
    expect(
      await readFile(join(f.input.sourceDataDir, "user-file.txt"), "utf8"),
    ).toBe("unchanged user work");
    await expect(lstat(stage)).rejects.toMatchObject({ code: "ENOENT" });
    await unpublished(f.input);
    expect(conversions).toBe(1);
  },
);
