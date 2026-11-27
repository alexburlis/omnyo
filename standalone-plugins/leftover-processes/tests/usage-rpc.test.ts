import { createFakePluginHost, makeHostResponse } from "@omnyo/plugin-sdk/testing";
import { describe, expect, it } from "vitest";
import { rpcContract } from "../contract";
import plugin from "../server";
import { emptySystemUsage } from "../system-usage";

describe("usage RPC and CLI", () => {
  it("uses the read-only host method and preserves failed known hosts", async () => {
    const methods: string[] = [];

    const owner = createFakePluginHost({
      pluginId: "leftover-processes",
      sdk: {
        hosts: {
          list: async () => [
            makeHostResponse({ id: "connected", name: "Connected machine" }),
            makeHostResponse({ id: "offline", name: "Offline machine", status: "disconnected" }),
          ],
        },
      },
      experimental_callHostRpc: async ({ method }) => {
        methods.push(method);

        if (method !== "usage") throw new Error("Usage must not invoke cleanup");

        return {
          hostName: "Connected machine",
          system: emptySystemUsage(),
          coverage: "complete",
          threads: [
            {
              threadId: "chat",
              cpuPercent: 25,
              memoryBytes: 1024,
              tasks: [{ pid: 123, name: "node", cpuPercent: 25, memoryBytes: 1024 }],
            },
          ],
        };
      },
    });

    plugin(owner.api);

    try {
      const result = rpcContract.usage.output.parse(
        await owner.harness.behavior.callRpc("usage", {}),
      );

      expect(result.hosts).toEqual([
        {
          hostId: "connected",
          hostName: "Connected machine",
          system: emptySystemUsage(),
          coverage: "complete",
          threads: [
            {
              threadId: "chat",
              cpuPercent: 25,
              memoryBytes: 1024,
              tasks: [{ pid: 123, name: "node", cpuPercent: 25, memoryBytes: 1024 }],
            },
          ],
        },
        {
          hostId: "offline",
          hostName: "Offline machine",
          system: emptySystemUsage(),
          coverage: "failed",
          threads: [],
        },
      ]);
      const cli = await owner.harness.behavior.runCli(["usage", "--json"]);
      expect(cli.exitCode).toBe(1);
      expect(JSON.parse(cli.stdout ?? "{}")).toEqual(result);
      expect(methods).toEqual(["usage", "usage"]);
      expect(await owner.harness.behavior.runCli(["usage", "--all"])).toMatchObject({
        exitCode: 1,
      });
    } finally {
      await owner.harness.lifecycle.dispose();
    }
  });
});
