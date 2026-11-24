import { describe, expect, it } from "vitest";
import { makeSidebarThread } from "./fixtures.js";
import {
  buildSidebarData,
  getSidebarData,
  resetSidebarDataCacheForTest,
} from "./use-sidebar-data.js";

describe("buildSidebarData", () => {
  it("groups threads by project, resolves the personal project, and collects hosts", () => {
    const projects = [
      {
        id: "proj_a",
        name: "A",
        isPersonal: false,
        href: "/projects/proj_a",
        settingsHref: "/projects/proj_a/settings",
      },
      {
        id: "proj_me",
        name: "Personal",
        isPersonal: true,
        href: "/projects/proj_me",
        settingsHref: "/projects/proj_me/settings",
      },
    ];

    const threads = [
      makeSidebarThread({
        id: "t1",
        projectId: "proj_a",
        host: { id: "h1", name: "Mac" },
      }),
      makeSidebarThread({
        id: "t2",
        projectId: "proj_me",
        host: { id: "h2", name: "Box" },
      }),
      makeSidebarThread({
        id: "t3",
        projectId: "proj_a",
        host: { id: "h1", name: "Mac" },
      }),
      makeSidebarThread({ id: "t4", projectId: "proj_gone" }),
    ];

    const data = buildSidebarData("ready", threads, projects, [
      { id: "sec_1", name: "Later", createdAt: 1, updatedAt: 1 },
    ]);

    expect(data.status).toBe("ready");
    expect(data.sections.map((section) => section.id)).toEqual(["sec_1"]);
    expect(
      data.projects.map((project) => [
        project.id,
        project.threads.map((t) => t.id),
      ]),
    ).toEqual([
      ["proj_a", ["t1", "t3"]],
      ["proj_me", ["t2"]],
    ]);
    expect(data.projects[0]).toMatchObject({
      name: "A",
      href: "/projects/proj_a",
      settingsHref: "/projects/proj_a/settings",
      isPersonal: false,
    });
    expect(data.personalProject?.id).toBe("proj_me");
    expect([...data.hostsById.entries()]).toEqual([
      ["h1", { id: "h1", name: "Mac" }],
      ["h2", { id: "h2", name: "Box" }],
    ]);
  });

  it("keeps shelved threads out of project groups and lets archived win over shelved", () => {
    const project = {
      id: "proj_a",
      name: "A",
      isPersonal: false,
      href: "/projects/proj_a",
      settingsHref: "/projects/proj_a/settings",
    };

    const data = buildSidebarData(
      "ready",
      [
        makeSidebarThread({ id: "active", projectId: "proj_a" }),
        makeSidebarThread({
          id: "shelved",
          projectId: "proj_a",
          experimental_shelvedAt: 5,
        }),
        makeSidebarThread({
          id: "archived",
          projectId: "proj_a",
          archivedAt: 6,
          experimental_shelvedAt: 5,
        }),
      ],
      [project],
      [],
    );

    expect(data.projects[0]?.threads.map((thread) => thread.id)).toEqual([
      "active",
      "archived",
    ]);
    expect(data.projects[0]?.shelvedThreads.map((thread) => thread.id)).toEqual(
      ["shelved"],
    );
  });

  it("nests forks under their lifecycle owner without overriding a real parent", () => {
    const project = {
      id: "proj_a",
      name: "A",
      isPersonal: false,
      href: "/projects/proj_a",
      settingsHref: "/projects/proj_a/settings",
    };

    const ownedFork = makeSidebarThread({
      id: "owned-fork",
      projectId: "proj_a",
      originKind: "fork",
      lifecycleOwnerThreadId: "owner",
    });

    const threads = [
      makeSidebarThread({ id: "owner", projectId: "proj_a" }),
      ownedFork,
      makeSidebarThread({
        id: "nested-fork",
        projectId: "proj_a",
        originKind: "fork",
        parentThreadId: "other",
        lifecycleOwnerThreadId: "owner",
      }),
      makeSidebarThread({
        id: "owned-spawn",
        projectId: "proj_a",
        lifecycleOwnerThreadId: "owner",
      }),
    ];

    const first = buildSidebarData("ready", threads, [project], []);

    expect(
      first.projects[0]?.threads.map((thread) => [
        thread.id,
        thread.parentThreadId,
      ]),
    ).toEqual([
      ["owner", null],
      ["owned-fork", "owner"],
      ["nested-fork", "other"],
      ["owned-spawn", null],
    ]);

    const second = buildSidebarData("ready", threads, [project], [], [], first);

    expect(second.projects[0]?.threads).toBe(first.projects[0]?.threads);
    expect(ownedFork.parentThreadId).toBeNull();
  });

  it("groups a handoff chain under its newest chat", () => {
    const project = {
      id: "proj_a",
      name: "A",
      isPersonal: false,
      href: "/projects/proj_a",
      settingsHref: "/projects/proj_a/settings",
    };

    const first = makeSidebarThread({
      id: "first",
      projectId: "proj_a",
      createdAt: 1,
    });

    const threads = [
      first,
      makeSidebarThread({
        id: "second",
        projectId: "proj_a",
        originKind: "handoff",
        sourceThreadId: "first",
        createdAt: 2,
      }),
      makeSidebarThread({
        id: "third",
        projectId: "proj_a",
        originKind: "handoff",
        sourceThreadId: "second",
        createdAt: 3,
      }),
      makeSidebarThread({
        id: "first-subagent",
        projectId: "proj_a",
        parentThreadId: "first",
      }),
    ];

    const data = buildSidebarData("ready", threads, [project], []);

    expect(
      data.projects[0]?.threads.map((thread) => [
        thread.id,
        thread.parentThreadId,
      ]),
    ).toEqual([
      ["first", "third"],
      ["second", "third"],
      ["third", null],
      ["first-subagent", "first"],
    ]);
    expect(first.parentThreadId).toBeNull();

    const again = buildSidebarData("ready", threads, [project], [], [], data);

    expect(again.projects[0]?.threads).toBe(data.projects[0]?.threads);
  });

  it("groups a source under its newest handoff and leaves older branches in place", () => {
    const project = {
      id: "proj_a",
      name: "A",
      isPersonal: false,
      href: "/projects/proj_a",
      settingsHref: "/projects/proj_a/settings",
    };

    const threads = [
      makeSidebarThread({ id: "source", projectId: "proj_a", createdAt: 1 }),
      makeSidebarThread({
        id: "older-branch",
        projectId: "proj_a",
        originKind: "handoff",
        sourceThreadId: "source",
        createdAt: 2,
      }),
      makeSidebarThread({
        id: "newer-branch",
        projectId: "proj_a",
        originKind: "handoff",
        sourceThreadId: "source",
        createdAt: 3,
      }),
    ];

    const data = buildSidebarData("ready", threads, [project], []);

    expect(
      data.projects[0]?.threads.map((thread) => [
        thread.id,
        thread.parentThreadId,
      ]),
    ).toEqual([
      ["source", "newer-branch"],
      ["older-branch", null],
      ["newer-branch", null],
    ]);
  });

  it("keeps pinned, nested, shelved and missing sources in place", () => {
    const project = {
      id: "proj_a",
      name: "A",
      isPersonal: false,
      href: "/projects/proj_a",
      settingsHref: "/projects/proj_a/settings",
    };

    const handoffFrom = (id: string, sourceThreadId: string) =>
      makeSidebarThread({
        id,
        projectId: "proj_a",
        originKind: "handoff",
        sourceThreadId,
        createdAt: 2,
      });

    const threads = [
      makeSidebarThread({ id: "pinned", projectId: "proj_a", pinnedAt: 5 }),
      handoffFrom("from-pinned", "pinned"),
      makeSidebarThread({
        id: "child",
        projectId: "proj_a",
        parentThreadId: "parent",
      }),
      makeSidebarThread({ id: "parent", projectId: "proj_a" }),
      handoffFrom("from-child", "child"),
      makeSidebarThread({
        id: "shelved",
        projectId: "proj_a",
        experimental_shelvedAt: 4,
      }),
      handoffFrom("from-shelved", "shelved"),
      handoffFrom("from-missing", "missing"),
    ];

    const data = buildSidebarData("ready", threads, [project], []);

    const parentById = new Map(
      [
        ...(data.projects[0]?.threads ?? []),
        ...(data.projects[0]?.shelvedThreads ?? []),
      ].map((thread) => [thread.id, thread.parentThreadId]),
    );

    expect(parentById.get("pinned")).toBeNull();
    expect(parentById.get("child")).toBe("parent");
    expect(parentById.get("shelved")).toBeNull();
    expect(parentById.get("from-missing")).toBeNull();
  });

  it("groups a source shown at the top level because its parent is not listed", () => {
    const project = {
      id: "proj_a",
      name: "A",
      isPersonal: false,
      href: "/projects/proj_a",
      settingsHref: "/projects/proj_a/settings",
    };

    const handoffFrom = (id: string, sourceThreadId: string) =>
      makeSidebarThread({
        id,
        projectId: "proj_a",
        originKind: "handoff",
        sourceThreadId,
        createdAt: 2,
      });

    const threads = [
      makeSidebarThread({
        id: "child-of-archived",
        projectId: "proj_a",
        parentThreadId: "archived-parent",
        createdAt: 1,
      }),
      handoffFrom("from-child-of-archived", "child-of-archived"),
      makeSidebarThread({
        id: "hidden-parent",
        projectId: "proj_a",
        isHidden: true,
      }),
      makeSidebarThread({
        id: "child-of-hidden",
        projectId: "proj_a",
        parentThreadId: "hidden-parent",
        createdAt: 1,
      }),
      handoffFrom("from-child-of-hidden", "child-of-hidden"),
      makeSidebarThread({
        id: "shelved-parent",
        projectId: "proj_a",
        experimental_shelvedAt: 4,
      }),
      makeSidebarThread({
        id: "child-of-shelved",
        projectId: "proj_a",
        parentThreadId: "shelved-parent",
        createdAt: 1,
      }),
      handoffFrom("from-child-of-shelved", "child-of-shelved"),
    ];

    const data = buildSidebarData("ready", threads, [project], []);

    const parentById = new Map(
      (data.projects[0]?.threads ?? []).map((thread) => [
        thread.id,
        thread.parentThreadId,
      ]),
    );

    expect(parentById.get("child-of-archived")).toBe("from-child-of-archived");
    expect(parentById.get("child-of-hidden")).toBe("from-child-of-hidden");
    expect(parentById.get("child-of-shelved")).toBe("from-child-of-shelved");
  });

  it("reports no personal project when none is flagged", () => {
    const data = buildSidebarData("loading", [], [], []);
    expect(data.personalProject).toBeNull();
    expect(data.projects).toEqual([]);
    expect(data.hostsById.size).toBe(0);
  });
});

