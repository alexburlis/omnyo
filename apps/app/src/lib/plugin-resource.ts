import { useQueryClient } from "@tanstack/react-query";
import { useSyncExternalStore } from "react";
import type { PluginResourceOptions } from "@omnyo/plugin-sdk";
import { usePluginResourceQuery } from "@omnyo/plugin-sdk/internal/plugin-resource";
import { usePluginId } from "@/components/plugin/plugin-context";
import { useThreadInitialLoadPending } from "@/components/thread/ThreadInitialLoad";
import {
  getPluginResourceGeneration,
  subscribePluginSlots,
} from "./plugin-slots";

export function usePluginResource<T>(options: PluginResourceOptions<T>) {
  const pluginId = usePluginId();

  const generation = useSyncExternalStore(subscribePluginSlots, () =>
    getPluginResourceGeneration(pluginId),
  );

  const result = usePluginResourceQuery(
    options,
    [pluginId, generation],
    useQueryClient(),
  );

  useThreadInitialLoadPending(
    result.status === "loading" && result.data === undefined,
  );

  return result;
}
