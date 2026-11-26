import { describe, expect, it, vi } from "vitest";
import {
  archiveThread,
  createConnection,
  createProject,
  createThread,
  getThread,
  migrate,
  noopNotifier,
  threadCallbacks,
  unarchiveThread,
  upsertHost,
} from "../../src/index.js";

describe("archive callback waits", () => {
  it("cancels waits for the archived family without stopping sources or reviving waits on unarchive", () => {
    const db = createConnection(":memory:");
    migrate(db);
    const host = upsertHost(db, noopNotifier, { name: "archive-waits" });

    const { project } = createProject(db, noopNotifier, {
      name: "archive-waits",
      source: {
        type: "local_path",
        hostId: host.id,
        path: "/tmp/archive-waits",
      },
    });

    const create = (lifecycleOwnerThreadId?: string) =>
      createThread(db, noopNotifier, {
        projectId: project.id,
        providerId: "codex",
        status: "idle",
        ...(lifecycleOwnerThreadId === undefined
          ? {}
          : { lifecycleOwnerThreadId }),
      });

    const consumer = create();
    const child = create(consumer.id);

    const source = createThread(db, noopNotifier, {
      projectId: project.id,
      providerId: "codex",
      status: "active",
    });

    const unrelated = create();

    try {
      for (const thread of [consumer, child, unrelated])
        db.insert(threadCallbacks)
          .values({
            threadId: thread.id,
            id: `callback-${thread.id}`,
            sourceThreadId: source.id,
            sourceTitle: "Source",
            reason: "Receive result",
            createdAt: Date.now(),
            afterSeq: 0,
            matchText: `marker-${thread.id}`,
          })
          .run();
      expect(db.select().from(threadCallbacks).all()).toHaveLength(3);
      const notifyThread = vi.fn<typeof noopNotifier.notifyThread>();
      archiveThread(db, { ...noopNotifier, notifyThread }, consumer.id);

      for (const threadId of [consumer.id, child.id]) {
        expect(notifyThread).toHaveBeenCalledWith(
          threadId,
          expect.arrayContaining(["archived-changed", "interactions-changed"]),
          expect.objectContaining({ projectId: project.id }),
        );
      }

      expect(
        db
          .select()
          .from(threadCallbacks)
          .all()
          .map((row) => row.threadId),
      ).toEqual([unrelated.id]);

      for (const threadId of [consumer.id, child.id]) {
        expect(getThread(db, threadId)?.archivedAt).not.toBeNull();
      }

      expect(getThread(db, source.id)?.archivedAt).toBeNull();
      expect(getThread(db, source.id)?.status).toBe("active");
      unarchiveThread(db, noopNotifier, consumer.id);
      unarchiveThread(db, noopNotifier, child.id);
      expect(
        db
          .select()
          .from(threadCallbacks)
          .all()
          .map((row) => row.threadId),
      ).toEqual([unrelated.id]);
    } finally {
      db.$client.close();
    }
  });
});
