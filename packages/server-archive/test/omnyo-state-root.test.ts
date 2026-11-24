import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { createConnection } from "@omnyo/db";
import {
  admitConfiguredOmnyoStateWrites,
  readConfiguredOmnyoStateAdmission,
} from "@omnyo/config/omnyo-state-startup";
import { assertOmnyoStateWriteAdmission } from "@omnyo/config/omnyo-state-admission";
import {
  inspectOmnyoStateRoot,
  stageOmnyoStateRoot,
  rollBackOmnyoStateRoot,
  assertOmnyoStagedStateRoot,
} from "../src/omnyo-state-root.js";
import {
  createOmnyoRootFixture,
  omnyoRootFixtureOwners,
} from "./omnyo-root-fixture.js";

const roots: string[] = [];

afterEach(async () => {
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});

async function fixture() {
  const value = await createOmnyoRootFixture();
  roots.push(value.root);

  return value;
}

test("stages the full stopped profile without losing unknown files, host state, IDs or permissions", async () => {
  const f = await fixture();
  let migrations = 0;

  const owners = {
    ...omnyoRootFixtureOwners,
    async prepareDestination(
      stage: Parameters<typeof assertOmnyoStagedStateRoot>[0],
    ) {
      await assertOmnyoStagedStateRoot(stage);
      migrations++;
      await omnyoRootFixtureOwners.prepareDestination(stage);
    },
  };

  const binding = await stageOmnyoStateRoot(f.input, owners);
  expect(await stageOmnyoStateRoot(f.input, owners)).toEqual(binding);
  expect(migrations).toBe(1);
  expect((await inspectOmnyoStateRoot(f.input.sourceDataDir)).digest).toBe(
    f.input.expectedSourceDigest,
  );
  expect(
    await readFile(join(f.input.destinationDataDir, "user-file.txt"), "utf8"),
  ).toBe("unchanged user work");
  expect(
    (await stat(join(f.input.destinationDataDir, "user-file.txt"))).mode &
      0o777,
  ).toBe(0o640);
  expect(
    await readFile(
      join(f.input.destinationDataDir, "plugins/tasks/host-data/opaque-state"),
      "utf8",
    ),
  ).toBe("preserved plugin host state");
  expect(() =>
    readConfiguredOmnyoStateAdmission(f.input.sourceDataDir),
  ).toThrow(/destination/);

  const admission = readConfiguredOmnyoStateAdmission(
    f.input.destinationDataDir,
  );

  if (admission === undefined) throw new Error("Missing destination admission");
  expect(() => assertOmnyoStateWriteAdmission(admission)).toThrow(/durable/);
  const db = createConnection(join(f.input.destinationDataDir, "app.db"));

  try {
    expect(
      db.$client
        .prepare(
          "SELECT value FROM plugin_kv WHERE plugin_id = 'tasks' AND key = 'migration-fixture'",
        )
        .get(),
    ).toEqual({
      value: JSON.stringify({ draft: "unchanged draft", id: "stable-id" }),
    });
  } finally {
    db.$client.close();
  }
});

test("adopts updater filenames without replaying pending intent or changing unknown bytes", async () => {
  const f = await fixture();

  const previous = {
    kind: "npm",
    packageRoot: join(
      f.input.sourceDataDir,
      "app-versions",
      "previous",
      "node_modules",
      "bb-app",
    ),
    version: "0.46.241+private.1",
  } as const;

  const intended = {
    kind: "npm",
    packageRoot: join(
      f.input.sourceDataDir,
      "app-versions",
      "intended",
      "node_modules",
      "bb-app",
    ),
    version: "0.46.242+private.1",
  } as const;

  const raw = `${JSON.stringify(
    {
      schemaVersion: 1,
      current: { ...previous, nodeAbi: "127" },
      pending: {
        id: "original-updater-request",
        from: previous,
        to: intended,
        requestedAt: "2026-11-04T00:00:00.000Z",
      },
      lastResult: null,
      unknown: { draft: "retained user work", future: [1, "untouched"] },
    },
    null,
    2,
  )}\n`;

  const original = join(f.input.sourceDataDir, "bb-app-update.json");
  await writeFile(original, raw, { mode: 0o640 });
  f.input.expectedSourceDigest = (
    await inspectOmnyoStateRoot(f.input.sourceDataDir)
  ).digest;
  const binding = await stageOmnyoStateRoot(f.input, omnyoRootFixtureOwners);
  const adopted = join(f.input.destinationDataDir, "omnyo-app-update.json");

  expect(await readFile(adopted, "utf8")).toBe(raw);
  expect(await readFile(original, "utf8")).toBe(raw);
  expect((await stat(adopted)).mode & 0o777).toBe(0o640);
  expect(
    existsSync(join(f.input.destinationDataDir, "bb-app-update.json")),
  ).toBe(false);
  expect(await stageOmnyoStateRoot(f.input, omnyoRootFixtureOwners)).toEqual(
    binding,
  );

  const admission = readConfiguredOmnyoStateAdmission(
    f.input.destinationDataDir,
  );

  if (admission === undefined) throw new Error("Missing destination admission");
  expect(() => assertOmnyoStateWriteAdmission(admission)).toThrow(/durable/);
});

