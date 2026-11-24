// @vitest-environment jsdom

import { QueryClient } from "@tanstack/react-query";
import type { TimelineUserConversationRow } from "@omnyo/server-contract";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OmnyoHttpError } from "@/lib/sdk";
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
  clearPersistedThreadTimelineDisplays,
  hasThreadOpenDisplay,
  peekPersistedThreadTimelineDisplay,
  readPersistedThreadTimelineDisplay,
  rememberThreadOpenRuntimeId,
  rememberThreadTimelineRuntimeId,
  schedulePersistedThreadTimelineDisplay,
  THREAD_OPEN_CACHE_MAX_THREADS,
  THREAD_TIMELINE_DISPLAY_CACHE_MAX_TOTAL_BYTES,
  touchThreadOpenCache,
} from "./thread-open-cache-owner";

const clients: QueryClient[] = [];

function warmThread() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });

  clients.push(client);
  client.setQueryData(threadDetailBootstrapQueryKey("thread"), {
    ...makeThreadResponse({ id: "thread", projectId: "project" }),
    environment: null,
    host: null,
  });
  client.setQueryData(threadOpenRuntimeIdentityQueryKey(), "runtime");
  rememberThreadOpenRuntimeId(client, "runtime");
  rememberThreadTimelineRuntimeId(client, "thread", "runtime");

  return client;
}

afterEach(() => {
  for (const client of clients.splice(0)) client.clear();
});

describe("warm thread display admission", () => {
  it("admits a resolved empty timeline without waiting for another read", () => {
    const client = warmThread();
    client.setQueryData(
      threadTimelineQueryKey("thread"),
      makeThreadTimelineResponse({ runtimeId: "runtime" }),
    );

    expect(hasThreadOpenDisplay(client, "project", "thread")).toBe(true);
  });

  it("requires matching thread, project and runtime identities", () => {
    const client = warmThread();
    client.setQueryData(
      threadTimelineQueryKey("thread"),
      makeThreadTimelineResponse({ runtimeId: "runtime" }),
    );

    expect(hasThreadOpenDisplay(client, "another-project", "thread")).toBe(
      false,
    );
    expect(hasThreadOpenDisplay(client, "project", "another-thread")).toBe(
      false,
    );
    client.setQueryData(threadDetailBootstrapQueryKey("thread"), {
      ...makeThreadResponse({ id: "another-thread", projectId: "project" }),
      environment: null,
      host: null,
    });
    expect(hasThreadOpenDisplay(client, "project", "thread")).toBe(false);
  });

  it("rejects an old runtime while its new identity is being reconciled", () => {
    const client = warmThread();
    client.setQueryData(
      threadTimelineQueryKey("thread"),
      makeThreadTimelineResponse({ runtimeId: "runtime" }),
    );
    client.setQueryData(threadOpenRuntimeIdentityQueryKey(), "new-runtime");

    expect(hasThreadOpenDisplay(client, "project", "thread")).toBe(false);
  });

  it("rejects a response from another runtime when timeline metadata has not been recorded", () => {
    const client = new QueryClient();
    clients.push(client);
    client.setQueryData(threadDetailBootstrapQueryKey("thread"), {
      ...makeThreadResponse({ id: "thread", projectId: "project" }),
      environment: null,
      host: null,
    });
    client.setQueryData(threadOpenRuntimeIdentityQueryKey(), "runtime");
    client.setQueryData(
      threadTimelineQueryKey("thread"),
      makeThreadTimelineResponse({ runtimeId: "another-runtime" }),
    );

    expect(hasThreadOpenDisplay(client, "project", "thread")).toBe(false);
  });

  it.each(["bootstrap", "timeline"])(
    "rejects a confirmed %s not-found while stale data remains",
    async (kind) => {
      const client = warmThread();
      client.setQueryData(
        threadTimelineQueryKey("thread"),
        makeThreadTimelineResponse({ runtimeId: "runtime" }),
      );

      const queryKey =
        kind === "bootstrap"
          ? threadDetailBootstrapQueryKey("thread")
          : threadTimelineQueryKey("thread");

      await expect(
        client.fetchQuery({
          queryKey,
          staleTime: 0,
          queryFn: () =>
            Promise.reject(
              new OmnyoHttpError({
                status: 404,
                message: "Missing",
                code: null,
                body: null,
              }),
            ),
        }),
      ).rejects.toThrow();

      expect(hasThreadOpenDisplay(client, "project", "thread")).toBe(false);
    },
  );

  it("allows cached content after a visible refresh failure", async () => {
    const client = warmThread();
    client.setQueryData(
      threadTimelineQueryKey("thread"),
      makeThreadTimelineResponse({ runtimeId: "runtime" }),
    );
    await expect(
      client.fetchQuery({
        queryKey: threadTimelineQueryKey("thread"),
        staleTime: 0,
        queryFn: () => Promise.reject(new Error("Refresh failed")),
      }),
    ).rejects.toThrow("Refresh failed");

    expect(hasThreadOpenDisplay(client, "project", "thread")).toBe(true);
  });
});

