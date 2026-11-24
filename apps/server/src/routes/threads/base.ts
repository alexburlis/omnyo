import { observeRunningRead } from "../../services/system/running-read-diagnostics.js";
import { registerThreadGetRoute } from "./get.js";
import { purgeHistoryCacheThread } from "../../services/threads/history-cache-writer.js";
import { findThreadSearchMatchesInWorker } from "../../services/threads/timeline-page-builder.js";
import { countUnarchivedThreadDescendants } from "../../services/threads/thread-archive.js";
import { cancelAbandonedProviderCreations } from "../../services/threads/thread-environment-providers.js";
import {
  THREAD_SEARCH_LIMIT_PER_GROUP_DEFAULT,
  THREAD_SEARCH_LIMIT_PER_GROUP_MAX,
  countNonDeletedAssignedChildThreads,
  countThreads,
  getEnvironment,
  getThread,
  getThreadGroupById,
  getThreadSectionById,
  hydrateThreadSearchMatches,
  listThreadMentionRowsByIds,
  listThreadsWithPendingInteractionState,
  markThreadDeleted,
  listLifecycleThreadTree,
  listNativeSessionClaims,
  listPluginThreadMetadata,
  listThreadAncestors,
  listThreadDescendants,
  updateThread,
  type ThreadSearchResultGroup as DbThreadSearchResultGroup,
  type UpdateThreadInput,
} from "@omnyo/db";
import {
  INBOX_CALLER_PLUGIN_HEADER,
  INBOX_CALLER_THREAD_HEADER,
  type Thread,
  type ThreadListEntry,
} from "@omnyo/domain";
import {
  THREAD_COUNT_ROOT_PARENT,
  publicApiRoutes,
  typedRoutes,
  type ThreadChildSummaryResponse,
  type ThreadCountResponse,
  type PluginThreadMetadataListResponse,
  type ThreadAncestorsListResponse,
  type ThreadDescendantsListResponse,
  type ThreadRunningResponse,
  type ThreadSearchResponse,
  type PublicApiSchema,
  type ResolveThreadMentionsResponse,
  parseThreadListThreadIds,
} from "@omnyo/server-contract";
import type { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import {
  importNativeThread,
  NATIVE_IMPORT_MAX_BODY_BYTES,
} from "../../services/threads/native-import.js";
import type { PluginService } from "../../services/plugins/plugin-service.js";
import type { AppDeps } from "../../types.js";
import { ApiError } from "../../errors.js";
import {
  parseInteger,
  parsePaginationQuery,
} from "../../services/lib/validation.js";
import {
  requireEnvironment,
  requirePublicProject,
  requirePublicThread,
} from "../../services/lib/entity-lookup.js";
import { listRunningThreadsWithIntendedHosts } from "../../services/threads/dispatch-attempt.js";
import { filterRunningThreadsByHost } from "../../services/threads/thread-runtime-display.js";
import { dispatchThreadRenameCommand } from "../../services/threads/thread-commands.js";
import { requestThreadStorageDeletion } from "../../services/threads/thread-lifecycle.js";
import { createThreadFromRequest } from "../../services/threads/thread-create.js";
import {
  acceptSubmission,
  readSubmissionContract,
} from "../../services/threads/submission-accept.js";
import { requestInboxActor } from "../inbox.js";
import { createThreadForkFromRequest } from "../../services/threads/thread-fork.js";
import { requireChildThreadsConfirmation } from "../../services/threads/child-thread-confirmation.js";
import {
  toThreadListEntryResponses,
  toThreadResponseFromThread,
} from "../../services/threads/thread-runtime-display.js";
import { assertValidParentThread } from "../../services/threads/thread-parent.js";
import { handleThreadOwnershipChange } from "../../services/threads/thread-ownership.js";
import { applyThreadExecutionOverride } from "../../services/threads/thread-execution-override.js";
import { setThreadServiceTier } from "../../services/threads/thread-speed.js";
import { applyThreadSessionOptionPatch } from "../../services/threads/thread-session-options.js";
import { emitPluginThreadDeleted } from "../../services/plugins/plugin-thread-events.js";
import { applyGeneratedThreadTitle } from "../../services/threads/title-generation.js";

type ThreadSearchResultGroupResponse = ThreadSearchResponse["active"];

interface BuildThreadSearchGroupResponseArgs {
  group: DbThreadSearchResultGroup;
}

interface BuildThreadSearchResponseArgs {
  active: DbThreadSearchResultGroup;
  archived: DbThreadSearchResultGroup;
}

function launchingThreadId(header: string | undefined): string | null {
  const id = header?.trim();

  return id ? id : null;
}

function countNonWhitespaceChars(value: string): number {
  return value.replaceAll(/\s/gu, "").length;
}

function threadMentionLabel(thread: {
  id: string;
  title: string | null;
  titleFallback: string | null;
}): string {
  if (thread.title && thread.title.trim().length > 0) {
    return thread.title;
  }

  if (thread.titleFallback && thread.titleFallback.trim().length > 0) {
    return thread.titleFallback;
  }

  return `Thread ${thread.id.slice(0, 8)}`;
}

function parseSearchLimitPerGroup(value: string | undefined): number {
  const limit =
    value === undefined
      ? THREAD_SEARCH_LIMIT_PER_GROUP_DEFAULT
      : parseInteger(value, "limitPerGroup");

  if (limit <= 0) {
    throw new ApiError(
      400,
      "invalid_request",
      "limitPerGroup must be positive",
    );
  }

  if (limit > THREAD_SEARCH_LIMIT_PER_GROUP_MAX) {
    throw new ApiError(
      400,
      "invalid_request",
      `limitPerGroup must be at most ${THREAD_SEARCH_LIMIT_PER_GROUP_MAX}`,
    );
  }

  return limit;
}

function requireThreadSection(
  deps: Pick<AppDeps, "db">,
  sectionId: string,
): void {
  if (!getThreadSectionById(deps.db, sectionId)) {
    throw new ApiError(404, "section_not_found", "Section not found");
  }
}

function requireThreadGroup(
  deps: Pick<AppDeps, "db">,
  groupId: string,
  projectId?: string,
): void {
  const group = getThreadGroupById(deps.db, groupId);

  if (!group) {
    throw new ApiError(404, "group_not_found", "Group not found");
  }

  if (projectId !== undefined && group.projectId !== projectId) {
    throw new ApiError(
      400,
      "group_project_mismatch",
      "A group can only hold chats from its own project",
    );
  }
}

function buildThreadSearchGroupResponse(
  deps: AppDeps,
  args: BuildThreadSearchGroupResponseArgs,
): ThreadSearchResultGroupResponse {
  const threadEntries = toThreadListEntryResponses(deps, {
    threads: args.group.results.map((result) => result.thread),
  });

  const threadEntriesById = new Map(
    threadEntries.map((thread) => [thread.id, thread]),
  );

  return {
    total: args.group.total,
    results: args.group.results.flatMap((result) => {
      const thread = threadEntriesById.get(result.thread.id);

      if (thread === undefined) {
        return [];
      }

      return [{ thread, matches: result.matches }];
    }),
  };
}

function buildThreadSearchResponse(
  deps: AppDeps,
  args: BuildThreadSearchResponseArgs,
): ThreadSearchResponse {
  return {
    active: buildThreadSearchGroupResponse(deps, { group: args.active }),
    archived: buildThreadSearchGroupResponse(deps, { group: args.archived }),
  };
}

export function registerThreadBaseRoutes(
  app: Hono,
  deps: AppDeps,
  plugins?: Pick<PluginService, "readThreadBootstrap">,
): void {
  const { get, post, patch, del } = typedRoutes<PublicApiSchema>(app, {
    onValidationError: (msg) => new ApiError(400, "invalid_request", msg),
  });

  const routes = publicApiRoutes.threads;

  get(routes.count, (context, query) => {
    if (query.projectId) {
      requirePublicProject(deps.db, query.projectId);
    }

    const result = countThreads(deps.db, {
      ...(query.status !== undefined ? { status: query.status } : {}),
      ...(query.hostId !== undefined ? { hostId: query.hostId } : {}),
      ...(query.providerId !== undefined
        ? { providerId: query.providerId }
        : {}),
      ...(query.projectId !== undefined ? { projectId: query.projectId } : {}),
      ...(query.parentThreadId === undefined
        ? {}
        : {
            parent:
              query.parentThreadId === THREAD_COUNT_ROOT_PARENT
                ? { kind: "root" as const }
                : {
                    kind: "id" as const,
                    parentThreadId: query.parentThreadId,
                  },
          }),
      ...(query.groupBy !== undefined ? { groupBy: query.groupBy } : {}),
      includeArchived: query.includeArchived === "true",
      includeHidden: query.includeHidden === "true",
    });

    const response: ThreadCountResponse = {
      total: result.total,
      ...(result.groups !== undefined ? { groups: result.groups } : {}),
    };

    return context.json(response);
  });

  post(routes.ancestors, (context, payload) => {
    return context.json({
      threads: listThreadAncestors(deps.db, payload.threadIds),
    } satisfies ThreadAncestorsListResponse);
  });

  post(routes.descendants, (context, payload) => {
    return context.json({
      threads: listThreadDescendants(deps.db, payload.threadIds, {
        includeArchived: payload.includeArchived ?? false,
        includeHidden: payload.includeHidden ?? false,
      }),
    } satisfies ThreadDescendantsListResponse);
  });

  post(routes.pluginMetadata.list, (context, payload) => {
    const { threads, corruptThreadIds } = listPluginThreadMetadata(
      deps.db,
      payload.pluginId,
      payload.threadIds,
    );

    for (const threadId of corruptThreadIds) {
      deps.logger.warn(
        `Ignoring corrupt plugin metadata for thread ${threadId}, plugin ${payload.pluginId}`,
      );
    }

    return context.json({ threads } satisfies PluginThreadMetadataListResponse);
  });

  get(routes.running, (context) => {
    return observeRunningRead(
      context.req,
      () =>
        filterRunningThreadsByHost(
          deps,
          listRunningThreadsWithIntendedHosts(deps),
        ) satisfies ThreadRunningResponse,
      (rows) => context.json(rows),
    );
  });

  get(routes.list, (context, query) => {
    const { limit, offset } = parsePaginationQuery({
      limit: query.limit,
      offset: query.offset,
    });

    if (query.projectId) {
      requirePublicProject(deps.db, query.projectId);
    }

    if (query.sectionId && query.unsectioned === "true") {
      throw new ApiError(
        400,
        "invalid_request",
        "sectionId and unsectioned cannot be used together",
      );
    }

    if (query.sectionId) {
      requireThreadSection(deps, query.sectionId);
    }

    if (query.groupId) {
      requireThreadGroup(deps, query.groupId);
    }

    const threads = listThreadsWithPendingInteractionState(deps.db, {
      ...(query.projectId ? { projectId: query.projectId } : {}),
      ...(query.environmentId ? { environmentId: query.environmentId } : {}),
      ...(query.hostId ? { hostId: query.hostId } : {}),
      ...(query.parentThreadId ? { parentThreadId: query.parentThreadId } : {}),
      ...(query.sourceThreadId ? { sourceThreadId: query.sourceThreadId } : {}),
      ...(query.sectionId ? { sectionId: query.sectionId } : {}),
      ...(query.unsectioned === "true" ? { unsectioned: true } : {}),
      ...(query.groupId ? { groupId: query.groupId } : {}),
      ...(query.originKind ? { originKind: query.originKind } : {}),
      ...(query.originPluginId ? { originPluginId: query.originPluginId } : {}),
      threadIds:
        query.threadIds === undefined
          ? undefined
          : parseThreadListThreadIds(query.threadIds),
      includeHidden: query.includeHidden === "true",
      includePluginHome: query.includePluginHome === "true",
      archived:
        query.archived === undefined ? undefined : query.archived === "true",
      shelved:
        query.shelved === undefined ? undefined : query.shelved === "true",
      hasParent:
        query.hasParent === undefined ? undefined : query.hasParent === "true",
      ...(limit !== undefined ? { limit } : {}),
      ...(offset !== undefined ? { offset } : {}),
    });

    return context.json(
      toThreadListEntryResponses(deps, { threads }) satisfies ThreadListEntry[],
    );
  });

  get(routes.search, async (context, query) => {
    const searchQuery = query.query.trim();

    if (countNonWhitespaceChars(searchQuery) < 2) {
      throw new ApiError(
        400,
        "invalid_request",
        "query must contain at least two non-whitespace characters",
      );
    }

    const matches = await findThreadSearchMatchesInWorker(deps.db, {
      query: searchQuery,
      limitPerGroup: parseSearchLimitPerGroup(query.limitPerGroup),
      signal: context.req.raw.signal,
    });

    return context.json(
      buildThreadSearchResponse(
        deps,
        hydrateThreadSearchMatches(deps.db, matches),
      ) satisfies ThreadSearchResponse,
    );
  });

  post(routes.resolveMentions, (context, payload) => {
    const uniqueThreadIds = [...new Set(payload.threadIds)];

    const rowsById = new Map(
      listThreadMentionRowsByIds(deps.db, uniqueThreadIds).map((thread) => [
        thread.id,
        thread,
      ]),
    );

    const resolved = uniqueThreadIds.flatMap((threadId) => {
      const thread = rowsById.get(threadId);

      if (thread === undefined) {
        return [];
      }

      return [
        {
          threadId: thread.id,
          projectId: thread.projectId,
          label: threadMentionLabel(thread),
        },
      ];
    });

    return context.json(resolved satisfies ResolveThreadMentionsResponse);
  });

  get(routes.submissionContract, (context) =>
    context.json(readSubmissionContract(deps)),
  );

  post(routes.submit, async (context, payload) => {
    if (
      payload.action.kind === "new-thread" &&
      payload.action.thread.sectionId
    ) {
      requireThreadSection(deps, payload.action.thread.sectionId);
    }

    const receipt = await acceptSubmission(deps, {
      actor: requestInboxActor(context),
      launchedByThreadId: launchingThreadId(
        context.req.header(INBOX_CALLER_THREAD_HEADER),
      ),
      request: payload,
    });

    return context.json(receipt);
  });

  post(routes.create, async (context, payload) => {
    if (payload.sectionId) {
      requireThreadSection(deps, payload.sectionId);
    }

    const launchedByThreadId = launchingThreadId(
      context.req.header(INBOX_CALLER_THREAD_HEADER),
    );

    const callerPluginId =
      context.req.header(INBOX_CALLER_PLUGIN_HEADER)?.trim() || null;

    const thread = await createThreadFromRequest(deps, {
      ...payload,
      origin: payload.origin,
      callerPluginId,
      ...(launchedByThreadId === null ? {} : { launchedByThreadId }),
    });

    return context.json(toThreadResponseFromThread(deps, { thread }), 201);
  });

  post(routes.fork, async (context, payload) => {
    const thread = await createThreadForkFromRequest(
      deps,
      payload,
      launchingThreadId(context.req.header(INBOX_CALLER_THREAD_HEADER)),
    );

    return context.json(toThreadResponseFromThread(deps, { thread }), 201);
  });

  app.post(
    routes.importNative.path,
    bodyLimit({
      maxSize: NATIVE_IMPORT_MAX_BODY_BYTES,
      onError: () => {
        throw new ApiError(
          413,
          "invalid_request",
          "Imported chat exceeds the 32MB limit",
        );
      },
    }),
  );
  post(routes.importNative, async (context, payload) => {
    const result = await importNativeThread(deps, payload);

    return result.kind === "imported"
      ? context.json(result, 201)
      : context.json(result, 200);
  });

  get(routes.nativeSessions, (context, query) =>
    context.json({ claimed: listNativeSessionClaims(deps.db, query) }),
  );

  registerThreadGetRoute(app, deps, plugins);

  function getThreadChildSummary(thread: Thread): ThreadChildSummaryResponse {
    const nonDeletedChildCount = countNonDeletedAssignedChildThreads(deps.db, {
      parentThreadId: thread.id,
    });

    return {
      nonDeletedChildCount,
      unarchivedDescendantCount: countUnarchivedThreadDescendants(
        deps.db,
        thread,
      ),
    };
  }

  get(routes.childSummary, (context) => {
    const thread = requirePublicThread(deps.db, context.req.param("id"));

    return context.json(getThreadChildSummary(thread));
  });

  patch(routes.update, async (context, payload) => {
    const thread = requirePublicThread(deps.db, context.req.param("id"));

    if (payload.experimental_titleIfUntitled) {
      if (context.req.raw.signal.aborted) {
        return Response.json(
          {
            code: "request_cancelled",
            message: "The title request was cancelled",
          },
          { status: 499 },
        );
      }

      if (payload.title === null || payload.title === undefined) {
        throw new ApiError(
          400,
          "invalid_request",
          "A conditional title is required",
        );
      }

      const applied = applyGeneratedThreadTitle(deps, {
        threadId: thread.id,
        title: payload.title,
      });

      const current = requirePublicThread(deps.db, thread.id);

      return context.json({
        ...toThreadResponseFromThread(deps, { thread: current }),
        experimental_titleApplied: applied,
      });
    }

    if (payload.parentThreadId) {
      assertValidParentThread(deps, {
        childThreadId: thread.id,
        parentThreadId: payload.parentThreadId,
      });
    }

    if ("model" in payload || "reasoningLevel" in payload) {
      await applyThreadExecutionOverride(deps, {
        thread,
        patch: {
          ...("model" in payload ? { model: payload.model } : {}),
          ...("reasoningLevel" in payload
            ? { reasoningLevel: payload.reasoningLevel }
            : {}),
        },
      });
    }

    if (payload.serviceTier !== undefined) {
      await setThreadServiceTier(deps, thread, payload.serviceTier);
    }

    if (payload.sessionOptions !== undefined) {
      applyThreadSessionOptionPatch(deps, {
        thread,
        patch: payload.sessionOptions,
      });
    }

    const metadataUpdate: UpdateThreadInput = {};

    if ("title" in payload) {
      metadataUpdate.title = payload.title;
    }

    const sectionId = payload.sectionId;

    if (sectionId !== undefined) {
      if (sectionId !== null) {
        requireThreadSection(deps, sectionId);
      }

      metadataUpdate.sectionId = sectionId;
    } else if (
      payload.parentThreadId === null &&
      thread.parentThreadId !== null
    ) {
      metadataUpdate.sectionId =
        getThread(deps.db, thread.parentThreadId)?.sectionId ?? null;
    }

    if (payload.groupId !== undefined) {
      if (payload.groupId !== null) {
        requireThreadGroup(deps, payload.groupId, thread.projectId);
      }

      metadataUpdate.groupId = payload.groupId;
    }

    if ("parentThreadId" in payload) {
      metadataUpdate.parentThreadId = payload.parentThreadId;
    }

    if ("visibility" in payload) {
      metadataUpdate.visibility = payload.visibility;
    }

    if (payload.experimental_pluginHome !== undefined) {
      const callerPluginId =
        context.req.header(INBOX_CALLER_PLUGIN_HEADER)?.trim() || null;

      const ownsChat =
        callerPluginId !== null && thread.originPluginId === callerPluginId;

      if (
        payload.experimental_pluginHome
          ? !ownsChat
          : !ownsChat && callerPluginId !== null
      ) {
        throw new ApiError(
          403,
          "plugin_required",
          payload.experimental_pluginHome
            ? "Only the plugin that created this chat can make it its home chat"
            : "Only the owner or the plugin that created this chat can clear its home flag",
        );
      }

      metadataUpdate.pluginHome = payload.experimental_pluginHome;
    }

    const patched =
      Object.keys(metadataUpdate).length > 0
        ? updateThread(deps.db, deps.hub, thread.id, metadataUpdate)
        : requirePublicThread(deps.db, thread.id);

    if (!patched) {
      throw new ApiError(404, "thread_not_found", "Thread not found");
    }

    const reparented =
      patched.parentThreadId !== null &&
      patched.parentThreadId !== thread.parentThreadId;

    const updated = reparented
      ? requirePublicThread(deps.db, patched.id)
      : patched;

    if (
      payload.title &&
      payload.title !== thread.title &&
      updated.environmentId
    ) {
      const environment = requireEnvironment(deps.db, updated.environmentId);

      if (environment.status === "ready" && environment.path) {
        dispatchThreadRenameCommand(deps, {
          environment: {
            id: environment.id,
            hostId: environment.hostId,
          },
          providerId: updated.providerId,
          threadId: updated.id,
          title: payload.title,
        });
      }
    }

    if (
      "parentThreadId" in payload &&
      payload.parentThreadId !== thread.parentThreadId
    ) {
      await handleThreadOwnershipChange(deps, {
        previousThread: thread,
        updatedThread: updated,
      });
    }

    return context.json(toThreadResponseFromThread(deps, { thread: updated }));
  });

  del(routes.delete, async (context, payload) => {
    const thread = requirePublicThread(deps.db, context.req.param("id"));
    requireChildThreadsConfirmation({
      action: "delete",
      confirmed: payload.childThreadsConfirmed,
      deps,
      thread,
    });
    const dependents = listLifecycleThreadTree(deps.db, thread.id);
    markThreadDeleted(deps.db, deps.hub, { threadId: thread.id });

    for (const [index, dependent] of dependents.entries()) {
      if (index > 0)
        await new Promise<void>((resolve) => setImmediate(resolve));
      const deleted = getThread(deps.db, dependent.id);

      if (!deleted) continue;

      if (dependent.deletedAt === null) emitPluginThreadDeleted(deleted);
      cancelAbandonedProviderCreations(deps, deleted.id);
      deps.terminalSessions.closeDeletedThreadTerminals({
        threadId: deleted.id,
      });
      requestThreadStorageDeletion(
        deps,
        deleted,
        deleted.environmentId === null
          ? null
          : getEnvironment(deps.db, deleted.environmentId),
      );
    }

    for (const dependent of dependents)
      await purgeHistoryCacheThread(deps.db, dependent.id);

    return context.json({ ok: true });
  });
}
