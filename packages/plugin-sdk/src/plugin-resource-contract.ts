/** Primitive scope parts; include every filter, route and permission scope used by load. */
export type PluginResourceKey = readonly (string | number | boolean | null)[];

export interface PluginResourceOptions<T> {
  key: PluginResourceKey;
  /** Read-only loader. Mutations remain explicit RPC calls. */
  load(): Promise<T>;
  enabled?: boolean;
  /** Milliseconds before a revisit revalidates. Defaults to Infinity (explicit invalidation). */
  staleTime?: number;
}

export interface PluginResourceState<T> {
  data: T | undefined;
  error: unknown;
  status: "idle" | "loading" | "success" | "error";
  isRefreshing: boolean;
  /** Shares an existing request; retains the previous successful value. */
  refresh(): Promise<T | undefined>;
  /** Marks this scope stale and reloads active observers without clearing data. */
  invalidate(): void;
}
