import type { QueryClient, QueryKey } from "@tanstack/react-query";

interface RefreshState {
  timer: ReturnType<typeof setTimeout> | null;
  unsubscribe: (() => void) | null;
  supersedeActive: boolean;
  canceling: boolean;
}

export function createSnapshotInvalidator(queryKey: QueryKey) {
  const refreshStates = new WeakMap<QueryClient, RefreshState>();
  const filters = { queryKey, exact: true };

  function invalidate(
    queryClient: QueryClient,
    options: { supersedeActive?: boolean } = {},
  ): void {
    void queryClient.invalidateQueries({ ...filters, refetchType: "none" });
    let state = refreshStates.get(queryClient);

    if (!state) {
      state = {
        timer: null,
        unsubscribe: null,
        supersedeActive: false,
        canceling: false,
      };
      refreshStates.set(queryClient, state);
    }

    if (options.supersedeActive) {
      state.supersedeActive = true;
      state.unsubscribe?.();
      state.unsubscribe = null;
    }

    if (state.timer !== null || state.unsubscribe !== null || state.canceling)
      return;
    const pending = state;
    pending.timer = setTimeout(() => {
      pending.timer = null;

      if (pending.supersedeActive) {
        pending.canceling = true;
        void queryClient
          .cancelQueries(
            { ...filters, type: "active" },
            { revert: false, silent: true },
          )
          .then(() => {
            if (refreshStates.get(queryClient) !== pending) return;
            pending.canceling = false;
            pending.supersedeActive = false;
            void queryClient.refetchQueries(
              { ...filters, type: "active" },
              { cancelRefetch: false },
            );
          });

        return;
      }

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
