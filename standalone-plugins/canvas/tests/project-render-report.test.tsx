import { act, cleanup, fireEvent, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { renderSlot, type PluginRpcTestHandlers } from "@omnyo/plugin-sdk/testing/app";
import { boardAddressKey } from "../board-contract";
import { canvasNodeSchema, type Board, type CanvasRpcContract } from "../contract";
import type { ProjectCanvas, ProjectView } from "../project-contract";
import { renderReportSchema } from "../workspace-contract";
import { ProjectCanvasPage } from "../components/project";
import { ProjectCanvasHeader } from "../components/project-header";
import { RenderRegistry } from "../lib/inspection";
import {
  archivedAdoptedCanvas,
  emptyServerCanvas,
  synthesizedOverview,
} from "./fixtures/project-canvas";
import { projectFit } from "../components/project-geometry";
import { CompactViewportOverrideProvider } from "../ui/components/ui/hooks/use-compact-viewport";

beforeEach(() => {
  localStorage.clear();
  vi.stubGlobal("__OMNYO_PLUGIN_ID__", "canvas");
  vi.stubGlobal("matchMedia", () => ({
    matches: false,
    addEventListener() {},
    removeEventListener() {},
  }));
  vi.stubGlobal(
    "ResizeObserver",
    class {
      constructor(private readonly callback: ResizeObserverCallback) {}
      observe(target: Element) {
        if (target.classList.contains("cnv-board")) this.callback([], this);
      }
      unobserve() {}
      disconnect() {}
    },
  );
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(1000);
  vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(700);
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (
    this: HTMLElement,
  ) {
    return this.closest("[hidden]") ? new DOMRect() : new DOMRect(20, 30, 640, 180);
  });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  localStorage.clear();
});

it("zooms into the real project modules while retaining one world and its neighboring projects", async () => {
  localStorage.setItem("canvas.project.last", "proj_old");

  const projects = [
    { id: "proj_alpha", name: "Alpha", section: "Planning" },
    { id: "proj_beta", name: "Beta", section: "Metrics" },
    { id: "proj_empty", name: "Empty", section: null },
  ];

  const view = renderSlot<
    { subPath: string },
    Pick<CanvasRpcContract, "project.get" | "project.unseen" | "board.get">
  >(
    { component: ProjectCanvasPage },
    { subPath: "" },
    {
      pluginId: "canvas",
      sidebarThreads: {
        status: "ready",
        projects: projects.map(({ id, name }) => ({
          id,
          name,
          isPersonal: false,
          href: `/projects/${id}`,
          settingsHref: `/projects/${id}/settings`,
        })),
      },
      rpc: {
        "project.get": ({ projectId }) => {
          const name = projects.find(({ id }) => id === projectId)?.section;

          if (!name) return emptyServerCanvas(projectId);
          const fixture = archivedAdoptedCanvas(projectId, `sec_${projectId}`);

          return {
            ...fixture,
            sections: fixture.sections.map((section) => ({
              ...section,
              archivedAt: null,
              title: name,
              originThreadId: null,
            })),
          };
        },
        "project.unseen": () => ({ sectionIds: [] }),
        "board.get": (input) => ({ board: board(boardAddressKey(input)) }),
      },
    },
  );

  const alpha = await view.findByRole("button", { name: "Zoom to Alpha canvas" });
  const beta = view.getByRole("button", { name: "Zoom to Beta canvas" });
  const world = view.container.querySelector(".cnv-world");

  if (!(world instanceof HTMLElement)) throw new Error("Missing shared canvas world");
  expect(Number(world.style.getPropertyValue("--cnv-zoom"))).toBeLessThanOrEqual(0.32);
  expect(view.getByRole("button", { name: "Metrics" })).toBeTruthy();
  expect(view.queryByRole("button", { name: "Zoom to Empty canvas" })).toBeNull();
  expect(await within(world).findByText("Evidence sec_proj_beta")).toBeTruthy();

  const zoomOut = view.getByRole("button", { name: "Zoom out" });

  for (let step = 0; step < 4; step += 1) fireEvent.click(zoomOut);

  const initial = world.style.transform;
  const initialZoom = Number(world.style.getPropertyValue("--cnv-zoom"));
  expect(initialZoom).toBeLessThan(0.14);
  expect(initialZoom).toBeGreaterThan(0.1);
  expect(
    within(world)
      .getByRole("article", { name: "Note: Module sec_proj_beta" })
      .getAttribute("data-tile"),
  ).toBe("false");
  expect(within(world).getByText("Evidence sec_proj_beta")).toBeTruthy();

  fireEvent.click(beta);

  await waitFor(() => expect(world.style.transform).not.toBe(initial));
  expect(Number(world.style.getPropertyValue("--cnv-zoom"))).toBeGreaterThan(initialZoom);
  expect(view.container.querySelector(".cnv-world")).toBe(world);
  expect(within(world).getByRole("button", { name: "Zoom to Alpha canvas" })).toBe(alpha);
  expect(within(world).getByRole("button", { name: "Zoom to Beta canvas" })).toBe(beta);
  expect(await within(world).findByText("Evidence sec_proj_beta")).toBeTruthy();
  const surface = world.closest(".cnv-board");

  if (!surface) throw new Error("Missing canvas surface");
  const content = within(world).getByText("Evidence sec_proj_beta");
  const closeZoom = world.style.getPropertyValue("--cnv-zoom");
  const closeTransform = world.style.transform;

  fireEvent.wheel(surface, { deltaX: 12000, deltaY: 5000 });
  expect(world.style.transform).not.toBe(closeTransform);
  expect(world.style.getPropertyValue("--cnv-zoom")).toBe(closeZoom);
  expect(within(world).getByText("Evidence sec_proj_beta")).toBe(content);

  fireEvent.wheel(surface, { deltaX: -12000, deltaY: -5000 });
  const readX = (transform: string) => Number.parseFloat(transform.slice("translate(".length));
  expect(readX(world.style.transform)).toBeCloseTo(readX(closeTransform));
  const returnedTransform = world.style.transform;
  expect(within(world).getByText("Evidence sec_proj_beta")).toBe(content);
  fireEvent.wheel(surface, { metaKey: true, shiftKey: true, deltaY: 100 });
  expect(world.style.transform).not.toBe(returnedTransform);
  expect(world.style.getPropertyValue("--cnv-zoom")).toBe(closeZoom);
  expect(within(world).getByText("Evidence sec_proj_beta")).toBe(content);
  expect(view.navigateCalls).toEqual([]);
});

