import { QueryClient, QueryObserver } from "@tanstack/react-query";
import type { ThreadListEntry, ThreadWithRuntime } from "@omnyo/domain";
import type { SidebarBootstrapResponse } from "@omnyo/server-contract";
import {
  makeThreadListEntry,
  makeThreadWithRuntime,
} from "@omnyo/test-helpers/domain-fixtures";
import { describe, expect, it } from "vitest";
import {
  makeProjectWithThreadsResponse,
  makeSidebarBootstrapResponse,
} from "@/test/fixtures/projects";
import {
  archivedThreadsListQueryKey,
  shelvedThreadsListQueryKey,
  sidebarNavigationQueryKey,
  threadListQueryKey,
  threadQueryKey,
} from "../queries/query-keys";
import { holdPendingThreadArchives } from "./pending-thread-membership";
import { readSidebarNavigation } from "./query-cache";
import {
  beginArchiveThreadAndChildrenTransaction,
  beginUnarchiveThreadTransaction,
  settleThreadPatchTransaction,
  settleUnarchiveThreadTransaction,
  rollbackArchiveThreadsTransaction,
  rollbackThreadListMutationTransaction,
  settleArchiveThreadsTransaction,
} from "./thread-state-cache-owner";

function makeSidebarNavigation(threads: ThreadListEntry[]) {
  return makeSidebarBootstrapResponse({
    projects: [makeProjectWithThreadsResponse({ id: "project-1", threads })],
  });
}

describe("pending thread archives", () => {
  it("keeps an archived family hidden when stale list and detail fetches finish", async () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: Infinity } },
    });

    const entries = [
      makeThreadListEntry({ id: "root" }),
      makeThreadListEntry({ id: "child", parentThreadId: "root" }),
      makeThreadListEntry({ id: "other" }),
    ];

    const listKey = threadListQueryKey({ archived: false });
    const sidebarKey = sidebarNavigationQueryKey();
    queryClient.setQueryData(listKey, entries);
    queryClient.setQueryData(sidebarKey, makeSidebarNavigation(entries));

    queryClient.setQueryData(
      threadQueryKey("root"),
      makeThreadWithRuntime({ id: "root" }),
    );

    const transaction = await beginArchiveThreadAndChildrenTransaction({
      queryClient,
      threadId: "root",
    });

    await queryClient.fetchQuery({
      queryKey: listKey,
      queryFn: async () => entries,
      staleTime: 0,
    });

    await queryClient.fetchQuery({
      queryKey: sidebarKey,
      queryFn: async () => makeSidebarNavigation(entries),
      staleTime: 0,
    });

    await queryClient.fetchQuery({
      queryKey: threadQueryKey("root"),
      queryFn: async () => makeThreadWithRuntime({ id: "root" }),
      staleTime: 0,
    });

    expect(
      queryClient.getQueryData<ThreadListEntry[]>(listKey)?.map(({ id }) => id),
    ).toEqual(["other"]);

    expect(
      queryClient
        .getQueryData<SidebarBootstrapResponse>(sidebarKey)
        ?.projects[0]?.threads.map(({ id }) => id),
    ).toEqual(["other"]);

    expect(
      queryClient.getQueryData<ThreadWithRuntime>(threadQueryKey("root"))
        ?.archivedAt,
    ).not.toBeNull();

    rollbackArchiveThreadsTransaction({ queryClient, transaction });

    await queryClient.fetchQuery({
      queryKey: listKey,
      queryFn: async () => entries,
      staleTime: 0,
    });

    expect(queryClient.getQueryData(listKey)).toEqual(entries);
    queryClient.clear();
  });

  it("retains independent archives while another archive rolls back", async () => {
    const queryClient = new QueryClient();
    const key = threadListQueryKey({ archived: false });

    const entries = [
      makeThreadListEntry({ id: "a" }),
      makeThreadListEntry({ id: "b" }),
    ];

    const releaseA = holdPendingThreadArchives(queryClient, ["a"]);
    const releaseB = holdPendingThreadArchives(queryClient, ["b"]);
    releaseA();
    await queryClient.fetchQuery({
      queryKey: key,
      queryFn: async () => entries,
    });
    expect(
      queryClient.getQueryData<ThreadListEntry[]>(key)?.map(({ id }) => id),
    ).toEqual(["a"]);
    releaseB();
    queryClient.clear();
  });

  it("holds archive membership until the settlement refetch finishes", async () => {
    const queryClient = new QueryClient();
    const key = sidebarNavigationQueryKey();
    const entries = [makeThreadListEntry({ id: "root" })];
    const navigation = makeSidebarNavigation(entries);
    queryClient.setQueryData(key, navigation);

    const transaction = await beginArchiveThreadAndChildrenTransaction({
      queryClient,
      threadId: "root",
    });

    let complete = (_value: typeof navigation) => {};

    const response = new Promise<typeof navigation>((resolve) => {
      complete = resolve;
    });

    const observer = new QueryObserver(queryClient, {
      queryKey: key,
      queryFn: () => response,
      staleTime: Infinity,
    });

    const unsubscribe = observer.subscribe(() => {});

    const settled = settleArchiveThreadsTransaction({
      queryClient,
      transaction,
      response: undefined,
    });

    complete(navigation);
    await settled;
    expect(
      queryClient.getQueryData<typeof navigation>(key)?.projects[0]?.threads,
    ).toEqual([]);
    await queryClient.fetchQuery({
      queryKey: key,
      queryFn: async () => navigation,
      staleTime: 0,
    });
    expect(
      queryClient.getQueryData<typeof navigation>(key)?.projects[0]?.threads,
    ).toEqual(entries);
    unsubscribe();
    queryClient.clear();
  });
  it("cancels inactive stale fetches before releasing the archive hold", async () => {
    const queryClient = new QueryClient();
    const key = sidebarNavigationQueryKey();

    const navigation = makeSidebarNavigation([
      makeThreadListEntry({ id: "root" }),
    ]);

    queryClient.setQueryData(key, navigation);

    const transaction = await beginArchiveThreadAndChildrenTransaction({
      queryClient,
      threadId: "root",
    });

    let complete = (_value: typeof navigation) => {};

    const response = new Promise<typeof navigation>((resolve) => {
      complete = resolve;
    });

    const staleFetch = queryClient
      .fetchQuery({ queryKey: key, queryFn: () => response, staleTime: 0 })
      .catch(() => undefined);

    await settleArchiveThreadsTransaction({
      queryClient,
      transaction,
      response: undefined,
    });
    complete(navigation);
    await staleFetch;
    expect(
      queryClient.getQueryData<typeof navigation>(key)?.projects[0]?.threads,
    ).toEqual([]);
    queryClient.clear();
  });
});

