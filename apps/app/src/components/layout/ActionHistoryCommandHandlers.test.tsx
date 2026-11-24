// @vitest-environment jsdom

import { useEffect } from "react";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { defaultAppSettings, type AppDefaultKeybinding } from "@omnyo/domain";
import { AppCommandProvider } from "@/components/commands/AppCommandProvider";
import type { ActionHistory } from "@/lib/action-history";
import { experimental_useActionHistory as useExperimentalActionHistory } from "@/lib/plugin-sdk-hooks";
import {
  ActionHistoryProvider,
  useActionHistory,
} from "./ActionHistoryProvider";
import { ActionHistoryCommandHandlers } from "./ActionHistoryCommandHandlers";

const mocks = vi.hoisted(() => ({ success: vi.fn(), undoKey: "z" }));

function binding(command: "edit.undo" | "edit.redo"): AppDefaultKeybinding {
  return {
    command,
    desktopOnly: false,
    shortcut: {
      key: command === "edit.undo" ? mocks.undoKey : "z",
      mod: true,
      meta: false,
      control: false,
      alt: false,
      shift: command === "edit.redo",
    },
    when: {
      all: ["mainSurface"],
      none: ["modalOpen", "editableFocus", "terminalFocus", "browserFocus"],
    },
  };
}

vi.mock("@/hooks/queries/system-queries", () => ({
  useSystemConfig: () => ({
    data: {
      generalSettings: { ...defaultAppSettings, showKeyboardHints: false },
      keybindings: [binding("edit.undo"), binding("edit.redo")],
      defaultKeybindings: [binding("edit.undo"), binding("edit.redo")],
    },
  }),
}));

vi.mock("@/lib/plugin-slots", () => ({
  usePluginSlots: () => ({ commandPaletteActions: [] }),
}));

vi.mock("@/lib/omnyo-desktop", () => ({ getOmnyoDesktopInfo: () => null }));

vi.mock("@/components/ui/app-toast", () => ({
  appToast: { success: mocks.success, error: vi.fn() },
}));

function PluginBoard({ moves }: { moves: string[] }) {
  const history = useExperimentalActionHistory();

  return (
    <div aria-label="Board">
      <button
        type="button"
        onClick={() => {
          moves.push("moved");
          history.record({
            label: "Move Revenue chart",
            undo: async () => {
              moves.push("undo move");
            },
            redo: async () => {
              moves.push("redo move");
            },
          });
        }}
      >
        Move
      </button>
      <button
        type="button"
        disabled={!history.canUndo}
        onClick={() => void history.undo()}
      >
        Board undo
      </button>
    </div>
  );
}

function Harness({
  onHistory,
  moves,
}: {
  onHistory: (history: ActionHistory) => void;
  moves: string[];
}) {
  const history = useActionHistory();
  useEffect(() => onHistory(history), [history, onHistory]);

  return (
    <>
      <ActionHistoryCommandHandlers />
      <PluginBoard moves={moves} />
      <input
        aria-label="Search"
        onKeyDown={(event) => event.stopPropagation()}
      />
      <textarea
        aria-label="Draft"
        onKeyDown={(event) => event.stopPropagation()}
      />
      <div
        role="textbox"
        aria-label="Composer"
        contentEditable
        onKeyDown={(event) => event.stopPropagation()}
      />
    </>
  );
}

function setup(moves: string[] = []) {
  const captured: { history: ActionHistory | null } = { history: null };
  render(
    <MemoryRouter>
      <AppCommandProvider>
        <ActionHistoryProvider>
          <Harness
            moves={moves}
            onHistory={(value) => {
              captured.history = value;
            }}
          />
        </ActionHistoryProvider>
      </AppCommandProvider>
    </MemoryRouter>,
  );

  if (captured.history === null)
    throw new Error("History provider did not mount");

  return captured.history;
}

function shortcut(target: HTMLElement, shiftKey = false) {
  const event = new KeyboardEvent("keydown", {
    key: "z",
    code: "KeyZ",
    metaKey: true,
    shiftKey,
    bubbles: true,
    cancelable: true,
  });

  fireEvent(target, event);

  return event;
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  mocks.success.mockClear();
  mocks.undoKey = "z";
});