function board(id: string): Board {
  return {
    threadId: id,
    revision: 2,
    seenRevision: 2,
    sections: ["Evidence"],
    edges: [],
    nodes: [
      canvasNodeSchema.parse({
        id: "shared",
        kind: "note",
        order: 0,
        section: "Evidence",
        title: `Module ${id}`,
        body: `Evidence ${id}`,
        tone: "neutral",
        pinned: false,
        wide: false,
        href: null,
        language: null,
        html: null,
        options: [],
        recommended: null,
        progress: null,
        state: null,
        assetId: null,
        position: null,
        createdRevision: 1,
        updatedRevision: 2,
        updatedAt: 1,
      }),
    ],
  };
}

function fixture(
  options: {
    home?: ProjectView;
    subPath?: string;
    boardReady?: Promise<void>;
    emptySectionCount?: number;
  } = {},
) {
  const first = board("sec_first"),
    second = board("sec_second");

  const sectionBoards = options.emptySectionCount
    ? Array.from({ length: options.emptySectionCount }, (_, index) => ({
        ...board(`sec_empty_${index}`),
        nodes: [],
      }))
    : [first, second];

  const boards = new Map(sectionBoards.map((entry) => [entry.threadId, entry]));

  const project: ProjectCanvas = {
    projectId: "proj_reports",
    revision: 1,
    homeViewId: options.home?.id ?? null,
    archivedAt: null,
    views: options.home ? [options.home] : [],
    chats: [],
    sections: sectionBoards.map((entry, index) => ({
      id: entry.threadId,
      projectId: "proj_reports",
      title: entry.threadId,
      question: null,
      x: index * 1400,
      y: 0,
      order: index,
      locked: false,
      archivedAt: null,
      originThreadId: null,
      createdBy: "human",
      createdAt: 1,
    })),
  };

  const registry = new RenderRegistry();
  let acknowledge = async () => {};

  const verify = vi.fn(
    (input: {
      threadId?: string;
      board?: { threadId: string } | { sectionId: string };
      id: string;
    }) => {
      const key = boardAddressKey(input),
        current = boards.get(key);

      const node = current?.nodes.find((entry) => entry.id === input.id);

      if (!current || !node) throw new Error("Unknown fixture module");

      return registry.verify(key, node, current.revision, null);
    },
  );

  type ReportingContract = Pick<
    CanvasRpcContract,
    | "project.get"
    | "project.info"
    | "project.unseen"
    | "board.get"
    | "board.markSeen"
    | "board.historySummary"
    | "source.list"
    | "node.inspect"
    | "render.report"
    | "node.verify"
  >;

  const rpc: PluginRpcTestHandlers<ReportingContract> = {
    "project.get": () => project,
    "project.info": () => ({ name: "Reports" }),
    "project.unseen": () => ({ sectionIds: [] }),
    "board.get": async (input) => {
      await options.boardReady;

      return { board: boards.get(boardAddressKey(input)) ?? null };
    },
    "board.markSeen": () => ({ seenRevision: 2 }),
    "board.historySummary": () => ({ entries: [], total: 0, canUndo: false, canRedo: false }),
    "source.list": () => ({ sources: [] }),
    "node.inspect": (input) => {
      const current = boards.get(boardAddressKey(input)),
        node = current?.nodes[0];

      if (!current || !node) throw new Error("Missing fixture module");

      return { node, boardRevision: current.revision, fieldVersions: {} };
    },
    "render.report": async (input) => {
      await acknowledge();

      const key = boardAddressKey(input),
        current = boards.get(key);

      if (!current) throw new Error("Unknown fixture board");

      return {
        accepted: registry.report(
          key,
          input.reports.map((report) => renderReportSchema.parse(report)),
          current.nodes,
        ),
      };
    },
    "node.verify": verify,
  };

  function Page({ compact, subPath }: { compact: boolean; subPath?: string }) {
    return (
      <CompactViewportOverrideProvider isCompactViewport={compact}>
        <ProjectCanvasPage subPath={subPath ?? options.subPath ?? "proj_reports/s/sec_first"} />
      </CompactViewportOverrideProvider>
    );
  }

  const view = renderSlot<{ compact: boolean; subPath?: string }, ReportingContract>(
    { component: Page },
    { compact: false },
    { pluginId: "canvas", rpc },
  );

  return {
    view,
    first,
    second,
    registry,
    verify,
    Page,
    rpc,
    hold(next: () => Promise<void>) {
      acknowledge = next;
    },
    current(current: Board) {
      const node = current.nodes[0];

      if (!node) throw new Error("Missing fixture module");

      return registry.verify(current.threadId, node, current.revision, null);
    },
  };
}

