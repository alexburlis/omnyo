// @vitest-environment jsdom

import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  defaultAppSettings,
  type AppDefaultKeybindings,
  type AppKeybindingOverrides,
} from "@omnyo/domain";
import { appCommandTarget } from "@/lib/app-command-targets";
import { AppCommandProvider, useAppCommandHandler } from "./AppCommandProvider";
import { AppCommandShortcutOverlay } from "./AppCommandShortcutOverlay";

const testState = vi.hoisted(() => {
  const shortcut = (key: string, shift = false) => ({
    key,
    mod: true,
    meta: false,
    control: false,
    alt: false,
    shift,
  });

  const when = { all: ["mainSurface"], none: ["modalOpen"] };

  const defaultKeybindings = [
    {
      command: "thread.new",
      desktopOnly: false,
      shortcut: shortcut("o", true),
      when,
    },
    {
      command: "thread.search",
      desktopOnly: false,
      shortcut: shortcut("k"),
      when,
    },
    {
      command: "sidebar.toggle",
      desktopOnly: false,
      shortcut: shortcut("b"),
      when,
    },
  ] as AppDefaultKeybindings;

  return {
    defaultKeybindings,
    keybindingOverrides: [] as AppKeybindingOverrides,
    mutate:
      vi.fn<
        (
          overrides: AppKeybindingOverrides,
          options: { onError(): void },
        ) => void
      >(),
    toastSuccess: vi.fn(),
  };
});

vi.mock("@/hooks/queries/system-queries", () => ({
  useSystemConfig: () => ({
    data: {
      defaultKeybindings: testState.defaultKeybindings,
      generalSettings: defaultAppSettings,
      keybindingOverrides: testState.keybindingOverrides,
      keybindings: testState.defaultKeybindings,
    },
  }),
}));

vi.mock("@/hooks/mutations/settings-mutations", () => ({
  useUpdateKeyboardSettings: () => ({
    isPending: false,
    mutate: testState.mutate,
  }),
}));

vi.mock("@/lib/omnyo-desktop", () => ({
  getOmnyoDesktopInfo: () => null,
}));

vi.mock("@/components/ui/app-toast", () => ({
  appToast: { success: testState.toastSuccess },
}));

const onNewThread = vi.fn();

const onSearch = vi.fn<() => boolean>(() => true);

function SearchHandler() {
  useAppCommandHandler("thread.search", onSearch);

  return null;
}

function Harness() {
  return (
    <AppCommandProvider>
      <SearchHandler />
      <button {...appCommandTarget("thread.new")} onClick={onNewThread}>
        New thread
      </button>
      <AppCommandShortcutOverlay />
    </AppCommandProvider>
  );
}

function holdCommand() {
  fireEvent.keyDown(window, { key: "Meta", metaKey: true });
  act(() => {
    vi.advanceTimersByTime(800);
  });
}

function releaseCommand() {
  fireEvent.keyUp(window, { key: "Meta", metaKey: false });
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(navigator, "platform", "get").mockReturnValue("MacIntel");
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue(
    new DOMRect(100, 100, 80, 24),
  );
  document.elementFromPoint = (x: number, y: number) =>
    [...document.querySelectorAll("[data-app-command]")].find((element) => {
      const rect = element.getBoundingClientRect();

      return (
        x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom
      );
    }) ?? document.body;
  testState.mutate.mockImplementation((overrides) => {
    testState.keybindingOverrides = overrides;
  });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
  testState.mutate.mockReset();
  testState.toastSuccess.mockReset();
  testState.keybindingOverrides = [];
  onNewThread.mockReset();
  onSearch.mockClear();
});

describe("AppCommandShortcutOverlay", () => {
  it("shows every bound shortcut and badges marked controls while ⌘ is held", () => {
    render(<Harness />);
    expect(screen.queryByTestId("app-shortcut-sheet")).toBeNull();

    holdCommand();

    const sheet = screen.getByTestId("app-shortcut-sheet");
    expect(sheet.textContent).toContain("New thread");
    expect(sheet.textContent).toContain("Search threads");
    expect(sheet.textContent).toContain("Toggle sidebar");
    expect(
      document.querySelector('[data-app-shortcut-badge="thread.new"]')
        ?.textContent,
    ).toBe("⇧⌘O");

    releaseCommand();
    expect(screen.queryByTestId("app-shortcut-sheet")).toBeNull();
  });

  it("⌘-clicking a marked control rebinds it in place instead of running it", () => {
    render(<Harness />);
    holdCommand();

    const button = screen.getByRole("button", { name: "New thread" });
    fireEvent.pointerDown(button, { button: 0, metaKey: true });
    fireEvent.mouseDown(button, { button: 0, metaKey: true });
    fireEvent.click(button, { button: 0, metaKey: true });

    expect(onNewThread).not.toHaveBeenCalled();
    expect(screen.getByTestId("app-shortcut-editor").textContent).toContain(
      "New thread",
    );

    releaseCommand();
    fireEvent.keyDown(window, { key: "j", metaKey: true, shiftKey: true });

    expect(testState.mutate).toHaveBeenCalledTimes(1);
    expect(testState.keybindingOverrides).toEqual([
      {
        command: "thread.new",
        platform: "mac",
        shortcut: {
          key: "j",
          mod: true,
          meta: false,
          control: false,
          alt: false,
          shift: true,
        },
      },
    ]);
    expect(testState.toastSuccess).toHaveBeenCalledWith(
      "New thread is now ⇧ ⌘ J",
    );
    expect(screen.queryByTestId("app-shortcut-editor")).toBeNull();

    fireEvent.click(button);
    expect(onNewThread).toHaveBeenCalledTimes(1);
  });

  it("does not run app commands while recording and asks before replacing a conflict", () => {
    render(<Harness />);
    holdCommand();
    fireEvent.pointerDown(screen.getByRole("button", { name: "New thread" }), {
      button: 0,
      metaKey: true,
    });

    fireEvent.keyDown(window, { key: "k", metaKey: true });

    expect(onSearch).not.toHaveBeenCalled();
    expect(testState.mutate).not.toHaveBeenCalled();
    expect(screen.getByTestId("app-shortcut-editor").textContent).toContain(
      "Already used by Search threads",
    );

    fireEvent.click(screen.getByRole("button", { name: "Replace" }));

    expect(testState.keybindingOverrides).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          command: "thread.new",
          shortcut: expect.objectContaining({ key: "k", mod: true }),
        }),
        expect.objectContaining({ command: "thread.search", shortcut: null }),
      ]),
    );
  });

  it("edits a command from its sheet row and cancels with Escape", () => {
    render(<Harness />);
    holdCommand();

    const row = document.querySelector<HTMLElement>(
      '[data-app-shortcut-row="sidebar.toggle"]',
    );

    expect(row).not.toBeNull();
    fireEvent.click(row as HTMLElement);
    expect(screen.getByTestId("app-shortcut-editor").textContent).toContain(
      "Toggle sidebar",
    );

    fireEvent.keyDown(window, { key: "Escape" });

    expect(screen.queryByTestId("app-shortcut-editor")).toBeNull();
    expect(testState.mutate).not.toHaveBeenCalled();
  });

  it("leaves quick ⌘-clicks alone before the hint delay", () => {
    render(<Harness />);
    fireEvent.keyDown(window, { key: "Meta", metaKey: true });
    const button = screen.getByRole("button", { name: "New thread" });
    fireEvent.pointerDown(button, { button: 0, metaKey: true });
    fireEvent.click(button, { metaKey: true });

    expect(onNewThread).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId("app-shortcut-editor")).toBeNull();
  });
});
