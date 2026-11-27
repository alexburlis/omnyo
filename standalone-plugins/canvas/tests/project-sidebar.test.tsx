import { act, cleanup, waitFor } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { renderSlot } from "@omnyo/plugin-sdk/testing/app";
import type {
  ExperimentalProjectSidebarGroup,
  ExperimentalProjectSidebarItem,
  PluginSidebarThread,
} from "@omnyo/plugin-sdk/app";
import { projectSidebarItems } from "../components/project-sidebar";
import type { ProjectCanvas, ProjectSection, ProjectView } from "../project-contract";
import {
  archivedAdoptedCanvas,
  emptyServerCanvas,
  synthesizedOverview,
} from "./fixtures/project-canvas";

const projectId = "proj_sidebar";

const projects = [
  {
    id: projectId,
    name: "Project",
    isPersonal: false,
    href: "/compose",
    settingsHref: "/settings",
  },
];

function section(id: string, order = 0): ProjectSection {
  return {
    id,
    projectId,
    title: id,
    question: null,
    x: 100,
    y: 200,
    order,
    locked: false,
    archivedAt: null,
    originThreadId: null,
    createdBy: "human",
    createdAt: 1,
  };
}

function view(id: string, regionId: string | null, order = 0): ProjectView {
  return {
    id,
    projectId,
    title: id,
    order,
    anchorKind: regionId ? "section" : "free",
    regionId,
    anchorId: regionId,
    rect: { x: 40, y: 60, width: 1000, height: 700 },
    createdBy: "human",
    createdAt: 1,
  };
}

function canvas(): ProjectCanvas {
  return {
    projectId,
    revision: 7,
    homeViewId: "overview",
    archivedAt: null,
    sections: [section("sec_b", 1), section("sec_a")],
    views: [view("apps", "sec_a", 2), view("latency", "sec_a", 3), view("overview", null)],
    chats: [],
  };
}

function thread(id: string, overrides: Partial<PluginSidebarThread> = {}): PluginSidebarThread {
  return {
    id,
    projectId,
    title: id,
    titleFallback: null,
    displayTitle: id,
    experimental_subtitle: null,
    parentThreadId: null,
    lifecycleOwnerThreadId: null,
    sourceThreadId: null,
    sectionId: null,
    originKind: null,
    originPluginId: "canvas",
    providerId: "codex",
    status: "idle",
    runtimeStatus: "idle",
    queuedWork: "none",
    hasPendingInteraction: false,
    activity: { workflows: 0, backgroundAgents: 0, backgroundCommands: 0, planMode: 0, goals: 0 },
    indicator: "none",
    indicatorLabel: null,
    isUnread: false,
    isPinned: false,
    pinnedAt: null,
    pinSortKey: null,
    isArchived: false,
    archivedAt: null,
    experimental_shelvedAt: null,
    experimental_shelfSortKey: null,
    href: `/threads/${id}`,
    isHidden: false,
    environment: null,
    host: null,
    createdAt: 1,
    updatedAt: 1,
    lastReadAt: null,
    latestAttentionAt: 1,
    lastMessageAt: null,
    ...overrides,
  };
}

function setup(
  initial: ProjectCanvas,
  threads: PluginSidebarThread[] = [],
  fail = false,
  failures: { sectionUpdateAt?: number; journal?: boolean } = {},
) {
  let sectionUpdates = 0;
  let current = initial;

  const journal: Array<{
    id: string;
    revision: number;
    label: string;
    actor: string;
    state: "applied";
    createdAt: number;
  }> = [];

  const save = (label: string) => {
    current = { ...current, revision: current.revision + 1 };
    journal.push({
      id: `change_${current.revision}`,
      revision: current.revision,
      label,
      actor: "human",
      state: "applied",
      createdAt: 1,
    });

    return current;
  };

  let latest: readonly ExperimentalProjectSidebarGroup[] = [];

  function Probe() {
    latest = projectSidebarItems.useItems({ projects });

    return <output>{latest[0]?.items[0]?.children?.length ?? 0}</output>;
  }

  const harness = renderSlot(
    { component: Probe },
    {},
    {
      pluginId: "test-canvas",
      sidebarThreads: { threads },
      rpc: {
        "project.get": () => {
          if (fail) throw new Error("Canvas unavailable");

          return current;
        },
        "project.unseen": () => ({ sectionIds: ["sec_b"] }),
        "project.journal": () => {
          if (failures.journal) throw new Error("Journal unavailable");

          return journal;
        },
        "project.section.update": () => {
          sectionUpdates += 1;

          if (sectionUpdates === failures.sectionUpdateAt) throw new Error("Second move rejected");

          return save("Update section");
        },
        "project.undo": () => {
          current = { ...current, revision: current.revision + 1 };

          return current;
        },
        "project.view.put": () => save("Save view"),
        "project.view.reorder": () => save("Reorder views"),
        "project.chat.move": () => save("Move chat"),
        "project.view.remove": () => save("Remove view"),
        "project.section.archive": () => save("Archive section"),
      },
    },
  );

  return {
    harness,
    rows: () => latest[0]?.items ?? [],
    setProject: (value: ProjectCanvas) => {
      current = value;
    },
    recover: () => {
      fail = false;
    },
  };
}

