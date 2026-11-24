import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import {
  claimQueuedThreadMessageGroup,
  createConnection,
  createProject,
  createQueuedThreadMessage,
  createThread,
  getPendingCoalescedQueuedThreadMessage,
  getQueuedThreadMessage,
  migrate,
  noopNotifier,
  updateCoalescedQueuedThreadMessageInTransaction,
  upsertHost,
} from "../src/index.js";

it("retains an unfinished notice window across database reopen without mutating a claimed row", () => {
  const directory = mkdtempSync(join(tmpdir(), "omnyo-notice-coalescing-"));
  const path = join(directory, "notice.db");
  let db = createConnection(path);

  try {
    migrate(db);
    const host = upsertHost(db, noopNotifier, { name: "notice-owner" });

    const { project } = createProject(db, noopNotifier, {
      name: "notice-owner",
      source: { type: "local_path", hostId: host.id, path: "/tmp/notices" },
    });

    const thread = createThread(db, noopNotifier, {
      projectId: project.id,
      providerId: "codex",
    });

    const content = [
      { type: "text" as const, text: "First outcome", mentions: [] },
    ];

    const notice = { kind: "child-completed" as const, subject: null };
    const now = Date.now();

    const row = createQueuedThreadMessage(db, noopNotifier, {
      threadId: thread.id,
      content,
      model: "gpt-5",
      reasoningLevel: "medium",
      permissionMode: "full",
      serviceTier: "default",
      waitingOn: { kind: "time" },
      sendAt: now + 60_000,
      payload: { kind: "inline" },
      systemNotice: notice,
      coalesce: { key: "child-outcomes", state: '["first"]' },
    });

    db.$client.close();
    db = createConnection(path);
    migrate(db);
    expect(
      getPendingCoalescedQueuedThreadMessage(db, {
        threadId: thread.id,
        coalesceKey: "child-outcomes",
        now,
      }),
    ).toMatchObject({
      id: row.id,
      coalesceState: '["first"]',
      content: JSON.stringify(content),
    });
    expect(
      claimQueuedThreadMessageGroup(db, noopNotifier, row.id, {
        kind: "explicit-send",
      }),
    ).not.toBeNull();

    const updated = db.transaction((tx) =>
      updateCoalescedQueuedThreadMessageInTransaction(tx, {
        threadId: thread.id,
        id: row.id,
        content: [{ type: "text", text: "Overwritten", mentions: [] }],
        systemNotice: notice,
        coalesceState: '["second"]',
        sendAt: now + 70_000,
      }),
    );

    expect(updated).toBeNull();
    expect(getQueuedThreadMessage(db, row.id)).toMatchObject({
      coalesceState: '["first"]',
      content: JSON.stringify(content),
    });
  } finally {
    if (db.$client.open) db.$client.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
