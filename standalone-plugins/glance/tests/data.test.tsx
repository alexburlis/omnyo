import { act, cleanup, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderSlot, type PluginRpcTestHandlers } from "@omnyo/plugin-sdk/testing/app";
import {
  cardSchema,
  realtimeChannel,
  type CardDiff,
  type CardView,
  type GlanceRpcContract,
} from "../contract";
import type { ExperimentalThreadBootstrapData } from "@omnyo/plugin-sdk/app";
import { GlanceCard } from "../components/card";
import { useCard, useIndex } from "../components/data";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;

  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });

  return { promise, resolve, reject };
}

function card(revision: number) {
  return {
    threadId: "thread-1",
    revision,
    updatedAt: revision,
    source: "cli" as const,
    staleSince: null,
    card: cardSchema.parse({ status: "done", phase: "done", headline: `Outcome ${revision}` }),
    proofs: [],
  };
}

function diff(revision: number): CardDiff {
  return {
    seenRevision: null,
    revision,
    conversationSeq: revision,
    changes: [],
    newReplies: 0,
    moreActivity: false,
  };
}

function CurrentCard({ threadId }: { threadId: string }) {
  const result = useCard(threadId);

  return (
    <>
      <output aria-label="Card">{result.view?.card.headline ?? "None"}</output>
      <output aria-label="Changes">{result.diff?.revision ?? "None"}</output>
      <output aria-label="Failure">{result.error ?? "None"}</output>
      <output aria-label="Current">{String(result.current)}</output>
    </>
  );
}

