import {
  lstat,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, onTestFinished, test } from "vitest";
import { z } from "zod";
import { mutateManagedJsonFile } from "../src/managed-json-file.js";

const schema = z
  .object({ counter: z.number(), draft: z.string() })
  .passthrough();

async function fixture() {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "omnyo-managed-json-")),
  );

  const path = join(root, "settings.json");
  onTestFinished(() => rm(root, { recursive: true, force: true }));

  const value = {
    counter: 0,
    draft: "uncommitted user work",
    unknown: { future: [1, "untouched"] },
  };

  await writeFile(path, `${JSON.stringify(value)}\n`, { mode: 0o640 });

  return {
    root,
    path,
    value,
    read: async () => schema.parse(JSON.parse(await readFile(path, "utf8"))),
  };
}

test("serializes concurrent current-owner writes while preserving unknown user fields and the existing private output mode", async () => {
  const f = await fixture();
  await Promise.all(
    Array.from({ length: 8 }, () =>
      mutateManagedJsonFile({
        path: f.path,
        read: f.read,
        mutate: (current) => ({ ...current, counter: current.counter + 1 }),
      }),
    ),
  );
  expect(await f.read()).toEqual({ ...f.value, counter: 8 });

  if (process.platform !== "win32")
    expect((await lstat(f.path)).mode & 0o777).toBe(0o600);
  await expect(lstat(join(f.root, ".settings.json.tmp"))).rejects.toMatchObject(
    { code: "ENOENT" },
  );
});

test("a rejected current-owner mutation leaves the committed bytes and inode intact and releases its lock", async () => {
  const f = await fixture();

  const before = await Promise.all([
    readFile(f.path),
    lstat(f.path, { bigint: true }),
  ]);

  await expect(
    mutateManagedJsonFile({
      path: f.path,
      read: f.read,
      mutate: () => {
        throw new Error("fixture mutation refused");
      },
    }),
  ).rejects.toThrow("fixture mutation refused");
  expect(await readFile(f.path)).toEqual(before[0]);
  expect((await lstat(f.path, { bigint: true })).ino).toBe(before[1].ino);
  await expect(lstat(join(f.root, ".settings.json.tmp"))).rejects.toMatchObject(
    { code: "ENOENT" },
  );
  await mutateManagedJsonFile({
    path: f.path,
    read: f.read,
    mutate: (current) => ({ ...current, counter: 1 }),
  });
  expect(await f.read()).toEqual({ ...f.value, counter: 1 });
});
