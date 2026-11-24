// @vitest-environment jsdom

import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { TooltipProvider } from "@omnyo/shared-ui/tooltip";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createQueryClientTestHarness } from "@/test/queryClientTestHarness";
import { QueuedMessageStartOnMenu } from "./QueuedMessageStartOnMenu";

const listStartMachines = vi.hoisted(() => vi.fn());

const moveStart = vi.hoisted(() => vi.fn());

const toastError = vi.hoisted(() => vi.fn());

vi.mock("@/lib/sdk", () => ({
  sdk: {
    threads: {
      experimental_listStartMachines: listStartMachines,
      experimental_moveStart: moveStart,
    },
    environments: {
      listProviders: vi.fn(async () => [
        { id: "temporary-copy", displayName: "Temporary copy" },
      ]),
    },
  },
}));

vi.mock("@/components/ui/app-toast", () => ({
  appToast: { error: toastError },
}));

afterEach(() => {
  cleanup();
  window.localStorage.clear();
  listStartMachines.mockReset();
  moveStart.mockReset();
  toastError.mockReset();
});

function renderMenu() {
  listStartMachines.mockResolvedValue({
    originHostId: "host-pro",
    machines: [
      {
        hostId: "host-air",
        name: "Mac Air",
        eligible: true,
        environmentProviderId: "temporary-copy",
        reason: null,
      },
      {
        hostId: "host-3090",
        name: "3090",
        eligible: false,
        environmentProviderId: null,
        reason: "That machine can't take new chats now.",
      },
    ],
  });

  const { wrapper: Wrapper } = createQueryClientTestHarness();

  render(
    <Wrapper>
      <TooltipProvider>
        <QueuedMessageStartOnMenu threadId="thr_1" compact disabled={false} />
      </TooltipProvider>
    </Wrapper>,
  );

  fireEvent.pointerDown(
    screen.getByRole("button", { name: "Start on another machine" }),
    { button: 0, ctrlKey: false, pointerType: "mouse" },
  );
}

describe("QueuedMessageStartOnMenu", () => {
  it("starts the waiting chat on the picked machine", async () => {
    moveStart.mockResolvedValue({
      kind: "moved",
      threadId: "thr_1",
      fromHostId: "host-pro",
      toHostId: "host-air",
      environmentProviderId: "temporary-copy",
    });
    renderMenu();

    const airItem = await screen.findByRole("menuitem", { name: /Mac Air/u });

    await waitFor(() =>
      expect(airItem.textContent).toContain("Temporary copy"),
    );
    expect(
      screen
        .getByRole("menuitem", { name: /3090/u })
        .getAttribute("aria-disabled"),
    ).toBe("true");
    expect(
      screen.getByText("That machine can't take new chats now."),
    ).toBeTruthy();

    fireEvent.click(airItem);

    await waitFor(() =>
      expect(moveStart).toHaveBeenCalledWith({
        threadId: "thr_1",
        hostId: "host-air",
        expectedHostId: "host-pro",
      }),
    );
    expect(toastError).not.toHaveBeenCalled();
  });

  it("shows why the server refused the move", async () => {
    moveStart.mockResolvedValue({
      kind: "refused",
      code: "start_claimed",
      message: "This chat is starting right now.",
    });
    renderMenu();

    fireEvent.click(await screen.findByRole("menuitem", { name: /Mac Air/u }));

    await waitFor(() =>
      expect(toastError).toHaveBeenCalledWith(
        "This chat is starting right now.",
      ),
    );
  });
});
