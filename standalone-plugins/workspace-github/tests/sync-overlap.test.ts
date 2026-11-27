import { createFakePluginHost } from "@omnyo/plugin-sdk/testing";
import { expect, it, vi } from "vitest";
import plugin from "../server";
import hostEntry from "../host";

it("overlaps two primary-host repository reads while keeping ordered commits and bounded admission", async () => {
  const pending: Array<() => void> = [];
  const hosts: string[] = [];
  let active = 0;
  let peak = 0;

  const { api, harness } = createFakePluginHost({
    settings: { extraRepos: "acme/one,acme/two,acme/three" },
    sdk: {
      projects: { list: async () => [] },
      hosts: { list: async () => [] },
      system: { config: async () => ({ primaryHostId: "primary-host" }) },
      plugins: { getSettings: async () => ({ ok: true, schema: {}, values: {} }) },
    },
    experimental_callHostRpc: async (call) => {
      hosts.push(call.hostId);

      if (call.method === "authStatus") return { state: "ready", error: null };

      if (call.method !== "gh") throw new Error("Unexpected host method");
      const { args } = hostEntry.contract.gh.input.parse(call.input);

      if (args[0] === "api" && args[1] === "user") return { stdout: '{"login":"octocat"}' };
      const name = args.find((arg) => arg.startsWith("name="))?.slice(5);

      if (!name) throw new Error("Expected a repository read");
      active++;
      peak = Math.max(peak, active);

      return new Promise<{ stdout: string }>((resolve) =>
        pending.push(() => {
          active--;
          resolve({
            stdout: JSON.stringify({
              data: {
                repository: {
                  nameWithOwner: `acme/${name}`,
                  hasIssuesEnabled: true,
                  viewerPermission: "WRITE",
                  openIssues: { nodes: [] },
                  closedIssues: { nodes: [] },
                  openPrs: { nodes: [] },
                  closedPrs: { nodes: [] },
                },
              },
            }),
          });
        }),
      );
    },
  });

  try {
    await plugin(api);

    const refresh = harness.behavior.callRpc("refresh", null).then(
      (result) => ({ result }),
      (error) => ({ error }),
    );

    await vi.waitFor(() => expect(pending).toHaveLength(2), { timeout: 500 });
    const first = pending.shift();
    const second = pending.shift();

    if (!first || !second) throw new Error("Missing repository reads");
    first();
    await Promise.resolve();
    expect(pending).toHaveLength(0);
    second();
    await vi.waitFor(() => expect(pending).toHaveLength(1), { timeout: 500 });
    const last = pending.shift();

    if (!last) throw new Error("Missing final repository read");
    last();
    expect(await refresh).toEqual({ result: { repos: 3, items: 0 } });
    expect(peak).toBe(2);
    expect(hosts.every((id) => id === "primary-host")).toBe(true);
  } finally {
    for (const finish of pending.splice(0)) finish();
    await harness.lifecycle.dispose();
  }
});
