import { describe, expect, it } from "vitest";
import {
  getAppSettings,
  insertEvents,
  setAppSettings,
  setExperiments,
} from "@omnyo/db";
import {
  createStandaloneBuiltinCompactCommandInput,
  encodeClientTurnRequestIdNumber,
  THREAD_CONTEXT_CLEAR_OPERATION,
  threadScope,
  turnScope,
  type ContextSnapshot,
} from "@omnyo/domain";
import { seedThreadFixture } from "../helpers/seed.js";
import { withTestHarness } from "../helpers/test-app.js";

const snapshot: ContextSnapshot = {
  capturedAt: "2026-09-11T12:00:00.000Z",
  providerSessionId: "claude-session",
  providerTurnId: null,
  model: "claude-test",
  usedTokens: 100,
  contextWindowTokens: 1_000,
  autoCompactAtTokens: 900,
  estimated: true,
  categories: [
    { id: "custom", label: "Custom", kind: "used", tokens: 100, entries: [] },
  ],
};

const notScheduled = {
  state: "disabled",
  at: null,
  reason: "provider-unsupported",
  cacheReadShare: null,
};

function compactRequest(sequence: number) {
  return {
    direction: "outbound",
    requestId: encodeClientTurnRequestIdNumber({ value: sequence }),
    input: createStandaloneBuiltinCompactCommandInput(),
    target: { kind: "new-turn" },
    execution: {
      model: "claude-test",
      serviceTier: "default",
      reasoningLevel: "medium",
      permissionMode: "full",
      source: "client/turn/requested",
    },
    initiator: "user",
    senderThreadId: null,
    request: { method: "turn/start", params: {} },
    source: "tell",
  };
}

