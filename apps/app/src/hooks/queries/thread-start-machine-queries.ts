import { useMutation, useQuery } from "@tanstack/react-query";
import { sdk } from "@/lib/sdk";
import { threadStartMachinesQueryKey } from "./query-keys";

export interface ThreadStartMoveRequest {
  threadId: string;
  hostId: string;
  expectedHostId: string;
}

export function useThreadStartMachines(threadId: string, enabled: boolean) {
  return useQuery({
    queryKey: threadStartMachinesQueryKey(threadId),
    queryFn: () => sdk.threads.experimental_listStartMachines({ threadId }),
    enabled,
    staleTime: 0,
  });
}

export function useMoveThreadStart() {
  return useMutation({
    mutationFn: (request: ThreadStartMoveRequest) =>
      sdk.threads.experimental_moveStart(request),
  });
}
