// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { TooltipProvider } from "@omnyo/shared-ui/tooltip";
import { ComposerSuggestion } from "./ComposerSuggestion";

vi.mock("@/components/commands/AppCommandShortcutHint", () => ({
  AppCommandShortcutPill: () => null,
}));

afterEach(cleanup);

it.each([false, true])(
  "offers one-tap insertion on touch (engaged: %s)",
  (engaged) => {
    const onInsert = vi.fn();
    const onDismiss = vi.fn();
    render(
      <TooltipProvider>
        <ComposerSuggestion
          suggestion={{ status: "ready", text: "Fix the gateway", onDismiss }}
          engaged={engaged}
          touch={true}
          onInsert={onInsert}
        />
      </TooltipProvider>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Insert suggestion" }));
    expect(onInsert).toHaveBeenCalledTimes(1);
    expect(onDismiss).not.toHaveBeenCalled();
  },
);

it("keeps regeneration and labelled state actions in the touch overlay", () => {
  const onRegenerate = vi.fn();

  const { rerender } = render(
    <TooltipProvider>
      <ComposerSuggestion
        suggestion={{
          status: "ready",
          text: "Smoke test the release on the test iPhone",
          onDismiss: vi.fn(),
          onRegenerate,
        }}
        engaged={false}
        touch={true}
        onInsert={vi.fn()}
      />
    </TooltipProvider>,
  );

  fireEvent.click(
    screen.getByRole("button", { name: "Suggest another reply" }),
  );
  expect(onRegenerate).toHaveBeenCalledTimes(1);

  rerender(
    <TooltipProvider>
      <ComposerSuggestion
        suggestion={{
          status: "failed",
          message: "Provider unavailable",
          onDismiss: vi.fn(),
          onRetry: vi.fn(),
        }}
        engaged={false}
        touch={true}
        onInsert={vi.fn()}
      />
    </TooltipProvider>,
  );

  expect(screen.getByRole("button", { name: "Retry" }).textContent).toBe(
    "Retry",
  );
});
