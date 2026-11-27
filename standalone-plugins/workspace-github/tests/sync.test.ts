import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import plugin from "../server";
import { createFakePluginHost, installFakeGh } from "../testing/fake-gh";

it("retains last verified rows and exposes a failed refresh instead of showing an empty successful sync", async () => {
  const scratch = mkdtempSync(join(tmpdir(), "workspace-github-sync-"));
  const marker = join(scratch, "fail");

  const response = JSON.stringify({
    data: {
      repository: {
        nameWithOwner: "acme/widgets",
        hasIssuesEnabled: true,
        viewerPermission: "WRITE",
        openIssues: {
          nodes: [
            {
              number: 1,
              title: "Open issue",
              state: "OPEN",
              author: { __typename: "User", login: "octocat" },
              labels: { nodes: [] },
              assignees: { nodes: [] },
              url: "https://github.com/acme/widgets/issues/1",
              body: "",
              updatedAt: "2026-10-10T00:00:00Z",
            },
          ],
        },
        closedIssues: { nodes: [] },
        openPrs: {
          nodes: [
            {
              number: 2,
              title: "Open pull request",
              state: "OPEN",
              isDraft: false,
              mergeable: "CONFLICTING",
              mergeStateStatus: "DIRTY",
              reviewDecision: "APPROVED",
              author: { __typename: "Bot", login: "connector" },
              labels: { nodes: [] },
              assignees: { nodes: [] },
              url: "https://github.com/acme/widgets/pull/2",
              body: "Full description for the detail view.",
              updatedAt: "2026-10-10T00:00:00Z",
            },
          ],
        },
        closedPrs: {
          nodes: [
            {
              number: 42,
              title: "Already merged",
              state: "MERGED",
              author: { __typename: "User", login: "octocat" },
              labels: { nodes: [] },
              assignees: { nodes: [] },
              url: "https://github.com/acme/widgets/pull/42",
              body: "",
              updatedAt: "2026-10-10T00:00:00Z",
            },
          ],
        },
      },
    },
  });

  const restore = installFakeGh(
    scratch,
    `if (args[0] === "api" && args[1] === "graphql") { if (fs.existsSync(${JSON.stringify(marker)})) { err("fixture request failed"); process.exit(1); } out(${JSON.stringify(response)}); } else if (args[0] === "api" && args[1] === "user") { out('{"login":"octocat"}'); }`,
  );

  const { api, harness } = createFakePluginHost({
    settings: { extraRepos: "legacy/widgets,acme/widgets" },
    sdk: {
      projects: { list: async () => [] },
      plugins: { getSettings: async () => ({ ok: true, schema: {}, values: {} }) },
    },
  });

  try {
    await plugin(api);
    await harness.behavior.callRpc("refresh", null);
    const before = await harness.behavior.callRpc("listItems", {});
    expect(before).toMatchObject({
      items: expect.arrayContaining([
        expect.objectContaining({ repo: "acme/widgets", number: 42, state: "MERGED" }),
        expect.objectContaining({
          repo: "acme/widgets",
          number: 2,
          pullReview: "conflicts",
          pullMerge: "DIRTY",
          body: "Full description for the detail view.",
        }),
      ]),
    });
    expect(
      await harness.behavior.callRpc("listItems", { kind: "pr", includeBody: false }),
    ).toMatchObject({
      items: expect.arrayContaining([
        expect.objectContaining({ number: 2, pullMerge: "DIRTY", body: "" }),
      ]),
    });
    expect(await harness.behavior.callRpc("status", null)).toMatchObject({
      repos: [{ repo: "acme/widgets", projectId: null }],
    });
    expect(await harness.behavior.callRpc("counts", null)).toMatchObject({
      issues: 1,
      prs: 1,
      stale: false,
      lastSyncedAt: expect.any(String),
    });
    await harness.behavior.callRpc("setRepoExcluded", { repo: "LEGACY/WIDGETS", excluded: true });
    expect(await harness.behavior.callRpc("counts", null)).toMatchObject({ issues: 0, prs: 0 });
    await harness.behavior.callRpc("setRepoExcluded", { repo: "legacy/widgets", excluded: false });
    expect(await harness.behavior.callRpc("counts", null)).toMatchObject({ issues: 1, prs: 1 });
    writeFileSync(marker, "fail");
    await expect(harness.behavior.callRpc("refresh", null)).rejects.toThrow("sync failed");
    expect(await harness.behavior.callRpc("listItems", {})).toEqual(before);
    expect(await harness.behavior.callRpc("counts", null)).toMatchObject({
      issues: 1,
      prs: 1,
      stale: true,
    });
    expect(await harness.behavior.callRpc("status", null)).toMatchObject({
      warnings: [expect.stringContaining("acme/widgets")],
    });
  } finally {
    await harness.lifecycle.dispose();
    restore();
    rmSync(scratch, { recursive: true, force: true });
  }
});

