import { describe, expect, it } from "vitest";
import type { SystemVersionResponse } from "@omnyo/server-contract";
import { readJson } from "../helpers/json.js";
import { withTestHarness } from "../helpers/test-app.js";

describe("GET /api/v1/system/config runtime identity", () => {
  it("reports the exact running version without requesting registry update metadata", async () => {
    await withTestHarness(
      {
        appVersion: "0.46.0+private.1",
        appVersionService: {
          async getSystemVersion(): Promise<SystemVersionResponse> {
            throw new Error("config must not request update metadata");
          },
        },
      },
      async (harness) => {
        const response = await harness.app.request("/api/v1/system/config");
        expect(response.status).toBe(200);
        expect(await readJson(response)).toMatchObject({
          appVersion: "0.46.0+private.1",
          dataDir: harness.deps.config.dataDir,
        });
      },
    );
  });
});
