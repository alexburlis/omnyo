import { act, cleanup, fireEvent, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { renderSlot } from "@omnyo/plugin-sdk/testing/app";
import {
  experimental_useAppNavigate,
  useSdk,
  type PluginThreadActionTarget,
  type PluginSidebarThread,
  type PluginRpcResult,
} from "@omnyo/plugin-sdk/app";
import type { CanvasRpcContract } from "../contract";
import {
  ProjectEntryPoints,
  projectPaletteAction,
  projectThreadAction,
  projectRowMarksScript,
} from "../components/project-entry-points";

beforeEach(() => {
  vi.stubGlobal("matchMedia", () => ({
    matches: false,
    addEventListener() {},
    removeEventListener() {},
  }));
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function target(id: string): PluginThreadActionTarget {
  return {
    id,
    projectId: "proj_entries",
    parentThreadId: null,
    archivedAt: null,
    pinnedAt: null,
    shelvedAt: null,
    sectionId: null,
    isUnread: false,
    status: "idle",
    environment: null,
  };
}

function Menu({ threadId }: { threadId: string }) {
  const hook = projectThreadAction.useData;

  if (!hook) throw new Error("Missing Canvas actions loader");
  const data = hook({ threadIds: [threadId] });

  const action = projectThreadAction.item({
    thread: target(threadId),
    data,
    sdk: useSdk(),
    navigate: experimental_useAppNavigate(),
  });

  const loaded = data.rows ? <span>Canvas actions loaded</span> : null;

  if (!action) return loaded;

  return (
    <>
      {loaded}
      <button
        type="button"
        disabled={action.disabled}
        onClick={() => void action.run({ requestRename() {} })}
      >
        {action.label}
      </button>
      {action.detail ? <span>{action.detail}</span> : null}
    </>
  );
}

it("opens the selected project's Canvas from the palette", async () => {
  const view = renderSlot(
    { component: ProjectEntryPoints },
    {},
    { pluginId: "canvas", context: { projectId: "proj_entries", threadId: "thr_palette" } },
  );

  await act(async () => {
    await projectPaletteAction.run({
      projectId: "proj_entries",
      threadId: "thr_palette",
      openPanel: () => false,
    });
  });
  expect(view.navigateCalls).toContainEqual({
    method: "toPluginPanel",
    path: "p",
    options: { subPath: "proj_entries" },
  });
});

it("leaves a chat without a board out of the menu", async () => {
  const view = renderSlot(
    { component: Menu },
    { threadId: "thr_no_board" },
    {
      pluginId: "canvas",
      rpc: {
        "project.actions": () => [
          { threadId: "thr_no_board", projectId: "proj_entries", boardTitle: null, link: null },
        ],
      },
    },
  );

  await view.findByText("Canvas actions loaded");
  expect(view.queryByRole("button")).toBeNull();
});

it.each([
  {
    threadId: "thr_adopted",
    boardTitle: null,
    link: { sectionId: "sec_adopted", chat: false },
    label: "Open in project canvas",
    disabled: false,
    path: "proj_entries/s/sec_adopted",
  },
  {
    threadId: "thr_spawned",
    boardTitle: null,
    link: { sectionId: null, chat: true },
    label: "Show on canvas",
    disabled: false,
    path: "proj_entries/c/thr_spawned",
  },
])("offers the correct menu action for $threadId", async (row) => {
  const view = renderSlot(
    { component: Menu },
    { threadId: row.threadId },
    {
      pluginId: "canvas",
      rpc: {
        "project.actions": () => [
          {
            threadId: row.threadId,
            projectId: "proj_entries",
            boardTitle: row.boardTitle,
            link: row.link,
          },
        ],
      },
    },
  );

  const button = await view.findByRole("button", { name: row.label });
  await waitFor(() => expect(button).toHaveProperty("disabled", row.disabled));

  fireEvent.click(button);
  expect(view.navigateCalls).toContainEqual({
    method: "toPluginPanel",
    path: "p",
    options: { subPath: row.path },
  });
});

it("adopts a board through a fresh revision and opens its resulting section", async () => {
  const view = renderSlot(
    { component: Menu },
    { threadId: "thr_adopt_menu" },
    {
      pluginId: "canvas",
      rpc: {
        "project.actions": () => [
          {
            threadId: "thr_adopt_menu",
            projectId: "proj_entries",
            boardTitle: "Deployment",
            link: null,
          },
        ],
        "project.get": () => ({ revision: 17 }),
        "project.adopt": () => ({
          projectId: "proj_entries",
          revision: 18,
          homeViewId: null,
          archivedAt: null,
          sections: [{ id: "sec_menu", originThreadId: "thr_adopt_menu" }],
          views: [],
          chats: [],
        }),
        "project.journal": () => [
          {
            id: "adoption",
            revision: 18,
            actor: "human",
            label: "Add deployment",
            state: "applied",
            createdAt: 1,
          },
        ],
      },
    },
  );

  const button = await view.findByRole("button", { name: "Add board to project canvas" });
  await waitFor(() => expect(button).toHaveProperty("disabled", false));
  fireEvent.click(button);
  await waitFor(() =>
    expect(view.navigateCalls).toContainEqual({
      method: "toPluginPanel",
      path: "p",
      options: { subPath: "proj_entries/s/sec_menu" },
    }),
  );
  expect(view.rpcCalls).toContainEqual({
    method: "project.adopt",
    input: {
      projectId: "proj_entries",
      threadId: "thr_adopt_menu",
      title: "Deployment",
      actor: "human",
      expectedRevision: 17,
    },
  });
});

it("resolves a view link in an ordinary chat and leaves modified clicks alone", async () => {
  function Host() {
    return (
      <>
        <ProjectEntryPoints />
        <a href="#canvas-view-view_apps">Apps</a>
      </>
    );
  }

  const view = renderSlot(
    { component: Host },
    {},
    {
      pluginId: "canvas",
      context: { projectId: "proj_entries", threadId: "thr_normal" },
      rpc: { "project.view.resolve": () => ({ projectId: "proj_entries", viewId: "view_apps" }) },
    },
  );

  const link = view.getByRole("link", { name: "Apps" });
  fireEvent.click(link, { ctrlKey: true });
  expect(view.rpcCalls).toEqual([]);
  fireEvent.click(link);
  await waitFor(() =>
    expect(view.navigateCalls).toContainEqual({
      method: "toPluginPanel",
      path: "p",
      options: { subPath: "proj_entries/v/view_apps" },
    }),
  );
  expect(view.rpcCalls).toContainEqual({
    method: "project.view.resolve",
    input: { projectId: "proj_entries", viewId: "view_apps" },
  });
});

it("shows a missing view without navigating to a fabricated destination", async () => {
  function Host() {
    return (
      <>
        <ProjectEntryPoints />
        <a href="#canvas-view-view_missing">Missing</a>
      </>
    );
  }

  const view = renderSlot(
    { component: Host },
    {},
    {
      pluginId: "canvas",
      context: { projectId: "proj_entries", threadId: "thr_normal_missing" },
      rpc: { "project.view.resolve": () => null },
    },
  );

  fireEvent.click(view.getByRole("link", { name: "Missing" }));
  expect(await view.findByRole("alert")).toHaveProperty(
    "textContent",
    expect.stringContaining("no longer available"),
  );
  expect(view.navigateCalls).toEqual([]);
});

it("offers the shared return drawer before Undo removes anchored views", async () => {
  const project = {
    projectId: "proj_entries",
    revision: 21,
    homeViewId: "view_home",
    archivedAt: null,
    sections: [
      {
        id: "sec_undo",
        projectId: "proj_entries",
        title: "Deployment",
        question: null,
        x: 0,
        y: 0,
        order: 0,
        locked: false,
        archivedAt: null,
        originThreadId: "thr_original",
        createdBy: "human",
        createdAt: 1,
      },
    ],
    views: [
      {
        id: "view_apps",
        projectId: "proj_entries",
        title: "Apps view",
        order: 0,
        anchorKind: "section",
        regionId: "sec_undo",
        anchorId: "sec_undo",
        rect: { x: 0, y: 0, width: 900, height: 600 },
        createdBy: "human",
        createdAt: 1,
      },
    ],
    chats: [],
  };

  const view = renderSlot(
    { component: ProjectEntryPoints },
    {},
    {
      pluginId: "canvas",
      rpc: {
        "project.get": () => project,
        "project.return": () => ({ ...project, revision: 22, sections: [], views: [] }),
        "project.journal": () => [
          {
            id: "returned",
            revision: 22,
            actor: "human",
            label: "Return deployment",
            state: "applied",
            createdAt: 2,
          },
        ],
      },
    },
  );

  act(() => {
    window.dispatchEvent(
      new CustomEvent("canvas-project-adopted", {
        detail: { projectId: "proj_entries", sectionId: "sec_undo" },
      }),
    );
  });
  fireEvent.click(view.getByRole("button", { name: "Undo" }));
  expect(await view.findByText("Apps view")).toBeTruthy();
  expect(view.rpcCalls.some((call) => call.method === "project.return")).toBe(false);
  fireEvent.click(view.getByRole("button", { name: "Move back to chat" }));
  await waitFor(() =>
    expect(view.rpcCalls).toContainEqual({
      method: "project.return",
      input: {
        projectId: "proj_entries",
        sectionId: "sec_undo",
        expectedRevision: 21,
      },
    }),
  );
});

function sidebarThread(id: string): PluginSidebarThread {
  return {
    id,
    projectId: "proj_marks",
    title: id,
    titleFallback: null,
    displayTitle: id,
    experimental_subtitle: null,
    experimental_shelvedAt: null,
    experimental_shelfSortKey: null,
    parentThreadId: null,
    lifecycleOwnerThreadId: null,
    sourceThreadId: null,
    sectionId: null,
    originKind: null,
    originPluginId: null,
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
    href: `/projects/proj_marks/threads/${id}`,
    isHidden: false,
    environment: null,
    host: null,
    createdAt: 1,
    updatedAt: 1,
    lastReadAt: null,
    lastMessageAt: null,
    latestAttentionAt: 1,
  };
}

it("marks ordinary adopted and joined rows, then clears changed links and unloads", async () => {
  const controller = new AbortController();
  const setStatus = vi.fn();

  const dispose = await projectRowMarksScript.mount({
    pluginId: "canvas",
    generation: 1,
    signal: controller.signal,
    experimental_setThreadRowStatus: setStatus,
  });

  let rows: PluginRpcResult<CanvasRpcContract["project.actions"]> = [
    {
      threadId: "thr_mark_origin",
      projectId: "proj_marks",
      boardTitle: null,
      link: { sectionId: "sec_marks", chat: false },
    },
    {
      threadId: "thr_mark_joined",
      projectId: "proj_marks",
      boardTitle: null,
      link: { sectionId: "sec_marks", chat: false },
    },
    {
      threadId: "thr_mark_spawned",
      projectId: "proj_marks",
      boardTitle: null,
      link: { sectionId: "sec_marks", chat: true },
    },
    { threadId: "thr_mark_plain", projectId: "proj_marks", boardTitle: "Unadopted", link: null },
  ];

  const view = renderSlot(
    { component: ProjectEntryPoints },
    {},
    {
      pluginId: "canvas",
      sidebarThreads: { threads: rows.map((row) => sidebarThread(row.threadId)) },
      rpc: { "project.actions": () => rows },
    },
  );

  await waitFor(() =>
    expect(setStatus).toHaveBeenCalledWith("thr_mark_origin", {
      icon: "GridView",
      label: "In project canvas",
    }),
  );
  expect(setStatus).toHaveBeenCalledWith("thr_mark_joined", {
    icon: "GridView",
    label: "In project canvas",
  });
  expect(
    setStatus.mock.calls.some(([id]) => id === "thr_mark_spawned" || id === "thr_mark_plain"),
  ).toBe(false);
  rows = rows.map((row) => (row.threadId === "thr_mark_origin" ? { ...row, link: null } : row));
  await view.emitRealtime("canvas.project.changed", { projectId: "proj_marks", revision: 2 });
  await waitFor(() => expect(setStatus).toHaveBeenCalledWith("thr_mark_origin", null));
  view.unmount();
  expect(setStatus).toHaveBeenCalledWith("thr_mark_joined", null);

  if (dispose) await dispose();
});

it("keeps a replacement generation's marks when the previous script disposes", async () => {
  const first = new AbortController();
  const second = new AbortController();
  const setFirst = vi.fn();
  const setSecond = vi.fn();

  const disposeFirst = await projectRowMarksScript.mount({
    pluginId: "canvas",
    generation: 2,
    signal: first.signal,
    experimental_setThreadRowStatus: setFirst,
  });

  const view = renderSlot(
    { component: ProjectEntryPoints },
    {},
    {
      pluginId: "canvas",
      sidebarThreads: { threads: [sidebarThread("thr_mark_generation")] },
      rpc: {
        "project.actions": () => [
          {
            threadId: "thr_mark_generation",
            projectId: "proj_marks",
            boardTitle: null,
            link: { sectionId: "sec_generation", chat: false },
          },
        ],
      },
    },
  );

  await waitFor(() =>
    expect(setFirst).toHaveBeenCalledWith("thr_mark_generation", {
      icon: "GridView",
      label: "In project canvas",
    }),
  );

  type MountedScript = { dispose: Awaited<ReturnType<typeof projectRowMarksScript.mount>> };

  const secondMount: MountedScript = { dispose: undefined };

  await act(async () => {
    secondMount.dispose = await projectRowMarksScript.mount({
      pluginId: "canvas",
      generation: 3,
      signal: second.signal,
      experimental_setThreadRowStatus: setSecond,
    });
  });
  await waitFor(() =>
    expect(setSecond).toHaveBeenCalledWith("thr_mark_generation", {
      icon: "GridView",
      label: "In project canvas",
    }),
  );
  await act(async () => {
    if (disposeFirst) await disposeFirst();
  });
  expect(setSecond).toHaveBeenLastCalledWith("thr_mark_generation", {
    icon: "GridView",
    label: "In project canvas",
  });
  act(() => second.abort());
  expect(setSecond).toHaveBeenLastCalledWith("thr_mark_generation", null);
  view.unmount();

  if (secondMount.dispose) await secondMount.dispose();
});

it("reports a missing row-status capability visibly instead of omitting the mark", async () => {
  const controller = new AbortController();
  expect(() =>
    projectRowMarksScript.mount({ pluginId: "canvas", generation: 4, signal: controller.signal }),
  ).toThrow("require thread row status support");
  const view = renderSlot({ component: ProjectEntryPoints }, {}, { pluginId: "canvas" });
  expect(await view.findByRole("alert")).toHaveProperty(
    "textContent",
    expect.stringContaining("row marks require"),
  );
  view.unmount();

  const reset = await projectRowMarksScript.mount({
    pluginId: "canvas",
    generation: 5,
    signal: controller.signal,
    experimental_setThreadRowStatus: vi.fn(),
  });

  if (reset) await reset();
});
