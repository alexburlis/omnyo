// @vitest-environment jsdom

import { useEffect, useState } from "react";
import { useThreadReadTracking } from "@/hooks/useThreadReadTracking";
import { act, cleanup, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferredPromise } from "@omnyo/test-helpers";
import { PluginContext } from "@/components/plugin/plugin-context";
import { useRpc, useSettings } from "@/lib/plugin-sdk-hooks";
import {
  applyPluginCss,
  resetPluginCssForTest,
  usePluginCss,
} from "@/lib/plugin-css";
import {
  createPendingChat,
  retirePendingChatSurface,
} from "@/lib/pending-chat-creations";
import { makeThreadResponse } from "@/test/fixtures/thread-responses";
import {
  ThreadInitialLoad,
  useThreadInitialLoadPending,
} from "./ThreadInitialLoad";

function Notices({ pending }: { pending: boolean }) {
  useThreadInitialLoadPending(pending);

  return <p>Conversation and notices</p>;
}

function Card() {
  const rpc = useRpc();
  const settings = useSettings();
  const [text, setText] = useState("Loading card");
  usePluginCss("cards");
  useEffect(() => {
    if (settings.isLoading) return;
    void rpc
      .call("state")
      .then(() => rpc.call("card"))
      .then(
        () => setText("Glance and prediction"),
        () => setText("Card failed to load"),
      );
  }, [rpc, settings.isLoading]);

  return <p>{text}</p>;
}

async function frames() {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(50);
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) =>
    setTimeout(() => callback(performance.now()), 16),
  );
  vi.stubGlobal("cancelAnimationFrame", clearTimeout);
  window.dispatchEvent(new KeyboardEvent("keydown"));
});

afterEach(() => {
  cleanup();
  resetPluginCssForTest();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("ThreadInitialLoad", () => {
  it("reveals notices, plugin settings, chained RPC data and styles together, then keeps live updates visible", async () => {
    const settings = createDeferredPromise<Response>();
    const state = createDeferredPromise<Response>();
    const card = createDeferredPromise<Response>();
    const requests = [settings.promise, state.promise, card.promise];
    vi.stubGlobal(
      "fetch",
      vi.fn(() => requests.shift()),
    );
    applyPluginCss("cards", "/cards.css");

    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });

    const content = (pending: boolean) => (
      <QueryClientProvider client={client}>
        <ThreadInitialLoad threadId="thr_test" fallback={<p>Loading chat</p>}>
          <Notices pending={pending} />
          <PluginContext.Provider value="cards">
            <Card />
          </PluginContext.Provider>
        </ThreadInitialLoad>
      </QueryClientProvider>
    );

    const view = render(content(true));
    const conversation = screen.getByText("Conversation and notices");
    await frames();
    expect(getComputedStyle(conversation).visibility).toBe("hidden");
    await act(async () => {
      settings.resolve(Response.json({ ok: true, values: { enabled: true } }));
    });
    await frames();
    expect(getComputedStyle(conversation).visibility).toBe("hidden");
    await act(async () => {
      state.resolve(Response.json({ ok: true, result: {} }));
    });
    await frames();
    expect(getComputedStyle(conversation).visibility).toBe("hidden");
    await act(async () => {
      card.resolve(Response.json({ ok: true, result: {} }));
    });
    view.rerender(content(false));
    await frames();
    expect(
      getComputedStyle(screen.getByText("Glance and prediction")).visibility,
    ).toBe("hidden");
    await act(async () => {
      document.head
        .querySelector('link[rel="stylesheet"]')!
        .dispatchEvent(new Event("load"));
    });
    await frames();
    expect(getComputedStyle(conversation).visibility).toBe("visible");
    expect(
      getComputedStyle(screen.getByText("Glance and prediction")).visibility,
    ).toBe("visible");
    expect(screen.queryByText("Loading chat")).toBeNull();
    view.rerender(content(true));
    await frames();
    expect(getComputedStyle(conversation).visibility).toBe("visible");
    client.clear();
  });

  it("reveals the plugin error instead of leaving the chat loading after a rejected request", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(
          Response.json({ ok: true, values: { enabled: true } }),
        )
        .mockRejectedValueOnce(new Error("offline")),
    );

    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });

    render(
      <QueryClientProvider client={client}>
        <ThreadInitialLoad threadId="thr_test" fallback={<p>Loading chat</p>}>
          <PluginContext.Provider value="cards">
            <Card />
          </PluginContext.Provider>
        </ThreadInitialLoad>
      </QueryClientProvider>,
    );
    await frames();
    await frames();
    expect(
      getComputedStyle(screen.getByText("Card failed to load")).visibility,
    ).toBe("visible");
    expect(screen.queryByText("Loading chat")).toBeNull();
    client.clear();
  });

  it("reveals after a bounded wait for a stalled plugin read but always waits for the conversation", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => new Promise<Response>(() => {})),
    );

    function StalledRead() {
      const rpc = useRpc();
      useEffect(() => {
        void rpc.call("card");
      }, [rpc]);

      return <p>Plugin card</p>;
    }

    function Conversation({ pending }: { pending: boolean }) {
      useThreadInitialLoadPending(pending, true);

      return <p>Conversation</p>;
    }

    const content = (pending: boolean) => (
      <ThreadInitialLoad threadId="thr_test" fallback={<p>Loading chat</p>}>
        <Conversation pending={pending} />
        <PluginContext.Provider value="cards">
          <StalledRead />
        </PluginContext.Provider>
      </ThreadInitialLoad>
    );

    const view = render(content(true));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_200);
    });
    expect(getComputedStyle(screen.getByText("Conversation")).visibility).toBe(
      "hidden",
    );
    view.rerender(content(false));
    await frames();
    expect(getComputedStyle(screen.getByText("Conversation")).visibility).toBe(
      "visible",
    );
    expect(getComputedStyle(screen.getByText("Plugin card")).visibility).toBe(
      "visible",
    );
  });

  it("starts a fresh barrier on chat navigation without carrying readiness from the previous chat", async () => {
    const content = (threadId: string, pending: boolean) => (
      <ThreadInitialLoad
        threadId={threadId}
        key={threadId}
        fallback={<p>Loading chat</p>}
      >
        <Notices pending={pending} />
      </ThreadInitialLoad>
    );

    const view = render(content("first", false));
    await frames();
    expect(
      getComputedStyle(screen.getByText("Conversation and notices")).visibility,
    ).toBe("visible");
    view.rerender(content("second", true));
    await frames();
    expect(
      getComputedStyle(screen.getByText("Conversation and notices")).visibility,
    ).toBe("hidden");
    view.rerender(content("second", false));
    await frames();
    expect(
      getComputedStyle(screen.getByText("Conversation and notices")).visibility,
    ).toBe("visible");
  });

  it("marks a chat that just took over from its starting view only for the entrance", async () => {
    const pending = createPendingChat({
      queueOwner: {},
      request: {
        projectId: "project-handoff",
        providerId: "codex",
        model: "model",
        reasoningLevel: "high",
        permissionMode: "full",
        environment: { type: "reuse", environmentId: "environment-handoff" },
        executionInputSources: { providerId: "explicit" },
        input: [{ type: "text", text: "start the chat", mentions: [] }],
      },
      create: async () =>
        makeThreadResponse({ id: "thr_handoff", projectId: "project-handoff" }),
      send: async () => {},
      renderer: () => null,
      prepare: async () => {},
    });

    await pending.completion;
    retirePendingChatSurface(pending.id);

    const view = render(
      <>
        <ThreadInitialLoad
          threadId="thr_handoff"
          initiallyReady
          fallback={null}
        >
          <p>Handed off</p>
        </ThreadInitialLoad>
        <ThreadInitialLoad threadId="thr_opened" initiallyReady fallback={null}>
          <p>Opened</p>
        </ThreadInitialLoad>
      </>,
    );

    const isMarked = (threadId: string) =>
      view.container
        .querySelector(`[data-thread-initial-load="${threadId}"]`)
        ?.hasAttribute("data-thread-handoff");

    expect(isMarked("thr_handoff")).toBe(true);
    expect(isMarked("thr_opened")).toBe(false);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(400);
    });

    expect(isMarked("thr_handoff")).toBe(false);
  });
});