beforeEach(() => {
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: false,
    media: query,
    addEventListener() {},
    removeEventListener() {},
  }));
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("Glance current card reads", () => {
  it("shares the early route read with a composer mounted while that read is pending", async () => {
    const pending = deferred<{ view: ReturnType<typeof card>; conversationSeq: number }>();
    const get = vi.fn(() => pending.promise);

    const rpc: PluginRpcTestHandlers<GlanceRpcContract> = {
      "servers.remember": () => ({ active: [], recent: null }),
      "servers.read": () => ({ active: [], recent: null }),
      "servers.restart": () => ({ active: [], recent: null }),
      "card.get": () => {
        throw new Error("The card display must not wait for a captured cursor");
      },
      "card.read": get,
      "card.diff": () => diff(9),
      "card.markSeen": () => ({ ok: true }),
      "cards.index": () => ({ cards: [] }),
    };

    renderSlot({ component: CurrentCard }, { threadId: "early-route" }, { rpc });
    renderSlot({ component: CurrentCard }, { threadId: "early-route" }, { rpc });

    try {
      expect(get).toHaveBeenCalledTimes(1);
    } finally {
      await act(async () => pending.resolve({ view: card(9), conversationSeq: 9 }));
    }
  });

  it("shows the current card before optional diff finishes and exposes a diff failure", async () => {
    const changes = deferred<CardDiff>();

    const rpc: PluginRpcTestHandlers<GlanceRpcContract> = {
      "servers.remember": () => ({ active: [], recent: null }),
      "servers.read": () => ({ active: [], recent: null }),
      "servers.restart": () => ({ active: [], recent: null }),
      "card.get": () => {
        throw new Error("The card display must not wait for a captured cursor");
      },
      "card.read": () => ({ view: card(1), conversationSeq: 1 }),
      "card.diff": () => changes.promise,
      "card.markSeen": () => ({ ok: true }),
      "cards.index": () => ({ cards: [] }),
    };

    renderSlot({ component: CurrentCard }, { threadId: "thread-1" }, { rpc });

    try {
      await waitFor(() => expect(screen.getByLabelText("Card").textContent).toBe("Outcome 1"));
      expect(screen.getByLabelText("Changes").textContent).toBe("None");
    } finally {
      await act(async () => changes.reject(new Error("Diff unavailable")));
    }

    expect(screen.getByLabelText("Card").textContent).toBe("Outcome 1");
    await waitFor(() => expect(screen.getByLabelText("Failure").textContent).not.toBe("None"));
  });

  it("keeps a revisited card visible while its fresh read is pending and reports failure", async () => {
    const fresh = deferred<{ view: ReturnType<typeof card>; conversationSeq: number }>();
    let reads = 0;

    const rpc: PluginRpcTestHandlers<GlanceRpcContract> = {
      "servers.remember": () => ({ active: [], recent: null }),
      "servers.read": () => ({ active: [], recent: null }),
      "servers.restart": () => ({ active: [], recent: null }),
      "card.get": () => {
        throw new Error("The card display must not wait for a captured cursor");
      },
      "card.read": () => (++reads === 1 ? { view: card(8), conversationSeq: 8 } : fresh.promise),
      "card.diff": () => diff(8),
      "card.markSeen": () => ({ ok: true }),
      "cards.index": () => ({ cards: [] }),
    };

    const first = renderSlot({ component: CurrentCard }, { threadId: "revisit" }, { rpc });
    await waitFor(() => expect(screen.getByLabelText("Card").textContent).toBe("Outcome 8"));
    first.unmount();
    renderSlot({ component: CurrentCard }, { threadId: "revisit" }, { rpc });
    expect(screen.getByLabelText("Card").textContent).toBe("Outcome 8");
    await act(async () => fresh.reject(new Error("Unavailable")));
    expect(screen.getByLabelText("Failure").textContent).not.toBe("None");
    expect(screen.getByLabelText("Card").textContent).toBe("Outcome 8");
  });

  it("keeps a current card current while a realtime notice revalidates it until that read fails", async () => {
    const fresh = deferred<{ view: ReturnType<typeof card>; conversationSeq: number }>();
    let reads = 0;

    const rpc: PluginRpcTestHandlers<GlanceRpcContract> = {
      "servers.remember": () => ({ active: [], recent: null }),
      "servers.read": () => ({ active: [], recent: null }),
      "servers.restart": () => ({ active: [], recent: null }),
      "card.get": () => {
        throw new Error("The card display must not wait for a captured cursor");
      },
      "card.read": () => (++reads === 1 ? { view: card(4), conversationSeq: 4 } : fresh.promise),
      "card.diff": () => diff(4),
      "card.markSeen": () => ({ ok: true }),
      "cards.index": () => ({ cards: [] }),
    };

    const slot = renderSlot({ component: CurrentCard }, { threadId: "revalidate" }, { rpc });
    await waitFor(() => expect(screen.getByLabelText("Current").textContent).toBe("true"));
    await slot.behavior.emitRealtime(realtimeChannel, { threadId: "revalidate", revision: 4 });
    expect(reads).toBe(2);
    expect(screen.getByLabelText("Current").textContent).toBe("true");
    expect(screen.getByLabelText("Card").textContent).toBe("Outcome 4");
    await act(async () => fresh.reject(new Error("Unavailable")));
    expect(screen.getByLabelText("Current").textContent).toBe("false");
    expect(screen.getByLabelText("Failure").textContent).not.toBe("None");
  });

  it("supersedes pending reads on realtime and reconnect without accepting an older response", async () => {
    const older = deferred<{ view: ReturnType<typeof card>; conversationSeq: number }>();
    let requests = 0;

    const rpc: PluginRpcTestHandlers<GlanceRpcContract> = {
      "servers.remember": () => ({ active: [], recent: null }),
      "servers.read": () => ({ active: [], recent: null }),
      "servers.restart": () => ({ active: [], recent: null }),
      "card.get": () => {
        throw new Error("The card display must not wait for a captured cursor");
      },
      "card.read": () => {
        requests += 1;

        return requests === 1 ? older.promise : { view: card(requests), conversationSeq: requests };
      },
      "card.diff": () => diff(requests),
      "card.markSeen": () => ({ ok: true }),
      "cards.index": () => ({ cards: [] }),
    };

    const slot = renderSlot({ component: CurrentCard }, { threadId: "thread-1" }, { rpc });

    await slot.behavior.emitRealtime(realtimeChannel, { threadId: "thread-1", revision: 2 });
    await waitFor(() => expect(screen.getByLabelText("Card").textContent).toBe("Outcome 2"));
    await act(async () => older.resolve({ view: card(1), conversationSeq: 1 }));
    expect(screen.getByLabelText("Card").textContent).toBe("Outcome 2");

    await slot.behavior.setRealtimeConnectionState("reconnecting");
    await slot.behavior.setRealtimeConnectionState("connected");
    await waitFor(() => expect(screen.getByLabelText("Card").textContent).toBe("Outcome 3"));
    expect(screen.getByLabelText("Changes").textContent).toBe("3");
  });
});

