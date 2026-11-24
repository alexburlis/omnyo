import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { afterEach, expect, it } from "vitest";
import { assertStorageAdmission } from "../src/storage-admission.mjs";

const roots: string[] = [];

afterEach(async () => {
  for (const root of roots.splice(0)) {
    await fs.rm(root, { recursive: true });
    await expect(fs.stat(root)).rejects.toMatchObject({ code: "ENOENT" });
  }
});

async function fixture() {
  const parent = path.join(os.homedir(), "scratch", "omnyo");
  await fs.mkdir(parent, { recursive: true });

  const root = await fs.realpath(
    await fs.mkdtemp(path.join(parent, "admission-test-")),
  );

  roots.push(root);

  return root;
}

it("measures the real destination before creating an absent allocation", async () => {
  const root = await fixture();
  const directory = path.join(root, "future", "allocation");

  const receipt = await assertStorageAdmission({
    directory,
    expectedBytes: 1024,
    minimumFreeBytes: 1024,
  });

  expect(receipt).toMatchObject({
    directory,
    filesystemDirectory: root,
    requiredBytes: 2048,
  });
  expect(receipt.availableBytes).toBeGreaterThanOrEqual(receipt.requiredBytes);
  await expect(fs.stat(path.join(root, "future"))).rejects.toMatchObject({
    code: "ENOENT",
  });
});

it("refuses an impossible real filesystem budget without modifying prior output", async () => {
  const root = await fixture();
  await fs.writeFile(path.join(root, "keeper"), "preserved");
  await expect(
    assertStorageAdmission({
      directory: path.join(root, "future"),
      expectedBytes: Number.MAX_SAFE_INTEGER,
      minimumFreeBytes: 0,
    }),
  ).rejects.toThrow("No allocation was created");
  expect(await fs.readdir(root)).toEqual(["keeper"]);
  expect(await fs.readFile(path.join(root, "keeper"), "utf8")).toBe(
    "preserved",
  );
});

it("refuses symbolic destinations and invalid budgets without following them", async () => {
  const root = await fixture();
  const physical = path.join(root, "physical");
  await fs.mkdir(physical);
  const link = path.join(root, "link");
  await fs.symlink(physical, link, "dir");
  await expect(
    assertStorageAdmission({
      directory: path.join(link, "future"),
      expectedBytes: 1,
      minimumFreeBytes: 0,
    }),
  ).rejects.toThrow("nonphysical");

  for (const expectedBytes of [0, -1, Infinity, NaN, 1.5])
    await expect(
      assertStorageAdmission({
        directory: root,
        expectedBytes,
        minimumFreeBytes: 0,
      }),
    ).rejects.toThrow("finite positive");
  expect(await fs.readdir(physical)).toEqual([]);
});
