import type { TimelineRow } from "@omnyo/server-contract";
import { timelineRowsEnvelopeByteLength } from "./timeline-row-bytes.js";

const DEFAULT_MAX_ENTRIES = 64;

const DEFAULT_RING_SIZE = 4;

const DEFAULT_MAX_ENTRY_BYTES = 1024 * 1024;

const DEFAULT_MAX_BYTES = 8 * 1024 * 1024;

interface TimelineLatestRows {
  maxSeq: number;
  revision?: string;
  rows: readonly TimelineRow[];
}

interface TimelineLatestRowsCache {
  get(
    threadId: string,
    paramsKey: string,
    maxSeq: number,
    revision?: string,
  ): TimelineLatestRows | undefined;
  invalidateThread(threadId: string): void;
  set(threadId: string, paramsKey: string, value: TimelineLatestRows): void;
  readonly size: number;
}

interface TimelineLatestRowsCacheEntry {
  ring: TimelineLatestRowsSnapshot[];
  weight: number;
  threadId: string;
}

interface TimelineLatestRowsSnapshot {
  value: TimelineLatestRows;
  weight: number;
}

export function createTimelineLatestRowsCache(
  options: {
    maxEntries?: number;
    ringSize?: number;
    maxEntryBytes?: number;
    maxBytes?: number;
  } = {},
): TimelineLatestRowsCache {
  const maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;
  const ringSize = options.ringSize ?? DEFAULT_RING_SIZE;
  const maxEntryBytes = options.maxEntryBytes ?? DEFAULT_MAX_ENTRY_BYTES;
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  const entries = new Map<string, TimelineLatestRowsCacheEntry>();
  let retainedBytes = 0;

  function touch(paramsKey: string, entry: TimelineLatestRowsCacheEntry): void {
    entries.delete(paramsKey);
    entries.set(paramsKey, entry);
  }

  function removeEntry(paramsKey: string): void {
    const entry = entries.get(paramsKey);

    if (entry === undefined) {
      return;
    }

    entries.delete(paramsKey);
    retainedBytes -= entry.weight;
  }

  function removeSnapshot(
    entry: TimelineLatestRowsCacheEntry,
    index: number,
  ): void {
    const [snapshot] = entry.ring.splice(index, 1);

    if (snapshot === undefined) {
      return;
    }

    entry.weight -= snapshot.weight;
    retainedBytes -= snapshot.weight;
  }

  function evictToLimits(): void {
    while (entries.size > maxEntries || retainedBytes > maxBytes) {
      const oldest = entries.keys().next().value;

      if (oldest === undefined) {
        break;
      }

      removeEntry(oldest);
    }
  }

  return {
    get(threadId, paramsKey, maxSeq, revision) {
      const entry = entries.get(paramsKey);

      if (entry === undefined || entry.threadId !== threadId) {
        return undefined;
      }

      touch(paramsKey, entry);

      return entry.ring.find(
        (snapshot) =>
          snapshot.value.maxSeq === maxSeq &&
          snapshot.value.revision === revision,
      )?.value;
    },
    invalidateThread(threadId) {
      for (const [paramsKey, entry] of entries) {
        if (entry.threadId === threadId) {
          removeEntry(paramsKey);
        }
      }
    },
    set(threadId, paramsKey, value) {
      const weight = timelineRowsEnvelopeByteLength(value);
      let entry = entries.get(paramsKey);

      if (entry !== undefined && entry.threadId !== threadId) {
        removeEntry(paramsKey);
        entry = undefined;
      }

      const existingIndex =
        entry?.ring.findIndex(
          (snapshot) =>
            snapshot.value.maxSeq === value.maxSeq &&
            snapshot.value.revision === value.revision,
        ) ?? -1;

      if (existingIndex !== -1 && entry !== undefined) {
        removeSnapshot(entry, existingIndex);
      }

      if (weight > maxEntryBytes || weight > maxBytes) {
        if (entry !== undefined && entry.ring.length === 0) {
          removeEntry(paramsKey);
        } else if (entry !== undefined) {
          touch(paramsKey, entry);
        }

        return;
      }

      if (entry === undefined) {
        entry = { ring: [], weight: 0, threadId };
      }

      if (ringSize <= 0) {
        touch(paramsKey, entry);
        evictToLimits();

        return;
      }

      while (entry.ring.length >= ringSize) {
        removeSnapshot(entry, 0);
      }

      entry.ring.push({ value, weight });
      entry.weight += weight;
      retainedBytes += weight;
      touch(paramsKey, entry);
      evictToLimits();
    },
    get size() {
      return entries.size;
    },
  };
}
