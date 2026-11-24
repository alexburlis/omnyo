import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  readServerManagedFiles,
  rewriteManagedAddresses,
} from "../../src/services/server-move/managed-files.js";

const dataDirs: string[] = [];

afterEach(() => {
  for (const dataDir of dataDirs.splice(0)) {
    rmSync(dataDir, { force: true, recursive: true });
  }
});

describe("server-move managed files with app alias origins", () => {
  it("rewrites only the canonical app URL and keeps the alias list", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "omnyo-move-alias-"));
    dataDirs.push(dataDir);
    const configPath = join(dataDir, "config.json");
    writeFileSync(
      configPath,
      `${JSON.stringify({
        config: {
          OMNYO_APP_URL: "https://old.example.test",
          OMNYO_APP_ALIAS_URLS: "https://app.alias.example.test",
        },
      })}\n`,
    );

    expect((await readServerManagedFiles(dataDir)).addresses).toEqual([
      {
        file: "config.json",
        key: "OMNYO_APP_URL",
        value: "https://old.example.test",
      },
    ]);

    await expect(
      rewriteManagedAddresses({
        dataDir,
        fromOrigin: "https://old.example.test",
        toUrl: "https://new.example.test",
      }),
    ).resolves.toEqual(["OMNYO_APP_URL"]);

    expect(JSON.parse(readFileSync(configPath, "utf8"))).toEqual({
      config: {
        OMNYO_APP_URL: "https://new.example.test",
        OMNYO_APP_ALIAS_URLS: "https://app.alias.example.test",
      },
    });
  });
});
