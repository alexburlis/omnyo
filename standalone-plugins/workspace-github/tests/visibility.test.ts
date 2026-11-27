import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { z } from "zod";
import plugin from "../server";
import { createFakePluginHost, installFakeGh } from "../testing/fake-gh";

const shippedMigrations = [
  `CREATE TABLE IF NOT EXISTS items (
       repo TEXT NOT NULL,
       number INTEGER NOT NULL,
       kind TEXT NOT NULL,
       title TEXT NOT NULL,
       state TEXT NOT NULL,
       author TEXT NOT NULL,
       labels TEXT NOT NULL,
       url TEXT NOT NULL,
       body TEXT NOT NULL,
       updated_at TEXT NOT NULL,
       PRIMARY KEY (repo, kind, number)
     )`,
  `ALTER TABLE items ADD COLUMN assignees TEXT NOT NULL DEFAULT '[]'`,
];

const node = (number: number, author: { __typename: string; login: string }) => ({
  number,
  title: `Item ${number}`,
  state: "OPEN",
  author,
  labels: { nodes: [] },
  assignees: { nodes: [] },
  url: `https://github.com/acme/widgets/issues/${number}`,
  body: "",
  updatedAt: "2026-10-10T00:00:00Z",
});

const octocat = { __typename: "User", login: "octocat" };

const mallory = { __typename: "User", login: "mallory" };

const dependabot = { __typename: "Bot", login: "dependabot" };

const mannequin = { __typename: "Mannequin", login: "imported" };

const repositories = {
  widgets: {
    nameWithOwner: "acme/widgets",
    hasIssuesEnabled: true,
    viewerPermission: "WRITE",
    openIssues: { nodes: [node(1, octocat), node(8, mallory), node(12, dependabot)] },
    closedIssues: { nodes: [] },
    openPrs: {
      nodes: [node(2, octocat), node(3, dependabot), node(4, mallory), node(13, mannequin)],
    },
    closedPrs: { nodes: [] },
  },
  lib: {
    nameWithOwner: "other/lib",
    hasIssuesEnabled: true,
    viewerPermission: "READ",
    openIssues: { nodes: [node(5, octocat)] },
    closedIssues: { nodes: [] },
    openPrs: { nodes: [node(6, dependabot), node(7, octocat)] },
    closedPrs: { nodes: [] },
  },
};

it("caches only the signed-in account's items and bot PRs on writable repos", async () => {
  const scratch = mkdtempSync(join(tmpdir(), "workspace-github-visibility-"));
  const login = join(scratch, "login");
  const widgetsFails = join(scratch, "widgets-fails");
  const userFails = join(scratch, "user-fails");
  writeFileSync(login, "octocat");

  const restore = installFakeGh(
    scratch,
    `
    const viewer = fs.readFileSync(${JSON.stringify(login)}, "utf8");
    if (args[0] === "api" && args[1] === "graphql") {
      const value = (key) => args.find((arg) => arg.startsWith(key + "="))?.slice(key.length + 1);
      if (value("viewer") !== viewer || !value("query").includes("filterBy: {createdBy: $viewer}")) {
        err("issues were not requested for the signed-in account"); process.exit(1);
      }
      const name = value("name");
      if (name === "widgets" && fs.existsSync(${JSON.stringify(widgetsFails)})) { err("fixture request failed"); process.exit(1); }
      out(JSON.stringify({ data: { repository: ${JSON.stringify(repositories)}[name] } }));
    } else if (args[0] === "api" && args[1] === "user") {
      if (fs.existsSync(${JSON.stringify(userFails)})) { err("HTTP 502"); process.exit(1); }
      out(JSON.stringify({ login: viewer }));
    }
  `,
  );

  const { api, harness } = createFakePluginHost({
    settings: { extraRepos: "acme/widgets,other/lib" },
    sdk: {
      projects: { list: async () => [] },
      plugins: { getSettings: async () => ({ ok: true, schema: {}, values: {} }) },
    },
  });

  const visible = async () =>
    z
      .object({
        items: z.array(z.object({ repo: z.string(), kind: z.string(), number: z.number() })),
      })
      .parse(await harness.behavior.callRpc("listItems", {}))
      .items.map((item) => `${item.repo} ${item.kind} ${item.number}`)
      .sort();

  try {
    const db = api.storage.database();
    api.storage.migrate(db, shippedMigrations);

    const insert = db.prepare(
      `INSERT INTO items (repo, number, kind, title, state, author, labels, assignees, url, body, updated_at)
       VALUES ('gone/repo', ?, ?, 'Cached before the rule', 'OPEN', ?, '[]', '[]', 'https://github.com/gone/repo', '', '2026-10-01T00:00:00Z')`,
    );

    insert.run(9, "issue", "octocat");
    insert.run(10, "issue", "mallory");
    insert.run(11, "pr", "app/dependabot");

    await plugin(api);
    expect(await visible()).toEqual([]);

    await harness.behavior.callRpc("refresh", null);

    const octocatItems = [
      "acme/widgets issue 1",
      "acme/widgets pr 2",
      "acme/widgets pr 3",
      "other/lib issue 5",
      "other/lib pr 7",
    ];

    expect(await visible()).toEqual(octocatItems);
    expect(await harness.behavior.callRpc("counts", null)).toMatchObject({ issues: 2, prs: 3 });

    writeFileSync(widgetsFails, "fail");
    await harness.behavior.callRpc("refresh", null);
    expect(await visible()).toEqual(octocatItems);

    rmSync(widgetsFails);
    writeFileSync(login, "mallory");
    await harness.behavior.callRpc("refresh", null);
    expect(await visible()).toEqual([
      "acme/widgets issue 8",
      "acme/widgets pr 3",
      "acme/widgets pr 4",
    ]);

    writeFileSync(userFails, "fail");
    await expect(harness.behavior.callRpc("refresh", null)).rejects.toThrow(
      "signed-in GitHub account",
    );
    expect(await visible()).toEqual([
      "acme/widgets issue 8",
      "acme/widgets pr 3",
      "acme/widgets pr 4",
    ]);
    expect(await harness.behavior.callRpc("counts", null)).toMatchObject({ stale: true });
    expect(await harness.behavior.callRpc("status", null)).toMatchObject({
      warnings: [expect.stringContaining("signed-in GitHub account")],
    });
  } finally {
    await harness.lifecycle.dispose();
    restore();
    rmSync(scratch, { recursive: true, force: true });
  }
});