it("automatically publishes each mounted section and invalidates a section when its modules leave the active DOM", async () => {
  const test = fixture();
  await waitFor(() =>
    expect(
      test.view.container.querySelector('[data-project-section-id="sec_first"] .cnv-node'),
    ).not.toBeNull(),
  );
  await waitFor(() =>
    expect(test.current(test.first)).toMatchObject({ current: true, report: { ready: true } }),
  );
  await waitFor(() =>
    expect(test.current(test.second)).toMatchObject({
      current: true,
      report: { text: expect.stringContaining("sec_second") },
    }),
  );
  const reportCalls = test.view.rpcCalls.filter((call) => call.method === "render.report");
  expect(
    reportCalls.some((call) =>
      JSON.stringify(call.input).includes('"board":{"sectionId":"sec_first"}'),
    ),
  ).toBe(true);
  const node = test.view.container.querySelector('[data-project-section-id="sec_first"] .cnv-node');

  if (!node) throw new Error("Missing rendered module");
  act(() => node.remove());
  await waitFor(() =>
    expect(test.current(test.first)).toMatchObject({
      current: true,
      report: { ready: false, text: "" },
    }),
  );
  expect(test.current(test.first).issues.join(" ")).toContain("not rendered");
});

it("reports the visible compact outline once instead of its retained hidden world", async () => {
  const test = fixture();
  await waitFor(() => expect(test.current(test.first).current).toBe(true));
  test.view.rerender(<test.Page compact />);
  await waitFor(() =>
    expect(test.view.container.querySelector(".cnv-project-world")?.hasAttribute("hidden")).toBe(
      true,
    ),
  );
  expect(
    test.view.container.querySelectorAll('[data-project-section-id="sec_first"] .cnv-node').length,
  ).toBe(2);
  await waitFor(() =>
    expect(test.current(test.first)).toMatchObject({
      current: true,
      report: { mode: "outline", ready: true },
    }),
  );

  const input = test.view.rpcCalls.findLast(
    (call) =>
      call.method === "render.report" &&
      JSON.stringify(call.input).includes('"sectionId":"sec_first"'),
  )?.input;

  expect(input).toMatchObject({
    board: { sectionId: "sec_first" },
    reports: [{ mode: "outline", ready: true }],
  });
});

