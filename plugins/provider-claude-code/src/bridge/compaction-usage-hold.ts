import type {
  ThreadDelta,
  ThreadEventTokenUsageBreakdown,
} from "@omnyo/plugin-sdk/provider-bridge";
import { sdkUsageSchema } from "../schemas.js";
import type { CompactionApiRequestUsage } from "./compaction-telemetry.js";

type UsageDelta = Extract<ThreadDelta, { kind: "usage" }>;

const ONE_HOUR_PROMPT_CACHE_TTL_MS = 3_600_000;

const FIVE_MINUTE_PROMPT_CACHE_TTL_MS = 300_000;

const SAME_TURN_DELTA_KINDS: ReadonlySet<ThreadDelta["kind"]> = new Set([
  "contextWindow",
  "provider.rateLimits",
  "provider.warning",
  "provider.modelFallback",
  "thread.identity",
  "thread.name",
  "extension.state",
  "unhandled",
]);

export interface CompactionUsageRelease {
  last: ThreadEventTokenUsageBreakdown;
  total: ThreadEventTokenUsageBreakdown;
  promptCacheTtlMs: number | null;
}

export interface CompactionUsageHolds {
  hold(threadId: string): number;
  endCapture(threadId: string, generation: number): void;
  isHolding(threadId: string, generation: number): boolean;
  offer(threadId: string, deltas: readonly ThreadDelta[]): ThreadDelta[];
  release(
    threadId: string,
    generation: number,
    usage: CompactionUsageRelease | null,
  ): void;
  flush(threadId: string): void;
}

export function toCompactionTokenUsage(
  usage: CompactionApiRequestUsage,
): ThreadEventTokenUsageBreakdown {
  const cachedInputTokens = usage.cacheReadTokens + usage.cacheCreationTokens;

  return {
    totalTokens: usage.inputTokens + usage.outputTokens + cachedInputTokens,
    inputTokens: usage.inputTokens,
    cachedInputTokens,
    cacheReadInputTokens: usage.cacheReadTokens,
    cacheWriteInputTokens: usage.cacheCreationTokens,
    outputTokens: usage.outputTokens,
    reasoningOutputTokens: 0,
  };
}

export function compactionPromptCacheTtlMs(
  usage: CompactionApiRequestUsage,
): number | null {
  if (usage.cacheCreation1hTokens > 0) return ONE_HOUR_PROMPT_CACHE_TTL_MS;

  if (usage.cacheCreationTokens > 0) return FIVE_MINUTE_PROMPT_CACHE_TTL_MS;

  return null;
}

export function hasZeroResultUsage(usage: unknown): boolean {
  const parsed = sdkUsageSchema.safeParse(usage);

  if (!parsed.success) return true;

  return (
    (parsed.data.input_tokens ?? 0) === 0 &&
    (parsed.data.output_tokens ?? 0) === 0 &&
    (parsed.data.cache_read_input_tokens ?? 0) === 0 &&
    (parsed.data.cache_creation_input_tokens ?? 0) === 0
  );
}

function replacementUsage(
  held: UsageDelta | null,
  usage: CompactionUsageRelease,
): UsageDelta {
  const promptCacheTtlMs = usage.promptCacheTtlMs ?? held?.promptCacheTtlMs;

  return {
    kind: "usage",
    total: usage.total,
    last: usage.last,
    modelContextWindow: held?.modelContextWindow ?? null,
    ...(promptCacheTtlMs === undefined ? {} : { promptCacheTtlMs }),
  };
}

function turnUsageIndex(deltas: readonly ThreadDelta[]): number {
  for (const [index, delta] of deltas.entries()) {
    if (delta.kind === "turn.boundary") return -1;

    if (delta.kind === "usage") return index;
  }

  return -1;
}

interface HeldCompactionUsage {
  generation: number;
  capturing: boolean;
  usage: UsageDelta | null;
}

export function createCompactionUsageHolds(
  send: (threadId: string, deltas: readonly ThreadDelta[]) => void,
): CompactionUsageHolds {
  const held = new Map<string, HeldCompactionUsage>();
  let nextGeneration = 0;

  function take(threadId: string): HeldCompactionUsage | undefined {
    const hold = held.get(threadId);

    if (hold !== undefined) held.delete(threadId);

    return hold;
  }

  function sendHeld(threadId: string): void {
    const usage = take(threadId)?.usage;

    if (usage !== undefined && usage !== null) send(threadId, [usage]);
  }

  return {
    hold(threadId) {
      sendHeld(threadId);
      nextGeneration += 1;
      held.set(threadId, {
        generation: nextGeneration,
        capturing: true,
        usage: null,
      });

      return nextGeneration;
    },
    endCapture(threadId, generation) {
      const hold = held.get(threadId);

      if (hold?.generation === generation) hold.capturing = false;
    },
    isHolding(threadId, generation) {
      return held.get(threadId)?.generation === generation;
    },
    offer(threadId, deltas) {
      const hold = held.get(threadId);

      if (hold === undefined) return [...deltas];

      if (hold.capturing) {
        const usageIndex = hold.usage === null ? turnUsageIndex(deltas) : -1;
        const usage = deltas[usageIndex];

        if (usage?.kind !== "usage") return [...deltas];
        hold.usage = usage;

        return deltas.filter((_, index) => index !== usageIndex);
      }

      if (deltas.every((delta) => SAME_TURN_DELTA_KINDS.has(delta.kind)))
        return [...deltas];
      held.delete(threadId);

      return hold.usage === null ? [...deltas] : [hold.usage, ...deltas];
    },
    release(threadId, generation, usage) {
      if (held.get(threadId)?.generation !== generation) return;
      const hold = take(threadId);

      if (hold === undefined) return;

      if (usage !== null) {
        send(threadId, [replacementUsage(hold.usage, usage)]);

        return;
      }

      if (hold.usage !== null) send(threadId, [hold.usage]);
    },
    flush(threadId) {
      sendHeld(threadId);
    },
  };
}