describe("persisted display cache reads", () => {
  const scope = {
    origin: window.location.origin,
    runtimeId: "runtime",
    threadId: "thread",
  };

  function userRow(id: string): TimelineUserConversationRow {
    return {
      id,
      kind: "conversation",
      role: "user",
      threadId: "thread",
      turnId: null,
      sourceSeqStart: 1,
      sourceSeqEnd: 1,
      messageSeq: 1,
      startedAt: 1,
      createdAt: 1,
      text: id,
      mentions: [],
      attachments: null,
      initiator: "user",
      senderThreadId: null,
      systemMessageKind: "unlabeled",
      systemMessageSubject: null,
      turnRequest: {
        clientRequestId: null,
        isGrouped: false,
        kind: "message",
        status: "accepted",
      },
    };
  }

  function persist(rows: TimelineUserConversationRow[]) {
    const writes: Array<() => void> = [];
    vi.stubGlobal("requestIdleCallback", (callback: IdleRequestCallback) => {
      writes.push(() => callback({ didTimeout: true, timeRemaining: () => 0 }));

      return writes.length;
    });
    vi.stubGlobal("cancelIdleCallback", vi.fn());
    readPersistedThreadTimelineDisplay(scope);
    schedulePersistedThreadTimelineDisplay({
      ...scope,
      surfaceKey: "thread",
      response: {
        ...makeThreadTimelineResponse({ runtimeId: "runtime" }),
        rows,
        timelinePage: {
          ...makeThreadTimelineResponse().timelinePage,
          historySnapshot: "snapshot",
        },
      },
    });

    for (const write of writes) write();
    vi.unstubAllGlobals();
  }

  afterEach(() => {
    clearPersistedThreadTimelineDisplays();
  });

  it("follows storage rewritten by another tab between reads", () => {
    persist([userRow("first")]);
    expect(readPersistedThreadTimelineDisplay(scope)?.rows).toEqual([
      userRow("first"),
    ]);

    const stored = window.localStorage.getItem(
      "omnyo.threadTimelineDisplay.v1",
    );

    if (stored === null) throw new Error("Expected a persisted display");
    window.localStorage.setItem(
      "omnyo.threadTimelineDisplay.v1",
      stored.replaceAll('"first"', '"second"'),
    );

    expect(readPersistedThreadTimelineDisplay(scope)?.rows).toEqual([
      userRow("second"),
    ]);

    window.localStorage.removeItem("omnyo.threadTimelineDisplay.v1");
    expect(readPersistedThreadTimelineDisplay(scope)).toBeNull();
  });
});

