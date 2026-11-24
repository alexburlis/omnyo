import {
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  admitOmnyoStateWrites,
  assertOmnyoStateWriteAdmission,
  prepareOmnyoStateAdmission,
  selectOmnyoPreWriteRollback,
  type OmnyoStateBinding,
} from "../src/omnyo-state-admission.js";

const fixtures: string[] = [];

async function fixture() {
  const directory = await mkdtemp(
    join(await realpath(tmpdir()), "omnyo-admission-"),
  );

  fixtures.push(directory);

  return {
    journalPath: join(directory, "migration-job", "write-admission.json"),
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
  await Promise.all(
    fixtures
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("Omnyo one-shot state write admission", () => {
  it("requires a prepared closed journal before the first destination writer", async () => {
    const args = await fixture();
    await expect(admitOmnyoStateWrites(args)).rejects.toThrow();
    expect(() => assertOmnyoStateWriteAdmission(args)).toThrow();
    await prepareOmnyoStateAdmission(args);
    expect(() => assertOmnyoStateWriteAdmission(args)).toThrow(
      /durable admission/,
    );
    await admitOmnyoStateWrites(args);
    expect(() => assertOmnyoStateWriteAdmission(args)).not.toThrow();
    await expect(selectOmnyoPreWriteRollback(args)).rejects.toThrow(
      /forward repair/,
    );
  });

  it("keeps rollback forbidden after response loss before any acknowledged write", async () => {
    const args = await fixture();
    await prepareOmnyoStateAdmission(args);

    const interruptedStartup = async () => {
      await admitOmnyoStateWrites(args);
      throw new Error("startup-interrupted-fixture");
    };

    await expect(interruptedStartup()).rejects.toThrow(
      "startup-interrupted-fixture",
    );
    await prepareOmnyoStateAdmission(args);
    await admitOmnyoStateWrites(args);
    await expect(selectOmnyoPreWriteRollback(args)).rejects.toThrow(
      /forward repair/,
    );
  });

  it.each(["before", "after"])(
    "recovers a killed startup %s the durable admission boundary",
    async (boundary) => {
      const args = await fixture();
      await prepareOmnyoStateAdmission(args);

      const moduleUrl = pathToFileURL(
        fileURLToPath(
          new URL("../src/omnyo-state-admission.ts", import.meta.url),
        ),
      ).href;

      const script = `
        import { admitOmnyoStateWrites } from ${JSON.stringify(moduleUrl)};
        const args = JSON.parse(process.argv[1]);
        process.on("message", async () => {
          await admitOmnyoStateWrites(args);
          process.send("after");
        });
        process.send("before");
      `;

      const child = spawn(
        process.execPath,
        [
          "--import",
          "tsx",
          "--input-type=module",
          "--eval",
          script,
          JSON.stringify(args),
        ],
        {
          stdio: ["ignore", "ignore", "ignore", "ipc"],
          env: { PATH: process.env.PATH },
        },
      );

      try {
        expect(
          await once(child, "message", { signal: AbortSignal.timeout(3_000) }),
        ).toEqual(["before", undefined]);

        if (boundary === "after") {
          child.send("admit");
          expect(
            await once(child, "message", {
              signal: AbortSignal.timeout(3_000),
            }),
          ).toEqual(["after", undefined]);
        }
      } finally {
        if (child.exitCode === null && child.signalCode === null) {
          const exited = once(child, "exit", {
            signal: AbortSignal.timeout(3_000),
          });

          child.kill("SIGKILL");
          await exited;
        }
      }

      if (boundary === "before") {
        await selectOmnyoPreWriteRollback(args);
        await expect(admitOmnyoStateWrites(args)).rejects.toThrow(
          /rollback already selected/,
        );
      } else {
        await expect(selectOmnyoPreWriteRollback(args)).rejects.toThrow(
          /forward repair/,
        );
        expect(() => assertOmnyoStateWriteAdmission(args)).not.toThrow();
      }
    },
  );

  it("preserves new work across restart and refuses stale-artifact admission", async () => {
    const args = await fixture();
    await prepareOmnyoStateAdmission(args);
    await admitOmnyoStateWrites(args);
    const newWorkPath = join(fixtures.at(-1) ?? "", "new-work.txt");
    await writeFile(newWorkPath, "new-work-fixture", "utf8");
    const before = await readFile(args.journalPath, "utf8");

    const staleArgs = {
      ...args,
      binding: { ...args.binding, artifactDigest: "d".repeat(64) },
    };

    await expect(admitOmnyoStateWrites(staleArgs)).rejects.toThrow(
      /does not match/,
    );
    await expect(prepareOmnyoStateAdmission(staleArgs)).rejects.toThrow(
      /does not match/,
    );
    expect(await readFile(args.journalPath, "utf8")).toBe(before);
    expect(await readFile(newWorkPath, "utf8")).toBe("new-work-fixture");
  });

  it("selects pre-write rollback durably and prevents later destination admission", async () => {
    const args = await fixture();
    await prepareOmnyoStateAdmission(args);
    await selectOmnyoPreWriteRollback(args);
    await prepareOmnyoStateAdmission(args);
    await selectOmnyoPreWriteRollback(args);
    await expect(admitOmnyoStateWrites(args)).rejects.toThrow(
      /rollback already selected/,
    );
    expect(() => assertOmnyoStateWriteAdmission(args)).toThrow(
      /durable admission/,
    );
  });

  it("serializes racing rollback and write admission into one winning owner", async () => {
    const args = await fixture();
    await prepareOmnyoStateAdmission(args);

    const results = await Promise.allSettled([
      admitOmnyoStateWrites(args),
      selectOmnyoPreWriteRollback(args),
    ]);

    expect(
      results.filter((result) => result.status === "fulfilled"),
    ).toHaveLength(1);
    expect(
      results.filter((result) => result.status === "rejected"),
    ).toHaveLength(1);
  });

  it.each(["not-json", "{}", '{"formatVersion":1,"admission":"closed"}'])(
    "does not initialize over a malformed journal (%s)",
    async (contents) => {
      const args = await fixture();
      await prepareOmnyoStateAdmission(args);
      await writeFile(args.journalPath, contents, "utf8");
      await expect(prepareOmnyoStateAdmission(args)).rejects.toThrow(
        /Invalid Omnyo/,
      );
      await expect(admitOmnyoStateWrites(args)).rejects.toThrow(
        /Invalid Omnyo/,
      );
      await expect(selectOmnyoPreWriteRollback(args)).rejects.toThrow(
        /Invalid Omnyo/,
      );
      expect(await readFile(args.journalPath, "utf8")).toBe(contents);
    },
  );

  it("refuses missing rollback evidence", async () => {
    await expect(
      selectOmnyoPreWriteRollback(await fixture()),
    ).rejects.toThrow();
  });

  it("rejects a journal inside a data root before creating state", async () => {
    const args = await fixture();
    await expect(
      prepareOmnyoStateAdmission({
        ...args,
        journalPath: join(args.binding.destinationDataDir, "journal.json"),
      }),
    ).rejects.toThrow(/must be separate/);
  });

  it("refuses a symlinked journal instead of changing its target", async () => {
    const args = await fixture();
    await prepareOmnyoStateAdmission(args);
    const target = `${args.journalPath}.other`;
    await writeFile(target, "foreign-fixture", "utf8");
    const linkedArgs = { ...args, journalPath: `${args.journalPath}.link` };
    await symlink(target, linkedArgs.journalPath);
    await expect(prepareOmnyoStateAdmission(linkedArgs)).rejects.toThrow(
      /symlinks/,
    );
    expect(await readFile(target, "utf8")).toBe("foreign-fixture");
  });
});
