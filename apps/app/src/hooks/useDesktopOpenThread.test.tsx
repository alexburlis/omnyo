// @vitest-environment jsdom

import { cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useDesktopOpenThread } from "./useDesktopOpenThread";

const mocks = vi.hoisted(() => ({
  getThread: vi.fn(),
}));

vi.mock("@/lib/sdk", () => ({
  sdk: { threads: { get: mocks.getThread } },
}));

afterEach(() => {
  cleanup();
  mocks.getThread.mockReset();
  delete window.omnyoDesktop;
});

function setup(threads: { id: string; projectId: string }[]) {
  const listener: { current: (threadId: string) => void } = {
    current: () => undefined,
  };

  const unsubscribe = vi.fn();
  window.omnyoDesktop = {
    onOpenThread: vi.fn((callback: (threadId: string) => void) => {
      listener.current = callback;

      return unsubscribe;
    }),
  } as unknown as Window["omnyoDesktop"];
  const openThread = vi.fn();
  const navigate = vi.fn();

  const view = renderHook(() =>
    useDesktopOpenThread({ threads, openThread, navigate }),
  );

  return {
    open: (threadId: string) => listener.current(threadId),
    openThread,
    navigate,
    unsubscribe,
    view,
  };
}

describe("useDesktopOpenThread", () => {
  it("opens a listed chat in its project without fetching it", () => {
    const { open, openThread, navigate } = setup([
      { id: "thr_listed", projectId: "proj_one" },
    ]);

    open("thr_listed");

    expect(openThread).toHaveBeenCalledExactlyOnceWith(
      { projectId: "proj_one", threadId: "thr_listed" },
      "replace",
    );
    expect(mocks.getThread).not.toHaveBeenCalled();
    expect(navigate).not.toHaveBeenCalled();
  });

  it("fetches an unlisted chat's project before opening it", async () => {
    mocks.getThread.mockResolvedValue({ projectId: "proj_two" });
    const { open, openThread, navigate } = setup([]);
    open("thr_unlisted");

    await waitFor(() =>
      expect(openThread).toHaveBeenCalledExactlyOnceWith(
        { projectId: "proj_two", threadId: "thr_unlisted" },
        "replace",
      ),
    );
    expect(mocks.getThread).toHaveBeenCalledExactlyOnceWith({
      threadId: "thr_unlisted",
    });
    expect(navigate).not.toHaveBeenCalled();
  });

  it("falls back to the chat route when the chat cannot be fetched", async () => {
    mocks.getThread.mockRejectedValue(new Error("not found"));
    const { open, openThread, navigate } = setup([]);
    open("thr/missing");

    await waitFor(() =>
      expect(navigate).toHaveBeenCalledExactlyOnceWith(
        "/threads/thr%2Fmissing",
      ),
    );
    expect(openThread).not.toHaveBeenCalled();
  });

  it("stops listening when unmounted", () => {
    const { unsubscribe, view } = setup([]);
    view.unmount();

    expect(unsubscribe).toHaveBeenCalledOnce();
  });
});
