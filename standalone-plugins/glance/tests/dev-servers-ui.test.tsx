import { act, cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderSlot, type PluginRpcTestHandlers } from "@omnyo/plugin-sdk/testing/app";
import { useComposers, type PluginComposerApi } from "@omnyo/plugin-sdk/app";
import {
  ComposerDevServers,
  DevServers,
  DevServersPopup,
  HeaderDevServers,
} from "../components/dev-servers";
import type { DevServerRow, DevServerShelf, GlanceRpcContract } from "../contract";

const empty: DevServerShelf = { active: [], recent: null };

class ViewportQuery extends EventTarget implements MediaQueryList {
  onchange = null;
  readonly media = "(max-width: 767px)";
  matches = false;

  addListener() {}

  removeListener() {}

  resize(matches: boolean) {
    this.matches = matches;
    this.dispatchEvent(new Event("change"));
  }
}

let viewport: ViewportQuery;

function server(
  id: string,
  state: DevServerRow["status"]["state"],
  lastObservedOnlineAt: number | null = null,
): DevServerRow {
  return {
    preview: {
      id,
      projectId: "project-one",
      threadId: "thread-one",
      environmentId: "environment-one",
      hostId: "host-one",
      hostName: "Preview Mac",
      url: `http://localhost:4310/${id}?fixture=1#ready`,
      remoteUrl: `/preview/${id}/${id}?fixture=1#ready`,
      createdAt: 10,
    },
    status: { state, checkedAt: Date.now(), detail: null, runId: null },
    lastObservedOnlineAt,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;

  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });

  return { promise, resolve, reject };
}

function handlers(
  read: PluginRpcTestHandlers<GlanceRpcContract>["servers.read"],
  restart: PluginRpcTestHandlers<GlanceRpcContract>["servers.restart"] = () => empty,
): PluginRpcTestHandlers<GlanceRpcContract> {
  return {
    "servers.remember": () => ({ active: [], recent: null }),
    "servers.read": read,
    "servers.restart": restart,
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
    "cards.index": () => ({ cards: [] }),
  };
}

