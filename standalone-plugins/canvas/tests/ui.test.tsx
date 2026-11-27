import { act, cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  loadPluginApp,
  renderSlot,
  type PluginRpcTestHandlers,
} from "@omnyo/plugin-sdk/testing/app";
import {
  experimental_useAppNavigate,
  useComposer,
  useSdk,
  type ComposerMention,
} from "@omnyo/plugin-sdk/app";
import {
  realtimeChannel,
  type Board,
  type CanvasMode,
  type CanvasNode,
  type CanvasRpcContract,
} from "../contract";
import { boardAddressKey } from "../board-contract";
import { CanvasHeaderButton } from "../components/header";
import { CanvasModeMenu, modeMenuItem } from "../components/mode-toggle";
import { closeFullScreen } from "../components/fullscreen-state";
import { sourceInputSchema } from "../source-contract";
import { RenderRegistry } from "../lib/inspection";
import { renderReportSchema } from "../workspace-contract";
import { frameDocument } from "../lib/frame-document";
import { BoardView, CanvasPanel } from "../components/panel";
import { useWorkspaceEditor } from "../components/workspace-data";
import { COMPACT_VIEWPORT_QUERY } from "../ui/components/ui/hooks/use-compact-viewport";

const originalResizeObserver = globalThis.ResizeObserver;

const originalMatchMedia = window.matchMedia;

let compact = false;

let compactMedia: StubMediaQueryList | undefined;

class StubResizeObserver {
  static observed = new Map<Element, StubResizeObserver>();

  constructor(readonly callback: ResizeObserverCallback) {}

  observe(target: Element) {
    StubResizeObserver.observed.set(target, this);
  }
  unobserve(target: Element) {
    StubResizeObserver.observed.delete(target);
  }
  disconnect() {
    for (const [target, observer] of StubResizeObserver.observed)
      if (observer === this) StubResizeObserver.observed.delete(target);
  }

  resize(target: Element, blockSize: number) {
    const size = { blockSize, inlineSize: 960 };
    this.callback(
      [
        {
          target,
          borderBoxSize: [size],
          contentBoxSize: [size],
          devicePixelContentBoxSize: [size],
          contentRect: new DOMRectReadOnly(0, 0, 960, blockSize),
        },
      ],
      this,
    );
  }
}

class StubMediaQueryList extends EventTarget implements MediaQueryList {
  onchange = null;

  constructor(
    readonly media: string,
    public matches: boolean,
  ) {
    super();
  }

  addListener() {}

  removeListener() {}
}

beforeAll(() => {
  globalThis.ResizeObserver = StubResizeObserver;
  window.matchMedia = (query) => {
    const media = new StubMediaQueryList(query, compact);

    if (query !== COMPACT_VIEWPORT_QUERY) return media;

    return (compactMedia ??= media);
  };
});

afterAll(() => {
  globalThis.ResizeObserver = originalResizeObserver;
  window.matchMedia = originalMatchMedia;
});

beforeEach(() => {
  compact = false;
  compactMedia = undefined;
});

afterEach(() => {
  cleanup();
  closeFullScreen();
});

function node(id: string, overrides: Partial<CanvasNode> = {}): CanvasNode {
  return {
    id,
    kind: "note",
    order: 1,
    section: "Investigate",
    title: id,
    body: null,
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
    updatedRevision: 1,
    updatedAt: 0,
    ...overrides,
  };
}

function boardFor(threadId: string): Board {
  return {
    threadId,
    revision: 3,
    seenRevision: 1,
    sections: ["Investigate", "Decide"],
    nodes: [
      node("goal", { title: "Thread list under 1 s", body: "- [x] Reproduce", pinned: true }),
      node("tests", {
        kind: "status",
        title: "Server tests",
        state: "running",
        progress: 0.5,
        updatedRevision: 2,
      }),
      node("fix", {
        kind: "decision",
        section: "Decide",
        title: "How should we fix it?",
        options: ["Batch query", "Add a cache"],
        recommended: "Batch query",
        createdRevision: 3,
        updatedRevision: 3,
      }),
    ],
    edges: [{ from: "goal", to: "fix", label: "decides" }],
  };
}

function rpc(mode: () => CanvasMode): PluginRpcTestHandlers<CanvasRpcContract> {
  return {
    "project.unseen": () => ({ sectionIds: [] }),
    "project.actions": () => [],
    "project.view.resolve": () => null,
    "project.chat.changes": () => [],
    "project.link": () => null,
    "project.boards": () => [],
    "project.boardProject": () => ({ projectId: "proj_1" }),
    "project.info": () => ({ name: "Test project" }),
    "project.get": () => {
      throw new Error("Project canvas is outside this chat-board fixture");
    },
    "project.section.create": () => {
      throw new Error("Project canvas is outside this chat-board fixture");
    },
    "project.section.update": () => {
      throw new Error("Project canvas is outside this chat-board fixture");
    },
    "project.section.move": () => {
      throw new Error("Project canvas is outside this chat-board fixture");
    },
    "project.section.archive": () => {
      throw new Error("Project canvas is outside this chat-board fixture");
    },
    "project.section.restore": () => {
      throw new Error("Project canvas is outside this chat-board fixture");
    },
    "project.view.put": () => {
      throw new Error("Project canvas is outside this chat-board fixture");
    },
    "project.view.remove": () => {
      throw new Error("Project canvas is outside this chat-board fixture");
    },
    "project.view.reorder": () => {
      throw new Error("Project canvas is outside this chat-board fixture");
    },
    "project.view.home": () => {
      throw new Error("Project canvas is outside this chat-board fixture");
    },
    "project.chat.put": () => {
      throw new Error("Project canvas is outside this chat-board fixture");
    },
    "project.chat.move": () => {
      throw new Error("Project canvas is outside this chat-board fixture");
    },
    "project.chat.resolve": () => {
      throw new Error("Project canvas is outside this chat-board fixture");
    },
    "project.adopt": () => {
      throw new Error("Project canvas is outside this chat-board fixture");
    },
    "project.return": () => {
      throw new Error("Project canvas is outside this chat-board fixture");
    },
    "project.join": () => {
      throw new Error("Project canvas is outside this chat-board fixture");
    },
    "project.journal": () => {
      throw new Error("Project canvas is outside this chat-board fixture");
    },
    "project.redo": () => {
      throw new Error("Project canvas is outside this chat-board fixture");
    },
    "project.undo": () => {
      throw new Error("Project canvas is outside this chat-board fixture");
    },

    "node.add": () => ({ revision: 4, changeId: "4", added: ["n1"] }),
    "node.duplicate": () => ({ revision: 4, changeId: "4", id: "n1" }),
    "node.inspect": (input) => {
      const node = boardFor(boardAddressKey(input)).nodes.find((entry) => entry.id === input.id);

      if (!node) throw new Error("Node not found");

      return { node, boardRevision: 3, fieldVersions: {} };
    },
    "node.edit": () => ({ revision: 4, changeId: "4" }),
    "board.link": () => ({ revision: 4, changeId: "4" }),
    "board.history": () => ({ entries: [], canUndo: false, canRedo: false }),
    "board.historySummary": () => ({ entries: [], canUndo: false, canRedo: false, total: 0 }),
    "board.historyDetail": () => {
      throw new Error("No retained history in this fixture");
    },
    "board.undo": () => ({ revision: 4, changeId: "4" }),
    "board.redo": () => ({ revision: 4, changeId: "4" }),
    "render.report": (input) => ({ accepted: input.reports.length }),
    "node.verify": () => ({ report: null, current: false, issues: ["No render reported"] }),
    "source.list": () => ({ sources: [] }),
    "source.put": (input) => ({
      source: {
        definition: sourceInputSchema.parse(input.source),
        status: "idle",
        error: null,
        lastAttemptAt: null,
        lastSuccessAt: null,
        nextRefreshAt: null,
        failures: 0,
      },
      dataset: null,
    }),
    "source.refresh": () => {
      throw new Error("Source not configured");
    },
    "source.pause": () => {
      throw new Error("Source not configured");
    },
    "source.push": () => {
      throw new Error("Source not configured");
    },
    "source.credential": (input) => ({ slot: input.slot, configured: true }),
    "mode.get": () => mode(),
    "mode.off": () => ({ canvas: false, unseen: false, startedBy: null, movedTo: null }),
    "workspace.get": () => ({ environmentId: "env_1", hostId: "host_1" }),
    "board.get": (input) => ({ board: mode().canvas ? boardFor(boardAddressKey(input)) : null }),
    "board.markSeen": (input) => ({ seenRevision: input.revision }),
    "board.compose": () => ({ revision: 4, changeId: "4", notes: [] }),
    "node.move": () => ({ revision: 4, changeId: "c_move" }),
    "node.pin": () => ({ revision: 4, changeId: "c_pin" }),
    "node.archive": () => ({ revision: 4, changeId: null }),
  };
}

