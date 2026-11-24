import {
  buildThreadTimelinePage,
  buildThreadConversationOutlinePage,
  invalidateThreadHistoryBuilders,
  loadThreadEventListBody,
  loadTimelineTurnSummaryDetails,
} from "../../services/threads/timeline-page-builder.js";
import {
  purgeHistoryCacheThread,
  touchHistoryCache,
} from "../../services/threads/history-cache-writer.js";
import { TIMELINE_PROJECTION_FORMAT_VERSION } from "../../services/threads/timeline-root-cache.js";
import { randomUUID } from "node:crypto";
import { clearTimelineOrderingContextCache } from "../../services/threads/timeline-context-order.js";
import {
  getAppSettings,
  getThreadPluginMetadata,
  patchThreadPluginMetadata,
  getLatestThreadSequence,
  getThreadHistoryEpoch,
  getThreadHistoryState,
  listQueuedThreadMessages,
} from "@omnyo/db";
import type { Hono } from "hono";
import {
  DEFAULT_COMPLETED_TURN_DISPLAY,
  PROMPT_HISTORY_ENTRY_LIMIT,
  threadEventTypeSchema,
  type AppSettings,
  type CompletedTurnDisplay,
  type Thread,
  type ThreadEventType,
} from "@omnyo/domain";
import {
  publicApiRoutes,
  THREAD_EVENT_LIST_PAGE_SIZE,
  typedRoutes,
  type PublicApiSchema,
  type ThreadTimelineQuery,
} from "@omnyo/server-contract";
import type { ServerMaintenance } from "../../services/maintenance/server-maintenance.js";
import type { AppDeps } from "../../types.js";
import { COMMAND_TIMEOUT_MS } from "../../constants.js";
import { ApiError } from "../../errors.js";
import { requirePublicThread } from "../../services/lib/entity-lookup.js";
import { callHostRetryableOnlineRpc } from "../../services/hosts/online-rpc.js";
import { requireThreadStorageTarget } from "../../services/threads/thread-storage.js";
import { toThreadQueuedMessage } from "../../services/threads/thread-queued-messages.js";
import {
  isCompactionOfferEnabled,
  withCompactionOffer,
} from "../../services/threads/compaction-offer.js";
import {
  getAutoCompactionState,
  withAutoCompactionAt,
} from "../../services/threads/auto-compaction.js";
import { readThreadContextWindowUsage } from "../../services/threads/context-window-usage.js";
import {
  readAutoCompactionMetadata,
  writeAutoCompactionMetadata,
} from "../../services/threads/maintenance-run.js";
import {
  buildThreadConversationOutlineProjectionKey,
  resolveConversationHistorySequenceStart,
  getThreadMessage,
  buildThreadConversationPage,
  getThreadTimelineSnapshot,
  threadTimelineBuildIdentity,
  type BuildThreadTimelineOptions,
  THREAD_TIMELINE_DEFAULT_SEGMENT_LIMIT,
  THREAD_TIMELINE_SEGMENT_LIMIT_MAX,
} from "../../services/threads/timeline.js";
import type {
  ThreadTimelinePageKind,
  ThreadTimelinePageRequest,
} from "../../services/threads/timeline-pagination.js";
import { createSlowThreadTimelineBuildLogger } from "../../services/threads/timeline-build-log.js";
import {
  buildThreadTimelineParamsKey,
  createThreadTimelineCache,
} from "../../services/threads/timeline-cache.js";
import { createTimelineLatestRowsCache } from "../../services/threads/timeline-latest-rows-cache.js";
import { DEFAULT_MAX_INLINE_OUTPUT_CHARS } from "../../services/threads/timeline-output-truncation.js";
import { computeTimelineRowDelta } from "@omnyo/server-contract";
import {
  findThreadEvent,
  getLastThreadOutput,
  listThreadEventRows,
} from "../../services/threads/thread-data.js";
import {
  redactThreadHistory,
  redactThreadHistoryEvent,
} from "../../services/threads/thread-history-redaction.js";
import { listThreadPromptHistory } from "../../services/prompt-history.js";
import { tryResolveExistingThreadExecutionPlan } from "../../services/threads/thread-execution-plan.js";
import {
  parseBoundedPositiveOptionalInteger,
  parseInteger,
  parseOptionalInteger,
} from "../../services/lib/validation.js";
import { resolveProviderPlanCommand } from "../../services/providers/provider-plan-command.js";
import { parsePathKindInclusion } from "../path-list-inclusion.js";
import {
  DEFAULT_PATH_LIST_EXCLUDE_NAMES,
  THREAD_STORAGE_PATH_LIST_INCLUDE_HIDDEN,
} from "../path-list-policy.js";
import { parseFileListLimit } from "../file-list-query.js";