it("awaits the selected section report acknowledgement before manual verification", async () => {
  const test = fixture();
  await waitFor(() => expect(test.current(test.first).current).toBe(true));

  const node = test.view.container.querySelector<HTMLElement>(
    '[data-project-section-id="sec_first"] .cnv-node',
  );

  if (!node) throw new Error("Missing rendered module");
  fireEvent.pointerDown(node);
  const button = await within(test.view.container).findByRole("button", { name: "Verify render" });
  let release = () => {};

  const held = new Promise<void>((resolve) => {
    release = resolve;
  });

  const started = vi.fn();
  test.hold(async () => {
    started();
    await held;
  });

  try {
    fireEvent.click(button);
    await waitFor(() => expect(started).toHaveBeenCalled());
    expect(test.verify).not.toHaveBeenCalled();
    release();
    await waitFor(() => expect(test.verify).toHaveBeenCalledOnce());
    expect(test.current(test.first)).toMatchObject({ current: true, report: { ready: true } });
  } finally {
    release();
  }
});

it("keeps a newer live render tracked when an older cull acknowledgement arrives late", async () => {
  const test = fixture();
  await waitFor(() => expect(test.current(test.first).report?.ready).toBe(true));
  const original = test.current(test.first).report?.capturedAt ?? 0;
  const node = test.view.container.querySelector('[data-project-section-id="sec_first"] .cnv-node');
  const parent = node?.parentElement;

  if (!node || !parent) throw new Error("Missing rendered module");
  let release = () => {};

  const held = new Promise<void>((resolve) => {
    release = resolve;
  });

  const started = vi.fn();
  let first = true;
  test.hold(async () => {
    if (!first) return;
    first = false;
    started();
    await held;
  });

  try {
    act(() => node.remove());
    await waitFor(() => expect(started).toHaveBeenCalledOnce());
    act(() => parent.append(node));
    await waitFor(() =>
      expect(test.current(test.first).report?.capturedAt).toBeGreaterThan(original),
    );
    expect(test.current(test.first).report?.ready).toBe(true);
    await act(async () => {
      release();
      await held;
    });
    expect(test.current(test.first).report?.ready).toBe(true);
    act(() => node.remove());
    await waitFor(() => expect(test.current(test.first).report?.ready).toBe(false));
  } finally {
    release();
  }
});

it("revisits the selected section after panning even when its URL is unchanged", async () => {
  const test = fixture();
  await waitFor(() => expect(test.current(test.first).current).toBe(true));
  const world = test.view.container.querySelector<HTMLElement>(".cnv-project-world .cnv-world");
  const surface = test.view.container.querySelector<HTMLElement>(".cnv-project-world .cnv-board");
  expect(test.view.container.querySelector(".cnv-project-contents")).toBeNull();
  act(() => {
    window.dispatchEvent(
      new CustomEvent("canvas-project-action", {
        detail: { projectId: "proj_reports", action: "contents" },
      }),
    );
  });
  const contents = test.view.container.querySelector<HTMLElement>(".cnv-project-contents");

  if (!world || !surface || !contents) throw new Error("Missing project navigation surface");
  const initial = world.style.transform;
  fireEvent.wheel(surface, { deltaX: 300, deltaY: 0 });
  await waitFor(() => expect(world.style.transform).not.toBe(initial));
  const panned = world.style.transform;
  fireEvent.click(within(contents).getByRole("button", { name: /^sec_first$/ }));
  await waitFor(() => expect(world.style.transform).not.toBe(panned));
});

