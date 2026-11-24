import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  SDKMessage,
  SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import type { JsonValue } from "@omnyo/plugin-sdk/provider-bridge";
import {
  experimental_assembleCapturedThreadEvents as assembleCapturedThreadEvents,
  experimental_createBridgeJsonRpcTestHarness as createBridgeJsonRpcTestHarness,
} from "@omnyo/plugin-sdk/provider-bridge/testing";
import type { ThreadEvent } from "@omnyo/plugin-sdk/provider-bridge/testing";

const { queryMock } = vi.hoisted(() => ({ queryMock: vi.fn() }));

vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  query: queryMock,
  forkSession: vi.fn(),
  createSdkMcpServer: vi.fn(() => ({})),
  tool: vi.fn((_name, _desc, _schema, handler) => handler),
}));

import { handleLine } from "../bridge.js";

type SdkResultUsage = Extract<SDKMessage, { type: "result" }>["usage"];

type BridgeHarness = ReturnType<typeof createBridgeJsonRpcTestHarness>;

interface ControlledQuery {
  emit(message: SDKMessage): void;
  finish(): void;
  prompts: AsyncIterable<SDKUserMessage>;
}

const FIXTURE_PATH = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../__fixtures__/otlp-api-request-logs.json",
);

const COMPACT_INPUT: JsonValue[] = [
  {
    type: "text",
    text: "/compact",
    mentions: [
      {
        start: 0,
        end: "/compact".length,
        resource: {
          kind: "command",
          trigger: "/",
          name: "compact",
          source: "command",
          origin: "builtin",
          label: "compact",
          argumentHint: null,
        },
      },
    ],
  },
];

const CANONICAL_OPTIONS: Record<string, JsonValue> = {
  permissionMode: "accept-edits",
  permissionScope: "workspace",
  approvalReviewer: "user",
  permissionEscalation: "ask",
  instructions: "test",
  providerOptions: { workflowsEnabled: false },
};

const ZERO_USAGE = { input: 0, output: 0, read: 0, write: 0 };

const NEXT_TURN_USAGE = { input: 4, output: 6, read: 3_000, write: 50 };

function createControlledQuery(prompts: AsyncIterable<SDKUserMessage>): {
  query: Record<string | symbol, unknown>;
  controlled: ControlledQuery;
} {
  const pending: IteratorResult<SDKMessage>[] = [];
  let resolveNext: ((result: IteratorResult<SDKMessage>) => void) | undefined;

  function push(result: IteratorResult<SDKMessage>): void {
    if (resolveNext !== undefined) {
      const resolveResult = resolveNext;
      resolveNext = undefined;
      resolveResult(result);

      return;
    }

    pending.push(result);
  }

  const iterator: AsyncIterator<SDKMessage> = {
    next: () => {
      const next = pending.shift();

      if (next !== undefined) return Promise.resolve(next);

      return new Promise((resolveResult) => {
        resolveNext = resolveResult;
      });
    },
    return: async () => ({ value: undefined, done: true }),
  };

  return {
    query: {
      applyFlagSettings: vi.fn().mockResolvedValue(undefined),
      close: vi.fn(() => push({ value: undefined, done: true })),
      getContextUsage: vi.fn().mockResolvedValue(null),
      initializationResult: vi.fn().mockResolvedValue({ models: [] }),
      interrupt: vi.fn().mockResolvedValue(undefined),
      mcpServerStatus: vi.fn().mockResolvedValue([]),
      setModel: vi.fn().mockResolvedValue(undefined),
      setPermissionMode: vi.fn().mockResolvedValue(undefined),
      [Symbol.asyncIterator]: () => iterator,
    },
    controlled: {
      emit: (message) => push({ value: message, done: false }),
      finish: () => push({ value: undefined, done: true }),
      prompts,
    },
  };
}

function resultUsage(counts: typeof ZERO_USAGE): SdkResultUsage {
  return {
    cache_creation: {
      ephemeral_1h_input_tokens: counts.write,
      ephemeral_5m_input_tokens: 0,
    },
    cache_creation_input_tokens: counts.write,
    cache_read_input_tokens: counts.read,
    inference_geo: "",
    input_tokens: counts.input,
    iterations: [],
    output_tokens: counts.output,
    server_tool_use: { web_fetch_requests: 0, web_search_requests: 0 },
    service_tier: "standard",
    speed: "standard",
  };
}

