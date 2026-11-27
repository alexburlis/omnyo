import { act, cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import type { ReactElement } from "react";
import { renderSlot } from "@omnyo/plugin-sdk/testing/app";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Connections } from "../components/connections";
import { EditorWorkbench, type EditorActions } from "../components/editor";
import type { Board, CanvasHistory, CanvasNode, NodeInspection } from "../contract";
import { changeFlow, draftFor, mergeDraft } from "../lib/editor";
import { sourceStateSchema } from "../source-contract";

function renderWorkbench(ui: ReactElement<Parameters<typeof EditorWorkbench>[0]>) {
  return renderSlot({ component: EditorWorkbench }, ui.props, {
    pluginId: "canvas-editor-test",
    rpc: { "board.link": () => ({ revision: 8, changeId: "8" }) },
  });
}

function node(overrides: Partial<CanvasNode> = {}): CanvasNode {
  return {
    id: "chart",
    kind: "html",
    order: 1,
    section: "Discovery",
    title: "Reach",
    body: "Original note",
    tone: "neutral",
    pinned: false,
    wide: false,
    href: null,
    language: null,
    html: "<p>4,899 clicks</p>",
    options: [],
    recommended: null,
    progress: null,
    state: null,
    assetId: null,
    position: null,
    createdRevision: 1,
    updatedRevision: 7,
    updatedAt: 1000,
    width: 720,
    ...overrides,
  };
}

function inspection(
  value = node(),
  versions: Record<string, number> = { title: 3, body: 2, width: 4 },
): NodeInspection {
  return { node: value, boardRevision: value.updatedRevision, fieldVersions: versions };
}

function board(value = node()): Board {
  return {
    threadId: "board",
    revision: value.updatedRevision,
    seenRevision: value.updatedRevision,
    sections: ["Discovery"],
    nodes: [value],
    edges: [],
    composition: null,
  };
}

function fixture() {
  const inspect = vi.fn<EditorActions["inspect"]>().mockResolvedValue(inspection());
  const edit = vi.fn<EditorActions["edit"]>().mockResolvedValue(undefined);
  const undo = vi.fn<EditorActions["undo"]>().mockResolvedValue(undefined);
  const redo = vi.fn<EditorActions["redo"]>().mockResolvedValue(undefined);

  const verify = vi.fn<EditorActions["verify"]>().mockResolvedValue({
    report: null,
    current: false,
    issues: ["No connected render has reported this module."],
  });

  const readHistory = vi.fn<EditorActions["readHistory"]>();

  const actions: EditorActions = {
    readHistory,
    loadHistory: async () => {},
    refreshHistory: async () => {},
    inspect,
    edit,
    undo,
    redo,
    verify,
    duplicate: async () => {},
    compose: async () => {},
    move: async () => {},
    reference: () => {},
    pin: async () => {},
    hide: async () => {},
    resetPosition: async () => {},
    saveSource: async () => {},
    refreshSource: async () => {},
    pauseSource: async () => {},
    pushDataset: async () => {},
    addModule: async () => {},
  };

  const props = {
    threadId: "board",
    mode: "inspect",
    onMode: () => {},
    onClose: () => {},
    board: board(),
    selectedNode: node(),
    sources: [],
    history: { entries: [], canUndo: false, canRedo: false, total: 0 },
    busy: false,
    actions,
  } satisfies Parameters<typeof EditorWorkbench>[0];

  return { props, inspect, edit, undo, redo, verify, readHistory };
}

afterEach(cleanup);

