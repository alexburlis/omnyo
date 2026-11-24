import { describe, expect, it } from "vitest";
import type { NativeChatSummary, ScanOutput } from "./host-contract.js";
import {
  buildPreview,
  chatKey,
  chatStatus,
  checkTarget,
  claimIndex,
  formatRelativeTime,
  pathContains,
  plannedProjects,
  planProjects,
  ProjectPlanner,
  type HostContext,
  type ProjectRecord,
} from "./service.js";
import type { PlannedProject } from "./contract.js";

const HOME = "/Users/ada";

const context: HostContext = {
  homeDir: HOME,
  roots: { codex: `${HOME}/.codex`, claude: `${HOME}/.claude` },
};

const NOW = Date.UTC(2026, 10, 12, 12);

function summary(
  overrides: Partial<NativeChatSummary> = {},
): NativeChatSummary {
  const cwd = overrides.cwd ?? `${HOME}/code/app`;

  return {
    providerId: "claude-code",
    sourceProviderThreadId: "s-1",
    sourcePath: `${HOME}/.claude/projects/-Users-ada-code-app/s-1.jsonl`,
    cwd,
    realCwd: cwd,
    cwdExists: true,
    cwdMatchesStore: true,
    projectRoot: { path: cwd, kind: "git", mainRepositoryPath: null },
    title: "Fix the build",
    firstPrompt: "Fix the build",
    createdAt: NOW - 3_600_000,
    lastMessageAt: NOW - 60_000,
    client: "cli",
    sizeBytes: 1024,
    forkedFromProviderThreadId: null,
    ...overrides,
  };
}

function project(
  id: string,
  name: string,
  path: string,
  hostId = "host-1",
): ProjectRecord {
  return { id, name, sources: [{ type: "local_path", hostId, path }] };
}

function planned(
  projects: ProjectRecord[],
  realPaths: ReadonlyMap<string, string | null> = new Map(),
): PlannedProject[] {
  return plannedProjects(projects, "host-1", realPaths);
}

function scanOf(
  chats: NativeChatSummary[],
  resolvedPaths: ScanOutput["resolvedPaths"] = [],
): ScanOutput {
  return {
    roots: context.roots,
    homeDir: HOME,
    chats,
    dropped: [],
    resolvedPaths,
  };
}

function plannable(chat: NativeChatSummary) {
  return {
    ...chat,
    key: chatKey(chat.providerId, chat.sourceProviderThreadId),
    status: "ready" as const,
  };
}

describe("chatStatus", () => {
  it("applies the documented precedence", () => {
    const broken = summary({
      cwdExists: false,
      cwd: HOME,
      cwdMatchesStore: false,
    });

    expect(
      chatStatus(
        broken,
        { sourceProviderThreadId: "s-1", threadId: "t", via: "identity" },
        context,
      ),
    ).toBe("omnyo-chat");
    expect(
      chatStatus(
        broken,
        { sourceProviderThreadId: "s-1", threadId: "t", via: "import" },
        context,
      ),
    ).toBe("already-imported");
    expect(chatStatus(broken, undefined, context)).toBe("folder-missing");
    expect(
      chatStatus(
        summary({ cwd: HOME, cwdMatchesStore: false }),
        undefined,
        context,
      ),
    ).toBe("not-a-project-folder");
    expect(
      chatStatus(summary({ cwdMatchesStore: false }), undefined, context),
    ).toBe("cwd-mismatch");
    expect(chatStatus(summary(), undefined, context)).toBe("ready");
  });

  it.each([
    ["/"],
    [HOME],
    [`${HOME}/`],
    [`${HOME}/.omnyo/thread-storage/thr_1`],
    [`${HOME}/.omnyo-dev/abc`],
    [`${HOME}/code/app/.omnyo/data`],
    [`${HOME}/.codex/worktrees/x`],
    [`${HOME}/.claude`],
    ["C:\\"],
  ])("treats %s as not a project folder", (cwd) => {
    expect(
      chatStatus(
        summary({ cwd }),
        undefined,
        cwd.startsWith("C:")
          ? { homeDir: "C:\\Users\\ada", roots: { codex: null, claude: null } }
          : context,
      ),
    ).toBe("not-a-project-folder");
  });

  it("prefers an identity claim over an import claim for the same session", () => {
    const claims = claimIndex({
      codex: [],
      "claude-code": [
        { sourceProviderThreadId: "s-1", threadId: "t-import", via: "import" },
        { sourceProviderThreadId: "s-1", threadId: "t-omnyo", via: "identity" },
      ],
    });

    expect(claims["claude-code"].get("s-1")).toMatchObject({
      threadId: "t-omnyo",
    });
  });
});

