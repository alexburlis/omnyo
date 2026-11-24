import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { inspectDeveloperEntries } from "./developer-storage.js";

import { developerStorageRoot } from "./storage-identities.js";

describe("developer storage identity records", () => {
  it("names only the current developer storage root", () => {
    expect(developerStorageRoot("/fixture/home/")).toBe(
      "/fixture/home/.omnyo-dev",
    );
  });

  it("reads current launch and runtime records without changing them", async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "omnyo-dev-record-"));

    try {
      const checkout = path.join(home, "checkout");
      const rootPath = path.join(home, ".omnyo-dev");
      await fs.mkdir(checkout);

      const records = [
        ["current-launch", "dev-instance.json", { repoRoot: checkout }],
        [
          "current-runtime",
          "app-runtime.json",
          { entryPath: path.join(checkout, "scripts", "start-omnyo.mjs") },
        ],
      ] as const;

      const before = new Map<string, Buffer>();

      for (const [name, filename, record] of records) {
        const directory = path.join(rootPath, name);
        await fs.mkdir(directory, { recursive: true });
        const target = path.join(directory, filename);
        await fs.writeFile(target, JSON.stringify(record));
        before.set(target, await fs.readFile(target));
      }

      const result = await inspectDeveloperEntries(
        { rootPath, names: records.map(([name]) => name), candidatePaths: [] },
        new AbortController().signal,
      );

      expect(result.entries).toEqual(
        records.map(([name]) => ({
          name,
          sourcePath: checkout,
          sourcePathState: "exists",
          running: false,
        })),
      );

      for (const [target, bytes] of before)
        expect(await fs.readFile(target)).toEqual(bytes);
    } finally {
      await fs.rm(home, { recursive: true, force: true });
    }
  });
});
