// @vitest-environment jsdom

import { act, cleanup, render, screen } from "@testing-library/react";
import {
  MutationObserver,
  QueryClient,
  QueryClientProvider,
  useMutation,
} from "@tanstack/react-query";
import { useState } from "react";
import { afterEach, expect, it, vi } from "vitest";
import {
  nativeQuestionSubmissionKey,
  useNativeQuestionSubmission,
} from "./native-question-submissions";

const submissionKey = nativeQuestionSubmissionKey("thr_one", [
  { id: "question-1", revision: 1 },
]);

function Submission() {
  const state = useNativeQuestionSubmission(submissionKey);

  return <p>{state?.status ?? "idle"}</p>;
}

function UnrelatedMutation() {
  useMutation({ mutationFn: () => Promise.resolve() });

  return null;
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

it("does not re-render the question form while another component mounts a mutation", () => {
  const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
  const client = new QueryClient();
  let showUnrelated = () => {};

  function Tree() {
    const [unrelated, setUnrelated] = useState(false);
    showUnrelated = () => setUnrelated(true);

    return (
      <>
        {unrelated ? <UnrelatedMutation /> : null}
        <Submission />
      </>
    );
  }

  render(
    <QueryClientProvider client={client}>
      <Tree />
    </QueryClientProvider>,
  );

  const submit = new MutationObserver(client, {
    mutationKey: submissionKey,
    mutationFn: () => new Promise<void>(() => {}),
  });

  act(() => {
    void submit.mutate();
    showUnrelated();
  });

  expect(screen.getByText("pending")).toBeTruthy();
  expect(
    consoleError.mock.calls.some((call) =>
      String(call[0]).includes("Cannot update a component"),
    ),
  ).toBe(false);
});
