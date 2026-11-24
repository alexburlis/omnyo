const TIMELINE_CACHE_MAX_BYTES = 512 * 1024 * 1024;

interface TimelineRetentionCandidate {
  threadId: string;
  bytes: number;
  active: boolean;
  retained: boolean;
}

export function selectTimelineCacheEvictions(
  candidates: readonly TimelineRetentionCandidate[],
): string[] {
  let bytes = candidates.reduce(
    (total, candidate) => total + candidate.bytes,
    0,
  );

  const evictions: string[] = [];

  for (const retained of [false, true]) {
    for (const candidate of candidates) {
      if (bytes <= TIMELINE_CACHE_MAX_BYTES) return evictions;

      if (candidate.active || candidate.retained !== retained) continue;
      evictions.push(candidate.threadId);
      bytes -= candidate.bytes;
    }
  }

  return evictions;
}
