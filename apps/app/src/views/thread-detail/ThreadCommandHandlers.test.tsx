// @vitest-environment jsdom

import { ActionHistoryProvider } from "@/components/layout/ActionHistoryProvider";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import type { Thread } from "@omnyo/domain";
import { makeThread as makeThreadFixture } from "@omnyo/test-helpers/domain-fixtures";
import { defaultAppSettings } from "@omnyo/domain";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AppCommandProvider } from "@/components/commands/AppCommandProvider";
import { PaneContext, type PaneContextValue } from "./PaneContext";
import { threadQueryKey } from "@/hooks/queries/query-keys";
import { CORE_THREAD_ACTIONS } from "@/lib/thread-actions/core-thread-actions";
import { toThreadActionTarget } from "@/lib/thread-actions/thread-action-target";
import {
  ThreadActionCollectors,
  resetThreadActionRegistryForTest,
} from "@/lib/thread-actions/thread-action-registry";
import { ThreadArchiveCommandHandler } from "./ThreadArchiveCommandHandler";
import { ThreadCopyLinkCommandHandler } from "./ThreadCopyLinkCommandHandler";
import { ThreadShelveCommandHandler } from "./ThreadShelveCommandHandler";

const mocks = vi.hoisted(() => ({
  requestArchive: vi.fn(),
  requestDelete: vi.fn(),
  requestShelve: vi.fn(),
  copyToClipboardWithToast: vi.fn(() => Promise.resolve(true)),
}));

const testState = vi.hoisted(() => {
  const keybinding = (
    command:
      | "thread.archive"
      | "thread.copyLink"
      | "thread.rename"
      | "thread.shelve",
    key: string,
  ) => ({
    command,
    desktopOnly: false,
    shortcut: {
      key,
      mod: true,
      meta: false,
      control: false,
      alt: false,
      shift: true,
    },
    when: { all: ["mainSurface" as const], none: ["modalOpen" as const] },
  });

  return {
    keybindings: [
      keybinding("thread.archive", "a"),
      keybinding("thread.rename", "r"),
      keybinding("thread.shelve", "f"),
      keybinding("thread.copyLink", "c"),
    ],
  };
});

vi.mock("@/lib/thread-actions/thread-actions-context", () => ({
  useThreadActions: () => mocks,
}));

vi.mock("@/lib/clipboard", () => ({
  copyToClipboardWithToast: mocks.copyToClipboardWithToast,
}));

vi.mock("@/hooks/queries/system-queries", () => ({
  useSystemConfig: () => ({
    data: {
      generalSettings: defaultAppSettings,
      keybindings: testState.keybindings,
    },
  }),
}));

vi.mock("@/lib/omnyo-desktop", () => ({
  getOmnyoDesktopInfo: () => null,
}));

function makeThread(id: string, title: string): Thread {
  return makeThreadFixture({
    createdAt: 1,
    id,
    lastReadAt: null,
    latestAttentionAt: 1,
    title,
    titleFallback: null,
    updatedAt: 1,
  });
}

const firstThread = makeThread("thr_first", "First pane title");

const secondThread = makeThread("thr_second", "Second pane title");

function paneContext(paneId: string, isFocused: boolean): PaneContextValue {
  return {
    beginPaneDrag: undefined,
    isBoundedPane: true,
    isFocused,
    isMaximized: false,
    isSplitPane: true,
    isTopRow: true,
    navigateInPane: vi.fn(),
    onMoveToSide: undefined,
    onRequestClose: vi.fn(),
    onToggleMaximize: vi.fn(),
    ownsWindowTopLeft: paneId === "pane-first",
    paneId,
    reservesWindowPanelToggle: false,
    secondaryPanelHost: null,
  };
}

function SplitHandlers({
  firstPaneThread = firstThread,
  focusedThreadId,
}: {
  firstPaneThread?: Thread;
  focusedThreadId: string | null;
}) {
  const queryClient = new QueryClient();

  for (const thread of [firstPaneThread, secondThread]) {
    queryClient.setQueryData(threadQueryKey(thread.id), thread);
  }

  return (
    <QueryClientProvider client={queryClient}>
      <ActionHistoryProvider>
        <MemoryRouter>
          <ThreadActionCollectors
            coreRegistrations={CORE_THREAD_ACTIONS}
            requestRename={() => {}}
          />
          <AppCommandProvider>
            <PaneContext.Provider
              value={paneContext(
                "pane-first",
                focusedThreadId === firstPaneThread.id,
              )}
            >
              <ThreadArchiveCommandHandler
                thread={toThreadActionTarget(firstPaneThread, null)}
              />
            </PaneContext.Provider>
            <PaneContext.Provider
              value={paneContext(
                "pane-second",
                focusedThreadId === secondThread.id,
              )}
            >
              <ThreadArchiveCommandHandler
                thread={toThreadActionTarget(secondThread, null)}
              />
            </PaneContext.Provider>
          </AppCommandProvider>
        </MemoryRouter>
      </ActionHistoryProvider>
    </QueryClientProvider>
  );
}