describe("recorded thread context API", () => {
  it("returns the persisted root snapshot, drops superseded details, and respects clear boundaries", async () => {
    await withTestHarness(async (harness) => {
      const { thread } = seedThreadFixture(harness);
      const endpoint = `/api/v1/threads/${thread.id}/context`;

      const read = async () => {
        const response = await harness.app.request(endpoint);
        expect(response.status, await response.clone().text()).toBe(200);

        return response.json();
      };

      const base = {
        threadId: thread.id,
        providerThreadId: "claude-session",
        scope: threadScope(),
        itemId: null,
        itemKind: null,
        parentToolCallId: null,
      };

      expect(await read()).toEqual({
        usage: null,
        autoCompaction: notScheduled,
      });
      insertEvents(harness.db, harness.hub, [
        {
          ...base,
          sequence: 1,
          type: "thread/contextWindowUsage/updated",
          data: JSON.stringify({
            contextWindowUsage: {
              usedTokens: 100,
              modelContextWindow: 1_000,
              estimated: true,
              snapshot,
            },
          }),
        },
        {
          ...base,
          sequence: 2,
          scope: turnScope("nested-turn"),
          parentToolCallId: "nested-tool",
          type: "turn/started",
          data: JSON.stringify({ parentToolCallId: "nested-tool" }),
        },
        {
          ...base,
          sequence: 3,
          scope: turnScope("nested-turn"),
          type: "thread/contextWindowUsage/updated",
          data: JSON.stringify({
            contextWindowUsage: {
              usedTokens: 999,
              modelContextWindow: 1_000,
              estimated: true,
            },
          }),
        },
      ]);
      expect(await read()).toEqual({
        usage: {
          usedTokens: 100,
          modelContextWindow: 1_000,
          estimated: true,
          snapshot,
        },
        autoCompaction: notScheduled,
      });

      const timeline = await harness.app.request(
        `/api/v1/threads/${thread.id}/timeline`,
      );

      expect(await timeline.json()).toMatchObject({
        contextWindowUsage: { snapshot },
      });
      insertEvents(harness.db, harness.hub, [
        {
          ...base,
          sequence: 4,
          type: "thread/contextWindowUsage/updated",
          data: JSON.stringify({
            contextWindowUsage: {
              usedTokens: 200,
              modelContextWindow: null,
              estimated: false,
            },
          }),
        },
      ]);
      expect(await read()).toEqual({
        usage: { usedTokens: 200, modelContextWindow: 1_000, estimated: false },
        autoCompaction: notScheduled,
      });
      insertEvents(harness.db, harness.hub, [
        {
          ...base,
          sequence: 5,
          type: "system/operation",
          data: JSON.stringify({
            operation: THREAD_CONTEXT_CLEAR_OPERATION,
            operationId: "clear",
            status: "completed",
            message: "Fresh context",
          }),
        },
      ]);
      expect(await read()).toEqual({
        usage: null,
        autoCompaction: notScheduled,
      });
    });
  });

  it("offers compaction once a large context's prompt cache expires", async () => {
    await withTestHarness(async (harness) => {
      const { thread } = seedThreadFixture(harness, {
        thread: { providerId: "pi" },
      });

      const read = async () => {
        const context = await harness.app.request(
          `/api/v1/threads/${thread.id}/context`,
        );

        const timeline = await harness.app.request(
          `/api/v1/threads/${thread.id}/timeline`,
        );

        const contextUsage = (await context.json()).usage;
        const timelineUsage = (await timeline.json()).contextWindowUsage;
        expect(timelineUsage?.compactionOfferAt).toEqual(
          contextUsage?.compactionOfferAt,
        );

        return contextUsage?.compactionOfferAt;
      };

      const base = {
        threadId: thread.id,
        providerThreadId: "pi-session",
        scope: turnScope("turn-1"),
        itemId: null,
        itemKind: null,
        parentToolCallId: null,
      };

      const usage = {
        totalTokens: 150_000,
        inputTokens: 10,
        cachedInputTokens: 149_990,
        outputTokens: 0,
        reasoningOutputTokens: 0,
      };

      const insertUsage = (
        sequence: number,
        usedTokens: number,
        cache: { promptCacheTtlMs?: number },
      ) =>
        insertEvents(harness.db, harness.hub, [
          {
            ...base,
            sequence,
            type: "thread/contextWindowUsage/updated",
            data: JSON.stringify({
              contextWindowUsage: {
                usedTokens,
                modelContextWindow: 200_000,
                estimated: false,
              },
            }),
          },
          {
            ...base,
            sequence: sequence + 1,
            type: "thread/tokenUsage/updated",
            data: JSON.stringify({
              tokenUsage: {
                total: usage,
                last: usage,
                modelContextWindow: 200_000,
                ...cache,
              },
            }),
          },
        ]);

      const before = Date.now();
      insertUsage(1, 150_000, { promptCacheTtlMs: 3_600_000 });
      const after = Date.now();
      setAppSettings(harness.db, {
        ...getAppSettings(harness.db),
        compactExpiredCache: false,
      });
      expect(await read()).toBeUndefined();

      setAppSettings(harness.db, {
        ...getAppSettings(harness.db),
        compactExpiredCache: true,
      });
      const offerAt = Date.parse(await read());
      expect(offerAt).toBeGreaterThanOrEqual(before + 3_600_000);
      expect(offerAt).toBeLessThanOrEqual(after + 3_600_000);

      insertUsage(3, 150_000, {});
      expect(await read()).toBeUndefined();

      insertUsage(5, 99_999, { promptCacheTtlMs: 300_000 });
      expect(await read()).toBeUndefined();

      insertUsage(7, 150_000, { promptCacheTtlMs: 3_600_000 });
      expect(await read()).toBeDefined();
      insertEvents(harness.db, harness.hub, [
        {
          ...base,
          scope: threadScope(),
          sequence: 9,
          type: "client/turn/requested",
          data: JSON.stringify(compactRequest(9)),
        },
      ]);
      expect(await read()).toBeUndefined();

      insertEvents(harness.db, harness.hub, [
        {
          ...base,
          scope: turnScope("turn-2"),
          sequence: 10,
          type: "turn/started",
          data: JSON.stringify({}),
        },
        {
          ...base,
          scope: turnScope("turn-2"),
          sequence: 11,
          type: "turn/completed",
          data: JSON.stringify({
            status: "failed",
            error: { message: "Provider overloaded" },
          }),
        },
      ]);
      expect(await read()).toBeDefined();

      insertEvents(harness.db, harness.hub, [
        {
          ...base,
          scope: threadScope(),
          sequence: 12,
          type: "client/turn/requested",
          data: JSON.stringify(compactRequest(12)),
        },
        {
          ...base,
          scope: turnScope("turn-3"),
          sequence: 13,
          type: "thread/compacted",
          data: JSON.stringify({}),
        },
        {
          ...base,
          scope: turnScope("turn-3"),
          sequence: 14,
          type: "turn/completed",
          data: JSON.stringify({ status: "completed" }),
        },
      ]);
      expect(await read()).toBeUndefined();
    });
  });

  it("reports the automatic compaction schedule and turns it off for one chat", async () => {
    await withTestHarness(async (harness) => {
      setExperiments(harness.db, { autoCompactBeforeCacheExpiry: true });

      const { thread } = seedThreadFixture(harness, {
        thread: { providerId: "claude-code" },
      });

      const anchorAt = Date.now() - 45 * 60_000;
      const dueAt = new Date(anchorAt + 50 * 60_000).toISOString();

      const base = {
        threadId: thread.id,
        providerThreadId: "claude-session",
        itemId: null,
        itemKind: null,
        parentToolCallId: null,
      };

      const usage = {
        totalTokens: 250_000,
        inputTokens: 10,
        cachedInputTokens: 249_990,
        outputTokens: 0,
        reasoningOutputTokens: 0,
      };

      insertEvents(harness.db, harness.hub, [
        {
          ...base,
          scope: threadScope(),
          sequence: 1,
          type: "client/turn/requested",
          data: JSON.stringify({
            ...compactRequest(1),
            input: [{ type: "text", text: "Fix the overlap" }],
          }),
        },
        {
          ...base,
          scope: turnScope("turn-1"),
          sequence: 2,
          createdAt: anchorAt,
          type: "thread/contextWindowUsage/updated",
          data: JSON.stringify({
            contextWindowUsage: {
              usedTokens: 250_000,
              modelContextWindow: 1_000_000,
              estimated: false,
            },
          }),
        },
        {
          ...base,
          scope: turnScope("turn-1"),
          sequence: 3,
          createdAt: anchorAt,
          type: "thread/tokenUsage/updated",
          data: JSON.stringify({
            tokenUsage: {
              total: usage,
              last: usage,
              modelContextWindow: 1_000_000,
              promptCacheTtlMs: 3_600_000,
            },
          }),
        },
      ]);

      const read = async () => {
        const context = await harness.app.request(
          `/api/v1/threads/${thread.id}/context`,
        );

        const timeline = await harness.app.request(
          `/api/v1/threads/${thread.id}/timeline`,
        );

        expect(context.status, await context.clone().text()).toBe(200);
        const body = await context.json();

        const timelineUsage = (await timeline.json()).contextWindowUsage;

        return {
          autoCompaction: body.autoCompaction,
          contextAt: body.usage?.autoCompactionAt,
          timelineAt: timelineUsage?.autoCompactionAt,
          timelineOptedOut: timelineUsage?.autoCompactionOptedOut,
        };
      };

      expect(await read()).toEqual({
        autoCompaction: {
          state: "scheduled",
          at: dueAt,
          reason: null,
          cacheReadShare: null,
        },
        contextAt: dueAt,
        timelineAt: dueAt,
        timelineOptedOut: undefined,
      });

      const setEnabled = async (enabled: boolean) => {
        const response = await harness.app.request(
          `/api/v1/threads/${thread.id}/auto-compaction`,
          {
            method: "PUT",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ enabled }),
          },
        );

        expect(response.status, await response.clone().text()).toBe(200);

        return response.json();
      };

      expect(await setEnabled(false)).toEqual({ enabled: false });
      expect(await read()).toEqual({
        autoCompaction: {
          state: "disabled",
          at: null,
          reason: "opted-out",
          cacheReadShare: null,
        },
        contextAt: dueAt,
        timelineAt: dueAt,
        timelineOptedOut: true,
      });

      expect(await setEnabled(true)).toEqual({ enabled: true });
      expect(await read()).toMatchObject({
        timelineAt: dueAt,
        timelineOptedOut: undefined,
      });

      expect(
        (
          await harness.app.request(
            `/api/v1/threads/${thread.id}/auto-compaction`,
            {
              method: "PUT",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ enabled: "no" }),
            },
          )
        ).status,
      ).toBe(400);
    });
  });

  it("returns 404 for unknown threads", async () => {
    await withTestHarness(async (harness) => {
      expect(
        (await harness.app.request("/api/v1/threads/missing/context")).status,
      ).toBe(404);
    });
  });
});
