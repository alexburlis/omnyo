import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { createApp } from "../../src/server.js";
import { readJson } from "../helpers/json.js";
import { createTestAppHarness } from "../helpers/test-app.js";

it.each(["0.46.382+private.1", "1.0.0+private.1", "1.0.1"])(
  "keeps hot web updates available for packaged runtime %s",
  async (appVersion) => {
    const harness = await createTestAppHarness();
    const staticDir = mkdtempSync(join(tmpdir(), "omnyo-web-update-gate-"));
    writeFileSync(join(staticDir, "index.html"), "web shell");
    writeFileSync(
      join(staticDir, "web-build.json"),
      JSON.stringify({
        schema: 1,
        sourceCommit: "a".repeat(40),
        compatibilityHash: "b".repeat(64),
        files: [
          {
            path: "index.html",
            size: 9,
            sha256: createHash("sha256").update("web shell").digest("hex"),
          },
        ],
      }),
    );

    const { app } = createApp(
      { ...harness.deps, config: { ...harness.deps.config, appVersion } },
      { staticDir },
    );

    try {
      const response = await app.request("/api/v1/system/web-update");
      expect(response.status).toBe(200);
      await expect(readJson(response)).resolves.toMatchObject({
        supported: true,
        packagedSourceCommit: "a".repeat(40),
      });
    } finally {
      rmSync(staticDir, { force: true, recursive: true });
      await harness.cleanup();
    }
  },
);
