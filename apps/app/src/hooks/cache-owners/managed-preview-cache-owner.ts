import type { QueryClient } from "@tanstack/react-query";
import type { PreviewStatus } from "@omnyo/server-contract";
import {
  managedPreviewStatusQueryKey,
  managedPreviewsQueryKey,
} from "../queries/query-keys";

interface ManagedPreviewStatusCacheArgs {
  queryClient: QueryClient;
  previewId: string | undefined;
}

interface SetManagedPreviewStatusArgs extends ManagedPreviewStatusCacheArgs {
  status: PreviewStatus;
}

interface InvalidateManagedPreviewsArgs extends ManagedPreviewStatusCacheArgs {
  threadId: string;
}

export function setManagedPreviewStatus(
  args: SetManagedPreviewStatusArgs,
): void {
  args.queryClient.setQueryData(
    managedPreviewStatusQueryKey(args.previewId),
    args.status,
  );
}

export function invalidateManagedPreviewStatus(
  args: ManagedPreviewStatusCacheArgs,
): Promise<void> {
  return args.queryClient.invalidateQueries({
    queryKey: managedPreviewStatusQueryKey(args.previewId),
  });
}

export function invalidateManagedPreviews(
  args: InvalidateManagedPreviewsArgs,
): void {
  void args.queryClient.invalidateQueries({
    queryKey: managedPreviewsQueryKey(args.threadId),
  });
  void invalidateManagedPreviewStatus(args);
}
