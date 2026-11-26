import { describe, expect, it, vi } from "vitest";
import {
  createQueuedThreadMessage,
  createQueuedThreadMessageInTransaction,
  createUniqueQueuedThreadMessageInTransaction,
  listQueuedThreadMessages,
  type CreateQueuedThreadMessageInput,
} from "../../src/data/queued-thread-messages.js";
import { createProject } from "../../src/data/projects.js";
import {
  archiveThread,
  createThread,
  deleteThread,
} from "../../src/data/threads.js";
import { upsertHost } from "../../src/data/hosts.js";
import { noopNotifier } from "../../src/notifier.js";
import { createMigratedConnection } from "../helpers/migrated-connection.js";

describe("queued message lifecycle admission", () => {
  it.each(["archived", "deleted", "missing"] as const)(
    "rejects direct and transactional insertion on a %s thread",
    (reason) => {
      const db = createMigratedConnection();

      try {
        const host = upsertHost(db, noopNotifier, { name: "test" });

        const { project } = createProject(db, noopNotifier, {
          name: "test",
          source: { type: "local_path", hostId: host.id, path: "/tmp/test" },
        });

        const thread = createThread(db, noopNotifier, {
          projectId: project.id,
          providerId: "codex",
        });

        const input: CreateQueuedThreadMessageInput = {
          threadId: thread.id,
          content: [{ type: "text", text: "delayed input", mentions: [] }],
          model: "gpt-5",
          reasoningLevel: "medium",
          permissionMode: "full",
          serviceTier: "default",
          waitingOn: { kind: "time" },
          sendAt: Date.now() + 60_000,
          payload: { kind: "inline" },
          systemNotice: null,
        };

        if (reason === "archived")
          createQueuedThreadMessage(db, noopNotifier, input);

        if (reason === "archived") archiveThread(db, noopNotifier, thread.id);
        else if (reason === "deleted") {
          db.$client
            .prepare("UPDATE threads SET deleted_at = ? WHERE id = ?")
            .run(Date.now(), thread.id);
        } else deleteThread(db, noopNotifier, thread.id);
        const before = listQueuedThreadMessages(db, thread.id);
        const notifyThread = vi.fn();

        const expected = expect.objectContaining({
          name: "QueuedMessageThreadUnavailableError",
          threadId: thread.id,
          reason: reason === "archived" ? "archived" : "deleted",
        });

        expect(() =>
          createQueuedThreadMessage(
            db,
            { ...noopNotifier, notifyThread },
            input,
          ),
        ).toThrow(expected);

        for (const insert of [
          createQueuedThreadMessageInTransaction,
          createUniqueQueuedThreadMessageInTransaction,
        ]) {
          expect(() =>
            db.transaction((tx) => insert(tx, input), {
              behavior: "immediate",
            }),
          ).toThrow(expected);
        }

        expect(listQueuedThreadMessages(db, thread.id)).toEqual(before);
        expect(notifyThread).not.toHaveBeenCalled();
      } finally {
        db.$client.close();
      }
    },
  );
});