function required(
  items: readonly ExperimentalProjectSidebarItem[],
  id: string,
): ExperimentalProjectSidebarItem {
  for (const item of items) {
    if (item.id === id) return item;

    if (item.children) {
      const found = item.children.find((child) => child.id === id);

      if (found) return found;

      for (const child of item.children) {
        const grandchild = child.children?.find((entry) => entry.id === id);

        if (grandchild) return grandchild;
      }
    }
  }

  throw new Error(`Missing sidebar item ${id}`);
}

afterEach(() => {
  cleanup();
  sessionStorage.clear();
});

async function settled(test: ReturnType<typeof setup>) {
  await waitFor(() => expect(test.harness.rpcCalls).toHaveLength(2));
  await act(async () => {});
}

it("keeps the Canvas row childless when the server reports only its synthesized Overview", async () => {
  const test = setup(emptyServerCanvas(projectId));
  await settled(test);
  expect(test.rows()[0]?.label).toBe("Canvas");
  expect(test.rows()[0]?.children).toBeUndefined();
  expect(test.rows()[0]?.onReorder).toBeUndefined();
});

it("keeps the Canvas row childless after archiving the last adopted board with its retained view", async () => {
  const test = setup(archivedAdoptedCanvas(projectId));

  await settled(test);
  expect(test.rows()[0]?.children).toBeUndefined();
});

it("opens the home view from the Canvas row and nests nothing for a lone view or lone section", async () => {
  const free = { ...view("corner", null, 1), title: "Whiteboard corner" };

  const viewsOnly = setup({
    ...emptyServerCanvas(projectId),
    revision: 1,
    views: [synthesizedOverview(projectId), free],
  });

  await settled(viewsOnly);
  expect(viewsOnly.rows()[0]).toMatchObject({ href: `/plugins/test-canvas/p/${projectId}/h` });
  expect(viewsOnly.rows()[0]?.children).toBeUndefined();
  cleanup();

  const populated = setup({
    ...emptyServerCanvas(projectId),
    revision: 1,
    sections: [section("sec_live")],
  });

  await settled(populated);
  expect(populated.rows()[0]).toMatchObject({ href: `/plugins/test-canvas/p/${projectId}/h` });
  expect(populated.rows()[0]?.children).toBeUndefined();
  cleanup();

  const chatting = setup(
    {
      ...emptyServerCanvas(projectId),
      revision: 1,
      chats: [
        {
          threadId: "free_chat",
          projectId,
          regionId: null,
          anchorKind: "free",
          anchorId: null,
          x: 0,
          y: 0,
          role: "spawned",
          state: "open",
          createdAt: 1,
        },
      ],
    },
    [thread("free_chat")],
  );

  await waitFor(() =>
    expect(chatting.rows()[0]?.children?.map((item) => item.id)).toEqual(["chat:free_chat"]),
  );
});

it("never lists the configured home view, and lists Overview once it is no longer home", async () => {
  const value = canvas();
  value.homeViewId = "wall";
  value.views = [...value.views, { ...view("wall", null, 4), title: "Ops wall" }];
  const test = setup(value);
  await waitFor(() =>
    expect(test.rows()[0]?.children?.map((item) => item.id)).toEqual([
      "view:overview",
      "section:sec_a",
      "section:sec_b",
    ]),
  );
  expect(test.rows()[0]?.href).toBe(`/plugins/test-canvas/p/${projectId}/h`);
  cleanup();

  const stale = canvas();
  stale.homeViewId = "retired";
  stale.sections = [...stale.sections, { ...section("sec_old", 2), archivedAt: 3 }];
  stale.views = [
    synthesizedOverview(projectId),
    view("apps", "sec_a", 2),
    view("latency", "sec_a", 3),
    view("retired", "sec_old", 5),
  ];
  const fallback = setup(stale);
  await waitFor(() =>
    expect(fallback.rows()[0]?.children?.map((item) => item.id)).toEqual([
      "section:sec_a",
      "section:sec_b",
    ]),
  );
});

