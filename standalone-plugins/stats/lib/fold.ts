import type { PluginApi } from "@omnyo/plugin-sdk";
import { z } from "zod";
import {
  cohortSchema,
  emptyCounters,
  type Cohort,
  type CommitPart,
  type Counters,
  type FoldLedger,
} from "../contract.ts";

export type EventRow = Awaited<ReturnType<PluginApi["sdk"]["threads"]["events"]["list"]>>[number];

export type Thread = Awaited<ReturnType<PluginApi["sdk"]["threads"]["get"]>>;

const executionSchema = z.object({
  model: z.string(),
  effort: z.string(),
  mode: z.string(),
  steer: z.boolean(),
  turnId: z.string().nullable(),
});

const usageSchema = z.object({
  input: z.number(),
  output: z.number(),
  total: z.number(),
  cached: z.number(),
  cacheRead: z.number(),
  cacheWrite: z.number(),
  reasoning: z.number(),
});

const turnSchema = z.object({
  id: z.string(),
  session: z.string(),
  at: z.number(),
  output: z.number(),
  usage: z.boolean(),
  uncertain: z.boolean(),
  attributed: z.boolean(),
  cohort: cohortSchema,
  open: z.record(z.string(), z.number()),
  intervals: z.array(z.tuple([z.number(), z.number()])),
});

export const stateSchema = z.object({
  version: z.literal(2),
  cohort: cohortSchema,
  turn: turnSchema.nullable(),
  requests: z.record(z.string(), executionSchema),
  native: z.record(z.string(), usageSchema),
  context: z
    .object({
      used: z.number().nullable(),
      capacity: z.number().nullable(),
      estimated: z.boolean(),
      at: z.number(),
    })
    .nullable(),
});

export type State = z.infer<typeof stateSchema>;

type Usage = z.infer<typeof usageSchema>;

export function initialState(cohort: Cohort): State {
  return {
    version: 2,
    cohort,
    turn: null,
    requests: {},
    native: {},
    context: null,
  };
}

function usage(input: {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  cachedInputTokens: number;
  reasoningOutputTokens: number;
  cacheReadInputTokens?: number;
  cacheWriteInputTokens?: number;
}): Usage {
  return {
    input: input.inputTokens,
    output: input.outputTokens,
    total: input.totalTokens,
    cached: input.cachedInputTokens,
    reasoning: input.reasoningOutputTokens,
    cacheRead: input.cacheReadInputTokens ?? 0,
    cacheWrite: input.cacheWriteInputTokens ?? 0,
  };
}

function attribute(state: State, requestId: string, ledger: FoldLedger): void {
  const request = state.requests[requestId];

  if (!request || !state.turn || request.turnId !== state.turn.id) return;

  if (!request.steer && !state.turn.attributed) {
    const scope = ledger.scope(state.turn.id);

    if (scope) ledger.saveScope(state.turn.id, { ...scope, key: "main" });
    state.turn.cohort = {
      ...state.cohort,
      model: request.model,
      effort: request.effort,
      mode: request.mode,
      agentRole: state.cohort.chatRole,
    };
    state.cohort = state.turn.cohort;
    state.turn.attributed = true;
  }

  delete state.requests[requestId];
}

function startTurn(state: State, id: string, session: string, at: number): void {
  state.turn = {
    id,
    session,
    at,
    output: 0,
    usage: false,
    uncertain: false,
    attributed: false,
    cohort: { ...state.cohort, model: "", effort: "", mode: "", agentRole: "unknown" },
    open: {},
    intervals: [],
  };
}

function blocked(intervals: [number, number][], from: number, to: number): number {
  let end = from;
  let result = 0;

  for (const [left, right] of intervals.slice().sort((a, b) => a[0] - b[0])) {
    result += Math.max(0, Math.min(to, right) - Math.max(from, left, end));
    end = Math.max(end, right);
  }

  return result;
}

function part(parts: Map<string, CommitPart>, cohort: Cohort): CommitPart {
  const key = JSON.stringify(cohort);
  let value = parts.get(key);

  if (!value) {
    value = { cohort: { ...cohort }, observations: [], samples: [] };
    parts.set(key, value);
  }

  return value;
}

function add(parts: Map<string, CommitPart>, cohort: Cohort, at: number, counters: Counters): void {
  part(parts, cohort).observations.push({ at, counters });
}

const blockedTypes = new Set([
  "toolCall",
  "commandExecution",
  "fileChange",
  "webSearch",
  "webFetch",
  "imageView",
  "imageGeneration",
  "delegation",
]);