function resolveThreadProviderDisplayName(
  deps: Pick<AppDeps, "providerRegistry">,
  providerId: string,
): string | undefined {
  return deps.providerRegistry.get(providerId)?.info.displayName;
}

function resolveThreadCompletedTurnDisplay(
  deps: Pick<AppDeps, "providerRegistry">,
  settings: AppSettings,
  providerId: string,
): CompletedTurnDisplay {
  return (
    settings.providerCompletedTurnDisplay[providerId] ??
    deps.providerRegistry.get(providerId)?.info.completedTurnDisplay ??
    DEFAULT_COMPLETED_TURN_DISPLAY
  );
}

function parseThreadEventTypes(
  value: string | undefined,
): ThreadEventType[] | undefined {
  if (value === undefined) return undefined;

  return value.split(",").map((type) => {
    const parsed = threadEventTypeSchema.safeParse(type);

    if (!parsed.success) {
      throw new ApiError(400, "invalid_request", "Invalid event type");
    }

    return parsed.data;
  });
}

function parseThreadTimelineSegmentLimit(
  defaultLimit: number,
  rawLimit: string | undefined,
): number {
  const limit = parseOptionalInteger(rawLimit, "segmentLimit") ?? defaultLimit;

  if (limit <= 0) {
    throw new ApiError(
      400,
      "invalid_request",
      "segmentLimit must be a positive integer",
    );
  }

  if (limit > THREAD_TIMELINE_SEGMENT_LIMIT_MAX) {
    throw new ApiError(
      400,
      "invalid_request",
      `segmentLimit must be less than or equal to ${THREAD_TIMELINE_SEGMENT_LIMIT_MAX}`,
    );
  }

  return limit;
}

function parseThreadTimelinePage(
  query: ThreadTimelineQuery,
): ThreadTimelinePageRequest {
  const hasBeforeAnchorSeq = query.beforeAnchorSeq !== undefined;
  const kind: ThreadTimelinePageKind = hasBeforeAnchorSeq ? "older" : "latest";

  const segmentLimit = parseThreadTimelineSegmentLimit(
    THREAD_TIMELINE_DEFAULT_SEGMENT_LIMIT,
    query.segmentLimit,
  );

  if (kind === "latest") {
    return {
      kind,
      segmentLimit,
    };
  }

  if (
    query.beforeAnchorSeq === undefined ||
    query.beforeAnchorId === undefined
  ) {
    throw new ApiError(
      400,
      "invalid_request",
      "beforeAnchorSeq and beforeAnchorId must be provided together",
    );
  }

  return {
    beforeCursor: {
      anchorSeq: parseInteger(query.beforeAnchorSeq, "beforeAnchorSeq"),
      anchorId: query.beforeAnchorId,
    },
    kind,
    segmentLimit,
  };
}