const on: CanvasMode = { canvas: true, unseen: false, startedBy: "user", movedTo: null };

const off: CanvasMode = { canvas: false, unseen: false, startedBy: null, movedTo: null };

function canvasPill(text: string): ComposerMention {
  return {
    kind: "plugin",
    pluginId: "canvas",
    provider: "mode",
    id: "canvas",
    label: "Canvas",
    from: 0,
    to: text.length,
  };
}

function hasCanvasPill(mentions: readonly ComposerMention[]): boolean {
  return mentions.some(
    (mention) =>
      mention.kind === "plugin" &&
      mention.pluginId === "canvas" &&
      mention.provider === "mode" &&
      mention.id === "canvas",
  );
}

function threadComposer(threadId: string, text = "") {
  return { text, scope: { kind: "thread" as const, threadId } };
}

const openCanvas = { method: "openThreadPanel", options: { actionId: "canvas", title: "Canvas" } };

describe("registration", () => {
  it("adds Canvas beside the chat instead of replacing the chat", async () => {
    const app = await loadPluginApp(() => import("../app"));

    expect(app.threadPanelActions).toEqual([
      expect.objectContaining({ id: "canvas", title: "Canvas", layout: "flush" }),
    ]);
    expect(app.threadHeaderActions.map((action) => action.id)).toEqual(["canvas-open"]);
    expect(app.composerCustomizations).toEqual([
      expect.objectContaining({
        id: "canvas-mode",
        scopes: ["new-thread", "thread"],
        plusMenu: [expect.objectContaining({ id: "mode", label: "Canvas", icon: "GridView" })],
        experimental_popups: [expect.objectContaining({ id: "mode", label: "Canvas" })],
      }),
    ]);
    expect(app.composerCustomizations[0]?.actions).toBeUndefined();
    expect(app.threadLists).toEqual([]);
  });
});