beforeEach(() => {
  vi.spyOn(document, "hidden", "get").mockReturnValue(false);
  viewport = new ViewportQuery();
  vi.stubGlobal("matchMedia", () => viewport);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("Dev server shelf", () => {
  it("labels IPv4 loopback servers as localhost while preserving distinct ports and IPv6", async () => {
    const first = server("first", "online");
    first.preview.url = "http://127.0.0.1:3227/";
    const second = server("second", "online");
    second.preview.url = "http://127.0.0.1:3237/path?fixture=1#ready";
    const ipv6 = server("ipv6", "online");
    ipv6.preview.url = "http://[::1]:3227/path?fixture=1#ready";

    renderSlot(
      { component: DevServers },
      { threadId: "thread-one" },
      {
        rpc: handlers(() => ({ active: [first, second, ipv6], recent: null })),
        realtimeConnectionState: "connecting",
      },
    );

    const region = await screen.findByRole("region", { name: "Dev servers" });
    expect(within(region).getAllByRole("listitem")).toHaveLength(3);

    const firstLink = within(region).getByRole("link", { name: "Open localhost:3227" });

    const secondLink = within(region).getByRole("link", {
      name: "Open localhost:3237/path?fixture=1#ready",
    });

    const ipv6Link = within(region).getByRole("link", {
      name: "Open [::1]:3227/path?fixture=1#ready",
    });

    expect(firstLink.getAttribute("href")).toBe(
      new URL(first.preview.remoteUrl, window.location.href).href,
    );
    expect(secondLink.getAttribute("href")).toBe(
      new URL(second.preview.remoteUrl, window.location.href).href,
    );
    expect(ipv6Link.getAttribute("href")).toBe(
      new URL(ipv6.preview.remoteUrl, window.location.href).href,
    );
  });

  it("removes the composer shelf and its polling on mobile, and restores it after resizing", async () => {
    viewport.resize(true);
    const read = vi.fn(() => ({ active: [server("live", "online")], recent: null }));
    renderSlot(
      { component: ComposerDevServers },
      {},
      {
        rpc: handlers(read),
        composer: { scope: { kind: "thread", threadId: "thread-one" } },
        realtimeConnectionState: "connecting",
      },
    );

    await act(async () => {});
    expect(screen.queryByRole("region", { name: "Dev servers" })).toBeNull();
    expect(read).not.toHaveBeenCalled();
    await act(async () => viewport.resize(false));
    await screen.findByRole("link");
    expect(read).toHaveBeenCalledTimes(1);
    await act(async () => viewport.resize(true));
    fireEvent.focus(window);
    await act(async () => {});
    expect(screen.queryByRole("region", { name: "Dev servers" })).toBeNull();
    expect(read).toHaveBeenCalledTimes(1);
  });

  it("keeps all active servers and the recent stopped server beside full private preview links", async () => {
    const recent = server("recent", "stopped", 5);
    const shelf = { active: [server("first", "online"), server("second", "online")], recent };

    const slot = renderSlot(
      { component: DevServers },
      { threadId: "thread-one" },
      { rpc: handlers(() => shelf), realtimeConnectionState: "connecting", openUrl: () => true },
    );

    const region = await screen.findByRole("region", { name: "Dev servers" });
    expect(within(region).getAllByRole("listitem")).toHaveLength(3);
    expect(within(region).getByText("Stopped")).toBeTruthy();
    expect(within(region).getByText(/^Last seen running /u)).toBeTruthy();
    expect(within(region).getAllByText("Running")).toHaveLength(2);

    const link = within(region).getByRole("link", {
      name: "Open localhost:4310/first?fixture=1#ready",
    });

    const expected = new URL("/preview/first/first?fixture=1#ready", window.location.href).href;
    expect(link.getAttribute("href")).toBe(expected);
    expect(within(region).getByText("localhost:4310/first?fixture=1#ready")).toBeTruthy();
    expect(within(link).getByText("Open")).toBeTruthy();
    fireEvent.click(link);
    expect(slot.inspection.navigateCalls).toHaveLength(1);
    expect(slot.inspection.navigateCalls).toContainEqual({ method: "openUrl", url: expected });
  });

  it("sends one saved-server restart with an idempotency identity and opens only after readiness", async () => {
    const pending = deferred<DevServerShelf>();

    const restart = vi.fn<PluginRpcTestHandlers<GlanceRpcContract>["servers.restart"]>(
      () => pending.promise,
    );

    const row = server("saved", "stopped");

    const slot = renderSlot(
      { component: DevServers },
      { threadId: "thread-one" },
      {
        rpc: handlers(() => ({ active: [], recent: row }), restart),
        realtimeConnectionState: "connecting",
      },
    );

    const button = await screen.findByRole("button", {
      name: "Restart localhost:4310/saved?fixture=1#ready",
    });

    expect(screen.getByText("Not seen running yet")).toBeTruthy();
    expect(screen.getByText("Stopped")).toBeTruthy();
    fireEvent.click(button);
    fireEvent.click(button);
    expect(button.hasAttribute("disabled")).toBe(true);
    expect(button.getAttribute("aria-busy")).toBe("true");
    expect(screen.queryByRole("link")).toBeNull();
    await waitFor(() => expect(restart).toHaveBeenCalledTimes(1));
    const call = slot.inspection.rpcCalls.find((entry) => entry.method === "servers.restart");
    expect(call?.input).toEqual({
      threadId: "thread-one",
      previewId: "saved",
      requestId: expect.stringMatching(/^[a-f0-9-]{36}$/u),
    });
    await act(async () =>
      pending.resolve({ active: [server("saved", "online", Date.now())], recent: null }),
    );
    expect(
      await screen.findByRole("link", { name: "Open localhost:4310/saved?fixture=1#ready" }),
    ).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Restart/u })).toBeNull();
  });

  it.each([
    ["host-offline", "Computer offline"],
    ["conflict", "Port in use"],
    ["unknown", "Status unknown"],
  ] as const)(
    "keeps %s visible without offering an unsafe open or restart",
    async (state, text) => {
      const row = server("unavailable", state, 5);
      row.status.detail = "The owner could not provide a ready server";
      renderSlot(
        { component: DevServers },
        { threadId: "thread-one" },
        {
          rpc: handlers(() => ({ active: [], recent: row })),
          realtimeConnectionState: "connecting",
        },
      );

      await screen.findByText(text);
      expect(screen.getByText(/^Last seen running /u)).toBeTruthy();
      expect(screen.getByText(row.status.detail)).toBeTruthy();
      expect(screen.queryByRole("link")).toBeNull();
      expect(screen.queryByRole("button", { name: /Restart/u })).toBeNull();
    },
  );

  it("shows starting without replaying the launch and keeps failed starts restartable", async () => {
    const shelf = { active: [server("starting", "starting")], recent: server("failed", "error") };
    const restart = vi.fn(() => empty);
    renderSlot(
      { component: DevServers },
      { threadId: "thread-one" },
      { rpc: handlers(() => shelf, restart), realtimeConnectionState: "connecting" },
    );

    const starting = await screen.findByRole("button", {
      name: "Restart localhost:4310/starting?fixture=1#ready",
    });

    expect(starting.hasAttribute("disabled")).toBe(true);
    fireEvent.click(starting);
    expect(restart).not.toHaveBeenCalled();
    expect(
      screen
        .getByRole("button", { name: "Restart localhost:4310/failed?fixture=1#ready" })
        .hasAttribute("disabled"),
    ).toBe(false);
  });

  it("withdraws stale controls on a failed refresh and restores them only after Retry observes readiness", async () => {
    let failing = false;

    const read = vi.fn(() => {
      if (failing) throw new Error("fixture transport failure");

      return { active: [server("live", "online")], recent: null };
    });

    renderSlot(
      { component: DevServers },
      { threadId: "thread-one" },
      { rpc: handlers(read), realtimeConnectionState: "connecting" },
    );
    await screen.findByRole("link");
    failing = true;
    fireEvent.focus(window);
    await screen.findByText("Could not check dev servers.");
    expect(screen.queryByRole("link")).toBeNull();
    expect(screen.getByText("Status unknown")).toBeTruthy();
    failing = false;
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(await screen.findByRole("link")).toBeTruthy();
    expect(screen.queryByText("Could not check dev servers.")).toBeNull();
  });

  it("reconciles a failed restart through Retry without automatically launching again", async () => {
    let shelf: DevServerShelf = { active: [], recent: server("saved", "stopped") };

    const restart = vi.fn(() => {
      throw new Error("fixture ambiguous response");
    });

    renderSlot(
      { component: DevServers },
      { threadId: "thread-one" },
      { rpc: handlers(() => shelf, restart), realtimeConnectionState: "connecting" },
    );
    fireEvent.click(await screen.findByRole("button", { name: /Restart/u }));
    await screen.findByText("Could not start the dev server. Retry checks its current state.");
    expect(screen.queryByRole("button", { name: /Restart/u })).toBeNull();
    shelf = { active: [server("saved", "online")], recent: null };
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(await screen.findByRole("link")).toBeTruthy();
    expect(restart).toHaveBeenCalledTimes(1);
  });

  it("discards another chat's pending read when the composer changes scope", async () => {
    const pending = deferred<DevServerShelf>();

    const read = vi.fn<PluginRpcTestHandlers<GlanceRpcContract>["servers.read"]>((input) =>
      input.threadId === "thread-one"
        ? pending.promise
        : { active: [server("new-chat", "online")], recent: null },
    );

    const slot = renderSlot(
      { component: ComposerDevServers },
      {},
      {
        rpc: handlers(read),
        composer: { scope: { kind: "thread", threadId: "thread-one" } },
        realtimeConnectionState: "connecting",
      },
    );

    await slot.behavior.setComposerScope({ kind: "thread", threadId: "thread-two" });
    await screen.findByRole("link", { name: "Open localhost:4310/new-chat?fixture=1#ready" });
    await act(async () =>
      pending.resolve({ active: [server("old-chat", "online")], recent: null }),
    );
    expect(
      screen.queryByRole("link", { name: "Open localhost:4310/old-chat?fixture=1#ready" }),
    ).toBeNull();
    await slot.behavior.setComposerScope({ kind: "new-thread", projectId: "project-one" });
    expect(screen.queryByRole("region", { name: "Dev servers" })).toBeNull();
  });

  it("expires enabled controls while a status refresh remains unresolved", async () => {
    vi.useFakeTimers();
    const pending = deferred<DevServerShelf>();

    const read = vi
      .fn<PluginRpcTestHandlers<GlanceRpcContract>["servers.read"]>()
      .mockImplementationOnce(() => ({ active: [server("live", "online")], recent: null }))
      .mockImplementation(() => pending.promise);

    const slot = renderSlot(
      { component: DevServers },
      { threadId: "thread-one" },
      { rpc: handlers(read), realtimeConnectionState: "connecting" },
    );

    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(screen.queryByRole("link")).not.toBeNull();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(16000);
    });
    expect(read).toHaveBeenCalledTimes(2);
    expect(screen.queryByRole("link")).toBeNull();
    expect(screen.queryByRole("button", { name: /Restart/u })).toBeNull();
    expect(screen.getByText("Server status expired. Retry to check it.")).toBeTruthy();
    slot.unmount();
    await act(async () => {
      pending.resolve(empty);
    });
  });

  it("pauses polling while hidden, resumes one poll chain, and cancels it on unmount", async () => {
    vi.useFakeTimers();
    const visibility = vi.spyOn(document, "hidden", "get");
    const read = vi.fn(() => ({ active: [server("live", "online")], recent: null }));

    const slot = renderSlot(
      { component: DevServers },
      { threadId: "thread-one" },
      { rpc: handlers(read), realtimeConnectionState: "connecting" },
    );

    await act(async () => {});
    expect(read).toHaveBeenCalledTimes(1);
    await act(() => vi.advanceTimersByTimeAsync(10000));
    expect(read).toHaveBeenCalledTimes(2);
    visibility.mockReturnValue(true);
    fireEvent(document, new Event("visibilitychange"));
    await act(() => vi.advanceTimersByTimeAsync(30000));
    expect(read).toHaveBeenCalledTimes(2);
    expect(screen.queryByRole("link")).toBeNull();
    visibility.mockReturnValue(false);
    fireEvent(document, new Event("visibilitychange"));
    await act(async () => {});
    expect(read).toHaveBeenCalledTimes(3);
    await act(() => vi.advanceTimersByTimeAsync(10000));
    expect(read).toHaveBeenCalledTimes(4);
    slot.unmount();
    await act(() => vi.advanceTimersByTimeAsync(30000));
    fireEvent.focus(window);
    expect(read).toHaveBeenCalledTimes(4);
  });

  it("omits an empty shelf and refuses an online observation older than the freshness window", async () => {
    let shelf = empty;
    renderSlot(
      { component: DevServers },
      { threadId: "thread-one" },
      { rpc: handlers(() => shelf), realtimeConnectionState: "connecting" },
    );
    await act(async () => {});
    expect(screen.queryByRole("region", { name: "Dev servers" })).toBeNull();
    const row = server("stale", "online");
    row.status.checkedAt = Date.now() - 20000;
    shelf = { active: [row], recent: null };
    fireEvent.focus(window);
    await screen.findByRole("region", { name: "Dev servers" });
    expect(screen.queryByRole("link")).toBeNull();
    expect(screen.getByText("Status unknown")).toBeTruthy();
  });
});

