// @vitest-environment jsdom

import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useState, type ReactNode } from "react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, expect, it, vi } from "vitest";
import { CompactViewportOverrideProvider } from "@omnyo/shared-ui/hooks/use-compact-viewport";
import { PendingInteractionShell } from "./PendingInteractionShell";
import { MobilePendingInteractionProvider } from "./MobilePendingInteraction";

afterEach(cleanup);

function DecisionContent({ onSkip }: { onSkip: () => void }) {
  const [notes, setNotes] = useState("");

  return (
    <>
      <label>
        Notes
        <input
          value={notes}
          onChange={(event) => setNotes(event.target.value)}
        />
      </label>
      <button type="button" onClick={onSkip}>
        Skip
      </button>
    </>
  );
}

function TestHost({ children }: { children: ReactNode }) {
  return (
    <QueryClientProvider client={new QueryClient()}>
      <MemoryRouter>
        <CompactViewportOverrideProvider isCompactViewport>
          {children}
        </CompactViewportOverrideProvider>
      </MemoryRouter>
    </QueryClientProvider>
  );
}

it("opens a mobile decision in a dismissible dialog and preserves its draft when minimized", async () => {
  const onSkip = vi.fn();

  const { container } = render(
    <TestHost>
      <PendingInteractionShell
        label="Needs your answer"
        expandedByDefault
        testId="decision"
      >
        {() => <DecisionContent onSkip={onSkip} />}
      </PendingInteractionShell>
    </TestHost>,
  );

  const dialog = await screen.findByRole("dialog", {
    name: "Needs your answer",
  });

  const notes = await within(dialog).findByRole("textbox", { name: "Notes" });
  fireEvent.change(notes, { target: { value: "Keep this draft" } });
  fireEvent.click(within(dialog).getByRole("button", { name: "Minimize" }));
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(onSkip).not.toHaveBeenCalled();
  expect(container.hasAttribute("inert")).toBe(false);
  expect(container.getAttribute("aria-hidden")).not.toBe("true");
  fireEvent.click(screen.getByRole("button", { name: "Needs your answer" }));

  const reopened = await screen.findByRole("dialog", {
    name: "Needs your answer",
  });

  expect(within(reopened).getByRole("textbox", { name: "Notes" })).toBe(notes);
  expect(notes).toHaveProperty("value", "Keep this draft");
  fireEvent.click(within(reopened).getByRole("button", { name: "Skip" }));
  expect(onSkip).toHaveBeenCalledOnce();
});

function DecisionQueue({ ids }: { ids: string[] }) {
  return (
    <MobilePendingInteractionProvider>
      {ids.map((id) => (
        <PendingInteractionShell
          key={id}
          label={`Decision ${id}`}
          expandedByDefault
          testId={`decision-${id}`}
        >
          {() => <input aria-label={`Notes ${id}`} />}
        </PendingInteractionShell>
      ))}
    </MobilePendingInteractionProvider>
  );
}

it("opens one mobile decision, leaves existing decisions minimized, and opens a new arrival", async () => {
  const view = render(
    <TestHost>
      <DecisionQueue ids={["one", "two"]} />
    </TestHost>,
  );

  const first = await screen.findByRole("dialog", { name: "Decision one" });
  await within(first).findByRole("textbox", { name: "Notes one" });
  expect(screen.getAllByRole("dialog")).toHaveLength(1);
  fireEvent.click(within(first).getByRole("button", { name: "Minimize" }));
  expect(screen.queryByRole("dialog")).toBeNull();

  view.rerender(
    <TestHost>
      <DecisionQueue ids={["one", "two"]} />
    </TestHost>,
  );
  expect(screen.queryByRole("dialog")).toBeNull();

  fireEvent.click(screen.getByRole("button", { name: "Decision two" }));
  const second = await screen.findByRole("dialog", { name: "Decision two" });
  await within(second).findByRole("textbox", { name: "Notes two" });
  expect(screen.getAllByRole("dialog")).toHaveLength(1);
  fireEvent.keyDown(document, { key: "Escape" });
  expect(screen.queryByRole("dialog")).toBeNull();

  view.rerender(
    <TestHost>
      <DecisionQueue ids={["one", "two", "three"]} />
    </TestHost>,
  );
  const third = await screen.findByRole("dialog", { name: "Decision three" });
  await within(third).findByRole("textbox", { name: "Notes three" });
  expect(screen.getAllByRole("dialog")).toHaveLength(1);
});

function NativeQuestionSlot({ id }: { id: string }) {
  return (
    <TestHost>
      <MobilePendingInteractionProvider>
        <PendingInteractionShell
          interactionKey={id}
          label="Needs your answer"
          expandedByDefault
          testId="decision"
        >
          {() => <input key={id} aria-label={`Notes ${id}`} />}
        </PendingInteractionShell>
      </MobilePendingInteractionProvider>
    </TestHost>
  );
}

it("automatically opens the next question in an existing minimized shell", async () => {
  const view = render(<NativeQuestionSlot id="first" />);

  const first = await screen.findByRole("dialog", {
    name: "Needs your answer",
  });

  await within(first).findByRole("textbox", { name: "Notes first" });
  fireEvent.click(within(first).getByRole("button", { name: "Minimize" }));
  expect(screen.queryByRole("dialog")).toBeNull();
  view.rerender(<NativeQuestionSlot id="next" />);
  const next = await screen.findByRole("dialog", { name: "Needs your answer" });
  await within(next).findByRole("textbox", { name: "Notes next" });
  expect(screen.getAllByRole("dialog")).toHaveLength(1);
});
