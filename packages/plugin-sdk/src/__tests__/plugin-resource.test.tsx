// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { QueryClient } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import { usePluginResourceQuery } from "../internal/plugin-resource.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;

  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });

  return { promise, resolve, reject };
}

const clients: QueryClient[] = [];

function client() {
  const value = new QueryClient();
  clients.push(value);

  return value;
}

afterEach(() => {
  cleanup();

  for (const value of clients.splice(0)) value.clear();
});

describe("plugin resources", () => {
  it("rejects pending results after the host removes access-scoped queries", async () => {
    const cache = client();
    const old = deferred<string>();
    const next = deferred<string>();

    const load = vi
      .fn<() => Promise<string>>()
      .mockImplementationOnce(() => old.promise)
      .mockImplementation(() => next.promise);

    const useResource = () =>
      usePluginResourceQuery({ key: ["page"], load }, ["plugin"], cache);

    const first = renderHook(useResource);
    act(() => cache.removeQueries({ queryKey: ["plugin-resource"] }));
    first.unmount();
    const second = renderHook(useResource);
    expect(second.result.current.data).toBeUndefined();
    await act(async () => {
      next.resolve("new session");
    });
    await waitFor(() => expect(second.result.current.data).toBe("new session"));
    await act(async () => {
      old.resolve("old session");
    });
    expect(second.result.current.data).toBe("new session");
    expect(cache.getQueryCache().getAll()).toHaveLength(1);
  });

  it("discards a late first read invalidated while in flight", async () => {
    const cache = client();
    const old = deferred<string>();
    const next = deferred<string>();

    const load = vi
      .fn<() => Promise<string>>()
      .mockImplementationOnce(() => old.promise)
      .mockImplementation(() => next.promise);

    const view = renderHook(() =>
      usePluginResourceQuery({ key: ["page"], load }, ["plugin"], cache),
    );

    act(() => view.result.current.invalidate());
    await waitFor(() => expect(load).toHaveBeenCalledTimes(2));
    await act(async () => {
      next.resolve("current");
    });
    await waitFor(() => expect(view.result.current.data).toBe("current"));
    await act(async () => {
      old.resolve("obsolete");
    });
    expect(view.result.current.data).toBe("current");
  });

  it("evicts inactive scopes after five minutes", async () => {
    const cache = client();

    const view = renderHook(() =>
      usePluginResourceQuery(
        { key: ["page"], load: async () => "ready" },
        ["plugin"],
        cache,
      ),
    );

    await waitFor(() => expect(view.result.current.data).toBe("ready"));
    vi.useFakeTimers();

    try {
      view.unmount();
      await vi.advanceTimersByTimeAsync(5 * 60 * 1000);
      expect(cache.getQueryCache().getAll()).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("revalidates an invalidated inactive scope on return while retaining data", async () => {
    const cache = client();
    const next = deferred<string>();

    const load = vi
      .fn<() => Promise<string>>()
      .mockResolvedValueOnce("old")
      .mockImplementation(() => next.promise);

    const useResource = () =>
      usePluginResourceQuery({ key: ["page"], load }, ["plugin"], cache);

    const first = renderHook(useResource);
    await waitFor(() => expect(first.result.current.data).toBe("old"));
    first.unmount();
    await cache.invalidateQueries({ queryKey: ["plugin-resource"] });
    expect(load).toHaveBeenCalledTimes(1);
    const again = renderHook(useResource);
    expect(again.result.current.data).toBe("old");
    await waitFor(() => expect(load).toHaveBeenCalledTimes(2));
    await act(async () => next.resolve("new"));
    await waitFor(() => expect(again.result.current.data).toBe("new"));
  });

  it("shares pending reads and immediately restores successful data after remount", async () => {
    const cache = client();
    const request = deferred<string>();
    const load = vi.fn(() => request.promise);

    const useResource = () =>
      usePluginResourceQuery({ key: ["page"], load }, ["plugin", "1"], cache);

    const first = renderHook(useResource);
    const second = renderHook(useResource);
    expect(load).toHaveBeenCalledTimes(1);
    await act(async () => request.resolve("ready"));
    await waitFor(() => expect(first.result.current.data).toBe("ready"));
    first.unmount();
    second.unmount();
    const again = renderHook(useResource);
    expect(again.result.current.status).toBe("success");
    expect(again.result.current.data).toBe("ready");
    expect(load).toHaveBeenCalledTimes(1);
  });

  it("keeps data during refresh and shares repeated refreshes", async () => {
    const cache = client();
    const request = deferred<string>();

    const load = vi
      .fn<() => Promise<string>>()
      .mockResolvedValueOnce("old")
      .mockImplementation(() => request.promise);

    const view = renderHook(() =>
      usePluginResourceQuery({ key: ["page"], load }, ["plugin"], cache),
    );

    await waitFor(() => expect(view.result.current.data).toBe("old"));
    let first!: Promise<string | undefined>;
    let second!: Promise<string | undefined>;
    act(() => {
      first = view.result.current.refresh();
      second = view.result.current.refresh();
    });
    await waitFor(() => expect(view.result.current.isRefreshing).toBe(true));
    expect(view.result.current.data).toBe("old");
    expect(load).toHaveBeenCalledTimes(2);
    await act(async () => {
      request.resolve("new");
      await Promise.all([first, second]);
    });
    await waitFor(() => expect(view.result.current.data).toBe("new"));
  });

  it("retains good data after a failed refresh and permits retry", async () => {
    const cache = client();
    const failure = new Error("read failed");

    const load = vi
      .fn<() => Promise<string>>()
      .mockResolvedValueOnce("old")
      .mockRejectedValueOnce(failure)
      .mockResolvedValueOnce("recovered");

    const view = renderHook(() =>
      usePluginResourceQuery({ key: ["page"], load }, ["plugin"], cache),
    );

    await waitFor(() => expect(view.result.current.data).toBe("old"));
    await act(async () => {
      await expect(view.result.current.refresh()).rejects.toBe(failure);
    });
    await waitFor(() => expect(view.result.current.status).toBe("error"));
    expect(view.result.current.data).toBe("old");
    await act(async () => {
      await view.result.current.refresh();
    });
    await waitFor(() => expect(view.result.current.data).toBe("recovered"));
  });

  it("isolates route races, generations and clients without previous-scope placeholders", async () => {
    const cache = client();
    const old = deferred<string>();

    const view = renderHook(
      ({ key, generation, queryClient }) =>
        usePluginResourceQuery(
          {
            key: [key],
            load: () => (key === "old" ? old.promise : Promise.resolve(key)),
          },
          ["plugin", generation],
          queryClient,
        ),
      { initialProps: { key: "old", generation: "1", queryClient: cache } },
    );

    view.rerender({ key: "new", generation: "1", queryClient: cache });
    expect(view.result.current.data).toBeUndefined();
    await waitFor(() => expect(view.result.current.data).toBe("new"));
    await act(async () => old.resolve("late old"));
    expect(view.result.current.data).toBe("new");
    view.rerender({ key: "new", generation: "2", queryClient: cache });
    expect(view.result.current.data).toBeUndefined();
    await waitFor(() => expect(view.result.current.data).toBe("new"));

    const isolated = renderHook(() =>
      usePluginResourceQuery(
        { key: ["new"], load: () => old.promise },
        ["plugin", "2"],
        client(),
      ),
    );

    expect(isolated.result.current.data).toBeUndefined();
  });

  it("invalidates an active scope without clearing its successful data", async () => {
    const cache = client();
    const next = deferred<string>();

    const load = vi
      .fn<() => Promise<string>>()
      .mockResolvedValueOnce("old")
      .mockImplementation(() => next.promise);

    const view = renderHook(() =>
      usePluginResourceQuery({ key: ["page"], load }, ["plugin"], cache),
    );

    await waitFor(() => expect(view.result.current.data).toBe("old"));

    act(() => view.result.current.invalidate());
    await waitFor(() => expect(view.result.current.isRefreshing).toBe(true));
    expect(view.result.current.data).toBe("old");
    await act(async () => next.resolve("new"));
    await waitFor(() => expect(view.result.current.data).toBe("new"));
  });

  it("does not run disabled resources and runs their loader when enabled", async () => {
    const cache = client();
    const load = vi.fn(async () => "ready");

    const view = renderHook(
      ({ enabled }) =>
        usePluginResourceQuery(
          { key: ["page"], load, enabled },
          ["plugin"],
          cache,
        ),
      { initialProps: { enabled: false } },
    );

    expect(view.result.current.status).toBe("idle");
    await view.result.current.refresh();
    expect(load).not.toHaveBeenCalled();
    view.rerender({ enabled: true });

    await waitFor(() => expect(view.result.current.data).toBe("ready"));
  });
});
