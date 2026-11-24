import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createLineReadStats,
  readFirstLine,
  readLines,
  readTailLines,
} from "./jsonl.js";

let directory = "";

beforeEach(async () => {
  directory = await fs.mkdtemp(path.join(os.tmpdir(), "chat-importer-jsonl-"));
});

afterEach(async () => {
  await fs.rm(directory, { recursive: true, force: true });
});

async function writeFixture(content: string | Buffer): Promise<string> {
  const filePath = path.join(directory, "lines.jsonl");

  await fs.writeFile(filePath, content);

  return filePath;
}

async function collect(
  filePath: string,
  options: Parameters<typeof readLines>[1] = {},
): Promise<string[]> {
  const lines: string[] = [];

  for await (const line of readLines(filePath, options)) lines.push(line);

  return lines;
}

describe("readLines", () => {
  it("splits lines across chunk boundaries, strips CR and skips blank lines", async () => {
    const filePath = await writeFixture(
      'first line\r\n\n{"emoji":"✓ é"}\nsecond-to-last\nno trailing newline',
    );

    await expect(collect(filePath, { chunkBytes: 3 })).resolves.toEqual([
      "first line",
      '{"emoji":"✓ é"}',
      "second-to-last",
      "no trailing newline",
    ]);
  });

  it("skips and counts lines over the cap without returning them", async () => {
    const stats = createLineReadStats();

    const filePath = await writeFixture(
      `short\n${"x".repeat(50)}\nafter\n${"y".repeat(40)}`,
    );

    await expect(
      collect(filePath, { chunkBytes: 7, maxLineBytes: 20, stats }),
    ).resolves.toEqual(["short", "after"]);
    expect(stats.oversizedLines).toBe(2);
    expect(stats.bytesRead).toBe((await fs.stat(filePath)).size);
  });

  it("keeps a line exactly at the cap", async () => {
    const filePath = await writeFixture(`${"z".repeat(20)}\n`);

    await expect(
      collect(filePath, { chunkBytes: 6, maxLineBytes: 20 }),
    ).resolves.toEqual(["z".repeat(20)]);
  });

  it("reads only the first line when asked", async () => {
    const stats = createLineReadStats();

    const filePath = await writeFixture(
      `${"a".repeat(100)}\n${"b".repeat(5000)}\n`,
    );

    await expect(
      readFirstLine(filePath, { chunkBytes: 64, stats }),
    ).resolves.toBe("a".repeat(100));
    expect(stats.bytesRead).toBeLessThan(1000);
  });
});

describe("readTailLines", () => {
  it("drops the partial first line of a window", async () => {
    const filePath = await writeFixture("alpha\nbravo\ncharlie\ndelta\n");

    await expect(readTailLines(filePath, 16)).resolves.toEqual({
      lines: ["charlie", "delta"],
      reachedStart: false,
    });
    await expect(readTailLines(filePath, 1024)).resolves.toEqual({
      lines: ["alpha", "bravo", "charlie", "delta"],
      reachedStart: true,
    });
  });
});
