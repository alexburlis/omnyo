import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Worker } from "node:worker_threads";
import { describe, expect, it, vi } from "vitest";
import { PERSONAL_PROJECT_ID, threadScope } from "@omnyo/domain";
import {
  createConnection,
  createThread,
  getLatestThreadSequence,
  getThread,
  getThreadHistoryEpoch,
  insertEvents,
  migrate,
  noopNotifier,
  type DbConnection,
} from "@omnyo/db";
import * as historyWorkers from "../../../src/services/threads/history-cache-writer.js";
import {
  buildThreadTimelineWithProfile,
  threadTimelineBuildIdentity,
} from "../../../src/services/threads/timeline.js";
import { timelineWorkerResultSchema } from "../../../src/services/threads/timeline-worker-contract.js";
import {
  buildThreadTimelinePage,
  closeThreadTimelinePageBuilders,
} from "../../../src/services/threads/timeline-page-builder.js";

const options = {
  compactionOfferEnabled: false,
  completedTurnDisplay: "collapse" as const,
  deferContent: true,
  eventBudget: 1500,
  includeClearedContextHistory: false,
  includeDiagnosticOperations: false,
  includeNestedRows: true,
  maxInlineOutputChars: 32768,
  maxSeq: 0,
  page: { kind: "latest" as const, segmentLimit: 20 },
};

async function withDatabase(run: (db: DbConnection) => Promise<void>) {
  const directory = mkdtempSync(join(tmpdir(), "timeline-deadline-"));
  const db = createConnection(join(directory, "history.db"));

  try {
    migrate(db);
    await run(db);
  } finally {
    await closeThreadTimelinePageBuilders(db);
    db.$client.close();
    rmSync(directory, { recursive: true, force: true });
  }
}

function createFixtureThread(db: DbConnection, text: string) {
  const thread = createThread(db, noopNotifier, {
    projectId: PERSONAL_PROJECT_ID,
    providerId: "codex",
    status: "active",
  });

  insertEvents(db, noopNotifier, [
    {
      threadId: thread.id,
      sequence: 1,
      scope: threadScope(),
      itemId: null,
      itemKind: null,
      parentToolCallId: null,
      type: "system/manager/user_message",
      data: JSON.stringify({ text }),
    },
  ]);

  return thread.id;
}

function fixtureResponse(
  db: DbConnection,
  threadId: string,
  includeNestedRows: boolean,
) {
  const thread = getThread(db, threadId);

  if (thread === null) throw new Error("Fixture thread missing");

  const effectiveOptions = {
    ...options,
    includeNestedRows,
    maxSeq: getLatestThreadSequence(db, { threadId }),
  };

  const { completedRootProjections: _projections, ...timeline } =
    buildThreadTimelineWithProfile(db, thread, effectiveOptions);

  return timelineWorkerResultSchema.parse({
    ...timeline,
    completedRootRecords: [],
    historyEpoch: getThreadHistoryEpoch(db, threadId),
    threadIdentity: threadTimelineBuildIdentity(db, thread, effectiveOptions),
    workerThreadId: 0,
    fromCache: false,
  });
}

describe("active timeline worker deadlines", () => {
  it("expires a hung slot without canceling shared survivors or unrelated workers and recovers queued and fresh reads", async () => {
    try {
      await withDatabase(async (db) => {
        const threadId = createFixtureThread(
          db,
          "Queued history survives timeout",
        );

        const otherThreadId = createFixtureThread(
          db,
          "Unrelated chat remains available",
        );

        const responses = Object.fromEntries(
          [threadId, otherThreadId].flatMap((id) =>
            [true, false].map((includeNestedRows) => [
              JSON.stringify([id, includeNestedRows]),
              fixtureResponse(db, id, includeNestedRows),
            ]),
          ),
        );

        await historyWorkers.ensureHistoryCache(db);
        vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });

        const started = new Promise<Worker>((resolve) => {
          let hungStarted = false;

          vi.spyOn(historyWorkers, "startTimelineWorker").mockImplementation(
            (databasePath, mode) => {
              expect(databasePath).toBe(db.$client.name);
              expect(mode).toBe("read");

              if (hungStarted) {
                return new Worker(
                  `
                const { parentPort, threadId, workerData } = require("node:worker_threads");
                parentPort.on("message", (request) => {
                  const result = workerData[JSON.stringify([request.threadId, request.options.includeNestedRows !== false])];
                  if (!result) throw new Error("Fixture response missing");
                  parentPort.postMessage({ type: "result", id: request.id, result: { ...result, workerThreadId: threadId }, cacheTouches: [] });
                });
              `,
                  { eval: true, execArgv: [], env: {}, workerData: responses },
                );
              }

              hungStarted = true;

              const worker = new Worker(
                'require("node:worker_threads").parentPort.on("message", () => {});',
                {
                  eval: true,
                  execArgv: [],
                  env: {},
                },
              );

              resolve(worker);

              return worker;
            },
          );
        });

        const controller = new AbortController();

        const canceled = buildThreadTimelinePage(db, {
          threadId,
          options,
          signal: controller.signal,
        }).catch((error: Error) => error);

        let settled = false;

        const shared = buildThreadTimelinePage(db, { threadId, options }).catch(
          (error: Error) => {
            settled = true;

            return error;
          },
        );

        const queued = buildThreadTimelinePage(db, {
          threadId,
          options: { ...options, includeNestedRows: false },
        }).catch((error: Error) => error);

        const hung = await started;
        const terminated = vi.spyOn(hung, "terminate");

        controller.abort();
        expect(await canceled).toMatchObject({ name: "AbortError" });
        expect(terminated).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(59_000);
        expect(settled).toBe(false);

        const unrelated = await buildThreadTimelinePage(db, {
          threadId: otherThreadId,
          options,
        });

        expect(JSON.stringify(unrelated.response)).toContain(
          "Unrelated chat remains available",
        );
        await vi.advanceTimersByTimeAsync(999);
        expect(settled).toBe(false);
        await vi.advanceTimersByTimeAsync(1);
        expect(settled).toBe(true);
        expect(await shared).toMatchObject({
          status: 503,
          body: { code: "timeline_unavailable", retryable: true },
        });
        expect(terminated).toHaveBeenCalledTimes(1);
        await terminated.mock.results[0]?.value;

        const stillAvailable = await buildThreadTimelinePage(db, {
          threadId: otherThreadId,
          options,
        });

        expect(stillAvailable.workerThreadId).toBe(unrelated.workerThreadId);
        const recovered = await queued;

        expect(recovered).not.toBeInstanceOf(Error);

        if (recovered instanceof Error) throw recovered;
        expect(JSON.stringify(recovered.response)).toContain(
          "Queued history survives timeout",
        );
        hung.emit("message", { type: "unexpected-late-message" });

        const fresh = await buildThreadTimelinePage(db, {
          threadId,
          options: { ...options, includeNestedRows: false },
        });

        expect(fresh.response).toEqual(recovered.response);
        expect(fresh.workerThreadId).toBe(recovered.workerThreadId);
      });
    } finally {
      vi.useRealTimers();
      vi.restoreAllMocks();
    }
  });
});
