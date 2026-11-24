// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { defaultAppSettings } from "@omnyo/domain";
import { AppCommandProvider, useAppCommandHandler } from "./AppCommandProvider";
import { useComposerShortcutCapture } from "./composer-shortcut-capture";

const testState = vi.hoisted(() => ({ cycles: 0 }));

vi.mock("@/hooks/queries/system-queries", () => ({
  useSystemConfig: () => ({
    data: {
      generalSettings: { ...defaultAppSettings, showKeyboardHints: false },
      keybindings: [
        {
          command: "modelPicker.cycleModel",
          desktopOnly: false,
          shortcut: {
            key: "m",
            mod: true,
            meta: false,
            control: false,
            alt: false,
            shift: false,
          },
          when: { all: ["mainSurface"], none: ["modalOpen"] },
        },
      ],
    },
  }),
}));

vi.mock("@/lib/omnyo-desktop", () => ({ getOmnyoDesktopInfo: () => null }));

function Picker() {
  useAppCommandHandler("modelPicker.cycleModel", () => {
    testState.cycles += 1;

    return true;
  });

  return null;
}

function CapturingComposer() {
  const capture = useComposerShortcutCapture();

  return (
    <div onKeyDownCapture={capture}>
      <textarea data-testid="captured" />
    </div>
  );
}

function renderInModal() {
  return render(
    <MemoryRouter>
      <AppCommandProvider>
        <div role="dialog" data-state="open">
          <Picker />
          <CapturingComposer />
          <textarea data-testid="uncaptured" />
        </div>
      </AppCommandProvider>
    </MemoryRouter>,
  );
}

function pressCycleModel(testId: string) {
  fireEvent.keyDown(screen.getByTestId(testId), {
    key: "m",
    ctrlKey: true,
  });
}

afterEach(() => {
  cleanup();
  testState.cycles = 0;
});

describe("useComposerShortcutCapture", () => {
  it("runs model shortcuts from a composer inside an open modal", () => {
    renderInModal();

    pressCycleModel("captured");

    expect(testState.cycles).toBe(1);
  });

  it("leaves modal-gated shortcuts blocked outside the composer", () => {
    renderInModal();

    pressCycleModel("uncaptured");

    expect(testState.cycles).toBe(0);
  });
});
