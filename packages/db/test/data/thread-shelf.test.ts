import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it, vi } from "vitest";
import { noopNotifier, type DbNotifier } from "../../src/notifier.js";
import { threads } from "../../src/schema.js";
import {
  archiveThread,
  createThread,
  getThread,
  hasActiveThreadAttention,
  listActiveVisiblePinnedThreadRoots,
  listThreadsWithPendingInteractionState,
  markThreadDeleted,
  pinThread,
  reorderShelvedThread,
  shelveThreadFamily,
  unshelveThreadFamily,
} from "../../src/data/threads.js";
import { createProject } from "../../src/data/projects.js";
import { upsertHost } from "../../src/data/hosts.js";
import { createMigratedConnection } from "../helpers/migrated-connection.js";

function createSpyNotifier(): DbNotifier {
  return {
    notifyThread: vi.fn(),
    notifyEnvironment: vi.fn(),
    notifyHost: vi.fn(),
    notifyProject: vi.fn(),
    notifySystem: vi.fn(),
  };
}

function setupFamily() {
  const db = createMigratedConnection();
  const host = upsertHost(db, noopNotifier, { name: "test-host" });

  const { project } = createProject(db, noopNotifier, {
    name: "test-project",
    source: { type: "local_path", hostId: host.id, path: "/tmp/test" },
  });

  const root = createThread(db, noopNotifier, {
    projectId: project.id,
    providerId: "codex",
  });

  const child = createThread(db, noopNotifier, {
    parentThreadId: root.id,
    projectId: project.id,
    providerId: "codex",
  });

  const hiddenGrandchild = createThread(db, noopNotifier, {
    parentThreadId: child.id,
    projectId: project.id,
    providerId: "codex",
    visibility: "hidden",
  });

  return { db, project, root, child, hiddenGrandchild };
}

describe("thread shelf", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("shelves every live family member and marks only the top-level thread read", () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const { db, project, root, child, hiddenGrandchild } = setupFamily();

    const archivedChild = createThread(db, noopNotifier, {
      parentThreadId: root.id,
      projectId: project.id,
      providerId: "codex",
    });

    const deletedChild = createThread(db, noopNotifier, {
      parentThreadId: root.id,
      projectId: project.id,
      providerId: "codex",
    });

    archiveThread(db, noopNotifier, archivedChild.id);
    markThreadDeleted(db, noopNotifier, { threadId: deletedChild.id });
    db.update(threads).set({ lastReadAt: null }).run();
    vi.setSystemTime(2_000);
    const notifier = createSpyNotifier();

    expect(shelveThreadFamily(db, notifier, { threadId: root.id })).toEqual({
      kind: "shelved",
      thread: expect.objectContaining({
        id: root.id,
        lastReadAt: 2_000,
        shelvedAt: 2_000,
      }),
    });
    expect(getThread(db, child.id)).toMatchObject({
      lastReadAt: null,
      shelvedAt: 2_000,
    });
    expect(getThread(db, hiddenGrandchild.id)?.shelvedAt).toBe(2_000);
    expect(getThread(db, archivedChild.id)?.shelvedAt).toBeNull();
    expect(getThread(db, deletedChild.id)?.shelvedAt).toBeNull();
    expect(notifier.notifyThread).toHaveBeenCalledTimes(3);
    expect(notifier.notifyThread).toHaveBeenCalledWith(
      root.id,
      expect.arrayContaining(["shelf-state-changed", "read-state-changed"]),
      { projectId: project.id },
    );
    expect(notifier.notifyThread).toHaveBeenCalledWith(
      child.id,
      ["shelf-state-changed"],
      { projectId: project.id },
    );
    expect(notifier.notifyThread).toHaveBeenCalledWith(
      hiddenGrandchild.id,
      ["shelf-state-changed"],
      { projectId: project.id },
    );

    vi.setSystemTime(3_000);

    expect(shelveThreadFamily(db, notifier, { threadId: root.id })).toEqual({
      kind: "shelved",
      thread: expect.objectContaining({ lastReadAt: 2_000, shelvedAt: 2_000 }),
    });
    expect(notifier.notifyThread).toHaveBeenCalledTimes(3);
  });

  it("shelves a sub-chat that joined a shelved family at the family's shelf time", () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const { db, project, root } = setupFamily();
    shelveThreadFamily(db, noopNotifier, { threadId: root.id });
    vi.setSystemTime(2_000);

    const lateChild = createThread(db, noopNotifier, {
      parentThreadId: root.id,
      projectId: project.id,
      providerId: "codex",
    });

    const notifier = createSpyNotifier();

    expect(shelveThreadFamily(db, notifier, { threadId: root.id })).toEqual({
      kind: "shelved",
      thread: expect.objectContaining({
        id: root.id,
        lastReadAt: 1_000,
        shelvedAt: 1_000,
      }),
    });
    expect(getThread(db, lateChild.id)?.shelvedAt).toBe(1_000);
    expect(notifier.notifyThread).toHaveBeenCalledTimes(1);
    expect(notifier.notifyThread).toHaveBeenCalledWith(
      lateChild.id,
      ["shelf-state-changed"],
      { projectId: project.id },
    );
  });

  it("returns the whole family when a sub-chat comes back", () => {
    const { db, project, root, child, hiddenGrandchild } = setupFamily();
    shelveThreadFamily(db, noopNotifier, { threadId: root.id });
    const notifier = createSpyNotifier();

    expect(
      unshelveThreadFamily(db, notifier, {
        threadId: hiddenGrandchild.id,
      }).sort(),
    ).toEqual([root.id, child.id, hiddenGrandchild.id].sort());

    for (const thread of [root, child, hiddenGrandchild]) {
      expect(getThread(db, thread.id)?.shelvedAt).toBeNull();
      expect(notifier.notifyThread).toHaveBeenCalledWith(
        thread.id,
        ["shelf-state-changed"],
        { projectId: project.id },
      );
    }

    expect(unshelveThreadFamily(db, notifier, { threadId: child.id })).toEqual(
      [],
    );
    expect(notifier.notifyThread).toHaveBeenCalledTimes(3);
  });

  it("keeps Shelf membership when it archives a family", () => {
    const { db, project, root } = setupFamily();

    const shelvedDependent = createThread(db, noopNotifier, {
      lifecycleOwnerThreadId: root.id,
      projectId: project.id,
      providerId: "codex",
    });

    const activeDependent = createThread(db, noopNotifier, {
      lifecycleOwnerThreadId: root.id,
      projectId: project.id,
      providerId: "codex",
    });

    shelveThreadFamily(db, noopNotifier, { threadId: root.id });
    const shelvedAt = getThread(db, root.id)?.shelvedAt;
    const notifier = createSpyNotifier();

    archiveThread(db, notifier, root.id);

    expect(getThread(db, root.id)).toMatchObject({
      archivedAt: expect.any(Number),
      shelvedAt,
    });

    for (const thread of [root, shelvedDependent, activeDependent])
      expect(notifier.notifyThread).toHaveBeenCalledWith(
        thread.id,
        ["archived-changed"],
        { projectId: project.id },
      );
  });

  it("leaves shelved families out of pinned roots and attention", () => {
    const { db, root, child } = setupFamily();
    pinThread(db, noopNotifier, { threadId: root.id });
    db.update(threads)
      .set({ lastReadAt: null })
      .where(eq(threads.id, child.id))
      .run();

    expect(
      listActiveVisiblePinnedThreadRoots(db).map((thread) => thread.id),
    ).toEqual([root.id]);
    expect(hasActiveThreadAttention(db)).toBe(true);

    shelveThreadFamily(db, noopNotifier, { threadId: root.id });

    expect(listActiveVisiblePinnedThreadRoots(db)).toEqual([]);
    expect(hasActiveThreadAttention(db)).toBe(false);
  });
});