it.each(["first empty sync", "unchanged recovery", "authentication failure"])(
  "notifies count subscribers after background %s",
  async (scenario) => {
    const scratch = mkdtempSync(join(tmpdir(), "workspace-github-freshness-"));
    const marker = join(scratch, "failure");

    const response = JSON.stringify({
      data: {
        repository: {
          nameWithOwner: "acme/widgets",
          hasIssuesEnabled: true,
          viewerPermission: "READ",
          openIssues: { nodes: [] },
          closedIssues: { nodes: [] },
          openPrs: { nodes: [] },
          closedPrs: { nodes: [] },
        },
      },
    });

    const restore = installFakeGh(
      scratch,
      `
      const failure = fs.existsSync(${JSON.stringify(marker)}) ? fs.readFileSync(${JSON.stringify(marker)}, "utf8") : "";
      if (args[0] === "auth" && args[1] === "status" && failure === "auth") { err("authentication temporarily unavailable"); process.exit(1); }
      if (args[0] === "api" && args[1] === "graphql") {
        if (failure === "fetch") { err("fixture request failed"); process.exit(1); }
        out(${JSON.stringify(response)});
      }
      if (args[0] === "api" && args[1] === "user") out('{"login":"octocat"}');
    `,
    );

    const { api, harness } = createFakePluginHost({
      settings: { extraRepos: "acme/widgets" },
      sdk: {
        projects: { list: async () => [] },
        plugins: { getSettings: async () => ({ ok: true, schema: {}, values: {} }) },
      },
    });

    let service: ReturnType<typeof harness.behavior.runService> | null = null;

    try {
      await plugin(api);

      if (scenario !== "first empty sync") await harness.behavior.callRpc("refresh", null);

      if (scenario === "unchanged recovery") {
        writeFileSync(marker, "fetch");
        await expect(harness.behavior.callRpc("refresh", null)).rejects.toThrow("sync failed");
        expect(await harness.behavior.callRpc("counts", null)).toMatchObject({ stale: true });
        rmSync(marker);
      } else if (scenario === "authentication failure") writeFileSync(marker, "auth");
      const signalCount = harness.inspection.realtimeSignals.length;
      const logCount = harness.inspection.logEntries.length;
      service = harness.behavior.runService("sync");
      await expect
        .poll(
          () =>
            harness.inspection.logEntries
              .slice(logCount)
              .some(
                (entry) =>
                  entry.message.startsWith("synced ") ||
                  entry.message.startsWith("sync failed (retry"),
              ),
          { timeout: 10_000 },
        )
        .toBe(true);
      service.controller.abort();
      await service.done;
      expect(harness.inspection.realtimeSignals.slice(signalCount)).toContainEqual({
        channel: "data-changed",
        payload: expect.any(Object),
      });
      expect(await harness.behavior.callRpc("counts", null)).toMatchObject({
        issues: 0,
        prs: 0,
        lastSyncedAt: expect.any(String),
        stale: scenario === "authentication failure",
      });
    } finally {
      service?.controller.abort();
      await service?.done;
      await harness.lifecycle.dispose();
      restore();
      rmSync(scratch, { recursive: true, force: true });
    }
  },
);
