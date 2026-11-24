// @vitest-environment jsdom

import { QueryClient } from "@tanstack/react-query";
import { afterEach, describe, expect, it } from "vitest";
import {
  makeThreadResponse,
  makeThreadTimelineResponse,
} from "@/test/fixtures/thread-responses";
import {
  threadDetailBootstrapQueryKey,
  threadOpenRuntimeIdentityQueryKey,
  threadTimelineQueryKey,
} from "../queries/query-keys";
import {
  hasThreadOpenDisplay,
  rememberThreadOpenRuntimeId,
} from "./thread-open-cache-owner";
import { seedThreadOpenSnapshot } from "./thread-open-snapshots";

const clients: QueryClient[] = [];

function client() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });

  clients.push(queryClient);

  return queryClient;
}

function record(overrides: { runtimeId?: string; archivedAt?: number } = {}) {
  const runtimeId = overrides.runtimeId ?? "runtime";

  return {
    schema: 2 as const,
    key: `${window.location.origin}\u0000thread`,
    origin: window.location.origin,
    threadId: "thread",
    runtimeId,
    savedAt: 1_000,
    bootstrap: {
      ...makeThreadResponse({
        id: "thread",
        projectId: "project",
        archivedAt: overrides.archivedAt ?? null,
      }),
      environment: null,
      host: null,
    },
    timeline: makeThreadTimelineResponse({ runtimeId, maxSeq: 12 }),
  };
}

afterEach(() => {
  for (const queryClient of clients.splice(0)) queryClient.clear();
});

describe("thread open snapshots", () => {
  it("makes a persisted chat displayable before any network read and marks it for refresh", () => {
    const queryClient = client();

    expect(seedThreadOpenSnapshot(queryClient, "thread", record())).toBe(true);
    expect(hasThreadOpenDisplay(queryClient, "project", "thread")).toBe(true);
    expect(
      queryClient.getQueryState(threadTimelineQueryKey("thread"))
        ?.isInvalidated,
    ).toBe(true);
    expect(
      queryClient.getQueryState(threadDetailBootstrapQueryKey("thread"))
        ?.isInvalidated,
    ).toBe(true);
  });

  it("lets hidden chats render before the server identity read by recording the snapshot runtime as already stale", () => {
    const queryClient = client();
    seedThreadOpenSnapshot(queryClient, "thread", record());

    const identity = queryClient.getQueryState(
      threadOpenRuntimeIdentityQueryKey(),
    );

    expect(identity?.data).toBe("runtime");
    expect(identity?.dataUpdatedAt).toBe(1_000);
  });

  it("ignores a snapshot from a server runtime the client already knows is gone", () => {
    const queryClient = client();
    rememberThreadOpenRuntimeId(queryClient, "newer-runtime");

    expect(seedThreadOpenSnapshot(queryClient, "thread", record())).toBe(false);
    expect(
      queryClient.getQueryData(threadTimelineQueryKey("thread")),
    ).toBeUndefined();
  });

  it("never replaces data that was already loaded", () => {
    const queryClient = client();

    const live = makeThreadTimelineResponse({
      runtimeId: "runtime",
      maxSeq: 40,
    });

    queryClient.setQueryData(threadTimelineQueryKey("thread"), live);

    expect(seedThreadOpenSnapshot(queryClient, "thread", record())).toBe(false);
    expect(queryClient.getQueryData(threadTimelineQueryKey("thread"))).toBe(
      live,
    );
  });

  it("drops archived or malformed snapshots", () => {
    const queryClient = client();

    expect(
      seedThreadOpenSnapshot(queryClient, "thread", record({ archivedAt: 5 })),
    ).toBe(false);
    expect(
      seedThreadOpenSnapshot(queryClient, "thread", {
        ...record(),
        timeline: { rows: "not rows" },
      }),
    ).toBe(false);
    expect(
      queryClient.getQueryData(threadDetailBootstrapQueryKey("thread")),
    ).toBeUndefined();
  });
});
