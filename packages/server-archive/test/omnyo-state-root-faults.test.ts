import { readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import {
  readConfiguredOmnyoStateAdmission,
  admitConfiguredOmnyoStateWrites,
} from "@omnyo/config/omnyo-state-startup";
import {
  stageOmnyoStateRoot,
  rollBackOmnyoStateRoot,
} from "../src/omnyo-state-root.js";
import { assertOmnyoStateWriteAdmission } from "@omnyo/config/omnyo-state-admission";
import {
  createOmnyoRootFixture,
  omnyoRootFixtureOwners,
} from "./omnyo-root-fixture.js";

const fault = vi.hoisted(() => ({ point: "", destination: "" }));

vi.mock("node:fs/promises", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:fs/promises")>();

  return {
    ...original,
    open: async (...args: Parameters<typeof original.open>) => {
      const handle = await original.open(...args);

      return new Proxy(handle, {
        get(target, property) {
          if (property === "sync")
            return async () => {
              if (
                String(args[0]) === fault.destination &&
                fault.point === "admission-before-sync"
              )
                throw new Error("admission-sync-fixture");
              await target.sync();

              if (
                String(args[0]) === fault.destination &&
                fault.point === "admission-after-sync"
              )
                throw new Error("admission-sync-response-loss-fixture");
            };

          const value: unknown = Reflect.get(target, property, target);

          return typeof value === "function" ? value.bind(target) : value;
        },
      });
    },
    copyFile: async (...args: Parameters<typeof original.copyFile>) => {
      if (String(args[1]) === fault.destination && fault.point === "before")
        throw new Error("backup-before-fixture");
      await original.copyFile(...args);

      if (String(args[1]) === fault.destination && fault.point === "after")
        throw new Error("backup-response-loss-fixture");
    },
    rename: async (...args: Parameters<typeof original.rename>) => {
      if (String(args[1]) === fault.destination && fault.point === "before")
        throw new Error("publication-before-fixture");
      await original.rename(...args);

      if (String(args[1]) === fault.destination && fault.point === "after")
        throw new Error("publication-response-loss-fixture");
    },
  };
});

const roots: string[] = [];

afterEach(async () => {
  fault.point = "";
  fault.destination = "";

  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});

test.each(["before", "after"])(
  "resumes %s publication response failure without replaying conversion or admitting writes",
  async (point) => {
    const fixture = await createOmnyoRootFixture();
    roots.push(fixture.root);
    fault.destination = fixture.input.destinationDataDir;
    fault.point = point;
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

    await expect(stageOmnyoStateRoot(fixture.input, owners)).rejects.toThrow(
      /publication/,
    );
    expect(existsSync(fixture.input.destinationDataDir)).toBe(
      point === "after",
    );
    fault.point = "";
    const binding = await stageOmnyoStateRoot(fixture.input, owners);
    expect(conversions).toBe(1);

    const admission = readConfiguredOmnyoStateAdmission(
      fixture.input.destinationDataDir,
    );

    expect(admission?.binding).toEqual(binding);

    if (admission === undefined)
      throw new Error("Missing publication admission");
    expect(() => assertOmnyoStateWriteAdmission(admission)).toThrow(/durable/);
    expect(
      await readFile(
        join(fixture.input.destinationDataDir, "user-file.txt"),
        "utf8",
      ),
    ).toBe("unchanged user work");
  },
);

test.each([
  ["admission-before-sync", "admission"],
  ["admission-after-sync", "admission"],
  ["before", "stage-config"],
  ["after", "stage-config"],
])(
  "resumes sealed conversion after %s at %s without replaying database conversion",
  async (point, target) => {
    const fixture = await createOmnyoRootFixture();
    roots.push(fixture.root);
    fault.destination =
      target === "admission"
        ? join(fixture.input.jobDir, "write-admission.json")
        : join(fixture.input.jobDir, "root-staging", "config.json");
    fault.point = point;
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

    await expect(stageOmnyoStateRoot(fixture.input, owners)).rejects.toThrow(
      /fixture/,
    );
    fault.point = "";
    expect(existsSync(fixture.input.destinationDataDir)).toBe(false);
    await stageOmnyoStateRoot(fixture.input, owners);
    expect(conversions).toBe(1);
    await rollBackOmnyoStateRoot(fixture.input);
    expect(
      await readFile(join(fixture.input.sourceDataDir, "config.json"), "utf8"),
    ).toBe(fixture.originalConfig);
  },
);