describe("pathContains", () => {
  it("matches whole path segments only", () => {
    expect(pathContains("/a/app", "/a/app")).toBe(true);
    expect(pathContains("/a/app/", "/a/app/src")).toBe(true);
    expect(pathContains("/a/app", "/a/application")).toBe(false);
    expect(pathContains("C:\\Code\\App", "c:/code/app/src")).toBe(true);
  });
});

describe("ProjectPlanner", () => {
  it("picks the longest local source on the same host that contains the cwd", () => {
    const planner = new ProjectPlanner(
      planned([
        project("p-outer", "code", `${HOME}/code`),
        project("p-app", "app", `${HOME}/code/app`),
        project(
          "p-other-host",
          "app elsewhere",
          `${HOME}/code/app/src`,
          "host-2",
        ),
        project("p-sibling", "application", `${HOME}/code/application`),
      ]),
      context,
    );

    expect(
      planner.target(
        summary({
          cwd: `${HOME}/code/app/src`,
          projectRoot: {
            path: `${HOME}/code/app`,
            kind: "git",
            mainRepositoryPath: null,
          },
        }),
      ),
    ).toEqual({
      kind: "existing",
      projectId: "p-app",
      name: "app",
    });
  });

  it("never files a repository under a folder project above it", () => {
    const planner = new ProjectPlanner(
      planned([project("p-folder", "projects", `${HOME}/projects`)]),
      context,
    );

    expect(planner.target(summary({ cwd: `${HOME}/projects/foo` }))).toEqual({
      kind: "new",
      name: "foo",
      path: `${HOME}/projects/foo`,
    });

    expect(
      planner.target(
        summary({
          cwd: `${HOME}/projects/notes`,
          projectRoot: {
            path: `${HOME}/projects/notes`,
            kind: "folder",
            mainRepositoryPath: null,
          },
        }),
      ),
    ).toEqual({ kind: "existing", projectId: "p-folder", name: "projects" });
  });

  it("maps a git worktree to the project of its main repository", () => {
    const planner = new ProjectPlanner(
      planned([project("p-omnyo", "omnyo", `${HOME}/projects/omnyo`)]),
      context,
    );

    const worktree = summary({
      cwd: `${HOME}/worktrees/omnyo/feature`,
      projectRoot: {
        path: `${HOME}/worktrees/omnyo/feature`,
        kind: "git-worktree",
        mainRepositoryPath: `${HOME}/projects/omnyo`,
      },
    });

    expect(planner.target(worktree)).toEqual({
      kind: "existing",
      projectId: "p-omnyo",
      name: "omnyo",
    });
    expect(new ProjectPlanner([], context).target(worktree)).toEqual({
      kind: "new",
      name: "omnyo",
      path: `${HOME}/projects/omnyo`,
    });
  });

  it("names new projects by folder, dedupes names and shares one proposal per folder", () => {
    const planner = new ProjectPlanner(
      planned([project("p-1", "app", "/elsewhere/app")]),
      context,
    );

    const nested = summary({
      cwd: `${HOME}/code/app/src`,
      projectRoot: {
        path: `${HOME}/code/app`,
        kind: "git",
        mainRepositoryPath: null,
      },
    });

    expect(planner.target(nested)).toEqual({
      kind: "new",
      name: "app 2",
      path: `${HOME}/code/app`,
    });
    expect(planner.target(summary({ cwd: `${HOME}/code/app` }))).toEqual({
      kind: "new",
      name: "app 2",
      path: `${HOME}/code/app`,
    });
    expect(planner.target(summary({ cwd: `${HOME}/other/app` }))).toEqual({
      kind: "new",
      name: "app 3",
      path: `${HOME}/other/app`,
    });
    expect(planner.newProjects()).toEqual([
      { name: "app 2", path: `${HOME}/code/app` },
      { name: "app 3", path: `${HOME}/other/app` },
    ]);
  });

  it("proposes the cwd itself when the repository root is the home folder", () => {
    const planner = new ProjectPlanner([], context);

    expect(
      planner.target(
        summary({
          cwd: `${HOME}/notes`,
          projectRoot: { path: HOME, kind: "git", mainRepositoryPath: null },
        }),
      ),
    ).toEqual({ kind: "new", name: "notes", path: `${HOME}/notes` });
  });
});