describe("pending thread unarchives", () => {
  it("keeps a restored row visible while stale sidebar, archived list and detail reads finish", async () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: Infinity } },
    });

    const entry = makeThreadListEntry({
      id: "restored",
      projectId: "project-1",
      archivedAt: 1,
    });

    const sidebarKey = sidebarNavigationQueryKey();
    const archivedKey = archivedThreadsListQueryKey({});
    const empty = makeSidebarNavigation([]);
    queryClient.setQueryData(sidebarKey, empty);
    queryClient.setQueryData(archivedKey, {
      pages: [[entry]],
      pageParams: [0],
    });
    queryClient.setQueryData(
      threadQueryKey(entry.id),
      makeThreadWithRuntime({ ...entry }),
    );

    const transaction = await beginUnarchiveThreadTransaction({
      queryClient,
      threadId: entry.id,
    });

    try {
      expect(
        queryClient
          .getQueryData<SidebarBootstrapResponse>(sidebarKey)
          ?.projects[0]?.threads.map(({ id }) => id),
      ).toEqual([entry.id]);
      await queryClient.fetchQuery({
        queryKey: sidebarKey,
        staleTime: 0,
        queryFn: () => readSidebarNavigation(queryClient, async () => empty),
      });
      expect(
        queryClient
          .getQueryData<SidebarBootstrapResponse>(sidebarKey)
          ?.projects[0]?.threads.map(({ id }) => id),
      ).toEqual([entry.id]);
      await queryClient.fetchQuery({
        queryKey: archivedKey,
        staleTime: 0,
        queryFn: async () => ({ pages: [[entry]], pageParams: [0] }),
      });
      expect(
        queryClient
          .getQueryData<{ pages: ThreadListEntry[][] }>(archivedKey)
          ?.pages.flat(),
      ).toEqual([]);
      await queryClient.fetchQuery({
        queryKey: threadQueryKey(entry.id),
        staleTime: 0,
        queryFn: async () => makeThreadWithRuntime({ ...entry }),
      });
      expect(
        queryClient.getQueryData<ThreadWithRuntime>(threadQueryKey(entry.id))
          ?.archivedAt,
      ).toBeNull();
      settleThreadPatchTransaction(transaction);
      await queryClient.fetchQuery({
        queryKey: sidebarKey,
        staleTime: 0,
        queryFn: () => readSidebarNavigation(queryClient, async () => empty),
      });
      expect(
        queryClient.getQueryData<SidebarBootstrapResponse>(sidebarKey)
          ?.projects[0]?.threads,
      ).toEqual([]);
    } finally {
      settleThreadPatchTransaction(transaction);
      queryClient.clear();
    }
  });

  it("releases a rejected restore before a refresh can reapply it", async () => {
    const queryClient = new QueryClient();

    const entry = makeThreadListEntry({
      id: "refused",
      projectId: "project-1",
      archivedAt: 1,
    });

    const key = sidebarNavigationQueryKey();
    const empty = makeSidebarNavigation([]);
    queryClient.setQueryData(key, empty);
    queryClient.setQueryData(archivedThreadsListQueryKey({}), {
      pages: [[entry]],
      pageParams: [0],
    });

    const transaction = await beginUnarchiveThreadTransaction({
      queryClient,
      threadId: entry.id,
    });

    try {
      rollbackThreadListMutationTransaction({
        queryClient,
        threadId: entry.id,
        transaction,
      });
      await queryClient.fetchQuery({
        queryKey: key,
        staleTime: 0,
        queryFn: () => readSidebarNavigation(queryClient, async () => empty),
      });
      expect(
        queryClient.getQueryData<SidebarBootstrapResponse>(key)?.projects[0]
          ?.threads,
      ).toEqual([]);
    } finally {
      settleThreadPatchTransaction(transaction);
      queryClient.clear();
    }
  });

  it("cancels a stale sidebar read before releasing the restore hold", async () => {
    const queryClient = new QueryClient();

    const entry = makeThreadListEntry({
      id: "restored",
      projectId: "project-1",
      archivedAt: 1,
    });

    const key = sidebarNavigationQueryKey();
    const empty = makeSidebarNavigation([]);
    queryClient.setQueryData(key, empty);
    queryClient.setQueryData(archivedThreadsListQueryKey({}), {
      pages: [[entry]],
      pageParams: [0],
    });

    const transaction = await beginUnarchiveThreadTransaction({
      queryClient,
      threadId: entry.id,
    });

    let resolveRead = (_value: typeof empty) => {};

    const response = new Promise<typeof empty>((resolve) => {
      resolveRead = resolve;
    });

    const reading = queryClient
      .fetchQuery({
        queryKey: key,
        staleTime: 0,
        queryFn: () => readSidebarNavigation(queryClient, () => response),
      })
      .catch(() => undefined);

    await settleUnarchiveThreadTransaction({
      queryClient,
      threadId: entry.id,
      transaction,
    });
    resolveRead(empty);
    await reading;
    expect(
      queryClient
        .getQueryData<SidebarBootstrapResponse>(key)
        ?.projects[0]?.threads.map(({ id }) => id),
    ).toEqual([entry.id]);
    queryClient.clear();
  });

  it("removes an archived shelved family immediately and keeps it hidden through a stale Shelf read", async () => {
    const queryClient = new QueryClient();
    const shelfKey = shelvedThreadsListQueryKey();

    const root = makeThreadListEntry({
      id: "shelved-root",
      projectId: "project-1",
      shelvedAt: 1,
    });

    const child = makeThreadListEntry({
      id: "shelved-child",
      projectId: "project-1",
      parentThreadId: root.id,
      shelvedAt: 1,
    });

    const other = makeThreadListEntry({
      id: "other",
      projectId: "project-1",
      shelvedAt: 1,
    });

    const shelf = { pages: [[root, child, other]], pageParams: [0] };
    queryClient.setQueryData(
      sidebarNavigationQueryKey(),
      makeSidebarNavigation([]),
    );
    queryClient.setQueryData(shelfKey, shelf);

    const transaction = await beginArchiveThreadAndChildrenTransaction({
      queryClient,
      threadId: root.id,
    });

    try {
      expect(transaction.archivedThreadIds).toEqual([root.id, child.id]);
      expect(
        queryClient
          .getQueryData<typeof shelf>(shelfKey)
          ?.pages.flat()
          .map(({ id }) => id),
      ).toEqual([other.id]);
      await queryClient.fetchQuery({
        queryKey: shelfKey,
        staleTime: 0,
        queryFn: async () => shelf,
      });
      expect(
        queryClient
          .getQueryData<typeof shelf>(shelfKey)
          ?.pages.flat()
          .map(({ id }) => id),
      ).toEqual([other.id]);
      rollbackArchiveThreadsTransaction({ queryClient, transaction });
      expect(queryClient.getQueryData(shelfKey)).toEqual(shelf);
    } finally {
      transaction.releasePendingArchives();
      queryClient.clear();
    }
  });
});