type BootstrapSnapshot = ExperimentalThreadBootstrapData & { current?: boolean };

type BootstrapFixture = {
  "thread-1:card.read": BootstrapSnapshot;
};

function readyBootstrap(
  revision: number,
  threadId = "thread-1",
  current = true,
): BootstrapSnapshot {
  return {
    status: "ready",
    current,
    updatedAt: revision,
    result: {
      view: {
        threadId,
        revision,
        updatedAt: revision,
        source: "cli",
        staleSince: null,
        card: { status: "done", phase: "done", headline: `Outcome ${revision}` },
        proofs: [],
      },
    },
  };
}

function bootstrapRpc(
  revision: number,
  read: () => Promise<{ view: CardView | null }> = async () => ({ view: card(revision) }),
) {
  const reads = vi.fn(read);

  const rpc: PluginRpcTestHandlers<GlanceRpcContract> = {
    "servers.remember": () => ({ active: [], recent: null }),
    "servers.read": () => ({ active: [], recent: null }),
    "servers.restart": () => ({ active: [], recent: null }),
    "card.read": reads,
    "card.get": () => {
      throw new Error("Unexpected cursor read");
    },
    "card.diff": () => diff(revision),
    "card.markSeen": () => ({ ok: true }),
    "cards.index": () => ({ cards: [] }),
  };

  return { reads, rpc };
}

function IndexOwner() {
  useIndex();

  return null;
}

