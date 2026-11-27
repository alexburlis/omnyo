import assert from "node:assert/strict";
import { it } from "node:test";
import type { ExperimentalProjectSidebarGroup } from "@omnyo/plugin-sdk/app";
import { projectSidebarClaims, unclaimedProjectThreads } from "../lib/project-sidebar.ts";

const groups: readonly ExperimentalProjectSidebarGroup[] = [
  {
    projectId: "p1",
    key: "canvas/tree/p1",
    items: [
      {
        id: "canvas",
        label: "Canvas",
        icon: "Layout",
        href: "/plugins/canvas",
        children: [
          {
            id: "section",
            label: "Section",
            icon: "Layout",
            href: "/plugins/canvas/p1/section",
            children: [
              {
                id: "chat",
                label: "Canvas chat",
                icon: "MessageSquare",
                href: "/plugins/canvas/p1/chat",
                threadId: "claimed",
              },
            ],
          },
        ],
      },
    ],
  },
  {
    projectId: "p2",
    items: [{ id: "canvas", label: "Canvas", icon: "Layout", href: "/plugins/canvas/p2" }],
  },
  {
    projectId: "missing",
    items: [
      {
        id: "chat",
        label: "Unavailable project chat",
        icon: "MessageSquare",
        href: "/",
        threadId: "unavailable",
      },
    ],
  },
];

const rows = [
  { id: "claimed", projectId: "p1", isPinned: false },
  { id: "claimed", projectId: "p2", isPinned: false },
  { id: "normal", projectId: "p1", isPinned: false },
  { id: "unavailable", projectId: "missing", isPinned: false },
];

for (const row of [
  { view: "projects", isPinned: false, claimedRemains: false },
  { view: "projects", isPinned: true, claimedRemains: false },
  { view: "inbox", isPinned: false, claimedRemains: true },
  { view: "inbox", isPinned: true, claimedRemains: true },
] as const) {
  it(`honors recursive rendered-project claims only in ${row.view}, pinned=${row.isPinned}`, () => {
    const claims = projectSidebarClaims(groups, new Set(["p1", "p2"]));
    const threads = rows.map((thread) => ({ ...thread, isPinned: row.isPinned }));
    const visible = unclaimedProjectThreads(threads, claims, row.view);
    assert.equal(
      visible.some((thread) => thread.id === "claimed" && thread.projectId === "p1"),
      row.claimedRemains,
    );
    assert.equal(
      visible.some((thread) => thread.id === "claimed" && thread.projectId === "p2"),
      true,
    );
    assert.equal(
      visible.some((thread) => thread.id === "normal"),
      true,
    );
    assert.equal(
      visible.some((thread) => thread.id === "unavailable"),
      true,
    );
    assert.equal(claims.has("missing"), false);
    assert.equal(claims.get("p2")?.size, 0);
  });
}

it("releases every chat claim when its provider unloads", () => {
  const before = unclaimedProjectThreads(
    rows,
    projectSidebarClaims(groups, new Set(["p1", "p2"])),
    "projects",
  );

  assert.equal(before.length, 3);

  const after = unclaimedProjectThreads(
    rows,
    projectSidebarClaims([], new Set(["p1", "p2"])),
    "projects",
  );

  assert.deepEqual(after, rows);
});

it("combines contributors in one project without consuming another project's chat", () => {
  const claims = projectSidebarClaims(
    [
      ...groups,
      {
        projectId: "p1",
        key: "other/tree/p1",
        items: [{ id: "other", label: "Other", icon: "Layout", href: "/", threadId: "normal" }],
      },
    ],
    new Set(["p1", "p2"]),
  );

  assert.deepEqual(unclaimedProjectThreads(rows, claims, "projects"), [rows[1], rows[3]]);
});
