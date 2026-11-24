// @vitest-environment jsdom
import type { ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import type { Host, ThreadStatus } from "@omnyo/domain";
import type { SendMessageRequest } from "@omnyo/server-contract";
import {
  makeEnvironment,
  makeHost,
  makeThreadListEntry,
} from "@omnyo/test-helpers/domain-fixtures";
import {
  environmentQueryKey,
  hostsQueryKey,
  systemAppUpdateQueryKey,
  threadQueryKey,
} from "./queries/query-keys";
import { usePredictedSendWait } from "./usePredictedSendWait";

afterEach(cleanup);

function renderPrediction(
  queryClient: QueryClient,
  enabled = true,
  mode: SendMessageRequest["mode"] = "queue-if-active",
) {
  return renderHook(
    () =>
      usePredictedSendWait({
        enabled,
        mode,
        threadId: "thread-1",
      }),
    {
      wrapper: ({ children }: { children: ReactNode }) => (
        <QueryClientProvider client={queryClient}>
          {children}
        </QueryClientProvider>
      ),
    },
  );
}

function seedThreadOnHost(status: ThreadStatus, host: Partial<Host> = {}) {
  const queryClient = new QueryClient();

  queryClient.setQueryData(
    threadQueryKey("thread-1"),
    makeThreadListEntry({
      id: "thread-1",
      status,
      environmentId: "env_test",
    }),
  );
  queryClient.setQueryData(environmentQueryKey("env_test"), makeEnvironment());
  queryClient.setQueryData(hostsQueryKey(), [
    makeHost({ name: "Mac Pro", ...host }),
  ]);

  return queryClient;
}

it("announces a queue as soon as an Omnyo update starts holding new turns", () => {
  const queryClient = new QueryClient();

  queryClient.setQueryData(
    threadQueryKey("thread-1"),
    makeThreadListEntry({ id: "thread-1", status: "idle" }),
  );

  const { result } = renderPrediction(queryClient);

  expect(result.current).toBeNull();

  act(() => {
    queryClient.setQueryData(systemAppUpdateQueryKey(), {
      newTurnsPausedForUpdate: true,
    });
  });

  expect(result.current).toEqual({ kind: "server-update" });

  act(() => {
    queryClient.setQueryData(systemAppUpdateQueryKey(), {
      newTurnsPausedForUpdate: false,
    });
  });

  expect(result.current).toBeNull();
});

it("stays quiet while the composer has nothing to send", () => {
  const queryClient = new QueryClient();

  queryClient.setQueryData(systemAppUpdateQueryKey(), {
    newTurnsPausedForUpdate: true,
  });

  const { result } = renderPrediction(queryClient, false);

  expect(result.current).toBeNull();
});

it("announces a queue when the chat's machine is set to Away and clears it when it is back", () => {
  const queryClient = seedThreadOnHost("idle");
  const { result } = renderPrediction(queryClient);

  expect(result.current).toBeNull();

  act(() => {
    queryClient.setQueryData(hostsQueryKey(), [
      makeHost({ name: "Mac Pro", availability: "away" }),
    ]);
  });

  expect(result.current).toEqual({ kind: "host-away", hostName: "Mac Pro" });

  act(() => {
    queryClient.setQueryData(hostsQueryKey(), [makeHost({ name: "Mac Pro" })]);
  });

  expect(result.current).toBeNull();
});

it.each([
  ["disconnected", { status: "disconnected" }],
  [
    "suspended",
    {
      lifecycle: {
        phase: "suspended",
        suspendedAt: 1,
        message: null,
        pendingLog: "",
        teardown: null,
      },
    },
  ],
] as const)(
  "announces a queue when the chat's machine is %s",
  (_label, host) => {
    const { result } = renderPrediction(seedThreadOnHost("idle", host));

    expect(result.current).toEqual({
      kind: "host-offline",
      hostName: "Mac Pro",
    });
  },
);

it("names the offline machine for a follow-up queued behind a running turn", () => {
  const { result } = renderPrediction(
    seedThreadOnHost("active", { status: "disconnected" }),
  );

  expect(result.current).toEqual({ kind: "host-offline", hostName: "Mac Pro" });
});

it("does not promise a queue for a steer the server refuses while the machine is offline", () => {
  const { result } = renderPrediction(
    seedThreadOnHost("active", { status: "disconnected" }),
    true,
    "steer",
  );

  expect(result.current).toBeNull();
});
