import { describe, expect, it } from "vitest";
import {
  getAppSettings,
  getLatestThreadSequence,
  setAppSettings,
} from "@omnyo/db";
import {
  THREAD_CONTEXT_CLEAR_OPERATION,
  threadScope,
  turnScope,
} from "@omnyo/domain";
import { threadConversationOutlineResponseSchema } from "@omnyo/server-contract";
import { readJson } from "../helpers/json.js";
import { seedEvent, seedThreadFixture } from "../helpers/seed.js";
import { withTestHarness, type TestAppHarness } from "../helpers/test-app.js";

function appendAnswer(
  harness: TestAppHarness,
  threadId: string,
  sequence: number,
  text: string,
  turnId = "live",
): void {
  seedEvent(harness.deps, {
    threadId,
    sequence,
    providerThreadId: "outline-snapshot",
    scope: turnScope(turnId),
    type: "item/completed",
    data: { item: { id: `answer-${sequence}`, type: "agentMessage", text } },
  });
}

function appendAfterCapture(
  harness: TestAppHarness,
  limit: number,
  append: () => void,
): () => void {
  const client = harness.db.$client;
  const prepare = client.prepare;
  let queued = false;
  let count = 0;

  Object.defineProperty(client, "prepare", {
    configurable: true,
    writable: true,
    value: (source: string) => {
      const statement = prepare.call(client, source);

      if (source.includes("thread_history_epochs")) {
        const get = statement.get.bind(statement);

        statement.get = (...parameters: unknown[]) => {
          const row: unknown = Reflect.apply(get, statement, parameters);

          if (!queued && count < limit) {
            queued = true;
            queueMicrotask(() => {
              queued = false;
              count += 1;
              append();
            });
          }

          return row;
        };
      }

      return statement;
    },
  });

  return () => {
    client.prepare = prepare;
  };
}

describe("outline HTTP snapshot publication", () => {
  it("publishes the captured outline while ordinary appends advance the tip", async () => {
    await withTestHarness(async (harness) => {
      const { thread } = seedThreadFixture(harness, {
        thread: { providerId: "codex" },
      });

      seedEvent(harness.deps, {
        threadId: thread.id,
        sequence: 1,
        scope: turnScope("live"),
        providerThreadId: "outline-snapshot",
        type: "turn/started",
        data: {},
      });
      appendAnswer(harness, thread.id, 2, "Captured answer");
      let sequence = 2;

      const restore = appendAfterCapture(harness, 2, () => {
        sequence += 1;
        appendAnswer(harness, thread.id, sequence, `Later answer ${sequence}`);
      });

      try {
        const response = await harness.app.request(
          `/api/v1/threads/${thread.id}/conversation-outline`,
        );

        expect(response.status).toBe(200);

        const body = threadConversationOutlineResponseSchema.parse(
          await readJson(response),
        );

        expect(body.maxSeq).toBe(2);
        expect(body.items.map((item) => item.preview)).toEqual([
          "Captured answer",
        ]);
        expect(
          getLatestThreadSequence(harness.db, { threadId: thread.id }),
        ).toBeGreaterThan(body.maxSeq);
      } finally {
        restore();
      }
    });
  });

  it("rebuilds when a context clear changes the captured history boundary", async () => {
    await withTestHarness(async (harness) => {
      setAppSettings(harness.db, {
        ...getAppSettings(harness.db),
        keepHistoryAfterContextClear: false,
      });

      const { thread } = seedThreadFixture(harness, {
        thread: { providerId: "codex" },
      });

      seedEvent(harness.deps, {
        threadId: thread.id,
        sequence: 1,
        scope: turnScope("live"),
        providerThreadId: "outline-snapshot",
        type: "turn/started",
        data: {},
      });
      appendAnswer(harness, thread.id, 2, "Old private context");

      const restore = appendAfterCapture(harness, 1, () => {
        seedEvent(harness.deps, {
          threadId: thread.id,
          sequence: 3,
          scope: threadScope(),
          type: "system/operation",
          data: {
            operation: THREAD_CONTEXT_CLEAR_OPERATION,
            operationId: "snapshot-clear",
            status: "completed",
            message: "Context cleared",
          },
        });
        seedEvent(harness.deps, {
          threadId: thread.id,
          sequence: 4,
          scope: turnScope("fresh"),
          providerThreadId: "outline-snapshot",
          type: "turn/started",
          data: {},
        });
        appendAnswer(harness, thread.id, 5, "Fresh answer", "fresh");
      });

      try {
        const response = await harness.app.request(
          `/api/v1/threads/${thread.id}/conversation-outline`,
        );

        expect(response.status).toBe(200);

        const body = threadConversationOutlineResponseSchema.parse(
          await readJson(response),
        );

        expect(body.maxSeq).toBe(5);
        expect(body.items.map((item) => item.preview)).toEqual([
          "Fresh answer",
        ]);
      } finally {
        restore();
      }
    });
  });
});