export function fold(
  state: State,
  row: EventRow,
  parts: Map<string, CommitPart>,
  ledger: FoldLedger,
): void {
  const turnId = row.scope.kind === "turn" ? row.scope.turnId : null;

  switch (row.type) {
    case "client/turn/requested": {
      const request = row.data;

      if (
        request.target.kind === "steer" &&
        state.turn &&
        request.execution.model !== state.turn.cohort.model
      )
        state.turn.uncertain = true;
      state.requests[request.requestId] = {
        model: request.execution.model,
        effort: request.execution.reasoningLevel,
        mode: request.execution.serviceTier,
        steer: request.target.kind === "steer",
        turnId: null,
      };
      const keys = Object.keys(state.requests);

      if (keys.length > 32) delete state.requests[keys[0]];
      break;
    }

    case "turn/input/accepted": {
      const request = state.requests[row.data.clientRequestId];

      if (request) {
        request.turnId = turnId;
        const scope = turnId === null ? null : ledger.scope(turnId);

        if (turnId && scope && !scope.nested && !request.steer && state.turn?.id !== turnId)
          startTurn(state, turnId, scope.session, scope.at);
        attribute(state, row.data.clientRequestId, ledger);
      }

      break;
    }

    case "turn/started": {
      if (!turnId) break;
      ledger.saveScope(turnId, {
        key: row.data.parentToolCallId ? `agent:${row.data.parentToolCallId}` : `unknown:${turnId}`,
        nested: Boolean(row.data.parentToolCallId),
        at: row.createdAt,
        session: row.data.providerThreadId,
      });

      if (
        row.data.parentToolCallId ||
        state.turn?.id === turnId ||
        !Object.values(state.requests).some(
          (request) => request.turnId === turnId && !request.steer,
        )
      )
        break;
      startTurn(state, turnId, row.data.providerThreadId, row.createdAt);

      for (const key of Object.keys(state.requests)) attribute(state, key, ledger);
      break;
    }

    case "thread/tokenUsage/updated": {
      const total = usage(row.data.tokenUsage.total);
      const last = usage(row.data.tokenUsage.last);
      const scope = turnId === null ? null : ledger.scope(turnId);

      // Codex forwards independent native-agent cumulative ledgers. Claude's
      // translator maintains one cumulative ledger for the entire Omnyo chat.
      const stream = JSON.stringify([
        row.data.providerThreadId,
        state.cohort.provider === "codex"
          ? (scope?.key ?? (turnId === null ? "main" : `unknown:${turnId}`))
          : "main",
      ]);

      const keys: (keyof Usage)[] = [
        "input",
        "output",
        "total",
        "cached",
        "cacheRead",
        "cacheWrite",
        "reasoning",
      ];

      if (
        keys.some(
          (key) =>
            !Number.isSafeInteger(total[key]) ||
            total[key] < 0 ||
            !Number.isSafeInteger(last[key]) ||
            last[key] < 0,
        )
      )
        throw new Error("Invalid provider token counter");
      const baseline = ledger.stream(stream);
      const coreKeys: (keyof Usage)[] = ["input", "output", "total"];

      const reset = baseline === null || coreKeys.some((key) => total[key] < baseline[key]);

      const delta = { ...last };

      if (!reset && baseline)
        for (const key of keys) delta[key] = Math.max(0, total[key] - baseline[key]);
      const unknown = reset && keys.some((key) => total[key] !== last[key]);

      const counters = {
        ...emptyCounters(),
        ...delta,
        usageEvents: 1,
        unknownBaselines: unknown ? 1 : 0,
      };

      // Optional cache fields can disappear between snapshots. Preserve their
      // high water mark without resetting unrelated input/output counters.
      const next = { ...total };

      if (!reset && baseline)
        for (const key of keys) next[key] = Math.max(total[key], baseline[key]);
      ledger.saveStream(stream, next);
      const ownsTurn = state.turn !== null && (turnId === null || turnId === state.turn.id);

      const attributed = ownsTurn
        ? (state.turn?.cohort ?? state.cohort)
        : { ...state.cohort, model: "", effort: "", mode: "" };

      const cohort: Cohort = {
        ...attributed,
        agentRole: scope?.nested
          ? "subagent"
          : turnId !== null && scope?.key === "main"
            ? state.cohort.chatRole
            : "unknown",
      };

      if (keys.some((key) => delta[key] > 0) || unknown)
        add(parts, cohort, row.createdAt, counters);

      if (state.turn && ownsTurn) {
        state.turn.output += delta.output;
        state.turn.usage = true;

        if (unknown || (!reset && delta.output > 0 && delta.output !== last.output))
          state.turn.uncertain = true;
      }

      break;
    }

    case "provider/modelFallback": {
      if (state.turn) {
        state.turn.uncertain = true;
        state.turn.cohort.model = "";
      }

      state.cohort.model = "";
      break;
    }

    case "item/started":
    case "item/completed": {
      const item = row.data.item;
      const turn = state.turn;

      if (
        !turn ||
        (turnId !== null && turnId !== turn.id) ||
        ("parentToolCallId" in item && item.parentToolCallId)
      )
        break;

      if (!blockedTypes.has(item.type)) break;
      const key = `tool:${item.id}`;

      if (row.type === "item/started") {
        if (Object.keys(turn.open).length < 512 || turn.open[key] !== undefined)
          turn.open[key] ??= row.createdAt;
        else turn.uncertain = true;
      } else {
        const duration = "durationMs" in item ? item.durationMs : undefined;

        const start =
          turn.open[key] ??
          (duration !== undefined && duration >= 0 ? row.createdAt - duration : null);

        if (start === null || start > row.createdAt) turn.uncertain = true;
        else if (turn.intervals.length < 512) turn.intervals.push([start, row.createdAt]);
        else turn.uncertain = true;
        delete turn.open[key];
        const counters = emptyCounters();
        counters.toolCalls = 1;
        add(parts, turn.cohort, row.createdAt, counters);
      }

      break;
    }

    case "system/interaction/lifecycle": {
      const turn = state.turn;

      if (!turn || row.data.interaction.status === "resolving") break;
      const key = `wait:${row.data.interaction.id}`;

      if (row.data.interaction.status === "pending") {
        if (Object.keys(turn.open).length < 512 || turn.open[key] !== undefined)
          turn.open[key] ??= row.createdAt;
        else turn.uncertain = true;
      } else {
        const start = turn.open[key];

        if (start === undefined || start > row.createdAt) turn.uncertain = true;
        else if (turn.intervals.length < 512) turn.intervals.push([start, row.createdAt]);
        else turn.uncertain = true;
        delete turn.open[key];
      }

      break;
    }

    case "item/backgroundTask/completed": {
      const supplied = row.data.item.usage;

      if (!supplied || !["local_agent", "local_subagent"].includes(row.data.item.taskType)) break;
      const previous = state.native[row.data.item.id];

      const current = {
        input: 0,
        output: 0,
        total: supplied.totalTokens,
        cached: supplied.toolUses,
        reasoning: supplied.durationMs,
        cacheRead: 0,
        cacheWrite: 0,
      };

      const counters = emptyCounters();
      counters.nativeTokens = Math.max(0, current.total - (previous?.total ?? 0));
      counters.nativeToolUses = Math.max(0, current.cached - (previous?.cached ?? 0));
      counters.nativeMs = Math.max(0, current.reasoning - (previous?.reasoning ?? 0));
      state.native[row.data.item.id] = current;
      const keys = Object.keys(state.native);

      if (keys.length > 64) delete state.native[keys[0]];
      add(
        parts,
        { ...state.cohort, model: "", effort: "", mode: "", agentRole: "subagent" },
        row.createdAt,
        counters,
      );
      break;
    }

    case "thread/contextWindowUsage/updated": {
      const context = row.data.contextWindowUsage;
      state.context = {
        used: context.usedTokens,
        capacity: context.modelContextWindow,
        estimated: context.estimated,
        at: row.createdAt,
      };
      break;
    }

    case "turn/completed": {
      const turn = state.turn;

      if (!turn || turnId !== turn.id) break;
      const counters = emptyCounters();
      counters.turns = 1;

      if (row.data.status !== "completed") counters.failedTurns = 1;
      const elapsed = row.createdAt - turn.at - blocked(turn.intervals, turn.at, row.createdAt);

      const measured =
        row.data.status === "completed" &&
        !turn.uncertain &&
        turn.attributed &&
        turn.usage &&
        turn.output > 0 &&
        elapsed > 0 &&
        Object.keys(turn.open).length === 0;

      if (measured) {
        counters.measuredTurns = 1;
        counters.modelMs = elapsed;
        counters.speedOutput = turn.output;
        part(parts, turn.cohort).samples.push({
          id: `${row.threadId}:${turn.session}:${turn.id}`,
          at: row.createdAt,
          output: turn.output,
          modelMs: elapsed,
        });
      }

      add(parts, turn.cohort, row.createdAt, counters);
      state.turn = null;
      break;
    }
  }
}
