// @vitest-environment jsdom

import { cleanup, render, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, expect, it, vi } from "vitest";
import type {
  ThreadAttentionSnapshot,
  ThreadCallback,
  ThreadChangeKind,
} from "@omnyo/domain";
import { sdk } from "@/lib/sdk";
import { useThreadAttentionCache } from "./thread-attention";
import { threadAttentionQueryKey } from "../cache-owners/thread-attention-cache-owner";

const listeners = vi.hoisted(() => ({
  changed: [] as Array<(message: unknown) => void>,
}));

vi.mock("@/lib/sdk", () => ({
  sdk: { experimental_attention: { snapshot: vi.fn() } },
}));

vi.mock("@/lib/ws", () => ({
  wsManager: {
    onChanged: (callback: (message: unknown) => void) => {
      listeners.changed.push(callback);

      return () => {};
    },
    onConnected: () => () => {},
    onResumed: () => () => {},
  },
}));

vi.mock("@/components/thread/ThreadInitialLoad", () => ({
  useThreadInitialLoadPending: () => {},
}));

function AttentionCache() {
  useThreadAttentionCache();

  return null;
}

function send(
  changes: ThreadChangeKind[],
  metadata?: { attentionItems: ThreadAttentionSnapshot },
) {
  for (const callback of listeners.changed)
    callback({
      type: "changed",
      entity: "thread",
      id: "thr_one",
      changes,
      ...(metadata ? { metadata } : {}),
    });
}

function callbackFor(threadId: string, id: string): ThreadCallback {
  return {
    id,
    threadId,
    sourceThreadId: null,
    sourceTitle: "",
    reason: "Waiting for the build",
    createdAt: 1,
    afterSeq: 0,
    matchText: "build done",
    sourceState: "working",
  };
}

function renderAttentionCache(client: QueryClient) {
  render(
    <QueryClientProvider client={client}>
      <AttentionCache />
    </QueryClientProvider>,
  );
}

afterEach(() => {
  cleanup();
  listeners.changed.length = 0;
  vi.clearAllMocks();
});

it("refetches native attention only when a change cannot be applied from its message", async () => {
  const snapshot = vi.mocked(sdk.experimental_attention.snapshot);
  snapshot.mockResolvedValue({ questions: [], callbacks: [] });

  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });

  renderAttentionCache(client);
  await waitFor(() => expect(snapshot).toHaveBeenCalledTimes(1));
  send(["events-appended"]);
  send(["status-changed"]);
  send(["title-changed", "queue-changed", "read-state-changed"]);
  send(["interactions-changed"]);
  send(["thread-deleted"]);
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(snapshot).toHaveBeenCalledTimes(1);

  send(["events-appended", "archived-changed"]);
  await waitFor(() => expect(snapshot).toHaveBeenCalledTimes(2));
});

it("applies a thread's attention items from the realtime message", async () => {
  const snapshot = vi.mocked(sdk.experimental_attention.snapshot);
  snapshot.mockResolvedValue({
    questions: [],
    callbacks: [callbackFor("thr_one", "old"), callbackFor("thr_two", "kept")],
  });

  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });

  renderAttentionCache(client);
  await waitFor(() =>
    expect(client.getQueryData(threadAttentionQueryKey)).toBeDefined(),
  );

  send(["interactions-changed"], {
    attentionItems: {
      questions: [],
      callbacks: [callbackFor("thr_one", "new")],
    },
  });

  expect(
    client
      .getQueryData<ThreadAttentionSnapshot>(threadAttentionQueryKey)
      ?.callbacks.map((callback) => callback.id),
  ).toEqual(["kept", "new"]);

  send(["thread-deleted"]);

  expect(
    client
      .getQueryData<ThreadAttentionSnapshot>(threadAttentionQueryKey)
      ?.callbacks.map((callback) => callback.id),
  ).toEqual(["kept"]);
  expect(snapshot).toHaveBeenCalledTimes(1);
});