it("keeps Contents and Changes from covering each other in the right-hand panel slot", async () => {
  const test = fixture();
  await waitFor(() => expect(test.current(test.first).current).toBe(true));

  const command = (action: "contents" | "changes") =>
    act(() => {
      window.dispatchEvent(
        new CustomEvent("canvas-project-action", { detail: { projectId: "proj_reports", action } }),
      );
    });

  const shown = (selector: string) => test.view.container.querySelector(selector) !== null;

  command("contents");
  await waitFor(() => expect(shown(".cnv-project-contents")).toBe(true));
  command("changes");
  await waitFor(() => expect(shown(".cnv-project-journal")).toBe(true));
  expect(shown(".cnv-project-contents")).toBe(false);
  command("contents");
  await waitFor(() => expect(shown(".cnv-project-contents")).toBe(true));
  expect(shown(".cnv-project-journal")).toBe(false);
});

it("lets Sources replace Changes and closes one layer per Escape", async () => {
  const test = fixture();
  await waitFor(() => expect(test.current(test.first).current).toBe(true));

  const command = (action: "contents" | "changes" | "sources") =>
    act(() => {
      window.dispatchEvent(
        new CustomEvent("canvas-project-action", { detail: { projectId: "proj_reports", action } }),
      );
    });

  const shown = (selector: string) => test.view.container.querySelector(selector) !== null;
  const escape = () => fireEvent.keyDown(document.body, { key: "Escape" });

  command("changes");
  await waitFor(() => expect(shown(".cnv-project-journal")).toBe(true));
  command("sources");
  await waitFor(() => expect(shown(".cnv-project .cnv-workbench")).toBe(true));
  expect(shown(".cnv-project-journal")).toBe(false);
  escape();
  await waitFor(() => expect(shown(".cnv-project .cnv-workbench")).toBe(false));
  command("contents");
  await waitFor(() => expect(shown(".cnv-project-contents")).toBe(true));
  escape();
  await waitFor(() => expect(shown(".cnv-project-contents")).toBe(false));
});

it("starts Contents with an empty search after it was closed mid-search", async () => {
  const test = fixture();
  await waitFor(() => expect(test.current(test.first).current).toBe(true));

  const contents = () =>
    act(() => {
      window.dispatchEvent(
        new CustomEvent("canvas-project-action", {
          detail: { projectId: "proj_reports", action: "contents" },
        }),
      );
    });

  const search = () =>
    test.view.container.querySelector<HTMLInputElement>(".cnv-project-contents input");

  contents();
  await waitFor(() => expect(search()).not.toBeNull());
  fireEvent.change(search()!, { target: { value: "no such section" } });
  fireEvent.keyDown(search()!, { key: "Escape" });
  await waitFor(() => expect(search()).toBeNull());
  contents();
  await waitFor(() => expect(search()?.value).toBe(""));
});

it("writes the remembered camera once after panning settles and flushes it on unmount", async () => {
  const key = "canvas.project.camera.proj_reports";
  const setItem = vi.spyOn(Storage.prototype, "setItem");
  const test = fixture();
  await waitFor(() => expect(test.current(test.first).current).toBe(true));
  const surface = test.view.container.querySelector<HTMLElement>(".cnv-project-world .cnv-board");

  if (!surface) throw new Error("Missing project navigation surface");
  await new Promise((resolve) => setTimeout(resolve, 350));
  localStorage.removeItem(key);
  setItem.mockClear();

  for (let index = 0; index < 6; index += 1) fireEvent.wheel(surface, { deltaX: 40, deltaY: 0 });
  expect(localStorage.getItem(key)).toBeNull();
  await waitFor(() => expect(localStorage.getItem(key)).not.toBeNull());
  expect(setItem.mock.calls.filter(([name]) => name === key)).toHaveLength(1);
  localStorage.removeItem(key);
  fireEvent.wheel(surface, { deltaX: 40, deltaY: 0 });
  expect(localStorage.getItem(key)).toBeNull();
  window.dispatchEvent(new Event("pagehide"));
  expect(localStorage.getItem(key)).not.toBeNull();
  localStorage.removeItem(key);
  fireEvent.wheel(surface, { deltaX: 40, deltaY: 0 });
  expect(localStorage.getItem(key)).toBeNull();
  test.view.unmount();
  expect(localStorage.getItem(key)).not.toBeNull();
  setItem.mockRestore();
});

