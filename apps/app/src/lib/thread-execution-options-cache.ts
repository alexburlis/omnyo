import { resolvedThreadExecutionOptionsSchema } from "@omnyo/domain";
import { createLastKnownCache } from "@/lib/last-known-cache";

const threadExecutionOptionsCache = createLastKnownCache({
  prefix: "omnyo.thread-execution-options",
  obsoletePrefixes: ["bb.thread-execution-options"],
  version: "1",
  schema: resolvedThreadExecutionOptionsSchema,
});

export function threadExecutionOptionsCacheKey(threadId: string): string {
  return threadExecutionOptionsCache.key(threadId);
}

export const readCachedThreadExecutionOptions =
  threadExecutionOptionsCache.read;

export const writeCachedThreadExecutionOptions =
  threadExecutionOptionsCache.write;

export const clearCachedThreadExecutionOptions =
  threadExecutionOptionsCache.clear;
