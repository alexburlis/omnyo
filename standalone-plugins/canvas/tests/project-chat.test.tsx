import { cleanup, fireEvent, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { renderSlot } from "@omnyo/plugin-sdk/testing/app";
import { makeThreadResponse } from "@omnyo/plugin-sdk/testing";
import type { experimental_PluginBrowserSdk } from "@omnyo/plugin-sdk/app";
import type { ProjectCanvas } from "../project-contract";
import { ProjectChatSurface } from "../components/project-chat";

beforeEach(() => {
  class Pointer extends MouseEvent {
    readonly pointerId: number;

    constructor(type: string, init: PointerEventInit) {
      super(type, init);
      this.pointerId = init.pointerId ?? 0;
    }
  }

  vi.stubGlobal("PointerEvent", Pointer);
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function openChatProject(revision: number): ProjectCanvas {
  return {
    projectId: "proj_canvas",
    revision,
    homeViewId: null,
    archivedAt: null,
    sections: [],
    views: [],
    chats: [
      {
        threadId: "thr_open",
        projectId: "proj_canvas",
        regionId: null,
        anchorKind: "free",
        anchorId: null,
        x: 1500,
        y: -300,
        role: "spawned",
        state: "open",
        createdAt: 1,
      },
    ],
  };
}

function renderOpenChat(move: () => Promise<ProjectCanvas>) {
  const props = {
    project: openChatProject(4),
    camera: { x: 0, y: 0, zoom: 1 },
    size: { width: 1000, height: 700 },
    target: { regionId: null, kind: "free" as const, id: null, x: 0, y: 0, label: "Canvas" },
    sectionRects: new Map(),
    openThreadId: "thr_open",
    changedNodes: [
      { sectionId: "sec_a", nodeId: "apps", rect: { x: 100, y: 400, width: 300, height: 120 } },
    ],
    onOpen: vi.fn(),
    onClose: vi.fn(),
    onCreated: vi.fn(),
    onJumpNode: vi.fn(),
    onChanges: vi.fn(),
  };

  const view = renderSlot({ component: ProjectChatSurface }, props, {
    pluginId: "canvas",
    rpc: { "project.chat.move": move },
  });

  const card = view.container.querySelector<HTMLElement>(".cnv-project-chat-card[data-open=true]");

  if (!card) throw new Error("Missing open chat card");

  return { view, card, props };
}

it("starts change connectors on the visible card when its anchor is off screen", () => {
  const { view, card } = renderOpenChat(() => new Promise(() => {}));

  expect([card.style.left, card.style.top]).toEqual(["552px", "8px"]);
  expect(view.container.querySelector(".cnv-project-chat-connectors path")?.getAttribute("d")).toBe(
    "M552,400 L400,400",
  );
});

it("drags an open card from where it is shown and keeps the drop until the move saves", () => {
  const move = vi.fn(() => new Promise<ProjectCanvas>(() => {}));
  const { view, card, props } = renderOpenChat(move);
  const header = card.querySelector("header");

  if (!header) throw new Error("Missing chat card header");
  header.setPointerCapture = vi.fn();
  fireEvent.pointerDown(header, { pointerId: 3, button: 0, clientX: 600, clientY: 20 });
  fireEvent.pointerMove(header, { pointerId: 3, clientX: 580, clientY: 120 });
  expect([card.style.left, card.style.top]).toEqual(["532px", "108px"]);
  fireEvent.pointerUp(header, { pointerId: 3, clientX: 580, clientY: 120 });
  expect(move).toHaveBeenCalledWith(
    expect.objectContaining({ regionId: null, anchorKind: "free", x: 532, y: 108 }),
  );
  expect([card.style.left, card.style.top]).toEqual(["532px", "108px"]);
  const saved = openChatProject(5);
  saved.chats = saved.chats.map((chat) => ({ ...chat, x: 532, y: 108 }));
  view.lifecycle.rerender(<ProjectChatSurface {...props} project={saved} />);
  expect([card.style.left, card.style.top]).toEqual(["532px", "108px"]);
  view.lifecycle.rerender(<ProjectChatSurface {...props} project={openChatProject(6)} />);
  expect([card.style.left, card.style.top]).toEqual(["552px", "8px"]);
});

it("starts a visible project chat with the selected anchor and native composer request", async () => {
  const project: ProjectCanvas = {
    projectId: "proj_canvas",
    revision: 0,
    homeViewId: null,
    archivedAt: null,
    sections: [],
    views: [],
    chats: [],
  };

  const spawn = vi.fn(
    async (_request: Parameters<experimental_PluginBrowserSdk["threads"]["spawn"]>[0]) =>
      makeThreadResponse({ id: "thr_canvas_created" }),
  );

  const created = vi.fn();

  const view = renderSlot(
    { component: ProjectChatSurface },
    {
      project,
      camera: { x: 0, y: 0, zoom: 1 },
      size: { width: 1000, height: 700 },
      target: {
        regionId: "sec_test",
        kind: "node",
        id: "latency",
        x: 1500,
        y: 300,
        label: "Deployment › Latency",
      },
      sectionRects: new Map(),
      openThreadId: null,
      changedNodes: [],
      onOpen: vi.fn(),
      onClose: vi.fn(),
      onCreated: created,
      onJumpNode: vi.fn(),
      onChanges: vi.fn(),
    },
    { pluginId: "canvas", sdk: { threads: { spawn } } },
  );

  fireEvent.change(view.getByTestId("omnyo-new-thread-composer-input"), {
    target: { value: "Add an error-rate chart" },
  });
  fireEvent.click(view.getByTestId("omnyo-new-thread-composer-submit"));
  await waitFor(() => expect(created).toHaveBeenCalledWith("thr_canvas_created"));
  expect(spawn).toHaveBeenCalledTimes(1);
  expect(spawn.mock.calls[0]?.[0]).toMatchObject({
    projectId: "proj_canvas",
    visibility: "visible",
    providerId: "codex",
    model: "gpt-5",
    environment: { type: "project-default" },
    input: [{ type: "text", text: "Add an error-rate chart", mentions: [] }],
    pluginMetadata: {
      canvasChat: true,
      projectId: "proj_canvas",
      regionId: "sec_test",
      anchorKind: "node",
      anchorId: "latency",
      x: 1500,
      y: 300,
    },
  });
});

it("names its target in the dock and lets the chip aim a new chat at the whole canvas", async () => {
  const project: ProjectCanvas = {
    projectId: "proj_canvas",
    revision: 3,
    homeViewId: null,
    archivedAt: null,
    views: [],
    chats: [],
    sections: [
      {
        id: "sec_test",
        projectId: "proj_canvas",
        title: "Deployment",
        question: null,
        x: 0,
        y: 0,
        order: 0,
        locked: false,
        archivedAt: null,
        originThreadId: null,
        createdBy: "human",
        createdAt: 1,
      },
    ],
  };

  const spawn = vi.fn(
    async (_request: Parameters<experimental_PluginBrowserSdk["threads"]["spawn"]>[0]) =>
      makeThreadResponse({ id: "thr_canvas_whole" }),
  );

  const created = vi.fn();

  const view = renderSlot(
    { component: ProjectChatSurface },
    {
      project,
      camera: { x: 0, y: 0, zoom: 1 },
      size: { width: 1000, height: 700 },
      target: {
        regionId: "sec_test",
        kind: "node",
        id: "latency",
        x: 1500,
        y: 300,
        label: "Deployment › Latency",
      },
      sectionRects: new Map(),
      openThreadId: null,
      changedNodes: [],
      onOpen: vi.fn(),
      onClose: vi.fn(),
      onCreated: created,
      onJumpNode: vi.fn(),
      onChanges: vi.fn(),
    },
    { pluginId: "canvas", sdk: { threads: { spawn } } },
  );

  const line = view.getByRole("textbox", { name: "Start a canvas chat" });
  expect(line.getAttribute("placeholder")).toBe("Ask or change something in Latency…");
  expect(view.queryByRole("combobox", { name: "Chat recipient" })).toBeNull();
  expect(view.getByText("New chat")).toBeTruthy();
  fireEvent.click(
    view.getByRole("button", {
      name: "Sending to Deployment › Latency. Switch to the whole canvas",
    }),
  );
  expect(
    view.getByRole("button", {
      name: "Sending to the whole canvas. Switch to Deployment › Latency",
    }),
  ).toBeTruthy();
  expect(line.getAttribute("placeholder")).toBe("Ask or change something on this canvas…");
  fireEvent.focus(line);
  fireEvent.change(view.getByTestId("omnyo-new-thread-composer-input"), {
    target: { value: "Summarize the whole canvas" },
  });
  fireEvent.click(view.getByTestId("omnyo-new-thread-composer-submit"));
  await waitFor(() => expect(created).toHaveBeenCalledWith("thr_canvas_whole"));
  expect(spawn.mock.calls[0]?.[0]).toMatchObject({
    visibility: "visible",
    pluginMetadata: {
      canvasChat: true,
      projectId: "proj_canvas",
      regionId: null,
      anchorKind: "free",
      anchorId: null,
      x: 500,
      y: 350,
    },
  });
});
