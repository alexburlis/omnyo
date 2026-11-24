import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import {
  createConnection,
  listQueuedThreadMessages,
  queuedThreadMessages,
  submissionReceipts,
  threads,
} from "@omnyo/db";
import {
  submissionContractSchema,
  submissionReceiptSchema,
  threadQueuedMessageListResponseSchema,
  threadTimelineResponseSchema,
  type SubmissionReceipt,
} from "@omnyo/server-contract";
import { describe, expect, it } from "vitest";
import { applyLoggedThreadLifecycleEvent } from "../../src/services/threads/lifecycle-outcome.js";
import { runQueuedMessageDispatch } from "../../src/services/threads/queued-message-dispatch.js";
import {
  reportQueuedCommandSuccess,
  waitForQueuedCommand,
} from "../helpers/commands.js";
import { readJson } from "../helpers/json.js";
import {
  seedEnvironment,
  seedHostSession,
  seedProjectWithSource,
  seedThread,
  seedThreadRuntimeState,
  seedTurnStarted,
} from "../helpers/seed.js";
import {
  createTestAppHarness,
  createTestDb,
  withTestHarness,
  type TestAppHarness,
} from "../helpers/test-app.js";

const SUBMISSION_A = "sub_0123456789abcdef0123456789abcdef";

const SUBMISSION_B = "sub_fedcba9876543210fedcba9876543210";

interface BusyThread {
  hostId: string;
  projectId: string;
  threadId: string;
}

interface SubmitOutcome {
  code: string | null;
  receipt: SubmissionReceipt | null;
  retryable: boolean | null;
  status: number;
}

function text(value: string) {
  return [{ type: "text" as const, text: value, mentions: [] }];
}

function seedBusyThread(harness: TestAppHarness, id: string): BusyThread {
  const { host } = seedHostSession(harness.deps, { id: `host-${id}` });
  const { project } = seedProjectWithSource(harness.deps, { hostId: host.id });

  const environment = seedEnvironment(harness.deps, {
    hostId: host.id,
    projectId: project.id,
    path: `/tmp/${id}`,
  });

  const thread = seedThread(harness.deps, {
    projectId: project.id,
    environmentId: environment.id,
    status: "active",
  });

  seedThreadRuntimeState(harness.deps, {
    threadId: thread.id,
    environmentId: environment.id,
    providerThreadId: `provider-${id}`,
  });
  seedTurnStarted(harness.deps, {
    environmentId: environment.id,
    providerThreadId: `provider-${id}`,
    threadId: thread.id,
    turnId: "turn-current",
  });

  return { hostId: host.id, projectId: project.id, threadId: thread.id };
}

async function readStoreId(harness: TestAppHarness): Promise<string> {
  const response = await harness.app.request("/api/v1/submissions/contract");

  expect(response.status).toBe(200);

  return submissionContractSchema.parse(await readJson(response)).storeId;
}

