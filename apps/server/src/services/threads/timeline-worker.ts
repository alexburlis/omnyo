import { parentPort, threadId, workerData } from "node:worker_threads";
import { z } from "zod";
import { createHash } from "node:crypto";
import {
  createConnection,
  findThreadSearchMatches,
  getLatestThreadSequence,
  getThread,
  getThreadHistoryState,
  historyCachePath,
  openHistoryCache,
  historySourceIdentity,
  type HistoryCache,
  type HistoryCacheRecord,
} from "@omnyo/db";
import { ApiError } from "../../errors.js";
import { timelineProjectionDiagnostic } from "./timeline-projection-diagnostics.js";
import {
  buildThreadTimelineWithProfile,
  buildTimelineTurnSummaryDetails,
  threadTimelineBuildIdentity,
  buildThreadConversationOutlineProjectionKey,
  buildConversationOutlineCheckpointKey,
  loadThreadConversationOutline,
  resolveConversationHistorySequenceStart,
} from "./timeline.js";
import {
  timelineWorkerRequestSchema,
  timelineWorkerResultSchema,
} from "./timeline-worker-contract.js";
import {
  prepareCompletedRootProjections,
  TIMELINE_PROJECTION_FORMAT_VERSION,
} from "./timeline-root-cache.js";
import {
  attachHistoryCacheReader,
  historyRecordKey,
} from "./history-cache-access.js";
import { historyCacheCommandSchema } from "./history-cache-writer.js";
import {
  captureConversationOutlineCheckpoint,
  getConversationOutlineCheckpointState,
  conversationOutlineCheckpointSchema,
  restoreConversationOutlineCheckpoint,
} from "./conversation-outline-cache.js";
import {
  redactThreadHistory,
  redactThreadHistoryEvent,
} from "./thread-history-redaction.js";
import { listThreadEventRows } from "./thread-data.js";
import { truncateTimelineResponseOutputs } from "./timeline-output-truncation.js";
import { previewTimelineResponseOutputs } from "./timeline-output-preview.js";

const port = parentPort;

if (port === null) throw new Error("Timeline worker requires a parent");

const data = z
  .object({ databasePath: z.string(), mode: z.enum(["read", "write"]) })
  .parse(workerData);

const queries: { sql: string; durationMs: number; cpuDurationMs: number }[] =
  [];

const db = createConnection(data.databasePath, {
  readonly: true,
  cacheSizeKiB: 8192,
  mmapSizeBytes: 0,
  slowQueryThresholdMs: 250,
  slowQueryLogger: {
    info: (fields) => {
      if (fields.operation !== "transaction")
        queries.push({
          sql: fields.sql,
          durationMs: fields.durationMs,
          cpuDurationMs: fields.cpuDurationMs,
        });
      queries.sort((left, right) => right.durationMs - left.durationMs);

      if (queries.length > 8) queries.length = 8;
    },
  },
});

const sourceIdentity = historySourceIdentity(data.databasePath);

const openedCache = openHistoryCache(historyCachePath(data.databasePath), {
  readonly: data.mode === "read",
});

const cacheHits = new Set<string>();

const cache: HistoryCache =
  data.mode === "read"
    ? {
        ...openedCache,
        get(args) {
          const record = openedCache.get(args);

          if (record !== null) cacheHits.add(record.key);

          return record;
        },
      }
    : openedCache;

const takeCacheHits = (): string[] => {
  const keys = [...cacheHits].slice(0, 1024);
  cacheHits.clear();

  return keys;
};

const outlineDigests = new Map<string, string>();

const outlineEnvelopeSchema = z.object({
  version: z.literal(1),
  digest: z.string(),
  checkpoint: z.unknown(),
});