it("folds a lone adopted section while keeping distinctly named origin views and dropping its own view", async () => {
  const value: ProjectCanvas = {
    ...emptyServerCanvas(projectId),
    revision: 4,
    sections: [{ ...section("sec_live"), title: "Live deployment", originThreadId: "origin" }],
    views: [
      synthesizedOverview(projectId),
      {
        ...view("adopted", "sec_live", 1),
        title: "Live deployment",
        rect: { x: 0, y: 0, width: 1480, height: 900 },
      },
      {
        ...view("apps", "sec_live", 2),
        rect: { x: 0, y: 0, width: 600, height: 400 },
      },
      view("latency", "sec_live", 3),
    ],
    chats: ["origin", "qa"].map((threadId) => ({
      threadId,
      projectId,
      regionId: "sec_live",
      anchorKind: "section" as const,
      anchorId: "sec_live",
      x: 0,
      y: 0,
      role: threadId === "origin" ? ("origin" as const) : ("spawned" as const),
      state: "open" as const,
      createdAt: 1,
    })),
  };

  const test = setup(value, [thread("origin"), thread("qa")]);
  await waitFor(() =>
    expect(test.rows()[0]?.children?.map((item) => item.id)).toEqual(["view:apps", "view:latency"]),
  );
  await act(async () => {
    await test.rows()[0]?.onReorder?.(["view:latency", "view:apps"]);
  });
  expect(test.harness.rpcCalls).toContainEqual({
    method: "project.view.reorder",
    input: {
      projectId,
      actor: "human",
      expectedRevision: 4,
      ids: [`view_overview_${projectId}`, "adopted", "latency", "apps"],
    },
  });
});

it("shows a lone section with only chats as a plain Canvas row that counts waiting chats", async () => {
  const value: ProjectCanvas = {
    ...emptyServerCanvas(projectId),
    revision: 3,
    sections: [{ ...section("sec_live"), title: "Live deployment", originThreadId: "origin" }],
    views: [
      synthesizedOverview(projectId),
      { ...view("adopted", "sec_live", 1), title: "Live deployment" },
    ],
    chats: ["origin", "summary"].map((threadId) => ({
      threadId,
      projectId,
      regionId: "sec_live",
      anchorKind: threadId === "origin" ? ("section" as const) : ("node" as const),
      anchorId: "sec_live",
      x: 0,
      y: 0,
      role: threadId === "origin" ? ("origin" as const) : ("spawned" as const),
      state: "open" as const,
      createdAt: 1,
    })),
  };

  const test = setup(value, [
    thread("origin"),
    thread("summary", { hasPendingInteraction: true, indicator: "waiting-for-input" }),
  ]);

  await waitFor(() => expect(test.rows()[0]?.count).toBe(1));
  expect(test.rows()[0]?.children).toBeUndefined();
  expect(test.rows()[0]?.onReorder).toBeUndefined();
});

it("never nests a lone view under a section but keeps a lone chat", async () => {
  const value = canvas();
  value.views = [view("overview", null), view("apps", "sec_a", 1)];
  value.chats = [
    {
      threadId: "solo",
      projectId,
      regionId: "sec_b",
      anchorKind: "section",
      anchorId: "sec_b",
      x: 0,
      y: 0,
      role: "spawned",
      state: "open",
      createdAt: 1,
    },
  ];
  const test = setup(value, [thread("solo")]);
  await waitFor(() => expect(required(test.rows(), "section:sec_b").children).toHaveLength(1));
  expect(required(test.rows(), "section:sec_a").children).toBeUndefined();
  expect(required(test.rows(), "section:sec_a").onReorder).toBeUndefined();
  expect(required(test.rows(), "section:sec_b").children?.map((item) => item.id)).toEqual([
    "chat:solo",
  ]);
});

it("always exposes a childless Canvas row for an empty project without creating data", async () => {
  const test = setup({ ...canvas(), sections: [], views: [], chats: [] });
  expect(test.rows()[0]).toMatchObject({
    label: "Canvas",
    href: "/plugins/test-canvas/p/proj_sidebar",
  });
  await waitFor(() => expect(test.harness.rpcCalls).toHaveLength(2));
  expect(test.rows()[0]?.children).toBeUndefined();
  expect(test.harness.rpcCalls.map((call) => call.method).sort()).toEqual([
    "project.get",
    "project.unseen",
  ]);
});

