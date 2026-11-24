// @vitest-environment jsdom

import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  resetPluginLogoStoreForTest,
  setPluginLogoUrls,
} from "@/lib/plugin-logos";
import { COMPACT_VIEWPORT_QUERY } from "@omnyo/shared-ui/hooks/use-compact-viewport";
import { POINTER_COARSE_QUERY } from "@omnyo/shared-ui/hooks/use-pointer-coarse";
import {
  computeMessageActionRowLayout,
  findMessageActionTooltipCollisionBoundary,
  formatShortMessageTime,
  MessageActionBar,
} from "./MessageActionBar";
import { TimelineStepRailContext } from "./timeline-step-rail";
import { buildMessageActions } from "./message-actions";

const TIMESTAMP = Date.UTC(2026, 8, 30, 16, 5);

afterEach(() => {
  cleanup();
  resetPluginLogoStoreForTest();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function installControlledResizeObserver() {
  const observations: { callback: ResizeObserverCallback; node: Element }[] =
    [];

  class ControlledResizeObserver {
    readonly #callback: ResizeObserverCallback;
    constructor(callback: ResizeObserverCallback) {
      this.#callback = callback;
    }
    observe(node: Element) {
      observations.push({ callback: this.#callback, node });
    }
    unobserve() {}
    disconnect() {}
  }

  vi.stubGlobal("ResizeObserver", ControlledResizeObserver);

  return {
    reportWidth(width: number) {
      act(() => {
        for (const { callback, node } of observations) {
          callback(
            [
              {
                target: node,
                contentRect: { width, height: 20 },
              } as unknown as ResizeObserverEntry,
            ],
            undefined as unknown as ResizeObserver,
          );
        }
      });
    },
  };
}

function mockMobileCoarsePointer() {
  vi.spyOn(window, "matchMedia").mockImplementation((query) => ({
    matches: query === COMPACT_VIEWPORT_QUERY || query === POINTER_COARSE_QUERY,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  }));
}

function openDesktopMenu() {
  fireEvent.pointerDown(
    screen.getByRole("button", { name: "Message actions" }),
  );

  return screen.getByRole("menu");
}

describe("MessageActionBar", () => {
  it("shows the send time beside the actions without adding a row", () => {
    vi.useFakeTimers({ now: TIMESTAMP + 60_000, toFake: ["Date"] });

    try {
      const { container } = render(
        <MessageActionBar
          timestamp={TIMESTAMP}
          alignment="end"
          actions={buildMessageActions({ messageText: "Hi." })}
        />,
      );

      const time = container.querySelector("time[data-message-time]");
      const row = time?.parentElement?.parentElement;
      expect(time?.getAttribute("dateTime")).toBe(
        new Date(TIMESTAMP).toISOString(),
      );
      expect(time?.textContent).toBe("1m ago");
      expect(row?.lastElementChild).toBe(time?.parentElement);
      expect(row?.parentElement?.className).toContain("h-5");
    } finally {
      vi.useRealTimers();
    }
  });

  it("floats a step message's actions over its work line instead of adding a row", () => {
    const { container } = render(
      <TimelineStepRailContext.Provider
        value={{
          role: "head",
          line: "none",
          startsRun: true,
          hasWork: true,
          state: "idle",
        }}
      >
        <MessageActionBar
          timestamp={TIMESTAMP}
          showTimestamp={false}
          alignment="start"
          actions={buildMessageActions({ messageText: "Saved." })}
        />
      </TimelineStepRailContext.Provider>,
    );

    const slot = container.firstElementChild;
    expect(slot?.className).toContain("h-0");
    expect(slot?.className).not.toContain("h-5");
    expect(slot?.firstElementChild?.className).toContain("right-0");
    expect(slot?.firstElementChild?.className).not.toContain("left-0");
  });

  it("keeps a floating step message's time at the right edge, after its actions", () => {
    render(
      <TimelineStepRailContext.Provider
        value={{
          role: "head",
          line: "none",
          startsRun: true,
          hasWork: true,
          state: "idle",
        }}
      >
        <MessageActionBar
          timestamp={TIMESTAMP}
          alignment="start"
          actions={buildMessageActions({ messageText: "Saved." })}
        />
      </TimelineStepRailContext.Provider>,
    );

    const timeButton = screen.getByRole("button", { name: /^Sent / });
    expect(timeButton.parentElement?.lastElementChild).toBe(timeButton);
  });

  it("omits every timestamp while the message is unfinished", () => {
    const { container } = render(
      <MessageActionBar
        timestamp={TIMESTAMP}
        showTimestamp={false}
        alignment="start"
        actions={buildMessageActions({ messageText: "Working" })}
      />,
    );

    expect(container.querySelector("time")).toBeNull();
    expect(screen.queryByRole("button", { name: /^Sent / })).toBeNull();
  });

  it("uses the nearest thread window as the tooltip collision boundary", () => {
    const threadWindow = document.createElement("div");
    threadWindow.setAttribute("data-thread-window", "");
    const sidePanel = document.createElement("aside");
    const actionBar = document.createElement("div");
    threadWindow.append(actionBar);
    document.body.append(threadWindow, sidePanel);

    expect(findMessageActionTooltipCollisionBoundary(actionBar)).toBe(
      threadWindow,
    );
    expect(
      findMessageActionTooltipCollisionBoundary(sidePanel),
    ).toBeUndefined();
  });

  it("exposes message actions directly when the row has space", () => {
    const resizeObserver = installControlledResizeObserver();
    setPluginLogoUrls(
      new Map([
        [
          "demo",
          {
            displayName: "Demo",
            icon: "Check",
            compactIconUrl: "/demo.svg",
            logoUrl: null,
            logoDarkUrl: null,
            icons: new Map(),
          },
        ],
      ]),
    );
    const onPluginSelect = vi.fn();
    const onCopyLink = vi.fn();

    const { container } = render(
      <MessageActionBar
        timestamp={TIMESTAMP}
        alignment="start"
        actions={buildMessageActions({
          messageText: "An answer.",
          onEdit: vi.fn(),
          onCopyLink,
          onAddToChat: vi.fn(),
          onFork: vi.fn(),
          pluginActions: [
            {
              key: "demo/summarize/1",
              pluginId: "demo",
              icon: "Zap",
              label: "Summarize",
              onSelect: onPluginSelect,
            },
          ],
        })}
      />,
    );

    resizeObserver.reportWidth(320);

    expect(
      [...container.querySelectorAll<HTMLButtonElement>("button[aria-label]")]
        .map((button) => button.getAttribute("aria-label"))
        .filter(
          (label) => label !== "Message actions" && !label?.startsWith("Sent "),
        ),
    ).toEqual([
      "Copy message",
      "Edit message",
      "Copy link",
      "Add to chat",
      "Fork into new thread",
      "Summarize",
    ]);
    expect(
      screen
        .getByRole("button", { name: "Summarize" })
        .querySelector('[data-icon="Zap"]'),
    ).not.toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Summarize" }));
    expect(onPluginSelect).toHaveBeenCalledTimes(1);

    expect(
      screen.queryByRole("button", { name: "Message actions" }),
    ).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Copy link" }));
    expect(onCopyLink).toHaveBeenCalledTimes(1);
  });

  it("moves candidates that do not fit into the menu from the end", () => {
    const resizeObserver = installControlledResizeObserver();
    render(
      <MessageActionBar
        timestamp={TIMESTAMP}
        alignment="end"
        actions={buildMessageActions({
          messageText: "An answer.",
          onEdit: vi.fn(),
          onCopyLink: vi.fn(),
          onAddToChat: vi.fn(),
          onFork: vi.fn(),
          pluginActions: [
            {
              key: "demo/summarize/1",
              pluginId: null,
              icon: "Zap",
              label: "Summarize",
              onSelect: vi.fn(),
            },
            {
              key: "demo/translate/1",
              pluginId: null,
              icon: "Languages",
              label: "Translate",
              onSelect: vi.fn(),
            },
          ],
        })}
      />,
    );
    resizeObserver.reportWidth(72);

    expect(screen.getByRole("button", { name: "Copy message" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Edit message" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Summarize" })).toBeNull();

    expect(
      within(openDesktopMenu())
        .getAllByRole("menuitem")
        .map((item) => item.textContent),
    ).toEqual([
      "Copy link",
      "Add to chat",
      "Fork into new thread",
      "Summarize",
      "Translate",
    ]);
  });

  it("puts every candidate in the menu when none fit", () => {
    const resizeObserver = installControlledResizeObserver();
    render(
      <MessageActionBar
        timestamp={TIMESTAMP}
        alignment="end"
        actions={buildMessageActions({
          messageText: "An answer.",
          onEdit: vi.fn(),
          onAddToChat: vi.fn(),
          onFork: vi.fn(),
        })}
      />,
    );
    resizeObserver.reportWidth(30);

    expect(screen.queryByRole("button", { name: "Copy message" })).toBeNull();
    expect(
      within(openDesktopMenu())
        .getAllByRole("menuitem")
        .map((item) => item.textContent),
    ).toEqual([
      "Copy message",
      "Edit message",
      "Add to chat",
      "Fork into new thread",
    ]);
  });

  it("opens the exact sent time from the timestamp", () => {
    render(
      <MessageActionBar
        timestamp={TIMESTAMP}
        alignment="start"
        actions={buildMessageActions({ messageText: "An answer." })}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /^Sent / }));
    const dialog = screen.getByRole("dialog");
    expect(dialog.textContent).toContain(
      new Date(TIMESTAMP).toLocaleString(undefined, {
        dateStyle: "full",
        timeStyle: "long",
      }),
    );
  });

  it("renders no action buttons and no menu trigger on touch", () => {
    mockMobileCoarsePointer();
    const resizeObserver = installControlledResizeObserver();

    const { container } = render(
      <MessageActionBar
        timestamp={TIMESTAMP}
        alignment="start"
        actions={buildMessageActions({
          messageText: "An answer.",
          onEdit: vi.fn(),
          onCopyLink: vi.fn(),
          onAddToChat: vi.fn(),
          onFork: vi.fn(),
        })}
      />,
    );

    resizeObserver.reportWidth(60);

    expect(
      [...container.querySelectorAll("button")].map((button) =>
        button.getAttribute("aria-label"),
      ),
    ).toEqual([expect.stringMatching(/^Sent /)]);
    expect(container.firstElementChild?.className).toContain("h-5");
    expect(container.firstElementChild?.className).not.toContain(
      "pointer-coarse:h-7",
    );
  });

  it("reserves no slot on touch when only actions would show", () => {
    mockMobileCoarsePointer();

    const { container } = render(
      <TimelineStepRailContext.Provider
        value={{
          role: "head",
          line: "none",
          startsRun: true,
          hasWork: true,
          state: "idle",
        }}
      >
        <MessageActionBar
          timestamp={TIMESTAMP}
          showTimestamp={false}
          alignment="start"
          actions={buildMessageActions({
            messageText: "Checking the updater.",
            onCopyLink: vi.fn(),
            onFork: vi.fn(),
          })}
        />
      </TimelineStepRailContext.Provider>,
    );

    expect(container.innerHTML).toBe("");
  });

  it("keeps a hidden slot on touch while the timestamp is hidden", () => {
    mockMobileCoarsePointer();

    const { container } = render(
      <MessageActionBar
        timestamp={TIMESTAMP}
        showTimestamp={false}
        alignment="start"
        actions={buildMessageActions({ messageText: "Streaming." })}
      />,
    );

    const slot = container.firstElementChild;
    expect(slot?.className).toContain("h-5");
    expect(slot?.getAttribute("aria-hidden")).toBe("true");
    expect(slot?.childElementCount).toBe(0);
  });

  it("reveals desktop actions on hover or keyboard focus only", () => {
    render(
      <MessageActionBar
        timestamp={TIMESTAMP}
        alignment="start"
        actions={buildMessageActions({ messageText: "An answer." })}
      />,
    );

    const className = screen.getByRole("button", {
      name: "Copy message",
    }).className;

    expect(className).toContain("opacity-0");
    expect(className).toContain("group-hover/message:opacity-100");
    expect(className).toContain(
      "group-has-[:focus-visible]/message:opacity-100",
    );
    expect(className).not.toContain("group-focus-within/message");
    expect(className).not.toContain("hover:none");
  });

  it("passes message text and attachments from Add to chat", () => {
    const onAddToChat = vi.fn();

    const attachment = {
      type: "localFile" as const,
      path: "uploads/spec.md",
      name: "spec.md",
      sizeBytes: 0,
    };

    render(
      <MessageActionBar
        timestamp={TIMESTAMP}
        alignment="end"
        actions={buildMessageActions({
          messageText: "Quote this message.",
          addToChatAttachments: [attachment],
          onAddToChat,
        })}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Add to chat" }));
    expect(onAddToChat).toHaveBeenCalledWith("Quote this message.", [
      attachment,
    ]);
  });

  it("offers Add to chat for attachment-only messages", () => {
    const onAddToChat = vi.fn();

    const attachment = {
      type: "localImage" as const,
      path: "uploads/screenshot.png",
      name: "screenshot.png",
      sizeBytes: 0,
    };

    render(
      <MessageActionBar
        timestamp={TIMESTAMP}
        alignment="end"
        actions={buildMessageActions({
          messageText: "",
          addToChatAttachments: [attachment],
          onAddToChat,
        })}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Add to chat" }));
    expect(onAddToChat).toHaveBeenCalledWith("", [attachment]);
  });

  it("offers Copy for an image-only message", () => {
    render(
      <MessageActionBar
        timestamp={TIMESTAMP}
        alignment="end"
        actions={buildMessageActions({
          messageText: "",
          copyImageUrl: "/attachments/screenshot.png",
        })}
      />,
    );

    expect(screen.getByRole("button", { name: "Copy message" })).toBeTruthy();
  });

  it("marks the action row while the menu is open", () => {
    const resizeObserver = installControlledResizeObserver();
    render(
      <MessageActionBar
        timestamp={TIMESTAMP}
        alignment="end"
        actions={buildMessageActions({ messageText: "An answer." })}
      />,
    );
    resizeObserver.reportWidth(30);
    const trigger = screen.getByRole("button", { name: "Message actions" });
    const row = trigger.parentElement;

    expect(row?.hasAttribute("data-menu-open")).toBe(false);
    fireEvent.pointerDown(trigger);
    expect(row?.hasAttribute("data-menu-open")).toBe(true);
    fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" });
    expect(row?.hasAttribute("data-menu-open")).toBe(false);
  });
});

describe("computeMessageActionRowLayout", () => {
  const metrics = { actionWidth: 20 };

  it("renders every candidate inline before the slot is measured", () => {
    expect(
      computeMessageActionRowLayout({
        actionCount: 5,
        availableWidth: undefined,
        ...metrics,
      }),
    ).toEqual({ inlineCount: 5, overflowCount: 0 });
  });

  it("reserves space for the always-present menu trigger", () => {
    expect(
      computeMessageActionRowLayout({
        actionCount: 3,
        availableWidth: 100,
        ...metrics,
      }),
    ).toEqual({ inlineCount: 3, overflowCount: 0 });
    expect(
      computeMessageActionRowLayout({
        actionCount: 3,
        availableWidth: 99,
        ...metrics,
      }),
    ).toEqual({ inlineCount: 2, overflowCount: 1 });
  });

  it("moves candidates into overflow from the end", () => {
    expect(
      computeMessageActionRowLayout({
        actionCount: 3,
        availableWidth: 72,
        ...metrics,
      }),
    ).toEqual({ inlineCount: 2, overflowCount: 1 });
    expect(
      computeMessageActionRowLayout({
        actionCount: 3,
        availableWidth: 71,
        ...metrics,
      }),
    ).toEqual({ inlineCount: 1, overflowCount: 2 });
  });

  it("puts every candidate in the menu when none fit beside the trigger", () => {
    expect(
      computeMessageActionRowLayout({
        actionCount: 3,
        availableWidth: 30,
        ...metrics,
      }),
    ).toEqual({ inlineCount: 0, overflowCount: 3 });
  });

  it("returns an empty layout for zero candidates", () => {
    expect(
      computeMessageActionRowLayout({
        actionCount: 0,
        availableWidth: 400,
        ...metrics,
      }),
    ).toEqual({ inlineCount: 0, overflowCount: 0 });
  });
});

describe("formatShortMessageTime", () => {
  const now = new Date(2026, 9, 26, 15, 13);
  it.each([
    [0, "now"],
    [60_000, "1m ago"],
    [52 * 60_000, "52m ago"],
    [5 * 3_600_000, "5h ago"],
  ])("formats %d milliseconds ago as %s", (elapsed, expected) => {
    expect(formatShortMessageTime(now.getTime() - elapsed, now)).toBe(expected);
  });

  it("adds the clock after yesterday and older calendar dates", () => {
    const yesterday = new Date(2026, 9, 25, 13, 13);
    const older = new Date(2026, 9, 20, 13, 13);

    const clock = yesterday.toLocaleTimeString(undefined, {
      hour: "numeric",
      minute: "2-digit",
    });

    expect(formatShortMessageTime(yesterday.getTime(), now)).toBe(
      `Yesterday - ${clock}`,
    );
    expect(formatShortMessageTime(older.getTime(), now)).toBe(
      `${older.toLocaleDateString(undefined, { month: "short", day: "numeric" })} - ${clock}`,
    );
  });
});