describe("persisted display writes for opened chats", () => {
  const origin = window.location.origin;
  const storageKey = "omnyo.threadTimelineDisplay.v1";
  const idleWrites: Array<() => void> = [];

  function row(threadId: string, text: string): TimelineUserConversationRow {
    return {
      id: `${threadId}:row`,
      kind: "conversation",
      role: "user",
      threadId,
      turnId: null,
      sourceSeqStart: 1,
      sourceSeqEnd: 1,
      messageSeq: 1,
      startedAt: 1,
      createdAt: 1,
      text,
      mentions: [],
      attachments: null,
      initiator: "user",
      senderThreadId: null,
      systemMessageKind: "unlabeled",
      systemMessageSubject: null,
      turnRequest: {
        clientRequestId: null,
        isGrouped: false,
        kind: "message",
        status: "accepted",
      },
    };
  }

  function schedule(
    threadId: string,
    runtimeId: string,
    text: string,
    queryClient?: QueryClient,
  ) {
    schedulePersistedThreadTimelineDisplay({
      origin,
      runtimeId,
      threadId,
      surfaceKey: threadId,
      queryClient,
      response: {
        ...makeThreadTimelineResponse({ runtimeId }),
        rows: [row(threadId, text)],
        timelinePage: {
          ...makeThreadTimelineResponse().timelinePage,
          historySnapshot: `${threadId}-snapshot`,
        },
      },
    });

    for (const write of idleWrites.splice(0)) write();
  }

  beforeEach(() => {
    idleWrites.length = 0;
    vi.stubGlobal("requestIdleCallback", (callback: IdleRequestCallback) => {
      idleWrites.push(() =>
        callback({ didTimeout: true, timeRemaining: () => 0 }),
      );

      return idleWrites.length;
    });
    vi.stubGlobal("cancelIdleCallback", vi.fn());
    clearPersistedThreadTimelineDisplays();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    clearPersistedThreadTimelineDisplays();
  });

  it("writes the current runtime's display although storage still names the previous runtime", () => {
    readPersistedThreadTimelineDisplay({
      origin,
      runtimeId: "runtime-old",
      threadId: "opened",
    });
    schedule("opened", "runtime-old", "before restart");

    const client = new QueryClient();
    clients.push(client);
    schedule("opened", "runtime-new", "unverified write");
    expect(
      peekPersistedThreadTimelineDisplay({ origin, threadId: "opened" })?.rows,
    ).toEqual([row("opened", "before restart")]);

    rememberThreadOpenRuntimeId(client, "runtime-new");
    schedule("opened", "runtime-new", "after restart", client);
    expect(
      peekPersistedThreadTimelineDisplay({ origin, threadId: "opened" })?.rows,
    ).toEqual([row("opened", "after restart")]);
  });

  it("keeps an opened chat's display when the in-memory thread cache evicts it", () => {
    const client = new QueryClient();
    clients.push(client);
    rememberThreadOpenRuntimeId(client, "runtime");
    readPersistedThreadTimelineDisplay({
      origin,
      runtimeId: "runtime",
      threadId: "opened",
    });
    schedule("opened", "runtime", "opened chat", client);
    touchThreadOpenCache(client, "opened");

    for (let index = 0; index <= THREAD_OPEN_CACHE_MAX_THREADS; index += 1)
      touchThreadOpenCache(client, `browsed-${index}`);

    expect(
      peekPersistedThreadTimelineDisplay({ origin, threadId: "opened" })?.rows,
    ).toEqual([row("opened", "opened chat")]);
  });

  it("bounds stored displays by thread count and total bytes, keeping the most recent", () => {
    const client = new QueryClient();
    clients.push(client);
    rememberThreadOpenRuntimeId(client, "runtime");
    const text = "x".repeat(90 * 1024);
    const threadIds = Array.from({ length: 30 }, (_, index) => `chat-${index}`);

    for (const threadId of threadIds)
      schedule(threadId, "runtime", text, client);

    const stored = window.localStorage.getItem(storageKey) ?? "";

    expect(new TextEncoder().encode(stored).byteLength).toBeLessThanOrEqual(
      THREAD_TIMELINE_DISPLAY_CACHE_MAX_TOTAL_BYTES,
    );

    const retained = threadIds.filter(
      (threadId) =>
        peekPersistedThreadTimelineDisplay({ origin, threadId }) !== null,
    );

    expect(retained.length).toBeGreaterThan(0);
    expect(retained.length).toBeLessThanOrEqual(THREAD_OPEN_CACHE_MAX_THREADS);
    expect(retained).toEqual(threadIds.slice(-retained.length));
  });
});