it("opens the configured home view from the Canvas row over a remembered camera, again after panning", async () => {
  localStorage.setItem(
    "canvas.project.camera.proj_reports",
    JSON.stringify({ x: -4200, y: -3100, zoom: 0.4 }),
  );

  const home: ProjectView = {
    id: "view_wall",
    projectId: "proj_reports",
    title: "Ops wall",
    order: 1,
    anchorKind: "free",
    regionId: null,
    anchorId: null,
    rect: { x: 1400, y: 0, width: 640, height: 180 },
    createdBy: "human",
    createdAt: 1,
  };

  const test = fixture({ home, subPath: "proj_reports/h" });
  await waitFor(() =>
    expect(test.view.container.querySelector(".cnv-project-world .cnv-world")).not.toBeNull(),
  );
  const world = test.view.container.querySelector<HTMLElement>(".cnv-project-world .cnv-world");
  const surface = test.view.container.querySelector<HTMLElement>(".cnv-project-world .cnv-board");

  if (!world || !surface) throw new Error("Missing project navigation surface");
  const remembered = world.style.transform;
  expect(remembered).toContain("0.4");

  const redirect = {
    method: "toPluginPanel",
    path: "p",
    options: { subPath: "proj_reports/v/view_wall", replace: true },
  };

  await waitFor(() => expect(test.view.navigateCalls).toContainEqual(redirect));
  test.view.rerender(<test.Page compact={false} subPath="proj_reports/v/view_wall" />);
  await waitFor(() => expect(world.style.transform).not.toBe(remembered));
  const framed = world.style.transform;
  fireEvent.wheel(surface, { deltaX: 300, deltaY: 120 });
  await waitFor(() => expect(world.style.transform).not.toBe(framed));
  test.view.rerender(<test.Page compact={false} subPath="proj_reports/h" />);
  await waitFor(() =>
    expect(
      test.view.navigateCalls.filter((call) => JSON.stringify(call) === JSON.stringify(redirect)),
    ).toHaveLength(2),
  );
  test.view.rerender(<test.Page compact={false} subPath="proj_reports/v/view_wall" />);
  await waitFor(() => expect(world.style.transform).toBe(framed));
});

it("fits cold Overview Home to the same loaded bounds as a warm Home visit", async () => {
  let release = () => {};

  const boardReady = new Promise<void>((resolve) => {
    release = resolve;
  });

  const home = synthesizedOverview("proj_reports");
  const test = fixture({ home, subPath: "proj_reports/h", boardReady });

  const redirect = {
    method: "toPluginPanel",
    path: "p",
    options: { subPath: `proj_reports/v/${home.id}`, replace: true },
  };

  try {
    await waitFor(() => expect(test.view.navigateCalls).toContainEqual(redirect));
    test.view.rerender(<test.Page compact={false} subPath={`proj_reports/v/${home.id}`} />);
    await waitFor(() =>
      expect(test.view.rpcCalls.some((call) => call.method === "board.get")).toBe(true),
    );
    await act(async () => {
      release();
      await boardReady;
    });
    await waitFor(() => expect(test.current(test.first).current).toBe(true));
    await waitFor(() => expect(test.current(test.second).current).toBe(true));
    const world = test.view.container.querySelector<HTMLElement>(".cnv-project-world .cnv-world");
    const surface = test.view.container.querySelector<HTMLElement>(".cnv-project-world .cnv-board");

    if (!world || !surface) throw new Error("Missing project navigation surface");
    const cold = world.style.transform;
    fireEvent.wheel(surface, { deltaX: 300, deltaY: 120 });
    await waitFor(() => expect(world.style.transform).not.toBe(cold));
    const panned = world.style.transform;
    test.view.rerender(<test.Page compact={false} subPath="proj_reports/h" />);
    await waitFor(() =>
      expect(
        test.view.navigateCalls.filter((call) => JSON.stringify(call) === JSON.stringify(redirect)),
      ).toHaveLength(2),
    );
    test.view.rerender(<test.Page compact={false} subPath={`proj_reports/v/${home.id}`} />);
    await waitFor(() => expect(world.style.transform).not.toBe(panned));
    expect(world.style.transform).toBe(cold);
  } finally {
    release();
  }
});