it("orders views and sections, preserves native indicators, and claims only visible spawned chats", async () => {
  const value = canvas();
  value.chats = ["running", "needs", "archived", "deleted", "origin", "joined", "resolved"].map(
    (threadId) => ({
      threadId,
      projectId,
      regionId: "sec_a",
      anchorKind: "section",
      anchorId: "sec_a",
      x: 0,
      y: 0,
      role: threadId === "origin" ? "origin" : threadId === "joined" ? "joined" : "spawned",
      state: threadId === "resolved" ? "resolved" : "open",
      createdAt: 1,
    }),
  );

  const test = setup(value, [
    thread("running", {
      status: "active",
      runtimeStatus: "active",
      indicator: "runtime",
      isUnread: true,
    }),
    thread("needs", { hasPendingInteraction: true, indicator: "waiting-for-input" }),
    thread("archived", { isArchived: true }),
    thread("origin"),
    thread("joined"),
    thread("resolved"),
  ]);

  await waitFor(() => expect(test.rows()[0]?.children).toHaveLength(2));
  const root = required(test.rows(), `canvas:${projectId}`);
  expect(root.children?.map((item) => item.id)).toEqual(["section:sec_a", "section:sec_b"]);
  expect(root.unread).toBe(true);
  const first = required(test.rows(), "section:sec_a");
  expect(first.count).toBe(1);
  expect(first.children?.map((item) => item.id)).toEqual([
    "view:apps",
    "view:latency",
    "chat:running",
    "chat:needs",
  ]);
  expect(required(test.rows(), "chat:running")).toMatchObject({
    threadId: "running",
    indicator: "runtime",
    unread: true,
    href: "/plugins/test-canvas/p/proj_sidebar/c/running",
  });
  expect(required(test.rows(), "section:sec_b").unread).toBe(true);
});

it("renames from a fresh revision and reorders sections through real RPC callbacks", async () => {
  const test = setup(canvas());
  await waitFor(() => expect(test.rows()[0]?.children).toHaveLength(2));
  test.setProject({ ...canvas(), revision: 20 });
  await act(async () => {
    await required(test.rows(), "section:sec_a").onRename?.("Deployment");
  });
  expect(test.harness.rpcCalls).toContainEqual({
    method: "project.section.update",
    input: {
      projectId,
      actor: "human",
      expectedRevision: 20,
      sectionId: "sec_a",
      title: "Deployment",
    },
  });
  await act(async () => {
    await test.rows()[0]?.onReorder?.(["section:sec_b", "section:sec_a"]);
  });
  expect(test.harness.rpcCalls).toContainEqual({
    method: "project.section.update",
    input: { projectId, actor: "human", expectedRevision: 21, sectionId: "sec_b", order: 0 },
  });
  expect(test.harness.rpcCalls).toContainEqual({
    method: "project.section.update",
    input: { projectId, actor: "human", expectedRevision: 22, sectionId: "sec_a", order: 1 },
  });
  expect(test.harness.experimental_actionHistory.undoLabels).toEqual([
    "Update section",
    "Reorder canvas contents",
  ]);
});

it.each([false, true])(
  "preserves a partial reorder and its failure when journal preparation fails: %s",
  async (journal) => {
    const test = setup(canvas(), [], false, { sectionUpdateAt: 2, journal });
    await waitFor(() => expect(test.rows()[0]?.children).toHaveLength(2));

    await act(async () => {
      await expect(test.rows()[0]?.onReorder?.(["section:sec_b", "section:sec_a"])).rejects.toThrow(
        journal
          ? "Second move rejected Change saved, but Undo could not be prepared."
          : "Second move rejected",
      );
    });

    if (journal) {
      expect(test.harness.experimental_actionHistory.undoLabels).toEqual([]);
    } else {
      expect(test.harness.experimental_actionHistory.undoLabels).toEqual(["Update section"]);
      await act(async () => {
        await test.harness.experimental_actionHistory.undo();
      });
      expect(test.harness.rpcCalls).toContainEqual({
        method: "project.undo",
        input: { projectId, changeId: "change_8", actor: "human", expectedRevision: 8 },
      });
    }
  },
);

