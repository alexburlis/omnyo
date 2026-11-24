// @vitest-environment jsdom

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ReactNode } from "react";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferredPromise } from "@omnyo/test-helpers";
import type { ThreadResponse } from "@omnyo/server-contract";
import { WindowTitleBarSlotsContext } from "@/components/layout/window-title-bar-slots";
import { CHROME_ROW_HEIGHT_CLASS } from "@/lib/omnyo-desktop";
import { createPendingChat } from "@/lib/pending-chat-creations";
import {
  startTypeAheadCapture,
  stopTypeAheadCapture,
  takeTypeAhead,
} from "@/lib/typed-ahead";
import { DefaultPaneContextProvider, PaneContext } from "./PaneContext";
import { PendingThreadChat } from "./PendingThreadChat";

const titleBar = vi.hoisted(() => ({ hostsRightPanelToggle: false }));

vi.mock("@/components/layout/WindowRightPanelToggle", () => ({
  useWindowTitleBarHostsRightPanelToggle: () => titleBar.hostsRightPanelToggle,
}));

const editor = vi.hoisted(() => ({ insertTypedText: vi.fn() }));

vi.mock("@/components/promptbox/NewThreadComposer", () => ({
  NewThreadComposer: ({
    children,
  }: {
    children: (composer: {
      renderPromptBox: (options: {
        promptBoxRef?: { current: unknown };
      }) => ReactNode;
    }) => ReactNode;
  }) =>
    children({
      renderPromptBox: (options) => {
        if (options.promptBoxRef) options.promptBoxRef.current = editor;

        return (
          <form data-promptbox="">
            <div
              contentEditable
              suppressContentEditableWarning
              aria-label="Pending editor"
            />
            <div data-new-thread-footer="">Locked selection</div>
          </form>
        );
      },
    }),
}));

afterEach(() => {
  cleanup();
  editor.insertTypedText.mockReset();
  stopTypeAheadCapture();
  takeTypeAhead();
  titleBar.hostsRightPanelToggle = false;
  window.sessionStorage.clear();
  window.localStorage.clear();
});

type PaneLayout = "single" | "split";

function startPendingChat(
  text: string,
  {
    chromeInTitleBar = false,
    layout = "single",
  }: { chromeInTitleBar?: boolean; layout?: PaneLayout } = {},
) {
  const creation = createDeferredPromise<ThreadResponse>();

  const pending = createPendingChat({
    queueOwner: {},
    request: {
      projectId: "project-pending-thread-chat",
      providerId: "codex",
      model: "model",
      reasoningLevel: "high",
      permissionMode: "full",
      environment: { type: "reuse", environmentId: "environment-pending" },
      executionInputSources: { providerId: "explicit" },
      input: [{ type: "text", text, mentions: [] }],
    },
    create: () => creation.promise,
    send: async () => {},
    renderer: PendingThreadChat,
    prepare: async () => {},
  });

  titleBar.hostsRightPanelToggle = chromeInTitleBar;

  const slots = chromeInTitleBar
    ? {
        pageTitle: document.createElement("div"),
        pageActions: document.createElement("div"),
        companionToolbar: null,
      }
    : null;

  const view = render(
    <WindowTitleBarSlotsContext.Provider value={slots}>
      <DefaultPaneContextProvider
        onRequestClose={null}
        navigateInPane={() => {}}
      >
        {layout === "split" ? (
          <SplitPane>
            <PendingThreadChat pendingId={pending.id} />
          </SplitPane>
        ) : (
          <PendingThreadChat pendingId={pending.id} />
        )}
      </DefaultPaneContextProvider>
    </WindowTitleBarSlotsContext.Provider>,
  );

  return { creation, pending, view };
}

function SplitPane({ children }: { children: ReactNode }) {
  return (
    <PaneContext.Provider
      value={{
        paneId: "split-right",
        isFocused: true,
        isSplitPane: true,
        secondaryPanelHost: null,
        reservesWindowPanelToggle: false,
        onRequestClose: null,
        isMaximized: false,
        onToggleMaximize: null,
        isBoundedPane: true,
        isTopRow: true,
        ownsWindowTopLeft: false,
        navigateInPane: () => {},
      }}
    >
      {children}
    </PaneContext.Provider>
  );
}

