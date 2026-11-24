// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FloatingThreadGoal, ThreadGoalCard } from "./ThreadGoalCard";

const mocks = vi.hoisted(() => ({
  clearThreadGoal: { isPending: false, mutate: vi.fn() },
}));

vi.mock("@/hooks/mutations/thread-runtime-mutations", () => ({
  useClearThreadGoal: () => mocks.clearThreadGoal,
}));

const goal = {
  sourceSeq: 1,
  updatedAt: 100,
  objective: "Finish the activity model",
  status: "active" as const,
  tokenBudget: null,
  tokensUsed: 100,
  timeUsedSeconds: 750,
};

afterEach(() => {
  cleanup();
  mocks.clearThreadGoal.isPending = false;
  mocks.clearThreadGoal.mutate.mockReset();
});

function Harness({
  onChange,
  onClearGoal,
}: {
  onChange: (expanded: boolean) => void;
  onClearGoal?: () => void;
}) {
  const [expanded, setExpanded] = useState(false);

  return (
    <ThreadGoalCard
      goal={goal}
      isExpanded={expanded}
      onClearGoal={onClearGoal}
      onExpandedChange={(next) => {
        onChange(next);
        setExpanded(next);
      }}
    />
  );
}

describe("ThreadGoalCard", () => {
  it("shows a compact pill and expands the objective", () => {
    const onChange = vi.fn();

    render(<Harness onChange={onChange} />);

    const pill = screen.getByRole("button", { name: "Goal, 12m elapsed" });

    expect(screen.queryByText(goal.objective)).toBeNull();
    fireEvent.click(pill);
    expect(onChange).toHaveBeenLastCalledWith(true);
    expect(screen.getByText(goal.objective)).not.toBeNull();
  });

  it("collapses on Escape without clearing the goal or hiding the app", () => {
    const onChange = vi.fn();
    const onClearGoal = vi.fn();

    const { container } = render(
      <Harness onChange={onChange} onClearGoal={onClearGoal} />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Goal, 12m elapsed" }));
    fireEvent.keyDown(screen.getByText(goal.objective), { key: "Escape" });
    expect(onChange).toHaveBeenLastCalledWith(false);
    expect(onClearGoal).not.toHaveBeenCalled();
    expect(screen.queryByText(goal.objective)).toBeNull();
    expect(container.closest("[inert], [aria-hidden='true']")).toBeNull();
    expect(
      screen.getByRole("button", { name: "Goal, 12m elapsed" }),
    ).not.toBeNull();
  });

  it("clears only through the explicit action inside the expanded card", () => {
    const onClearGoal = vi.fn();

    render(<Harness onChange={() => {}} onClearGoal={onClearGoal} />);

    expect(screen.queryByRole("button", { name: "Clear goal" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Goal, 12m elapsed" }));
    fireEvent.click(screen.getByRole("button", { name: "Clear goal" }));
    expect(onClearGoal).toHaveBeenCalledOnce();
  });

  it("disables repeated clear requests while pending", () => {
    render(
      <ThreadGoalCard
        goal={goal}
        isClearPending
        isExpanded
        onClearGoal={() => {}}
        onExpandedChange={() => {}}
      />,
    );

    expect(
      screen
        .getByRole("button", { name: "Clearing goal…" })
        .hasAttribute("disabled"),
    ).toBe(true);
  });

  it("wires the floating goal's clear action to the current thread", () => {
    render(<FloatingThreadGoal goal={goal} threadId="thr_goal" />);

    fireEvent.click(screen.getByRole("button", { name: "Goal, 12m elapsed" }));
    fireEvent.click(screen.getByRole("button", { name: "Clear goal" }));
    expect(mocks.clearThreadGoal.mutate).toHaveBeenCalledWith("thr_goal");
  });

  it("renders nothing for an inactive goal", () => {
    const { container } = render(
      <ThreadGoalCard
        goal={null}
        isExpanded={false}
        onExpandedChange={() => {}}
      />,
    );

    expect(container.childElementCount).toBe(0);
  });
});