function successResult(sessionId: string, usage: SdkResultUsage): SDKMessage {
  return {
    type: "result",
    subtype: "success",
    duration_ms: 1,
    duration_api_ms: 1,
    is_error: false,
    num_turns: 1,
    result: "",
    stop_reason: "end_turn",
    total_cost_usd: 0,
    usage,
    modelUsage: {},
    permission_denials: [],
    uuid: "00000000-0000-4000-8000-000000000010",
    session_id: sessionId,
  };
}

function systemInit(sessionId: string): SDKMessage {
  return {
    type: "system",
    subtype: "init",
    apiKeySource: "none",
    claude_code_version: "2.1.322",
    cwd: "/tmp/worktree",
    tools: [],
    mcp_servers: [],
    model: "claude-opus-5-5",
    permissionMode: "default",
    slash_commands: [],
    output_style: "default",
    skills: [],
    plugins: [],
    uuid: "00000000-0000-4000-8000-000000000014",
    session_id: sessionId,
  };
}

function statusMessage(sessionId: string, compacting: boolean): SDKMessage {
  return {
    type: "system",
    subtype: "status",
    status: compacting ? "compacting" : null,
    uuid: "00000000-0000-4000-8000-000000000011",
    session_id: sessionId,
  };
}

function compactBoundary(sessionId: string): SDKMessage {
  return {
    type: "system",
    subtype: "compact_boundary",
    uuid: "00000000-0000-4000-8000-000000000012",
    session_id: sessionId,
    compact_metadata: {
      trigger: "manual",
      pre_tokens: 92_000,
      post_tokens: 3_000,
    },
  };
}

function assistantText(sessionId: string): SDKMessage {
  return {
    type: "assistant",
    message: {
      id: "msg-after-compact",
      type: "message",
      role: "assistant",
      container: null,
      content: [{ type: "text", text: "Continuing.", citations: null }],
      context_management: null,
      model: "claude-opus-5-5",
      stop_details: null,
      stop_reason: "end_turn",
      stop_sequence: null,
      usage: resultUsage(NEXT_TURN_USAGE),
    },
    parent_tool_use_id: null,
    uuid: "00000000-0000-4000-8000-000000000013",
    session_id: sessionId,
  };
}

function turnParams(
  threadId: string,
  requestId: string,
  input: JsonValue[],
): Record<string, JsonValue> {
  return {
    threadId,
    providerThreadId: threadId,
    clientRequestId: requestId,
    input,
    options: CANONICAL_OPTIONS,
  };
}

function tokenUsageEvents(
  events: ThreadEvent[],
): Extract<ThreadEvent, { type: "thread/tokenUsage/updated" }>[] {
  return events.flatMap((event) =>
    event.type === "thread/tokenUsage/updated" ? [event] : [],
  );
}

function completedTurns(bridge: BridgeHarness): ThreadEvent[] {
  return assembleCapturedThreadEvents(bridge.messages, "claude-code").filter(
    (event) => event.type === "turn/completed",
  );
}

function turnIdOf(event: ThreadEvent): string | undefined {
  return event.scope.kind === "turn" ? event.scope.turnId : undefined;
}

function liveSessionEnv(): Record<string, string> {
  const options: unknown = queryMock.mock.calls[0]?.[0]?.options;

  if (
    options === null ||
    typeof options !== "object" ||
    !("env" in options) ||
    options.env === null ||
    typeof options.env !== "object"
  ) {
    throw new Error("Expected Claude session env");
  }

  return Object.fromEntries(
    Object.entries(options.env).flatMap(([key, value]) =>
      typeof value === "string" ? [[key, value]] : [],
    ),
  );
}

function exporterHeaders(env: Record<string, string>): Headers {
  const headers = new Headers({ "content-type": "application/json" });

  for (const pair of (env.OTEL_EXPORTER_OTLP_LOGS_HEADERS ?? "").split(",")) {
    const separator = pair.indexOf("=");
    headers.set(pair.slice(0, separator), pair.slice(separator + 1));
  }

  return headers;
}

