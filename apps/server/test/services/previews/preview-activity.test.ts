import { and, asc, eq } from "drizzle-orm";
import { events, getLatestThreadSequence, threads } from "@omnyo/db";
import { INBOX_CALLER_THREAD_HEADER, turnScope } from "@omnyo/domain";
import { describe, expect, it, vi } from "vitest";
import {
  registerPreview,
  restartPreview,
} from "../../../src/services/previews/managed-previews.js";
import { registerHostRpcResponder } from "../../helpers/host-rpc.js";
import {
  seedEvent,
  seedThread,
  seedThreadFixture,
  seedTurnStarted,
} from "../../helpers/seed.js";
import {
  withTestHarness,
  type TestAppHarness,
} from "../../helpers/test-app.js";

type PreviewState = "online" | "error";

function setup(
  harness: TestAppHarness,
  state: { current: PreviewState },
  onEnsure: () => void = () => {},
) {
  const fixture = seedThreadFixture(harness, {
    session: { name: "Studio" },
  });

  registerHostRpcResponder(harness, {
    hostId: fixture.host.id,
    sessionId: fixture.session.id,
    handle: () => {
      onEnsure();

      return {
        ok: true,
        result: {
          state: state.current,
          checkedAt: Date.now(),
          detail: state.current === "error" ? "Exited with code 1" : null,
          runId: "run-1",
        },
      };
    },
  });

  const preview = registerPreview(harness.deps, {
    threadId: fixture.thread.id,
    url: "http://localhost:4317/lab",
    argv: ["pnpm", "dev"],
  });

  let requests = 0;

  return {
    fixture,
    preview,
    restart: (actingThreadId: string | null = null) =>
      restartPreview(
        harness.deps,
        preview.id,
        `request-${(requests += 1)}`,
        actingThreadId,
      ),
  };
}

function listActivityEvents(harness: TestAppHarness, threadId: string) {
  return harness.db
    .select({
      scopeKind: events.scopeKind,
      turnId: events.turnId,
      sequence: events.sequence,
      data: events.data,
    })
    .from(events)
    .where(
      and(eq(events.threadId, threadId), eq(events.type, "system/operation")),
    )
    .orderBy(asc(events.sequence))
    .all()
    .map((row) => ({ ...row, data: JSON.parse(row.data) }))
    .filter((row) => row.data.operation === "activity");
}

function completeTurn(
  harness: TestAppHarness,
  args: { threadId: string; turnId: string },
) {
  seedEvent(harness.deps, {
    threadId: args.threadId,
    sequence: getLatestThreadSequence(harness.db, args) + 1,
    type: "turn/completed",
    scope: turnScope(args.turnId),
    providerThreadId: `provider-${args.turnId}`,
    data: { providerThreadId: `provider-${args.turnId}`, status: "completed" },
  });
}

describe("preview started activity", () => {
  it("adds one step to the active turn however often the preview restarts", async () => {
    await withTestHarness(async (harness) => {
      const { fixture, preview, restart } = setup(harness, {
        current: "online",
      });

      const threadId = fixture.thread.id;
      seedTurnStarted(harness.deps, { threadId, turnId: "turn-1" });
      const notify = vi.spyOn(harness.hub, "notifyThread");

      await restart();
      await restart();

      const activities = listActivityEvents(harness, threadId);
      expect(activities).toEqual([
        {
          scopeKind: "turn",
          turnId: "turn-1",
          sequence: expect.any(Number),
          data: expect.objectContaining({
            status: "completed",
            metadata: {
              activityKind: "preview",
              ref: { previewId: preview.id },
              snapshot: {
                url: "http://localhost:4317/lab",
                hostName: "Studio",
              },
            },
          }),
        },
      ]);

      const sequence = activities[0]!.sequence;
      expect(notify).toHaveBeenCalledWith(threadId, ["events-appended"], {
        eventTypes: ["system/operation"],
        timelineSequence: sequence,
        eventSequenceRange: { from: sequence, to: sequence },
      });
    });
  });

  it("uses thread scope outside a turn and adds a new step after a later turn", async () => {
    await withTestHarness(async (harness) => {
      const { fixture, restart } = setup(harness, { current: "online" });
      const threadId = fixture.thread.id;

      await restart();
      await restart();
      expect(listActivityEvents(harness, threadId)).toEqual([
        expect.objectContaining({ scopeKind: "thread", turnId: null }),
      ]);

      seedTurnStarted(harness.deps, { threadId, turnId: "turn-1" });
      completeTurn(harness, { threadId, turnId: "turn-1" });
      await restart();

      expect(
        listActivityEvents(harness, threadId).map((row) => row.scopeKind),
      ).toEqual(["thread", "thread"]);
    });
  });

  it("records the step in the restarting chat when another chat in the project restarts the preview", async () => {
    await withTestHarness(async (harness) => {
      const { fixture, preview } = setup(harness, { current: "online" });

      const second = seedThread(harness.deps, {
        projectId: fixture.project.id,
        environmentId: fixture.environment.id,
      });

      seedTurnStarted(harness.deps, { threadId: second.id, turnId: "turn-2" });

      const response = await harness.app.request(
        `/api/v1/previews/${preview.id}/restart`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            [INBOX_CALLER_THREAD_HEADER]: second.id,
          },
          body: JSON.stringify({ requestId: "agent-request-1" }),
        },
      );

      expect(response.status).toBe(200);

      expect(listActivityEvents(harness, fixture.thread.id)).toEqual([]);
      expect(listActivityEvents(harness, second.id)).toEqual([
        expect.objectContaining({ scopeKind: "turn", turnId: "turn-2" }),
      ]);
    });
  });

  it("records the step in the preview's chat when the caller is outside the project", async () => {
    await withTestHarness(async (harness) => {
      const { fixture, restart } = setup(harness, { current: "online" });
      const outsider = seedThreadFixture(harness);

      await restart(outsider.thread.id);

      expect(listActivityEvents(harness, outsider.thread.id)).toEqual([]);
      expect(listActivityEvents(harness, fixture.thread.id)).toHaveLength(1);
    });
  });

  it("adds no step to an archived chat", async () => {
    await withTestHarness(async (harness) => {
      const { fixture, restart } = setup(harness, { current: "online" });
      harness.db
        .update(threads)
        .set({ archivedAt: Date.now() })
        .where(eq(threads.id, fixture.thread.id))
        .run();

      await expect(restart()).resolves.toMatchObject({ state: "online" });
      expect(listActivityEvents(harness, fixture.thread.id)).toEqual([]);
    });
  });

  it("still reports the started server when its chat is deleted during the restart", async () => {
    await withTestHarness(async (harness) => {
      let threadId = "";

      const { fixture, restart } = setup(harness, { current: "online" }, () => {
        harness.db
          .update(threads)
          .set({ deletedAt: Date.now() })
          .where(eq(threads.id, threadId))
          .run();
      });

      threadId = fixture.thread.id;

      await expect(restart()).resolves.toMatchObject({ state: "online" });
      expect(listActivityEvents(harness, threadId)).toEqual([]);
    });
  });

  it("adds no step when the server did not come online", async () => {
    await withTestHarness(async (harness) => {
      const { fixture, restart } = setup(harness, { current: "error" });

      await expect(restart()).resolves.toMatchObject({ state: "error" });
      expect(listActivityEvents(harness, fixture.thread.id)).toEqual([]);
    });
  });
});
