import { QueryClient, QueryObserver } from "@tanstack/react-query";
import { afterEach, expect, it, vi } from "vitest";
import type { InboxSnapshot } from "@omnyo/domain";
import { createDeferredPromise } from "@omnyo/test-helpers";
import { makeThreadListEntry } from "@omnyo/test-helpers/domain-fixtures";
import {
  makeProjectWithThreadsResponse,
  makeSidebarBootstrapResponse,
} from "@/test/fixtures/projects";
import { createRealtimeCacheEffects } from "../realtime-cache-effects";
import {
  sidebarNavigationQueryKey,
  projectPromptHistoryQueryKey,
  threadQueryKey,
} from "../queries/query-keys";
import {
  INBOX_SNAPSHOT_QUERY_KEY,
  fetchInboxSnapshot,
} from "./inbox-snapshot-cache-owner";
import { readSidebarNavigation } from "./query-cache";

function sidebar(ids: readonly string[]) {
  return makeSidebarBootstrapResponse({
    projects: [
      makeProjectWithThreadsResponse({
        id: "proj_test",
        threads: ids.map((id) =>
          makeThreadListEntry({ id, projectId: "proj_test" }),
        ),
      }),
    ],
  });
}

function inbox(ids: readonly string[]): InboxSnapshot {
  return {
    revision: ids.join(),
    generatedAt: 0,
    inbox: ids.map((threadId) => ({
      threadId,
      projectId: "proj_test",
      title: threadId,
      shelved: false,
      automationId: null,
      state: "finished",
      reason: { kind: "none", text: "", threadId },
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
      inbox: ids.length,
      questions: 0,
      running: 0,
      waiting: 0,
      onYou: [],
      nextBackAt: null,
    },
    lastMove: null,
  };
}

afterEach(() => vi.useRealTimers());

it.each([
  { operation: "archive", id: "thr_move", before: ["thr_move"], after: [] },
  { operation: "undo", id: "thr_move", before: [], after: ["thr_move"] },
  {
    operation: "global archive",
    primed: true,
    id: undefined,
    before: ["thr_move"],
    after: [],
  },
  { operation: "global undo", id: undefined, before: [], after: ["thr_move"] },
  {
    operation: "cold archive",
    primed: false,
    id: "thr_move",
    before: ["thr_move"],
    after: [],
  },
])(
  "supersedes held Sidebar and Inbox reads for $operation, even when stale transports ignore abort",
  async ({ id, before, after, primed = true }) => {
    vi.useFakeTimers();

    const client = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: Infinity } },
    });

    const effects = createRealtimeCacheEffects({ queryClient: client });
    const historyKey = projectPromptHistoryQueryKey("proj_test");
    const detailKey = threadQueryKey("thr_move");
    client.setQueryData(historyKey, []);
    client.setQueryData(
      detailKey,
      makeThreadListEntry({ id: "thr_move", projectId: "proj_test" }),
    );
    const staleSidebar = createDeferredPromise<ReturnType<typeof sidebar>>();
    const freshSidebar = createDeferredPromise<ReturnType<typeof sidebar>>();
    const staleInbox = createDeferredPromise<InboxSnapshot>();
    const freshInbox = createDeferredPromise<InboxSnapshot>();

    const sidebarSignals: AbortSignal[] = [],
      inboxSignals: AbortSignal[] = [];

    const readSidebar = vi.fn(({ signal }: { signal: AbortSignal }) => {
      sidebarSignals.push(signal);

      return readSidebarNavigation(
        client,
        () =>
          (sidebarSignals.length === 1 ? staleSidebar : freshSidebar).promise,
      );
    });

    const readInbox = vi.fn(({ signal }: { signal: AbortSignal }) => {
      inboxSignals.push(signal);

      return fetchInboxSnapshot(
        client,
        () => (inboxSignals.length === 1 ? staleInbox : freshInbox).promise,
      );
    });

    if (primed) {
      client.setQueryData(sidebarNavigationQueryKey(), sidebar(before));
      client.setQueryData(INBOX_SNAPSHOT_QUERY_KEY, inbox(before));
    }

    const stopSidebar = new QueryObserver(client, {
      queryKey: sidebarNavigationQueryKey(),
      queryFn: readSidebar,
      staleTime: Infinity,
    }).subscribe(() => {});

    const stopInbox = new QueryObserver(client, {
      queryKey: INBOX_SNAPSHOT_QUERY_KEY,
      queryFn: readInbox,
      staleTime: Infinity,
    }).subscribe(() => {});

    void client.refetchQueries({
      queryKey: sidebarNavigationQueryKey(),
      exact: true,
    });
    void client.refetchQueries({
      queryKey: INBOX_SNAPSHOT_QUERY_KEY,
      exact: true,
    });

    const localSidebar = {
      ...sidebar(before),
      orderedProjectIds: ["keep-local"],
    };

    const localInbox = { ...inbox(before), revision: "keep-local" };

    if (primed) {
      client.setQueryData(sidebarNavigationQueryKey(), localSidebar);
      client.setQueryData(INBOX_SNAPSHOT_QUERY_KEY, localInbox);
    }

    const cachedSidebar = client.getQueryData(sidebarNavigationQueryKey());
    const cachedInbox = client.getQueryData(INBOX_SNAPSHOT_QUERY_KEY);

    try {
      for (let i = 0; i < 3; i++)
        effects.handleChanged({
          type: "changed",
          entity: "thread",
          ...(id === undefined ? {} : { id }),
          changes: ["archived-changed"],
        });
      await vi.advanceTimersByTimeAsync(0);
      expect(readSidebar).toHaveBeenCalledTimes(2);
      expect(readInbox).toHaveBeenCalledTimes(2);
      expect(client.getQueryState(historyKey)?.isInvalidated).not.toBe(true);
      expect(client.getQueryState(detailKey)?.isInvalidated).not.toBe(true);
      expect(sidebarSignals[0]?.aborted).toBe(true);
      expect(inboxSignals[0]?.aborted).toBe(true);
      expect(client.getQueryData(sidebarNavigationQueryKey())).toBe(
        cachedSidebar,
      );
      expect(client.getQueryData(INBOX_SNAPSHOT_QUERY_KEY)).toBe(cachedInbox);
      freshSidebar.resolve(sidebar(after));
      freshInbox.resolve(inbox(after));
      await vi.advanceTimersByTimeAsync(0);
      staleSidebar.resolve(sidebar(before));
      staleInbox.resolve(inbox(before));
      await vi.advanceTimersByTimeAsync(200);
      expect(client.getQueryState(historyKey)?.isInvalidated).toBe(true);
      expect(client.getQueryState(detailKey)?.isInvalidated).toBe(true);
      expect(
        client
          .getQueryData<ReturnType<typeof sidebar>>(sidebarNavigationQueryKey())
          ?.projects[0]?.threads.map((thread) => thread.id),
      ).toEqual(after);
      expect(
        client
          .getQueryData<InboxSnapshot>(INBOX_SNAPSHOT_QUERY_KEY)
          ?.inbox.map((entry) => entry.threadId),
      ).toEqual(after);
      expect(readSidebar).toHaveBeenCalledTimes(2);
      expect(readInbox).toHaveBeenCalledTimes(2);
    } finally {
      stopSidebar();
      stopInbox();
      effects.dispose();
      client.clear();
      staleSidebar.resolve(sidebar(before));
      staleInbox.resolve(inbox(before));
      freshSidebar.resolve(sidebar(after));
      freshInbox.resolve(inbox(after));
    }
  },
);
