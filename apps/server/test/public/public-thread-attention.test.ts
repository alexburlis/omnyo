import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import {
  listEvents,
  listQueuedThreadMessages,
  listThreadQuestions,
  readThreadAttention,
  threadQuestions,
  threads,
} from "@omnyo/db";
import {
  INBOX_CALLER_PLUGIN_HEADER,
  INBOX_CALLER_THREAD_HEADER,
  threadAttentionResultSchema,
  threadAttentionSnapshotSchema,
  threadQuestionInputSchema,
} from "@omnyo/domain";
import {
  insertFailure,
  listOpenFailures,
  listOutstandingReceipts,
} from "../../src/services/inbox/store.js";
import { withTestHarness, type TestAppHarness } from "../helpers/test-app.js";
import {
  seedThread,
  seedThreadFixture,
  seedThreadRuntimeState,
  seedQueuedMessage,
  seedTurnStarted,
} from "../helpers/seed.js";
import { textInput } from "../helpers/prompt-input.js";
import { listQueuedThreadCommands } from "../helpers/commands.js";

async function command(
  harness: TestAppHarness,
  threadId: string,
  value: object,
  headers: Record<string, string> = {},
) {
  const response = await harness.app.request(
    `/api/v1/threads/${threadId}/attention`,
    {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
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
  it.each(["required", "optional"])(
    "steers a %s answer into the active turn without sending older queued work",
    async (mode) => {
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
          turnId: "turn-answer",
        });

        const older = seedQueuedMessage(harness.deps, {
          threadId: thread.id,
          content: textInput("Run this after the current task"),
          waitingOn: { kind: "thread-busy" },
        });

        const opened = await command(harness, thread.id, {
          action: "open",
          questions: [{ ...question, mode }],
        });

        const row = threadAttentionResultSchema.parse(opened.body).questions[0];

        if (!row) throw new Error("Question missing");

        const answer = {
          action: "answer",
          id: row.id,
          revision: row.revision,
          answer: {
            selected: ["a"],
            freeText: "Apply this to the current task",
          },
        };

        const accepted = await Promise.all([
          command(harness, thread.id, answer),
          command(harness, thread.id, answer),
        ]);

        expect(accepted.map((result) => result.status)).toEqual([200, 200]);
        expect(
          listQueuedThreadCommands(harness, "turn.submit", thread.id),
        ).toMatchObject([
          {
            target: { mode: "auto", expectedTurnId: "turn-answer" },
            input: [
              {
                type: "text",
                text: expect.stringContaining("Apply this to the current task"),
              },
            ],
          },
        ]);
        expect(listQueuedThreadMessages(harness.db, thread.id)).toMatchObject([
          { id: older.id, waitingOn: JSON.stringify({ kind: "thread-busy" }) },
        ]);
        expect((await command(harness, thread.id, answer)).status).toBe(200);
        expect(
          listQueuedThreadCommands(harness, "turn.submit", thread.id),
        ).toHaveLength(1);
      });
    },
  );

  it("starts the idle agent once when its question is answered", async () => {
    await withTestHarness(async (harness) => {
      const { thread, environment } = seedThreadFixture(harness, {
        thread: { status: "idle" },
      });

      seedThreadRuntimeState(harness.deps, {
        threadId: thread.id,
        environmentId: environment.id,
        providerThreadId: "provider-test",
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

      const accepted = await command(harness, thread.id, answer);

      expect(accepted.status, JSON.stringify(accepted.body)).toBe(200);
      expect(
        listQueuedThreadCommands(harness, "turn.submit", thread.id),
      ).toMatchObject([{ target: { mode: "start" } }]);
      expect(listQueuedThreadMessages(harness.db, thread.id)).toHaveLength(0);
      expect((await command(harness, thread.id, answer)).status).toBe(200);
      expect(
        listQueuedThreadCommands(harness, "turn.submit", thread.id),
      ).toHaveLength(1);
    });
  });

  it("answers several questions in one message and starts the idle agent once", async () => {
    await withTestHarness(async (harness) => {
      const { thread, environment } = seedThreadFixture(harness, {
        thread: { status: "idle" },
      });

      seedThreadRuntimeState(harness.deps, {
        threadId: thread.id,
        environmentId: environment.id,
        providerThreadId: "provider-test",
      });

      const opened = await command(harness, thread.id, {
        action: "open",
        questions: [
          { ...question, mode: "required", prompt: "Which layout?" },
          { ...question, mode: "required", prompt: "Which density?" },
          { ...question, prompt: "Which accent?" },
        ],
      });

      const [layout, density, accent] = threadAttentionResultSchema.parse(
        opened.body,
      ).questions;

      if (!layout || !density || !accent) throw new Error("Questions missing");

      const stale = await command(harness, thread.id, {
        action: "answers",
        answers: [
          { id: layout.id, revision: 1, answer: { selected: ["a"] } },
          { id: density.id, revision: 2, answer: { selected: ["b"] } },
        ],
      });

      expect(stale.status).toBe(409);
      expect(
        readThreadAttention(harness.db, [thread.id]).get(thread.id),
      ).toMatchObject({ requiredCount: 2, optionalCount: 1 });

      const answers = {
        action: "answers",
        answers: [
          { id: layout.id, revision: 1, answer: { selected: ["a"] } },
          {
            id: density.id,
            revision: 1,
            answer: { selected: ["b"], freeText: "Keep labels visible" },
          },
          { id: accent.id, revision: 1, answer: null },
        ],
      };

      const accepted = await command(harness, thread.id, answers);

      expect(accepted.status, JSON.stringify(accepted.body)).toBe(200);

      const resolved = threadAttentionResultSchema.parse(
        accepted.body,
      ).questions;

      expect(resolved.map((row) => row.state)).toEqual([
        "answered",
        "answered",
        "skipped",
      ]);
      expect(resolved[0]?.queuedMessageId).toBeTruthy();
      expect(resolved[1]?.queuedMessageId).toBe(resolved[0]?.queuedMessageId);
      expect(
        readThreadAttention(harness.db, [thread.id]).get(thread.id),
      ).toMatchObject({ kind: "none", requiredCount: 0, optionalCount: 0 });

      const submitted = listQueuedThreadCommands(
        harness,
        "turn.submit",
        thread.id,
      );

      expect(submitted).toMatchObject([{ target: { mode: "start" } }]);
      const text = JSON.stringify(submitted);
      expect(text).toContain("Question answered: Which layout?");
      expect(text).toContain("Question answered: Which density?");
      expect(text).toContain("Keep labels visible");
      expect(text).toContain("Question skipped: Which accent?");

      expect((await command(harness, thread.id, answers)).status).toBe(200);
      expect(
        listQueuedThreadCommands(harness, "turn.submit", thread.id),
      ).toHaveLength(1);
    });
  });

  it.each(["required", "optional"])(
    "withdraws an obsolete %s question while the agent continues and rejects late answers",
    async (mode) => {
      await withTestHarness(async (harness) => {
        const { thread } = seedThreadFixture(harness, {
          thread: { status: "active" },
        });

        const opened = await command(harness, thread.id, {
          action: "open",
          questions: [{ ...question, mode }],
        });

        const row = threadAttentionResultSchema.parse(opened.body).questions[0];

        if (!row) throw new Error("Question missing");

        const withdrawn = await command(harness, thread.id, {
          action: "withdraw",
          id: row.id,
          revision: row.revision,
        });

        expect(withdrawn.status).toBe(200);
        expect(
          threadAttentionResultSchema.parse(withdrawn.body).questions,
        ).toMatchObject([{ id: row.id, state: "withdrawn" }]);
        expect(
          readThreadAttention(harness.db, [thread.id]).get(thread.id),
        ).toMatchObject({ kind: "none", requiredCount: 0, optionalCount: 0 });
        expect(
          (
            await command(harness, thread.id, {
              action: "answer",
              id: row.id,
              revision: row.revision,
              answer: { selected: ["a"] },
            })
          ).status,
        ).toBe(409);
        expect(listQueuedThreadMessages(harness.db, thread.id)).toHaveLength(0);
        expect(
          listQueuedThreadCommands(harness, "turn.submit", thread.id),
        ).toHaveLength(0);
      });
    },
  );

  it("keeps required and optional questions distinct and rejects stale answers", async () => {
    await withTestHarness(async (harness) => {
      const { thread } = seedThreadFixture(harness);

      const opened = await command(harness, thread.id, {
        action: "open",
        questions: [question, { ...question, mode: "required" }],
      });

      expect(opened.status).toBe(200);
      const records = threadAttentionResultSchema.parse(opened.body).questions;
      expect(
        readThreadAttention(harness.db, [thread.id]).get(thread.id),
      ).toMatchObject({
        kind: "required-answer",
        requiredCount: 1,
        optionalCount: 1,
      });
      const required = records.find((row) => row.question.mode === "required");

      if (!required) throw new Error("Required question missing");
      expect(
        (
          await command(harness, thread.id, {
            action: "update",
            id: required.id,
            revision: 1,
            question: { ...required.question, prompt: "Updated direction?" },
          })
        ).status,
      ).toBe(200);
      expect(
        (
          await command(harness, thread.id, {
            action: "answer",
            id: required.id,
            revision: 1,
            answer: { selected: ["a"] },
          })
        ).status,
      ).toBe(409);
      expect(
        (
          await command(harness, thread.id, {
            action: "skip",
            id: required.id,
            revision: 2,
          })
        ).status,
      ).toBe(200);
      expect(
        readThreadAttention(harness.db, [thread.id]).get(thread.id)?.kind,
      ).toBe("optional-input");
      expect(listQueuedThreadMessages(harness.db, thread.id)).toHaveLength(0);
    });
  });

  it("accepts choice plus note once into the durable queue and retains answers across rereads", async () => {
    await withTestHarness(async (harness) => {
      const { thread, environment } = seedThreadFixture(harness, {
        thread: { status: "active" },
      });

      seedThreadRuntimeState(harness.deps, {
        threadId: thread.id,
        environmentId: environment.id,
        providerThreadId: "provider-test",
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
        answer: { selected: ["a"], freeText: "Keep the details available" },
      };

      const first = await command(harness, thread.id, answer);
      expect(first.status, JSON.stringify(first.body)).toBe(200);

      const accepted = threadAttentionResultSchema.parse(first.body)
        .questions[0];

      expect(accepted).toMatchObject({
        state: "answered",
        answer: answer.answer,
      });
      expect(accepted?.queuedMessageId).toBeTruthy();
      expect((await command(harness, thread.id, answer)).status).toBe(200);
      const queued = listQueuedThreadMessages(harness.db, thread.id);
      expect(queued).toHaveLength(1);
      expect(queued[0]?.content).toContain("Keep the details available");

      const history = await harness.app.request(
        `/api/v1/threads/${thread.id}/attention`,
      );

      expect(
        threadAttentionSnapshotSchema.parse(await history.json()).questions,
      ).toMatchObject([
        { state: "answered", queuedMessageId: accepted?.queuedMessageId },
      ]);
    });
  });
});

describe("child chat questions", () => {
  function storedQuestions(harness: TestAppHarness, threadId: string) {
    return harness.db
      .select()
      .from(threadQuestions)
      .where(eq(threadQuestions.threadId, threadId))
      .all();
  }

  it("asks the chat that launched it instead of the owner", async () => {
    await withTestHarness(async (harness) => {
      const {
        environment,
        project,
        thread: launcher,
      } = seedThreadFixture(harness, { thread: { status: "idle" } });

      seedThreadRuntimeState(harness.deps, {
        threadId: launcher.id,
        environmentId: environment.id,
        providerThreadId: "provider-launcher",
      });

      const launched = seedThread(harness.deps, {
        projectId: project.id,
        environmentId: environment.id,
        launchedByThreadId: launcher.id,
        title: "Study executor",
      });

      const opened = await command(harness, launched.id, {
        action: "open",
        questions: [{ ...question, mode: "required" }],
      });

      expect(opened.status, JSON.stringify(opened.body)).toBe(200);
      expect(threadAttentionResultSchema.parse(opened.body)).toMatchObject({
        questions: [],
        routedToThreadId: launcher.id,
      });
      expect(storedQuestions(harness, launched.id)).toEqual([]);
      expect(
        readThreadAttention(harness.db, [launched.id]).get(launched.id),
      ).toMatchObject({ kind: "none", requiredCount: 0, optionalCount: 0 });

      const [submit] = listQueuedThreadCommands(
        harness,
        "turn.submit",
        launcher.id,
      );

      if (submit?.type !== "turn.submit")
        throw new Error("Launcher turn missing");

      expect(
        submit.input
          .flatMap((part) => (part.type === "text" ? [part.text] : []))
          .join("\n"),
      ).toContain(`@thread:${launched.id} asks you, not the owner:`);
    });
  });

  it("asks the parent chat instead of the owner", async () => {
    await withTestHarness(async (harness) => {
      const {
        environment,
        project,
        thread: parent,
      } = seedThreadFixture(harness, { thread: { status: "idle" } });

      seedThreadRuntimeState(harness.deps, {
        threadId: parent.id,
        environmentId: environment.id,
        providerThreadId: "provider-parent",
      });

      const child = seedThread(harness.deps, {
        projectId: project.id,
        environmentId: environment.id,
        parentThreadId: parent.id,
        title: "Layout worker",
      });

      const opened = await command(harness, child.id, {
        action: "open",
        questions: [
          {
            ...question,
            mode: "required",
            context: "The card is narrow on phones.",
            options: [
              { value: "a", label: "Compact", recommended: true },
              { value: "b", label: "Detailed", description: "More rows" },
            ],
          },
        ],
      });

      expect(opened.status, JSON.stringify(opened.body)).toBe(200);
      expect(threadAttentionResultSchema.parse(opened.body)).toMatchObject({
        questions: [],
        routedToThreadId: parent.id,
      });
      expect(storedQuestions(harness, child.id)).toEqual([]);
      expect(
        readThreadAttention(harness.db, [child.id]).get(child.id),
      ).toMatchObject({ kind: "none", requiredCount: 0, optionalCount: 0 });
      expect(
        listQueuedThreadCommands(harness, "turn.submit", child.id),
      ).toHaveLength(0);

      const [submit, ...extra] = listQueuedThreadCommands(
        harness,
        "turn.submit",
        parent.id,
      );

      expect(extra).toHaveLength(0);

      if (submit?.type !== "turn.submit")
        throw new Error("Parent turn missing");

      const text = submit.input
        .flatMap((part) => (part.type === "text" ? [part.text] : []))
        .join("\n");

      expect(text).toContain(`@thread:${child.id} asks you, not the owner:`);
      expect(text).toContain(
        "Required: Which direction?\nThe card is narrow on phones.\n- Compact (recommended)\n- Detailed: More rows",
      );
      expect(text).toContain(`omnyo thread tell ${child.id} --mode auto`);

      const [first] = submit.input;

      if (first?.type !== "text") throw new Error("Parent message missing");
      const [mention] = first.mentions;

      expect(first.text.slice(mention?.start, mention?.end)).toBe(
        `@thread:${child.id}`,
      );
      expect(mention?.resource).toMatchObject({
        kind: "thread",
        threadId: child.id,
        label: "Layout worker",
      });
    });
  });

  it("routes a grandchild and a hidden child to their direct parents", async () => {
    await withTestHarness(async (harness) => {
      const { environment, project, thread: root } = seedThreadFixture(harness);

      const child = seedThread(harness.deps, {
        projectId: project.id,
        environmentId: environment.id,
        parentThreadId: root.id,
      });

      const grandchild = seedThread(harness.deps, {
        projectId: project.id,
        environmentId: environment.id,
        parentThreadId: child.id,
      });

      const hiddenChild = seedThread(harness.deps, {
        projectId: project.id,
        environmentId: environment.id,
        parentThreadId: root.id,
        visibility: "hidden",
      });

      for (const parent of [root, child])
        seedThreadRuntimeState(harness.deps, {
          threadId: parent.id,
          environmentId: environment.id,
          providerThreadId: `provider-${parent.id}`,
        });

      for (const [asking, parent] of [
        [grandchild, child],
        [hiddenChild, root],
      ] as const) {
        const opened = await command(harness, asking.id, {
          action: "open",
          questions: [question],
        });

        expect(opened.status, JSON.stringify(opened.body)).toBe(200);
        expect(
          threadAttentionResultSchema.parse(opened.body).routedToThreadId,
        ).toBe(parent.id);
        expect(storedQuestions(harness, asking.id)).toEqual([]);
      }

      expect(storedQuestions(harness, child.id)).toEqual([]);
      expect(storedQuestions(harness, root.id)).toEqual([]);
    });
  });

  it("sends several questions to the parent in one numbered message", async () => {
    await withTestHarness(async (harness) => {
      const {
        environment,
        project,
        thread: parent,
      } = seedThreadFixture(harness, { thread: { status: "idle" } });

      seedThreadRuntimeState(harness.deps, {
        threadId: parent.id,
        environmentId: environment.id,
        providerThreadId: "provider-parent-several",
      });

      const child = seedThread(harness.deps, {
        projectId: project.id,
        environmentId: environment.id,
        parentThreadId: parent.id,
      });

      const opened = await command(harness, child.id, {
        action: "open",
        questions: [
          { prompt: "Ship today?", mode: "required" },
          {
            prompt: "Which checks?",
            mode: "optional",
            multiSelect: true,
            allowFreeText: false,
            options: [
              {
                value: "a",
                label: "Unit",
                preview: "pnpm test:dev\n--package app",
              },
              { value: "b", label: "Device" },
            ],
          },
        ],
      });

      expect(opened.status, JSON.stringify(opened.body)).toBe(200);

      const submits = listQueuedThreadCommands(
        harness,
        "turn.submit",
        parent.id,
      );

      expect(submits).toHaveLength(1);
      const [submit] = submits;

      if (submit?.type !== "turn.submit")
        throw new Error("Parent turn missing");

      const text = submit.input
        .flatMap((part) => (part.type === "text" ? [part.text] : []))
        .join("\n");

      expect(text).toContain(
        [
          "1. Required: Ship today?",
          "",
          "2. Optional, the child continues with its stated default: Which checks?",
          "- Unit",
          "    pnpm test:dev",
          "    --package app",
          "- Device",
          "Several options may be chosen.",
          "Only the listed options are accepted.",
        ].join("\n"),
      );
    });
  });

  it("keeps archived chats and hidden roots out of questions and routing", async () => {
    await withTestHarness(async (harness) => {
      const {
        environment,
        project,
        thread: parent,
      } = seedThreadFixture(harness);

      const archivedChild = seedThread(harness.deps, {
        projectId: project.id,
        environmentId: environment.id,
        parentThreadId: parent.id,
      });

      harness.db
        .update(threads)
        .set({ archivedAt: Date.now() })
        .where(eq(threads.id, archivedChild.id))
        .run();

      const hiddenRoot = seedThread(harness.deps, {
        projectId: project.id,
        environmentId: environment.id,
        visibility: "hidden",
      });

      const hiddenChild = seedThread(harness.deps, {
        projectId: project.id,
        environmentId: environment.id,
        parentThreadId: parent.id,
        visibility: "hidden",
      });

      for (const [threadId, value] of [
        [archivedChild.id, { action: "open", questions: [question] }],
        [hiddenRoot.id, { action: "open", questions: [question] }],
        [
          hiddenChild.id,
          {
            action: "wait",
            sourceThreadId: parent.id,
            reason: "Wait for the parent",
          },
        ],
      ] as const) {
        expect((await command(harness, threadId, value)).status).toBe(409);
      }

      expect(
        listQueuedThreadCommands(harness, "turn.submit", parent.id),
      ).toHaveLength(0);
    });
  });

  it.each(["archived parent", "fork"] as const)(
    "asks the owner from a chat whose parent link is a %s",
    async (link) => {
      await withTestHarness(async (harness) => {
        const {
          environment,
          project,
          thread: parent,
        } = seedThreadFixture(harness);

        if (link === "archived parent")
          harness.db
            .update(threads)
            .set({ archivedAt: Date.now() })
            .where(eq(threads.id, parent.id))
            .run();

        const asking = seedThread(harness.deps, {
          projectId: project.id,
          environmentId: environment.id,
          parentThreadId: parent.id,
          originKind: link === "fork" ? "fork" : null,
        });

        const opened = await command(harness, asking.id, {
          action: "open",
          questions: [question],
        });

        expect(opened.status, JSON.stringify(opened.body)).toBe(200);
        expect(threadAttentionResultSchema.parse(opened.body)).toMatchObject({
          questions: [{ threadId: asking.id, state: "open" }],
          routedToThreadId: null,
        });
        expect(
          listQueuedThreadCommands(harness, "turn.submit", parent.id),
        ).toHaveLength(0);
      });
    },
  );
});

const CHIEF = { [INBOX_CALLER_PLUGIN_HEADER]: "chief" };

const delegation = {
  ruleId: "rule_layout",
  reason: "The owner always picks the compact layout",
};

async function openDelegationFixture(
  harness: TestAppHarness,
  delegable: readonly boolean[],
) {
  const { thread, environment } = seedThreadFixture(harness, {
    thread: { status: "idle" },
  });

  seedThreadRuntimeState(harness.deps, {
    threadId: thread.id,
    environmentId: environment.id,
    providerThreadId: "provider-test",
  });

  const opened = await command(harness, thread.id, {
    action: "open",
    questions: delegable.map((value, index) => ({
      ...question,
      mode: "required",
      prompt: `Which layout ${index}?`,
      delegable: value,
    })),
  });

  expect(opened.status, JSON.stringify(opened.body)).toBe(200);

  return {
    thread,
    questions: threadAttentionResultSchema.parse(opened.body).questions,
  };
}

function openQuestionIds(harness: TestAppHarness, threadId: string) {
  return listThreadQuestions(harness.db, threadId)
    .map((row) => row.id)
    .sort();
}

function storedAnsweredBy(harness: TestAppHarness, id: string) {
  return harness.db
    .select({ answeredBy: threadQuestions.answeredBy })
    .from(threadQuestions)
    .where(eq(threadQuestions.id, id))
    .get()?.answeredBy;
}

function lastTurnRequest(harness: TestAppHarness, threadId: string) {
  const request = listEvents(harness.db, { threadId })
    .filter((event) => event.type === "client/turn/requested")
    .at(-1);

  return JSON.parse(request?.data ?? "{}");
}

describe("delegated answers", () => {
  it("leaves an open failure for the owner when a plugin answers, while an owner answer resolves it", async () => {
    await withTestHarness(async (harness) => {
      const {
        thread,
        questions: [pluginRow, ownerRow],
      } = await openDelegationFixture(harness, [true, true]);

      if (!pluginRow || !ownerRow) throw new Error("Questions missing");

      insertFailure(harness.db, {
        threadId: thread.id,
        turnId: null,
        requestId: null,
        waitId: null,
        state: "actionable",
        reason: "Provider failed",
        decisionDeadline: null,
        now: Date.now(),
      });

      const delegated = await command(
        harness,
        thread.id,
        {
          action: "answer",
          id: pluginRow.id,
          revision: pluginRow.revision,
          answer: { selected: ["a"] },
          delegation,
        },
        CHIEF,
      );

      expect(delegated.status, JSON.stringify(delegated.body)).toBe(200);
      expect(listOpenFailures(harness.db, [thread.id])).toHaveLength(1);

      const owned = await command(harness, thread.id, {
        action: "answer",
        id: ownerRow.id,
        revision: ownerRow.revision,
        answer: { selected: ["a"] },
      });

      expect(owned.status, JSON.stringify(owned.body)).toBe(200);
      expect(listOpenFailures(harness.db, [thread.id])).toHaveLength(0);
    });
  });

  it("records an owner answer and marks the chat's Inbox items handled", async () => {
    await withTestHarness(async (harness) => {
      const {
        thread,
        questions: [row],
      } = await openDelegationFixture(harness, [true]);

      if (!row) throw new Error("Question missing");
      expect(row.question.delegable).toBe(true);
      expect(row.answeredBy).toBeNull();
      expect(listOutstandingReceipts(harness.db, [thread.id])).toHaveLength(1);

      const answered = await command(harness, thread.id, {
        action: "answer",
        id: row.id,
        revision: row.revision,
        answer: { selected: ["a"] },
      });

      expect(answered.status, JSON.stringify(answered.body)).toBe(200);
      expect(
        threadAttentionResultSchema.parse(answered.body).questions[0]
          ?.answeredBy,
      ).toEqual({ kind: "owner" });
      expect(JSON.parse(storedAnsweredBy(harness, row.id) ?? "null")).toEqual({
        kind: "owner",
      });
      expect(listOutstandingReceipts(harness.db, [thread.id])).toHaveLength(0);
      expect(lastTurnRequest(harness, thread.id)).not.toHaveProperty(
        "systemMessageSubject",
      );
    });
  });

  it("records a plugin answer with its rule, attributes the message and leaves Inbox items unhandled", async () => {
    await withTestHarness(async (harness) => {
      const {
        thread,
        questions: [row],
      } = await openDelegationFixture(harness, [true]);

      if (!row) throw new Error("Question missing");

      const answered = await command(
        harness,
        thread.id,
        {
          action: "answer",
          id: row.id,
          revision: row.revision,
          answer: { selected: ["a"] },
          delegation,
        },
        CHIEF,
      );

      const plugin = { kind: "plugin", pluginId: "chief", ...delegation };

      expect(answered.status, JSON.stringify(answered.body)).toBe(200);
      expect(
        threadAttentionResultSchema.parse(answered.body).questions[0],
      ).toMatchObject({ state: "answered", answeredBy: plugin });
      expect(JSON.parse(storedAnsweredBy(harness, row.id) ?? "null")).toEqual(
        plugin,
      );
      expect(listOutstandingReceipts(harness.db, [thread.id])).toHaveLength(1);

      const request = lastTurnRequest(harness, thread.id);

      expect(request).toMatchObject({
        systemMessageKind: "external-message",
        systemMessageSubject: {
          kind: "message-source",
          source: { kind: "plugin", pluginId: "chief" },
        },
      });
      expect(JSON.stringify(request.input)).toContain(
        "by the chief plugin under its rule rule_layout",
      );
      expect(JSON.stringify(request.input)).toContain(
        "does not authorize any effect that needs the owner's approval",
      );
    });
  });

  it("refuses a plugin answer to a question not marked delegable", async () => {
    await withTestHarness(async (harness) => {
      const {
        thread,
        questions: [row],
      } = await openDelegationFixture(harness, [false]);

      if (!row) throw new Error("Question missing");

      const refused = await command(
        harness,
        thread.id,
        {
          action: "answer",
          id: row.id,
          revision: row.revision,
          answer: { selected: ["a"] },
          delegation,
        },
        CHIEF,
      );

      expect(refused).toMatchObject({
        status: 403,
        body: { code: "owner_only" },
      });
      expect(openQuestionIds(harness, thread.id)).toEqual([row.id]);
      expect(listQueuedThreadMessages(harness.db, thread.id)).toHaveLength(0);
    });
  });

  it("refuses a grouped answer whole when one question is not delegable", async () => {
    await withTestHarness(async (harness) => {
      const { thread, questions } = await openDelegationFixture(harness, [
        true,
        false,
      ]);

      const refused = await command(
        harness,
        thread.id,
        {
          action: "answers",
          answers: questions.map((row) => ({
            id: row.id,
            revision: row.revision,
            answer: { selected: ["a"] },
          })),
          delegation,
        },
        CHIEF,
      );

      expect(refused).toMatchObject({
        status: 403,
        body: { code: "owner_only" },
      });
      expect(openQuestionIds(harness, thread.id)).toEqual(
        questions.map((row) => row.id).sort(),
      );
      expect(questions.map((row) => storedAnsweredBy(harness, row.id))).toEqual(
        [null, null],
      );
      expect(listQueuedThreadMessages(harness.db, thread.id)).toHaveLength(0);
    });
  });

  it("requires delegation from plugins and refuses it from the owner", async () => {
    await withTestHarness(async (harness) => {
      const {
        thread,
        questions: [row],
      } = await openDelegationFixture(harness, [true]);

      if (!row) throw new Error("Question missing");

      const answer = {
        action: "answer",
        id: row.id,
        revision: row.revision,
        answer: { selected: ["a"] },
      };

      expect(await command(harness, thread.id, answer, CHIEF)).toMatchObject({
        status: 400,
        body: { code: "invalid_request" },
      });
      expect(
        await command(harness, thread.id, { ...answer, delegation }),
      ).toMatchObject({ status: 400, body: { code: "invalid_request" } });
      expect(openQuestionIds(harness, thread.id)).toEqual([row.id]);
    });
  });

  it("lets only the owner or the asking chat mark a question delegable", async () => {
    await withTestHarness(async (harness) => {
      const {
        thread,
        questions: [row],
      } = await openDelegationFixture(harness, [false]);

      if (!row) throw new Error("Question missing");
      const other = seedThread(harness.deps, { projectId: thread.projectId });

      const update = {
        action: "update",
        id: row.id,
        revision: row.revision,
        question: { ...row.question, delegable: true },
      };

      expect(
        await command(harness, thread.id, update, {
          [INBOX_CALLER_THREAD_HEADER]: other.id,
        }),
      ).toMatchObject({ status: 403, body: { code: "owner_only" } });
      expect(await command(harness, thread.id, update, CHIEF)).toMatchObject({
        status: 403,
        body: { code: "owner_only" },
      });

      const raised = await command(harness, thread.id, update, {
        [INBOX_CALLER_THREAD_HEADER]: thread.id,
      });

      expect(raised.status, JSON.stringify(raised.body)).toBe(200);
      expect(
        threadAttentionResultSchema.parse(raised.body).questions[0],
      ).toMatchObject({ revision: 2, question: { delegable: true } });
    });
  });

  it.each(["skip", "withdraw"])(
    "refuses a plugin %s of a question not marked delegable",
    async (action) => {
      await withTestHarness(async (harness) => {
        const { thread, questions } = await openDelegationFixture(harness, [
          false,
          true,
        ]);

        const [unmarked, marked] = questions;

        if (!unmarked || !marked) throw new Error("Questions missing");

        expect(
          await command(
            harness,
            thread.id,
            { action, id: unmarked.id, revision: unmarked.revision },
            CHIEF,
          ),
        ).toMatchObject({ status: 403, body: { code: "owner_only" } });
        expect(
          (
            await command(
              harness,
              thread.id,
              { action, id: marked.id, revision: marked.revision },
              CHIEF,
            )
          ).status,
        ).toBe(200);
        expect(openQuestionIds(harness, thread.id)).toEqual([unmarked.id]);
      });
    },
  );
});
