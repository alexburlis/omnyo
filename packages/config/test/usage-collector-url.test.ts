import { describe, expect, it } from "vitest";
import { importLegacyManagedEnvFileV1 } from "../src/legacy-managed-environment-v1.js";
import { loadServerConfig } from "../src/server.js";
import { parseUsageCollectorOrigin } from "../src/usage-collector-url.js";

describe("collector configuration", () => {
  it("ignores legacy destinations in runtime and saved settings and preserves disablement", () => {
    for (const key of ["BB_POSTHOG_API_KEY", "OMNYO_POSTHOG_API_KEY"]) {
      expect(
        loadServerConfig({
          mode: "prod",
          homeDir: "/fixture",
          env: { [key]: "old-project" },
        }).OMNYO_USAGE_COLLECTOR_URL,
      ).toBeUndefined();
      expect(
        importLegacyManagedEnvFileV1({ env: { [key]: "old-project" } }),
      ).toEqual({ env: {} });
      expect(
        importLegacyManagedEnvFileV1({
          env: { [key]: "", OMNYO_TELEMETRY: "true" },
        }),
      ).toEqual({ env: { OMNYO_TELEMETRY: "false" } });
      expect(
        loadServerConfig({
          mode: "prod",
          homeDir: "/fixture",
          env: { [key]: "", OMNYO_TELEMETRY: "true" },
        }).OMNYO_TELEMETRY,
      ).toBe(false);
    }
  });
  it("requires an explicit collector origin and never infers a region", () => {
    expect(parseUsageCollectorOrigin(undefined)).toBeUndefined();
    expect(
      loadServerConfig({ mode: "prod", homeDir: "/fixture", env: {} })
        .OMNYO_USAGE_COUNT_REGION,
    ).toBeUndefined();
    expect(
      loadServerConfig({
        mode: "prod",
        homeDir: "/fixture",
        env: {
          OMNYO_USAGE_COLLECTOR_URL: "https://usage.example.test/",
          OMNYO_USAGE_COUNT_REGION: "us",
        },
      }),
    ).toMatchObject({
      OMNYO_USAGE_COLLECTOR_URL: "https://usage.example.test",
      OMNYO_USAGE_COUNT_REGION: "US",
    });
    expect(parseUsageCollectorOrigin("http://127.0.0.1:9999")).toBe(
      "http://127.0.0.1:9999",
    );

    for (const origin of [
      "http://usage.example.test",
      "https://user@usage.example.test",
      "https://usage.example.test/path",
      "https://usage.example.test/?token=x",
      "https://usage.example.test/#",
      "#",
    ])
      expect(() => parseUsageCollectorOrigin(origin)).toThrow();
  });
});
