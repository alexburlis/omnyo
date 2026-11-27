import { createFakePluginHost } from "@omnyo/plugin-sdk/testing";
import { expect, it } from "vitest";
import plugin from "../server";

it("runs GitHub CLI on the machine running Omnyo and reports when that machine is missing", async () => {
  const calls: string[] = [];
  let primaryHostId: string | null = null;

  const { api, harness } = createFakePluginHost({
    sdk: {
      hosts: { list: async () => [] },
      system: { config: async () => ({ primaryHostId }) },
      projects: { list: async () => [] },
      plugins: { getSettings: async () => ({ ok: true, schema: {}, values: {} }) },
    },
    experimental_callHostRpc: async (call) => {
      calls.push(`${call.method}@${call.hostId}`);

      if (call.method === "authStatus") return { state: "ready", error: null };

      return { repos: [], problems: [] };
    },
  });

  try {
    await plugin(api);
    expect(await harness.behavior.callRpc("status", null)).toMatchObject({
      ghState: "unavailable",
      ghError: "The machine running Omnyo is not connected, so GitHub CLI cannot run.",
    });
    expect(calls).toEqual([]);
    primaryHostId = "host_server";
    expect(await harness.behavior.callRpc("status", null)).toMatchObject({
      ghState: "ready",
      ghError: null,
    });
    expect(calls).toEqual(["authStatus@host_server"]);
  } finally {
    await harness.lifecycle.dispose();
  }
});
