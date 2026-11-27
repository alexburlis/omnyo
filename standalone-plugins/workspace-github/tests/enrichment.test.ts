import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { z } from "zod";
import plugin from "../server";
import { createFakePluginHost, installFakeGh } from "../testing/fake-gh";

const listedItems = z.object({
  items: z.array(z.looseObject({ repo: z.string(), number: z.number() })),
}).parse;

const node = {
  author: { __typename: "User", login: "octocat" },
  assignees: { nodes: [] },
  body: "",
  updatedAt: "2026-11-20T00:00:00Z",
  createdAt: "2026-11-19T00:00:00Z",
  closedAt: null,
};

const widgets = {
  data: {
    repository: {
      nameWithOwner: "acme/widgets",
      hasIssuesEnabled: true,
      viewerPermission: "WRITE",
      openIssues: {
        nodes: [
          {
            ...node,
            number: 1,
            title: "Crash on launch",
            state: "OPEN",
            labels: { nodes: [{ name: "bug", color: "d73a4a" }] },
            url: "https://github.com/acme/widgets/issues/1",
            comments: { totalCount: 3 },
          },
        ],
      },
      closedIssues: { nodes: [] },
      openPrs: {
        nodes: [
          {
            ...node,
            number: 3,
            title: "Fix the crash",
            state: "OPEN",
            labels: { nodes: [{ name: "bug", color: "d73a4a" }] },
            url: "https://github.com/acme/widgets/pull/3",
            comments: { totalCount: 2 },
            isDraft: false,
            mergeable: "MERGEABLE",
            mergeStateStatus: "UNSTABLE",
            reviewDecision: null,
            headRefName: "fix/crash",
            baseRefName: "main",
            additions: 40,
            deletions: 12,
            changedFiles: 3,
            commits: { nodes: [{ commit: { statusCheckRollup: { state: "FAILURE" } } }] },
            reviewRequests: {
              nodes: [{ requestedReviewer: { slug: "octo-team" } }, { requestedReviewer: null }],
            },
            latestReviews: { nodes: [{ state: "APPROVED", author: { login: "reviewer" } }] },
            closingIssuesReferences: {
              nodes: [{ number: 1, repository: { nameWithOwner: "acme/widgets" } }],
            },
          },
          {
            ...node,
            number: 5,
            title: "Lazy merge state",
            state: "OPEN",
            labels: { nodes: [] },
            url: "https://github.com/acme/widgets/pull/5",
            isDraft: false,
            mergeable: "UNKNOWN",
            mergeStateStatus: "UNKNOWN",
          },
        ],
      },
      closedPrs: {
        nodes: [
          {
            ...node,
            number: 4,
            title: "Shipped",
            state: "MERGED",
            labels: { nodes: [] },
            url: "https://github.com/acme/widgets/pull/4",
            mergedAt: "2026-11-21T00:00:00Z",
            additions: 1,
            deletions: 1,
            changedFiles: 1,
          },
        ],
      },
    },
  },
};

const legacy = {
  data: {
    repository: {
      ...widgets.data.repository,
      nameWithOwner: "legacy/old",
      openIssues: { nodes: [] },
      closedPrs: { nodes: [] },
      openPrs: {
        nodes: [
          {
            ...node,
            number: 9,
            title: "Ghost under the old name",
            state: "OPEN",
            labels: { nodes: [] },
            url: "https://github.com/legacy/old/pull/9",
            isDraft: false,
            mergeStateStatus: "CLEAN",
          },
        ],
      },
    },
  },
};

function single(nameWithOwner: string, number: number, title: string) {
  return {
    data: {
      repository: {
        ...legacy.data.repository,
        nameWithOwner,
        openPrs: {
          nodes: [
            {
              ...legacy.data.repository.openPrs.nodes[0],
              number,
              title,
              url: `https://github.com/${nameWithOwner}/pull/${number}`,
            },
          ],
        },
      },
    },
  };
}

const renamed = (nameWithOwner: string) =>
  JSON.stringify({ data: { repository: { nameWithOwner } } });

