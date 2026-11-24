import { existsSync } from "node:fs";
import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { admitConfiguredOmnyoStateWrites } from "@omnyo/config/omnyo-state-startup";
import {
  readMaintenanceHold,
  writeMaintenanceHold,
} from "../src/maintenance-hold.js";
import {
  assertOmnyoStagedStateRoot,
  inspectOmnyoStateRoot,
  rollBackOmnyoStateRoot,
  stageOmnyoStateRoot,
} from "../src/omnyo-state-root.js";
import { createOmnyoWorkerRootFixture } from "./omnyo-worker-root-fixture.js";

const roots: string[] = [];

afterEach(async () => {
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});

test("adopts a genuinely promoted worker without creating SQLite and preserves work after first admission", async () => {
  const f = await createOmnyoWorkerRootFixture();
  roots.push(f.root);
  let attempts = 0;

  const owners = {
    prepareDestination: async (
      stage: Parameters<typeof assertOmnyoStagedStateRoot>[0],
    ) => {
      await assertOmnyoStagedStateRoot(stage);
      expect(stage.databaseState).toBe("absent-worker");
      attempts++;

      if (attempts === 1) throw new Error("interrupted conversion");
    },
  };

  await expect(stageOmnyoStateRoot(f.input, owners)).rejects.toThrow(
    "interrupted conversion",
  );
  expect(existsSync(f.input.destinationDataDir)).toBe(false);
  await stageOmnyoStateRoot(f.input, owners);
  await stageOmnyoStateRoot(f.input, owners);
  expect(attempts).toBe(2);
  expect(existsSync(join(f.input.destinationDataDir, "app.db"))).toBe(false);
  expect(
    await readFile(join(f.input.destinationDataDir, "user-file.txt"), "utf8"),
  ).toBe("unchanged user work");
  await admitConfiguredOmnyoStateWrites(f.input.destinationDataDir);
  await writeFile(
    join(f.input.destinationDataDir, "new-work"),
    "after admission",
  );
  await expect(rollBackOmnyoStateRoot(f.input)).rejects.toThrow(
    "Omnyo writers were admitted; use forward repair",
  );
  expect(
    await readFile(join(f.input.destinationDataDir, "new-work"), "utf8"),
  ).toBe("after admission");
});

test("refuses fabricated worker identity fields and orphaned database sidecars", async () => {
  const f = await createOmnyoWorkerRootFixture();
  roots.push(f.root);
  await writeFile(join(f.input.sourceDataDir, "bb.db-wal"), "orphaned sidecar");

  const input = {
    ...f.input,
    expectedSourceDigest: (await inspectOmnyoStateRoot(f.input.sourceDataDir))
      .digest,
  };

  await expect(
    stageOmnyoStateRoot(input, {
      prepareDestination: async () => {
        throw new Error("unexpected writer");
      },
    }),
  ).rejects.toThrow(/database state is incomplete/iu);
  expect(existsSync(join(f.input.destinationDataDir, "app.db"))).toBe(false);
  const hold = readMaintenanceHold(f.input.sourceDataDir);

  if (hold === null) throw new Error("fixture hold missing");
  await writeMaintenanceHold(f.input.sourceDataDir, {
    ...hold,
    identityAdoption: hold.identityAdoption && {
      ...hold.identityAdoption,
      jobDir: join(f.root, "foreign-job"),
    },
  });
  await rm(join(f.input.sourceDataDir, "bb.db-wal"));
  await expect(
    stageOmnyoStateRoot(
      {
        ...f.input,
        expectedSourceDigest: (
          await inspectOmnyoStateRoot(f.input.sourceDataDir)
        ).digest,
      },
      {
        prepareDestination: async () => {
          throw new Error("unexpected writer");
        },
      },
    ),
  ).rejects.toThrow();
});