describe("side panel", () => {
  it("shows the board, its changes and links for a Canvas chat", async () => {
    renderSlot(
      { component: CanvasPanel },
      { threadId: "thr_board", params: null },
      { pluginId: "canvas", rpc: rpc(() => on), composer: threadComposer("thr_board") },
    );

    expect(await screen.findByText("Thread list under 1 s")).toBeTruthy();
    expect(screen.getByText("Investigate")).toBeTruthy();
    expect(screen.getByText("1 new")).toBeTruthy();
    expect(screen.getByText("1 updated")).toBeTruthy();
    expect(screen.getByText("decides")).toBeTruthy();
    expect(screen.getByRole("progressbar").getAttribute("aria-valuenow")).toBe("50");
    const toolbar = screen.getByRole("group", { name: "Canvas tools" });

    expect(toolbar.getAttribute("data-floating")).toBe("true");
    expect(toolbar.parentElement?.classList.contains("cnv-body")).toBe(true);
    expect(document.querySelector(".cnv-view > .cnv-toolbar[role='group']")).toBeNull();
    expect(within(toolbar).queryByRole("button", { name: "Fit" })).toBeNull();
    expect(within(toolbar).queryByRole("button", { name: /full screen/iu })).toBeNull();
    expect(screen.getByRole("button", { name: /^\d+%, fit board$/u }).getAttribute("title")).toBe(
      "Fit board",
    );

    for (const label of [
      "New conversation",
      "Undo",
      "Redo",
      "Inspect",
      "Changes",
      "Sources",
      "Jump to latest",
    ]) {
      const control = within(toolbar).getByRole("button", { name: label });
      expect(control.textContent).toBe("");
      expect(control.getAttribute("title")).toBeTruthy();
      expect(control.querySelector("[data-icon]")).toBeTruthy();
    }

    const add = within(toolbar).getByRole("button", { name: "Add to project canvas" });
    expect(add.textContent).toBe("Add to project");
    expect(add.getAttribute("data-labelled")).toBe("true");

    fireEvent.click(screen.getByRole("button", { name: "1 new" }));
    fireEvent.click(screen.getByRole("button", { name: "1 updated" }));
    expect(document.querySelector('.cnv-world[data-animate="true"]')).toBeTruthy();
  });

  it("zooms on pinch around the pointer and pans with two-finger scroll", async () => {
    renderSlot(
      { component: CanvasPanel },
      { threadId: "thr_zoom", params: null },
      { pluginId: "canvas", rpc: rpc(() => on), composer: threadComposer("thr_zoom") },
    );

    await screen.findByText("Thread list under 1 s");

    const surface = screen.getByRole("region", { name: /^Canvas board/u });
    const zoom = () => screen.getByRole("button", { name: /fit board$/u }).textContent;
    const world = () => surface.querySelector<HTMLElement>(".cnv-world")?.style.transform;
    const before = zoom();

    fireEvent.wheel(surface, { deltaY: -20, ctrlKey: true });
    await waitFor(() =>
      expect(Number.parseInt(zoom() ?? "", 10)).toBeGreaterThan(Number.parseInt(before ?? "", 10)),
    );

    const zoomed = zoom();
    const transform = world();

    fireEvent.wheel(surface, { deltaX: 40, deltaY: 120 });
    await waitFor(() => expect(world()).not.toBe(transform));
    expect(zoom()).toBe(zoomed);
  });

  it("dismisses the compact full-screen board when the desktop panel takes over", async () => {
    compact = true;

    const options = {
      pluginId: "canvas",
      rpc: rpc(() => on),
      composer: threadComposer("thr_full"),
    };

    renderSlot({ component: CanvasPanel }, { threadId: "thr_full", params: null }, options);

    await screen.findByRole("region", { name: "Decide" });
    expect(screen.queryByRole("dialog", { name: "Canvas" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Full screen" }));

    const dialog = await screen.findByRole("dialog", { name: "Canvas" });

    expect(await within(dialog).findByText("Thread list under 1 s")).toBeTruthy();
    expect(document.activeElement).toBe(dialog);
    expect(screen.getByText("Canvas is open full screen")).toBeTruthy();
    expect(screen.getAllByText("Thread list under 1 s")).toHaveLength(1);

    fireEvent.click(within(dialog).getByRole("button", { name: "Inspect" }));
    const workbench = within(dialog).getByRole("complementary", { name: "Canvas workbench" });
    fireEvent.keyDown(workbench, { key: "Escape" });
    expect(screen.getByRole("dialog", { name: "Canvas" })).toBe(dialog);

    const media = compactMedia;

    if (!media) throw new Error("Compact viewport is not observed");
    act(() => {
      media.matches = false;
      media.dispatchEvent(new Event("change"));
    });

    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Canvas" })).toBeNull());
    expect(await screen.findByText("Thread list under 1 s")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /full screen/iu })).toBeNull();
  });

  it("opens the zoomable board from a compact outline and returns to the outline", async () => {
    compact = true;

    const options = {
      pluginId: "canvas",
      rpc: rpc(() => on),
      composer: threadComposer("thr_mobile_full"),
    };

    renderSlot({ component: CanvasPanel }, { threadId: "thr_mobile_full", params: null }, options);

    expect(await screen.findByRole("region", { name: "Decide" })).toBeTruthy();
    expect(screen.queryByRole("region", { name: /^Canvas board/u })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Full screen" }));

    const dialog = await screen.findByRole("dialog", { name: "Canvas" });
    expect(await within(dialog).findByRole("region", { name: /^Canvas board/u })).toBeTruthy();
    expect(within(dialog).getByRole("button", { name: "Zoom in" })).toBeTruthy();
    expect(within(dialog).getByRole("button", { name: "Zoom out" })).toBeTruthy();
    fireEvent.click(within(dialog).getByRole("button", { name: "Exit full screen" }));

    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Canvas" })).toBeNull());
    expect(await screen.findByRole("region", { name: "Decide" })).toBeTruthy();
    expect(screen.queryByRole("region", { name: /^Canvas board/u })).toBeNull();
    expect(screen.getByRole("button", { name: "Full screen" })).toBeTruthy();
  });

  it("sends a decision through the thread composer and restores the draft", async () => {
    const view = renderSlot(
      { component: CanvasPanel },
      { threadId: "thr_decide", params: null },
      {
        pluginId: "canvas",
        rpc: rpc(() => on),
        composer: threadComposer("thr_decide", "half-typed note"),
      },
    );

    fireEvent.click(await screen.findByRole("button", { name: /Batch query/u }));

    await waitFor(() => expect(view.composer.submits).toHaveLength(1));
    expect(view.composer.text).toBe("half-typed note");
    expect(await screen.findByText("✓ Batch query")).toBeTruthy();
  });

  it("lists nodes by section on a compact screen", async () => {
    compact = true;
    renderSlot(
      { component: CanvasPanel },
      { threadId: "thr_compact", params: null },
      { pluginId: "canvas", rpc: rpc(() => on), composer: threadComposer("thr_compact") },
    );

    expect(await screen.findByRole("region", { name: "Decide" })).toBeTruthy();
    expect(screen.queryByRole("region", { name: /^Canvas board/u })).toBeNull();
    expect(screen.queryByRole("button", { name: "Jump to latest" })).toBeNull();
  });

  it.each([false, true])(
    "uses composed reading order and emphasis with compact=%s",
    async (isCompact) => {
      compact = isCompact;
      const board = boardFor("composed-order");
      board.composition = {
        width: 960,
        root: {
          flow: "column",
          children: [
            { node: "fix", emphasis: "lead" },
            { node: "goal", emphasis: "quiet" },
          ],
        },
      };

      const handlers: PluginRpcTestHandlers<CanvasRpcContract> = {
        ...rpc(() => on),
        "board.get": () => ({ board }),
      };

      renderSlot(
        { component: CanvasPanel },
        { threadId: "composed-order", params: null },
        {
          pluginId: "canvas",
          rpc: handlers,
          composer: threadComposer("composed-order"),
        },
      );
      await screen.findByRole("article", { name: "Decision: How should we fix it?" });
      const articles = screen.getAllByRole("article");
      expect(articles.map((article) => article.getAttribute("data-node-id"))).toEqual([
        "fix",
        "goal",
        "tests",
      ]);
      expect(articles[0]?.getAttribute("data-emphasis")).toBe("lead");
      expect(articles[1]?.getAttribute("data-emphasis")).toBe("quiet");
      expect(screen.queryByRole("region", { name: "Investigate" })).toBeNull();
    },
  );

  it("rounds natural border-box height upward before laying out a zero-gap successor", async () => {
    const board = boardFor("fractional-flow");
    board.composition = {
      width: 960,
      root: { flow: "column", gap: 0, children: [{ node: "goal" }, { node: "tests" }] },
    };

    const handlers: PluginRpcTestHandlers<CanvasRpcContract> = {
      ...rpc(() => on),
      "board.get": () => ({ board }),
    };

    renderSlot(
      { component: CanvasPanel },
      { threadId: "fractional-flow", params: null },
      { pluginId: "canvas", rpc: handlers, composer: threadComposer("fractional-flow") },
    );
    const first = await screen.findByRole("article", { name: "Note: Thread list under 1 s" });
    const observer = StubResizeObserver.observed.get(first);

    if (observer === undefined) throw new Error("Missing node measurement observer");
    Object.defineProperty(first, "offsetHeight", { configurable: true, value: 100 });
    act(() => observer.resize(first, 100.25));
    expect(screen.getByRole("article", { name: "Status: Server tests" }).style.top).toBe("101px");
  });

  it("turns Canvas on from the panel and shows the board once the message is sent", async () => {
    let mode = off;

    const view = renderSlot(
      { component: CanvasPanel },
      { threadId: "thr_panel_on", params: null },
      {
        pluginId: "canvas",
        rpc: rpc(() => mode),
        composer: threadComposer("thr_panel_on", "Summarize what we found"),
      },
    );

    expect(await screen.findByText("Canvas is off")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Turn on Canvas" }));

    await waitFor(() => expect(hasCanvasPill(view.composer.draft.mentions)).toBe(true));
    expect(view.composer.text).toContain("Summarize what we found");
    expect(view.composer.focusCount).toBe(1);
    expect(await screen.findByText("Canvas starts with your next message")).toBeTruthy();

    mode = on;
    await act(() => view.emitRealtime(realtimeChannel, { threadId: "thr_panel_on", revision: 0 }));

    expect(await screen.findByText("How should we fix it?")).toBeTruthy();
  });

  it("sends the user to the chat that now holds a moved board", async () => {
    const view = renderSlot(
      { component: CanvasPanel },
      { threadId: "thr_old", params: null },
      {
        pluginId: "canvas",
        rpc: rpc(() => ({ ...off, movedTo: "thr_new" })),
        composer: threadComposer("thr_old"),
      },
    );

    expect(await screen.findByText("This board moved to another chat")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Turn on Canvas" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Open that chat" }));

    expect(view.navigateCalls).toEqual([{ method: "toThread", threadId: "thr_new" }]);
  });

  it("asks to retry when Canvas cannot load", async () => {
    let failing = true;

    const handlers: PluginRpcTestHandlers<CanvasRpcContract> = {
      ...rpc(() => on),
      "mode.get": () => {
        if (failing) throw new Error("offline");

        return on;
      },
    };

    renderSlot(
      { component: CanvasPanel },
      { threadId: "thr_failed", params: null },
      { pluginId: "canvas", rpc: handlers, composer: threadComposer("thr_failed") },
    );

    expect(await screen.findByText("Canvas could not load.")).toBeTruthy();

    failing = false;
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));

    expect(await screen.findByText("Thread list under 1 s")).toBeTruthy();
  });
});