describe("Canvas editor workbench", () => {
  it("applies only changed fields with the exact inspected writer versions", async () => {
    const { props, inspect, edit } = fixture();
    inspect.mockResolvedValueOnce(inspection()).mockResolvedValueOnce(
      inspection(node({ title: "Discovery", width: null, updatedRevision: 8 }), {
        title: 8,
        body: 2,
        width: 8,
      }),
    );
    renderWorkbench(<EditorWorkbench {...props} />);
    const title = await screen.findByRole("textbox", { name: "Title" });
    fireEvent.change(title, { target: { value: "Discovery" } });
    fireEvent.change(screen.getByRole("spinbutton", { name: "Width" }), { target: { value: "" } });
    fireEvent.click(screen.getByRole("button", { name: "Apply change" }));
    await waitFor(() => expect(edit).toHaveBeenCalledOnce());
    expect(edit).toHaveBeenCalledWith({
      id: "chart",
      fields: { title: "Discovery", width: null },
      expectedVersions: { title: 3, width: 4 },
      label: "Edit Reach",
    });
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Apply change" }).hasAttribute("disabled")).toBe(
        true,
      ),
    );
  });

  it("preserves a conflict draft and merges latest untouched fields only after explicit review", async () => {
    const { props, inspect, edit } = fixture();

    const latest = node({
      title: "Other writer",
      width: 900,
      body: "Updated note",
      updatedRevision: 9,
    });

    inspect
      .mockResolvedValueOnce(inspection())
      .mockResolvedValueOnce(inspection(latest, { title: 9, body: 9, width: 9 }))
      .mockResolvedValue(
        inspection(node({ ...latest, title: "My draft", updatedRevision: 10 }), {
          title: 10,
          body: 9,
          width: 9,
        }),
      );
    edit
      .mockRejectedValueOnce(new Error("Edit conflict: title changed"))
      .mockResolvedValue(undefined);
    const { rerender } = renderWorkbench(<EditorWorkbench {...props} />);
    const title = await screen.findByRole("textbox", { name: "Title" });
    fireEvent.change(title, { target: { value: "My draft" } });
    fireEvent.click(screen.getByRole("button", { name: "Apply change" }));
    await screen.findByText("Edit conflict: title changed");
    expect(screen.getByRole<HTMLInputElement>("textbox", { name: "Title" }).value).toBe("My draft");
    rerender(<EditorWorkbench {...props} board={board(latest)} selectedNode={latest} />);
    expect(screen.getByRole<HTMLInputElement>("textbox", { name: "Title" }).value).toBe("My draft");
    expect(screen.getByRole<HTMLInputElement>("spinbutton", { name: "Width" }).value).toBe("720");
    fireEvent.click(screen.getByRole("button", { name: "Review latest" }));
    await screen.findByLabelText("Current values and your draft");
    expect(screen.getByRole<HTMLInputElement>("textbox", { name: "Title" }).value).toBe("My draft");
    expect(screen.getByRole<HTMLInputElement>("spinbutton", { name: "Width" }).value).toBe("900");
    expect(screen.getByRole<HTMLTextAreaElement>("textbox", { name: "Notes" }).value).toBe(
      "Updated note",
    );
    expect(
      within(screen.getByLabelText("Current values and your draft")).getByText("Other writer", {
        exact: true,
      }),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Apply change" }));
    await waitFor(() => expect(edit).toHaveBeenCalledTimes(2));
    expect(edit.mock.calls[1]?.[0]).toMatchObject({
      fields: { title: "My draft" },
      expectedVersions: { title: 9 },
    });
  });

  it("synchronizes a clean editor after a saved change is externally undone", async () => {
    const { props, inspect, edit } = fixture();
    const saved = node({ title: "Saved title", updatedRevision: 8 });
    const undone = node({ title: "Reach", updatedRevision: 9 });
    inspect
      .mockResolvedValueOnce(inspection())
      .mockResolvedValueOnce(inspection(saved, { title: 8 }))
      .mockResolvedValue(inspection(undone, { title: 3 }));
    const { rerender } = renderWorkbench(<EditorWorkbench {...props} />);
    fireEvent.change(await screen.findByRole("textbox", { name: "Title" }), {
      target: { value: "Saved title" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Apply change" }));
    await waitFor(() => expect(edit).toHaveBeenCalledOnce());
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Apply change" }).hasAttribute("disabled")).toBe(
        true,
      ),
    );
    expect(screen.getByRole<HTMLInputElement>("textbox", { name: "Title" }).value).toBe(
      "Saved title",
    );
    rerender(<EditorWorkbench {...props} board={board(undone)} selectedNode={undone} />);
    await waitFor(() =>
      expect(screen.getByRole<HTMLInputElement>("textbox", { name: "Title" }).value).toBe("Reach"),
    );
    expect(inspect).toHaveBeenCalledTimes(3);
  });

  it("invalidates cached verification when board geometry changes", async () => {
    const { props, verify, inspect } = fixture();
    verify.mockResolvedValue({
      current: true,
      issues: [],
      report: {
        nodeId: "chart",
        nodeRevision: 7,
        sourceRevision: null,
        boardRevision: 7,
        capturedAt: 1000,
        mode: "board",
        zoom: 0.8,
        view: "evidence",
        bounds: { x: 0, y: 0, width: 720, height: 400 },
        text: "Current evidence",
        issues: [],
        ready: true,
      },
    });
    const { rerender } = renderWorkbench(<EditorWorkbench {...props} />);
    await screen.findByRole("textbox", { name: "Title" });
    fireEvent.click(screen.getByRole("button", { name: "Verify render" }));
    await screen.findByText("Current render");
    rerender(<EditorWorkbench {...props} board={{ ...props.board, revision: 8 }} />);
    expect(screen.queryByText("Current render")).toBeNull();
    expect(inspect).toHaveBeenCalledOnce();
  });

  it.each(["dataset", "status"])(
    "invalidates cached verification when a bound source %s changes",
    async (change) => {
      const { props, verify, inspect } = fixture();
      const selected = node({ binding: { sourceId: "stats", view: "metric" } });

      const source = sourceStateSchema.parse({
        source: {
          definition: { id: "stats", title: "Stats", provider: "manual" },
          status: "ready",
          error: null,
          lastAttemptAt: null,
          lastSuccessAt: 1000,
          nextRefreshAt: null,
          failures: 0,
        },
        dataset: {
          sourceId: "stats",
          columns: [{ key: "value", label: "Value", type: "number" }],
          rows: [{ value: 20 }],
          revision: 1,
          capturedAt: 1000,
          provenance: {},
        },
      });

      inspect.mockResolvedValue(inspection(selected));
      verify.mockResolvedValue({
        current: true,
        issues: [],
        report: {
          nodeId: "chart",
          nodeRevision: 7,
          sourceRevision: 1,
          boardRevision: 7,
          capturedAt: 1000,
          mode: "board",
          zoom: 0.8,
          view: "evidence",
          bounds: { x: 0, y: 0, width: 720, height: 400 },
          text: "Current evidence",
          issues: [],
          ready: true,
        },
      });

      const { rerender } = renderWorkbench(
        <EditorWorkbench
          {...props}
          selectedNode={selected}
          board={board(selected)}
          sources={[source]}
        />,
      );

      await screen.findByRole("textbox", { name: "Title" });
      fireEvent.click(screen.getByRole("button", { name: "Verify render" }));
      await screen.findByText("Current render");

      const changed = sourceStateSchema.parse(
        change === "dataset"
          ? { ...source, dataset: { ...source.dataset, revision: 2 } }
          : { ...source, source: { ...source.source, status: "error", error: "Refresh failed" } },
      );

      rerender(
        <EditorWorkbench
          {...props}
          selectedNode={selected}
          board={board(selected)}
          sources={[changed]}
        />,
      );
      expect(screen.queryByText("Current render")).toBeNull();
      expect(inspect).toHaveBeenCalledOnce();
    },
  );

  it("ignores an older inspection response after a newer clean revision loads", async () => {
    const { props, inspect } = fixture();
    const resolves: Array<(value: NodeInspection) => void> = [];

    const pending = new Promise<NodeInspection>((resolve) => {
      resolves.push(resolve);
    });

    const older = node({ title: "Older response", updatedRevision: 8 });
    const latest = node({ title: "Newest response", updatedRevision: 9 });
    inspect
      .mockResolvedValueOnce(inspection())
      .mockReturnValueOnce(pending)
      .mockResolvedValue(inspection(latest));
    const { rerender } = renderWorkbench(<EditorWorkbench {...props} />);
    await screen.findByRole("textbox", { name: "Title" });
    rerender(<EditorWorkbench {...props} selectedNode={older} board={board(older)} />);
    await waitFor(() => expect(inspect).toHaveBeenCalledTimes(2));
    rerender(<EditorWorkbench {...props} selectedNode={latest} board={board(latest)} />);
    await waitFor(() =>
      expect(screen.getByRole<HTMLInputElement>("textbox", { name: "Title" }).value).toBe(
        "Newest response",
      ),
    );
    const resolve = resolves[0];

    if (!resolve) throw new Error("Missing controlled response");
    await act(async () => resolve(inspection(older)));
    expect(screen.getByRole<HTMLInputElement>("textbox", { name: "Title" }).value).toBe(
      "Newest response",
    );
  });

  it("shows attributed before and after values and undoes the selected change", async () => {
    const { props, undo, readHistory } = fixture();

    const history: CanvasHistory = {
      canUndo: true,
      canRedo: false,
      entries: [
        {
          id: "8",
          revision: 8,
          actor: "human",
          label: "Rename discovery",
          createdAt: 1000,
          state: "applied",
          fields: [
            { target: "node:chart", field: "title", before: "Old heading", after: "New heading" },
          ],
          lastAction: "edit",
          lastActor: "human",
          lastActivityAt: 1000,
        },
      ],
    };

    const entry = history.entries[0];

    if (!entry) throw new Error("Missing fixture history");
    readHistory.mockResolvedValue(entry);
    const { fields, ...metadata } = entry;

    const summary = {
      ...history,
      total: 1,
      entries: [{ ...metadata, fieldCount: fields.length, targets: ["node:chart"] }],
    };

    renderWorkbench(<EditorWorkbench {...props} mode="changes" history={summary} />);
    expect(await screen.findByText("Old heading")).toBeTruthy();
    expect(screen.getByText("New heading")).toBeTruthy();
    expect(screen.getByText(/You · Edited/u)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Undo this change" }));
    await waitFor(() => expect(undo).toHaveBeenCalledWith("8"));
  });

  it("shows a failed history load with Retry instead of loading forever", () => {
    const { props } = fixture();
    const refreshHistory = vi.fn(async () => {});
    renderWorkbench(
      <EditorWorkbench
        {...props}
        mode="changes"
        history={null}
        historyError="History could not load"
        actions={{ ...props.actions, refreshHistory }}
      />,
    );
    expect(screen.getByRole("alert").textContent).toContain("History could not load");
    expect(screen.queryByText("Loading changes…")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(refreshHistory).toHaveBeenCalledOnce();
  });

  it("never represents an absent render report as a passing verification", async () => {
    const { props, verify } = fixture();
    renderWorkbench(<EditorWorkbench {...props} />);
    await screen.findByRole("textbox", { name: "Title" });
    fireEvent.click(screen.getByRole("button", { name: "Verify render" }));
    await screen.findByText("Not reported");
    expect(verify).toHaveBeenCalledWith("chart");
    expect(screen.getByText("No connected render has reported this module.")).toBeTruthy();
    expect(screen.queryByText("Current render")).toBeNull();
  });

  it("retains a draft while switching workbench modes", async () => {
    const { props } = fixture();
    const { rerender } = renderWorkbench(<EditorWorkbench {...props} />);
    fireEvent.change(await screen.findByRole("textbox", { name: "Title" }), {
      target: { value: "Kept draft" },
    });
    rerender(<EditorWorkbench {...props} mode="changes" />);
    rerender(<EditorWorkbench {...props} />);
    expect(screen.getByRole<HTMLInputElement>("textbox", { name: "Title" }).value).toBe(
      "Kept draft",
    );
  });

  it("preserves unrelated node changes and edits flow structure immutably", () => {
    const original = node();
    const draft = { ...draftFor(original), title: "My title" };
    const latest = node({ title: "External", body: "Fresh note", width: 900 });
    expect(mergeDraft(original, draft, latest)).toMatchObject({
      title: "My title",
      body: "Fresh note",
      width: "900",
    });

    const composition = {
      width: 1000,
      root: { flow: "row", children: [{ node: "chart" }, { node: "second" }] },
    } satisfies NonNullable<Board["composition"]>;

    const changed = changeFlow(composition, "chart", { flow: "column", gap: 32, weight: 2 }, 1);
    expect(composition.root.children).toEqual([{ node: "chart" }, { node: "second" }]);
    expect(changed.root).toMatchObject({
      flow: "column",
      gap: 32,
      children: [{ node: "second" }, { node: "chart", weight: 2 }],
    });
  });
});

it("saves unlabeled connections through the real JSON RPC boundary", async () => {
  const current = board();
  current.nodes.push(node({ id: "comparison", title: "Comparison" }));

  const view = renderSlot(
    { component: Connections },
    { board: current, id: "chart" },
    {
      pluginId: "canvas-connections-test",
      rpc: { "board.link": () => ({ revision: 8, changeId: "8" }) },
    },
  );

  fireEvent.change(screen.getByRole("combobox", { name: "Connect to" }), {
    target: { value: "comparison" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Add connection" }));
  await waitFor(() => expect(view.rpcCalls.length).toBe(1));
  expect(view.rpcCalls[0]).toMatchObject({
    method: "board.link",
    input: {
      threadId: "board",
      from: "chart",
      to: "comparison",
      expectedRevision: 7,
      remove: false,
    },
  });
  expect(screen.queryByRole("alert")).toBeNull();
});
