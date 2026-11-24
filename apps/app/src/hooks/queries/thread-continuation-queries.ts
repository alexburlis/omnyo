import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { sdk } from "@/lib/sdk";
import { useThreadDetailRealtimeSubscription } from "@/hooks/useRealtimeSubscription";
import {
  beginContinueThreadTransaction,
  invalidateThreadContinuation,
  rollbackContinueThreadTransaction,
  settleContinueThreadTransaction,
  threadContinuationQueryKey,
} from "../cache-owners/thread-continuation-cache-owner";

export function useThreadContinuation(threadId: string, enabled: boolean) {
  useThreadDetailRealtimeSubscription(threadId, { enabled });

  return useQuery({
    queryKey: threadContinuationQueryKey(threadId),
    queryFn: ({ signal }) =>
      sdk.threads.experimental_continuationState({ threadId, signal }),
    enabled,
    staleTime: 0,
  });
}

export function useContinueThread() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (
      input: string | { threadId: string; now?: boolean; model?: string },
    ) =>
      sdk.threads.experimental_continue(
        typeof input === "string" ? { threadId: input } : input,
      ),
    onMutate: (input) =>
      beginContinueThreadTransaction(
        queryClient,
        typeof input === "string" ? input : input.threadId,
      ),
    onError: (_error, _threadId, transaction) =>
      rollbackContinueThreadTransaction(queryClient, transaction),
    onSuccess: (result, _threadId, transaction) =>
      settleContinueThreadTransaction(queryClient, transaction, result.outcome),
    onSettled: async (_data, _error, input) => {
      await invalidateThreadContinuation(
        queryClient,
        typeof input === "string" ? input : input.threadId,
      );
    },
  });
}
