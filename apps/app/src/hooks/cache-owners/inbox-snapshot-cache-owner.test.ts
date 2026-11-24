import { QueryClient, QueryObserver } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { InboxSnapshot } from "@omnyo/domain";
import {
  INBOX_SNAPSHOT_QUERY_KEY,
  INBOX_SNAPSHOT_QUERY_POLICY,
  fetchInboxSnapshot,
  inboxServerRevision,
  markInboxSnapshotDirty,
  inboxSnapshotState,
  predictInboxSnapshot,
  readPredictedInboxSnapshot,
  subscribeInboxSnapshot,
} from "./inbox-snapshot-cache-owner";
import { REALTIME_THREAD_CHANGE_REGISTRY } from "./realtime-cache-registry";

afterEach(() => vi.useRealTimers());

describe("shared Inbox snapshot", () => {
  it("registers attention changes, excluding session settings and timeline-only messages", () => {
    for (const [kind, entry] of Object.entries(
      REALTIME_THREAD_CHANGE_REGISTRY,
    )) {
      expect(
        entry.dirty.some((handler) => handler.name === "dirtyInboxSnapshot"),
        kind,
      ).toBe(
        !["execution-changed", "events-appended", "history-compacted"].includes(
          kind,
        ),
      );
    }
  });

  it("refreshes in the next task, coalescing changes and retaining a trailing refresh while a request is in flight", async () => {
    vi.useFakeTimers();
    const client = new QueryClient();
    let finish: (() => void) | undefined;
    const fetch = vi.fn().mockResolvedValue("initial");

    const observer = new QueryObserver(client, {
      queryKey: INBOX_SNAPSHOT_QUERY_KEY,
      queryFn: fetch,
      ...INBOX_SNAPSHOT_QUERY_POLICY,
    });

    const unsubscribe = observer.subscribe(() => {});
    await vi.advanceTimersByTimeAsync(0);
    fetch.mockImplementationOnce(
      () =>
        new Promise<string>((resolve) => {
          finish = () => resolve("refreshed");
        }),
    );
    markInboxSnapshotDirty(client);
    markInboxSnapshotDirty(client);
    expect(fetch).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(0);
    expect(fetch).toHaveBeenCalledTimes(2);
    markInboxSnapshotDirty(client);
    await vi.advanceTimersByTimeAsync(500);
    expect(fetch).toHaveBeenCalledTimes(2);
    finish?.();
    await vi.advanceTimersByTimeAsync(0);
    expect(fetch).toHaveBeenCalledTimes(3);
    unsubscribe();
    client.clear();
  });

  it("retries errors while preserving the prior snapshot as stale", async () => {
    vi.useFakeTimers();
    const client = new QueryClient();
    const fetch = vi.fn().mockResolvedValue("last snapshot");

    const observer = new QueryObserver(client, {
      queryKey: INBOX_SNAPSHOT_QUERY_KEY,
      queryFn: fetch,
      ...INBOX_SNAPSHOT_QUERY_POLICY,
    });

    const unsubscribe = observer.subscribe(() => {});
    await vi.advanceTimersByTimeAsync(0);
    fetch.mockRejectedValue(new Error("offline"));
    const refresh = observer.refetch();
    await vi.advanceTimersByTimeAsync(8_000);
    await refresh;
    expect(fetch).toHaveBeenCalledTimes(5);
    expect(inboxSnapshotState(observer.getCurrentResult())).toEqual({
      snapshot: "last snapshot",
      status: "error",
      stale: true,
    });
    expect(INBOX_SNAPSHOT_QUERY_POLICY.refetchOnWindowFocus).toBe(true);
    expect(INBOX_SNAPSHOT_QUERY_POLICY.refetchOnReconnect).toBe(true);
    unsubscribe();
    client.clear();
  });

  it("shows a prediction at once and keeps it until a fetch that started after the server confirmed", async () => {
    vi.useFakeTimers();
    const client = new QueryClient();

    const server = (revision: string, titles: string[]): InboxSnapshot => ({
      revision,
      generatedAt: 0,
      inbox: titles.map((title) => ({
        threadId: title,
        projectId: "proj",
        title,
        shelved: false,
        automationId: null,
        state: "finished",
        reason: { kind: "none", text: "", threadId: title },
        recap: null,
        archiveReady: false,
        optionalQuestion: null,
        pendingResults: 0,
        view: "inbox",
        card: null,
        waiting: null,
        running: null,
        runs: null,
        incident: null,
        sortAt: 0,
        latch: "inbox",
      })),
      waiting: [],
      running: [],
      shelf: [],
      counts: {
        needsYou: 0,
        inbox: titles.length,
        questions: 0,
        running: 0,
        waiting: 0,
        onYou: [],
        nextBackAt: null,
      },
      lastMove: null,
    });

    const responses: ((snapshot: InboxSnapshot) => void)[] = [];

    const observer = new QueryObserver(client, {
      queryKey: INBOX_SNAPSHOT_QUERY_KEY,
      queryFn: () =>
        fetchInboxSnapshot(
          client,
          () =>
            new Promise<InboxSnapshot>((resolve) => responses.push(resolve)),
        ),
      ...INBOX_SNAPSHOT_QUERY_POLICY,
    });

    const unsubscribe = observer.subscribe(() => {});
    const notified = vi.fn();
    const unsubscribeStore = subscribeInboxSnapshot(client, notified);
    responses.shift()?.(server("r1", ["a", "b"]));
    await vi.advanceTimersByTimeAsync(0);

    const titles = () =>
      readPredictedInboxSnapshot(client)?.inbox.map((entry) => entry.title);

    const prediction = predictInboxSnapshot(client, (snapshot) => ({
      ...snapshot,
      inbox: snapshot.inbox.filter((entry) => entry.threadId !== "a"),
    }));

    expect(titles()).toEqual(["b"]);
    expect(notified).toHaveBeenCalled();
    expect(readPredictedInboxSnapshot(client)).toBe(
      readPredictedInboxSnapshot(client),
    );
    const predictedRevision = readPredictedInboxSnapshot(client)?.revision;
    expect(predictedRevision).not.toBe("r1");
    expect(inboxServerRevision(predictedRevision ?? "")).toBe("r1");

    void observer.refetch();
    await vi.advanceTimersByTimeAsync(0);
    prediction.settle();
    responses.shift()?.(server("r2", ["a", "b"]));
    await vi.advanceTimersByTimeAsync(0);
    expect(titles()).toEqual(["b"]);

    await vi.advanceTimersByTimeAsync(0);
    responses.shift()?.(server("r3", ["b"]));
    await vi.advanceTimersByTimeAsync(0);
    expect(titles()).toEqual(["b"]);
    expect(readPredictedInboxSnapshot(client)?.revision).toBe("r3");

    const discarded = predictInboxSnapshot(client, (snapshot) => ({
      ...snapshot,
      inbox: [],
    }));

    expect(titles()).toEqual([]);
    discarded.discard();
    expect(titles()).toEqual(["b"]);
    unsubscribeStore();
    unsubscribe();
    client.clear();
  });
});
