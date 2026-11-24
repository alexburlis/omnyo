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
  sidebarNavigationQueryKey,
  threadListQueryKey,
  threadQueryKey,
} from "../queries/query-keys";
import { holdPendingThreadArchives } from "./pending-thread-archives";
import {
  beginArchiveThreadAndChildrenTransaction,
  rollbackArchiveThreadsTransaction,
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