if (data.mode === "write") {
  let afterKey: string | null = null;

  do {
    const result = cache.reconcile({
      sourceIdentity,
      now: Date.now(),
      afterKey,
      limit: 256,
      isThreadEligible: (record) => {
        const thread = getThread(db, record.threadId);

        return (
          thread !== null &&
          thread.deletedAt === null &&
          getThreadHistoryState(db, thread.id).rewriteEpoch ===
            record.rewriteEpoch
        );
      },
    });

    afterKey = result.nextKey;
  } while (afterKey !== null);

  port.on("message", (message: unknown) => {
    const parsed = historyCacheCommandSchema.safeParse(message);

    if (!parsed.success) {
      port.postMessage({ type: "boot-error" });

      return;
    }

    const request = parsed.data;

    try {
      const admissions: (
        | "stored"
        | "unchanged"
        | "stale"
        | "expired"
        | "capacity"
      )[] = [];

      if (request.kind === "purge")
        for (const id of request.threadIds) cache.purgeThread(id);
      else if (request.kind === "touch") cache.touch(request.keys, Date.now());
      else {
        const thread = getThread(db, request.write.threadId);

        if (thread !== null && thread.deletedAt === null) {
          const state = getThreadHistoryState(db, thread.id);
          const latest = getLatestThreadSequence(db, { threadId: thread.id });

          if (
            state.epoch === request.write.historyEpoch &&
            state.rewriteEpoch === request.write.rewriteEpoch
          )
            cache.batch(() => {
              for (const record of request.write.records) {
                if (
                  record.threadId !== thread.id ||
                  record.sourceIdentity !== sourceIdentity ||
                  record.rewriteEpoch !== state.rewriteEpoch ||
                  record.sequence > latest
                )
                  throw new Error("Invalid history cache binding");

                if (record.kind === "outline") {
                  const existing = cache.get({
                    key: record.key,
                    sourceIdentity,
                    now: Date.now(),
                  });

                  if (
                    existing !== null &&
                    existing.sequence >= record.sequence
                  ) {
                    admissions.push("unchanged");
                    continue;
                  }
                }

                admissions.push(cache.put(record).status);
              }
            });
        }
      }

      port.postMessage({
        type: "cache-result",
        id: request.id,
        ok: true,
        admissions,
      });
    } catch {
      port.postMessage({
        type: "cache-result",
        id: request.id,
        ok: false,
        admissions: [],
      });
    }
  });
  port.postMessage({ type: "ready" });
} else {
  attachHistoryCacheReader(db, cache, sourceIdentity);
  port.on("message", (message: unknown) => {
    const parsed = timelineWorkerRequestSchema.safeParse(message);

    if (!parsed.success) {
      port.postMessage({ type: "error", id: "invalid", status: 503 });

      return;
    }

    const request = parsed.data;
    queries.length = 0;
    cacheHits.clear();

    if (request.kind === "search") {
      try {
        port.postMessage({
          type: "search-result",
          id: request.id,
          result: findThreadSearchMatches(db, {
            query: request.query,
            limitPerGroup: request.limitPerGroup,
          }),
        });
      } catch {
        port.postMessage({ type: "error", id: request.id, status: 503 });
      }

      return;
    }

    try {
      const message = db.transaction(() => {
        const thread = getThread(db, request.threadId);

        if (thread === null || thread.deletedAt !== null)
          throw new ApiError(404, "not_found", "Chat is unavailable");

        if (request.kind === "events")
          return {
            type: "events-result",
            id: request.id,
            result: {
              body: JSON.stringify(
                redactThreadHistory(
                  db,
                  thread.id,
                  listThreadEventRows(db, {
                    threadId: thread.id,
                    ...request.options,
                  }).map(redactThreadHistoryEvent),
                  { invalidJsonText: "withhold" },
                ),
              ),
              queries: [...queries],
            },
          };

        if (request.kind === "turn-details")
          return {
            type: "turn-details-result",
            id: request.id,
            result: {
              body: JSON.stringify(
                redactThreadHistory(
                  db,
                  thread.id,
                  buildTimelineTurnSummaryDetails(db, thread, request.options),
                  { invalidJsonText: "withhold" },
                ),
              ),
              queries: [...queries],
            },
          };

        const state = getThreadHistoryState(db, thread.id);
        const latest = getLatestThreadSequence(db, { threadId: thread.id });
        const records: HistoryCacheRecord[] = [];

        const record = (
          kind: HistoryCacheRecord["kind"],
          key: string,
          body: string,
          sequence: number,
          expiresAt: number | null,
        ) => {
          const maxBytes =
            kind === "outline"
              ? 8 * 1024 * 1024
              : kind === "root"
                ? 4 * 1024 * 1024
                : 1024 * 1024;

          if (Buffer.byteLength(body) > maxBytes) return;
          records.push({
            kind,
            key,
            body,
            sequence,
            expiresAt,
            threadId: thread.id,
            sourceIdentity,
            rewriteEpoch: state.rewriteEpoch,
            createdAt: Date.now(),
          });
        };

        const cacheWrite = {
          threadId: thread.id,
          historyEpoch: state.epoch,
          rewriteEpoch: state.rewriteEpoch,
          records,
        };

        if (request.kind === "outline") {
          const options = {
            ...request.options,
            maxSeq: latest,
          };

          const identity = buildThreadConversationOutlineProjectionKey(
            thread,
            0,
            options,
          );

          const checkpointKey = buildConversationOutlineCheckpointKey(
            thread,
            options,
          );

          const key = historyRecordKey(
            "outline",
            JSON.stringify([state.rewriteEpoch, thread.id, checkpointKey]),
          );

          const current = getConversationOutlineCheckpointState(db, thread.id);

          const reusable =
            current !== null &&
            current.key === checkpointKey &&
            current.rewriteEpoch === state.rewriteEpoch &&
            current.maxSeq <= latest;

          const stored = reusable
            ? null
            : cache.get({ key, sourceIdentity, now: Date.now() });

          let previousDigest: string | null = outlineDigests.get(key) ?? null;

          if (stored !== null) {
            let checkpoint: unknown;

            try {
              checkpoint = JSON.parse(stored.body);
            } catch {
              checkpoint = null;
            }

            const envelope = outlineEnvelopeSchema.safeParse(checkpoint);

            if (envelope.success) {
              previousDigest = envelope.data.digest;

              const candidate = conversationOutlineCheckpointSchema.safeParse(
                envelope.data.checkpoint,
              );

              if (
                candidate.success &&
                (current === null ||
                  current.rewriteEpoch !== candidate.data.rewriteEpoch ||
                  current.key !== candidate.data.key ||
                  current.maxSeq < candidate.data.maxSeq)
              )
                restoreConversationOutlineCheckpoint(
                  db,
                  thread.id,
                  candidate.data,
                );
            }
          }

          const outline = loadThreadConversationOutline(db, thread, options);

          const sanitized = redactThreadHistory(db, thread.id, outline, {
            invalidJsonText: "withhold",
          });

          const digest = createHash("sha256")
            .update(JSON.stringify(sanitized.items))
            .digest("hex");

          const checkpoint =
            digest === previousDigest
              ? null
              : captureConversationOutlineCheckpoint(db, thread.id);

          if (checkpoint !== null)
            record(
              "outline",
              key,
              JSON.stringify({
                version: 1,
                digest,
                checkpoint: redactThreadHistory(db, thread.id, checkpoint, {
                  invalidJsonText: "withhold",
                }),
              }),
              latest,
              null,
            );

          outlineDigests.delete(key);
          outlineDigests.set(key, digest);

          while (outlineDigests.size > 16)
            outlineDigests.delete(outlineDigests.keys().next().value!);

          const response = {
            ...sanitized,
            items:
              options.role === undefined
                ? sanitized.items
                : sanitized.items.filter((item) => item.role === options.role),
          };

          return {
            type: "outline-result",
            id: request.id,
            cacheWrite,
            cacheTouches: takeCacheHits(),
            result: {
              body: JSON.stringify(response),
              maxSeq: latest,
              historySequenceStart: resolveConversationHistorySequenceStart(
                db,
                thread,
                options,
              ),
              historyEpoch: state.epoch,
              threadIdentity: identity,
              workerThreadId: threadId,
              queries: [...queries],
            },
          };
        }

        const options = {
          ...request.options,
          cacheCompletedRoots: true,
          maxSeq:
            request.options.page.kind === "latest"
              ? latest
              : request.options.maxSeq,
        };

        const identity = threadTimelineBuildIdentity(db, thread, options);

        const key = historyRecordKey(
          "page",
          JSON.stringify([
            TIMELINE_PROJECTION_FORMAT_VERSION,
            state.epoch,
            identity,
            options.maxSeq,
            options,
          ]),
        );

        const stored = cache.get({ key, sourceIdentity, now: Date.now() });

        if (stored !== null) {
          let value: unknown;

          try {
            value = JSON.parse(stored.body);
          } catch {
            value = null;
          }

          const parsed = timelineWorkerResultSchema.safeParse(value);

          if (
            parsed.success &&
            parsed.data.historyEpoch === state.epoch &&
            parsed.data.threadIdentity === identity &&
            (parsed.data.expiresAt === null ||
              parsed.data.expiresAt > Date.now())
          )
            return {
              type: "result",
              id: request.id,
              result: {
                ...parsed.data,
                workerThreadId: threadId,
                fromCache: true,
              },
              cacheTouches: takeCacheHits(),
            };
        }

        const { completedRootProjections, ...timeline } =
          buildThreadTimelineWithProfile(db, thread, options);

        const roots = prepareCompletedRootProjections(
          db,
          thread.id,
          completedRootProjections,
        );

        for (const root of roots)
          record(
            "root",
            root.key,
            root.body,
            timeline.response.maxSeq,
            root.expiresAt,
          );

        const truncated =
          options.maxInlineOutputChars === null
            ? timeline.response
            : truncateTimelineResponseOutputs(
                timeline.response,
                options.maxInlineOutputChars,
              );

        const response = redactThreadHistory(
          db,
          thread.id,
          options.includeNestedRows
            ? truncated
            : previewTimelineResponseOutputs(truncated),
          { invalidJsonText: "withhold" },
        );

        const result = {
          ...timeline,
          response,
          completedRootRecords: [],
          threadIdentity: identity,
          historyEpoch: state.epoch,
          workerThreadId: threadId,
          queries: [...queries],
          fromCache: false,
        };

        if (thread.status !== "active" || options.page.kind === "older")
          record(
            "page",
            key,
            JSON.stringify(result),
            response.maxSeq,
            result.expiresAt,
          );

        return {
          type: "result",
          id: request.id,
          result,
          cacheWrite,
          cacheTouches: takeCacheHits(),
        };
      });

      port.postMessage(message);
    } catch (error) {
      const diagnostic = timelineProjectionDiagnostic(error);

      const status =
        error instanceof ApiError &&
        (error.status === 400 || error.status === 404 || error.status === 413)
          ? error.status
          : 503;

      port.postMessage({
        type: "error",
        id: request.id,
        status,
        ...(diagnostic === undefined
          ? {}
          : {
              projectionFailure: {
                diagnostic,
                stack:
                  error instanceof Error
                    ? error.stack?.slice(0, 32768)
                    : undefined,
              },
            }),
        ...(status === 400 && error instanceof ApiError
          ? { message: error.message }
          : {}),
      });
    }
  });
}

port.on("close", () => {
  cache.close();
  db.$client.close();
});
