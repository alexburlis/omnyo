import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeHostResponse } from "@omnyo/plugin-sdk/testing";
import { expect, it } from "vitest";
import plugin from "../server";
import { createFakePluginHost, installFakeGh } from "../testing/fake-gh";

it("keeps an offline machine's last discovered repositories with a notice instead of an error", async () => {
  const scratch = mkdtempSync(join(tmpdir(), "workspace-github-offline-"));
  const restore = installFakeGh(scratch, "");
  let status: "connected" | "disconnected" = "connected";
  const discovered: string[] = [];

  const { api, harness } = createFakePluginHost({
    sdk: {
      plugins: { getSettings: async () => ({ ok: true, schema: {}, values: {} }) },
      hosts: {
        list: async () => [
          makeHostResponse({ id: "pc", name: "gpu-pc", status }),
          makeHostResponse({ id: "air", name: "Air", status: "disconnected" }),
        ],
      },
      projects: {
        list: async () => [
          {
            id: "games",
            name: "Games",
            sources: [
              { type: "local_path", hostId: "pc", path: "C:\\projects\\games" },
              { type: "local_path", hostId: "air", path: "/Users/mac/projects/notes" },
            ],
          },
        ],
      },
    },
    experimental_callHostRpc: async (call) => {
      discovered.push(call.hostId);

      return {
        repos: [{ repo: "acme/games", path: "C:\\projects\\games\\app" }],
        problems: [],
      };
    },
  });

  try {
    await plugin(api);
    expect(await harness.behavior.callRpc("status", null)).toMatchObject({
      repos: [{ repo: "acme/games", projectId: "games" }],
      warnings: ["Air is offline. Its repositories appear once it reconnects."],
      notices: [],
    });

    status = "disconnected";
    await harness.behavior.callRpc("repositorySettings", { refresh: true });
    expect(await harness.behavior.callRpc("status", null)).toMatchObject({
      repos: [{ repo: "acme/games", projectId: "games" }],
      warnings: ["Air is offline. Its repositories appear once it reconnects."],
      notices: [expect.stringMatching(/^gpu-pc is offline\. Showing its repositories found on /)],
    });
    expect(discovered).toEqual(["pc"]);
  } finally {
    await harness.lifecycle.dispose();
    restore();
    rmSync(scratch, { recursive: true, force: true });
  }
});
