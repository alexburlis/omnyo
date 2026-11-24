import { describe, expect, it } from "vitest";
import { noopNotifier } from "../../src/notifier.js";
import {
  createUniqueQueuedThreadMessageInTransaction,
  listQueuedThreadMessages,
  setQueuedThreadMessageFailureReason,
  type CreateQueuedThreadMessageInput,
} from "../../src/data/queued-thread-messages.js";
import { createProject } from "../../src/data/projects.js";
import { createThread } from "../../src/data/threads.js";
import { upsertHost } from "../../src/data/hosts.js";
import { createMigratedConnection } from "../helpers/migrated-connection.js";

function setup() {
  const db = createMigratedConnection();

  const host = upsertHost(db, noopNotifier, { name: "test-host" });

  const { project } = createProject(db, noopNotifier, {
    name: "test-project",
    source: { type: "local_path", hostId: host.id, path: "/tmp/test" },
  });

  const thread = createThread(db, noopNotifier, {
    projectId: project.id,
    providerId: "codex",
  });

  const message = (
    overrides: Partial<CreateQueuedThreadMessageInput> = {},
  ): CreateQueuedThreadMessageInput => ({
    threadId: thread.id,
    content: [{ type: "text", text: "Finish the release", mentions: [] }],
    model: "gpt-5",
    reasoningLevel: "medium",
    permissionMode: "full",
    serviceTier: "default",
    waitingOn: { kind: "server-update" },
    sendAt: null,
    payload: { kind: "inline" },
    systemNotice: null,
    ...overrides,
  });

  const queue = (input: CreateQueuedThreadMessageInput) =>
    db.transaction((tx) =>
      createUniqueQueuedThreadMessageInTransaction(tx, input),
    );

  return { db, message, queue, thread };
}

describe("unique queued thread messages", () => {
  it("reuses the pending copy of an identical message", () => {
    const { db, message, queue, thread } = setup();

    const first = queue(message());
    const second = queue(message({ waitingOn: { kind: "thread-busy" } }));

    expect(first.created).toBe(true);
    expect(second).toEqual({ created: false, row: first.row });
    expect(listQueuedThreadMessages(db, thread.id)).toHaveLength(1);
  });

  it.each([
    [
      "different text",
      {
        content: [{ type: "text" as const, text: "Other work", mentions: [] }],
      },
    ],
    ["a different schedule", { sendAt: 1_800_000_000_000 }],
    ["a different sender", { senderThreadId: "thr_sender" }],
    ["a different delivery mode", { deliveryMode: "queue" as const }],
    ["a different model", { model: "gpt-5-mini" }],
    [
      "a different retry attempt",
      {
        payload: {
          kind: "retry" as const,
          retryOfTurnRequestId: "creq_acakb4x3yj",
          attempt: 2,
          reason: "Continue",
        },
      },
    ],
  ])("keeps a message with %s as its own row", (_label, overrides) => {
    const { db, message, queue, thread } = setup();

    queue(message());

    expect(queue(message(overrides)).created).toBe(true);
    expect(listQueuedThreadMessages(db, thread.id)).toHaveLength(2);
  });

  it("queues a new copy beside an identical message that failed to send", () => {
    const { db, message, queue, thread } = setup();

    const failed = queue(message()).row;
    setQueuedThreadMessageFailureReason(db, noopNotifier, {
      id: failed.id,
      threadId: thread.id,
      failureReason: "Provider rejected the turn",
      now: Date.now(),
      retryDelaysMs: [],
    });

    expect(queue(message()).created).toBe(true);
    expect(listQueuedThreadMessages(db, thread.id)).toHaveLength(2);
  });
});