describe("buildPreview", () => {
  it("sorts by last message, counts by provider and lists only ready rows' projects", () => {
    const scan: ScanOutput = {
      roots: context.roots,
      homeDir: HOME,
      chats: [
        summary({
          sourceProviderThreadId: "old",
          lastMessageAt: NOW - 7_200_000,
        }),
        summary({
          sourceProviderThreadId: "home",
          cwd: HOME,
          lastMessageAt: NOW - 1_000,
        }),
        summary({
          providerId: "codex",
          sourceProviderThreadId: "cx",
          cwd: `${HOME}/code/tool`,
          lastMessageAt: NOW - 5_000,
        }),
        summary({ sourceProviderThreadId: "done", lastMessageAt: NOW - 9_000 }),
      ],
      dropped: [
        { providerId: "claude-code", reason: "scripted-session", count: 4 },
      ],
      resolvedPaths: [],
    };

    const preview = buildPreview({
      hostId: "host-1",
      hosts: [{ id: "host-1", name: "Mac", connected: true }],
      days: 2,
      nowMs: NOW,
      scan,
      claims: claimIndex({
        codex: [],
        "claude-code": [
          {
            sourceProviderThreadId: "done",
            threadId: "thr-done",
            via: "import",
          },
        ],
      }),
      projects: [project("p-app", "app", `${HOME}/code/app`)],
    });

    expect(
      preview.chats.map((chat) => [chat.key, chat.status, chat.threadId]),
    ).toEqual([
      ["claude-code:home", "not-a-project-folder", null],
      ["codex:cx", "ready", null],
      ["claude-code:done", "already-imported", "thr-done"],
      ["claude-code:old", "ready", null],
    ]);
    expect(preview.chats[0]).toMatchObject({
      reason: "Not in a project folder.",
      project: null,
    });
    expect(preview.chats[3]?.project).toEqual({
      kind: "existing",
      projectId: "p-app",
      name: "app",
    });
    expect(preview.counts).toEqual({
      found: 4,
      ready: 2,
      alreadyImported: 1,
      unavailable: 1,
      byProvider: {
        codex: { found: 1, ready: 1 },
        "claude-code": { found: 3, ready: 1 },
      },
    });
    expect(preview.newProjects).toEqual([
      { name: "tool", path: `${HOME}/code/tool` },
    ]);
    expect(preview.cutoffMs).toBe(NOW - 2 * 86_400_000);
    expect(preview.dropped).toEqual(scan.dropped);
  });
});

