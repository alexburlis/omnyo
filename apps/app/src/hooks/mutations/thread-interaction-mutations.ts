import {
  useMutation,
  useMutationState,
  useQueryClient,
} from "@tanstack/react-query";
import type { PendingInteraction } from "@omnyo/domain";
import type { ResolvePendingInteractionRequest } from "@omnyo/server-contract";
import { sdk } from "@/lib/sdk";
import { isHostDisconnectedError } from "@/lib/lifecycle-errors";
import { useEnvironment } from "../queries/environment-queries";
import { useHosts } from "../queries/host-queries";
import { useThread } from "../queries/thread-queries";
import {
  applyResolvedThreadPendingInteraction,
  invalidateThreadPendingInteractionResolutionQueries,
} from "../cache-owners/mutation-cache-effects";
import { beginResolvedThreadInteractionTransaction } from "../cache-owners/thread-answer-cache-owner";

interface ResolveThreadPendingInteractionMutationRequest {
  threadId: string;
  interactionId: string;
  resolution: ResolvePendingInteractionRequest;
}

function useIsThreadHostConnected(threadId: string): boolean {
  const environmentId = useThread(threadId).data?.environmentId;
  const hostId = useEnvironment(environmentId).data?.hostId;
  const hosts = useHosts({ enabled: hostId !== undefined }).data;

  return (
    hosts?.some((host) => host.id === hostId && host.status === "connected") ??
    false
  );
}

export function useResolveThreadPendingInteraction(
  threadId: string,
  interactionId?: string,
) {
  const queryClient = useQueryClient();
  const isHostConnected = useIsThreadHostConnected(threadId);

  const mutationKey = [
    "resolve-thread-pending-interaction",
    threadId,
    interactionId,
  ];

  const submissions = useMutationState({
    filters: { mutationKey, exact: true },
    select: (entry) => ({
      isPending: entry.state.status === "pending",
      error: entry.state.error,
    }),
  });

  const mutation = useMutation({
    mutationKey,
    meta: {
      errorMessage: "Failed to resolve pending interaction.",
      showErrorToast: false,
    },
    mutationFn: ({
      threadId,
      interactionId,
      resolution,
    }: ResolveThreadPendingInteractionMutationRequest): Promise<PendingInteraction> =>
      sdk.threads.interactions.resolve({
        interactionId,
        resolution,
        threadId,
      }),
    onMutate: ({ threadId, interactionId }) =>
      beginResolvedThreadInteractionTransaction(queryClient, {
        threadId,
        interactionId,
      }),
    onError: (_error, variables, transaction) => {
      transaction?.rollback();
      invalidateThreadPendingInteractionResolutionQueries({
        queryClient,
        threadId: variables.threadId,
      });
    },
    onSuccess: (interaction, variables, transaction) => {
      applyResolvedThreadPendingInteraction({ interaction, queryClient });
      transaction?.settle(interaction.status);
      invalidateThreadPendingInteractionResolutionQueries({
        queryClient,
        threadId: variables.threadId,
      });

      return interaction;
    },
  });

  const latestSubmission =
    interactionId === undefined ? mutation : (submissions.at(-1) ?? mutation);

  const isStaleHostError =
    isHostConnected && isHostDisconnectedError(latestSubmission.error);

  return {
    ...mutation,
    isPending: latestSubmission.isPending,
    error: isStaleHostError ? null : latestSubmission.error,
  };
}