describe("compact Canvas action", () => {
  it.each([
    { compact: true, enabled: true, sameChat: true, visible: true },
    { compact: false, enabled: true, sameChat: true, visible: false },
    { compact: true, enabled: false, sameChat: true, visible: false },
    { compact: true, enabled: true, sameChat: false, visible: false },
  ])(
    "shows Open Canvas only for the active compact chat with a board ($compact, $enabled, $sameChat)",
    async (test) => {
      compact = test.compact;
      const threadId = `thr_canvas_action_${test.compact}_${test.enabled}_${test.sameChat}`;
      const app = await loadPluginApp(() => import("../app"));
      const action = app.threadActions.find((entry) => entry.id === "open-chat-canvas");

      expect(action?.useData).toBeDefined();

      if (!action?.useData) throw new Error("Missing Canvas thread action");
      const useData = action.useData;

      function Menu() {
        const data = useData({ threadIds: [threadId] });
        const sdk = useSdk();
        const navigate = experimental_useAppNavigate();

        const item = action?.item({
          data,
          sdk,
          navigate,
          thread: {
            id: test.sameChat ? threadId : "thr_other",
            projectId: "proj_1",
            parentThreadId: null,
            archivedAt: null,
            pinnedAt: null,
            shelvedAt: null,
            sectionId: null,
            isUnread: false,
            status: "idle",
            environment: null,
          },
        });

        return item ? (
          <button type="button" onClick={() => void item.run({ requestRename() {} })}>
            {item.label}
          </button>
        ) : null;
      }

      const view = renderSlot(
        { component: Menu },
        {},
        {
          pluginId: "canvas",
          context: { projectId: "proj_1", threadId },
          composer: threadComposer(threadId),
          rpc: rpc(() => (test.enabled ? on : off)),
          openThreadPanel: () => true,
        },
      );

      await act(async () => {});
      expect(view.navigateCalls).toEqual([]);

      if (test.visible) {
        fireEvent.click(await screen.findByRole("button", { name: "Open Canvas" }));
        expect(view.navigateCalls).toEqual([openCanvas]);
      } else {
        expect(screen.queryByRole("button", { name: "Open Canvas" })).toBeNull();
      }
    },
  );
});

describe("header button", () => {
  it("opens the board on each visit and on every click", async () => {
    const props = { threadId: "thr_header", projectId: "proj_1", isCompactViewport: false };

    const declined = renderSlot({ component: CanvasHeaderButton }, props, {
      pluginId: "canvas",
      rpc: rpc(() => ({ canvas: true, unseen: true, startedBy: "user", movedTo: null })),
      openThreadPanel: () => false,
    });

    await waitFor(() => expect(declined.navigateCalls).toEqual([openCanvas]));
    declined.unmount();

    const first = renderSlot({ component: CanvasHeaderButton }, props, {
      pluginId: "canvas",
      rpc: rpc(() => ({ canvas: true, unseen: true, startedBy: "user", movedTo: null })),
      openThreadPanel: () => true,
    });

    const button = await screen.findByRole("button", {
      name: "Open Canvas, the board has changes",
    });

    await waitFor(() => expect(first.navigateCalls).toEqual([openCanvas]));

    fireEvent.click(button);

    expect(first.navigateCalls).toEqual([openCanvas, openCanvas]);

    first.unmount();

    const second = renderSlot({ component: CanvasHeaderButton }, props, {
      pluginId: "canvas",
      rpc: rpc(() => on),
      openThreadPanel: () => true,
    });

    expect(await screen.findByRole("button", { name: "Open Canvas" })).toBeTruthy();
    await waitFor(() => expect(second.navigateCalls).toEqual([openCanvas]));
  });

  it("stays hidden until the chat turns Canvas on", async () => {
    let mode = off;

    const view = renderSlot(
      { component: CanvasHeaderButton },
      { threadId: "thr_plain", projectId: "proj_1", isCompactViewport: false },
      { pluginId: "canvas", rpc: rpc(() => mode) },
    );

    await waitFor(() => expect(view.rpcCalls.map((call) => call.method)).toContain("mode.get"));
    await act(() => new Promise((resolve) => setTimeout(resolve, 0)));

    expect(screen.queryByRole("button")).toBeNull();
    expect(view.navigateCalls).toEqual([]);

    mode = on;
    await act(() => view.emitRealtime(realtimeChannel, { threadId: "thr_plain", revision: 0 }));

    expect(await screen.findByRole("button", { name: "Open Canvas" })).toBeTruthy();
    await waitFor(() => expect(view.navigateCalls).toEqual([openCanvas]));
  });

  it("opens the board when the agent turns Canvas on without navigating or focusing the composer", async () => {
    let mode = off;

    const view = renderSlot(
      { component: CanvasHeaderButton },
      { threadId: "thr_agent", projectId: "proj_1", isCompactViewport: false },
      { pluginId: "canvas", rpc: rpc(() => mode), openThreadPanel: () => true },
    );

    await waitFor(() => expect(view.rpcCalls.map((call) => call.method)).toContain("mode.get"));

    mode = { canvas: true, unseen: true, startedBy: "agent", movedTo: null };
    await act(() => view.emitRealtime(realtimeChannel, { threadId: "thr_agent", revision: 1 }));

    const button = await screen.findByRole("button", {
      name: "Open Canvas, the board has changes",
    });

    await waitFor(() => expect(view.navigateCalls).toEqual([openCanvas]));
    expect(view.composer.focusCount).toBe(0);

    fireEvent.click(button);

    expect(view.navigateCalls).toEqual([openCanvas, openCanvas]);
  });

  it("waits for a click on a phone instead of covering the chat", async () => {
    const view = renderSlot(
      { component: CanvasHeaderButton },
      { threadId: "thr_phone", projectId: "proj_1", isCompactViewport: true },
      { pluginId: "canvas", rpc: rpc(() => on) },
    );

    const button = await screen.findByRole("button", { name: "Open Canvas" });

    expect(button.textContent).toBe("");
    expect(view.navigateCalls).toEqual([]);

    fireEvent.click(button);

    expect(view.navigateCalls).toEqual([openCanvas]);
  });
});

