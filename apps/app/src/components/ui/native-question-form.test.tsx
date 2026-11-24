// @vitest-environment jsdom

import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { useMemo, useRef } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  QuestionFormHostProvider,
  type QuestionFormHost,
} from "@omnyo/shared-ui/question-form-host";
import type { Question } from "./native-question-form";
import { QuestionForm } from "./question-form";

const questions: Question[] = [
  {
    id: "first",
    shortLabel: "Rule?",
    prompt: "Choose the first rule",
    multiSelect: false,
    allowFreeText: true,
    options: [
      { value: "local", label: "Local" },
      { value: "remote", label: "Remote" },
    ],
  },
  {
    id: "second",
    shortLabel: "Rule?",
    prompt: "Choose the second rule",
    multiSelect: false,
    allowFreeText: true,
    options: [{ value: "keep", label: "Keep" }],
  },
];

function Host({
  items,
  submit,
}: {
  items: Question[];
  submit: (answers: unknown) => Promise<void>;
}) {
  const choice = useRef<((index: number) => boolean) | null>(null);

  const host = useMemo<QuestionFormHost>(
    () => ({
      shortcuts: new Map([
        ["0", { label: "1", ariaKeyshortcuts: "1" }],
        ["1", { label: "2", ariaKeyshortcuts: "2" }],
      ]),
      registerChoiceHandler: (handler) => {
        choice.current = handler;

        return () => {
          choice.current = null;
        };
      },
    }),
    [],
  );

  return (
    <QuestionFormHostProvider value={host}>
      <div
        onKeyDown={(event) => {
          if (/^[1-9]$/.test(event.key))
            choice.current?.(Number(event.key) - 1);
        }}
      >
        <QuestionForm
          questions={items}
          disabled={false}
          cancelDisabled={false}
          onSubmit={submit}
          onCancel={() => {}}
        />
      </div>
    </QuestionFormHostProvider>
  );
}

beforeEach(() => vi.useFakeTimers());

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

it.each(["click", "number"] as const)(
  "retains a %s choice across delayed navigation and submits the batch explicitly",
  async (method) => {
    const submit = vi.fn(async () => {});
    const view = render(<Host items={questions} submit={submit} />);
    const local = view.getByRole("radio", { name: "Local" });
    expect(view.getByRole("button", { name: "Rule? 1" })).toBeTruthy();
    expect(view.getByRole("button", { name: "Rule? 2" })).toBeTruthy();

    if (method === "click") fireEvent.click(local);
    else fireEvent.keyDown(local, { key: "1" });
    expect(local.getAttribute("aria-checked")).toBe("true");
    expect(view.getByText("1 of 2")).toBeTruthy();
    act(() => vi.advanceTimersByTime(200));
    expect(view.getByText("2 of 2")).toBeTruthy();
    expect(view.getByRole("button", { name: "Rule? 1 Local" })).toBeTruthy();
    fireEvent.click(view.getByRole("button", { name: "Back" }));
    expect(
      view.getByRole("radio", { name: "Local" }).getAttribute("aria-checked"),
    ).toBe("true");
    fireEvent.click(view.getByRole("button", { name: "Next" }));
    fireEvent.click(view.getByRole("radio", { name: "Keep" }));
    act(() => vi.advanceTimersByTime(200));
    expect(submit).not.toHaveBeenCalled();
    expect(
      view.getByRole("button", { name: "Submit 2 answers" }),
    ).toHaveProperty("disabled", false);
    await act(async () => {
      fireEvent.keyDown(view.getByRole("radio", { name: "Keep" }), {
        key: "Enter",
      });
    });
    expect(submit).toHaveBeenCalledExactlyOnceWith({
      first: { selected: ["local"] },
      second: { selected: ["keep"] },
    });
  },
);

it.each(["multiple choices", "free text"] as const)(
  "requires explicit navigation for %s",
  (method) => {
    const submit = vi.fn(async () => {});

    const items = questions.map((question, index) => ({
      ...question,
      multiSelect: index === 0 && method === "multiple choices",
    }));

    const view = render(<Host items={items} submit={submit} />);

    if (method === "multiple choices") {
      fireEvent.click(view.getByRole("button", { name: "Local" }));
      fireEvent.click(view.getByRole("button", { name: "Remote" }));
    } else {
      fireEvent.click(view.getByRole("radio", { name: "Other…" }));
      fireEvent.change(view.getByRole("textbox"), {
        target: { value: "Custom rule" },
      });
    }

    act(() => vi.advanceTimersByTime(1000));
    expect(view.getByText("1 of 2")).toBeTruthy();
    expect(submit).not.toHaveBeenCalled();
    fireEvent.click(view.getByRole("button", { name: "Next" }));
    expect(view.getByText("2 of 2")).toBeTruthy();
    expect(
      view.getByRole("button", {
        name:
          method === "multiple choices"
            ? "Rule? 1 2 selected"
            : "Rule? 1 Custom rule",
      }),
    ).toBeTruthy();
  },
);
