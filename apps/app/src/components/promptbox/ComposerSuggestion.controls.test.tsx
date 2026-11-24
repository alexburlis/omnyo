// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { TooltipProvider } from "@omnyo/shared-ui/tooltip";
import { ComposerSuggestion } from "./ComposerSuggestion";

vi.mock("@/components/commands/AppCommandProvider", () => ({
  useIsAppCommandModifierHeld: () => false,
}));

afterEach(cleanup);

it.each([false, true])(
  "keeps suggestion actions accessible without captions (touch: %s)",
  (touch) => {
    const onInsert = vi.fn();
    const onDismiss = vi.fn();
    const onRegenerate = vi.fn();
    render(
      <TooltipProvider>
        <ComposerSuggestion
          suggestion={{
            status: "ready",
            text: "Review the change.",
            onDismiss,
            onRegenerate,
          }}
          engaged={false}
          touch={touch}
          onInsert={onInsert}
        />
      </TooltipProvider>,
    );
    expect(screen.getByText("Review the change.")).toBeTruthy();
    expect(screen.queryByText("Suggested reply")).toBeNull();
    expect(screen.queryByText("Insert")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Insert suggestion" }));
    fireEvent.click(
      screen.getByRole("button", { name: "Suggest another reply" }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Dismiss suggestion" }));
    expect(onInsert).toHaveBeenCalledOnce();
    expect(onRegenerate).toHaveBeenCalledOnce();
    expect(onDismiss).toHaveBeenCalledOnce();
  },
);
