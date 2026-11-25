import type { QueryClient, QueryKey } from "@tanstack/react-query";

interface RefreshState {
  timer: ReturnType<typeof setTimeout> | null;
  unsubscribe: (() => void) | null;
}

export function createSnapshotInvalidator(queryKey: QueryKey) {
  const refreshStates = new WeakMap<QueryClient, RefreshState>();
  const filters = { queryKey, exact: true };

  function invalidate(queryClient: QueryClient): void {
    void queryClient.invalidateQueries({ ...filters, refetchType: "none" });
    let state = refreshStates.get(queryClient);

    if (!state) {
      state = { timer: null, unsubscribe: null };
      refreshStates.set(queryClient, state);
    }

    if (state.timer !== null || state.unsubscribe !== null) return;
    const pending = state;
    pending.timer = setTimeout(() => {
      pending.timer = null;

      if (queryClient.isFetching(filters) > 0) {
        pending.unsubscribe = queryClient.getQueryCache().subscribe(() => {
          if (queryClient.isFetching(filters) > 0) return;
          pending.unsubscribe?.();
          pending.unsubscribe = null;
          invalidate(queryClient);
        });

        return;
      }

      void queryClient.refetchQueries(
        { ...filters, type: "active" },
        { cancelRefetch: false },
      );
    }, 0);
  }

  function dispose(queryClient: QueryClient): void {
    const state = refreshStates.get(queryClient);

    if (!state) return;

    if (state.timer !== null) clearTimeout(state.timer);
    state.unsubscribe?.();
    refreshStates.delete(queryClient);
  }

  return { invalidate, dispose };
}
