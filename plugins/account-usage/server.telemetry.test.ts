import { describe, expect, it } from "vitest";
import { createFakePluginHost } from "@omnyo/plugin-sdk/testing";
import plugin from "./server.ts";
import { poolTelemetryReportSchema } from "./lib/telemetry-contract.ts";
import { telemetryReportSchema as poolReportSchema } from "../account-pool/src/telemetry.ts";

const report = {
  from: 1,
  to: 2,
  collectionErrors: 0,
  truncated: false,
  rows: [],
  windows: [],
};

describe("account telemetry read boundary", () => {
  it("combines recorded Codex speed with account-filtered allowance", async () => {
    const accountId = "11111111-1111-4111-8111-111111111111";
    const calls: string[] = [];

    const { api, harness } = createFakePluginHost({
      pluginId: "omnyo--account-usage",
      sdk: {
        plugins: {
          callRpc: ({ pluginId, method, input, outputSchema }) => {
            calls.push(method);

            if (pluginId === "account-pool") {
              expect(method).toBe("experimental_telemetry.v1.report");
              expect(input).toEqual({ accountId });

              return outputSchema.parse(report);
            }

            expect(pluginId).toBe("stats");
            expect(method).toBe("report");
            expect(input).toEqual({
              range: "month",
              groupBy: "model",
              filters: { provider: "codex" },
              offset: 0,
              limit: 100,
              search: "",
            });

            return outputSchema.parse({
              speeds: [
                {
                  model: "gpt-6.1-sol",
                  provider: "codex",
                  mode: "default",
                  effort: "xhigh",
                  medianTps: 34.85,
                  medianSampleCount: 2,
                  counters: { measuredTurns: 3 },
                },
                {
                  model: "gpt-6-astra",
                  provider: "codex",
                  mode: "default",
                  effort: "high",
                  medianTps: null,
                  medianSampleCount: 0,
                  counters: { measuredTurns: 0 },
                },
                {
                  model: "gpt-6.1-sol",
                  provider: "codex",
                  mode: "fast",
                  effort: "xhigh",
                  medianTps: 42,
                  counters: { measuredTurns: 12 },
                },
              ],
            });
          },
        },
      },
    });

    try {
      plugin(api);
      expect(await harness.callRpc("telemetry", { accountId })).toEqual({
        ...report,
        speedRows: [
          {
            model: "gpt-6.1-sol",
            effort: "xhigh",
            requestedTier: "default",
            medianTps: 34.85,
            measuredTurns: 2,
          },
          {
            model: "gpt-6.1-sol",
            effort: "xhigh",
            requestedTier: "fast",
            medianTps: 42,
            measuredTurns: null,
          },
        ],
      });
      expect(calls).toEqual(["experimental_telemetry.v1.report", "report"]);
      expect(
        poolTelemetryReportSchema.parse(poolReportSchema.parse(report)),
      ).toEqual(report);
    } finally {
      await harness.lifecycle.dispose();
    }
  });

  it("reports an unavailable speed source instead of substituting proxy measurements", async () => {
    const { api, harness } = createFakePluginHost({
      pluginId: "omnyo--account-usage",
      sdk: {
        plugins: {
          callRpc: ({ pluginId, outputSchema }) => {
            if (pluginId === "stats") throw new Error("Stats is unavailable");

            return outputSchema.parse(report);
          },
        },
      },
    });

    try {
      plugin(api);
      await expect(
        harness.callRpc("telemetry", { accountId: null }),
      ).rejects.toThrow("Stats is unavailable");
    } finally {
      await harness.lifecycle.dispose();
    }
  });
});