it("moves a spawned chat between sections and rejects unrelated drops", async () => {
  const value = canvas();
  value.chats = [
    {
      threadId: "moving",
      projectId,
      regionId: "sec_a",
      anchorKind: "section",
      anchorId: "sec_a",
      x: 10,
      y: 20,
      role: "spawned",
      state: "open",
      createdAt: 1,
    },
  ];
  const test = setup(value, [thread("moving")]);
  await waitFor(() => expect(test.rows()[0]?.children).toHaveLength(2));
  await act(async () => {
    await required(test.rows(), "section:sec_b").onDrop?.("chat:moving");
  });
  expect(test.harness.rpcCalls).toContainEqual({
    method: "project.chat.move",
    input: {
      projectId,
      actor: "human",
      expectedRevision: 7,
      threadId: "moving",
      regionId: "sec_b",
      anchorKind: "section",
      anchorId: "sec_b",
      x: 0,
      y: 0,
    },
  });
  await act(async () => {
    await expect(required(test.rows(), "section:sec_b").onDrop?.("chat:ordinary")).rejects.toThrow(
      "no longer available",
    );
  });
  expect(test.harness.rpcCalls.filter((call) => call.method === "project.chat.move")).toHaveLength(
    1,
  );
});

it("refreshes the tree after realtime changes and keeps read errors visible with retry", async () => {
  const test = setup(canvas(), [], true);
  await waitFor(() => expect(test.rows()[0]?.status?.label).toBe("Canvas unavailable"));
  test.recover();
  await act(async () => {
    await test.rows()[0]?.menuItems?.[0]?.run();
  });
  await waitFor(() => expect(test.rows()[0]?.children).toHaveLength(2));
  test.setProject({
    ...canvas(),
    sections: [section("sec_new"), section("sec_next", 1)],
    views: [],
  });
  await act(async () => {
    await test.harness.emitRealtime("canvas.project.changed", { projectId });
  });
  await waitFor(() =>
    expect(test.rows()[0]?.children?.map((item) => item.id)).toEqual([
      "section:sec_new",
      "section:sec_next",
    ]),
  );
});

it("renames a view without losing its anchor and removes it through the view RPC", async () => {
  const test = setup(canvas());
  await waitFor(() => expect(test.rows()[0]?.children).toHaveLength(2));
  await act(async () => {
    await required(test.rows(), "view:apps").onRename?.("Apps now");
  });
  expect(test.harness.rpcCalls).toContainEqual({
    method: "project.view.put",
    input: {
      id: "apps",
      anchorKind: "section",
      regionId: "sec_a",
      anchorId: "sec_a",
      rect: { x: 40, y: 60, width: 1000, height: 700 },
      projectId,
      actor: "human",
      expectedRevision: 7,
      title: "Apps now",
    },
  });
  await act(async () => {
    await required(test.rows(), "view:apps")
      .menuItems?.find((item) => item.id === "remove")
      ?.run();
  });
  expect(test.harness.rpcCalls).toContainEqual({
    method: "project.view.remove",
    input: { projectId, actor: "human", expectedRevision: 8, id: "apps" },
  });
});

it("reorders anchored views without displacing other sections' views", async () => {
  const value = canvas();
  value.views = [
    view("overview", null),
    view("one", "sec_a", 1),
    view("other", "sec_b", 2),
    view("two", "sec_a", 3),
  ];
  const test = setup(value);
  await waitFor(() => expect(test.rows()[0]?.children).toHaveLength(2));
  await act(async () => {
    await required(test.rows(), "section:sec_a").onReorder?.(["view:two", "view:one"]);
  });
  expect(test.harness.rpcCalls).toContainEqual({
    method: "project.view.reorder",
    input: {
      projectId,
      actor: "human",
      expectedRevision: 7,
      ids: ["overview", "two", "other", "one"],
    },
  });
});

it("opens Update view through its route and copies a real deep link", async () => {
  const test = setup(canvas());
  await waitFor(() => expect(test.rows()[0]?.children).toHaveLength(2));
  await act(async () => {
    await required(test.rows(), "view:apps")
      .menuItems?.find((item) => item.id === "update")
      ?.run();
  });
  expect(test.harness.navigateCalls).toContainEqual({
    method: "toPluginPanel",
    path: "p",
    options: { subPath: `${projectId}/u/apps` },
  });
  await act(async () => {
    await required(test.rows(), "view:apps")
      .menuItems?.find((item) => item.label === "Copy link")
      ?.run();
  });
  expect(test.harness.experimental_clipboardWrites).toContainEqual({
    text: new URL(`/plugins/test-canvas/p/${projectId}/v/apps`, window.location.href).href,
  });
});
