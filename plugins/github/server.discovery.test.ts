import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createFakePluginHost } from "@omnyo/plugin-sdk/testing";
import plugin from "./server";

const fake = vi.hoisted(() => ({
  pending: new Map<string, (remote: string | Error) => void>(),
}));

vi.mock("node:child_process", () => ({
  execFile(
    file: string,
    args: string[],
    _options: object,
    callback: (error: Error | null, stdout: string, stderr: string) => void,
  ) {
    if (file === "git") {
      fake.pending.set(args[1]!, (remote) => {
        if (remote instanceof Error) callback(remote, "", remote.message);
        else callback(null, remote, "");
      });
    } else callback(null, "ok", "");
  },
}));

const hosts: ReturnType<typeof createFakePluginHost>[] = [];

beforeEach(() => fake.pending.clear());

afterEach(async () => {
  for (const release of fake.pending.values())
    release(new Error("test cleanup"));

  for (const host of hosts.splice(0)) await host.harness.lifecycle.dispose();
});

it("discovers project remotes concurrently while preserving first-project ownership", async () => {
  const host = createFakePluginHost({
    pluginId: "github",
    settings: { extraRepos: "acme/extra" },
    sdk: {
      projects: {
        list: async () => [
          {
            id: "proj_first",
            sources: [{ type: "local_path", path: "/first" }],
          },
          {
            id: "proj_second",
            sources: [{ type: "local_path", path: "/second" }],
          },
          {
            id: "proj_failed",
            sources: [{ type: "local_path", path: "/failed" }],
          },
        ],
      },
    },
  });

  hosts.push(host);
  await plugin(host.api);
  const status = host.harness.behavior.callRpc("status");
  await vi.waitFor(() => expect(fake.pending.has("/second")).toBe(true), {
    timeout: 100,
  });
  fake.pending.get("/second")!("https://github.com/acme/shared.git");
  await vi.waitFor(() => expect(fake.pending.has("/failed")).toBe(true), {
    timeout: 100,
  });
  fake.pending.get("/failed")!(new Error("not a repository"));
  fake.pending.get("/first")!("git@github.com:acme/shared.git");
  await expect(status).resolves.toMatchObject({
    repos: [
      { repo: "acme/shared", projectId: "proj_first" },
      { repo: "acme/extra", projectId: null },
    ],
  });
});