test.each(["before", "after"])(
  "resumes %s original-configuration backup failure without fencing or changing source work",
  async (point) => {
    const fixture = await createOmnyoRootFixture();
    roots.push(fixture.root);
    fault.destination = join(fixture.input.jobDir, "source-config.json");
    fault.point = point;
    await expect(
      stageOmnyoStateRoot(fixture.input, omnyoRootFixtureOwners),
    ).rejects.toThrow(/backup/);
    expect(
      await readFile(join(fixture.input.sourceDataDir, "config.json"), "utf8"),
    ).toBe(fixture.originalConfig);
    fault.point = "";
    await stageOmnyoStateRoot(fixture.input, omnyoRootFixtureOwners);
    await rollBackOmnyoStateRoot(fixture.input);
    expect(
      await readFile(join(fixture.input.sourceDataDir, "config.json"), "utf8"),
    ).toBe(fixture.originalConfig);
  },
);

test("refuses publication reconciliation when a stopped source changes or a staged directory is replaced", async () => {
  const fixture = await createOmnyoRootFixture();
  roots.push(fixture.root);
  fault.destination = fixture.input.destinationDataDir;
  fault.point = "before";
  await expect(
    stageOmnyoStateRoot(fixture.input, omnyoRootFixtureOwners),
  ).rejects.toThrow(/publication/);
  fault.point = "";
  await writeFile(
    join(fixture.input.sourceDataDir, "user-file.txt"),
    "new source work",
  );
  await expect(
    stageOmnyoStateRoot(fixture.input, omnyoRootFixtureOwners),
  ).rejects.toThrow(/stopped source changed/);
  expect(existsSync(fixture.input.destinationDataDir)).toBe(false);
  await writeFile(
    join(fixture.input.sourceDataDir, "user-file.txt"),
    "unchanged user work",
  );
  const stage = join(fixture.input.jobDir, "root-staging");
  const original = await import("node:fs/promises");
  await original.rename(
    stage,
    join(fixture.input.jobDir, "preserved-original-stage"),
  );
  await original.mkdir(stage);
  await writeFile(join(stage, "foreign-work"), "preserve this collision");
  await expect(
    stageOmnyoStateRoot(fixture.input, omnyoRootFixtureOwners),
  ).rejects.toThrow(/identity changed/);
  expect(await readFile(join(stage, "foreign-work"), "utf8")).toBe(
    "preserve this collision",
  );
  await expect(
    admitConfiguredOmnyoStateWrites(fixture.input.sourceDataDir),
  ).rejects.toThrow(/destination/);
  expect(() =>
    readConfiguredOmnyoStateAdmission(fixture.input.sourceDataDir),
  ).toThrow(/destination/);
});

test.each(["before", "after"])(
  "resumes %s source configuration restoration failure after rollback is durably selected",
  async (point) => {
    const fixture = await createOmnyoRootFixture();
    roots.push(fixture.root);
    await stageOmnyoStateRoot(fixture.input, omnyoRootFixtureOwners);
    fault.destination = join(fixture.input.sourceDataDir, "config.json");
    fault.point = point;
    await expect(rollBackOmnyoStateRoot(fixture.input)).rejects.toThrow(
      /publication/,
    );
    await expect(
      admitConfiguredOmnyoStateWrites(fixture.input.destinationDataDir),
    ).rejects.toThrow(/rollback/);
    fault.point = "";
    await rollBackOmnyoStateRoot(fixture.input);
    await rollBackOmnyoStateRoot(fixture.input);
    expect(await readFile(fault.destination, "utf8")).toBe(
      fixture.originalConfig,
    );
    expect(
      await readFile(
        join(fixture.input.sourceDataDir, "user-file.txt"),
        "utf8",
      ),
    ).toBe("unchanged user work");
  },
);