describe("Mobile dev servers", () => {
  it("shows a live header count and opens only the matching chat's popup", async () => {
    let composer: PluginComposerApi | undefined;

    function Header() {
      composer = useComposers()[0];

      return <HeaderDevServers threadId="thread-one" projectId="project-one" isCompactViewport />;
    }

    const slot = renderSlot(
      { component: Header },
      {},
      {
        rpc: handlers(() => ({
          active: [server("first", "online"), server("second", "online")],
          recent: server("saved", "stopped"),
        })),
        composer: { scope: { kind: "thread", threadId: "thread-one" } },
        realtimeConnectionState: "connecting",
      },
    );

    const button = await screen.findByRole("button", { name: "Dev servers, 2 running, 3 total" });
    expect(button.textContent).toBe("3");
    expect(button.getAttribute("aria-haspopup")).toBe("dialog");
    expect(screen.queryByRole("region", { name: "Dev servers" })).toBeNull();

    if (composer === undefined) throw new Error("Expected the header's mounted composer");
    const open = vi.spyOn(composer, "experimental_openPopup").mockReturnValue(true);
    fireEvent.click(button);
    expect(open).toHaveBeenCalledExactlyOnceWith("dev-servers");
    open.mockReturnValue(false);
    fireEvent.click(button);
    expect(
      screen.getByRole("button", { name: "Could not open dev servers. Retry" }).textContent,
    ).toBe("!");
    await slot.behavior.setComposerScope({ kind: "thread", threadId: "another-chat" });
    expect(button.hasAttribute("disabled")).toBe(true);
    fireEvent.click(button);
    expect(open).toHaveBeenCalledTimes(2);
  });

  it("does not mount a header observer on desktop and resets pending reads when its chat changes", async () => {
    const pending = deferred<DevServerShelf>();

    const read = vi.fn<PluginRpcTestHandlers<GlanceRpcContract>["servers.read"]>((input) =>
      input.threadId === "thread-one"
        ? pending.promise
        : { active: [server("new-chat", "online")], recent: null },
    );

    const slot = renderSlot(
      { component: HeaderDevServers },
      { threadId: "thread-one", projectId: "project-one", isCompactViewport: false },
      {
        rpc: handlers(read),
        composer: { scope: { kind: "thread", threadId: "thread-one" } },
        realtimeConnectionState: "connecting",
      },
    );

    await act(async () => {});
    expect(read).not.toHaveBeenCalled();
    slot.rerender(
      <HeaderDevServers threadId="thread-one" projectId="project-one" isCompactViewport />,
    );
    await act(async () => {});
    expect(read).toHaveBeenCalledTimes(1);
    slot.rerender(
      <HeaderDevServers threadId="thread-two" projectId="project-one" isCompactViewport />,
    );
    await screen.findByRole("button", { name: "Dev servers, 1 running, 1 total" });
    await act(async () =>
      pending.resolve({
        active: [server("old-one", "online"), server("old-two", "online")],
        recent: null,
      }),
    );
    expect(screen.getByRole("button", { name: "Dev servers, 1 running, 1 total" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Dev servers, 2 running, 2 total" })).toBeNull();
  });

  it("replaces expired header counts with an unknown status while a refresh is unresolved", async () => {
    vi.useFakeTimers();
    const pending = deferred<DevServerShelf>();

    const read = vi
      .fn<PluginRpcTestHandlers<GlanceRpcContract>["servers.read"]>()
      .mockImplementationOnce(() => ({ active: [server("live", "online")], recent: null }))
      .mockImplementation(() => pending.promise);

    const slot = renderSlot(
      { component: HeaderDevServers },
      { threadId: "thread-one", projectId: "project-one", isCompactViewport: true },
      {
        rpc: handlers(read),
        composer: { scope: { kind: "thread", threadId: "thread-one" } },
        realtimeConnectionState: "connecting",
      },
    );

    await act(async () => {});
    expect(
      screen.getByRole("button", { name: "Dev servers, 1 running, 1 total" }).textContent,
    ).toBe("1");
    await act(() => vi.advanceTimersByTimeAsync(16000));
    expect(screen.getByRole("button", { name: "Dev servers, status unknown" }).textContent).toBe(
      "?",
    );
    slot.unmount();
    await act(async () => pending.resolve(empty));
  });

  it("omits an empty header badge and keeps a failed check discoverable", async () => {
    let failing = false;
    renderSlot(
      { component: HeaderDevServers },
      { threadId: "thread-one", projectId: "project-one", isCompactViewport: true },
      {
        rpc: handlers(() => {
          if (failing) throw new Error("fixture transport failure");

          return empty;
        }),
        composer: { scope: { kind: "thread", threadId: "thread-one" } },
        realtimeConnectionState: "connecting",
      },
    );

    await act(async () => {});
    expect(screen.queryByRole("button")).toBeNull();
    failing = true;
    fireEvent.focus(window);
    const button = await screen.findByRole("button", { name: "Dev servers, status unknown" });
    expect(button.textContent).toBe("?");
    expect(button.hasAttribute("disabled")).toBe(false);
  });

  it("binds popup controls to its composer and explains an empty server list", async () => {
    let shelf: DevServerShelf = { active: [server("live", "online")], recent: null };
    const read = vi.fn(() => shelf);

    const slot = renderSlot(
      { component: DevServersPopup },
      {},
      {
        rpc: handlers(read),
        composer: { scope: { kind: "thread", threadId: "thread-two" } },
        realtimeConnectionState: "connecting",
      },
    );

    await screen.findByRole("link", { name: /Open/u });
    expect(slot.inspection.rpcCalls.find((call) => call.method === "servers.read")?.input).toEqual({
      threadId: "thread-two",
    });
    shelf = empty;
    fireEvent.focus(window);
    await screen.findByText("This chat hasn't started a dev server yet.");
    expect(screen.queryByRole("link")).toBeNull();
  });
});