describe("copies of Omnyo chats", () => {
  it("files a fork of a claimed session under the Omnyo chat that claims it", () => {
    const preview = buildPreview({
      hostId: "host-1",
      hosts: [],
      days: 2,
      nowMs: NOW,
      scan: scanOf([
        summary({
          sourceProviderThreadId: "rewind-copy",
          forkedFromProviderThreadId: "omnyo-session",
        }),
        summary({
          sourceProviderThreadId: "imported-copy",
          forkedFromProviderThreadId: "imported-source",
        }),
        summary({
          sourceProviderThreadId: "own-fork",
          forkedFromProviderThreadId: "unknown-session",
        }),
        summary({
          providerId: "codex",
          sourceProviderThreadId: "codex-copy",
          forkedFromProviderThreadId: "omnyo-session",
        }),
      ]),
      claims: claimIndex({
        codex: [],
        "claude-code": [
          {
            sourceProviderThreadId: "omnyo-session",
            threadId: "thr-omnyo",
            via: "identity",
          },
          {
            sourceProviderThreadId: "imported-source",
            threadId: "thr-imported",
            via: "import",
          },
        ],
      }),
      projects: [project("p-app", "app", `${HOME}/code/app`)],
    });

    expect(
      preview.chats.map((chat) => [
        chat.key,
        chat.status,
        chat.threadId,
        chat.reason,
        chat.project?.kind ?? null,
      ]),
    ).toEqual([
      ["codex:codex-copy", "ready", null, null, "existing"],
      [
        "claude-code:imported-copy",
        "omnyo-chat",
        "thr-imported",
        "This chat is a copy of a chat in Omnyo.",
        null,
      ],
      ["claude-code:own-fork", "ready", null, null, "existing"],
      [
        "claude-code:rewind-copy",
        "omnyo-chat",
        "thr-omnyo",
        "This chat is a copy of a chat in Omnyo.",
        null,
      ],
    ]);
    expect(preview.counts.ready).toBe(2);
  });
});

describe("symlinked project folders", () => {
  it("matches a chat in the real folder to a project added through a symlink", () => {
    const preview = buildPreview({
      hostId: "host-1",
      hosts: [],
      days: 2,
      nowMs: NOW,
      scan: scanOf(
        [
          summary({
            cwd: `${HOME}/projects/omnyo/apps/web`,
            projectRoot: {
              path: `${HOME}/projects/omnyo`,
              kind: "git",
              mainRepositoryPath: null,
            },
          }),
        ],
        [
          {
            path: `${HOME}/projects/omnyo-link`,
            realPath: `${HOME}/projects/omnyo`,
          },
        ],
      ),
      claims: claimIndex({ codex: [], "claude-code": [] }),
      projects: [project("p-omnyo", "omnyo", `${HOME}/projects/omnyo-link`)],
    });

    expect(preview.chats.map((chat) => chat.project)).toEqual([
      { kind: "existing", projectId: "p-omnyo", name: "omnyo" },
    ]);
    expect(preview.newProjects).toEqual([]);
    expect(preview.projects).toEqual([
      {
        id: "p-omnyo",
        name: "omnyo",
        paths: [`${HOME}/projects/omnyo-link`, `${HOME}/projects/omnyo`],
      },
    ]);
  });
});

describe("planProjects", () => {
  const parent = summary({
    sourceProviderThreadId: "a",
    cwd: "/x/proj",
    projectRoot: { path: "/x/proj", kind: "folder", mainRepositoryPath: null },
    lastMessageAt: NOW - 1_000,
  });

  const nested = summary({
    sourceProviderThreadId: "b",
    cwd: "/x/proj/sub",
    projectRoot: {
      path: "/x/proj/sub",
      kind: "folder",
      mainRepositoryPath: null,
    },
    lastMessageAt: NOW - 2_000,
  });

  const firstApp = summary({
    sourceProviderThreadId: "c",
    cwd: "/a/app",
    lastMessageAt: NOW - 3_000,
  });

  const secondApp = summary({
    sourceProviderThreadId: "d",
    cwd: "/b/app",
    lastMessageAt: NOW - 4_000,
  });

  const chats = [parent, nested, firstApp, secondApp].map(plannable);

  it("plans only the selected chats and shows an unselected chat where it would go", () => {
    const all = planProjects(chats, [], context, () => true);

    expect(Object.fromEntries(all.targets)).toEqual({
      "claude-code:a": { kind: "new", name: "proj", path: "/x/proj" },
      "claude-code:b": { kind: "new", name: "proj", path: "/x/proj" },
      "claude-code:c": { kind: "new", name: "app", path: "/a/app" },
      "claude-code:d": { kind: "new", name: "app 2", path: "/b/app" },
    });

    const subset = planProjects(
      chats,
      [],
      context,
      (chat) => chat.key === "claude-code:b" || chat.key === "claude-code:d",
    );

    expect(Object.fromEntries(subset.targets)).toEqual({
      "claude-code:a": { kind: "new", name: "proj", path: "/x/proj" },
      "claude-code:b": { kind: "new", name: "sub", path: "/x/proj/sub" },
      "claude-code:c": { kind: "new", name: "app", path: "/a/app" },
      "claude-code:d": { kind: "new", name: "app", path: "/b/app" },
    });
    expect(subset.newProjects).toEqual([
      { name: "sub", path: "/x/proj/sub" },
      { name: "app", path: "/b/app" },
    ]);
  });
});

