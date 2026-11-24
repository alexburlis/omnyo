import { useEffect, useLayoutEffect, useState, type RefObject } from "react";
import { MOTION_DURATION_MS } from "@omnyo/shared-ui/motion";
import {
  STREAMING_WORD_ATTRIBUTE,
  STREAMING_WORD_LIMIT,
} from "@/components/ui/markdown-streaming-words";

const STREAMING_WORD_SELECTOR = `[${STREAMING_WORD_ATTRIBUTE}]`;

const STREAMING_WORD_FADE_MS = MOTION_DURATION_MS.base;

const STREAMING_WORD_STAGGER_MS = STREAMING_WORD_FADE_MS / STREAMING_WORD_LIMIT;

const STREAMING_WORD_START_OPACITY = 0.08;

interface StreamingReplyTailState {
  arrivals: Map<number, number>;
  frame: number | null;
  lastArrival: number;
  observed: boolean;
  tailKey: string | null;
  words: HTMLElement[];
}

function streamingWordOpacity(age: number): number | null {
  if (age >= STREAMING_WORD_FADE_MS) return null;
  const progress = Math.max(0, age) / STREAMING_WORD_FADE_MS;
  const eased = 1 - (1 - progress) ** 3;

  return (
    STREAMING_WORD_START_OPACITY + (1 - STREAMING_WORD_START_OPACITY) * eased
  );
}

function paintStreamingWords(
  state: StreamingReplyTailState,
  now: number,
): boolean {
  let fading = false;

  for (const word of state.words) {
    const arrival = state.arrivals.get(
      Number(word.getAttribute(STREAMING_WORD_ATTRIBUTE)),
    );

    const opacity =
      arrival === undefined ? null : streamingWordOpacity(now - arrival);

    if (opacity === null) {
      word.style.removeProperty("opacity");
    } else {
      fading = true;
      word.style.opacity = opacity.toFixed(3);
    }
  }

  return fading;
}

function stopStreamingWordFrame(state: StreamingReplyTailState): void {
  if (state.frame === null) return;
  cancelAnimationFrame(state.frame);
  state.frame = null;
}

function scheduleStreamingWordFrame(state: StreamingReplyTailState): void {
  if (state.frame !== null) return;

  state.frame = requestAnimationFrame((now) => {
    state.frame = null;

    if (paintStreamingWords(state, now)) scheduleStreamingWordFrame(state);
  });
}

function observeStreamingWords(
  state: StreamingReplyTailState,
  container: HTMLElement,
  tailKey: string,
): void {
  if (state.tailKey !== tailKey) {
    state.arrivals.clear();
    state.tailKey = tailKey;
  }

  state.words = [
    ...container.querySelectorAll<HTMLElement>(STREAMING_WORD_SELECTOR),
  ];

  const now = performance.now();
  const present = new Set<number>();

  for (const word of state.words) {
    const ordinal = Number(word.getAttribute(STREAMING_WORD_ATTRIBUTE));
    present.add(ordinal);

    if (state.arrivals.has(ordinal)) continue;

    if (!state.observed) {
      state.arrivals.set(ordinal, Number.NEGATIVE_INFINITY);
      continue;
    }

    const arrival = Math.max(
      now,
      state.lastArrival + STREAMING_WORD_STAGGER_MS,
    );

    state.arrivals.set(ordinal, arrival);
    state.lastArrival = arrival;
  }

  for (const ordinal of state.arrivals.keys()) {
    if (!present.has(ordinal)) state.arrivals.delete(ordinal);
  }

  state.observed = true;

  if (paintStreamingWords(state, now)) {
    scheduleStreamingWordFrame(state);
  } else {
    stopStreamingWordFrame(state);
  }
}

function createStreamingReplyTailState(): StreamingReplyTailState {
  return {
    arrivals: new Map(),
    frame: null,
    lastArrival: Number.NEGATIVE_INFINITY,
    observed: false,
    tailKey: null,
    words: [],
  };
}

function resetStreamingWords(state: StreamingReplyTailState): void {
  stopStreamingWordFrame(state);
  state.arrivals.clear();
  state.lastArrival = Number.NEGATIVE_INFINITY;
  state.observed = false;
  state.tailKey = null;
  state.words = [];
}

export function useStreamingReplyTail(
  containerRef: RefObject<HTMLElement | null>,
  enabled: boolean,
  tailKey: string,
): void {
  const [state] = useState(createStreamingReplyTailState);

  useLayoutEffect(() => {
    const container = containerRef.current;

    if (!enabled || container === null) {
      resetStreamingWords(state);

      return;
    }

    observeStreamingWords(state, container, tailKey);
  });

  useEffect(() => () => stopStreamingWordFrame(state), [state]);
}
