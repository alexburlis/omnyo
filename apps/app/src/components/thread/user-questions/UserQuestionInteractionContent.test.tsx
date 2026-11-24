// @vitest-environment jsdom

import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { PendingInteraction } from "@omnyo/domain";
import { afterEach, expect, it, vi } from "vitest";
import { sdk } from "@/lib/sdk";
import { UserQuestionAnswerForm } from "./UserQuestionInteractionContent";

vi.mock("@omnyo/shared-ui/icon", () => ({ Icon: () => null }));

vi.mock("@/lib/sdk", () => ({
  sdk: { threads: { interactions: { resolve: vi.fn() } } },
}));

vi.mock("@/hooks/queries/thread-queries", () => ({
  useThread: () => ({ data: undefined }),
}));

vi.mock("@/hooks/queries/environment-queries", () => ({
  useEnvironment: () => ({ data: undefined }),
}));

vi.mock("@/hooks/queries/host-queries", () => ({
  useHosts: () => ({ data: [] }),
}));

vi.mock("@/hooks/mutations/thread-runtime-mutations", () => ({
  useStopThread: () => ({ isPending: false, mutateAsync: vi.fn() }),
}));

const questions = [
  {
    id: "q0",
    prompt: "What should we do?",
    shortLabel: "Direction",
    multiSelect: false,
    allowFreeText: true,
    options: [],
  },
];

function createDeferredPromise<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;

  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });

  return { promise, resolve, reject };
}

function form(
  client: QueryClient,
  threadId = "thr_one",
  interactionId = "pint_one",
) {
  return (
    <QueryClientProvider client={client}>
      <UserQuestionAnswerForm
        threadId={threadId}
        interactionId={interactionId}
        isResolving={false}
        questions={questions}
      />
    </QueryClientProvider>
  );
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.clearAllMocks();
  localStorage.clear();
});

it("keeps an answer pending across chat switches without locking another question", async () => {
  const client = new QueryClient({
    defaultOptions: { mutations: { retry: false } },
  });

  const request = createDeferredPromise<PendingInteraction>();

  const resolve = vi
    .spyOn(sdk.threads.interactions, "resolve")
    .mockReturnValue(request.promise);

  const view = render(form(client));
  fireEvent.change(screen.getByLabelText("Direction answer"), {
    target: { value: "Keep going" },
  });
  fireEvent.click(screen.getByRole("button", { name: /submit answer/i }));
  await waitFor(() => expect(resolve).toHaveBeenCalledTimes(1));
  view.rerender(form(client, "thr_two", "pint_two"));
  expect(screen.getByLabelText("Direction answer")).toHaveProperty(
    "disabled",
    false,
  );
  view.rerender(form(client));
  expect(screen.getByRole("status").textContent).toContain("Sending answer");
  expect(
    screen.queryByRole("textbox", { name: "Direction answer" }),
  ).toBeNull();
  expect(resolve).toHaveBeenCalledExactlyOnceWith({
    threadId: "thr_one",
    interactionId: "pint_one",
    resolution: {
      kind: "user_answer",
      answers: { q0: { selected: [], freeText: "Keep going" } },
    },
  });
  await act(async () => request.reject(new Error("Delivery failed")));
  client.clear();
});

it("restores a failed answer and its error after leaving the chat", async () => {
  const client = new QueryClient({
    defaultOptions: { mutations: { retry: false } },
  });

  const request = createDeferredPromise<PendingInteraction>();
  vi.spyOn(sdk.threads.interactions, "resolve").mockReturnValue(
    request.promise,
  );
  const view = render(form(client));
  fireEvent.change(screen.getByLabelText("Direction answer"), {
    target: { value: "Keep my answer" },
  });
  fireEvent.keyDown(screen.getByLabelText("Direction answer"), {
    key: "Enter",
    metaKey: true,
  });
  await waitFor(() =>
    expect(sdk.threads.interactions.resolve).toHaveBeenCalledTimes(1),
  );
  view.unmount();
  await act(async () => request.reject(new Error("Delivery failed")));
  render(form(client));
  expect(await screen.findByText("Delivery failed")).toBeTruthy();
  expect(screen.getByLabelText("Direction answer")).toHaveProperty(
    "value",
    "Keep my answer",
  );
  expect(screen.getByRole("button", { name: /submit answer/i })).toHaveProperty(
    "disabled",
    false,
  );
  expect(
    localStorage.getItem("omnyo.question-draft.v1:thr_one:pint_one"),
  ).not.toBeNull();
  client.clear();
});