it("caches GitLens-style row fields, moves renamed repositories and rechecks lazy merge states", async () => {
  const scratch = mkdtempSync(join(tmpdir(), "workspace-github-enrich-"));

  const restore = installFakeGh(
    scratch,
    `const joined = args.join(" ");
if (args[0] === "api" && args[1] === "user") { out('{"login":"octocat"}'); }
else if (joined.includes("RepositoryName") && joined.includes("name=old")) { out(${JSON.stringify(renamed("acme/widgets"))}); }
else if (joined.includes("RepositoryName") && joined.includes("name=moved")) { out(${JSON.stringify(renamed("other/new"))}); }
else if (joined.includes("RepositoryName") && joined.includes("name=kept")) { out(${JSON.stringify(renamed("solo/kept"))}); }
else if (joined.includes("RepositoryName")) { err("lookup failed"); process.exit(1); }
else if (joined.includes("MergeStates")) { out(${JSON.stringify(JSON.stringify({ data: { repository: { pr5: { mergeStateStatus: "CLEAN", mergeable: "MERGEABLE" } } } }))}); }
else if (joined.includes("name=old")) { out(${JSON.stringify(JSON.stringify(legacy))}); }
else if (joined.includes("name=moved")) { out(${JSON.stringify(JSON.stringify(single("other/moved", 11, "Renamed elsewhere")))}); }
else if (joined.includes("name=kept")) { out(${JSON.stringify(JSON.stringify(single("solo/kept", 12, "Still cached")))}); }
else if (joined.includes("name=broken")) { out(${JSON.stringify(JSON.stringify(single("flaky/broken", 13, "Lookup fails")))}); }
else if (args[0] === "api" && args[1] === "graphql") { out(${JSON.stringify(JSON.stringify(widgets))}); }`,
  );

  const { api, harness } = createFakePluginHost({
    settings: { extraRepos: "acme/widgets,legacy/old,other/moved,solo/kept,flaky/broken" },
    sdk: {
      projects: { list: async () => [] },
      plugins: { getSettings: async () => ({ ok: true, schema: {}, values: {} }) },
    },
  });

  try {
    await plugin(api);
    await harness.behavior.callRpc("refresh", null);

    const { items } = listedItems(
      await harness.behavior.callRpc("listItems", { includeBody: false }),
    );

    expect(items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          repo: "acme/widgets",
          number: 3,
          headRef: "fix/crash",
          baseRef: "main",
          additions: 40,
          deletions: 12,
          changedFiles: 3,
          checks: "failure",
          comments: 2,
          createdAt: "2026-11-19T00:00:00Z",
          labelColors: { bug: "d73a4a" },
          reviewers: [
            { login: "reviewer", state: "approved" },
            { login: "octo-team", state: "requested" },
          ],
          linkedIssues: [{ repo: "acme/widgets", number: 1 }],
        }),
        expect.objectContaining({ number: 4, state: "MERGED", mergedAt: "2026-11-21T00:00:00Z" }),
        expect.objectContaining({ kind: "issue", number: 1, comments: 3 }),
        expect.objectContaining({ repo: "legacy/old", number: 9 }),
      ]),
    );

    await harness.behavior.setSettings({ extraRepos: "acme/widgets" });
    await harness.behavior.callRpc("refresh", null);
    const after = listedItems(await harness.behavior.callRpc("listItems", { includeBody: false }));

    const repos = after.items.map((entry) => `${entry.repo}#${entry.number}`);

    expect(repos).not.toContain("legacy/old#9");
    expect(repos).toContain("other/new#11");
    expect(repos).not.toContain("other/moved#11");
    expect(repos).toContain("solo/kept#12");
    expect(repos).toContain("flaky/broken#13");
    expect(await harness.behavior.callRpc("counts", null)).toMatchObject({ prs: 5, issues: 1 });

    await vi.waitFor(
      async () => {
        const latest = listedItems(await harness.behavior.callRpc("listItems", { kind: "pr" }));

        expect(latest.items).toEqual(
          expect.arrayContaining([expect.objectContaining({ number: 5, pullMerge: "CLEAN" })]),
        );
      },
      { timeout: 12_000, interval: 250 },
    );
  } finally {
    await harness.lifecycle.dispose();
    restore();
    rmSync(scratch, { recursive: true, force: true });
  }
}, 30_000);
