import { withLocalStorage } from "./browser-storage";

export const TIMELINE_GAP_TRACE_STORAGE_KEY = "omnyo:timeline-gap-trace";

const MAX_TIMELINE_GAP_TRACE_ENTRIES = 60;

export type TimelineGapTraceEntry = {
  kind: "open-fresh";
  threadId: string;
  durationMs: number;
  hadCachedRows: boolean;
};

export function readTimelineGapTrace(): unknown[] {
  return withLocalStorage((storage) => {
    const stored = storage.getItem(TIMELINE_GAP_TRACE_STORAGE_KEY);

    if (stored === null) return [];
    const parsed: unknown = JSON.parse(stored);

    return Array.isArray(parsed) ? parsed : [];
  }, []);
}

export function recordTimelineGapTrace(entry: TimelineGapTraceEntry): void {
  withLocalStorage((storage) => {
    const entries = [
      ...readTimelineGapTrace(),
      { at: new Date().toISOString(), ...entry },
    ].slice(-MAX_TIMELINE_GAP_TRACE_ENTRIES);

    storage.setItem(TIMELINE_GAP_TRACE_STORAGE_KEY, JSON.stringify(entries));
  }, undefined);
}