function pressShortcut(letter: "A" | "C" | "F" | "R"): boolean {
  return fireEvent.keyDown(window, {
    key: letter,
    code: `Key${letter}`,
    ctrlKey: true,
    shiftKey: true,
  });
}

function FocusedShelveHandler({
  thread,
  isFocused = true,
}: {
  thread: Thread;
  isFocused?: boolean;
}) {
  const queryClient = new QueryClient();
  queryClient.setQueryData(threadQueryKey(thread.id), thread);

  return (
    <QueryClientProvider client={queryClient}>
      <ActionHistoryProvider>
        <MemoryRouter>
          <ThreadActionCollectors
            coreRegistrations={CORE_THREAD_ACTIONS}
            requestRename={() => {}}
          />
          <AppCommandProvider>
            <PaneContext.Provider value={paneContext("pane-first", isFocused)}>
              <ThreadShelveCommandHandler
                thread={toThreadActionTarget(thread, null)}
              />
              <ThreadCopyLinkCommandHandler
                thread={toThreadActionTarget(thread, null)}
              />
            </PaneContext.Provider>
          </AppCommandProvider>
        </MemoryRouter>
      </ActionHistoryProvider>
    </QueryClientProvider>
  );
}

afterEach(() => {
  cleanup();
  resetThreadActionRegistryForTest();
  vi.clearAllMocks();
});

describe("thread archive command handler", () => {
  it("runs the archive action for the focused pane's thread as focus changes", async () => {
    const view = render(<SplitHandlers focusedThreadId={firstThread.id} />);

    pressShortcut("A");
    await waitFor(() =>
      expect(mocks.requestArchive.mock.calls).toEqual([[firstThread]]),
    );

    mocks.requestArchive.mockClear();
    view.rerender(<SplitHandlers focusedThreadId={secondThread.id} />);
    pressShortcut("A");
    await waitFor(() =>
      expect(mocks.requestArchive.mock.calls).toEqual([[secondThread]]),
    );
  });

  it("does nothing when no pane is focused", async () => {
    render(<SplitHandlers focusedThreadId={null} />);

    pressShortcut("A");
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(mocks.requestArchive).not.toHaveBeenCalled();
  });

  it("does nothing when the focused thread is archived", async () => {
    const archivedThread = { ...firstThread, archivedAt: 2 };
    render(
      <SplitHandlers
        firstPaneThread={archivedThread}
        focusedThreadId={archivedThread.id}
      />,
    );

    pressShortcut("A");
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(mocks.requestArchive).not.toHaveBeenCalled();
  });
});

describe("thread shelve command handler", () => {
  it("runs the shared shelve action for the focused top-level thread", async () => {
    render(<FocusedShelveHandler thread={firstThread} />);

    const unhandled = pressShortcut("F");
    await waitFor(() =>
      expect(mocks.requestShelve.mock.calls).toEqual([
        [expect.objectContaining({ id: firstThread.id })],
      ]),
    );
    expect(unhandled).toBe(false);
  });

  it("leaves the shortcut unhandled for a sub-chat", async () => {
    render(
      <FocusedShelveHandler
        thread={{ ...secondThread, parentThreadId: firstThread.id }}
      />,
    );

    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(pressShortcut("F")).toBe(true);
    expect(mocks.requestShelve).not.toHaveBeenCalled();
  });
});

describe("thread copy link command handler", () => {
  it("copies the focused thread's link with a confirmation toast", async () => {
    render(<FocusedShelveHandler thread={firstThread} />);

    const unhandled = pressShortcut("C");
    await waitFor(() =>
      expect(mocks.copyToClipboardWithToast.mock.calls).toEqual([
        [
          expect.stringMatching(/\/threads\/thr_first$/),
          {
            successMessage: "Thread link copied",
            errorMessage: "Failed to copy thread link",
          },
        ],
      ]),
    );
    expect(unhandled).toBe(false);
  });

  it("leaves the shortcut unhandled when the thread's pane is not focused", async () => {
    render(<FocusedShelveHandler thread={firstThread} isFocused={false} />);

    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(pressShortcut("C")).toBe(true);
    expect(mocks.copyToClipboardWithToast).not.toHaveBeenCalled();
  });
});
