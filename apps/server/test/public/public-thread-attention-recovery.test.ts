import { describe, expect, it } from "vitest";
import {
  listQueuedThreadMessages,
  readThreadAttention,
} from "@omnyo/db";
import {
  threadAttentionResultSchema,
  threadAttentionSnapshotSchema,
  threadQuestionInputSchema,
} from "@omnyo/domain";
import { withTestHarness, type TestAppHarness } from "../helpers/test-app.js";
import {
  seedThreadFixture,
  seedThreadRuntimeState,
  seedTurnStarted,
} from "../helpers/seed.js";
import { listQueuedThreadCommands } from "../helpers/commands.js";

async function command(
  harness: TestAppHarness,
  threadId: string,
  value: object,
) {
  const response = await harness.app.request(
    `/api/v1/threads/${threadId}/attention`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(value),
    },
  );

  return { status: response.status, body: await response.json() };
}

const question = threadQuestionInputSchema.parse({
  prompt: "Which direction?",
  mode: "optional",
  options: [
    { value: "a", label: "Compact" },
    { value: "b", label: "Detailed" },
  ],
});

describe("native thread attention", () => {
  it("retries the accepted answer's durable message after immediate dispatch fails", async () => {
    await withTestHarness(async (harness) => {
      const { thread, environment } = seedThreadFixture(harness, {
        thread: { status: "active" },
      });

      seedThreadRuntimeState(harness.deps, {
        threadId: thread.id,
        environmentId: environment.id,
        providerThreadId: "provider-test",
      });
      seedTurnStarted(harness.deps, {
        threadId: thread.id,
        environmentId: environment.id,
        providerThreadId: "provider-test",
        turnId: "turn-answer-retry",
      });

      const opened = await command(harness, thread.id, {
        action: "open",
        questions: [question],
      });

      const row = threadAttentionResultSchema.parse(opened.body).questions[0];

      if (!row) throw new Error("Question missing");

      const answer = {
        action: "answer",
        id: row.id,
        revision: row.revision,
        answer: { selected: ["a"] },
      };

      harness.db.$client.exec(
        "CREATE TEMP TRIGGER fixture_answer_dispatch_failure BEFORE DELETE ON queued_thread_messages BEGIN SELECT RAISE(ABORT, 'Fixture dispatch unavailable'); END",
      );
      expect((await command(harness, thread.id, answer)).status).toBe(500);
      const queued = listQueuedThreadMessages(harness.db, thread.id);

      expect(queued).toHaveLength(1);
      expect(
        readThreadAttention(harness.db, [thread.id]).get(thread.id)?.kind,
      ).toBe("none");

      const history = await harness.app.request(
        `/api/v1/threads/${thread.id}/attention`,
      );

      expect(
        threadAttentionSnapshotSchema.parse(await history.json()).questions,
      ).toMatchObject([{ state: "answered", queuedMessageId: queued[0]?.id }]);
      harness.db.$client.exec("DROP TRIGGER fixture_answer_dispatch_failure");
      expect((await command(harness, thread.id, answer)).status).toBe(200);
      expect(listQueuedThreadMessages(harness.db, thread.id)).toHaveLength(0);
      expect(
        listQueuedThreadCommands(harness, "turn.submit", thread.id),
      ).toMatchObject([
        { target: { mode: "auto", expectedTurnId: "turn-answer-retry" } },
      ]);
    });
  });

  it("leaves the question open when durable queue insertion fails", async () => {
    await withTestHarness(async (harness) => {
      const { thread, environment } = seedThreadFixture(harness, {
        thread: { status: "active" },
      });

      seedThreadRuntimeState(harness.deps, {
        threadId: thread.id,
        environmentId: environment.id,
        providerThreadId: "provider-test",
      });

      const row = threadAttentionResultSchema.parse(
        (
          await command(harness, thread.id, {
            action: "open",
            questions: [question],
          })
        ).body,
      ).questions[0];

      if (!row) throw new Error("Missing question");
      harness.db.$client.exec(
        "CREATE TEMP TRIGGER fixture_queue_failure BEFORE INSERT ON queued_thread_messages BEGIN SELECT RAISE(ABORT, 'Fixture queue unavailable'); END",
      );
      expect(
        (
          await command(harness, thread.id, {
            action: "answer",
            id: row.id,
            revision: row.revision,
            answer: { selected: ["a"] },
          })
        ).status,
      ).toBe(500);
      expect(
        readThreadAttention(harness.db, [thread.id]).get(thread.id)
          ?.optionalCount,
      ).toBe(1);
      expect(listQueuedThreadMessages(harness.db, thread.id)).toHaveLength(0);
    });
  });
});