function reservesHeaderRow(container: HTMLElement): boolean {
  return Array.from(container.querySelectorAll("[aria-hidden]")).some(
    (element) => element.classList.contains(CHROME_ROW_HEIGHT_CLASS),
  );
}

function hiddenByAppCss(element: Element): boolean {
  const style = document.createElement("style");
  style.textContent = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), "../../app.css"),
    "utf8",
  );
  document.head.append(style);
  const rules = Array.from(style.sheet?.cssRules ?? []);
  style.remove();

  return rules.some(
    (rule) =>
      rule instanceof CSSStyleRule &&
      rule.style.display === "none" &&
      element.matches(rule.selectorText),
  );
}

function messageColumnOf(text: string): Element | null {
  return screen.getByText(text).closest("[data-message-column]");
}

describe("PendingThreadChat", () => {
  it("shows the sent message in the thread's message bubble with Starting... under it", () => {
    startPendingChat("plan the storage migration");

    expect(messageColumnOf("plan the storage migration")).not.toBeNull();
    expect(screen.getByRole("status").textContent).toBe("Starting...");
    expect(screen.queryByText(/Starting chat/)).toBeNull();
    expect(screen.queryByText("Waiting for chat")).toBeNull();
  });

  it("keeps the message and reports a failed start in the same status line", async () => {
    const { creation, pending } = startPendingChat(
      "plan the storage migration",
    );

    await act(async () => {
      creation.reject(new Error("create failed"));
      await pending.completion.catch(() => {});
    });

    expect(messageColumnOf("plan the storage migration")).not.toBeNull();
    expect(screen.getByRole("status").textContent).toBe(
      "The chat could not start. Your messages were kept.",
    );
    expect(screen.queryByText("Kept for recovery")).toBeNull();
  });

  it.each([
    { chromeInTitleBar: false, layout: "single", reserves: true },
    { chromeInTitleBar: true, layout: "single", reserves: false },
    { chromeInTitleBar: true, layout: "split", reserves: true },
  ] as const)(
    "reserves the thread header row only where the live chat has one (title bar chrome $chromeInTitleBar, $layout pane)",
    ({ chromeInTitleBar, layout, reserves }) => {
      const { view } = startPendingChat("plan the storage migration", {
        chromeInTitleBar,
        layout,
      });

      expect(reservesHeaderRow(view.container)).toBe(reserves);
    },
  );

  it("hides the locked selection row under the box so it ends where the live composer does", () => {
    const elsewhere = document.createElement("div");
    elsewhere.setAttribute("data-new-thread-footer", "");
    document.body.append(elsewhere);

    startPendingChat("plan the storage migration");

    expect(hiddenByAppCss(screen.getByText("Locked selection"))).toBe(true);
    expect(hiddenByAppCss(elsewhere)).toBe(false);
    elsewhere.remove();
  });
  it("inserts keys typed since the chat was started once its editor takes focus", () => {
    startTypeAheadCapture();
    startPendingChat("plan the storage migration");
    const pendingEditor = screen.getByLabelText("Pending editor");

    pendingEditor.setAttribute("contenteditable", "true");
    (document.activeElement as HTMLElement | null)?.blur();

    for (const key of ["h", "i", "x", "Backspace", "!"]) {
      fireEvent.keyDown(document.body, { key });
    }

    expect(editor.insertTypedText).not.toHaveBeenCalled();

    fireEvent.focus(pendingEditor);

    expect(editor.insertTypedText).toHaveBeenCalledExactlyOnceWith("hi!");
  });

  it("inserts nothing when no keys were typed ahead", () => {
    startPendingChat("plan the storage migration");
    const pendingEditor = screen.getByLabelText("Pending editor");

    pendingEditor.setAttribute("contenteditable", "true");
    fireEvent.focus(pendingEditor);

    expect(editor.insertTypedText).not.toHaveBeenCalled();
  });
});