it("shows HTML modules live and marks their section read when zoomed out above the map level", async () => {
  localStorage.setItem(
    "canvas.project.camera.proj_reports",
    JSON.stringify({ x: 40, y: 80, zoom: 0.2 }),
  );
  let release = () => {};

  const boardReady = new Promise<void>((resolve) => {
    release = resolve;
  });

  const test = fixture({ boardReady, subPath: "proj_reports" });
  const note = test.first.nodes[0];

  if (!note) throw new Error("Missing fixture module");
  test.first.nodes = [{ ...note, id: "chart", kind: "html", body: null, html: "<p>Chart</p>" }];
  test.first.seenRevision = 1;
  release();

  const chart = () =>
    test.view.container.querySelector<HTMLElement>(
      '[data-project-section-id="sec_first"] [data-node-id="chart"]:not([data-measuring])',
    );

  await waitFor(() => expect(chart()?.dataset.tile).toBe("false"));
  expect(
    test.view.container.querySelector<HTMLElement>(".cnv-project-world .cnv-world")?.style
      .transform,
  ).toContain("scale(0.2)");
  expect(chart()?.querySelector(".cnv-node-tile")).toBeNull();
  await waitFor(() =>
    expect(test.view.rpcCalls).toContainEqual(
      expect.objectContaining({
        method: "board.markSeen",
        input: { board: { sectionId: "sec_first" }, revision: 2 },
      }),
    ),
  );
});

it("keeps more than twelve HTML modules live when zoomed out", async () => {
  localStorage.setItem(
    "canvas.project.camera.proj_reports",
    JSON.stringify({ x: 40, y: 80, zoom: 0.2 }),
  );
  let release = () => {};

  const boardReady = new Promise<void>((resolve) => {
    release = resolve;
  });

  const test = fixture({ boardReady, subPath: "proj_reports" });
  const note = test.first.nodes[0];

  if (!note) throw new Error("Missing fixture module");
  test.first.nodes = Array.from({ length: 14 }, (_, index) => ({
    ...note,
    id: `chart-${index}`,
    kind: "html" as const,
    order: index,
    body: null,
    html: `<p>Chart ${index}</p>`,
  }));
  release();

  const charts = () =>
    Array.from(
      test.view.container.querySelectorAll<HTMLElement>(
        '[data-project-section-id="sec_first"] [data-node-id^="chart-"]:not([data-measuring])',
      ),
    );

  await waitFor(() => expect(charts()).toHaveLength(14));
  await waitFor(() =>
    expect(charts().filter((chart) => chart.dataset.tile === "true")).toEqual([]),
  );
});

it("finishes Overview Home loading past the capped atlas window", async () => {
  localStorage.setItem(
    "canvas.project.camera.proj_reports",
    JSON.stringify({ x: 40, y: 80, zoom: 0.1 }),
  );
  const home = synthesizedOverview("proj_reports");
  const test = fixture({ home, subPath: "proj_reports/h", emptySectionCount: 65 });
  await waitFor(() =>
    expect(test.view.navigateCalls).toContainEqual({
      method: "toPluginPanel",
      path: "p",
      options: { subPath: `proj_reports/v/${home.id}`, replace: true },
    }),
  );
  test.view.rerender(<test.Page compact={false} subPath={`proj_reports/v/${home.id}`} />);
  await waitFor(
    () => expect(test.view.rpcCalls.filter((call) => call.method === "board.get")).toHaveLength(65),
    { timeout: 5000 },
  );
  await waitFor(() =>
    expect(within(test.view.container).queryByText("Opening Overview…")).toBeNull(),
  );
  expect(test.view.container.querySelectorAll(".cnv-project-section").length).toBe(64);
});