describe("overlapping thread membership", () => {
  it("keeps Undo newer than an archive without reviving the superseded archive hold", async () => {
    const queryClient = new QueryClient();

    const entry = makeThreadListEntry({
      id: "overlap",
      projectId: "project-1",
    });

    const key = sidebarNavigationQueryKey();
    const visible = makeSidebarNavigation([entry]);
    queryClient.setQueryData(key, visible);

    const archived = await beginArchiveThreadAndChildrenTransaction({
      queryClient,
      threadId: entry.id,
    });

    const restored = await beginUnarchiveThreadTransaction({
      queryClient,
      threadId: entry.id,
    });

    try {
      await queryClient.fetchQuery({
        queryKey: key,
        staleTime: 0,
        queryFn: async () => makeSidebarNavigation([]),
      });
      expect(
        queryClient
          .getQueryData<SidebarBootstrapResponse>(key)
          ?.projects[0]?.threads.map(({ id }) => id),
      ).toEqual([entry.id]);
      settleThreadPatchTransaction(restored);
      await queryClient.fetchQuery({
        queryKey: key,
        staleTime: 0,
        queryFn: async () => visible,
      });
      expect(
        queryClient
          .getQueryData<SidebarBootstrapResponse>(key)
          ?.projects[0]?.threads.map(({ id }) => id),
      ).toEqual([entry.id]);
    } finally {
      settleThreadPatchTransaction(restored);
      archived.releasePendingArchives();
      queryClient.clear();
    }
  });

  it("keeps a new archive newer than an unarchive without reviving the superseded restore hold", async () => {
    const queryClient = new QueryClient();

    const entry = makeThreadListEntry({
      id: "overlap",
      projectId: "project-1",
      archivedAt: 1,
    });

    const key = sidebarNavigationQueryKey();
    const empty = makeSidebarNavigation([]);
    queryClient.setQueryData(key, empty);
    queryClient.setQueryData(archivedThreadsListQueryKey({}), {
      pages: [[entry]],
      pageParams: [0],
    });

    const restored = await beginUnarchiveThreadTransaction({
      queryClient,
      threadId: entry.id,
    });

    const archived = await beginArchiveThreadAndChildrenTransaction({
      queryClient,
      threadId: entry.id,
    });

    try {
      await queryClient.fetchQuery({
        queryKey: key,
        staleTime: 0,
        queryFn: async () =>
          makeSidebarNavigation([{ ...entry, archivedAt: null }]),
      });
      expect(
        queryClient.getQueryData<SidebarBootstrapResponse>(key)?.projects[0]
          ?.threads,
      ).toEqual([]);
      archived.releasePendingArchives();
      await queryClient.fetchQuery({
        queryKey: key,
        staleTime: 0,
        queryFn: async () => empty,
      });
      expect(
        queryClient.getQueryData<SidebarBootstrapResponse>(key)?.projects[0]
          ?.threads,
      ).toEqual([]);
    } finally {
      settleThreadPatchTransaction(restored);
      archived.releasePendingArchives();
      queryClient.clear();
    }
  });
});
