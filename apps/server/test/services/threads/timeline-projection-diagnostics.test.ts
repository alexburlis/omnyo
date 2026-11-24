import { describe, expect, it } from "vitest";
import { turnScope } from "@omnyo/domain";
import {
  createConnection,
  createProject,
  createThread,
  insertEvents,
  migrate,
  noopNotifier,
  upsertHost,
} from "@omnyo/db";
import { MissingProjectionTurnStartedError } from "@omnyo/thread-view";
import {
  timelineProjectionDiagnostic,
  timelineProjectionDiagnosticSchema,
  withTimelineProjectionDiagnostics,
} from "../../../src/services/threads/timeline-projection-diagnostics.js";

describe("timeline projection failure evidence", () => {
  it.each([
    [undefined, "missing"],
    [1, "before-window"],
    [10, "in-window"],
    [30, "after-failure"],
  ] as const)(
    "classifies stored start at %s as %s",
    (sequence, classification) => {
      const db = createConnection(":memory:");
      migrate(db);
      const host = upsertHost(db, noopNotifier, { name: "test-host" });

      const { project } = createProject(db, noopNotifier, {
        name: "test-project",
        source: {
          type: "local_path",
          hostId: host.id,
          path: "/inert/timeline",
        },
      });

      const thread = createThread(db, noopNotifier, {
        projectId: project.id,
        providerId: "codex",
      });

      const error = new MissingProjectionTurnStartedError(
        thread.id,
        "turn",
        "turn/completed",
        20,
        {
          delegatedTurnIds: new Set(),
          events: [
            {
              event: {
                type: "turn/started",
                threadId: thread.id,
                scope: turnScope("other"),
                providerThreadId: "provider-thread",
              },
              meta: { id: "event", seq: 5, createdAt: 0 },
            },
          ],
          messages: [],
        },
      );

      try {
        if (sequence !== undefined)
          insertEvents(db, noopNotifier, [
            {
              threadId: thread.id,
              sequence,
              scope: turnScope("turn"),
              type: "turn/started",
              itemId: null,
              itemKind: null,
              parentToolCallId: null,
              data: JSON.stringify({ providerThreadId: null }),
            },
          ]);

        expect(() =>
          withTimelineProjectionDiagnostics(db, () => {
            throw error;
          }),
        ).toThrow(error);
        expect(timelineProjectionDiagnostic(error)).toMatchObject({
          storedStart: classification,
          ...(sequence === undefined ? {} : { storedStartSequence: sequence }),
        });
        const safe = timelineProjectionDiagnosticSchema.parse(error.diagnostic);
        expect(safe).toEqual(error.diagnostic);
        expect(safe).not.toHaveProperty("threadId");
        expect(safe).not.toHaveProperty("turnId");
      } finally {
        db.$client.close();
      }
    },
  );

  it("preserves unrelated failures and successful results", () => {
    const db = createConnection(":memory:");
    const failure = new Error("unrelated failure");

    try {
      expect(withTimelineProjectionDiagnostics(db, () => 42)).toBe(42);
      expect(() =>
        withTimelineProjectionDiagnostics(db, () => {
          throw failure;
        }),
      ).toThrow(failure);
      expect(timelineProjectionDiagnostic(failure)).toBeUndefined();
    } finally {
      db.$client.close();
    }
  });
});
