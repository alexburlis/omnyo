// @vitest-environment jsdom

import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import {
  installNativeShellForTest,
  removeNativeShellForTest,
} from "@/test/native-shell-test-utils";
import { QuestionForm } from "./question-form";
import {
  BottomAnchorContext,
  type BottomAnchorContextValue,
} from "./bottom-anchored-scroll-body";

vi.mock("@omnyo/shared-ui/icon", () => ({ Icon: () => null }));

const questions = [
  {
    id: "answer",
    prompt: "Give an answer",
    shortLabel: "Answer",
    options: [],
    multiSelect: false,
    allowFreeText: true,
  },
];

afterEach(() => {
  cleanup();
  removeNativeShellForTest();
  localStorage.clear();
});

it("pulses once for each changed choice", () => {
  const shell = installNativeShellForTest();

  const firstQuestion = {
    id: "single",
    prompt: "Give an answer",
    shortLabel: "Answer",
    allowFreeText: true,
    multiSelect: false,
    options: [
      { value: "first", label: "First option" },
      { value: "second", label: "Second option" },
    ],
  };

  render(
    <QuestionForm
      questions={[firstQuestion]}
      disabled={false}
      cancelDisabled={false}
      onSubmit={() => Promise.resolve()}
      onCancel={() => {}}
    />,
  );

  const choice = screen.getByRole("radio", { name: "First option" });
  fireEvent.click(choice);
  expect(choice.getAttribute("aria-checked")).toBe("true");
  expect(shell.messages()).toEqual([{ type: "haptic", kind: "selection" }]);

  fireEvent.click(choice);
  expect(shell.messages()).toHaveLength(1);

  fireEvent.click(screen.getByRole("radio", { name: "Second option" }));
  expect(shell.messages()).toHaveLength(2);
});

it.each(["click", "shortcut"] as const)(
  "acknowledges %s immediately, prevents duplicates and retains a failed draft for retry",
  async (method) => {
    let reject!: (cause: Error) => void;

    const request = new Promise<void>((_, fail) => {
      reject = fail;
    });

    const submit = vi
      .fn()
      .mockReturnValueOnce(request)
      .mockResolvedValue(undefined);

    render(
      <QuestionForm
        questions={questions}
        draftKey="answer-fixture"
        disabled={false}
        cancelDisabled={false}
        onSubmit={submit}
        onCancel={() => {}}
      />,
    );
    const input = screen.getByRole("textbox", { name: "Answer answer" });
    const button = screen.getByRole("button", { name: "Submit answer" });
    fireEvent.change(input, { target: { value: "Keep my answer" } });

    if (method === "click") fireEvent.click(button);
    else fireEvent.keyDown(input, { key: "Enter", metaKey: true });
    expect(screen.getByRole("status").textContent).toContain("Sending answer");
    expect(screen.queryByRole("textbox")).toBeNull();
    fireEvent.click(button);
    fireEvent.keyDown(input, { key: "Enter", metaKey: true });
    expect(submit).toHaveBeenCalledTimes(1);
    await act(async () => reject(new Error("offline")));
    expect(screen.getByRole("textbox")).toHaveProperty(
      "value",
      "Keep my answer",
    );
    expect(
      localStorage.getItem("omnyo.question-draft.v1:answer-fixture"),
    ).not.toBeNull();
    await act(async () =>
      fireEvent.click(screen.getByRole("button", { name: "Submit answer" })),
    );
    expect(submit).toHaveBeenCalledTimes(2);
    expect(
      localStorage.getItem("omnyo.question-draft.v1:answer-fixture"),
    ).toBeNull();
  },
);

