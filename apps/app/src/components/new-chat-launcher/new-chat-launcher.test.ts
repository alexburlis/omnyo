import { describe, expect, it } from "vitest";
import { splitPane } from "@/lib/split-layout";
import {
  createSinglePaneLayout,
  focusedPaneRoute,
} from "@/views/thread-detail/splitThreadNavigation";
import { getRootComposeRoutePath } from "@/lib/route-paths";
import {
  closeNewChatLauncher,
  openNewChatLauncher,
  resolveNewChatEntry,
  type NewChatEntry,
  type NewChatLauncherState,
} from "./new-chat-launcher";

const CLOSED: NewChatLauncherState = { open: false, focusRequest: 3 };

const THREAD_PATH = "/projects/proj_omnyo/threads/thr_abc";

describe("resolveNewChatEntry", () => {
  it.each<{
    name: string;
    launcher: NewChatLauncherState;
    otherModalOpen: boolean;
    compact: boolean;
    pathname: string;
    entry: NewChatEntry["kind"];
  }>([
    {
      name: "focuses an open launcher",
      launcher: { open: true, focusRequest: 3 },
      otherModalOpen: true,
      compact: false,
      pathname: THREAD_PATH,
      entry: "focus-launcher",
    },
    {
      name: "leaves another dialog alone",
      launcher: CLOSED,
      otherModalOpen: true,
      compact: false,
      pathname: THREAD_PATH,
      entry: "ignore",
    },
    {
      name: "shows the page in a compact window",
      launcher: CLOSED,
      otherModalOpen: false,
      compact: true,
      pathname: THREAD_PATH,
      entry: "show-page",
    },
    {
      name: "shows the page in a compact window while the sidebar drawer closes",
      launcher: CLOSED,
      otherModalOpen: true,
      compact: true,
      pathname: THREAD_PATH,
      entry: "show-page",
    },
    {
      name: "shows the page in a compact window over a launcher left open",
      launcher: { open: true, focusRequest: 3 },
      otherModalOpen: false,
      compact: true,
      pathname: THREAD_PATH,
      entry: "show-page",
    },
    {
      name: "shows the page when New chat is already on screen",
      launcher: CLOSED,
      otherModalOpen: false,
      compact: false,
      pathname: getRootComposeRoutePath(),
      entry: "show-page",
    },
    {
      name: "opens the launcher over a chat",
      launcher: CLOSED,
      otherModalOpen: false,
      compact: false,
      pathname: THREAD_PATH,
      entry: "open-launcher",
    },
  ])("$name", ({ launcher, otherModalOpen, compact, pathname, entry }) => {
    expect(
      resolveNewChatEntry({
        launcher,
        otherModalOpen,
        compact,
        pathname,
        layout: null,
      }).kind,
    ).toBe(entry);
  });

  it("shows the page when another pane already holds New chat", () => {
    const layout = splitPane(
      createSinglePaneLayout({ projectId: "proj_omnyo", threadId: "thr_abc" }),
      "pane-1",
      "right",
      { kind: "new-thread" },
    );

    expect(
      resolveNewChatEntry({
        launcher: CLOSED,
        otherModalOpen: false,
        compact: false,
        pathname: focusedPaneRoute(layout) ?? "",
        layout,
      }).kind,
    ).toBe("show-page");
  });

  it("opens the launcher over a page outside the panes even when a hidden pane holds New chat", () => {
    const layout = splitPane(
      createSinglePaneLayout({ projectId: "proj_omnyo", threadId: "thr_abc" }),
      "pane-1",
      "right",
      { kind: "new-thread" },
    );

    expect(
      resolveNewChatEntry({
        launcher: CLOSED,
        otherModalOpen: false,
        compact: false,
        pathname: "/settings",
        layout,
      }).kind,
    ).toBe("open-launcher");
  });
});

describe("launcher state", () => {
  it("bumps the focus request on every open so a repeat ⌘N refocuses", () => {
    const opened = openNewChatLauncher(CLOSED);

    expect(opened).toEqual({ open: true, focusRequest: 4 });
    expect(openNewChatLauncher(opened)).toEqual({
      open: true,
      focusRequest: 5,
    });
    expect(closeNewChatLauncher(opened)).toEqual({
      open: false,
      focusRequest: 4,
    });
  });
});
