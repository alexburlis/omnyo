// @vitest-environment jsdom

import { act, cleanup, renderHook } from "@testing-library/react";
import { createStore, Provider } from "jotai";
import type { ReactNode } from "react";
import { afterEach, expect, it, vi } from "vitest";
import type { ThreadOpenFile } from "@omnyo/server-contract";
import {
  PREVIEW_SECONDARY_PANEL_WIDTH_PERCENT,
  secondaryPanelWidthPercentAtom,
} from "./threadSecondaryPanelAtoms";
import { useThreadOpenFileSignal } from "./useThreadOpenFileSignal";

const signal = vi.hoisted(() => ({
  pending: new Map<string, ThreadOpenFile>(),
  listeners: new Set<(open: { threadId: string }) => void>(),
}));

vi.mock("@/lib/ws", () => ({
  wsManager: {
    consumePendingOpenFile: (threadId: string) => {
      const file = signal.pending.get(threadId) ?? null;
      signal.pending.delete(threadId);

      return file;
    },
    onThreadOpen: (listener: (open: { threadId: string }) => void) => {
      signal.listeners.add(listener);

      return () => signal.listeners.delete(listener);
    },
  },
}));

afterEach(() => {
  cleanup();
  signal.pending.clear();
  signal.listeners.clear();
});

function open(path: string) {
  act(() => {
    signal.pending.set("thr_a", {
      source: "thread-storage",
      path,
      lineNumber: null,
    });

    for (const listener of signal.listeners) listener({ threadId: "thr_a" });
  });
}

it("widens the panel for an opened HTML file but not for other files", () => {
  const store = createStore();
  store.set(secondaryPanelWidthPercentAtom, 35);
  const openTab = vi.fn();

  const wrapper = ({ children }: { children: ReactNode }) => (
    <Provider store={store}>{children}</Provider>
  );

  renderHook(
    () =>
      useThreadOpenFileSignal({
        threadId: "thr_a",
        environmentId: "env_a",
        openTab,
      }),
    { wrapper },
  );

  open("notes.md");
  expect(openTab).toHaveBeenCalledTimes(1);
  expect(store.get(secondaryPanelWidthPercentAtom)).toBe(35);
  open("prototype/Index.HTML");
  expect(openTab).toHaveBeenLastCalledWith({
    kind: "thread-storage-file-preview",
    tab: { lineRange: null, path: "prototype/Index.HTML" },
  });
  expect(store.get(secondaryPanelWidthPercentAtom)).toBe(
    PREVIEW_SECONDARY_PANEL_WIDTH_PERCENT,
  );
});