it("clears a delivered draft after leaving the form", async () => {
  let resolve!: () => void;

  const request = new Promise<void>((done) => {
    resolve = done;
  });

  const view = render(
    <QuestionForm
      questions={questions}
      draftKey="answer-away"
      disabled={false}
      cancelDisabled={false}
      onSubmit={() => request}
      onCancel={() => {}}
    />,
  );

  fireEvent.change(screen.getByRole("textbox"), {
    target: { value: "Deliver while away" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Submit answer" }));
  view.unmount();
  expect(
    localStorage.getItem("omnyo.question-draft.v1:answer-away"),
  ).not.toBeNull();
  await act(async () => resolve());
  expect(
    localStorage.getItem("omnyo.question-draft.v1:answer-away"),
  ).toBeNull();
});

it("reads a legacy draft through, writes only the new key and clears both", async () => {
  const legacyKey = "bb.question-draft.v1:legacy-answer";
  const storageKey = "omnyo.question-draft.v1:legacy-answer";

  const stored = {
    version: 1,
    signature: JSON.stringify(questions),
    currentIndex: 0,
    formState: Object.fromEntries(
      questions.map((question) => [
        question.id,
        { selected: [], otherSelected: true, otherText: "Typed before" },
      ]),
    ),
  };

  localStorage.setItem(legacyKey, JSON.stringify(stored));

  const view = render(
    <QuestionForm
      questions={questions}
      draftKey="legacy-answer"
      disabled={false}
      cancelDisabled={false}
      onSubmit={() => Promise.resolve()}
      onCancel={() => {}}
    />,
  );

  expect(screen.getByRole<HTMLTextAreaElement>("textbox").value).toBe(
    "Typed before",
  );
  expect(localStorage.getItem(storageKey)).toBeNull();

  fireEvent.change(screen.getByRole("textbox"), {
    target: { value: "Typed after" },
  });

  expect(localStorage.getItem(storageKey)).toContain("Typed after");
  expect(localStorage.getItem(legacyKey)).toBe(JSON.stringify(stored));

  fireEvent.click(screen.getByRole("button", { name: "Submit answer" }));
  await waitFor(() => expect(localStorage.getItem(storageKey)).toBeNull());
  expect(localStorage.getItem(legacyKey)).toBeNull();
  view.unmount();
});

it("restores an answer saved with the former recommended option label", () => {
  const question = {
    ...questions[0],
    id: "recommendation",
    prompt: "Choose a layout",
    shortLabel: "Layout",
    options: [{ value: "compact", label: "Compact", recommended: true }],
  };

  const draftKey = "recommendation";
  const selected = ["compact"];

  localStorage.setItem(
    `omnyo.question-draft.v1:${draftKey}`,
    JSON.stringify({
      version: 2,
      questions: {
        recommendation: JSON.stringify({
          ...question,
          options: [{ value: "compact", label: "Compact (Recommended)" }],
        }),
      },
      currentIndex: 0,
      currentQuestionId: question.id,
      formState: {
        recommendation: { selected, otherSelected: false, otherText: "" },
      },
    }),
  );

  render(
    <QuestionForm
      questions={[question]}
      draftKey={draftKey}
      disabled={false}
      cancelDisabled={false}
      onSubmit={() => {}}
      onCancel={() => {}}
    />,
  );
  expect(
    screen
      .getByRole("radio", { name: "Compact, recommended" })
      .getAttribute("aria-checked"),
  ).toBe("true");
});

it.each(["Submit answer", "Cancel"])(
  "returns the chat to the latest message on %s",
  async (action) => {
    const scrollToBottom = vi.fn();

    const bottomAnchor: BottomAnchorContextValue = {
      getScrollElement: () => null,
      isAtBottom: false,
      scrollToBottom,
      scrollElementIntoView: () => {},
      scrollElementIntoViewClampedToMaxScroll: () => {},
      holdContentPosition: () => {},
    };

    render(
      <BottomAnchorContext.Provider value={bottomAnchor}>
        <QuestionForm
          questions={questions}
          draftKey="answer-follow"
          disabled={false}
          cancelDisabled={false}
          onSubmit={() => Promise.resolve()}
          onCancel={() => Promise.resolve()}
        />
      </BottomAnchorContext.Provider>,
    );

    fireEvent.change(screen.getByRole("textbox"), {
      target: { value: "Follow after answering" },
    });
    await act(async () =>
      fireEvent.click(screen.getByRole("button", { name: action })),
    );
    expect(scrollToBottom).toHaveBeenCalledTimes(1);
  },
);
