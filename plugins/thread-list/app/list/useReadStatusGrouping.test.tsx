// @vitest-environment jsdom

import { renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { makeSidebarThread } from "../model/fixtures.js";
import { createThreadUnreadPredicate } from "../model/read-status-grouping.js";
import type { SidebarThread } from "../model/sidebar-thread.js";
import { useHeldReadStatus } from "./useReadStatusGrouping.js";

function useHeldUnreadPredicate(
  threads: SidebarThread[],
  selectedThreadId: string | undefined,
) {
  return createThreadUnreadPredicate(
    useHeldReadStatus(threads, selectedThreadId),
  );
}

const unread = (id: string) => makeSidebarThread({ id, latestAttentionAt: 5 });

const read = (id: string) =>
  makeSidebarThread({ id, latestAttentionAt: 5, lastReadAt: 10 });

describe("useHeldReadStatus", () => {
  it("keeps the open thread unread until another thread opens", () => {
    const { result, rerender } = renderHook(
      ({ threads, selectedThreadId }) =>
        useHeldUnreadPredicate(threads, selectedThreadId),
      {
        initialProps: {
          threads: [unread("opened"), read("other")],
          selectedThreadId: "opened" as string | undefined,
        },
      },
    );

    rerender({
      threads: [read("opened"), read("other")],
      selectedThreadId: "opened",
    });
    expect(result.current(read("opened"))).toBe(true);

    rerender({
      threads: [read("opened"), read("other")],
      selectedThreadId: "other",
    });
    expect(result.current(read("opened"))).toBe(false);
  });

  it("moves the open thread as soon as it is marked unread", () => {
    const { result, rerender } = renderHook(
      ({ threads }) => useHeldUnreadPredicate(threads, "marked-unread"),
      { initialProps: { threads: [read("marked-unread")] } },
    );

    rerender({ threads: [unread("marked-unread")] });
    expect(result.current(unread("marked-unread"))).toBe(true);
  });

  it("moves the open thread as soon as it is marked read again", () => {
    const { result, rerender } = renderHook(
      ({ threads }) => useHeldUnreadPredicate(threads, "marked-read"),
      { initialProps: { threads: [unread("marked-read")] } },
    );

    rerender({ threads: [read("marked-read")] });
    rerender({ threads: [unread("marked-read")] });
    rerender({ threads: [read("marked-read")] });
    expect(result.current(read("marked-read"))).toBe(false);
  });

  it("keeps the open thread in place when new activity is read on arrival", () => {
    const attended = (lastReadAt?: number) =>
      makeSidebarThread({ id: "attended", latestAttentionAt: 20, lastReadAt });

    const { result, rerender } = renderHook(
      ({ threads }) => useHeldUnreadPredicate(threads, "attended"),
      { initialProps: { threads: [read("attended")] } },
    );

    rerender({ threads: [attended()] });
    expect(result.current(attended())).toBe(false);

    rerender({ threads: [attended(30)] });
    expect(result.current(attended(30))).toBe(false);
  });

  it("keeps the held status when the sidebar remounts", () => {
    const first = renderHook(() =>
      useHeldUnreadPredicate([unread("remounted")], "remounted"),
    );

    first.unmount();

    const second = renderHook(() =>
      useHeldUnreadPredicate([read("remounted")], "remounted"),
    );

    expect(second.result.current(read("remounted"))).toBe(true);
  });
});
