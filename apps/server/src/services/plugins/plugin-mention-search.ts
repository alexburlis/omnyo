import type {
  PluginMentionItem,
  PluginMentionProviderRegistration,
  PluginMentionSearchContext,
} from "@omnyo/plugin-sdk";
import { raceTimeout } from "./plugin-time-box.js";

const MAX_ACTIVE_SEARCHES = 2;

export function createBoundedMentionSearch(
  search: PluginMentionProviderRegistration["search"],
) {
  let active = 0;
  let next: ((admitted: boolean) => void) | null = null;

  return async (
    context: PluginMentionSearchContext,
    stopping: AbortSignal,
    timeoutMs: number,
  ) => {
    if (stopping.aborted) return [];
    const deadline = performance.now() + timeoutMs;
    let cancelWait: (() => void) | undefined;

    async function run(): Promise<PluginMentionItem[]> {
      if (active < MAX_ACTIVE_SEARCHES) {
        active++;
      } else {
        const admitted = await new Promise<boolean>((resolve) => {
          next?.(false);
          next = resolve;
          cancelWait = () => {
            if (next !== resolve) return;
            next = null;
            resolve(false);
          };

          stopping.addEventListener("abort", cancelWait, { once: true });
        });

        if (!admitted) return [];
      }

      try {
        if (stopping.aborted || performance.now() >= deadline) return [];

        return await search(context);
      } finally {
        if (next === null) {
          active--;
        } else {
          const admit = next;
          next = null;
          admit(true);
        }
      }
    }

    try {
      return await raceTimeout(
        run(),
        timeoutMs,
        `timed out after ${timeoutMs}ms`,
      );
    } finally {
      if (cancelWait) {
        stopping.removeEventListener("abort", cancelWait);
        cancelWait();
      }
    }
  };
}