export function registerThreadDataRoutes(
  app: Hono,
  deps: AppDeps,
  maintenance: Pick<ServerMaintenance, "getRuntimeId">,
): void {
  const { get, patch, put } = typedRoutes<PublicApiSchema>(app, {
    onValidationError: (msg) => new ApiError(400, "invalid_request", msg),
  });

  const routes = publicApiRoutes.threads;
  const timelineCache = createThreadTimelineCache();
  const timelineLatestRowsCache = createTimelineLatestRowsCache();
  const timelineDeltaFloorByThreadId = new Map<string, number>();
  deps.hub.onChangedMessage((message) => {
    if (message.entity !== "thread") {
      return;
    }

    if (message.changes.includes("thread-deleted")) {
      invalidateThreadHistoryBuilders(deps.db, message.id);
      void purgeHistoryCacheThread(deps.db, message.id).catch((error) =>
        deps.logger.error(
          { error, threadId: message.id },
          "History cache deletion failed",
        ),
      );
      timelineDeltaFloorByThreadId.delete(message.id);
      timelineCache.invalidateThread(message.id);
      timelineLatestRowsCache.invalidateThread(message.id);

      return;
    }

    const rewritten = message.changes.includes("history-rewritten");

    if (!rewritten && !message.changes.includes("history-compacted")) {
      return;
    }

    if (rewritten) {
      clearTimelineOrderingContextCache(deps.db);
    }

    invalidateThreadHistoryBuilders(deps.db, message.id);
    void purgeHistoryCacheThread(deps.db, message.id).catch((error) =>
      deps.logger.error(
        { error, threadId: message.id },
        "History cache invalidation failed",
      ),
    );

    timelineCache.invalidateThread(message.id);
    timelineLatestRowsCache.invalidateThread(message.id);
    timelineDeltaFloorByThreadId.set(
      message.id,
      getLatestThreadSequence(deps.db, { threadId: message.id }),
    );
  });

  const slowTimelineBuildLogger = createSlowThreadTimelineBuildLogger({
    logger: deps.logger,
  });

  const touchReadHistory = (
    threadId: string,
    keys: readonly string[] | undefined,
  ) => {
    if (keys === undefined || keys.length === 0) return;
    void touchHistoryCache(deps.db, keys).catch((error) =>
      deps.logger.warn(
        { error, threadId },
        "History cache access update failed",
      ),
    );
  };

  const resolveConversationRowsOptions = (thread: Thread) => {
    const providerDisplayName = resolveThreadProviderDisplayName(
      deps,
      thread.providerId,
    );

    const settings = getAppSettings(deps.db);

    return {
      completedTurnDisplay: resolveThreadCompletedTurnDisplay(
        deps,
        settings,
        thread.providerId,
      ),
      includeClearedContextHistory: settings.keepHistoryAfterContextClear,
      maxSeq: getLatestThreadSequence(deps.db, { threadId: thread.id }),
      ...(providerDisplayName === undefined ? {} : { providerDisplayName }),
    };
  };

  get(routes.pluginMetadata.get, (context, query) => {
    const thread = requirePublicThread(deps.db, context.req.param("id"));

    const { metadata, corrupt } = getThreadPluginMetadata(
      deps.db,
      thread.id,
      query.pluginId,
    );

    if (corrupt) {
      deps.logger.warn(
        `Ignoring corrupt plugin metadata for thread ${thread.id}, plugin ${query.pluginId}`,
      );
    }

    return context.json(metadata);
  });

  patch(routes.pluginMetadata.update, (context, payload) => {
    const thread = requirePublicThread(deps.db, context.req.param("id"));

    const result = patchThreadPluginMetadata(deps.db, {
      threadId: thread.id,
      pluginId: payload.pluginId,
      set: payload.set ?? {},
      remove: payload.remove ?? [],
    });

    if (!result.ok) {
      throw new ApiError(
        413,
        "invalid_request",
        "pluginMetadata exceeds 256 KiB",
      );
    }

    if (result.replacedCorrupt) {
      deps.logger.warn(
        `Replaced corrupt plugin metadata for thread ${thread.id}, plugin ${payload.pluginId}`,
      );
    }

    return context.json(result.metadata);
  });

  get(routes.context, (context) => {
    const thread = requirePublicThread(deps.db, context.req.param("id"));

    const now = Date.now();

    const { sequenceStart, usage } = readThreadContextWindowUsage(
      deps.db,
      thread.id,
    );

    return context.json({
      usage:
        usage === null
          ? null
          : withAutoCompactionAt(deps, {
              thread,
              usage: withCompactionOffer(deps.db, {
                enabled: isCompactionOfferEnabled(deps, thread.providerId),
                sequenceStart,
                threadId: thread.id,
                usage,
              }),
              sequenceStart,
              now,
            }),
      autoCompaction: getAutoCompactionState(deps, thread, now),
    });
  });

  put(routes.updateAutoCompaction, (context, payload) => {
    const thread = requirePublicThread(deps.db, context.req.param("id"));

    deps.db.transaction(
      (tx) => {
        writeAutoCompactionMetadata(tx, thread.id, {
          ...readAutoCompactionMetadata(tx, thread.id),
          disabled: !payload.enabled,
        });
      },
      { behavior: "immediate" },
    );

    return context.json({ enabled: payload.enabled });
  });

  get(routes.timeline, async (context, query) => {
    let thread = requirePublicThread(deps.db, context.req.param("id"));

    const runtimeId =
      query.runtimeIdentity === "server-v1"
        ? maintenance.getRuntimeId()
        : undefined;

    const page = parseThreadTimelinePage(query);
    const includeNestedRows = query.includeNestedRows === "true";
    const deferContent = query.deferContent === "true";
    const summaryOnly = query.summaryOnly === "true";
    const eventBudget = deps.config.featureFlags.timelineWindowEventBudget;

    const resolveOptions = (current: Thread): BuildThreadTimelineOptions => {
      const settings = getAppSettings(deps.db);

      return {
        compactionOfferEnabled: isCompactionOfferEnabled(
          deps,
          current.providerId,
        ),
        completedTurnDisplay: resolveThreadCompletedTurnDisplay(
          deps,
          settings,
          current.providerId,
        ),
        deferContent,
        eventBudget,
        includeClearedContextHistory: settings.keepHistoryAfterContextClear,
        includeDiagnosticOperations: settings.showDiagnosticEvents,
        includeNestedRows,
        maxInlineOutputChars: DEFAULT_MAX_INLINE_OUTPUT_CHARS,
        page,
        summaryOnly,
        providerDisplayName: resolveThreadProviderDisplayName(
          deps,
          current.providerId,
        ),
        planCommand: resolveProviderPlanCommand(
          deps.providerRegistry,
          current.providerId,
        ),
      };
    };

    const paramsFor = (
      current: Thread,
      options: BuildThreadTimelineOptions,
      snapshot: ReturnType<typeof getThreadTimelineSnapshot>,
    ) => {
      const identity = threadTimelineBuildIdentity(
        deps.db,
        { ...current, status: snapshot.status },
        options,
      );

      return `${TIMELINE_PROJECTION_FORMAT_VERSION}:${options.eventBudget}:${snapshot.historyEpoch}:${identity}:${buildThreadTimelineParamsKey(
        {
          threadId: current.id,
          status: snapshot.status,
          environmentId: current.environmentId,
          providerDisplayName: options.providerDisplayName,
          page,
          includeNestedRows,
          deferContent,
          summaryOnly,
          includeClearedContextHistory: options.includeClearedContextHistory,
          includeDiagnosticOperations: options.includeDiagnosticOperations,
          completedTurnDisplay: options.completedTurnDisplay,
        },
      )}:${getThreadHistoryState(deps.db, current.id).rewriteEpoch}`;
    };

    let selected:
      | {
          response: Awaited<
            ReturnType<typeof buildThreadTimelinePage>
          >["response"];
          paramsKey: string;
        }
      | undefined;

    for (let attempt = 0; attempt < 2; attempt += 1) {
      thread = requirePublicThread(deps.db, thread.id);
      const options = resolveOptions(thread);
      const snapshot = getThreadTimelineSnapshot(deps.db, thread, options);
      const paramsKey = paramsFor(thread, options, snapshot);

      const cached = timelineCache.get(
        thread.id,
        `${snapshot.maxSeq}|${paramsKey}`,
      );

      if (cached !== undefined) {
        selected = { response: cached, paramsKey };
        break;
      }

      const built = await buildThreadTimelinePage(deps.db, {
        threadId: thread.id,
        options,
        signal: context.req.raw.signal,
        priority: query.priority === "background" ? "background" : "foreground",
      });

      touchReadHistory(thread.id, built.cacheTouches);

      const current = () => {
        if (context.req.raw.signal.aborted)
          throw new DOMException("Loading canceled", "AbortError");
        const fresh = requirePublicThread(deps.db, thread.id);

        return (
          built.historyEpoch === getThreadHistoryEpoch(deps.db, thread.id) &&
          built.threadIdentity ===
            threadTimelineBuildIdentity(
              deps.db,
              fresh,
              resolveOptions(fresh),
            ) &&
          (built.expiresAt === null || built.expiresAt > Date.now())
        );
      };

      if (!current()) continue;

      if (!built.fromCache)
        slowTimelineBuildLogger.log({
          profile: built.profile,
          threadId: thread.id,
        });

      if (
        !built.fromCache &&
        built.queries !== undefined &&
        built.queries.length > 0
      )
        deps.logger.info(
          { threadId: thread.id, queries: built.queries },
          "Slow timeline worker SQL",
        );

      if (!current()) continue;
      selected = {
        response: timelineCache.getOrBuild(
          thread.id,
          `${built.response.maxSeq}|${paramsKey}`,
          () => built.response,
          paramsKey,
          built.expiresAt,
        ),
        paramsKey,
      };
      break;
    }

    if (selected === undefined)
      throw new ApiError(
        409,
        "timeline_changed",
        "Chat changed while loading. Try again.",
        true,
      );

    const { response: full, paramsKey } = selected;

    const afterSequence = parseOptionalInteger(
      query.afterSequence,
      "afterSequence",
    );

    const deltaFloor = timelineDeltaFloorByThreadId.get(thread.id);
    const appendMode = query.deltaFormat === "assistant-text-append-v1";

    const snapshotKey = appendMode
      ? `${paramsKey}:assistant-text-append-v1`
      : paramsKey;

    const previous =
      afterSequence === undefined ||
      (runtimeId !== undefined && query.afterRuntimeId !== runtimeId) ||
      (appendMode && query.afterRevision === undefined) ||
      (deltaFloor !== undefined && afterSequence <= deltaFloor)
        ? undefined
        : timelineLatestRowsCache.get(
            thread.id,
            snapshotKey,
            afterSequence,
            appendMode ? query.afterRevision : undefined,
          );

    const delta =
      previous === undefined
        ? undefined
        : computeTimelineRowDelta(
            previous.rows,
            full.rows,
            appendMode && previous.revision !== undefined
              ? { baseRevision: previous.revision }
              : undefined,
          );

    const revision = appendMode ? randomUUID() : undefined;
    const snapshot = { maxSeq: full.maxSeq, rows: full.rows, revision };
    timelineLatestRowsCache.set(thread.id, snapshotKey, snapshot);

    const scheduled =
      full.contextWindowUsage === undefined
        ? full
        : {
            ...full,
            contextWindowUsage: withAutoCompactionAt(deps, {
              thread,
              usage: full.contextWindowUsage,
              sequenceStart: full.contextBoundarySeq ?? 0,
              now: Date.now(),
            }),
          };

    const response =
      delta === undefined ? scheduled : { ...scheduled, rows: [], delta };

    const versioned = appendMode ? { ...response, revision } : response;

    return context.json(
      runtimeId === undefined ? versioned : { ...versioned, runtimeId },
    );
  });

  get(routes.conversation, (context, query) => {
    const thread = requirePublicThread(deps.db, context.req.param("id"));
    const options = resolveConversationRowsOptions(thread);
    const afterSeq = parseOptionalInteger(query.afterSeq, "afterSeq") ?? 0;
    const throughSeq = parseOptionalInteger(query.throughSeq, "throughSeq");

    if (throughSeq !== undefined && throughSeq < afterSeq) {
      throw new ApiError(
        400,
        "invalid_request",
        "throughSeq cannot precede afterSeq",
      );
    }

    return context.json(
      redactThreadHistory(
        deps.db,
        thread.id,
        buildThreadConversationPage(deps.db, thread, {
          ...options,
          maxSeq: Math.min(options.maxSeq, throughSeq ?? options.maxSeq),
          afterSeq,
          limit: parseBoundedPositiveOptionalInteger({
            defaultValue: 20,
            max: 100,
            name: "limit",
            value: query.limit,
          }),
        }),
      ),
    );
  });

  get(routes.conversationOutline, async (context, query) => {
    const id = context.req.param("id");

    for (let attempt = 0; attempt < 2; attempt += 1) {
      const thread = requirePublicThread(deps.db, id);

      const options = {
        ...resolveConversationRowsOptions(thread),
        role: query.role,
      };

      const built = await buildThreadConversationOutlinePage(deps.db, {
        threadId: thread.id,
        options,
        signal: context.req.raw.signal,
      });

      touchReadHistory(thread.id, built.cacheTouches);

      if (context.req.raw.signal.aborted)
        throw new DOMException("Loading canceled", "AbortError");
      const fresh = requirePublicThread(deps.db, id);
      const freshOptions = resolveConversationRowsOptions(fresh);

      if (
        built.maxSeq > freshOptions.maxSeq ||
        built.historyEpoch !== getThreadHistoryEpoch(deps.db, id) ||
        built.historySequenceStart !==
          resolveConversationHistorySequenceStart(
            deps.db,
            fresh,
            freshOptions,
          ) ||
        built.threadIdentity !==
          buildThreadConversationOutlineProjectionKey(fresh, 0, freshOptions)
      )
        continue;

      if (built.queries !== undefined && built.queries.length > 0)
        deps.logger.info(
          { threadId: id, queries: built.queries },
          "Slow outline worker SQL",
        );

      return context.body(built.body, 200, {
        "Content-Type": "application/json; charset=UTF-8",
      });
    }

    throw new ApiError(
      409,
      "timeline_changed",
      "Chat changed while loading. Try again.",
      true,
    );
  });

  get(routes.message, (context, query) => {
    const thread = requirePublicThread(deps.db, context.req.param("id"));
    const seq = context.req.param("seq");

    if (!/^\d+$/.test(seq)) {
      throw new ApiError(
        400,
        "invalid_request",
        "Message seq must be a non-negative integer",
      );
    }

    return context.json(
      redactThreadHistory(
        deps.db,
        thread.id,
        getThreadMessage(deps.db, thread, {
          ...resolveConversationRowsOptions(thread),
          seq: parseInteger(seq, "seq"),
          before: parseOptionalInteger(query.before, "before") ?? 0,
          after: parseOptionalInteger(query.after, "after") ?? 0,
        }),
      ),
    );
  });

  get(routes.timelineTurnSummaryDetails, async (context, query) => {
    const thread = requirePublicThread(deps.db, context.req.param("id"));
    const settings = getAppSettings(deps.db);

    const built = await loadTimelineTurnSummaryDetails(deps.db, {
      threadId: thread.id,
      signal: context.req.raw.signal,
      options: {
        beforeCursor: query.beforeCursor,
        deferContent: query.deferContent === "true",
        itemId: query.itemId ?? null,
        completedTurnDisplay: resolveThreadCompletedTurnDisplay(
          deps,
          settings,
          thread.providerId,
        ),
        includeDiagnosticOperations: settings.showDiagnosticEvents,
        providerDisplayName: resolveThreadProviderDisplayName(
          deps,
          thread.providerId,
        ),
        turnId: query.turnId,
        sourceSeqStart: parseInteger(query.sourceSeqStart, "sourceSeqStart"),
        sourceSeqEnd: parseInteger(query.sourceSeqEnd, "sourceSeqEnd"),
      },
    });

    if (built.queries !== undefined && built.queries.length > 0)
      deps.logger.info(
        { threadId: thread.id, queries: built.queries },
        "Slow turn summary worker SQL",
      );

    return context.body(built.body, 200, {
      "Content-Type": "application/json; charset=UTF-8",
    });
  });

  get(routes.output, (context) => {
    requirePublicThread(deps.db, context.req.param("id"));

    return context.json(
      redactThreadHistory(deps.db, context.req.param("id"), {
        output: getLastThreadOutput(deps.db, context.req.param("id")),
      }),
    );
  });

  get(routes.queuedMessages, (context) => {
    const threadId = context.req.param("id");
    requirePublicThread(deps.db, threadId);

    return context.json(
      redactThreadHistory(
        deps.db,
        threadId,
        listQueuedThreadMessages(deps.db, threadId, {
          includeClaimed: true,
        }).map(toThreadQueuedMessage),
      ),
    );
  });

  get(routes.promptHistory, (context, query) => {
    const threadId = context.req.param("id");
    requirePublicThread(deps.db, threadId);

    const limit = parseBoundedPositiveOptionalInteger({
      defaultValue: PROMPT_HISTORY_ENTRY_LIMIT,
      max: PROMPT_HISTORY_ENTRY_LIMIT,
      name: "limit",
      value: query.limit,
    });

    return context.json(
      redactThreadHistory(
        deps.db,
        threadId,
        listThreadPromptHistory(deps, {
          threadId,
          limit,
        }),
      ),
    );
  });

  get(routes.events, async (context, query) => {
    const threadId = context.req.param("id");
    requirePublicThread(deps.db, threadId);

    const options = {
      afterSeq: parseOptionalInteger(query.afterSeq, "afterSeq"),
      beforeSeq: parseOptionalInteger(query.beforeSeq, "beforeSeq"),
      limit: parseBoundedPositiveOptionalInteger({
        defaultValue: THREAD_EVENT_LIST_PAGE_SIZE,
        max: THREAD_EVENT_LIST_PAGE_SIZE,
        name: "limit",
        value: query.limit,
      }),
      order: query.order,
      types: parseThreadEventTypes(query.types),
    };

    if (options.limit === 1)
      return context.json(
        redactThreadHistory(
          deps.db,
          threadId,
          listThreadEventRows(deps.db, { threadId, ...options }).map(
            redactThreadHistoryEvent,
          ),
          { invalidJsonText: "withhold" },
        ),
      );

    const built = await loadThreadEventListBody(deps.db, {
      threadId,
      options,
      signal: context.req.raw.signal,
    });

    return context.body(built.body, 200, {
      "Content-Type": "application/json; charset=UTF-8",
    });
  });

  get(routes.eventWait, async (context, query) => {
    const threadId = context.req.param("id");
    requirePublicThread(deps.db, threadId);

    const afterSeq = parseOptionalInteger(query.afterSeq, "afterSeq");

    const waitMs = Math.min(
      parseOptionalInteger(query.waitMs, "waitMs") ?? 30_000,
      60_000,
    );

    const parsedEventType = threadEventTypeSchema.safeParse(query.type);

    if (!parsedEventType.success) {
      throw new ApiError(400, "invalid_request", "Invalid event type");
    }

    const eventType = parsedEventType.data;

    const findMatch = () =>
      findThreadEvent(deps.db, { threadId, type: eventType, afterSeq });

    const deadline = Date.now() + waitMs;
    let match = findMatch();

    while (!match) {
      const remaining = deadline - Date.now();

      if (remaining <= 0) break;
      const waiter = deps.hub.registerThreadEventWaiter(threadId, remaining);
      match = findMatch();

      if (match) {
        waiter.cancel();
        break;
      }

      await waiter.promise;
      match = findMatch();
    }

    if (!match) {
      return new Response(null, { status: 204 });
    }

    return context.json(
      redactThreadHistory(deps.db, threadId, redactThreadHistoryEvent(match)),
    );
  });

  get(routes.defaultExecutionOptions, async (context) => {
    const threadId = context.req.param("id");
    requirePublicThread(deps.db, threadId);

    return context.json(
      (
        await tryResolveExistingThreadExecutionPlan(deps, {
          executionSource: "client/turn/requested",
          input: {},
          threadId,
        })
      )?.resolvedExecution ?? null,
    );
  });

  get(routes.storageFiles, async (context, query) => {
    const target = await requireThreadStorageTarget(
      deps,
      context.req.param("id"),
    );

    const limit = parseFileListLimit(query.limit);

    try {
      const result = await callHostRetryableOnlineRpc(deps, {
        hostId: target.hostId,
        timeoutMs: COMMAND_TIMEOUT_MS,
        command: {
          type: "host.list_files",
          followRootSymlink: false,
          path: target.storagePath,
          ...(query.query ? { query: query.query } : {}),
          limit,
          includeHidden: THREAD_STORAGE_PATH_LIST_INCLUDE_HIDDEN,
          respectGitIgnore: false,
          excludeNames: [...DEFAULT_PATH_LIST_EXCLUDE_NAMES],
        },
      });

      return context.json({
        files: result.files,
        truncated: result.truncated,
        storageRootPath: target.storagePath,
      });
    } catch (error) {
      if (error instanceof ApiError && error.body.code === "ENOENT") {
        return context.json({
          files: [],
          truncated: false,
          storageRootPath: target.storagePath,
        });
      }

      throw error;
    }
  });

  get(routes.storageLocation, async (context) => {
    const target = await requireThreadStorageTarget(
      deps,
      context.req.param("id"),
    );

    return context.json({
      hostId: target.hostId,
      storageRootPath: target.storagePath,
    });
  });

  get(routes.storagePaths, async (context, query) => {
    const target = await requireThreadStorageTarget(
      deps,
      context.req.param("id"),
    );

    const limit = parseFileListLimit(query.limit);

    const inclusion = parsePathKindInclusion({
      includeFiles: query.includeFiles,
      includeDirectories: query.includeDirectories,
    });

    try {
      const result = await callHostRetryableOnlineRpc(deps, {
        hostId: target.hostId,
        timeoutMs: COMMAND_TIMEOUT_MS,
        command: {
          type: "host.list_paths",
          path: target.storagePath,
          ...(query.query ? { query: query.query } : {}),
          limit,
          includeFiles: inclusion.includeFiles,
          includeDirectories: inclusion.includeDirectories,
          includeHidden: THREAD_STORAGE_PATH_LIST_INCLUDE_HIDDEN,
          respectGitIgnore: false,
          excludeNames: [...DEFAULT_PATH_LIST_EXCLUDE_NAMES],
        },
      });

      return context.json({
        paths: result.paths,
        truncated: result.truncated,
        storageRootPath: target.storagePath,
      });
    } catch (error) {
      if (error instanceof ApiError && error.body.code === "ENOENT") {
        return context.json({
          paths: [],
          truncated: false,
          storageRootPath: target.storagePath,
        });
      }

      throw error;
    }
  });
}
