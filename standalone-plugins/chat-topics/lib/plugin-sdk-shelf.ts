import { experimental_useSidebarThreads } from "@omnyo/plugin-sdk/app";
import type { PluginSidebarThreadsState } from "@omnyo/plugin-sdk/app";
import { useInboxPrefetch } from "./use-inbox.ts";

export type ShelfPages = NonNullable<PluginSidebarThreadsState["experimental_archived"]>;

const ACTIVE_AND_SHELVED = ["active", "shelved"] as const;

export function useShelfSidebarThreads() {
  const state = experimental_useSidebarThreads({ experimental_lifecycles: ACTIVE_AND_SHELVED });
  useInboxPrefetch();

  return { ...state, shelfPages: state.experimental_shelved ?? null };
}
