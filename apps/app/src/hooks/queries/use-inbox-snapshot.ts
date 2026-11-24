import { useCallback, useSyncExternalStore } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { sdk } from "@/lib/sdk";
import {
  INBOX_SNAPSHOT_QUERY_KEY,
  INBOX_SNAPSHOT_QUERY_POLICY,
  fetchInboxSnapshot,
  inboxSnapshotState,
  markInboxSnapshotDirty,
  readPredictedInboxSnapshot,
  subscribeInboxSnapshot,
} from "../cache-owners/inbox-snapshot-cache-owner";

export function useInboxSnapshot() {
  const queryClient = useQueryClient();

  const query = useQuery({
    queryKey: INBOX_SNAPSHOT_QUERY_KEY,
    queryFn: ({ signal }) =>
      fetchInboxSnapshot(queryClient, () =>
        sdk.experimental_inbox.snapshot({ signal }),
      ),
    ...INBOX_SNAPSHOT_QUERY_POLICY,
  });

  const subscribe = useCallback(
    (listener: () => void) => subscribeInboxSnapshot(queryClient, listener),
    [queryClient],
  );

  const read = useCallback(
    () => readPredictedInboxSnapshot(queryClient),
    [queryClient],
  );

  const data = useSyncExternalStore(subscribe, read, read);

  const refresh = useCallback(
    () => markInboxSnapshotDirty(queryClient),
    [queryClient],
  );

  return {
    ...inboxSnapshotState({
      data,
      isError: query.isError,
      isRefetchError: query.isRefetchError,
      failureCount: query.failureCount,
    }),
    refresh,
  };
}
