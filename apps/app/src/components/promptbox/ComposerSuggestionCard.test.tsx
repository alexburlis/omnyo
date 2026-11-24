// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { TooltipProvider } from "@omnyo/shared-ui/tooltip";
import { ComposerSuggestionCard } from "./ComposerSuggestionCard";

const TEXT =
  "Looks good.\n\nBefore pushing:\n- check the iPad layout\n- run the composer tests again";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function renderCard() {
  render(
    <TooltipProvider>
      <ComposerSuggestionCard
        suggestion={{ status: "ready", text: TEXT, onDismiss: vi.fn() }}
        animate={false}
        send={{ blockedReason: null, onSend: vi.fn() }}
        onEdit={vi.fn()}
      />
    </TooltipProvider>,
  );
}

function suggestionText(): HTMLElement {
  const element = document.querySelector("[data-composer-suggestion-text]");

  if (!(element instanceof HTMLElement)) throw new Error("No text");

  return element;
}

it("clamps a long suggestion to three lines and expands it on tap", () => {
  vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockReturnValue(130);
  vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(78);
  renderCard();

  expect(suggestionText().className).toContain("line-clamp-3");
  const toggle = screen.getByRole("button", { expanded: false });
  fireEvent.click(toggle);

  expect(toggle.getAttribute("aria-expanded")).toBe("true");
  expect(suggestionText().className).not.toContain("line-clamp-3");
  expect(suggestionText().className).toContain("overflow-y-auto");
  expect(suggestionText().textContent).toBe(TEXT);
});

it("shows a short suggestion as plain text without an expand control", () => {
  renderCard();

  expect(suggestionText().textContent).toBe(TEXT);
  expect(screen.queryByRole("button", { expanded: false })).toBeNull();
});