test("refuses destination collision, changed source and a live runtime before fencing", async () => {
  const f = await fixture();
  await mkdir(f.input.destinationDataDir);
  await writeFile(join(f.input.destinationDataDir, "work"), "foreign work");
  await expect(
    stageOmnyoStateRoot(f.input, omnyoRootFixtureOwners),
  ).rejects.toThrow(/collision/);
  expect(
    await readFile(join(f.input.sourceDataDir, "config.json"), "utf8"),
  ).toBe(f.originalConfig);
  await rm(f.input.destinationDataDir, { recursive: true });
  await writeFile(
    join(f.input.sourceDataDir, "user-file.txt"),
    "newer user work",
  );
  await expect(
    stageOmnyoStateRoot(f.input, omnyoRootFixtureOwners),
  ).rejects.toThrow(/source changed/);
  await writeFile(
    join(f.input.sourceDataDir, "bb-app-runtime.json"),
    JSON.stringify({
      pid: process.pid,
      entryPath: "/installed/bb-app/dist/bb-app.js",
      surface: "host-daemon",
      serverUrl: "http://127.0.0.1:1",
      startedAt: new Date().toISOString(),
      version: "0.46.238+private.1",
    }),
  );
  await expect(
    stageOmnyoStateRoot(f.input, omnyoRootFixtureOwners),
  ).rejects.toThrow(/Stop the existing runtime/);
  expect(existsSync(f.input.destinationDataDir)).toBe(false);
});

test("refuses a malformed legacy runtime record before copying or fencing", async () => {
  const f = await fixture();
  await writeFile(
    join(f.input.sourceDataDir, "bb-app-runtime.json"),
    JSON.stringify({ pid: process.pid }),
  );
  await expect(
    stageOmnyoStateRoot(f.input, omnyoRootFixtureOwners),
  ).rejects.toThrow();
  expect(
    await readFile(join(f.input.sourceDataDir, "config.json"), "utf8"),
  ).toBe(f.originalConfig);
  expect(existsSync(f.input.destinationDataDir)).toBe(false);
});

test("resumes a conversion failure idempotently while the original remains fenced and unchanged", async () => {
  const f = await fixture();
  let first = true;
  await expect(
    stageOmnyoStateRoot(f.input, {
      ...omnyoRootFixtureOwners,
      async prepareDestination(stage) {
        await omnyoRootFixtureOwners.prepareDestination(stage);

        if (first) {
          first = false;
          throw new Error("interrupted conversion fixture");
        }
      },
    }),
  ).rejects.toThrow(/interrupted conversion/);
  expect(() =>
    readConfiguredOmnyoStateAdmission(f.input.sourceDataDir),
  ).toThrow(/destination/);
  expect((await inspectOmnyoStateRoot(f.input.sourceDataDir)).digest).toBe(
    f.input.expectedSourceDigest,
  );
  await stageOmnyoStateRoot(f.input, omnyoRootFixtureOwners);
  expect(existsSync(join(f.input.destinationDataDir, "app.db"))).toBe(true);
});

test("pre-write rollback restores original configuration and permanently fences the staged destination", async () => {
  const f = await fixture();
  await stageOmnyoStateRoot(f.input, omnyoRootFixtureOwners);
  await rollBackOmnyoStateRoot(f.input);
  expect(
    await readFile(join(f.input.sourceDataDir, "config.json"), "utf8"),
  ).toBe(f.originalConfig);
  await expect(
    admitConfiguredOmnyoStateWrites(f.input.destinationDataDir),
  ).rejects.toThrow(/rollback already selected/);
});

test("post-admission work forbids source rollback and survives repeated owner reconciliation", async () => {
  const f = await fixture();
  const binding = await stageOmnyoStateRoot(f.input, omnyoRootFixtureOwners);
  await admitConfiguredOmnyoStateWrites(f.input.destinationDataDir);
  await writeFile(
    join(f.input.destinationDataDir, "new-user-work"),
    "new work after admission",
  );
  await expect(rollBackOmnyoStateRoot(f.input)).rejects.toThrow(
    /state changed|forward repair/,
  );
  expect(await stageOmnyoStateRoot(f.input, omnyoRootFixtureOwners)).toEqual(
    binding,
  );
  expect(
    await readFile(join(f.input.destinationDataDir, "new-user-work"), "utf8"),
  ).toBe("new work after admission");
});

test("rollback removes only the migration-created configuration when the stopped source had none", async () => {
  const f = await fixture();
  const sourceConfig = join(f.input.sourceDataDir, "config.json");
  await rm(sourceConfig);
  const source = await inspectOmnyoStateRoot(f.input.sourceDataDir);
  const input = { ...f.input, expectedSourceDigest: source.digest };
  await stageOmnyoStateRoot(input, omnyoRootFixtureOwners);
  expect(existsSync(sourceConfig)).toBe(true);
  await rollBackOmnyoStateRoot(input);
  await rollBackOmnyoStateRoot(input);
  expect(existsSync(sourceConfig)).toBe(false);
  expect((await inspectOmnyoStateRoot(input.sourceDataDir)).digest).toBe(
    source.digest,
  );
  await expect(
    admitConfiguredOmnyoStateWrites(input.destinationDataDir),
  ).rejects.toThrow(/rollback/);
});

test("refuses a changed original-configuration backup before selecting rollback", async () => {
  const f = await fixture();
  await stageOmnyoStateRoot(f.input, omnyoRootFixtureOwners);
  await writeFile(
    join(f.input.jobDir, "source-config.json"),
    "foreign replacement",
  );
  await expect(rollBackOmnyoStateRoot(f.input)).rejects.toThrow(
    /backup changed/,
  );
  expect(() =>
    readConfiguredOmnyoStateAdmission(f.input.sourceDataDir),
  ).toThrow(/destination/);

  const admission = readConfiguredOmnyoStateAdmission(
    f.input.destinationDataDir,
  );

  if (admission === undefined)
    throw new Error("Missing preserved destination admission");
  expect(() => assertOmnyoStateWriteAdmission(admission)).toThrow(/durable/);
});
