// @vitest-environment jsdom

import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MachineLaunchCommand } from "./AddMachineDialog";

const COMMAND =
  "curl -sS --fail-with-body -L --max-redirs 0 -H 'X-Omnyo-Enrollment: secret' https://omnyo.example.test/install.sh | sh";

describe("MachineLaunchCommand", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
  });
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it("shows the PowerShell command when Windows is chosen", () => {
    render(
      <MachineLaunchCommand
        command={COMMAND}
        windowsCommand="irm windows-command | iex"
        expiresAt={15 * 60_000}
        onRegenerate={() => {}}
      />,
    );
    expect(screen.getByText(COMMAND)).toBeTruthy();
    expect(
      screen
        .getByRole("radio", { name: "macOS or Linux" })
        .getAttribute("aria-checked"),
    ).toBe("true");

    fireEvent.click(screen.getByRole("radio", { name: "Windows" }));

    expect(screen.getByText("irm windows-command | iex")).toBeTruthy();
    expect(screen.queryByText(COMMAND)).toBeNull();
    expect(screen.getByText("Run in PowerShell")).toBeTruthy();
  });

  it("counts the remaining time down while the command is still valid", () => {
    render(
      <MachineLaunchCommand
        command={COMMAND}
        windowsCommand="irm windows-command | iex"
        expiresAt={15 * 60_000}
        onRegenerate={() => {}}
      />,
    );
    expect(screen.getByRole("status").textContent).toBe(
      "Command expires in 15:00",
    );
    act(() => void vi.advanceTimersByTime(61_000));
    expect(screen.getByRole("status").textContent).toBe(
      "Command expires in 13:59",
    );
    expect(screen.getByText(COMMAND)).toBeTruthy();
  });

  it("stops offering a copy and offers a replacement once it expires", () => {
    const onRegenerate = vi.fn();
    render(
      <MachineLaunchCommand
        command={COMMAND}
        windowsCommand="irm windows-command | iex"
        expiresAt={5_000}
        onRegenerate={onRegenerate}
      />,
    );
    expect(
      screen.getByRole("button", { name: "Copy" }).hasAttribute("disabled"),
    ).toBe(false);
    act(() => void vi.advanceTimersByTime(6_000));
    expect(screen.getByRole("status").textContent).toBe("Command expired");
    expect(
      screen.getByRole("button", { name: "Copy" }).hasAttribute("disabled"),
    ).toBe(true);
    screen.getByRole("button", { name: "Generate a new command" }).click();
    expect(onRegenerate).toHaveBeenCalledTimes(1);
  });

  it("stops offering a copy after the server withdraws the command", () => {
    render(
      <MachineLaunchCommand
        command={COMMAND}
        windowsCommand="irm windows-command | iex"
        expiresAt={15 * 60_000}
        unavailable
        onRegenerate={() => {}}
      />,
    );
    expect(screen.getByRole("status").textContent).toBe("Command used");
    expect(
      screen.getByRole("button", { name: "Copy" }).hasAttribute("disabled"),
    ).toBe(true);
  });

  it("leads with the short setup code and keeps the full command as a fallback", async () => {
    const writeText = vi.fn(async () => {});
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    render(
      <MachineLaunchCommand
        command={COMMAND}
        windowsCommand="irm windows-command | iex"
        expiresAt={15 * 60_000}
        shortCommand={{
          code: "AB12-CD34",
          command: "curl -fsSL https://omnyo.example.test/m/AB12-CD34 | sh",
          windowsCommand:
            "irm https://omnyo.example.test/m/AB12-CD34.ps1 | iex",
          expiresAt: 10 * 60_000,
        }}
        onRegenerate={() => {}}
      />,
    );

    expect(screen.getByLabelText("Setup code").textContent).toBe("AB12-CD34");
    expect(
      screen.getByText(
        "curl -fsSL https://omnyo.example.test/m/AB12-CD34 | sh",
      ),
    ).toBeTruthy();
    expect(screen.queryByText(COMMAND)).toBeNull();
    expect(screen.getByRole("status").textContent).toBe(
      "Command expires in 10:00",
    );

    await act(async () => {
      fireEvent.click(
        screen.getByRole("button", { name: "Copy full command" }),
      );
    });
    expect(writeText).toHaveBeenCalledWith(COMMAND);

    fireEvent.click(screen.getByRole("radio", { name: "Windows" }));
    expect(
      screen.getByText("irm https://omnyo.example.test/m/AB12-CD34.ps1 | iex"),
    ).toBeTruthy();

    act(() => void vi.advanceTimersByTime(10 * 60_000));
    expect(screen.getByRole("status").textContent).toBe("Command expired");
    expect(
      screen.getByRole("button", { name: "Copy" }).hasAttribute("disabled"),
    ).toBe(true);
    expect(
      screen
        .getByRole("button", { name: /full command/u })
        .hasAttribute("disabled"),
    ).toBe(false);
    vi.unstubAllGlobals();
  });
});
