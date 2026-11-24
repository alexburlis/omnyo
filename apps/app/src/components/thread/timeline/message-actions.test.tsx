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
import { POINTER_COARSE_QUERY } from "@omnyo/shared-ui/hooks/use-pointer-coarse";
import {
  buildMessageActions,
  isMessageLongPressTarget,
  MessageTouchActions,
} from "./message-actions";

const LONG_PRESS_MS = 700;

const TIMESTAMP = Date.UTC(2026, 10, 20, 15, 42);

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

function mockPointer({ coarse }: { coarse: boolean }) {
  vi.spyOn(window, "matchMedia").mockImplementation((query) => ({
    matches: coarse && query === POINTER_COARSE_QUERY,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  }));
}

function renderMessage({
  onPluginSelect = vi.fn(),
}: { onPluginSelect?: () => void } = {}) {
  render(
    <MessageTouchActions
      actions={buildMessageActions({
        messageText: "Found a real bug.",
        onCopyLink: vi.fn(),
        onAddToChat: vi.fn(),
        onFork: vi.fn(),
        pluginActions: [
          {
            key: "side-chat/reply/1",
            pluginId: null,
            icon: "SideChat",
            label: "Reply in side chat",
            onSelect: onPluginSelect,
          },
        ],
      })}
      timestamp={TIMESTAMP}
      canSelectText
    >
      <div data-testid="column">
        <div data-sidebar-swipe-selectable data-testid="prose">
          <p>Found a real bug.</p>
          <a href="#docs">docs</a>
          <button type="button">Show more</button>
          <pre>pnpm test</pre>
          <span data-no-message-long-press="">widget</span>
        </div>
      </div>
    </MessageTouchActions>,
  );

  return { column: screen.getByTestId("column") };
}

function longPress(target: Element) {
  fireEvent.pointerDown(target, {
    pointerId: 1,
    pointerType: "touch",
    isPrimary: true,
    clientX: 20,
    clientY: 20,
  });
  act(() => vi.advanceTimersByTime(LONG_PRESS_MS));
  act(() => vi.advanceTimersByTime(500));
  fireEvent.pointerUp(target, { pointerId: 1, pointerType: "touch" });
}

describe("MessageTouchActions", () => {
  it("opens one sheet with every action, plugin actions included, on a long press", () => {
    vi.useFakeTimers();
    mockPointer({ coarse: true });
    vi.spyOn(document, "elementFromPoint").mockImplementation(() =>
      screen.getByText("Found a real bug."),
    );
    const onPluginSelect = vi.fn();
    const { column } = renderMessage({ onPluginSelect });

    expect(column.className).toContain("select-none");
    longPress(screen.getByText("Found a real bug."));

    const sheet = screen.getByRole("dialog", { name: "Message" });
    expect(sheet.textContent).toContain(
      `Sent ${new Date(TIMESTAMP).toLocaleString(undefined, {
        dateStyle: "medium",
        timeStyle: "short",
      })}`,
    );
    expect(
      within(sheet)
        .getAllByRole("menuitem")
        .map((item) => item.textContent),
    ).toEqual([
      "Copy message",
      "Select text",
      "Copy link",
      "Add to chat",
      "Fork into new thread",
      "Reply in side chat",
    ]);

    act(() => vi.advanceTimersByTime(2000));

    const item = within(sheet).getByRole("menuitem", {
      name: "Reply in side chat",
    });

    fireEvent.pointerDown(item, { pointerType: "touch" });
    fireEvent.click(item);
    expect(onPluginSelect).toHaveBeenCalledOnce();
  });

  it("leaves links, buttons, code blocks and opted-out content to their own gestures", () => {
    vi.useFakeTimers();
    mockPointer({ coarse: true });
    renderMessage();

    for (const target of [
      screen.getByRole("link", { name: "docs" }),
      screen.getByRole("button", { name: "Show more" }),
      screen.getByText("widget"),
    ]) {
      longPress(target);

      const contextMenu = new MouseEvent("contextmenu", {
        bubbles: true,
        cancelable: true,
      });

      fireEvent(target, contextMenu);
      expect(contextMenu.defaultPrevented).toBe(false);
    }

    expect(screen.queryByRole("dialog", { name: "Message" })).toBeNull();
  });

  it("opens the sheet from a long press on code text", () => {
    vi.useFakeTimers();
    mockPointer({ coarse: true });
    renderMessage();

    longPress(screen.getByText("pnpm test"));

    expect(screen.getByRole("dialog", { name: "Message" })).toBeTruthy();
  });

  it("keeps the native link callout on links inside the message", () => {
    mockPointer({ coarse: true });
    const { column } = renderMessage();

    expect(column.className).toContain(
      "[&_:where(a,[role=link])]:[-webkit-touch-callout:default]",
    );
  });

  it("adds nothing on a fine pointer, so a right-click keeps the native menu", () => {
    mockPointer({ coarse: false });
    const { column } = renderMessage();

    const contextMenu = new MouseEvent("contextmenu", {
      bubbles: true,
      cancelable: true,
    });

    fireEvent(screen.getByText("Found a real bug."), contextMenu);

    expect(contextMenu.defaultPrevented).toBe(false);
    expect(screen.queryByRole("dialog", { name: "Message" })).toBeNull();
    expect(column.className).not.toContain("select-none");
    expect(
      screen.queryByRole("button", { name: "Message actions" }),
    ).toBeNull();
  });

  it("opens the same sheet from a screen-reader button", async () => {
    mockPointer({ coarse: true });
    renderMessage();

    fireEvent.click(screen.getByRole("button", { name: "Message actions" }));

    expect(
      await within(screen.getByRole("dialog", { name: "Message" })).findByRole(
        "menuitem",
        { name: "Copy message" },
      ),
    ).toBeTruthy();
  });

  it("makes one message selectable from Select text until the selection is dismissed", async () => {
    mockPointer({ coarse: true });
    const { column } = renderMessage();

    fireEvent.click(screen.getByRole("button", { name: "Message actions" }));
    fireEvent.click(
      await screen.findByRole("menuitem", { name: "Select text" }),
    );

    const selection = window.getSelection();
    expect(column.className).not.toContain("select-none");
    expect(selection?.toString()).toContain("Found a real bug.");
    expect(
      selection?.getRangeAt(0).intersectsNode(screen.getByTestId("prose")),
    ).toBe(true);

    act(() => {
      selection?.removeAllRanges();
      document.dispatchEvent(new Event("selectionchange"));
    });

    expect(column.className).toContain("select-none");
  });
});

describe("isMessageLongPressTarget", () => {
  it("accepts prose and rejects interactive or opted-out content", () => {
    const root = document.createElement("div");
    root.innerHTML =
      '<p><strong id="prose">text</strong></p><a href="#x"><span id="link">x</span></a><img id="image" alt="" /><div data-no-message-long-press><span id="opted-out">x</span></div>';

    expect(isMessageLongPressTarget(root.querySelector("#prose")!)).toBe(true);
    expect(isMessageLongPressTarget(root.querySelector("#link")!)).toBe(false);
    expect(isMessageLongPressTarget(root.querySelector("#image")!)).toBe(false);
    expect(isMessageLongPressTarget(root.querySelector("#opted-out")!)).toBe(
      false,
    );
  });
});