function OverlayRead() {
  const rpc = useRpc();
  useEffect(() => {
    void rpc.call("diff", { threadId: "thr_overlay" });
  }, [rpc]);

  return null;
}

it("includes overlay requests for the owning chat without blocking a different pane", async () => {
  const response = createDeferredPromise<Response>();
  vi.stubGlobal(
    "fetch",
    vi.fn(() => response.promise),
  );
  render(
    <>
      <ThreadInitialLoad threadId="thr_overlay" fallback={<p>Loading first</p>}>
        <p>First chat</p>
      </ThreadInitialLoad>
      <ThreadInitialLoad threadId="thr_other" fallback={<p>Loading second</p>}>
        <p>Second chat</p>
      </ThreadInitialLoad>
      <PluginContext.Provider value="cards">
        <OverlayRead />
      </PluginContext.Provider>
    </>,
  );
  await frames();
  expect(getComputedStyle(screen.getByText("First chat")).visibility).toBe(
    "hidden",
  );
  expect(getComputedStyle(screen.getByText("Second chat")).visibility).toBe(
    "visible",
  );
  await act(async () => {
    response.resolve(Response.json({ ok: true, result: {} }));
  });
  await frames();
  expect(getComputedStyle(screen.getByText("First chat")).visibility).toBe(
    "visible",
  );
});

it("does not mark an unread chat read until the complete layout is revealed", async () => {
  const markThreadRead = {
    mutateAsync: vi.fn(async () => ({ lastReadAt: 20, latestAttentionAt: 20 })),
  };

  function ReadMarker() {
    useThreadReadTracking({
      markThreadRead,
      thread: { id: "thr_unread", lastReadAt: 10, latestAttentionAt: 20 },
    });

    return null;
  }

  const content = (pending: boolean) => (
    <ThreadInitialLoad threadId="thr_unread" fallback={<p>Loading chat</p>}>
      <Notices pending={pending} />
      <ReadMarker />
    </ThreadInitialLoad>
  );

  const view = render(content(true));
  await frames();
  expect(markThreadRead.mutateAsync).not.toHaveBeenCalled();
  view.rerender(content(false));
  await frames();
  expect(markThreadRead.mutateAsync).toHaveBeenCalledTimes(1);
});
