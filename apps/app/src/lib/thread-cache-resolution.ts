import type { InfiniteData, QueryClient } from "@tanstack/react-query";
import type { Thread, ThreadListEntry } from "@omnyo/domain";
import type { SidebarBootstrapResponse } from "@omnyo/server-contract";
import {
  archivedThreadsListQueryKey,
  shelvedThreadsListQueryKey,
  sidebarNavigationQueryKey,
  threadQueryKey,
} from "@/hooks/queries/query-keys";
import { sdk } from "./sdk";

const EMPTY_ENTRIES: ReadonlyMap<string, ThreadListEntry> = new Map();

const threadEntryMapByPayload = new WeakMap<
  SidebarBootstrapResponse,
  ReadonlyMap<string, ThreadListEntry>
>();

export function threadEntryMapFor(
  data: SidebarBootstrapResponse | undefined,
): ReadonlyMap<string, ThreadListEntry> {
  if (data === undefined) return EMPTY_ENTRIES;
  const cached = threadEntryMapByPayload.get(data);

  if (cached !== undefined) return cached;
  const entries = new Map<string, ThreadListEntry>();

  for (const project of [...data.projects, data.personalProject]) {
    for (const thread of project.threads) entries.set(thread.id, thread);
  }

  threadEntryMapByPayload.set(data, entries);

  return entries;
}

export function lookupCachedThread(
  queryClient: QueryClient,
  threadId: string,
): Thread | null {
  const detail = queryClient.getQueryData<Thread>(threadQueryKey(threadId));

  if (detail !== undefined) return detail;

  const active = threadEntryMapFor(
    queryClient.getQueryData<SidebarBootstrapResponse>(
      sidebarNavigationQueryKey(),
    ),
  ).get(threadId);

  if (active !== undefined) return active;

  for (const queryKey of [
    archivedThreadsListQueryKey({}),
    shelvedThreadsListQueryKey(),
  ]) {
    const paged = queryClient
      .getQueryData<InfiniteData<readonly ThreadListEntry[]>>(queryKey)
      ?.pages.flat()
      .find((thread) => thread.id === threadId);

    if (paged !== undefined) return paged;
  }

  return null;
}

export async function resolveThread(
  queryClient: QueryClient,
  threadId: string,
): Promise<Thread> {
  return (
    lookupCachedThread(queryClient, threadId) ??
    (await sdk.threads.get({ threadId }))
  );
}