async function submit(
  harness: TestAppHarness,
  body: Record<string, unknown>,
): Promise<SubmitOutcome> {
  const response = await harness.app.request("/api/v1/submissions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

  const payload = (await readJson(response)) as {
    code?: string;
    retryable?: boolean;
  };

  return {
    code: payload.code ?? null,
    receipt:
      response.status === 200 ? submissionReceiptSchema.parse(payload) : null,
    retryable: payload.retryable ?? null,
    status: response.status,
  };
}

function messageSubmission(args: {
  attachments?: unknown[];
  input?: unknown[];
  storeId: string;
  submissionId: string;
  threadId: string;
  value?: string;
}): Record<string, unknown> {
  return {
    version: 1,
    submissionId: args.submissionId,
    storeId: args.storeId,
    action: {
      kind: "thread-message",
      threadId: args.threadId,
      message: { input: args.input ?? text(args.value ?? "Follow up") },
    },
    attachments: args.attachments ?? [],
  };
}

function queuedCount(harness: TestAppHarness, threadId: string): number {
  return listQueuedThreadMessages(harness.db, threadId).length;
}

function receiptCount(harness: TestAppHarness): number {
  return harness.db.select().from(submissionReceipts).all().length;
}

async function uploadText(
  harness: TestAppHarness,
  projectId: string,
  content: string,
): Promise<string> {
  const form = new FormData();
  form.append("file", new File([content], "notes.txt", { type: "text/plain" }));

  const response = await harness.app.request(
    `/api/v1/projects/${projectId}/attachments`,
    { method: "POST", body: form },
  );

  expect(response.status).toBe(201);

  return ((await readJson(response)) as { path: string }).path;
}

function declared(path: string, content: string) {
  return {
    path,
    sha256: createHash("sha256").update(content).digest("hex"),
    sizeBytes: Buffer.byteLength(content),
  };
}

function fileInput(path: string, content: string) {
  return [
    ...text("See the attached notes"),
    {
      type: "localFile" as const,
      path,
      name: "notes.txt",
      sizeBytes: Buffer.byteLength(content),
      mimeType: "text/plain",
    },
  ];
}

describe("submission receipts", () => {
  it("accepts a thread message once and replays its receipt, also after its queue entry is consumed", () =>
    withTestHarness(async (harness) => {
      const { threadId } = seedBusyThread(harness, "submission-replay");
      const storeId = await readStoreId(harness);

      const body = messageSubmission({
        storeId,
        submissionId: SUBMISSION_A,
        threadId,
      });

      const first = await submit(harness, body);
      const second = await submit(harness, body);
      const queuedAfterReplay = queuedCount(harness, threadId);

      harness.db
        .delete(queuedThreadMessages)
        .where(eq(queuedThreadMessages.threadId, threadId))
        .run();

      const afterConsumption = await submit(harness, body);

      expect({
        afterConsumption: {
          queuedMessageId: afterConsumption.receipt?.queuedMessageId,
          replayed: afterConsumption.receipt?.replayed,
          status: afterConsumption.status,
        },
        first: { replayed: first.receipt?.replayed, status: first.status },
        queuedAfterConsumption: queuedCount(harness, threadId),
        queuedAfterReplay,
        receipts: receiptCount(harness),
        second: {
          acceptedAt: second.receipt?.acceptedAt,
          queuedMessageId: second.receipt?.queuedMessageId,
          replayed: second.receipt?.replayed,
          status: second.status,
        },
      }).toEqual({
        afterConsumption: {
          queuedMessageId: first.receipt?.queuedMessageId,
          replayed: true,
          status: 200,
        },
        first: { replayed: false, status: 200 },
        queuedAfterConsumption: 0,
        queuedAfterReplay: 1,
        receipts: 1,
        second: {
          acceptedAt: first.receipt?.acceptedAt,
          queuedMessageId: first.receipt?.queuedMessageId,
          replayed: true,
          status: 200,
        },
      });
    }));

  it.each(["commit", "rollback"] as const)(
    "publishes the durable follow-up queue state after dispatch on %s",
    (outcome) =>
      withTestHarness(async (harness) => {
        const { threadId } = seedBusyThread(
          harness,
          "submission-queue-realtime",
        );

        const storeId = await readStoreId(harness);
        const value = "Realtime queue follow-up";

        const { receipt } = await submit(
          harness,
          messageSubmission({
            storeId,
            submissionId: SUBMISSION_A,
            threadId,
            value,
          }),
        );

        if (receipt === null) throw new Error("Expected a submission receipt");
        const { queuedMessageId } = receipt;
        const queuePath = `/api/v1/threads/${threadId}/queued-messages`;

        const queueReads: {
          inTransaction: boolean;
          response: Promise<Response>;
        }[] = [];

        const stopObserving = harness.hub.onThreadChanged((id, changes) => {
          if (id === threadId && changes.includes("queue-changed")) {
            queueReads.push({
              inTransaction: harness.db.$client.inTransaction,
              response: Promise.resolve(harness.app.request(queuePath)),
            });
          }
        });

        try {
          if (outcome === "rollback") {
            harness.db.$client.exec(`
              CREATE TEMP TRIGGER abort_dispatch_request
              BEFORE INSERT ON events WHEN NEW.type = 'client/turn/requested'
              BEGIN SELECT RAISE(ABORT, 'rollback before the turn request'); END;
            `);
          }

          applyLoggedThreadLifecycleEvent(harness.deps, {
            event: { type: "run.succeeded" },
            threadId,
          });
          await runQueuedMessageDispatch(harness.deps, {
            kind: "thread-ready",
            threadId,
          });

          if (outcome === "commit") {
            const command = await waitForQueuedCommand(
              harness,
              ({ command }) =>
                command.type === "turn.submit" && command.threadId === threadId,
            );

            await reportQueuedCommandSuccess(harness, command, {
              trace: { spans: [] },
            });
          }

          const observed = await Promise.all(
            queueReads.map(async ({ inTransaction, response }) => {
              expect(inTransaction).toBe(false);

              return threadQueuedMessageListResponseSchema.parse(
                await readJson(await response),
              );
            }),
          );

          expect(observed[0]).toMatchObject([
            { id: queuedMessageId, editable: false },
          ]);

          const timeline = threadTimelineResponseSchema.parse(
            await readJson(
              await harness.app.request(`/api/v1/threads/${threadId}/timeline`),
            ),
          );

          const userBubbles = timeline.rows.filter(
            (row) =>
              row.kind === "conversation" &&
              row.role === "user" &&
              row.text === value,
          );

          if (outcome === "commit") {
            expect(observed).toHaveLength(2);
            expect(observed[1]).toEqual([]);
            expect(userBubbles).toHaveLength(1);
          } else {
            expect(
              observed.flatMap((rows) => rows.map((row) => row.id)),
            ).toEqual(observed.map(() => queuedMessageId));
            expect(userBubbles).toHaveLength(0);
          }
        } finally {
          stopObserving();
        }
      }),
  );

  it("keeps two identical messages apart when their submission IDs differ", () =>
    withTestHarness(async (harness) => {
      const { threadId } = seedBusyThread(harness, "submission-distinct");
      const storeId = await readStoreId(harness);

      const first = await submit(
        harness,
        messageSubmission({ storeId, submissionId: SUBMISSION_A, threadId }),
      );

      const second = await submit(
        harness,
        messageSubmission({ storeId, submissionId: SUBMISSION_B, threadId }),
      );

      expect({
        distinctRows:
          first.receipt?.queuedMessageId !== second.receipt?.queuedMessageId,
        queued: queuedCount(harness, threadId),
        statuses: [first.status, second.status],
      }).toEqual({ distinctRows: true, queued: 2, statuses: [200, 200] });
    }));

  it("refuses a changed envelope, another store and an unknown field without storing anything new", () =>
    withTestHarness(async (harness) => {
      const { threadId } = seedBusyThread(harness, "submission-refusals");
      const storeId = await readStoreId(harness);

      const accepted = await submit(
        harness,
        messageSubmission({ storeId, submissionId: SUBMISSION_A, threadId }),
      );

      const changed = await submit(
        harness,
        messageSubmission({
          storeId,
          submissionId: SUBMISSION_A,
          threadId,
          value: "Different text",
        }),
      );

      const otherStore = await submit(
        harness,
        messageSubmission({
          storeId: "store_other",
          submissionId: SUBMISSION_B,
          threadId,
        }),
      );

      const unknownField = await submit(harness, {
        ...messageSubmission({ storeId, submissionId: SUBMISSION_B, threadId }),
        legacy: true,
      });

      expect({
        accepted: accepted.status,
        changed: { code: changed.code, status: changed.status },
        otherStore: { code: otherStore.code, status: otherStore.status },
        queued: queuedCount(harness, threadId),
        receipts: receiptCount(harness),
        unknownField: unknownField.status,
      }).toEqual({
        accepted: 200,
        changed: { code: "submission_conflict", status: 409 },
        otherStore: { code: "store_mismatch", status: 409 },
        queued: 1,
        receipts: 1,
        unknownField: 400,
      });
    }));

  it("treats identical bytes uploaded again under another path as the same submission and refuses mismatched content", () =>
    withTestHarness(async (harness) => {
      const { projectId, threadId } = seedBusyThread(
        harness,
        "submission-attachments",
      );

      const storeId = await readStoreId(harness);
      const content = "the same bytes";
      const firstPath = await uploadText(harness, projectId, content);
      const secondPath = await uploadText(harness, projectId, content);

      const mismatched = await submit(
        harness,
        messageSubmission({
          attachments: [declared(firstPath, "other bytes")],
          input: fileInput(firstPath, content),
          storeId,
          submissionId: SUBMISSION_B,
          threadId,
        }),
      );

      const first = await submit(
        harness,
        messageSubmission({
          attachments: [declared(firstPath, content)],
          input: fileInput(firstPath, content),
          storeId,
          submissionId: SUBMISSION_A,
          threadId,
        }),
      );

      const reuploaded = await submit(
        harness,
        messageSubmission({
          attachments: [declared(secondPath, content)],
          input: fileInput(secondPath, content),
          storeId,
          submissionId: SUBMISSION_A,
          threadId,
        }),
      );

      expect({
        differentPaths: firstPath !== secondPath,
        first: first.status,
        mismatched: { code: mismatched.code, status: mismatched.status },
        queued: queuedCount(harness, threadId),
        reuploaded: {
          queuedMessageId: reuploaded.receipt?.queuedMessageId,
          replayed: reuploaded.receipt?.replayed,
          status: reuploaded.status,
        },
      }).toEqual({
        differentPaths: true,
        first: 200,
        mismatched: { code: "attachment_content_mismatch", status: 400 },
        queued: 1,
        reuploaded: {
          queuedMessageId: first.receipt?.queuedMessageId,
          replayed: true,
          status: 200,
        },
      });
    }));

  it("creates one chat for overlapping first prompts that share a submission ID and starts it through the queue", () =>
    withTestHarness(async (harness) => {
      const { host } = seedHostSession(harness.deps);

      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
        path: "/tmp/submission-first-prompt",
      });

      seedEnvironment(harness.deps, {
        hostId: host.id,
        projectId: project.id,
        path: "/tmp/submission-first-prompt",
      });

      const storeId = await readStoreId(harness);

      const body = {
        version: 1,
        submissionId: SUBMISSION_A,
        storeId,
        action: {
          kind: "new-thread",
          thread: {
            origin: "app",
            projectId: project.id,
            providerId: "codex",
            model: "gpt-5-mini",
            input: text("Start a chat from the outbox"),
            environment: {
              type: "host",
              hostId: host.id,
              workspace: { type: "unmanaged", path: null },
            },
          },
        },
        attachments: [],
      };

      const emptiedQueues: { id: string; inTransaction: boolean }[] = [];

      const stopObserving = harness.hub.onThreadChanged((id, changes) => {
        if (
          changes.includes("queue-changed") &&
          listQueuedThreadMessages(harness.db, id, { includeClaimed: true })
            .length === 0
        ) {
          emptiedQueues.push({
            id,
            inTransaction: harness.db.$client.inTransaction,
          });
        }
      });

      const [first, second] = await Promise.all([
        submit(harness, body),
        submit(harness, body),
      ]);

      const later = await submit(harness, body);
      const threadId = first.receipt?.threadId ?? "";

      const started = await waitForQueuedCommand(
        harness,
        ({ command }) =>
          command.type === "thread.start" && command.threadId === threadId,
      );

      stopObserving();
      expect(emptiedQueues).toEqual([{ id: threadId, inTransaction: false }]);

      expect({
        chats: harness.db
          .select({ id: threads.id })
          .from(threads)
          .where(eq(threads.projectId, project.id))
          .all().length,
        later: {
          replayed: later.receipt?.replayed,
          threadId: later.receipt?.threadId,
        },
        receipts: receiptCount(harness),
        replayedFlags: [
          first.receipt?.replayed,
          second.receipt?.replayed,
        ].sort(),
        sameChat: first.receipt?.threadId === second.receipt?.threadId,
        startedCommand: started.command.type,
        statuses: [first.status, second.status, later.status],
      }).toEqual({
        chats: 1,
        later: { replayed: true, threadId },
        receipts: 1,
        replayedFlags: [false, true],
        sameChat: true,
        startedCommand: "thread.start",
        statuses: [200, 200, 200],
      });
    }));

  it("refuses within the bound under a held write lock, stores nothing, then accepts once and keeps its store identity", async () => {
    const directory = await mkdtemp(join(tmpdir(), "omnyo-submissions-"));
    const file = join(directory, "omnyo.db");
    const template = createTestDb();
    await writeFile(file, template.$client.serialize());
    template.$client.close();

    let harness = await createTestAppHarness({ databaseSource: file });

    try {
      const { threadId } = seedBusyThread(harness, "submission-lock");
      const storeId = await readStoreId(harness);

      const body = messageSubmission({
        storeId,
        submissionId: SUBMISSION_A,
        threadId,
      });

      const peer = createConnection(file);
      peer.$client.exec("BEGIN IMMEDIATE");
      const startedAt = performance.now();
      let refused: SubmitOutcome;

      try {
        refused = await submit(harness, body);
      } finally {
        peer.$client.exec("ROLLBACK");
        peer.$client.close();
      }

      const refusedWithinOneSecond = performance.now() - startedAt < 1_000;
      const storedWhileRefused = queuedCount(harness, threadId);
      const accepted = await submit(harness, body);

      await harness.cleanup();
      harness.db.$client.close();
      harness = await createTestAppHarness({ databaseSource: file });

      expect({
        accepted: {
          replayed: accepted.receipt?.replayed,
          status: accepted.status,
        },
        queued: queuedCount(harness, threadId),
        refused: {
          code: refused.code,
          retryable: refused.retryable,
          status: refused.status,
        },
        refusedWithinOneSecond,
        sameStoreAfterReopen: (await readStoreId(harness)) === storeId,
        storedWhileRefused,
      }).toEqual({
        accepted: { replayed: false, status: 200 },
        queued: 1,
        refused: { code: "coordinator_busy", retryable: true, status: 503 },
        refusedWithinOneSecond: true,
        sameStoreAfterReopen: true,
        storedWhileRefused: 0,
      });
    } finally {
      await harness.cleanup();
      harness.db.$client.close();
      await rm(directory, { recursive: true, force: true });
    }
  });
});