describe("Glance conversation bootstrap adoption", () => {
  it("shows an indexed card with the chat while its conversation bootstrap is pending", async () => {
    const values: BootstrapFixture = { "thread-1:card.read": { status: "pending" } };
    const { rpc: base, reads } = bootstrapRpc(4);

    const index = vi.fn(() => ({
      cards: [
        {
          threadId: "thread-1",
          revision: 4,
          status: "needs-you" as const,
          phase: "build" as const,
          goal: "Ship the scoped release",
          headline: "Choose the release scope",
          sidebarSummary: null,
          blocker: null,
          next: "Sam answers the scope question",
          facts: [],
          visuals: [],
          stale: false,
          unseen: true,
          updatedAt: 4,
        },
      ],
    }));

    const rpc: PluginRpcTestHandlers<GlanceRpcContract> = { ...base, "cards.index": index };
    const options = { pluginId: "bootstrap-indexed", rpc, threadBootstrapData: values };
    renderSlot({ component: IndexOwner }, {}, options);
    await waitFor(() => expect(index).toHaveBeenCalled());
    await act(async () => {});

    renderSlot({ component: GlanceCard }, { threadId: "thread-1" }, options);

    expect(screen.getByText("Needs you")).toBeTruthy();
    expect(screen.getByText("Choose the release scope")).toBeTruthy();
    expect(screen.getByText("Ship the scoped release")).toBeTruthy();
    expect(screen.getByText("Sam answers the scope question")).toBeTruthy();
    expect(screen.queryByText("Loading Glance…")).toBeNull();
    expect(reads).not.toHaveBeenCalled();
  });

  it.each(["pending", "ready"] as const)(
    "shows a current bootstrap from initial %s without another card request",
    async (initial) => {
      const values: BootstrapFixture = {
        "thread-1:card.read": initial === "pending" ? { status: "pending" } : readyBootstrap(9),
      };

      const { rpc, reads } = bootstrapRpc(9);
      const options = { pluginId: `bootstrap-cold-${initial}`, rpc, threadBootstrapData: values };
      const early = renderSlot({ component: GlanceCard }, { threadId: "thread-1" }, options);

      if (initial === "pending") {
        expect(early.container.textContent).toBe("");
        values["thread-1:card.read"] = readyBootstrap(9);
        early.rerender(<GlanceCard threadId="thread-1" />);
      }

      expect(screen.getByText("Outcome 9")).toBeTruthy();
      expect(screen.queryByText("Loading Glance…")).toBeNull();
      expect(screen.queryByText(/Last loaded card/)).toBeNull();
      renderSlot({ component: GlanceCard }, { threadId: "thread-1" }, options);
      expect(screen.getAllByText("Outcome 9")).toHaveLength(2);
      await act(async () => {});
      expect(reads).not.toHaveBeenCalled();
    },
  );

  it.each(["null", "error"] as const)(
    "preserves an explicit fresh %s outcome without a fallback card read",
    async (outcome) => {
      const values: BootstrapFixture = {
        "thread-1:card.read": { status: "pending" },
      };

      const { rpc, reads } = bootstrapRpc(10);

      const slot = renderSlot(
        { component: GlanceCard },
        { threadId: "thread-1" },
        { pluginId: `bootstrap-${outcome}`, rpc, threadBootstrapData: values },
      );

      values["thread-1:card.read"] = readyBootstrap(10);
      slot.rerender(<GlanceCard threadId="thread-1" />);
      expect(screen.getByText("Outcome 10")).toBeTruthy();
      values["thread-1:card.read"] = { status: "pending" };
      slot.rerender(<GlanceCard threadId="thread-1" />);
      expect(screen.getByText("Last loaded card · checking for updates…")).toBeTruthy();
      values["thread-1:card.read"] =
        outcome === "null"
          ? { status: "ready", current: true, result: { view: null }, updatedAt: 11 }
          : { status: "error", message: "Conversation read unavailable", updatedAt: 11 };
      slot.rerender(<GlanceCard threadId="thread-1" />);

      if (outcome === "null") {
        expect(screen.queryByText("Outcome 10")).toBeNull();
        expect(screen.queryByText("Loading Glance…")).toBeNull();
      } else {
        expect(screen.getByText("Outcome 10")).toBeTruthy();
        expect(screen.getByText("Last loaded card · latest version unavailable")).toBeTruthy();
        expect(screen.getByRole("alert").textContent).toContain("Conversation read unavailable");
      }

      await act(async () => {});
      expect(reads).not.toHaveBeenCalled();
    },
  );

  it.each(["initial", "new-entry"] as const)(
    "labels a cached bootstrap from %s and revalidates once across consumers",
    async (entry) => {
      const pending = deferred<{ view: CardView | null }>();
      const { rpc, reads } = bootstrapRpc(12, () => pending.promise);

      const values = {
        "thread-1:card.read": readyBootstrap(12, "thread-1", entry === "new-entry"),
      };

      const options = { pluginId: `bootstrap-retained-${entry}`, rpc, threadBootstrapData: values };
      const first = renderSlot({ component: GlanceCard }, { threadId: "thread-1" }, options);

      if (entry === "new-entry") {
        expect(screen.queryByText(/Last loaded card/)).toBeNull();
        expect(reads).not.toHaveBeenCalled();
        values["thread-1:card.read"] = readyBootstrap(12, "thread-1", false);
        first.rerender(<GlanceCard threadId="thread-1" />);
      }

      renderSlot({ component: GlanceCard }, { threadId: "thread-1" }, options);
      expect(screen.getAllByText("Outcome 12")).toHaveLength(2);
      expect(screen.getAllByText("Last loaded card · checking for updates…")).toHaveLength(2);
      expect(reads).toHaveBeenCalledTimes(1);
      await act(async () => pending.reject(new Error("Revalidation unavailable")));
      expect(screen.getAllByText("Last loaded card · latest version unavailable")).toHaveLength(2);
    },
  );

  it("keeps one revalidation when the first consumer remounts while it is in flight", async () => {
    const pending = deferred<{ view: CardView | null }>();
    const { rpc, reads } = bootstrapRpc(14, () => pending.promise);
    const values = { "thread-1:card.read": readyBootstrap(14, "thread-1", false) };
    const options = { pluginId: "bootstrap-remount", rpc, threadBootstrapData: values };

    const first = renderSlot({ component: GlanceCard }, { threadId: "thread-1" }, options);
    expect(reads).toHaveBeenCalledTimes(1);
    first.unmount();
    renderSlot({ component: GlanceCard }, { threadId: "thread-1" }, options);
    renderSlot({ component: GlanceCard }, { threadId: "thread-1" }, options);
    expect(reads).toHaveBeenCalledTimes(1);
    expect(screen.getAllByText("Last loaded card · checking for updates…")).toHaveLength(2);

    await act(async () => pending.resolve({ view: card(14) }));
    expect(screen.queryByText(/Last loaded card/)).toBeNull();
    expect(screen.getAllByText("Outcome 14")).toHaveLength(2);
  });

  it("revalidates a cached card without adding or removing a row", async () => {
    const pending = deferred<{ view: CardView | null }>();
    const { rpc } = bootstrapRpc(13, () => pending.promise);

    renderSlot(
      { component: GlanceCard },
      { threadId: "thread-1" },
      {
        pluginId: "bootstrap-stable-height",
        rpc,
        threadBootstrapData: { "thread-1:card.read": readyBootstrap(13, "thread-1", false) },
      },
    );

    const status = screen.getByRole("status");
    expect(status.textContent).toBe("Last loaded card · checking for updates…");
    expect(status.className).toBe("sr-only");
    expect(screen.getByText("Checking…")).toBeTruthy();
    await act(async () => pending.resolve({ view: card(13) }));
    expect(screen.queryByRole("status")).toBeNull();
    expect(screen.queryByText("Checking…")).toBeNull();
    expect(screen.getByText("Outcome 13")).toBeTruthy();
  });

  it("waits for the new bootstrap revision's captured cursor before marking it seen", async () => {
    vi.useFakeTimers();
    const history = deferred<CardDiff>();
    const { rpc: baseRpc, reads } = bootstrapRpc(20);
    let histories = 0;

    const rpc: PluginRpcTestHandlers<GlanceRpcContract> = {
      ...baseRpc,
      "card.diff": () =>
        ++histories === 1 ? { ...diff(19), conversationSeq: 101 } : history.promise,
    };

    const values: BootstrapFixture = { "thread-1:card.read": { status: "pending" } };

    const slot = renderSlot(
      { component: GlanceCard },
      { threadId: "thread-1" },
      { pluginId: "bootstrap-cursor", rpc, threadBootstrapData: values },
    );

    values["thread-1:card.read"] = readyBootstrap(19);
    slot.rerender(<GlanceCard threadId="thread-1" />);
    await act(async () => {});
    await act(() => vi.advanceTimersByTimeAsync(2000));
    expect(slot.inspection.rpcCalls.filter((call) => call.method === "card.markSeen")).toHaveLength(
      1,
    );
    values["thread-1:card.read"] = { status: "pending" };
    slot.rerender(<GlanceCard threadId="thread-1" />);
    values["thread-1:card.read"] = readyBootstrap(20);
    slot.rerender(<GlanceCard threadId="thread-1" />);
    await act(() => vi.advanceTimersByTimeAsync(2500));
    expect(slot.inspection.rpcCalls.filter((call) => call.method === "card.markSeen")).toHaveLength(
      1,
    );
    await act(async () => history.resolve({ ...diff(20), conversationSeq: 202 }));
    await act(() => vi.advanceTimersByTimeAsync(2000));
    expect(
      slot.inspection.rpcCalls.filter((call) => call.method === "card.markSeen").at(-1)?.input,
    ).toEqual({ threadId: "thread-1", revision: 20, conversationSeq: 202 });
    expect(reads).not.toHaveBeenCalled();
  });

  it.each(["invalid", "other-thread"] as const)(
    "reports %s bootstrap data instead of silently issuing a replacement read",
    async (failure) => {
      const { rpc, reads } = bootstrapRpc(13);

      const value: BootstrapSnapshot =
        failure === "invalid"
          ? {
              status: "ready",
              current: true,
              result: { view: { threadId: "thread-1" } },
              updatedAt: 13,
            }
          : readyBootstrap(13, "another-chat");

      renderSlot(
        { component: GlanceCard },
        { threadId: "thread-1" },
        {
          pluginId: `bootstrap-${failure}`,
          rpc,
          threadBootstrapData: { "thread-1:card.read": value },
        },
      );
      expect(screen.getByRole("alert").textContent).toContain("invalid card");
      await act(async () => {});
      expect(reads).not.toHaveBeenCalled();
    },
  );
});
