import type { ThreadTimelineResponse } from "@omnyo/server-contract";
import type { CompletedTurnDisplay, ThreadStatus } from "@omnyo/domain";
import type { ThreadTimelinePageRequest } from "./timeline-pagination.js";
import { timelineRowsEnvelopeByteLength } from "./timeline-row-bytes.js";

const DEFAULT_MAX_ENTRIES = 128;

const DEFAULT_MAX_ENTRY_BYTES = 1024 * 1024;

const DEFAULT_MAX_BYTES = 8 * 1024 * 1024;

interface ThreadTimelineCacheOptions {
  maxEntries?: number;
  maxEntryBytes?: number;
  maxBytes?: number;
}

interface ThreadTimelineCache {
  get(threadId: string, key: string): ThreadTimelineResponse | undefined;
  getOrBuild(
    threadId: string,
    key: string,
    build: () => ThreadTimelineResponse,
    paramsKey?: string,
    expiresAt?: number | null,
  ): ThreadTimelineResponse;
  invalidateThread(threadId: string): void;
  readonly size: number;
}

interface ThreadTimelineCacheEntry {
  createdAt: number;
  expiresAt: number | null;
  paramsKey: string;
  response: ThreadTimelineResponse;
  threadId: string;
  weight: number;
}

export function createThreadTimelineCache(
  options: ThreadTimelineCacheOptions = {},
): ThreadTimelineCache {
  const maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;
  const maxEntryBytes = options.maxEntryBytes ?? DEFAULT_MAX_ENTRY_BYTES;
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;

  const entries = new Map<string, ThreadTimelineCacheEntry>();
  let retainedBytes = 0;

  function removeEntry(key: string): void {
    const entry = entries.get(key);

    if (entry === undefined) {
      return;
    }

    entries.delete(key);
    retainedBytes -= entry.weight;
  }

  function retain(key: string, entry: ThreadTimelineCacheEntry): void {
    removeEntry(key);

    if (entry.weight > maxEntryBytes || entry.weight > maxBytes) return;
    entries.set(key, entry);
    retainedBytes += entry.weight;

    while (entries.size > maxEntries || retainedBytes > maxBytes) {
      const oldest = entries.keys().next().value;

      if (oldest === undefined) break;
      removeEntry(oldest);
    }
  }

  function get(
    threadId: string,
    key: string,
  ): ThreadTimelineResponse | undefined {
    const now = Date.now();
    const cached = entries.get(key);

    if (cached !== undefined) {
      if (cached.threadId !== threadId) return undefined;

      if (
        cached.createdAt <= now &&
        (cached.expiresAt === null || cached.expiresAt > now)
      ) {
        entries.delete(key);
        entries.set(key, cached);

        return cached.response;
      }

      removeEntry(key);
    }

    return undefined;
  }

  return {
    get,
    getOrBuild(threadId, key, build, paramsKey = key, expiresAt = null) {
      const cached = get(threadId, key);

      if (cached !== undefined) return cached;
      const value = build();
      const weight = timelineRowsEnvelopeByteLength(value);
      const createdAt = Date.now();

      for (const [previousKey, entry] of entries) {
        if (entry.threadId === threadId && entry.paramsKey === paramsKey)
          removeEntry(previousKey);
      }

      if (expiresAt !== null && expiresAt <= createdAt) return value;
      retain(key, {
        response: value,
        threadId,
        paramsKey,
        weight,
        createdAt,
        expiresAt,
      });

      return value;
    },
    invalidateThread(threadId) {
      for (const [key, entry] of entries) {
        if (entry.threadId === threadId) {
          removeEntry(key);
        }
      }
    },
    get size() {
      return entries.size;
    },
  };
}

export interface ThreadTimelineCacheKeyArgs {
  threadId: string;
  maxSeq: number;
  status: ThreadStatus;
  environmentId: string | null;
  providerDisplayName?: string;
  page: ThreadTimelinePageRequest;
  includeNestedRows: boolean;
  deferContent: boolean;
  summaryOnly: boolean;
  includeClearedContextHistory: boolean;
  includeDiagnosticOperations: boolean;
  completedTurnDisplay: CompletedTurnDisplay;
}

function pageKeyPart(page: ThreadTimelinePageRequest): string {
  return page.kind === "older"
    ? `older:${page.segmentLimit}:${page.beforeCursor.anchorSeq}:${page.beforeCursor.anchorId}`
    : `latest:${page.segmentLimit}`;
}

export function buildThreadTimelineParamsKey(
  args: Omit<ThreadTimelineCacheKeyArgs, "maxSeq">,
): string {
  return [
    args.threadId,
    args.status,
    args.environmentId ?? "-",
    args.providerDisplayName ?? "-",
    pageKeyPart(args.page),
    args.includeNestedRows ? "1" : "0",
    args.deferContent ? "1" : "0",
    args.summaryOnly ? "1" : "0",
    args.includeClearedContextHistory ? "1" : "0",
    args.includeDiagnosticOperations ? "1" : "0",
    args.completedTurnDisplay,
  ].join("|");
}

export function buildThreadTimelineCacheKey(
  args: ThreadTimelineCacheKeyArgs,
): string {
  return `${args.maxSeq}|${buildThreadTimelineParamsKey(args)}`;
}