describe("composer + menu", () => {
  it("turns Canvas on in an existing chat with the pill and opens the board beside it", async () => {
    const view = renderSlot(
      { component: CanvasModeMenu },
      {},
      {
        pluginId: "canvas",
        rpc: rpc(() => off),
        composer: threadComposer("thr_toggle", "Fix the thread list"),
      },
    );

    const toggle = await screen.findByRole("switch", { name: "Canvas" });

    await waitFor(() => expect(toggle.getAttribute("disabled")).toBeNull());
    expect(toggle.getAttribute("aria-checked")).toBe("false");

    fireEvent.click(toggle);

    await waitFor(() => expect(hasCanvasPill(view.composer.draft.mentions)).toBe(true));
    expect(view.composer.draft.mentions[0]?.from).toBe(0);
    expect(view.composer.text).toContain("Fix the thread list");
    expect(view.navigateCalls).toEqual([openCanvas]);
    expect(toggle.getAttribute("aria-checked")).toBe("true");
    expect(toggle.getAttribute("data-state")).toBe("pending");

    fireEvent.click(toggle);

    await waitFor(() => expect(view.composer.draft.mentions).toEqual([]));
    expect(view.composer.text).toBe("Fix the thread list");
    expect(toggle.getAttribute("aria-checked")).toBe("false");
  });

  it("opens the board again when returning after turning Canvas on", async () => {
    let mode = off;

    const toggle = renderSlot(
      { component: CanvasModeMenu },
      {},
      {
        pluginId: "canvas",
        rpc: rpc(() => mode),
        composer: threadComposer("thr_closed"),
        openThreadPanel: () => true,
      },
    );

    const button = await screen.findByRole("switch", { name: "Canvas" });

    await waitFor(() => expect(button.getAttribute("disabled")).toBeNull());
    fireEvent.click(button);

    expect(toggle.navigateCalls).toEqual([openCanvas]);

    toggle.unmount();
    mode = on;

    const header = renderSlot(
      { component: CanvasHeaderButton },
      { threadId: "thr_closed", projectId: "proj_1", isCompactViewport: false },
      { pluginId: "canvas", rpc: rpc(() => mode), openThreadPanel: () => true },
    );

    expect(await screen.findByRole("button", { name: "Open Canvas" })).toBeTruthy();
    await waitFor(() => expect(header.navigateCalls).toEqual([openCanvas]));
  });

  it("adds the pill without covering the chat on a phone", async () => {
    compact = true;

    const view = renderSlot(
      { component: CanvasModeMenu },
      {},
      { pluginId: "canvas", rpc: rpc(() => off), composer: threadComposer("thr_toggle_phone") },
    );

    const toggle = await screen.findByRole("switch", { name: "Canvas" });

    await waitFor(() => expect(toggle.getAttribute("disabled")).toBeNull());
    fireEvent.click(toggle);

    await waitFor(() => expect(hasCanvasPill(view.composer.draft.mentions)).toBe(true));
    expect(view.navigateCalls).toEqual([]);
  });

  it("turns Canvas off in a Canvas chat", async () => {
    const view = renderSlot(
      { component: CanvasModeMenu },
      {},
      { pluginId: "canvas", rpc: rpc(() => on), composer: threadComposer("thr_toggle_off") },
    );

    const toggle = await screen.findByRole("switch", { name: "Canvas" });

    await waitFor(() => expect(toggle.getAttribute("aria-checked")).toBe("true"));

    fireEvent.click(toggle);

    await waitFor(() => expect(view.rpcCalls.map((call) => call.method)).toContain("mode.off"));
    expect(view.rpcCalls.find((call) => call.method === "mode.off")?.input).toEqual({
      threadId: "thr_toggle_off",
    });
    expect(toggle.getAttribute("aria-checked")).toBe("false");
    expect(view.navigateCalls).toEqual([]);
  });

  it("adds and removes the pill in the new chat composer, keeping the typed message", async () => {
    const view = renderSlot(
      { component: CanvasModeMenu },
      {},
      {
        pluginId: "canvas",
        composer: { text: "Fix the thread list", scope: { kind: "new-thread", projectId: "p" } },
      },
    );

    fireEvent.click(screen.getByRole("switch", { name: "Canvas" }));

    await waitFor(() => expect(hasCanvasPill(view.composer.draft.mentions)).toBe(true));
    expect(view.composer.text).toContain("Fix the thread list");
    expect(screen.getByRole("switch", { name: "Canvas" }).getAttribute("aria-checked")).toBe(
      "true",
    );

    fireEvent.click(screen.getByRole("switch", { name: "Canvas" }));

    await waitFor(() => expect(view.composer.draft.mentions).toEqual([]));
    expect(view.composer.text).toBe("Fix the thread list");
  });

  it("shows a chat that already carries the pill as starting Canvas", async () => {
    renderSlot(
      { component: CanvasModeMenu },
      {},
      {
        pluginId: "canvas",
        rpc: rpc(() => off),
        composer: {
          text: "Canvas",
          mentions: [canvasPill("Canvas")],
          scope: { kind: "thread", threadId: "thr_pill" },
        },
      },
    );

    const toggle = await screen.findByRole("switch", { name: "Canvas" });

    expect(toggle.getAttribute("data-state")).toBe("pending");
  });

  it("opens the Canvas switch from the + menu and reports when it cannot", () => {
    const opened: string[] = [];
    const failures: string[] = [];

    function PlusMenu() {
      const composer = useComposer();

      function choose(available: boolean) {
        try {
          modeMenuItem.run({
            composer: {
              ...composer,
              experimental_openPopup: (id) => {
                opened.push(id);

                return available;
              },
            },
          });
        } catch (error) {
          failures.push(error instanceof Error ? error.message : String(error));
        }
      }

      return (
        <>
          <button type="button" onClick={() => choose(true)}>
            Open
          </button>
          <button type="button" onClick={() => choose(false)}>
            Unavailable
          </button>
        </>
      );
    }

    renderSlot(
      { component: PlusMenu },
      {},
      { pluginId: "canvas", composer: threadComposer("thr_plus") },
    );

    fireEvent.click(screen.getByRole("button", { name: "Open" }));
    fireEvent.click(screen.getByRole("button", { name: "Unavailable" }));

    expect(opened).toEqual(["mode", "mode"]);
    expect(failures).toEqual(["Canvas could not open in this composer."]);
  });

  it("renders nothing in a queued message editor", () => {
    renderSlot(
      { component: CanvasModeMenu },
      {},
      {
        pluginId: "canvas",
        composer: { scope: { kind: "queued-message", threadId: "t", queuedMessageId: "q" } },
      },
    );

    expect(screen.queryByRole("button")).toBeNull();
  });
});

