import {
  mkdtemp,
  mkdir,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import {
  resolveProdDataDir,
  resolveDataDirDatabasePath,
} from "../src/runtime.js";
import {
  prepareOmnyoStateAdmission,
  selectOmnyoPreWriteRollback,
} from "../src/omnyo-state-admission.js";
import {
  admitConfiguredOmnyoStateWrites,
  retireCompletedOmnyoStateAdmissionV1,
} from "../src/omnyo-state-startup.js";

const fixtures: string[] = [];

afterEach(async () => {
  for (const path of fixtures.splice(0))
    await rm(path, { recursive: true, force: true });
});

async function fixture() {
  const homeDir = await mkdtemp(join(await realpath(tmpdir()), "omnyo-roots-"));
  fixtures.push(homeDir);

  return homeDir;
}

test("fresh profile selects the canonical root and neutral database filename", async () => {
  const homeDir = await fixture();
  expect(resolveProdDataDir({ homeDir })).toBe(join(homeDir, ".omnyo"));
  expect(resolveDataDirDatabasePath({ dataDir: join(homeDir, ".omnyo") })).toBe(
    join(homeDir, ".omnyo", "app.db"),
  );
});

async function retirementFixture() {
  const homeDir = await fixture();
  const sourceDataDir = join(homeDir, "source");
  const destinationDataDir = join(homeDir, "destination");
  await mkdir(destinationDataDir);

  const admission = {
    journalPath: join(homeDir, "protected-job", "write-admission.json"),
    binding: {
      migrationId: "retirement-fixture",
      sourceDataDir,
      destinationDataDir,
      sourceDigest: "a".repeat(64),
      destinationDigest: "b".repeat(64),
      artifactDigest: "c".repeat(64),
    },
  };

  await writeFile(
    join(destinationDataDir, "config.json"),
    JSON.stringify({ serverUrl: "http://kept", stateMigration: admission }),
  );
  await prepareOmnyoStateAdmission(admission);

  return { admission, destinationDataDir, sourceDataDir };
}

async function storedConfig(dataDir: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(join(dataDir, "config.json"), "utf8"));
}

test("retires the completed migration record once the legacy root is gone", async () => {
  const f = await retirementFixture();
  await admitConfiguredOmnyoStateWrites(f.destinationDataDir);

  await expect(
    retireCompletedOmnyoStateAdmissionV1(f.destinationDataDir),
  ).resolves.toBe(true);
  await expect(storedConfig(f.destinationDataDir)).resolves.toEqual({
    serverUrl: "http://kept",
  });
  await expect(
    retireCompletedOmnyoStateAdmissionV1(f.destinationDataDir),
  ).resolves.toBe(false);
  await expect(
    admitConfiguredOmnyoStateWrites(f.destinationDataDir),
  ).resolves.toBeUndefined();
});

test("retires the record when the legacy root is an empty directory", async () => {
  const f = await retirementFixture();
  await mkdir(f.sourceDataDir);
  await admitConfiguredOmnyoStateWrites(f.destinationDataDir);

  await expect(
    retireCompletedOmnyoStateAdmissionV1(f.destinationDataDir),
  ).resolves.toBe(true);
});

test("keeps the record while the legacy root still holds data", async () => {
  const f = await retirementFixture();
  await mkdir(f.sourceDataDir);
  await writeFile(join(f.sourceDataDir, "retained"), "worker copy");
  await admitConfiguredOmnyoStateWrites(f.destinationDataDir);

  await expect(
    retireCompletedOmnyoStateAdmissionV1(f.destinationDataDir),
  ).resolves.toBe(false);
  await expect(storedConfig(f.destinationDataDir)).resolves.toHaveProperty(
    "stateMigration",
  );
});

test("keeps the record until the journal shows final write admission", async () => {
  const f = await retirementFixture();

  await expect(
    retireCompletedOmnyoStateAdmissionV1(f.destinationDataDir),
  ).resolves.toBe(false);
  await selectOmnyoPreWriteRollback(f.admission);
  await expect(
    retireCompletedOmnyoStateAdmissionV1(f.destinationDataDir),
  ).resolves.toBe(false);
  await expect(storedConfig(f.destinationDataDir)).resolves.toHaveProperty(
    "stateMigration",
  );
});

test("does nothing for a profile without a migration record", async () => {
  const homeDir = await fixture();
  await writeFile(join(homeDir, "config.json"), "{}");

  await expect(retireCompletedOmnyoStateAdmissionV1(homeDir)).resolves.toBe(
    false,
  );
});
