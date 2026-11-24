// @vitest-environment jsdom
import { cleanup, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { PluginSidebarThread } from "@omnyo/plugin-sdk/app";
import { makeThreadResponse } from "@omnyo/plugin-sdk/testing";
import { loadPluginApp, renderSlot } from "@omnyo/plugin-sdk/testing/app";

const app = await loadPluginApp(() => import("../../app.js"));

beforeEach(() => {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) =>
    window.setTimeout(() => callback(performance.now()), 0),
  );
  vi.stubGlobal("cancelAnimationFrame", (id: number) =>
    window.clearTimeout(id),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function thread(
  id: string,
  indicator: PluginSidebarThread["indicator"],
): PluginSidebarThread {
  return {
    ...makeThreadResponse({ id }),
    displayTitle: id,
    experimental_subtitle: null,
    runtimeStatus: "idle",
    queuedWork: "none",
    hasPendingInteraction: false,
    activity: {
      workflows: 0,
      backgroundAgents: 0,
      backgroundCommands: 0,
      planMode: 0,
      goals: 0,
    },
    indicator,
    indicatorLabel: null,
    isUnread: true,
    isPinned: false,
    pinSortKey: null,
    isArchived: false,
    experimental_shelvedAt: null,
    experimental_shelfSortKey: null,
    href: `/threads/${id}`,
    isHidden: false,
    environment: null,
    host: null,
  };
}

it("keeps the legacy question renderer and one native sidebar overlay", () => {
  expect(app.pendingInteractions.map(({ id }) => id)).toEqual([
    "ask-user-question",
  ]);
  expect(app.appOverlays.map(({ id }) => id)).toEqual(["sidebar-highlight"]);
});

it("decorates native attention, respects settings, remounts with the sidebar and cleans up", async () => {
  const root = document.createElement("aside");
  root.dataset.sidebar = "content";
  root.innerHTML =
    '<a data-sidebar-thread-id="input"></a><a data-sidebar-thread-id="done"></a><a data-sidebar-thread-id="queued"></a>';
  document.body.append(root);
  const overlay = app.appOverlays[0];

  if (overlay === undefined) throw new Error("Missing sidebar overlay");

  const slot = renderSlot(
    overlay,
    {
      pluginId: "ask-user-question",
      generation: 1,
      signal: new AbortController().signal,
    },
    {
      settings: { unreadSuccess: false, intensity: "bold" },
      sidebarThreads: {
        threads: [
          thread("input", "waiting-for-input"),
          thread("done", "unread-success"),
          thread("queued", "queued-waiting"),
        ],
      },
      sdk: {
        experimental_attention: {
          snapshot: async () => ({ questions: [], callbacks: [] }),
        },
        subscribe: () => () => {},
      },
    },
  );

  try {
    await waitFor(() =>
      expect(
        root
          .querySelector('[data-sidebar-thread-id="input"]')
          ?.getAttribute("data-needs-you"),
      ).toBe("needs-input"),
    );
    expect(
      root
        .querySelector('[data-sidebar-thread-id="done"]')
        ?.hasAttribute("data-needs-you"),
    ).toBe(false);
    expect(
      root
        .querySelector('[data-sidebar-thread-id="queued"]')
        ?.getAttribute("data-needs-you-queued"),
    ).toBe("waiting");
    expect(
      document.documentElement.getAttribute("data-needs-you-intensity"),
    ).toBe("bold");

    const rebuilt = root.cloneNode(true);

    if (!(rebuilt instanceof HTMLElement))
      throw new Error("Invalid sidebar fixture");
    rebuilt.querySelectorAll("a").forEach((anchor) => {
      anchor.removeAttribute("data-needs-you");
      anchor.removeAttribute("data-needs-you-queued");
    });
    root.replaceWith(rebuilt);
    await waitFor(() =>
      expect(
        rebuilt
          .querySelector('[data-sidebar-thread-id="input"]')
          ?.getAttribute("data-needs-you"),
      ).toBe("needs-input"),
    );
    slot.unmount();
    expect(
      rebuilt.querySelector("[data-needs-you], [data-needs-you-queued]"),
    ).toBeNull();
    expect(document.getElementById("needs-you-sidebar-highlight")).toBeNull();
    expect(
      document.documentElement.hasAttribute("data-needs-you-intensity"),
    ).toBe(false);
    rebuilt.remove();
  } finally {
    slot.unmount();
    root.remove();
  }
});