describe("visual frames", () => {
  it("keeps a legacy visual titled and sandboxed without requiring an embedded heading", async () => {
    const handlers: PluginRpcTestHandlers<CanvasRpcContract> = {
      ...rpc(() => on),
      "board.get": () => ({
        board: {
          ...boardFor("legacy-visual"),
          nodes: [
            node("legacy", {
              kind: "html",
              title: "Legacy chart",
              html: "<p>Retained content</p>",
            }),
          ],
          edges: [],
        },
      }),
    };

    renderSlot(
      { component: CanvasPanel },
      { threadId: "legacy-visual", params: null },
      { pluginId: "canvas", composer: threadComposer("legacy-visual"), rpc: handlers },
    );

    expect(await screen.findByRole("heading", { name: "Legacy chart" })).toBeTruthy();
    const article = screen.getByRole("article", { name: "Visual: Legacy chart" });
    const frame = await within(article).findByTitle("Legacy chart");

    expect(article.getAttribute("data-kind")).toBe("html");
    expect(frame.getAttribute("sandbox")).toBe("allow-scripts");
    expect(frame.getAttribute("srcdoc")).toContain("<p>Retained content</p>");
  });

  it("resizes only from its own valid content height, including growth above 900px and shrinkage", async () => {
    const handlers: PluginRpcTestHandlers<CanvasRpcContract> = {
      ...rpc(() => on),
      "board.get": () => ({
        board: {
          ...boardFor("natural-height"),
          nodes: [
            node("natural", { kind: "html", title: "Natural height", html: "<p>Content</p>" }),
          ],
          edges: [],
        },
      }),
    };

    renderSlot(
      { component: CanvasPanel },
      { threadId: "natural-height", params: null },
      { pluginId: "canvas", composer: threadComposer("natural-height"), rpc: handlers },
    );

    const frame = await screen.findByTitle("Natural height");

    if (!(frame instanceof HTMLIFrameElement)) throw new Error("Expected an HTML frame");

    const source = frame.contentWindow;

    if (source === null) throw new Error("Expected the frame's window");

    act(() => {
      window.dispatchEvent(
        new MessageEvent("message", { source, data: { canvasFrameHeight: 1200.25 } }),
      );
    });
    expect(frame.style.height).toBe("1201px");

    act(() => {
      window.dispatchEvent(
        new MessageEvent("message", { source, data: { canvasFrameHeight: 80 } }),
      );
    });
    expect(frame.style.height).toBe("80px");

    act(() => {
      window.dispatchEvent(
        new MessageEvent("message", { source: window, data: { canvasFrameHeight: 1400 } }),
      );

      for (const canvasFrameHeight of ["1400", null, NaN, Infinity, -1, 0])
        window.dispatchEvent(new MessageEvent("message", { source, data: { canvasFrameHeight } }));

      window.dispatchEvent(new MessageEvent("message", { source, data: null }));
    });
    expect(frame.style.height).toBe("80px");
  });

  it("places shared defaults before custom CSS and preserves authored scripts", () => {
    const authored =
      '<style>.canvas-value{font-size:27px}</style><div class="canvas-metrics"><div class="canvas-value">42</div></div><script>window.customChart=true</script>';

    const source = frameDocument(authored, new Map(), "dark");
    const document = new DOMParser().parseFromString(source, "text/html");
    const styles = Array.from(document.querySelectorAll("style"));

    expect(styles).toHaveLength(2);
    expect(styles[0]?.textContent).toContain(":where(.canvas-value)");
    expect(styles[1]?.textContent).toBe(".canvas-value{font-size:27px}");
    expect(document.querySelector(".canvas-value")?.textContent).toBe("42");
    expect(document.body.innerHTML).toContain(authored);
    expect(document.scripts[0]?.textContent).toBe("window.customChart=true");
  });

  it("passes theme values without letting them break out of the style block", () => {
    const source = frameDocument(
      "<svg></svg>",
      new Map([["--brand", "red;}</style><script>x"]]),
      "dark",
    );

    expect(source).toContain("--brand:red/stylescriptx;");
    expect(source).not.toContain("</style><script>x");
  });

  it("matches the app's color scheme so a dark board gets no white frame backdrop", () => {
    expect(frameDocument("", new Map(), "dark")).toContain(":root{color-scheme:dark;");
    expect(frameDocument("", new Map(), "dark;}</style>")).toContain(":root{color-scheme:normal;");
  });
});

function EditorProbe({ threadId }: { threadId: string }) {
  const board = boardFor(threadId);

  const editor = useWorkspaceEditor(
    threadId,
    board,
    () => {},
    () => {},
    async () => {},
  );

  const goal = board.nodes.find((node) => node.id === "goal");

  if (goal === undefined) throw new Error("Missing goal module");

  return (
    <div>
      <button type="button" onClick={() => void editor.actions.pin(goal)}>
        Pin goal
      </button>
      <button type="button" onClick={() => void editor.actions.move("goal", { x: 40, y: 80 })}>
        Move goal
      </button>
      <button type="button" onClick={() => void editor.actions.hide(goal)}>
        Hide goal
      </button>
    </div>
  );
}

