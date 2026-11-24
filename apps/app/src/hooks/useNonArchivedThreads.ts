import { useMemo } from "react";
import type { ThreadListEntry } from "@omnyo/domain";
import { useShelvedThreads } from "@/hooks/queries/thread-queries";

export function useNonArchivedThreads(
  sidebarThreads: readonly ThreadListEntry[] | undefined,
): readonly ThreadListEntry[] {
  const shelvedQuery = useShelvedThreads();
  const shelvedPages = shelvedQuery.data?.pages;

  return useMemo(() => {
    const byId = new Map<string, ThreadListEntry>();

    for (const thread of [
      ...(sidebarThreads ?? []),
      ...(shelvedPages ?? []).flat(),
    ]) {
      if (
        thread.archivedAt === null &&
        thread.deletedAt === null &&
        !byId.has(thread.id)
      )
        byId.set(thread.id, thread);
    }

    return [...byId.values()];
  }, [sidebarThreads, shelvedPages]);
}