describe("Shelf order", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  function setupShelf() {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const { db, project, root, child } = setupFamily();

    const second = createThread(db, noopNotifier, {
      projectId: project.id,
      providerId: "codex",
    });

    const third = createThread(db, noopNotifier, {
      projectId: project.id,
      providerId: "codex",
    });

    for (const thread of [root, second, third]) {
      vi.advanceTimersByTime(10);
      shelveThreadFamily(db, noopNotifier, { threadId: thread.id });
    }

    return { db, root, child, second, third };
  }

  function shelf(db: ReturnType<typeof setupFamily>["db"]): string[] {
    return listThreadsWithPendingInteractionState(db, {
      shelved: true,
    }).map((thread) => thread.id);
  }

  it("puts a newly shelved family at the top and keeps it together", () => {
    const { db, root, child, second, third } = setupShelf();

    expect(shelf(db)).toEqual([third.id, second.id, root.id, child.id]);
    expect(getThread(db, child.id)?.shelfSortKey).toBe(
      getThread(db, root.id)?.shelfSortKey,
    );
  });

  it("moves a family between its new neighbors and clears the order on unshelve", () => {
    const { db, root, child, second, third } = setupShelf();
    const notifier = createSpyNotifier();

    expect(
      reorderShelvedThread({
        db,
        notifier,
        threadId: root.id,
        previousThreadId: third.id,
        nextThreadId: second.id,
      }),
    ).toEqual({ kind: "reordered" });
    expect(shelf(db)).toEqual([third.id, root.id, child.id, second.id]);
    expect(notifier.notifyThread).toHaveBeenCalledWith(
      child.id,
      ["shelf-state-changed"],
      { projectId: root.projectId },
    );

    unshelveThreadFamily(db, noopNotifier, { threadId: root.id });

    expect(getThread(db, root.id)?.shelfSortKey).toBeNull();
    expect(getThread(db, child.id)?.shelfSortKey).toBeNull();
  });

  it("refuses moves that do not match the current Shelf", () => {
    const { db, root, child, second, third } = setupShelf();

    const reorder = (
      threadId: string,
      previousThreadId: string | null,
      nextThreadId: string | null,
    ) =>
      reorderShelvedThread({
        db,
        notifier: noopNotifier,
        threadId,
        previousThreadId,
        nextThreadId,
      }).kind;

    expect(reorder(child.id, null, third.id)).toBe("not_shelved");
    expect(reorder(root.id, child.id, null)).toBe("stale_neighbor");
    expect(reorder(root.id, second.id, third.id)).toBe(
      "invalid_neighbor_order",
    );
    expect(reorder(root.id, second.id, null)).toBe("unchanged");
    expect(reorder("thr_missing", null, null)).toBe("not_found");
  });
});
