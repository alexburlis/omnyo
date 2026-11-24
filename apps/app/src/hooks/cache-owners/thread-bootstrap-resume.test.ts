import { describe, expect, it, vi } from "vitest";
import { QueryClient, QueryObserver } from "@tanstack/react-query";
import { threadDetailBootstrapQueryKey } from "../queries/query-keys";
import { refetchActiveRealtimeQueriesOnResume } from "./system-cache-effects";

describe("conversation bootstrap recovery", () => {
  it("recovers a failed active conversation bootstrap on resume without rereading healthy or inactive bootstraps", async () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: Infinity } },
    });

    const failedKey = threadDetailBootstrapQueryKey("failed-thread");
    const healthyKey = threadDetailBootstrapQueryKey("healthy-thread");
    const inactiveKey = threadDetailBootstrapQueryKey("inactive-thread");

    const failedRead = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(new Error("Connection interrupted"))
      .mockResolvedValue("current plugin data");

    const healthyRead = vi
      .fn<() => Promise<string>>()
      .mockResolvedValue("healthy plugin data");

    const inactiveRead = vi
      .fn<() => Promise<string>>()
      .mockRejectedValue(new Error("Connection interrupted"));

    const failed = new QueryObserver(queryClient, {
      queryKey: failedKey,
      queryFn: failedRead,
      staleTime: Infinity,
      refetchOnWindowFocus: false,
    });

    const healthy = new QueryObserver(queryClient, {
      queryKey: healthyKey,
      queryFn: healthyRead,
      staleTime: Infinity,
      refetchOnWindowFocus: false,
    });

    const subscriptions = [failed, healthy].map((query) =>
      query.subscribe(() => {}),
    );

    try {
      await queryClient
        .fetchQuery({ queryKey: inactiveKey, queryFn: inactiveRead })
        .catch(() => {});
      await vi.waitFor(() => {
        expect(failed.getCurrentResult().isError).toBe(true);
        expect(healthy.getCurrentResult().data).toBe("healthy plugin data");
      });

      refetchActiveRealtimeQueriesOnResume({ queryClient });

      await vi.waitFor(() =>
        expect(failed.getCurrentResult().data).toBe("current plugin data"),
      );
      expect(failed.getCurrentResult().isError).toBe(false);
      expect(healthyRead).toHaveBeenCalledTimes(1);
      expect(inactiveRead).toHaveBeenCalledTimes(1);
      expect(queryClient.getQueryState(inactiveKey)?.status).toBe("error");
    } finally {
      for (const unsubscribe of subscriptions) unsubscribe();
      queryClient.clear();
    }
  });
});
