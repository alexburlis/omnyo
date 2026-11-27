import { act, cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { z } from "zod";
import { renderSlot } from "@omnyo/plugin-sdk/testing/app";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Board, HistorySummary } from "../contract";
import { useWorkspaceEditor } from "../components/workspace-data";

const ignore = () => {};

const report = async () => {};

function summary(label: string): HistorySummary {
  return {
    entries: [
      {
        id: "1",
        revision: 1,
        actor: "human",
        label,
        createdAt: 1,
        state: "applied",
        lastAction: "edit",
        lastActor: "human",
        lastActivityAt: 1,
        fieldCount: 1,
        targets: ["node:chart"],
      },
    ],
    canUndo: true,
    canRedo: false,
    total: 1,
  };
}

function Probe() {
  const [threadId, setThreadId] = useState("first");
  const [mode, setMode] = useState<"sources" | null>(null);

  const board: Board = {
    threadId,
    revision: 1,
    seenRevision: 1,
    nodes: [],
    sections: [],
    edges: [],
  };

  const editor = useWorkspaceEditor(threadId, board, ignore, ignore, report, mode);

  return (
    <div>
      <span>{editor.history?.entries[0]?.label ?? "Loading history"}</span>
      <button onClick={() => setMode("sources")}>Discover sources</button>
      <button onClick={() => setThreadId("second")}>Switch thread</button>
      {editor.error ? <p role="alert">{editor.error}</p> : null}
    </div>
  );
}

afterEach(cleanup);

describe("history and source loading", () => {
  it("loads history metadata without full diffs and discovers unbound sources only on request", async () => {
    const full = vi.fn(() => ({ entries: [], canUndo: false, canRedo: false }));
    const sources = vi.fn(() => ({ sources: [] }));
    renderSlot(
      { component: Probe },
      {},
      {
        pluginId: "canvas",
        rpc: {
          "board.history": full,
          "board.historySummary": () => summary("Latest summary"),
          "source.list": sources,
        },
      },
    );
    await screen.findByText("Latest summary");
    expect(full).not.toHaveBeenCalled();
    expect(sources).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Discover sources" }));
    await waitFor(() => expect(sources).toHaveBeenCalledOnce());
  });

  it("ignores the previous thread's late history response", async () => {
    let finish: ((value: HistorySummary) => void) | undefined;

    const first = new Promise<HistorySummary>((resolve) => {
      finish = resolve;
    });

    const history = vi.fn(({ threadId }: { threadId: string }) =>
      threadId === "first" ? first : Promise.resolve(summary("Second thread")),
    );

    renderSlot(
      { component: Probe },
      {},
      {
        pluginId: "canvas",
        rpc: {
          "board.historySummary": (input) =>
            history(z.object({ threadId: z.string() }).parse(input)),
        },
      },
    );
    await waitFor(() => expect(history).toHaveBeenCalledOnce());
    fireEvent.click(screen.getByRole("button", { name: "Switch thread" }));
    await screen.findByText("Second thread");
    await act(async () => {
      finish?.(summary("Stale first thread"));
    });
    expect(screen.queryByText("Stale first thread")).toBeNull();
    expect(screen.getByText("Second thread")).toBeTruthy();
  });
});