describe("Canvas undo in Omnyo's single history", () => {
  it("records each user action by change ID and replays exactly that change", async () => {
    const view = renderSlot(
      { component: EditorProbe },
      { threadId: "thr_undo_probe" },
      { pluginId: "canvas", rpc: rpc(() => on) },
    );

    fireEvent.click(view.getByRole("button", { name: "Pin goal" }));
    await waitFor(() =>
      expect(view.experimental_actionHistory.undoLabels).toEqual(["Unpin Thread list under 1 s"]),
    );
    fireEvent.click(view.getByRole("button", { name: "Move goal" }));
    await waitFor(() =>
      expect(view.experimental_actionHistory.undoLabels).toEqual([
        "Unpin Thread list under 1 s",
        "Move Thread list under 1 s",
      ]),
    );

    await view.experimental_actionHistory.undo();
    await view.experimental_actionHistory.undo();
    await view.experimental_actionHistory.redo();

    expect(
      view.rpcCalls
        .filter((call) => call.method === "board.undo" || call.method === "board.redo")
        .map((call) => [call.method, call.input]),
    ).toEqual([
      ["board.undo", { threadId: "thr_undo_probe", changeId: "c_move" }],
      ["board.undo", { threadId: "thr_undo_probe", changeId: "c_pin" }],
      ["board.redo", { threadId: "thr_undo_probe", changeId: "c_pin" }],
    ]);
  });

  it("records nothing when an action changed nothing", async () => {
    const view = renderSlot(
      { component: EditorProbe },
      { threadId: "thr_undo_noop" },
      { pluginId: "canvas", rpc: rpc(() => on) },
    );

    fireEvent.click(view.getByRole("button", { name: "Hide goal" }));
    await waitFor(() =>
      expect(view.rpcCalls.some((call) => call.method === "node.archive")).toBe(true),
    );
    expect(view.experimental_actionHistory.undoLabels).toEqual([]);
  });

  it("keeps one toolbar bar above the board in full screen and on compact screens", async () => {
    for (const props of [
      { compact: false, fullScreen: true },
      { compact: true, fullScreen: false },
    ]) {
      const view = renderSlot(
        { component: BoardView },
        { threadId: "thr_toolbar_flow", composer: null, ...props },
        { pluginId: "canvas", rpc: rpc(() => on) },
      );

      const toolbar = await within(view.container).findByRole("group", { name: "Canvas tools" });

      expect(toolbar.getAttribute("data-floating")).toBe("false");
      expect(toolbar.parentElement?.classList.contains("cnv-view")).toBe(true);
      expect(toolbar.closest(".cnv-body")).toBeNull();
      view.unmount();
    }
  });

  it("leaves Cmd+Z, Ctrl+Z, Cmd+Shift+Z and Ctrl+Y to Omnyo instead of claiming them", async () => {
    const view = renderSlot(
      { component: BoardView },
      { threadId: "thr_keyboard_core", composer: null, compact: false, fullScreen: false },
      { pluginId: "canvas", rpc: rpc(() => on) },
    );

    const target = await within(view.container).findByRole("button", { name: "Jump to latest" });

    for (const input of [
      { key: "z", metaKey: true },
      { key: "z", ctrlKey: true },
      { key: "Z", metaKey: true, shiftKey: true },
      { key: "y", ctrlKey: true },
    ]) {
      const event = new KeyboardEvent("keydown", { ...input, bubbles: true, cancelable: true });
      fireEvent(target, event);
      expect(event.defaultPrevented).toBe(false);
    }

    expect(
      view.rpcCalls.filter((call) => call.method === "board.undo" || call.method === "board.redo"),
    ).toHaveLength(0);
    expect(within(view.container).getByRole("button", { name: "Undo" })).toHaveProperty(
      "disabled",
      true,
    );
  });
});

describe("explicit render verification", () => {
  it("awaits fresh DOM report acknowledgement before verifying an expired unchanged board", async () => {
    const now = vi.spyOn(Date, "now").mockReturnValue(1000000);
    let release = () => {};

    const acknowledgement = new Promise<void>((resolve) => {
      release = resolve;
    });

    const started = vi.fn();
    let hold = false;
    const registry = new RenderRegistry();
    const threadId = "thr_verify_fresh";
    const board = boardFor(threadId);
    const target = board.nodes[0];

    if (!target) throw new Error("Missing fixture module");

    const verify = vi.fn(
      (input: {
        threadId?: string;
        board?: { threadId: string } | { sectionId: string };
        id: string;
      }) => registry.verify(boardAddressKey(input), target, board.revision, null),
    );

    const handlers: PluginRpcTestHandlers<CanvasRpcContract> = {
      ...rpc(() => on),
      "render.report": async (input) => {
        if (hold) {
          started();
          await acknowledgement;
        }

        return {
          accepted: registry.report(
            boardAddressKey(input),
            input.reports.map((report) => renderReportSchema.parse(report)),
            board.nodes,
          ),
        };
      },
      "node.verify": verify,
    };

    try {
      const view = renderSlot(
        { component: CanvasPanel },
        { threadId, params: null },
        { pluginId: "canvas", rpc: handlers },
      );

      fireEvent.pointerDown(await within(view.container).findByText("Thread list under 1 s"));
      fireEvent.click(within(view.container).getByRole("button", { name: "Inspect" }));
      const button = await within(view.container).findByRole("button", { name: "Verify render" });
      registry.report(
        threadId,
        [
          {
            nodeId: target.id,
            nodeRevision: target.updatedRevision,
            boardRevision: board.revision,
            sourceRevision: null,
            capturedAt: 1000000,
            mode: "board",
            zoom: 0.8,
            view: "evidence",
            bounds: { x: 0, y: 0, width: 600, height: 200 },
            text: "Old DOM",
            issues: [],
            ready: true,
          },
        ],
        board.nodes,
      );
      now.mockReturnValue(1130000);
      expect(registry.verify(threadId, target, board.revision, null).current).toBe(false);
      hold = true;
      fireEvent.click(button);
      await waitFor(() => expect(started).toHaveBeenCalled());
      expect(verify).not.toHaveBeenCalled();
      release();
      await waitFor(() => expect(verify).toHaveBeenCalledOnce());
      const result = registry.verify(threadId, target, board.revision, null);
      expect(result.current).toBe(true);
      expect(result.report).toMatchObject({
        capturedAt: 1130000,
        ready: false,
        text: expect.stringContaining("Thread list under 1 s"),
      });
      expect(result.issues.join(" ")).toContain("waiting");
    } finally {
      release();
      now.mockRestore();
    }
  });

  it("does not reuse cached verification when the selected module has no rendered DOM", async () => {
    const verify = vi.fn(() => ({ report: null, current: false, issues: [] }));

    const handlers: PluginRpcTestHandlers<CanvasRpcContract> = {
      ...rpc(() => on),
      "node.verify": verify,
    };

    const view = renderSlot(
      { component: CanvasPanel },
      { threadId: "thr_verify_missing", params: null },
      { pluginId: "canvas", rpc: handlers },
    );

    fireEvent.pointerDown(await within(view.container).findByText("Thread list under 1 s"));
    fireEvent.click(within(view.container).getByRole("button", { name: "Inspect" }));
    const button = await within(view.container).findByRole("button", { name: "Verify render" });
    const module = view.container.querySelector<HTMLElement>('[data-node-id="goal"]');

    if (module === null) throw new Error("Missing fixture module");
    module.remove();
    fireEvent.click(button);
    await within(view.container).findByText(
      "The selected module is not rendered. Open Canvas and try Verify again.",
    );
    expect(verify).not.toHaveBeenCalled();
  });
});