describe("standalone /compact usage from Claude Code telemetry", () => {
  const queries: ControlledQuery[] = [];

  beforeEach(() => {
    queries.length = 0;
    queryMock.mockClear();
    queryMock.mockImplementation(
      (args: { prompt: AsyncIterable<SDKUserMessage> }) => {
        const { query, controlled } = createControlledQuery(args.prompt);
        queries.push(controlled);

        return query;
      },
    );
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  async function startCompaction(
    bridge: BridgeHarness,
    threadId: string,
    envVars?: Record<string, string>,
  ): Promise<ControlledQuery> {
    bridge.sendRequest(1, "thread/start", {
      threadId,
      cwd: "/tmp/worktree",
      instructionMode: "append",
      options:
        envVars === undefined
          ? CANONICAL_OPTIONS
          : { ...CANONICAL_OPTIONS, envVars },
    });
    await bridge.waitForResponse(1);
    bridge.sendRequest(
      2,
      "turn/start",
      turnParams(threadId, "creq_cmpactaaaa", COMPACT_INPUT),
    );
    const query = queries[0];

    if (query === undefined) throw new Error("Expected a Claude query");
    await query.prompts[Symbol.asyncIterator]().next();
    await bridge.waitForResponse(2);
    query.emit(systemInit(threadId));

    return query;
  }

  function emitZeroUsageCompaction(
    query: ControlledQuery,
    threadId: string,
  ): void {
    query.emit(statusMessage(threadId, true));
    query.emit(compactBoundary(threadId));
    query.emit(statusMessage(threadId, false));
    query.emit(successResult(threadId, resultUsage(ZERO_USAGE)));
  }

  async function startNextTurn(
    bridge: BridgeHarness,
    query: ControlledQuery,
    threadId: string,
  ): Promise<void> {
    bridge.sendRequest(
      3,
      "turn/start",
      turnParams(threadId, "creq_nextturnaa", [
        { type: "text", text: "next", mentions: [] },
      ]),
    );
    await query.prompts[Symbol.asyncIterator]().next();
    await bridge.waitForResponse(3);
    query.emit(assistantText(threadId));
    query.emit(successResult(threadId, resultUsage(NEXT_TURN_USAGE)));
    await bridge.flushWork();
  }

  async function postCompactTelemetry(
    env: Record<string, string>,
    threadId: string,
  ): Promise<void> {
    const response = await fetch(env.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT ?? "", {
      method: "POST",
      headers: exporterHeaders(env),
      body: readFileSync(FIXTURE_PATH, "utf8").replaceAll(
        "SESSION_ID",
        threadId,
      ),
    });

    expect(response.status).toBe(200);
  }

  function assembled(bridge: BridgeHarness) {
    const events = assembleCapturedThreadEvents(bridge.messages, "claude-code");

    return {
      turnIds: events
        .filter((event) => event.type === "turn/started")
        .map(turnIdOf),
      usage: tokenUsageEvents(events),
    };
  }

  async function stopThread(
    bridge: BridgeHarness,
    threadId: string,
  ): Promise<void> {
    bridge.sendRequest(99, "thread/stop", {
      threadId,
      providerThreadId: threadId,
      intent: "interrupt",
      activeTurnId: null,
    });
    await bridge.flushWork();
    queries[0]?.finish();
    await bridge.waitForResponse(99);
  }

  const COMPACT_LAST = {
    totalTokens: 10 + 2_500 + 91_200 + 800,
    inputTokens: 10,
    cachedInputTokens: 92_000,
    cacheReadInputTokens: 91_200,
    cacheWriteInputTokens: 800,
    outputTokens: 2_500,
    reasoningOutputTokens: 0,
  };

  const ZERO_LAST = {
    totalTokens: 0,
    inputTokens: 0,
    cachedInputTokens: 0,
    cacheReadInputTokens: 0,
    cacheWriteInputTokens: 0,
    outputTokens: 0,
    reasoningOutputTokens: 0,
  };

  it("ends the /compact turn at once and attaches the compact api_request usage to it", async () => {
    const bridge = createBridgeJsonRpcTestHarness(handleLine);
    const threadId = "thread-compact-usage";

    try {
      const query = await startCompaction(bridge, threadId);
      const env = liveSessionEnv();

      expect(env).toMatchObject({
        CLAUDE_CODE_ENABLE_TELEMETRY: "1",
        OTEL_LOGS_EXPORTER: "otlp",
        OTEL_EXPORTER_OTLP_LOGS_PROTOCOL: "http/json",
        OTEL_LOGS_EXPORT_INTERVAL: "1000",
      });

      emitZeroUsageCompaction(query, threadId);
      await bridge.flushWork();

      expect(completedTurns(bridge)).toHaveLength(1);
      expect(assembled(bridge).usage).toEqual([]);

      await postCompactTelemetry(env, threadId);
      await vi.waitFor(() => expect(assembled(bridge).usage).toHaveLength(1));

      await startNextTurn(bridge, query, threadId);

      const { turnIds, usage } = assembled(bridge);

      expect(turnIds).toHaveLength(2);
      expect(usage.map(turnIdOf)).toEqual(turnIds);
      expect(usage[0]?.tokenUsage).toMatchObject({
        last: COMPACT_LAST,
        total: COMPACT_LAST,
        promptCacheTtlMs: 3_600_000,
      });
      expect(usage[1]?.tokenUsage.last).toMatchObject({
        inputTokens: 4,
        outputTokens: 6,
      });
      expect(usage[1]?.tokenUsage.total).toMatchObject({
        inputTokens: 14,
        outputTokens: 2_506,
        cacheReadInputTokens: 94_200,
      });
    } finally {
      await stopThread(bridge, threadId);
      bridge.restore();
    }
  });

  it("keeps the zero usage on the /compact turn when the next turn starts before the event", async () => {
    const bridge = createBridgeJsonRpcTestHarness(handleLine);
    const threadId = "thread-compact-next-first";

    try {
      const query = await startCompaction(bridge, threadId);
      const env = liveSessionEnv();

      emitZeroUsageCompaction(query, threadId);
      await bridge.flushWork();
      await startNextTurn(bridge, query, threadId);
      await postCompactTelemetry(env, threadId);
      await bridge.flushWork();

      const { turnIds, usage } = assembled(bridge);

      expect(completedTurns(bridge)).toHaveLength(2);
      expect(usage.map(turnIdOf)).toEqual(turnIds);
      expect(usage.map((event) => event.tokenUsage.last)).toEqual([
        ZERO_LAST,
        expect.objectContaining({ inputTokens: 4, outputTokens: 6 }),
      ]);
    } finally {
      await stopThread(bridge, threadId);
      bridge.restore();
    }
  });

  it("sends the zero usage after 10 seconds when no event arrives", async () => {
    const bridge = createBridgeJsonRpcTestHarness(handleLine);
    const threadId = "thread-compact-no-usage";

    try {
      const query = await startCompaction(bridge, threadId);

      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      emitZeroUsageCompaction(query, threadId);
      await vi.advanceTimersByTimeAsync(9_000);

      expect(completedTurns(bridge)).toHaveLength(1);
      expect(assembled(bridge).usage).toEqual([]);

      await vi.advanceTimersByTimeAsync(1_100);
      vi.useRealTimers();

      expect(
        assembled(bridge).usage.map((event) => event.tokenUsage.last),
      ).toEqual([ZERO_LAST]);
    } finally {
      vi.useRealTimers();
      await stopThread(bridge, threadId);
      bridge.restore();
    }
  });

  it("does not wait when an env override turns the telemetry off", async () => {
    const bridge = createBridgeJsonRpcTestHarness(handleLine);
    const threadId = "thread-compact-telemetry-off";

    try {
      const query = await startCompaction(bridge, threadId, {
        CLAUDE_CODE_ENABLE_TELEMETRY: "0",
      });

      expect(liveSessionEnv().CLAUDE_CODE_ENABLE_TELEMETRY).toBe("0");

      emitZeroUsageCompaction(query, threadId);
      await bridge.flushWork();

      expect(completedTurns(bridge)).toHaveLength(1);
      expect(
        assembled(bridge).usage.map((event) => event.tokenUsage.last),
      ).toEqual([ZERO_LAST]);
    } finally {
      await stopThread(bridge, threadId);
      bridge.restore();
    }
  });

  it("sends the zero usage when the thread stops during the wait and ignores a later event", async () => {
    const bridge = createBridgeJsonRpcTestHarness(handleLine);
    const threadId = "thread-compact-stopped";
    let stopped = false;

    try {
      const query = await startCompaction(bridge, threadId);
      const env = liveSessionEnv();

      emitZeroUsageCompaction(query, threadId);
      await bridge.flushWork();

      expect(completedTurns(bridge)).toHaveLength(1);
      expect(assembled(bridge).usage).toEqual([]);

      await stopThread(bridge, threadId);
      stopped = true;

      expect(
        assembled(bridge).usage.map((event) => event.tokenUsage.last),
      ).toEqual([ZERO_LAST]);

      await postCompactTelemetry(env, threadId);
      await bridge.flushWork();

      expect(
        assembled(bridge).usage.map((event) => event.tokenUsage.last),
      ).toEqual([ZERO_LAST]);
    } finally {
      if (!stopped) await stopThread(bridge, threadId);
      bridge.restore();
    }
  });
});
