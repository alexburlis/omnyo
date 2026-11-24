import { describe, expect, it } from "vitest";
import {
  createConnection,
  migrate,
  createProject,
  createThread,
  upsertHost,
  noopNotifier,
  createQueuedThreadMessage,
  getQueuedThreadMessage,
} from "@omnyo/db";
import {
  appendPreparedClientTurnRequestedEventWithNotificationInTransaction,
  createClientTurnRequestId,
} from "../../src/services/threads/thread-events.js";

describe("new request supersedes queued retries", () => {
  it.each(["user", "agent", "system"] as const)(
    "only a new intentional message overtakes retry input (%s)",
    (initiator) => {
      const db = createConnection(":memory:");
      migrate(db);

      try {
        const host = upsertHost(db, noopNotifier, { name: "retry-owner" });

        const { project } = createProject(db, noopNotifier, {
          name: "retry",
          source: {
            type: "local_path",
            hostId: host.id,
            path: "/tmp/retry-owner",
          },
        });

        const thread = createThread(db, noopNotifier, {
          projectId: project.id,
          providerId: "codex",
        });

        const retry = createQueuedThreadMessage(db, noopNotifier, {
          threadId: thread.id,
          content: [{ type: "text", text: "Original input", mentions: [] }],
          model: "gpt-5",
          reasoningLevel: "medium",
          permissionMode: "full",
          serviceTier: "default",
          waitingOn: { kind: "time" },
          sendAt: Date.now() + 60_000,
          payload: {
            kind: "retry",
            retryOfTurnRequestId: createClientTurnRequestId(),
            attempt: 2,
            reason: "Rate limited",
          },
          systemNotice: null,
        });

        const request = db.transaction((tx) =>
          appendPreparedClientTurnRequestedEventWithNotificationInTransaction(
            { db: tx, hub: noopNotifier },
            {
              requestId: createClientTurnRequestId(),
              environmentId: null,
              execution: {
                model: "gpt-5",
                reasoningLevel: "medium",
                permissionMode: "full",
                serviceTier: "default",
                source: "client/turn/requested",
              },
              initiator,
              input: [{ type: "text", text: "New work", mentions: [] }],
              requestMethod: "turn/start",
              senderThreadId: null,
              source: "tell",
              target: { kind: "new-turn" },
              threadId: thread.id,
              type: "client/turn/requested",
            },
          ),
        );

        const row = getQueuedThreadMessage(db, retry.id);
        expect(row?.waitingOn).toBe(
          JSON.stringify({
            kind: initiator === "system" ? "time" : "superseded",
          }),
        );
        expect(request.notificationChanges.includes("queue-changed")).toBe(
          initiator !== "system",
        );
      } finally {
        db.$client.close();
      }
    },
  );
});