it("jumps from a sandboxed idea link and restores view and selection with Undo and Redo", async () => {
  const handlers: PluginRpcTestHandlers<CanvasRpcContract> = {
    ...rpc(() => on),
    "board.get": (input) => {
      const board = boardFor(boardAddressKey(input));
      board.nodes[0] = node("goal", { kind: "html", html: '<a href="#canvas-node-fix">Fix</a>' });

      return { board };
    },
  };

  const view = renderSlot(
    { component: BoardView },
    { threadId: "thr_link_jump", composer: null, compact: false, fullScreen: false },
    { pluginId: "canvas", rpc: handlers },
  );

  const frame = await waitFor(() => {
    const frame = view.container.querySelector("iframe");

    if (!frame?.contentWindow) throw new Error("Frame not ready");

    return frame;
  });

  const surface = view.container.querySelector<HTMLElement>(".cnv-board");
  const world = view.container.querySelector<HTMLElement>(".cnv-world");

  if (!surface || !world) throw new Error("Board not ready");
  Object.defineProperties(surface, { clientWidth: { value: 800 }, clientHeight: { value: 600 } });
  act(() => StubResizeObserver.observed.get(surface)?.resize(surface, 600));
  const initial = world.style.transform;
  frame.focus();
  expect(document.activeElement).toBe(frame);
  act(() =>
    window.dispatchEvent(
      new MessageEvent("message", { source: window, data: { canvasFrameNavigate: "fix" } }),
    ),
  );
  expect(view.experimental_actionHistory.undoLabels).toEqual([]);
  act(() =>
    window.dispatchEvent(
      new MessageEvent("message", {
        source: frame.contentWindow,
        data: { canvasFrameNavigate: "fix" },
      }),
    ),
  );
  const focused = world.style.transform;
  expect(document.activeElement).not.toBe(frame);
  expect(focused).not.toEqual(initial);
  expect(view.container.querySelector('[data-node-id="fix"]')?.getAttribute("data-selected")).toBe(
    "true",
  );
  await act(async () => {
    await view.experimental_actionHistory.undo();
  });
  expect(world.style.transform).toBe(initial);
  expect(view.container.querySelector('[data-node-id="fix"]')?.getAttribute("data-selected")).toBe(
    "false",
  );
  await act(async () => {
    await view.experimental_actionHistory.redo();
  });
  expect(world.style.transform).toBe(focused);
  expect(view.container.querySelector('[data-node-id="fix"]')?.getAttribute("data-selected")).toBe(
    "true",
  );
  expect(
    view.rpcCalls.filter((call) => call.method === "board.undo" || call.method === "board.redo"),
  ).toHaveLength(0);
  act(() =>
    window.dispatchEvent(
      new MessageEvent("message", {
        source: frame.contentWindow,
        data: { canvasFrameNavigate: "gone" },
      }),
    ),
  );
  expect((await view.findByRole("alert")).textContent).toContain(
    "That canvas module is no longer available",
  );
});

it("returns compact idea navigation to the outline's original scroll position", async () => {
  vi.stubGlobal("CSS", { escape: (value: string) => value });

  const view = renderSlot(
    { component: BoardView },
    { threadId: "thr_link_compact", composer: null, compact: true, fullScreen: false },
    { pluginId: "canvas", rpc: rpc(() => on) },
  );

  const outline = await waitFor(() => {
    const outline = view.container.querySelector<HTMLElement>(".cnv-outline");

    if (!outline) throw new Error("Outline not ready");

    return outline;
  });

  outline.scrollTop = 320;
  const restore = vi.fn();
  outline.scrollTo = restore;
  const destination = outline.querySelector<HTMLElement>('[data-node-id="fix"]');

  if (!destination) throw new Error("Missing destination");
  const scroll = vi.fn();
  destination.scrollIntoView = scroll;
  act(() =>
    destination.dispatchEvent(new CustomEvent("canvas-navigate", { bubbles: true, detail: "fix" })),
  );
  expect(scroll).toHaveBeenCalledOnce();
  await act(async () => {
    await view.experimental_actionHistory.undo();
  });
  expect(restore).toHaveBeenCalledWith(expect.objectContaining({ top: 320 }));
  await act(async () => {
    await view.experimental_actionHistory.redo();
  });
  expect(scroll).toHaveBeenCalledTimes(2);
  vi.unstubAllGlobals();
});

it("relays board links while leaving local, external and modified links alone", () => {
  const root = document.createElement("div");
  root.innerHTML =
    '<a id="idea" href="#canvas-node-detail">Detail</a><a id="local" href="#section">Local</a><a id="external" href="https://example.com">External</a>';
  document.body.append(root);
  const post = vi.spyOn(window, "postMessage").mockImplementation(() => {});
  const listener = vi.spyOn(window, "addEventListener");
  const html = frameDocument("", new Map(), "light");
  const script = html.slice(html.lastIndexOf("<script>") + 8, html.lastIndexOf("</script>"));
  const previousText = Object.getOwnPropertyDescriptor(document.body, "innerText");
  Object.defineProperty(document.body, "innerText", { configurable: true, value: "Content" });

  try {
    window.eval(script);
    post.mockClear();

    const click = (id: string, modified = false) => {
      const event = new MouseEvent("click", { bubbles: true, cancelable: true, ctrlKey: modified });
      root.querySelector(`#${id}`)?.dispatchEvent(event);

      return event.defaultPrevented;
    };

    expect(click("idea")).toBe(true);
    expect(post).toHaveBeenCalledWith({ canvasFrameNavigate: "detail" }, "*");
    post.mockClear();
    expect(click("local")).toBe(false);
    expect(click("external")).toBe(false);
    expect(click("idea", true)).toBe(false);
    expect(post).not.toHaveBeenCalled();
  } finally {
    for (const [event, callback] of listener.mock.calls) {
      if (callback) window.removeEventListener(event, callback);
    }

    listener.mockRestore();
    post.mockRestore();

    if (previousText) Object.defineProperty(document.body, "innerText", previousText);
    else Reflect.deleteProperty(document.body, "innerText");
    root.remove();
  }
});
