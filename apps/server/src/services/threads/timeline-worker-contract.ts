import { z } from "zod";
import { timelineProjectionDiagnosticSchema } from "./timeline-projection-diagnostics.js";
import type { ThreadSearchMatches } from "@omnyo/db";
import {
  completedTurnDisplaySchema,
  promptMentionCommandTriggerSchema,
  threadEventTypeSchema,
  threadSearchSourceKindSchema,
} from "@omnyo/domain";
import {
  threadTimelineResponseSchema,
  timelinePaginationCursorSchema,
} from "@omnyo/server-contract";
import { completedRootRecordSchema } from "./timeline-root-cache.js";
import {
  historyCacheWriteSchema,
  historyCacheAdmissionSchema,
} from "./history-cache-writer.js";
import type {
  BuildThreadTimelineOptions,
  BuildTimelineTurnSummaryDetailsOptions,
  ThreadTimelineBuildProfile,
} from "./timeline.js";

export const timelineBuildOptionsSchema = z.object({
  completedTurnDisplay: completedTurnDisplaySchema,
  deferContent: z.boolean().optional(),
  eventBudget: z.number().int().nonnegative(),
  responseByteBudget: z.number().int().positive().optional(),
  includeClearedContextHistory: z.boolean(),
  includeDiagnosticOperations: z.boolean(),
  includeNestedRows: z.boolean().optional(),
  maxInlineOutputChars: z.number().int().positive().nullable(),
  maxSeq: z.number().int().nonnegative().optional(),
  page: z.discriminatedUnion("kind", [
    z.object({
      kind: z.literal("latest"),
      segmentLimit: z.number().int().positive(),
    }),
    z.object({
      kind: z.literal("older"),
      segmentLimit: z.number().int().positive(),
      beforeCursor: timelinePaginationCursorSchema,
    }),
  ]),
  summaryOnly: z.boolean().optional(),
  compactionOfferEnabled: z.boolean(),
  providerDisplayName: z.string().optional(),
  planCommand: z
    .object({
      trigger: promptMentionCommandTriggerSchema,
      name: z.string(),
      trailingText: z.string(),
    })
    .nullable()
    .optional(),
}) satisfies z.ZodType<BuildThreadTimelineOptions>;

const profileSchema = z.object({
  workerQueueWaitMs: z.number().nonnegative().optional(),
  compactedEventCount: z.number(),
  contextWindowEventDataBytes: z.number(),
  contextWindowEventRowCount: z.number(),
  decodedEventCount: z.number(),
  eventDataBytes: z.number(),
  eventRowCount: z.number(),
  pageKind: z.enum(["latest", "older"]),
  projectedRowCount: z.number(),
  responseRowCount: z.number(),
  returnedSegmentCount: z.number(),
  segmentLimit: z.number(),
  selectionStrategy: z.enum(["full", "standard-window"]),
  stageTimings: z.array(
    z.object({
      durationMs: z.number(),
      stage: z.enum([
        "event-query",
        "selection-memo-lookup",
        "group-context-query",
        "ordering-context-query",
        "accepted-client-request-context-query",
        "event-json-decode",
        "summary-compaction",
        "context-window-query",
        "context-window-json-decode",
        "thread-view-projection",
        "pagination-segmentation",
      ]),
    }),
  ),
  totalDurationMs: z.number(),
}) satisfies z.ZodType<ThreadTimelineBuildProfile>;

export const outlineBuildOptionsSchema = z.object({
  completedTurnDisplay: completedTurnDisplaySchema,
  includeClearedContextHistory: z.boolean(),
  providerDisplayName: z.string().optional(),
  maxSeq: z.number().int().nonnegative(),
  role: z.enum(["user", "assistant"]).optional(),
});

export type OutlineBuildOptions = z.infer<typeof outlineBuildOptionsSchema>;

export const turnDetailsBuildOptionsSchema = z.object({
  beforeCursor: z.string().optional(),
  completedTurnDisplay: completedTurnDisplaySchema,
  deferContent: z.boolean(),
  includeDiagnosticOperations: z.boolean(),
  itemId: z.string().nullable(),
  providerDisplayName: z.string().optional(),
  sourceSeqEnd: z.number().int(),
  sourceSeqStart: z.number().int(),
  turnId: z.string(),
}) satisfies z.ZodType<BuildTimelineTurnSummaryDetailsOptions>;

export const eventsBuildOptionsSchema = z.object({
  afterSeq: z.number().int().optional(),
  beforeSeq: z.number().int().optional(),
  limit: z.number().int().positive(),
  order: z.enum(["asc", "desc"]).optional(),
  types: z.array(threadEventTypeSchema).optional(),
});

export type EventsBuildOptions = z.infer<typeof eventsBuildOptionsSchema>;