describe("checkTarget", () => {
  const chat = summary({
    cwd: "/x/proj/sub",
    projectRoot: {
      path: "/x/proj/sub",
      kind: "folder",
      mainRepositoryPath: null,
    },
  });

  it("keeps the previewed project while it still contains the chat", () => {
    const projects = planned([
      project("p-proj", "proj", "/x/proj"),
      project("p-sub", "sub", "/x/proj/sub"),
    ]);

    expect(
      checkTarget(
        chat,
        { kind: "existing", projectId: "p-proj", name: "proj" },
        projects,
        context,
      ),
    ).toEqual({ kind: "existing", projectId: "p-proj" });
    expect(
      checkTarget(
        chat,
        { kind: "existing", projectId: "p-gone", name: "gone" },
        projects,
        context,
      ),
    ).toEqual({ kind: "invalid" });
  });

  it("creates a previewed new project once and reuses one already at its path or real path", () => {
    const target = { kind: "new", name: "proj", path: "/x/proj" } as const;

    expect(checkTarget(chat, target, [], context)).toEqual({
      kind: "create",
      name: "proj",
      path: "/x/proj",
    });
    expect(
      checkTarget(
        chat,
        target,
        planned(
          [project("p-link", "link", "/links/proj")],
          new Map([["/links/proj", "/x/proj"]]),
        ),
        context,
      ),
    ).toEqual({ kind: "existing", projectId: "p-link" });
  });

  it("refuses a new project once another project holds the chat or has its name", () => {
    expect(
      checkTarget(
        chat,
        { kind: "new", name: "proj", path: "/x/proj" },
        planned([project("p-sub", "sub", "/x/proj/sub")]),
        context,
      ),
    ).toEqual({ kind: "invalid" });
    expect(
      checkTarget(
        chat,
        { kind: "new", name: "Sub", path: "/x/proj/sub" },
        planned([project("p-other", "sub", "/y/sub")]),
        context,
      ),
    ).toEqual({ kind: "invalid" });
  });

  it("refuses a new project the chat does not belong in", () => {
    for (const path of ["/y/other", "/x/proj/sub/deeper", HOME]) {
      expect(
        checkTarget(chat, { kind: "new", name: "other", path }, [], context),
      ).toEqual({ kind: "invalid" });
    }
  });
});

describe("formatRelativeTime", () => {
  it("uses short plain words", () => {
    expect(formatRelativeTime(NOW - 10_000, NOW)).toBe("just now");
    expect(formatRelativeTime(NOW - 5 * 60_000, NOW)).toBe("5 min ago");
    expect(formatRelativeTime(NOW - 2 * 3_600_000, NOW)).toBe("2 h ago");
    expect(formatRelativeTime(NOW - 30 * 3_600_000, NOW)).toBe("yesterday");
    expect(formatRelativeTime(NOW - 3 * 86_400_000, NOW)).toBe("3 days ago");
  });
});
