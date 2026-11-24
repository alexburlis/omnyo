import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  admitOmnyoStateWrites,
  prepareOmnyoStateAdmission,
  selectOmnyoPreWriteRollback,
  type OmnyoStateBinding,
} from "../src/omnyo-state-admission.js";

const faults = vi.hoisted(() => ({ point: "", directory: "" }));

vi.mock("node:fs/promises", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:fs/promises")>();

  return {
    ...original,
    open: async (...args: Parameters<typeof original.open>) => {
      const handle = await original.open(...args);

      return new Proxy(handle, {
        get(target, property) {
          if (property === "sync") {
            return async () => {
              if (
                (faults.point === "file-sync" &&
                  String(args[0]).endsWith(".json")) ||
                (faults.point === "directory-sync" &&
                  args[0] === faults.directory)
              ) {
                throw new Error("sync-fault-fixture");
              }

              await target.sync();
            };
          }

          if (property === "write") {
            return async (...writeArgs: Parameters<typeof target.write>) => {
              if (faults.point === "before-state-write")
                throw new Error("write-fault-fixture");

              const result = await Reflect.apply(
                target.write,
                target,
                writeArgs,
              );

              if (faults.point === "after-state-write")
                throw new Error("write-response-loss-fixture");

              return result;
            };
          }

          const value: unknown = Reflect.get(target, property, target);

          return typeof value === "function" ? value.bind(target) : value;
        },
      });
    },
  };
});

const fixtures: string[] = [];

async function fixture() {
  const directory = await mkdtemp(
    join(await realpath(tmpdir()), "omnyo-admission-fault-"),
  );

  fixtures.push(directory);
  faults.directory = join(directory, "migration-job");

  return {
    journalPath: join(faults.directory, "write-admission.json"),
    binding: {
      migrationId: "migration-fixture",
      sourceDataDir: join(directory, "source"),
      destinationDataDir: join(directory, "destination"),
      sourceDigest: "a".repeat(64),
      destinationDigest: "b".repeat(64),
      artifactDigest: "c".repeat(64),
    } satisfies OmnyoStateBinding,
  };
}

afterEach(async () => {
  faults.point = "";
  faults.directory = "";
  await Promise.all(
    fixtures
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("Omnyo admission durable-boundary faults", () => {
  it.each(["before-state-write", "directory-sync"])(
    "refuses writers when %s fails before the admission byte write",
    async (point) => {
      const args = await fixture();
      await prepareOmnyoStateAdmission(args);
      const before = await readFile(args.journalPath, "utf8");
      faults.point = point;
      await expect(admitOmnyoStateWrites(args)).rejects.toThrow(
        /fault-fixture/,
      );
      expect(await readFile(args.journalPath, "utf8")).toBe(before);
      faults.point = "";
      await selectOmnyoPreWriteRollback(args);
      await expect(admitOmnyoStateWrites(args)).rejects.toThrow(
        /rollback already selected/,
      );
    },
  );

  it.each(["after-state-write", "file-sync"])(
    "treats %s response loss as possibly admitted and never rolls back",
    async (point) => {
      const args = await fixture();
      await prepareOmnyoStateAdmission(args);
      faults.point = point;
      await expect(admitOmnyoStateWrites(args)).rejects.toThrow(/fixture/);
      faults.point = "";
      await expect(selectOmnyoPreWriteRollback(args)).rejects.toThrow(
        /forward repair/,
      );
      faults.point = "file-sync";
      await expect(admitOmnyoStateWrites(args)).rejects.toThrow(
        /sync-fault-fixture/,
      );
      faults.point = "";
      await admitOmnyoStateWrites(args);
    },
  );

  it("uses file durability on Windows without attempting unsupported directory flushes", async () => {
    const first = await fixture();
    await prepareOmnyoStateAdmission(first);
    const args = await fixture();
    const descriptor = Object.getOwnPropertyDescriptor(process, "platform");

    if (descriptor === undefined)
      throw new Error("Missing platform descriptor");
    Object.defineProperty(process, "platform", { value: "win32" });
    faults.point = "directory-sync";

    try {
      await prepareOmnyoStateAdmission(args);
      await admitOmnyoStateWrites(args);
      await expect(selectOmnyoPreWriteRollback(args)).rejects.toThrow(
        /forward repair/,
      );
    } finally {
      Object.defineProperty(process, "platform", descriptor);
    }
  });
});