export const timelineWorkerRequestSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("timeline"),
    id: z.string(),
    threadId: z.string(),
    options: timelineBuildOptionsSchema,
  }),
  z.object({
    kind: z.literal("outline"),
    id: z.string(),
    threadId: z.string(),
    options: outlineBuildOptionsSchema,
  }),
  z.object({
    kind: z.literal("turn-details"),
    id: z.string(),
    threadId: z.string(),
    options: turnDetailsBuildOptionsSchema,
  }),
  z.object({
    kind: z.literal("events"),
    id: z.string(),
    threadId: z.string(),
    options: eventsBuildOptionsSchema,
  }),
  z.object({
    kind: z.literal("search"),
    id: z.string(),
    query: z.string(),
    limitPerGroup: z.number().int().positive(),
  }),
]);

export type TimelineWorkerRequest = z.infer<typeof timelineWorkerRequestSchema>;

export const timelineWorkerResultSchema = z.object({
  cacheAdmissions: z.array(historyCacheAdmissionSchema).optional(),
  cacheTouches: z.array(z.string()).max(1024).optional(),
  queries: z
    .array(
      z.object({
        sql: z.string(),
        durationMs: z.number(),
        cpuDurationMs: z.number(),
      }),
    )
    .optional(),
  response: threadTimelineResponseSchema,
  profile: profileSchema,
  completedRootRecords: z.array(completedRootRecordSchema),
  expiresAt: z.number().nullable(),
  threadIdentity: z.string(),
  historyEpoch: z.string().regex(/^[a-f0-9]{32}$/u),
  workerThreadId: z.number().int().nonnegative().nullable(),
  fromCache: z.boolean(),
});

export type TimelineWorkerResult = z.infer<typeof timelineWorkerResultSchema>;

export const outlineWorkerResultSchema = z.object({
  queries: z
    .array(
      z.object({
        sql: z.string(),
        durationMs: z.number(),
        cpuDurationMs: z.number(),
      }),
    )
    .optional(),
  cacheAdmissions: z.array(historyCacheAdmissionSchema).optional(),
  cacheTouches: z.array(z.string()).max(1024).optional(),
  body: z.string(),
  maxSeq: z.number().int().nonnegative(),
  historySequenceStart: z.number().int().nonnegative(),
  historyEpoch: z.string(),
  threadIdentity: z.string(),
  workerThreadId: z.number().int().nonnegative().nullable(),
});

export type OutlineWorkerResult = z.infer<typeof outlineWorkerResultSchema>;

export const turnDetailsWorkerResultSchema = z.object({
  queries: z
    .array(
      z.object({
        sql: z.string(),
        durationMs: z.number(),
        cpuDurationMs: z.number(),
      }),
    )
    .optional(),
  body: z.string(),
});

export type TurnDetailsWorkerResult = z.infer<
  typeof turnDetailsWorkerResultSchema
>;

export const eventsWorkerResultSchema = turnDetailsWorkerResultSchema;

export type EventsWorkerResult = TurnDetailsWorkerResult;

const threadSearchMatchGroupSchema = z.object({
  total: z.number().int().nonnegative(),
  threads: z.array(
    z.object({
      threadId: z.string(),
      matches: z.array(
        z.object({
          sourceKind: threadSearchSourceKindSchema,
          text: z.string(),
          highlightRanges: z.array(
            z.object({
              start: z.number().int().nonnegative(),
              end: z.number().int().nonnegative(),
            }),
          ),
          sourceSeq: z.number().int().nullable(),
        }),
      ),
    }),
  ),
});

export const searchWorkerResultSchema = z.object({
  active: threadSearchMatchGroupSchema,
  archived: threadSearchMatchGroupSchema,
}) satisfies z.ZodType<ThreadSearchMatches>;

export const timelineWorkerMessageSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("result"),
    id: z.string(),
    result: timelineWorkerResultSchema,
    cacheWrite: historyCacheWriteSchema.optional(),
    cacheTouches: z.array(z.string()).max(1024),
  }),
  z.object({
    type: z.literal("outline-result"),
    id: z.string(),
    result: outlineWorkerResultSchema,
    cacheWrite: historyCacheWriteSchema.optional(),
    cacheTouches: z.array(z.string()).max(1024),
  }),
  z.object({
    type: z.literal("search-result"),
    id: z.string(),
    result: searchWorkerResultSchema,
  }),
  z.object({
    type: z.literal("turn-details-result"),
    id: z.string(),
    result: turnDetailsWorkerResultSchema,
  }),
  z.object({
    type: z.literal("events-result"),
    id: z.string(),
    result: eventsWorkerResultSchema,
  }),
  z.object({
    type: z.literal("error"),
    id: z.string(),
    status: z.union([
      z.literal(400),
      z.literal(404),
      z.literal(413),
      z.literal(503),
    ]),
    message: z.string().optional(),
    projectionFailure: z
      .object({
        diagnostic: timelineProjectionDiagnosticSchema,
        stack: z.string().max(32768).optional(),
      })
      .optional(),
  }),
]);
