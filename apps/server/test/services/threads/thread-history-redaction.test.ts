import { describe, expect, it } from "vitest";
import { threadScope } from "@omnyo/domain";
import {
  createConnection,
  createProject,
  createThread,
  deleteThreadEventSuffixInTransaction,
  insertEvents,
  migrate,
  noopNotifier,
  upsertHost,
  type DbConnection,
} from "@omnyo/db";
import { redactThreadHistory } from "../../../src/services/threads/thread-history-redaction.js";

function setupThread(): { db: DbConnection; threadId: string } {
  const db = createConnection(":memory:");
  migrate(db);
  const host = upsertHost(db, noopNotifier, { name: "redaction-host" });

  const { project } = createProject(db, noopNotifier, {
    name: "redaction-project",
    source: { type: "local_path", hostId: host.id, path: "/tmp/redaction" },
  });

  const thread = createThread(db, noopNotifier, {
    projectId: project.id,
    providerId: "codex",
  });

  return { db, threadId: thread.id };
}

function resolveEnvironment(
  db: DbConnection,
  threadId: string,
  sequence: number,
  value: string,
): void {
  insertEvents(db, noopNotifier, [
    {
      threadId,
      sequence,
      type: "provider.env-resolved",
      scope: threadScope(),
      providerThreadId: "provider-thread",
      itemId: null,
      itemKind: null,
      parentToolCallId: null,
      data: JSON.stringify({
        entries: [{ name: "SERVICE_TOKEN", source: "shell", value }],
      }),
    },
  ]);
}

describe("thread history redaction", () => {
  it("redacts a credential learned by rewriting an event at the same sequence", () => {
    const { db, threadId } = setupThread();
    const history = { text: "second-known-value" };

    try {
      resolveEnvironment(db, threadId, 1, "first-known-value");
      expect(redactThreadHistory(db, threadId, history).text).toBe(
        history.text,
      );
      db.transaction((tx) =>
        deleteThreadEventSuffixInTransaction(tx, {
          threadId,
          cutoffSequence: 1,
          oldMaxSequence: 1,
        }),
      );
      resolveEnvironment(db, threadId, 1, "second-known-value");

      expect(redactThreadHistory(db, threadId, history).text).not.toContain(
        history.text,
      );
    } finally {
      db.$client.close();
    }
  });

  it("redacts a credential resolved after earlier history reads", () => {
    const { db, threadId } = setupThread();
    const history = { text: "first-known-value then second-known-value" };

    try {
      resolveEnvironment(db, threadId, 1, "first-known-value");
      const before = redactThreadHistory(db, threadId, history).text;
      resolveEnvironment(db, threadId, 2, "second-known-value");
      const after = redactThreadHistory(db, threadId, history).text;

      expect(before).not.toContain("first-known-value");
      expect(before).toContain("second-known-value");
      expect(after).not.toContain("first-known-value");
      expect(after).not.toContain("second-known-value");
    } finally {
      db.$client.close();
    }
  });
});
