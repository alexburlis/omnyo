// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RootComposeIncomingPrompt } from "./RootComposeIncomingPrompt";

function setBoxHeights(scrollHeight: number, clientHeight: number) {
  vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockReturnValue(
    scrollHeight,
  );
  vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(
    clientHeight,
  );
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("RootComposeIncomingPrompt", () => {
  it("says the prompt came from a link", () => {
    setBoxHeights(40, 40);
    render(
      <RootComposeIncomingPrompt
        text="Short prompt"
        onUse={vi.fn()}
        onDismiss={vi.fn()}
      />,
    );

    expect(screen.getByText("From a link")).toBeTruthy();
    expect(screen.queryByText(/Scroll to read all of it/u)).toBeNull();
  });

  it("says when the text is longer than the visible box", () => {
    setBoxHeights(400, 112);
    render(
      <RootComposeIncomingPrompt
        text={"Long line\n".repeat(60)}
        onUse={vi.fn()}
        onDismiss={vi.fn()}
      />,
    );

    expect(
      screen.getByText("From a link. Scroll to read all of it."),
    ).toBeTruthy();
  });

  it("keeps the Use and Dismiss actions", () => {
    setBoxHeights(40, 40);
    const onUse = vi.fn();
    const onDismiss = vi.fn();
    render(
      <RootComposeIncomingPrompt
        text="Prompt"
        onUse={onUse}
        onDismiss={onDismiss}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Use" }));
    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));

    expect(onUse).toHaveBeenCalledTimes(1);
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });
});
