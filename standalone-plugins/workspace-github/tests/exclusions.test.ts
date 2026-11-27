import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import plugin from "../server";
import { createFakePluginHost, installFakeGh } from "../testing/fake-gh";

it("applies validated repo exclusions immediately, skips sync, and restores cached rows across reloads", async () => {
  const scratch = mkdtempSync(join(tmpdir(), "workspace-github-exclusions-"));
  const requests = join(scratch, "requests");

  const restore = installFakeGh(
    scratch,
    `
    if (args[0] === "api" && args[1] === "graphql") {
      const name = args.find((arg) => arg.startsWith("name=")).slice(5);
      fs.appendFileSync(${JSON.stringify(requests)}, name + "\\n");
      const repo = "acme/" + name;
      const entry = {
        number: 1, title: name, state: "OPEN", author: {__typename: "User", login: "octocat"},
        labels: {nodes: []}, assignees: {nodes: []},
        url: "https://github.com/" + repo + "/issues/1", body: "", updatedAt: "2026-10-10T00:00:00Z"
      };
      out(JSON.stringify({data: {repository: {
        nameWithOwner: repo, hasIssuesEnabled: true, viewerPermission: "READ",
        openIssues: {nodes: [entry]}, closedIssues: {nodes: []},
        openPrs: {nodes: []}, closedPrs: {nodes: []}
      }}}));
    } else if (args[0] === "api" && args[1] === "user") { out('{"login":"octocat"}'); }
  `,
  );

  let { api, harness } = createFakePluginHost({
    settings: { extraRepos: "legacy/widgets,acme/tools" },
    sdk: {
      projects: { list: async () => [] },
      plugins: { getSettings: async () => ({ ok: true, schema: {}, values: {} }) },
    },
  });

  try {
    await plugin(api);
    await harness.behavior.callRpc("refresh", null);
    expect(await harness.behavior.callRpc("listItems", {})).toMatchObject({
      items: expect.arrayContaining([
        expect.objectContaining({ repo: "acme/tools" }),
        expect.objectContaining({ repo: "acme/widgets" }),
      ]),
    });
    await expect(
      harness.behavior.callRpc("setRepoExcluded", { repo: "not-a-repo", excluded: true }),
    ).rejects.toThrow();
    await Promise.all([
      harness.behavior.callRpc("setRepoExcluded", { repo: "LEGACY/WIDGETS", excluded: true }),
      harness.behavior.callRpc("setRepoExcluded", { repo: "ACME/TOOLS", excluded: true }),
    ]);
    expect(await harness.behavior.callRpc("listItems", {})).toEqual({ items: [] });
    expect(await harness.behavior.callRpc("status", null)).toMatchObject({ repos: [] });
    expect(await harness.behavior.callRpc("refresh", null)).toEqual({ repos: 0, items: 0 });
    expect(readFileSync(requests, "utf8").trim().split("\n")).toHaveLength(2);
    const cli = await harness.behavior.runCli(["issues", "--json"]);
    expect(cli.exitCode).toBe(0);
    expect(JSON.parse(cli.stdout)).toMatchObject({ items: [] });

    ({ api, harness } = await harness.lifecycle.reload(plugin));
    expect(await harness.behavior.callRpc("listItems", {})).toEqual({ items: [] });
    expect(await harness.behavior.callRpc("refresh", null)).toEqual({ repos: 0, items: 0 });
    expect(readFileSync(requests, "utf8").trim().split("\n")).toHaveLength(2);

    await Promise.all([
      harness.behavior.callRpc("setRepoExcluded", { repo: "legacy/widgets", excluded: false }),
      harness.behavior.callRpc("setRepoExcluded", { repo: "acme/tools", excluded: false }),
    ]);
    expect(await harness.behavior.callRpc("listItems", {})).toMatchObject({
      items: [expect.anything(), expect.anything()],
    });
    expect(await harness.behavior.callRpc("status", null)).toMatchObject({
      repos: [
        expect.objectContaining({ repo: "acme/widgets" }),
        expect.objectContaining({ repo: "acme/tools" }),
      ],
    });
    expect(readFileSync(requests, "utf8").trim().split("\n")).toHaveLength(2);

    // An unseen renamed origin must not reintroduce an excluded canonical repository.
    await harness.behavior.setSettings({
      extraRepos: "another/widgets,acme/tools",
    });
    await harness.behavior.callRpc("setRepoExcluded", { repo: "ACME/WIDGETS", excluded: true });
    expect(await harness.behavior.callRpc("refresh", null)).toEqual({ repos: 1, items: 1 });
    expect(await harness.behavior.callRpc("listItems", {})).toMatchObject({
      items: [expect.objectContaining({ repo: "acme/tools" })],
    });
  } finally {
    await harness.lifecycle.dispose();
    restore();
    rmSync(scratch, { recursive: true, force: true });
  }
});

