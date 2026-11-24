import { describe, expect, it, vi } from "vitest";
import type { PluginThreadActionsInlineItem } from "@omnyo/plugin-sdk";
import {
  buildThreadHeaderMenuItems,
  THREAD_HEADER_ACTIONS_GROUP,
} from "./thread-header-menu-items";

const outline = vi.hoisted(() => ({ requestThreadOutline: vi.fn() }));

vi.mock("@/components/thread/toc/thread-outline-request", () => outline);

const WORKSPACE_ITEM: PluginThreadActionsInlineItem = {
  key: "workspace/finder",
  group: THREAD_HEADER_ACTIONS_GROUP,
  action: {
    icon: "FolderOpen",
    label: "Open workspace in Finder",
    run: vi.fn(),
  },
};

function build(
  overrides: Partial<Parameters<typeof buildThreadHeaderMenuItems>[0]> = {},
) {
  return buildThreadHeaderMenuItems({
    threadId: "thr_menu",
    isCompactViewport: true,
    executionHost: { name: "Mac Studio", connected: true },
    lineageSource: {
      parentThreadTitle: "Earlier chat",
      href: "/projects/proj/threads/thr_parent",
      relationship: "handoff",
    },
    lineageDestinations: [
      { href: "/projects/proj/threads/thr_next", title: "Next chat" },
    ],
    navigate: vi.fn(),
    responsiveItems: [WORKSPACE_ITEM],
    ...overrides,
  });
}

function rows(items: readonly PluginThreadActionsInlineItem[]) {
  return items.map(({ group, action }) => ({
    group,
    label: action.label,
    detail: action.detail,
    disabled: action.disabled,
  }));
}

describe("buildThreadHeaderMenuItems", () => {
  it("folds the machine, outline and lineage into the header group at phone width", () => {
    expect(rows(build())).toEqual([
      {
        group: THREAD_HEADER_ACTIONS_GROUP,
        label: "Runs on Mac Studio",
        detail: "Connected",
        disabled: true,
      },
      {
        group: THREAD_HEADER_ACTIONS_GROUP,
        label: "Jump to message…",
        detail: undefined,
        disabled: undefined,
      },
      {
        group: THREAD_HEADER_ACTIONS_GROUP,
        label: "Continued from",
        detail: "Earlier chat",
        disabled: undefined,
      },
      {
        group: THREAD_HEADER_ACTIONS_GROUP,
        label: "Continued in",
        detail: "Next chat",
        disabled: undefined,
      },
      {
        group: THREAD_HEADER_ACTIONS_GROUP,
        label: "Open workspace in Finder",
        detail: undefined,
        disabled: undefined,
      },
    ]);
  });

  it("offers only Jump to message beside the responsive items on wider layouts", () => {
    expect(
      build({ isCompactViewport: false, responsiveItems: [] }).map(
        ({ action }) => action.label,
      ),
    ).toEqual(["Jump to message…"]);
  });

  it("reports a disconnected machine and omits an unknown one", () => {
    expect(
      build({ executionHost: { name: "3090", connected: false } })[0]?.action
        .detail,
    ).toBe("Disconnected");
    expect(
      build({ executionHost: null }).some(
        ({ key }) => key === "thread/execution-host",
      ),
    ).toBe(false);
  });

  it("asks the visible outline of this thread to open", async () => {
    const jump = build().find(({ key }) => key === "thread/outline");
    await jump?.action.run({ requestRename: vi.fn() });

    expect(outline.requestThreadOutline).toHaveBeenCalledExactlyOnceWith(
      "thr_menu",
    );
  });

  it("navigates to the source and to a picked continuation", async () => {
    const navigate = vi.fn();

    const items = build({
      navigate,
      lineageDestinations: [
        { href: "/projects/proj/threads/thr_a", title: "Chat A" },
        { href: "/projects/proj/threads/thr_b", title: "Chat B" },
      ],
    });

    const source = items.find(({ key }) => key === "thread/continued-from");
    const continued = items.find(({ key }) => key === "thread/continued-in");
    await source?.action.run({ requestRename: vi.fn() });

    expect(continued?.action.detail).toBe("2 chats");
    expect(continued?.action.choices?.items.map(({ label }) => label)).toEqual([
      "Chat A",
      "Chat B",
    ]);
    await continued?.action.run({
      value: "/projects/proj/threads/thr_b",
      requestRename: vi.fn(),
    });

    expect(navigate.mock.calls).toEqual([
      ["/projects/proj/threads/thr_parent"],
      ["/projects/proj/threads/thr_b"],
    ]);
  });

  it("leaves a plain parent link out of the lineage items", () => {
    expect(
      build({
        lineageSource: {
          parentThreadTitle: "Parent",
          href: "/projects/proj/threads/thr_parent",
          relationship: "parent",
        },
        lineageDestinations: [],
      }).map(({ key }) => key),
    ).toEqual(["thread/execution-host", "thread/outline", "workspace/finder"]);
  });
});
