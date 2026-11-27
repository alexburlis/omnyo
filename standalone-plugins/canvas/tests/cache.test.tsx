import { act, cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { renderSlot } from "@omnyo/plugin-sdk/testing/app";
import { realtimeChannel, type Board, type CanvasMode } from "../contract";
import { useBoard, useCanvasMode } from "../components/thread-data";
import { ModelCache } from "../components/model-cache";

const on: CanvasMode = { canvas: true, unseen: false, startedBy: "user", movedTo: null };

const off: CanvasMode = { canvas: false, unseen: false, startedBy: null, movedTo: null };

afterEach(cleanup);

function board(threadId: string, revision = 1): Board {
  return { threadId, revision, seenRevision: revision, sections: [], nodes: [], edges: [] };
}

function pending<Value>() {
  let resolve: (value: Value) => void = () => {};

  const promise = new Promise<Value>((complete) => {
    resolve = complete;
  });

  return { promise, resolve };
}

function BoardReader({ threadId }: { threadId: string }) {
  const { board, error, refresh } = useBoard(threadId);

  return (
    <>
      <p>{board === null ? "Loading board" : `Revision ${board.revision}`}</p>
      {board?.sections.map((section) => (
        <p key={section}>{section}</p>
      ))}
      {error === null ? null : <p role="alert">{error}</p>}
      <button onClick={refresh}>Refresh</button>
    </>
  );
}

function TwoModes({ threadId }: { threadId: string }) {
  const first = useCanvasMode(threadId);
  const second = useCanvasMode(threadId);

  return <p>{first.mode?.canvas && second.mode?.canvas ? "Canvas on" : "Loading mode"}</p>;
}

it("shows the previous board immediately while a reopened panel revalidates", async () => {
  const threadId = "cache-reopen";

  const first = renderSlot(
    { component: BoardReader },
    { threadId },
    {
      pluginId: "canvas",
      rpc: { "board.get": () => ({ board: board(threadId) }) },
    },
  );

  await screen.findByText("Revision 1");
  first.unmount();
  const refreshed = pending<{ board: Board }>();
  renderSlot(
    { component: BoardReader },
    { threadId },
    {
      pluginId: "canvas",
      rpc: { "board.get": () => refreshed.promise },
    },
  );
  expect(screen.getByText("Revision 1")).toBeTruthy();
  await act(async () => refreshed.resolve({ board: board(threadId, 2) }));
  expect(await screen.findByText("Revision 2")).toBeTruthy();
});

it("shares one mode request between the header and panel", async () => {
  let reads = 0;
  const response = pending<CanvasMode>();
  renderSlot(
    { component: TwoModes },
    { threadId: "cache-mode-shared" },
    {
      pluginId: "canvas",
      rpc: {
        "mode.get": () => {
          reads += 1;

          return response.promise;
        },
      },
    },
  );
  await waitFor(() => expect(reads).toBe(1));
  await act(async () => response.resolve(on));
  expect(await screen.findByText("Canvas on")).toBeTruthy();
});

it("discards a response invalidated while pending and fetches the current revision", async () => {
  const threadId = "cache-revision-race";
  const first = pending<{ board: Board }>();
  let reads = 0;

  const view = renderSlot(
    { component: BoardReader },
    { threadId },
    {
      pluginId: "canvas",
      rpc: { "board.get": () => (++reads === 1 ? first.promise : { board: board(threadId, 2) }) },
    },
  );

  await waitFor(() => expect(reads).toBe(1));
  await view.emitRealtime(realtimeChannel, { threadId, revision: 2 });
  await act(async () => first.resolve({ board: board(threadId, 1) }));
  expect(await screen.findByText("Revision 2")).toBeTruthy();
  expect(reads).toBe(2);
});

it("refreshes a chat board whose linked section has the same revision", async () => {
  const threadId = "cache-linked-section";
  let current = { ...board(threadId), sections: ["Original board"] };

  const view = renderSlot(
    { component: BoardReader },
    { threadId },
    {
      pluginId: "canvas",
      rpc: { "board.get": () => ({ board: current }) },
    },
  );

  await screen.findByText("Original board");
  current = { ...board("sec_linked"), sections: ["Project section"] };
  await view.emitRealtime(realtimeChannel, { threadId, revision: current.revision });
  expect(await screen.findByText("Project section")).toBeTruthy();
});

it("keeps the visible board and reports a failed refresh", async () => {
  const threadId = "cache-refresh-error";
  let reads = 0;
  renderSlot(
    { component: BoardReader },
    { threadId },
    {
      pluginId: "canvas",
      rpc: {
        "board.get": () => {
          if (++reads > 1) throw new Error("unavailable");

          return { board: board(threadId) };
        },
      },
    },
  );
  await screen.findByText("Revision 1");
  fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
  expect(await screen.findByRole("alert")).toBeTruthy();
  expect(screen.getByText("Revision 1")).toBeTruthy();
});

it("refreshes after a realtime reconnect without clearing visible content", async () => {
  const threadId = "cache-reconnect";
  let revision = 1;

  const view = renderSlot(
    { component: BoardReader },
    { threadId },
    {
      pluginId: "canvas",
      rpc: { "board.get": () => ({ board: board(threadId, revision) }) },
    },
  );

  await screen.findByText("Revision 1");
  await view.setRealtimeConnectionState("reconnecting");
  revision = 2;
  await view.setRealtimeConnectionState("connected");
  expect(await screen.findByText("Revision 2")).toBeTruthy();
});

it("does not resurrect a disabled board from a pending response", async () => {
  const threadId = "cache-mode-off";

  function Reader() {
    const { mode } = useCanvasMode(threadId);

    return mode?.canvas ? <BoardReader threadId={threadId} /> : <p>Canvas off</p>;
  }

  let mode = on;
  const response = pending<{ board: Board }>();

  const view = renderSlot(
    { component: Reader },
    {},
    {
      pluginId: "canvas",
      rpc: { "mode.get": () => mode, "board.get": () => response.promise },
    },
  );

  await screen.findByText("Loading board");
  mode = off;
  await view.emitRealtime(realtimeChannel, { threadId, revision: 2 });
  await screen.findByText("Canvas off");
  await act(async () => response.resolve({ board: board(threadId) }));
  view.unmount();
  const stale = pending<{ board: Board | null }>();
  renderSlot(
    { component: BoardReader },
    { threadId },
    {
      pluginId: "canvas",
      rpc: { "board.get": () => stale.promise },
    },
  );
  expect(screen.queryByText("Revision 1")).toBeNull();
  await act(async () => stale.resolve({ board: null }));
});

it("evicts boards from older closed panels instead of retaining every visited chat", async () => {
  for (let index = 0; index < 25; index += 1) {
    const threadId = `cache-budget-${index}`;

    const view = renderSlot(
      { component: BoardReader },
      { threadId },
      {
        pluginId: "canvas",
        rpc: { "board.get": () => ({ board: board(threadId) }) },
      },
    );

    await screen.findByText("Revision 1");
    view.unmount();
  }

  const response = pending<{ board: Board }>();
  renderSlot(
    { component: BoardReader },
    { threadId: "cache-budget-0" },
    {
      pluginId: "canvas",
      rpc: { "board.get": () => response.promise },
    },
  );
  expect(screen.queryByText("Revision 1")).toBeNull();
  await act(async () => response.resolve({ board: board("cache-budget-0") }));
  await waitFor(() => expect(screen.getByText("Revision 1")).toBeTruthy());
});

it("does not drop a revision signal queued while a successful read is finalizing", async () => {
  const cache = new ModelCache<number>("Refresh failed");
  let reads = 0;
  const read = async () => ++reads;

  const unsubscribe = cache.subscribe("completion-gap", () => {
    if (cache.read("completion-gap").value === 1)
      queueMicrotask(() => cache.load("completion-gap", read, true));
  });

  cache.load("completion-gap", read);
  await waitFor(() => expect(cache.read("completion-gap").value).toBe(2));
  unsubscribe();
  expect(reads).toBe(2);
});