it("assigns nested repos to the most specific Omnyo project rather than its parent container", async () => {
  const scratch = mkdtempSync(join(tmpdir(), "workspace-github-projects-"));
  const restore = installFakeGh(scratch, "");

  const { api, harness } = createFakePluginHost({
    sdk: {
      plugins: { getSettings: async () => ({ ok: true, schema: {}, values: {} }) },
      projects: {
        list: async () => [
          {
            id: "parent",
            name: "Projects",
            sources: [{ type: "local_path", hostId: "mac", path: "/projects" }],
          },
          {
            id: "widgets",
            name: "Widgets",
            sources: [{ type: "local_path", hostId: "mac", path: "/projects/widgets" }],
          },
        ],
      },
    },
    experimental_callHostRpc: async () => ({
      repos: [{ repo: "acme/widgets", path: "/projects/widgets/app" }],
      problems: [],
    }),
  });

  try {
    await plugin(api);
    expect(await harness.behavior.callRpc("status", null)).toMatchObject({
      projects: [
        { id: "parent", name: "Projects" },
        { id: "widgets", name: "Widgets" },
      ],
      repos: [{ repo: "acme/widgets", projectId: "widgets" }],
    });
    await harness.behavior.callRpc("setRepoExcluded", { repo: "ACME/WIDGETS", excluded: true });
    expect(await harness.behavior.callRpc("status", null)).toMatchObject({ repos: [] });
  } finally {
    await harness.lifecycle.dispose();
    restore();
    rmSync(scratch, { recursive: true, force: true });
  }
});

it("starts a fresh install without saved exclusions, preserves concurrent toggles and refreshes project discovery", async () => {
  let discovered = ["acme/widgets"];

  let { api, harness } = createFakePluginHost({
    settings: { extraRepos: "acme/tools" },
    sdk: {
      plugins: {
        getSettings: async () => {
          throw new Error(
            "HTTP 404: unknown plugin, or plugin is not running — settings exist once its factory has run",
          );
        },
      },
      projects: {
        list: async () => [
          {
            id: "widgets",
            name: "Widgets",
            sources: [{ type: "local_path", hostId: "mac", path: "/projects/widgets" }],
          },
        ],
      },
    },
    experimental_callHostRpc: async () => ({
      repos: discovered.map((repo) => ({ repo, path: "/projects/widgets/app" })),
      problems: [],
    }),
  });

  try {
    await plugin(api);
    expect(harness.inspection.registrations.settingsDescriptors).not.toHaveProperty(
      "excludedRepos",
    );
    expect(await harness.behavior.callRpc("repositorySettings", {})).toMatchObject({
      repos: [
        { repo: "acme/tools", projectId: null, excluded: false, available: true },
        { repo: "acme/widgets", projectId: "widgets", excluded: false, available: true },
      ],
      projects: [{ id: "widgets", name: "Widgets" }],
      warnings: [],
    });
    await Promise.all([
      harness.behavior.callRpc("setRepoExcluded", { repo: "acme/tools", excluded: true }),
      harness.behavior.callRpc("setRepoExcluded", { repo: "ACME/WIDGETS", excluded: true }),
    ]);
    expect(await harness.behavior.callRpc("repositorySettings", {})).toMatchObject({
      repos: [
        { repo: "acme/tools", excluded: true },
        { repo: "acme/widgets", excluded: true },
      ],
    });
    ({ api, harness } = await harness.lifecycle.reload(plugin));
    expect(await harness.behavior.callRpc("repositorySettings", {})).toMatchObject({
      repos: [
        { repo: "acme/tools", excluded: true },
        { repo: "acme/widgets", excluded: true },
      ],
    });
    discovered.push("acme/new");
    expect(await harness.behavior.callRpc("repositorySettings", { refresh: true })).toMatchObject({
      repos: expect.arrayContaining([
        { repo: "acme/new", projectId: "widgets", excluded: false, available: true },
      ]),
    });
    await harness.behavior.setSettings({ extraRepos: "acme/extra" });
    expect(await harness.behavior.callRpc("repositorySettings", {})).toMatchObject({
      repos: expect.arrayContaining([
        { repo: "acme/extra", projectId: null, excluded: false, available: true },
        { repo: "acme/tools", projectId: null, excluded: true, available: false },
      ]),
    });
    await harness.behavior.callRpc("setRepoExcluded", { repo: "acme/tools", excluded: false });
    expect(await harness.behavior.callRpc("repositorySettings", {})).toMatchObject({
      repos: expect.not.arrayContaining([expect.objectContaining({ repo: "acme/tools" })]),
    });
    await expect(
      harness.behavior.callRpc("setRepoExcluded", { repo: "bad", excluded: true }),
    ).rejects.toThrow();
  } finally {
    await harness.lifecycle.dispose();
  }
});
