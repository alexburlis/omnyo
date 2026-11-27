import { act, cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderSlot, type PluginRpcTestHandlers } from "@omnyo/plugin-sdk/testing/app";
import { useIndex } from "../components/data";
import { realtimeChannel, type GlanceRpcContract } from "../contract";

function IndexStatus() {
  const { cards, error, refresh } = useIndex();

  return (
    <>
      <output aria-label="Cards">{cards?.length ?? "Loading"}</output>
      {error === null ? null : <p role="alert">{error}</p>}
      <button onClick={refresh}>Retry</button>
    </>
  );
}

afterEach(cleanup);

function handlers(read: PluginRpcTestHandlers<GlanceRpcContract>["cards.index"]) {
  const rpc: PluginRpcTestHandlers<GlanceRpcContract> = {
    "servers.remember": () => ({ active: [], recent: null }),
    "servers.read": () => ({ active: [], recent: null }),
    "servers.restart": () => ({ active: [], recent: null }),
    "cards.index": read,
    "card.read": () => ({ view: null }),
    "card.get": () => ({ view: null, conversationSeq: 0 }),
    "card.diff": () => ({
      seenRevision: null,
      revision: null,
      conversationSeq: 0,
      changes: [],
      newReplies: 0,
      moreActivity: false,
    }),
    "card.markSeen": () => ({ ok: true }),
  };

  return rpc;
}

describe("Glance refresh failure capture", () => {
  it.each([
    { name: "Error", status: 503, stage: "http", code: "handler_error" },
    { name: "TypeError", status: null, stage: "transport", code: null },
    { name: "SyntaxError", status: 200, stage: "response", code: null },
  ])(
    "retains actual $stage failure metadata until the next successful refresh",
    async (metadata) => {
      const failure = Object.assign(
        new Error("private fixture text must never leave memory"),
        metadata,
      );

      const read = vi
        .fn()
        .mockRejectedValueOnce(failure)
        .mockRejectedValueOnce(failure)
        .mockResolvedValue({ cards: [] });

      const slot = renderSlot({ component: IndexStatus }, {}, { rpc: handlers(read) });
      await screen.findByRole("alert");
      expect(read.mock.calls[0]?.[0]).toBeNull();
      fireEvent.click(screen.getByRole("button", { name: "Retry" }));
      await waitFor(() => expect(read).toHaveBeenCalledTimes(2));
      const diagnostic = read.mock.calls[1]?.[0]?.diagnostic;
      expect(diagnostic).toMatchObject({
        name: metadata.name,
        status: metadata.status,
        stage: metadata.stage,
        code: metadata.code,
        online: true,
        visibility: "visible",
        clientBundle: null,
        pluginBundle: null,
      });
      expect(diagnostic.id).toMatch(/^[a-f0-9-]{36}$/u);
      expect(diagnostic.occurredAt).toBeGreaterThan(0);
      expect(diagnostic.elapsedMs).toBeGreaterThanOrEqual(0);
      expect(JSON.stringify(diagnostic)).not.toContain(failure.message);
      expect(diagnostic).not.toHaveProperty("stack");
      await act(async () => {});
      await slot.behavior.emitRealtime(realtimeChannel, { threadId: "thread-1", revision: 1 });
      await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
      expect(read.mock.calls[2]?.[0]).toEqual({ diagnostic });
      fireEvent.click(screen.getByRole("button", { name: "Retry" }));
      await waitFor(() => expect(read).toHaveBeenCalledTimes(4));
      expect(read.mock.calls[3]?.[0]).toBeNull();
    },
  );

  it("keeps arbitrary error fields and text out of diagnostics", async () => {
    const failure = Object.assign(new Error("private fixture detail"), {
      name: "private-name",
      code: "private-code",
      status: "503",
      stage: "private-stage",
      payload: "private-payload",
    });

    const read = vi.fn().mockRejectedValueOnce(failure).mockResolvedValue({ cards: [] });
    renderSlot({ component: IndexStatus }, {}, { rpc: handlers(read) });
    await screen.findByRole("alert");
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(read).toHaveBeenCalledTimes(2));
    expect(read.mock.calls[1]?.[0]?.diagnostic).toMatchObject({
      name: "Other",
      code: "unknown",
      status: null,
      stage: "unknown",
    });
    expect(JSON.stringify(read.mock.calls[1]?.[0])).not.toContain("private-");
  });
});

describe("Glance network recovery", () => {
  it("revalidates on network restoration without a realtime reconnect and preserves the error until success", async () => {
    let recover!: (value: { cards: [] }) => void;

    const recovered = new Promise<{ cards: [] }>((resolve) => {
      recover = resolve;
    });

    const failure = Object.assign(new TypeError("Failed to fetch"), {
      status: null,
      stage: "transport",
    });

    const read = vi.fn().mockRejectedValueOnce(failure).mockReturnValueOnce(recovered);
    const slot = renderSlot({ component: IndexStatus }, {}, { rpc: handlers(read) });
    await screen.findByRole("alert");
    fireEvent(window, new Event("online"));
    await waitFor(() => expect(read).toHaveBeenCalledTimes(2));
    expect(screen.getByRole("alert").textContent).toContain("Glance could not refresh");
    expect(read.mock.calls[1]?.[0]?.diagnostic).toMatchObject({
      status: null,
      stage: "transport",
      name: "TypeError",
    });
    await act(async () => recover({ cards: [] }));
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByLabelText("Cards").textContent).toBe("0");
    slot.unmount();
    fireEvent(window, new Event("online"));
    expect(read).toHaveBeenCalledTimes(2);
  });

  it("starts the restored-network read even when the offline rejection has not settled", async () => {
    let rejectOffline!: (error: Error) => void;

    const offline = new Promise<never>((_resolve, reject) => {
      rejectOffline = reject;
    });

    const read = vi.fn().mockReturnValueOnce(offline).mockResolvedValue({ cards: [] });
    renderSlot({ component: IndexStatus }, {}, { rpc: handlers(read) });
    await waitFor(() => expect(read).toHaveBeenCalledTimes(1));
    fireEvent(window, new Event("online"));
    await waitFor(() => expect(read).toHaveBeenCalledTimes(2));
    await act(async () => rejectOffline(new TypeError("Failed to fetch")));
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByLabelText("Cards").textContent).toBe("0");
  });
});
