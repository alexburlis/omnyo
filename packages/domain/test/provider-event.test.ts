import { describe, expect, it } from "vitest";
import { threadEventSchema, turnScope } from "../src/index.js";

const CLIENT_REQUEST_ID = "creq_23456789ab";

describe("provider event schema", () => {
  it("models context clears as turn-scoped provider events", () => {
    expect(
      threadEventSchema.parse({
        type: "thread/context/cleared",
        threadId: "thr_123",
        providerThreadId: "provider-thread-123",
        scope: turnScope("turn_123"),
      }),
    ).toEqual({
      type: "thread/context/cleared",
      threadId: "thr_123",
      providerThreadId: "provider-thread-123",
      scope: turnScope("turn_123"),
    });
  });

  it("preserves opaque provider rate-limit window keys", () => {
    expect(
      threadEventSchema.parse({
        type: "provider/rateLimits/updated",
        threadId: "thr_123",
        providerThreadId: "provider-thread-123",
        scope: { kind: "thread" },
        rateLimits: {
          providerId: "claude-code",
          status: "blocked",
          kind: "subscription-window",
          windows: [
            {
              providerKey: "seven_day_fable",
              label: null,
              status: "blocked",
              resetsAtMs: 1_781_120_400_000,
            },
          ],
          reachedReason: "seven_day_fable",
          overageStatus: null,
          overageReason: null,
        },
      }),
    ).toMatchObject({
      rateLimits: {
        windows: [{ providerKey: "seven_day_fable" }],
      },
    });
  });

  it("uses clientRequestId for accepted input and user-message items", () => {
    expect(
      threadEventSchema.parse({
        type: "turn/input/accepted",
        threadId: "thr_123",
        providerThreadId: "provider-thread-123",
        clientRequestId: CLIENT_REQUEST_ID,
        scope: turnScope("turn_123"),
      }),
    ).toMatchObject({
      clientRequestId: CLIENT_REQUEST_ID,
    });

    expect(
      threadEventSchema.parse({
        type: "item/started",
        threadId: "thr_123",
        providerThreadId: "provider-thread-123",
        item: {
          type: "userMessage",
          id: "item_123",
          content: [{ type: "text", text: "hello" }],
          clientRequestId: CLIENT_REQUEST_ID,
        },
        scope: turnScope("turn_123"),
      }),
    ).toMatchObject({
      item: {
        clientRequestId: CLIENT_REQUEST_ID,
      },
    });
  });

  it("allows provider turn starts to carry parent tool call ids", () => {
    expect(
      threadEventSchema.parse({
        type: "turn/started",
        threadId: "thr_child",
        providerThreadId: "provider-thread-123",
        parentToolCallId: "tool-call-123",
        scope: turnScope("turn_child"),
      }),
    ).toMatchObject({
      parentToolCallId: "tool-call-123",
    });
  });

  it("accepts token usage across protocol 243 daemons and servers", () => {
    const breakdown = {
      totalTokens: 150_000,
      inputTokens: 10,
      cachedInputTokens: 149_990,
      outputTokens: 0,
      reasoningOutputTokens: 0,
    };

    const event = (tokenUsage: Record<string, unknown>) =>
      threadEventSchema.parse({
        type: "thread/tokenUsage/updated",
        threadId: "thr_123",
        providerThreadId: "provider-thread-123",
        scope: turnScope("turn_123"),
        tokenUsage,
      });

    const usage = {
      total: breakdown,
      last: breakdown,
      modelContextWindow: 200_000,
    };

    expect(event(usage)).toMatchObject({ tokenUsage: usage });
    expect(event(usage)).not.toHaveProperty("tokenUsage.promptCacheTtlMs");
    expect(event({ ...usage, promptCacheTtlMs: 3_600_000 })).toMatchObject({
      tokenUsage: { promptCacheTtlMs: 3_600_000 },
    });
    expect(event({ ...usage, futureField: true })).not.toHaveProperty(
      "tokenUsage.futureField",
    );
  });
});