it("keeps the compact header to the project while desktop names the section in view", async () => {
  const test = fixture();
  await waitFor(() => expect(test.current(test.first).current).toBe(true));
  test.view.rerender(<test.Page compact />);
  await waitFor(() =>
    expect(test.view.container.querySelector(".cnv-project-world")?.hasAttribute("hidden")).toBe(
      true,
    ),
  );

  function Header({ compact }: { compact: boolean }) {
    return (
      <CompactViewportOverrideProvider isCompactViewport={compact}>
        <ProjectCanvasHeader subPath="proj_reports/s/sec_first" />
      </CompactViewportOverrideProvider>
    );
  }

  const desktop = renderSlot(
    { component: Header },
    { compact: false },
    {
      pluginId: "canvas",
      rpc: test.rpc,
    },
  );

  const compact = renderSlot(
    { component: Header },
    { compact: true },
    {
      pluginId: "canvas",
      rpc: test.rpc,
    },
  );

  await waitFor(() =>
    expect(desktop.container.querySelector(".cnv-project-crumb-place")?.textContent).toBe(
      "sec_first",
    ),
  );
  await waitFor(() =>
    expect(compact.container.querySelector(".cnv-project-crumb")?.getAttribute("aria-label")).toBe(
      "Reports canvas. Jump to a section or view",
    ),
  );
  expect(compact.container.querySelector(".cnv-project-crumb-project")).toBeNull();
  expect(compact.container.querySelector(".cnv-project-crumb-place")).toBeNull();
});

it("fits Home against the collapsed World before its resize notification and preserves later pans", async () => {
  let width = 951;
  let notifyResize = () => {};

  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockImplementation(() => width);
  vi.stubGlobal(
    "ResizeObserver",
    class {
      constructor(private readonly callback: ResizeObserverCallback) {}
      observe(target: Element) {
        if (target.classList.contains("cnv-board")) {
          notifyResize = () => this.callback([], this);
          notifyResize();
        }
      }
      unobserve() {}
      disconnect() {}
    },
  );

  const home: ProjectView = {
    ...synthesizedOverview("proj_reports"),
    id: "view_wall",
    createdBy: "human",
    rect: { x: 1400, y: 0, width: 640, height: 180 },
  };

  const test = fixture({ home });
  await waitFor(() => expect(test.current(test.first).current).toBe(true));
  test.view.rerender(<test.Page compact={false} subPath="proj_reports/h" />);
  await waitFor(() =>
    expect(test.view.navigateCalls).toContainEqual({
      method: "toPluginPanel",
      path: "p",
      options: { subPath: "proj_reports/v/view_wall", replace: true },
    }),
  );
  test.view.rerender(<test.Page compact={false} subPath="proj_reports/v/view_wall" />);
  width = 1201;
  const world = test.view.container.querySelector<HTMLElement>(".cnv-project-world .cnv-world");
  const surface = test.view.container.querySelector<HTMLElement>(".cnv-project-world .cnv-board");

  if (!world || !surface) throw new Error("Missing project navigation surface");
  const expected = projectFit(home.rect, { width, height: 700 });
  await waitFor(() =>
    expect(world.style.transform).toBe(
      `translate(${expected.x}px, ${expected.y}px) scale(${expected.zoom})`,
    ),
  );
  fireEvent.wheel(surface, { deltaX: 300, deltaY: 120 });
  const panned = world.style.transform;
  width = 1301;
  act(() => notifyResize());
  await act(async () => {
    await new Promise<void>((resolve) =>
      window.requestAnimationFrame(() => window.requestAnimationFrame(() => resolve())),
    );
  });
  expect(world.style.transform).toBe(panned);

  test.view.rerender(<test.Page compact={false} subPath="proj_reports/h" />);
  await waitFor(() =>
    expect(test.view.navigateCalls.filter((call) => call.method === "toPluginPanel")).toHaveLength(
      2,
    ),
  );
  test.view.rerender(<test.Page compact={false} subPath="proj_reports/v/view_wall" />);
  fireEvent.wheel(surface, { deltaX: 120, deltaY: 80 });
  const interrupted = world.style.transform;
  await act(async () => {
    await new Promise<void>((resolve) =>
      window.requestAnimationFrame(() => window.requestAnimationFrame(() => resolve())),
    );
  });
  expect(world.style.transform).toBe(interrupted);
});