describe("buildSidebarData structural sharing", () => {
  const projects = [
    {
      id: "proj_a",
      name: "A",
      isPersonal: false,
      href: "/a",
      settingsHref: "/a/s",
    },
    {
      id: "proj_b",
      name: "B",
      isPersonal: false,
      href: "/b",
      settingsHref: "/b/s",
    },
  ];

  it("keeps untouched projects and their thread arrays by identity across updates", () => {
    const a1 = makeSidebarThread({ id: "a1", projectId: "proj_a" });
    const b1 = makeSidebarThread({ id: "b1", projectId: "proj_b" });
    const first = buildSidebarData("ready", [a1, b1], projects, []);

    const b1Changed = makeSidebarThread({
      id: "b1",
      projectId: "proj_b",
      title: "renamed",
    });

    const second = buildSidebarData(
      "ready",
      [a1, b1Changed],
      projects,
      [],
      [],
      first,
    );

    expect(second.projects[0]).toBe(first.projects[0]);
    expect(second.projects[0]?.threads).toBe(first.projects[0]?.threads);
    expect(second.projects[1]).not.toBe(first.projects[1]);
    expect(second.projects).not.toBe(first.projects);
    expect(second.hostsById).toBe(first.hostsById);

    const third = buildSidebarData(
      "ready",
      [a1, b1Changed],
      projects,
      [],
      [],
      second,
    );

    expect(third.projects).toBe(second.projects);
  });

  it("serves one grouped result per host payload to every caller", () => {
    resetSidebarDataCacheForTest();

    const state = {
      status: "ready" as const,
      threads: [makeSidebarThread({ id: "a1", projectId: "proj_a" })],
      experimental_hosts: [],
      projects,
      sections: [],
      experimental_archived: null,
      experimental_shelved: null,
    };

    const data = getSidebarData(state);
    expect(getSidebarData({ ...state })).toBe(data);
    expect(getSidebarData({ ...state, threads: [...state.threads] })).not.toBe(
      data,
    );
    resetSidebarDataCacheForTest();
  });
});