describe("ActionHistoryCommandHandlers", () => {
  it("undoes a plugin action before an older archive, in one history", async () => {
    vi.spyOn(navigator, "platform", "get").mockReturnValue("MacIntel");
    const moves: string[] = [];
    const history = setup(moves);
    let archived = true;
    history.record({
      label: "Archive chat",
      undo: async () => {
        archived = false;
      },
      redo: async () => {
        archived = true;
      },
    });
    fireEvent.click(screen.getByRole("button", { name: "Move" }));
    const board = screen.getByLabelText("Board");

    await act(async () => {
      expect(shortcut(board).defaultPrevented).toBe(true);
    });
    expect(moves).toEqual(["moved", "undo move"]);
    expect(archived).toBe(true);
    expect(mocks.success).toHaveBeenLastCalledWith(
      "Undid: Move Revenue chart",
      expect.anything(),
    );

    await act(async () => {
      shortcut(board, true);
    });
    expect(moves).toEqual(["moved", "undo move", "redo move"]);

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Board undo" }));
    });
    await act(async () => {
      shortcut(board);
    });
    expect(moves).toEqual(["moved", "undo move", "redo move", "undo move"]);
    expect(archived).toBe(false);
    expect(screen.getByRole("button", { name: "Board undo" })).toHaveProperty(
      "disabled",
      true,
    );
  });

  it.each(["Search", "Draft", "Composer"])(
    "restores an archive before the focused %s field consumes Cmd+Z, then supports redo",
    async (label) => {
      vi.spyOn(navigator, "platform", "get").mockReturnValue("MacIntel");
      const history = setup();
      let archived = true;
      history.record({
        label: "Archive chat",
        undo: async () => {
          archived = false;
        },
        redo: async () => {
          archived = true;
        },
      });
      const field = screen.getByRole("textbox", { name: label });
      field.focus();
      await act(async () => {
        expect(shortcut(field).defaultPrevented).toBe(true);
      });
      expect(archived).toBe(false);
      await act(async () => {
        expect(shortcut(field, true).defaultPrevented).toBe(true);
      });
      expect(archived).toBe(true);
    },
  );

  it("uses the configured undo shortcut rather than hard-coding Cmd+Z", async () => {
    vi.spyOn(navigator, "platform", "get").mockReturnValue("MacIntel");
    mocks.undoKey = "u";
    const history = setup();
    const undo = vi.fn(async () => {});
    history.record({ label: "Archive chat", undo, redo: async () => {} });
    const field = screen.getByRole("textbox", { name: "Draft" });
    field.focus();
    expect(shortcut(field).defaultPrevented).toBe(false);

    const event = new KeyboardEvent("keydown", {
      key: "u",
      code: "KeyU",
      metaKey: true,
      bubbles: true,
      cancelable: true,
    });

    await act(async () => {
      fireEvent(field, event);
    });
    expect(event.defaultPrevented).toBe(true);
    expect(undo).toHaveBeenCalledOnce();
  });

  it.each(["modal", "terminal", "browser"])(
    "preserves %s keyboard ownership",
    async (surface) => {
      vi.spyOn(navigator, "platform", "get").mockReturnValue("MacIntel");
      const history = setup();
      const undo = vi.fn(async () => {});
      history.record({ label: "Archive chat", undo, redo: async () => {} });
      const field = screen.getByRole("textbox", { name: "Draft" });

      if (surface === "modal") {
        field.setAttribute("aria-modal", "true");
      } else {
        field.setAttribute(`data-app-${surface}`, "");
      }

      field.focus();
      await act(async () => {
        expect(shortcut(field).defaultPrevented).toBe(false);
      });
      expect(undo).not.toHaveBeenCalled();
    },
  );

  it("keeps text undo ownership when typing while archive undo is still pending", async () => {
    vi.spyOn(navigator, "platform", "get").mockReturnValue("MacIntel");
    const history = setup();
    let finishUndo = () => {};

    const pendingUndo = new Promise<void>((resolve) => {
      finishUndo = resolve;
    });

    const redo = vi.fn(async () => {});
    history.record({ label: "Archive chat", undo: () => pendingUndo, redo });
    const field = screen.getByRole("textbox", { name: "Draft" });
    field.focus();
    expect(shortcut(field).defaultPrevented).toBe(true);
    fireEvent.input(field, {
      target: { value: "Typed during undo" },
      inputType: "insertText",
    });
    await act(async () => {
      finishUndo();
      await pendingUndo;
    });
    expect(shortcut(field, true).defaultPrevented).toBe(false);
    expect(redo).not.toHaveBeenCalled();
    expect(history.canRedo).toBe(true);
  });

  it("does not steal text undo when an archive finishes recording after the user starts typing", async () => {
    vi.spyOn(navigator, "platform", "get").mockReturnValue("MacIntel");
    const history = setup();
    const revision = history.keyboardRevision;
    const undo = vi.fn(async () => {});
    const field = screen.getByRole("textbox", { name: "Draft" });
    field.focus();
    fireEvent.input(field, {
      target: { value: "Typed during archive" },
      inputType: "insertText",
    });
    history.record(
      { label: "Archive chat", undo, redo: async () => {} },
      revision,
    );
    await act(async () => {
      expect(shortcut(field).defaultPrevented).toBe(false);
    });
    expect(undo).not.toHaveBeenCalled();
    expect(history.canUndo).toBe(true);
  });

  it("leaves Cmd+Z to the editor after the user edits text following an archive", async () => {
    vi.spyOn(navigator, "platform", "get").mockReturnValue("MacIntel");
    const history = setup();
    const undo = vi.fn(async () => {});
    history.record({ label: "Archive chat", undo, redo: async () => {} });
    const field = screen.getByRole("textbox", { name: "Draft" });
    field.focus();
    fireEvent.input(field, {
      target: { value: "New draft" },
      inputType: "insertText",
    });
    await act(async () => {
      expect(shortcut(field).defaultPrevented).toBe(false);
    });
    expect(undo).not.toHaveBeenCalled();
    expect(history.canUndo).toBe(true);
  });
});
