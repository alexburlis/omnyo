import {
  listActiveVisiblePinnedThreadRootsWithPendingInteractionState,
  pinThread,
  listShelvedThreadRootsWithPendingInteractionState,
  reorderPinnedThread,
  reorderQueuedThreadMessage,
  reorderShelvedThread,
  setQueuedThreadMessageGroupBoundary,
  shelveThreadFamily,
  unpinThread,
  unshelveThreadFamily,
  updateQueuedThreadMessage,
  updateThread,
  type ReorderPinnedThreadResult,
  type ReorderQueuedThreadMessageResult,
  type ReorderShelvedThreadResult,
  type SetQueuedThreadMessageGroupBoundaryResult,
  type ShelveThreadFamilyResult,
} from "@omnyo/db";
import {
  publicApiRoutes,
  typedRoutes,
  type ThreadListResponse,
  type PublicApiSchema,
} from "@omnyo/server-contract";
import type { Hono } from "hono";
import { type ThreadQueuedMessage } from "@omnyo/domain";
import type { AppDeps } from "../../types.js";
import { ApiError } from "../../errors.js";
import { acknowledgeOwnerMessageNow, requestInboxActor } from "../inbox.js";
import { createHash } from "node:crypto";
import { INBOX_FOR_TEXT_MAX } from "@omnyo/domain";
import type { SendMessageRequest } from "@omnyo/server-contract";
import { registerWait } from "../../services/inbox/waits.js";
import {
  archiveRootViaInbox,
  proposeShelve,
  unattendedArchiveRefusal,
} from "../../services/inbox/actions.js";
import {
  getInboxThread,
  isInboxDomainRoot,
} from "../../services/inbox/family.js";
import {
  deleteQueuedMessageForThread,
  restoreQueuedMessageForThread,
} from "../../services/threads/deleted-queued-messages.js";
import { toThreadQueuedMessage } from "../../services/threads/thread-queued-messages.js";
import { retryFailedTurn } from "../../services/threads/turn-retry.js";
import {
  continueAllThreads,
  continueThread,
  getThreadContinueState,
  listThreadContinuations,
} from "../../services/threads/thread-continue.js";
import {
  requireConnectedHostSession,
  requirePublicThread,
} from "../../services/lib/entity-lookup.js";
import { parseSafeRelativeRoutePath } from "../relative-route-path.js";
import { resolvePromptAttachmentReferences } from "../../services/projects/attachments.js";
import {
  compactThreadContext,
  threadTargetHostId,
} from "../../services/threads/dispatch-attempt.js";
import {
  createQueuedMessageForThread,
  holdQueuedMessageForEdit,
  releaseQueuedMessageEditHold,
  requestEditReleasedQueuedMessageDispatch,
  sendQueuedMessageNow,
} from "../../services/threads/queued-messages.js";
import {
  ensureThreadIsNotAwaitingUserInteraction,
  ensureThreadIsWritable,
  ensureThreadQueueIsWritable,
} from "../../services/threads/thread-send.js";
import { acceptThreadSendRequest } from "../../services/threads/thread-send-request.js";
import { editThreadMessage } from "../../services/threads/thread-edit-message.js";
import { clearThreadContext } from "../../services/threads/thread-context-clear.js";
import {
  buildExecutionOptions,
  prepareTurnSubmitCommandPayload,
} from "../../services/threads/thread-commands.js";
import { stopThreadForCurrentState } from "../../services/threads/thread-lifecycle.js";
import {
  buildThreadStatusChangeMetadata,
  getThreadPromptBannerActivity,
  toThreadListEntryResponses,
  toThreadResponseFromThread,
} from "../../services/threads/thread-runtime-display.js";
import {
  resolveThreadEnvironmentRestore,
  throwThreadEnvironmentRestoreRefusal,
} from "../../services/threads/thread-environment-restore.js";
import {
  listWaitingStartMachines,
  moveWaitingThreadStart,
} from "../../services/threads/thread-start-move.js";
import {
  requestThreadEnvironmentRestore,
  scheduleThreadProvisioningAdvance,
} from "../../services/threads/thread-provisioning.js";
import {
  archiveThreadAndChildren,
  unarchiveThreadWithLifecycleEffects,
} from "../../services/threads/thread-archive.js";
import {
  requireThreadCommandEnvironment,
  requireThreadHostCommandEnvironment,
  resolveThreadHostCommandEnvironment,
} from "../../services/threads/thread-command-environment.js";
import {
  LIVE_DAEMON_COMMAND_TIMEOUT_MS,
  runLiveHostCommand,
} from "../../services/hosts/live-command.js";

function toQueuedMessageOrderResponse(
  result: ReorderQueuedThreadMessageResult,
): ThreadQueuedMessage[] {
  switch (result.kind) {
    case "reordered":
    case "unchanged":
      return result.queuedMessages.map(toThreadQueuedMessage);
    case "not_found":
      throw new ApiError(404, "invalid_request", "Queued message not found");
    case "claimed":
      throw new ApiError(
        409,
        "invalid_request",
        "Queued message is already being sent",
      );
    case "stale_neighbor":
      throw new ApiError(
        409,
        "invalid_request",
        "Queued message order changed",
      );
    case "invalid_neighbor_order":
      throw new ApiError(
        409,
        "invalid_request",
        "Queued message order is invalid",
      );
    case "invalid_sender":
      throw new ApiError(
        409,
        "invalid_request",
        "Queued messages from different senders cannot be grouped",
      );
    case "invalid_execution_options":
      throw new ApiError(
        409,
        "invalid_request",
        "Queued messages with different execution options cannot be grouped",
      );
  }
}

function toQueuedMessageGroupBoundaryResponse(
  result: SetQueuedThreadMessageGroupBoundaryResult,
): ThreadQueuedMessage[] {
  switch (result.kind) {
    case "updated":
    case "unchanged":
      return result.queuedMessages.map(toThreadQueuedMessage);
    case "not_found":
      throw new ApiError(404, "invalid_request", "Queued message not found");
    case "claimed":
      throw new ApiError(
        409,
        "invalid_request",
        "Queued message is already being sent",
      );
    case "stale_neighbor":
      throw new ApiError(
        409,
        "invalid_request",
        "Queued message order changed",
      );
    case "invalid_sender":
      throw new ApiError(
        409,
        "invalid_request",
        "Queued messages from different senders cannot be grouped",
      );
    case "invalid_execution_options":
      throw new ApiError(
        409,
        "invalid_request",
        "Queued messages with different execution options cannot be grouped",
      );
  }
}

function buildActivePinnedThreadRootListResponse(
  deps: AppDeps,
): ThreadListResponse {
  return toThreadListEntryResponses(deps, {
    threads: listActiveVisiblePinnedThreadRootsWithPendingInteractionState(
      deps.db,
    ),
  });
}

function assertPinnedThreadOrderResult(
  result: ReorderPinnedThreadResult,
): void {
  switch (result.kind) {
    case "reordered":
    case "unchanged":
      return;
    case "not_found":
      throw new ApiError(404, "thread_not_found", "Thread not found");
    case "not_pinned":
      throw new ApiError(409, "invalid_request", "Thread is not pinned");
    case "stale_neighbor":
      throw new ApiError(409, "invalid_request", "Pinned thread order changed");
    case "invalid_neighbor_order":
      throw new ApiError(
        409,
        "invalid_request",
        "Pinned thread order is invalid",
      );
  }
}

function assertShelvedThreadOrderResult(
  result: ReorderShelvedThreadResult,
): void {
  switch (result.kind) {
    case "reordered":
    case "unchanged":
      return;
    case "not_found":
      throw new ApiError(404, "thread_not_found", "Thread not found");
    case "not_shelved":
      throw new ApiError(
        409,
        "invalid_request",
        "Only top-level threads on the Shelf can be reordered",
      );
    case "stale_neighbor":
      throw new ApiError(409, "invalid_request", "Shelf order changed");
    case "invalid_neighbor_order":
      throw new ApiError(409, "invalid_request", "Shelf order is invalid");
  }
}

function requireShelvedThread(result: ShelveThreadFamilyResult) {
  switch (result.kind) {
    case "shelved":
      return result.thread;
    case "not_found":
      throw new ApiError(404, "thread_not_found", "Thread not found");
    case "not_top_level":
      throw new ApiError(
        409,
        "shelve_requires_top_level",
        "Only top-level threads can be shelved",
      );
    case "archived":
      throw new ApiError(
        409,
        "thread_archived",
        "Archived threads cannot be shelved",
      );
  }
}

export function registerThreadActionRoutes(app: Hono, deps: AppDeps): void {
  const { get, post, patch, del } = typedRoutes<PublicApiSchema>(app, {
    onValidationError: (msg) => new ApiError(400, "invalid_request", msg),
  });

  const routes = publicApiRoutes.threads;

  get(routes.continuationState, (context) =>
    context.json(
      getThreadContinueState(
        deps,
        requirePublicThread(deps.db, context.req.param("id")),
      ),
    ),
  );
  get(routes.continuations, (context) =>
    context.json(listThreadContinuations(deps)),
  );
  post(routes.continue, async (context, query) => {
    requirePublicThread(deps.db, context.req.param("id"));

    return context.json(
      await continueThread(deps, context.req.param("id"), {
        now: query.now === "true",
        model: query.model,
      }),
    );
  });
  post(routes.continueAll, async (context) =>
    context.json(await continueAllThreads(deps)),
  );

  post(routes.send, async (context, payload) => {
    const thread = requirePublicThread(deps.db, context.req.param("id"));
    const actor = requestInboxActor(context);

    const fromSelf =
      payload.senderThreadId === undefined ||
      payload.senderThreadId === null ||
      payload.senderThreadId === thread.id;

    if (actor.kind === "owner" && fromSelf)
      acknowledgeOwnerMessageNow(deps, thread.id);

    if (
      actor.kind === "thread" &&
      actor.threadId === thread.id &&
      payload.sendAt !== undefined &&
      payload.sendAt > Date.now()
    )
      return context.json(scheduleSelfCheck(deps, thread.id, payload));

    const attributed =
      fromSelf && payload.messageSource === undefined && actor.kind !== "owner"
        ? {
            ...payload,
            messageSource: {
              kind: "script" as const,
              label: actor.kind === "automation" ? "Automation" : "This chat",
            },
          }
        : payload;

    return context.json(
      await acceptThreadSendRequest(deps, { payload: attributed, thread }),
    );
  });

  post(routes.editMessage, async (context, payload) => {
    const thread = requirePublicThread(deps.db, context.req.param("id"));

    const environment = await requireThreadCommandEnvironment(deps, {
      thread,
    });

    const result = await editThreadMessage(deps, {
      environment,
      payload,
      thread,
    });

    return context.json(result);
  });

  post(routes.retry, async (context, payload) => {
    const thread = requirePublicThread(deps.db, context.req.param("id"));
    ensureThreadIsWritable(thread);

    const result = await retryFailedTurn(deps, {
      request: payload,
      thread,
      actor: requestInboxActor(context),
    });

    return context.json(result);
  });

  post(routes.createQueuedMessage, async (context, payload) => {
    const thread = requirePublicThread(deps.db, context.req.param("id"));

    const queuedMessage = await createQueuedMessageForThread(deps, {
      payload,
      thread,
    });

    return context.json(queuedMessage, 201);
  });

  post(routes.sendQueuedMessage, async (context, payload) => {
    const thread = requirePublicThread(deps.db, context.req.param("id"));
    ensureThreadQueueIsWritable(thread);
    ensureThreadIsNotAwaitingUserInteraction(deps, thread.id);

    const result = await sendQueuedMessageNow(deps, {
      queuedMessageId: context.req.param("queuedMessageId"),
      mode: payload.mode,
      requestId: payload.requestId,
      threadId: context.req.param("id"),
      overrideFailures: true,
    });

    return context.json({ ok: true, ...result });
  });

  patch(routes.reorderQueuedMessage, (context, payload) => {
    const thread = requirePublicThread(deps.db, context.req.param("id"));
    ensureThreadQueueIsWritable(thread);

    return context.json(
      toQueuedMessageOrderResponse(
        reorderQueuedThreadMessage({
          db: deps.db,
          notifier: deps.hub,
          threadId: thread.id,
          queuedMessageId: context.req.param("queuedMessageId"),
          previousQueuedMessageId: payload.previousQueuedMessageId,
          nextQueuedMessageId: payload.nextQueuedMessageId,
          groupBoundaryQueuedMessageId: payload.groupBoundaryQueuedMessageId,
        }),
      ),
    );
  });

  patch(routes.setQueuedMessageGroupBoundary, (context, payload) => {
    const thread = requirePublicThread(deps.db, context.req.param("id"));
    ensureThreadQueueIsWritable(thread);

    return context.json(
      toQueuedMessageGroupBoundaryResponse(
        setQueuedThreadMessageGroupBoundary({
          db: deps.db,
          notifier: deps.hub,
          threadId: thread.id,
          expectedGroupedPrefixQueuedMessageIds:
            payload.expectedGroupedPrefixQueuedMessageIds,
          groupBoundaryQueuedMessageId: payload.groupBoundaryQueuedMessageId,
        }),
      ),
    );
  });

  patch(routes.updateQueuedMessage, async (context, payload) => {
    const thread = requirePublicThread(deps.db, context.req.param("id"));
    ensureThreadQueueIsWritable(thread);

    const input = await resolvePromptAttachmentReferences({
      db: deps.db,
      dataDir: deps.config.dataDir,
      input: payload.input,
      projectId: thread.projectId,
      hostId: threadTargetHostId(deps, thread),
    });

    const changesExecution =
      payload.model !== undefined ||
      payload.serviceTier !== undefined ||
      payload.reasoningLevel !== undefined ||
      payload.permissionMode !== undefined;

    const execution = changesExecution
      ? await buildExecutionOptions(deps, payload, { threadId: thread.id })
      : null;

    const result = updateQueuedThreadMessage(deps.db, deps.hub, {
      content: input,
      execution:
        execution === null
          ? null
          : {
              model: execution.model,
              permissionMode: execution.permissionMode,
              reasoningLevel: execution.reasoningLevel,
              serviceTier: execution.serviceTier,
            },
      expectedUpdatedAt: payload.expectedUpdatedAt,
      id: context.req.param("queuedMessageId"),
      threadId: thread.id,
    });

    if (result.kind === "not_found") {
      throw new ApiError(404, "invalid_request", "Queued message not found");
    }

    if (result.kind === "claimed") {
      throw new ApiError(
        409,
        "invalid_request",
        "Queued message is already being sent",
      );
    }

    if (result.kind === "stale") {
      throw new ApiError(
        409,
        "invalid_request",
        "Queued message changed since editing began",
      );
    }

    if (result.releasedEditHold) {
      requestEditReleasedQueuedMessageDispatch(deps, {
        queuedMessageId: result.queuedMessage.id,
        threadId: thread.id,
      });
    }

    return context.json(toThreadQueuedMessage(result.queuedMessage));
  });

  post(routes.holdQueuedMessageForEdit, (context) => {
    const thread = requirePublicThread(deps.db, context.req.param("id"));
    ensureThreadQueueIsWritable(thread);

    return context.json(
      holdQueuedMessageForEdit(deps, {
        queuedMessageId: context.req.param("queuedMessageId"),
        threadId: thread.id,
      }),
    );
  });

  del(routes.releaseQueuedMessageEditHold, (context) => {
    const thread = requirePublicThread(deps.db, context.req.param("id"));
    releaseQueuedMessageEditHold(deps, {
      queuedMessageId: context.req.param("queuedMessageId"),
      threadId: thread.id,
    });

    return context.json({ ok: true });
  });

  del(routes.deleteQueuedMessage, (context) => {
    deleteQueuedMessageForThread(deps, {
      queuedMessageId: context.req.param("queuedMessageId"),
      actor: requestInboxActor(context),
      threadId: context.req.param("id"),
    });

    return context.json({ ok: true });
  });

  post(routes.restoreQueuedMessage, (context) => {
    const thread = requirePublicThread(deps.db, context.req.param("id"));

    return context.json(
      restoreQueuedMessageForThread(deps, {
        queuedMessageId: context.req.param("queuedMessageId"),
        thread,
      }),
    );
  });

  post(routes.stop, async (context) => {
    const thread = requirePublicThread(deps.db, context.req.param("id"));

    const environment = resolveThreadHostCommandEnvironment({
      db: deps.db,
      thread,
    });

    await stopThreadForCurrentState(deps, thread, environment);

    return context.json({ ok: true });
  });

  post(routes.compact, async (context) => {
    const thread = requirePublicThread(deps.db, context.req.param("id"));
    await compactThreadContext(deps, thread);

    return context.json({ ok: true });
  });

  post(routes.clearContext, async (context) => {
    const thread = requirePublicThread(deps.db, context.req.param("id"));
    const environment = await requireThreadCommandEnvironment(deps, { thread });
    await clearThreadContext(deps, { environment, thread });

    return context.json({ ok: true });
  });

  post(routes.cancelPlan, async (context) => {
    const thread = requirePublicThread(deps.db, context.req.param("id"));
    const activity = getThreadPromptBannerActivity(deps, thread);

    if (activity.activePlanModeCount === 0) {
      throw new ApiError(409, "invalid_request", "Plan mode is not active");
    }

    if (activity.activePlanTurnId === null) {
      throw new ApiError(
        409,
        "invalid_request",
        "The active Plan turn could not be identified",
      );
    }

    const environment = requireThreadHostCommandEnvironment({
      db: deps.db,
      thread,
    });

    await runLiveHostCommand(deps, {
      command: {
        type: "thread.plan.cancel",
        environmentId: environment.id,
        threadId: thread.id,
        expectedTurnId: activity.activePlanTurnId,
      },
      hostId: environment.hostId,
      timeoutMs: LIVE_DAEMON_COMMAND_TIMEOUT_MS,
    });
    const updatedThread = requirePublicThread(deps.db, thread.id);

    if (
      getThreadPromptBannerActivity(deps, updatedThread).activePlanModeCount > 0
    ) {
      throw new ApiError(
        409,
        "invalid_request",
        "The provider did not confirm that Plan mode exited",
      );
    }

    return context.json({ ok: true });
  });

  post(routes.clearGoal, async (context) => {
    const thread = requirePublicThread(deps.db, context.req.param("id"));
    const activity = getThreadPromptBannerActivity(deps, thread);

    if (activity.activeGoalCount === 0) {
      throw new ApiError(409, "invalid_request", "No active Goal to clear");
    }

    const environment = await requireThreadCommandEnvironment(deps, {
      thread,
    });

    requireConnectedHostSession(deps, environment.hostId);

    const execution = await buildExecutionOptions(
      deps,
      {},
      { threadId: thread.id },
    );

    const preparedRuntimeCommand = await prepareTurnSubmitCommandPayload(deps, {
      environment,
      execution,
      input: [],
      permissionEscalation: "deny",
      target: { mode: "auto", expectedTurnId: null },
      thread,
    });

    const result = await runLiveHostCommand(deps, {
      command: {
        type: "thread.goal.clear",
        environmentId: environment.id,
        threadId: thread.id,
        options: preparedRuntimeCommand.options,
        resumeContext: preparedRuntimeCommand.resumeContext,
        bridgeLaunch: preparedRuntimeCommand.bridgeLaunch,
      },
      hostId: environment.hostId,
      timeoutMs: LIVE_DAEMON_COMMAND_TIMEOUT_MS,
    });

    const updatedThread = requirePublicThread(deps.db, thread.id);
    const updatedActivity = getThreadPromptBannerActivity(deps, updatedThread);

    if (updatedActivity.activeGoalCount > 0 && !result.cleared) {
      throw new ApiError(
        409,
        "invalid_request",
        "The provider did not clear the active Goal",
      );
    }

    if (updatedActivity.activeGoalCount > 0) {
      throw new ApiError(
        409,
        "invalid_request",
        "The provider did not confirm that the active Goal was cleared",
      );
    }

    return context.json({ ok: true });
  });

  post(routes.open, (context, payload) => {
    const publicThread = requirePublicThread(deps.db, context.req.param("id"));

    if (payload.file !== null) {
      parseSafeRelativeRoutePath(payload.file.path);
    }

    const delivered = deps.hub.notifyThreadOpen(
      { projectId: publicThread.projectId, threadId: publicThread.id },
      { split: payload.split ?? "replace", file: payload.file },
    );

    return context.json({ delivered });
  });

  post(routes.paneAction, (context, payload) => {
    const publicThread = requirePublicThread(deps.db, context.req.param("id"));

    const delivered = deps.hub.notifyThreadPaneAction(
      { projectId: publicThread.projectId, threadId: publicThread.id },
      payload.action,
    );

    return context.json({ delivered });
  });

  post(routes.pin, (context) => {
    const publicThread = requirePublicThread(deps.db, context.req.param("id"));

    const thread = pinThread(deps.db, deps.hub, {
      threadId: publicThread.id,
    });

    if (!thread) {
      throw new ApiError(404, "thread_not_found", "Thread not found");
    }

    return context.json(toThreadResponseFromThread(deps, { thread }));
  });

  post(routes.unpin, (context) => {
    const publicThread = requirePublicThread(deps.db, context.req.param("id"));

    const thread = unpinThread(deps.db, deps.hub, {
      threadId: publicThread.id,
    });

    if (!thread) {
      throw new ApiError(404, "thread_not_found", "Thread not found");
    }

    return context.json(toThreadResponseFromThread(deps, { thread }));
  });

  patch(routes.pinOrder, (context, payload) => {
    const thread = requirePublicThread(deps.db, context.req.param("id"));
    assertPinnedThreadOrderResult(
      reorderPinnedThread({
        db: deps.db,
        notifier: deps.hub,
        threadId: thread.id,
        previousThreadId: payload.previousThreadId,
        nextThreadId: payload.nextThreadId,
      }),
    );

    return context.json(buildActivePinnedThreadRootListResponse(deps));
  });

  post(routes.shelve, (context) => {
    const publicThread = requirePublicThread(deps.db, context.req.param("id"));

    refuseUnlessOwner(deps, context, publicThread.id, "shelve");

    const thread = requireShelvedThread(
      shelveThreadFamily(deps.db, deps.hub, { threadId: publicThread.id }),
    );

    return context.json(toThreadResponseFromThread(deps, { thread }));
  });

  post(routes.unshelve, (context) => {
    const publicThread = requirePublicThread(deps.db, context.req.param("id"));

    refuseUnlessOwner(deps, context, publicThread.id, "unshelve");
    unshelveThreadFamily(deps.db, deps.hub, { threadId: publicThread.id });

    return context.json(
      toThreadResponseFromThread(deps, {
        thread: requirePublicThread(deps.db, publicThread.id),
      }),
    );
  });

  patch(routes.shelfOrder, (context, payload) => {
    const thread = requirePublicThread(deps.db, context.req.param("id"));

    refuseUnlessOwner(deps, context, thread.id, "reorder-shelf");
    assertShelvedThreadOrderResult(
      reorderShelvedThread({
        db: deps.db,
        notifier: deps.hub,
        threadId: thread.id,
        previousThreadId: payload.previousThreadId,
        nextThreadId: payload.nextThreadId,
      }),
    );

    return context.json(
      toThreadListEntryResponses(deps, {
        threads: listShelvedThreadRootsWithPendingInteractionState(deps.db, [
          thread.id,
        ]),
      }),
    );
  });

  post(routes.archiveAll, (context) => {
    const thread = requirePublicThread(deps.db, context.req.param("id"));
    const actor = requestInboxActor(context);

    if (thread.archivedAt !== null || !isInboxRootThread(deps, thread.id))
      return context.json({
        ok: true,
        archivedThreadIds: archiveThreadAndChildren(deps, {
          parentThread: thread,
        }),
      });

    refuseUnlessOwner(deps, context, thread.id, "archive");

    if (actor.kind !== "owner") {
      const refusal = unattendedArchiveRefusal(deps, thread.id, Date.now());

      if (refusal !== null) throw new ApiError(409, "archive_refused", refusal);
    }

    return context.json({
      ok: true,
      archivedThreadIds: archiveRootViaInbox(deps, {
        rootId: thread.id,
        displayed: "all",
        stopRunning: true,
        now: Date.now(),
      }).archivedThreadIds,
    });
  });

  post(routes.unarchive, (context) => {
    const thread = requirePublicThread(deps.db, context.req.param("id"));

    if (unarchiveThreadWithLifecycleEffects(deps, thread) === "owner-archived")
      throw new ApiError(
        409,
        "invalid_request",
        "Lifecycle owner must be unarchived first",
      );

    return context.json({ ok: true });
  });

  get(routes.startMachines, async (context, query) => {
    const thread = requirePublicThread(deps.db, context.req.param("id"));

    return context.json(
      await listWaitingStartMachines(deps, {
        threadId: thread.id,
        initiator:
          query.pluginId === undefined
            ? { kind: "person" }
            : { kind: "plugin", pluginId: query.pluginId },
      }),
    );
  });

  post(routes.startMachine, async (context, payload) => {
    const thread = requirePublicThread(deps.db, context.req.param("id"));
    ensureThreadIsWritable(thread);

    return context.json(
      await moveWaitingThreadStart(deps, {
        threadId: thread.id,
        hostId: payload.hostId,
        expectedHostId: payload.expectedHostId,
        initiator: payload.initiator,
        ...(payload.note === undefined ? {} : { note: payload.note }),
      }),
    );
  });

  post(routes.restoreEnvironment, (context) => {
    const thread = requirePublicThread(deps.db, context.req.param("id"));
    ensureThreadIsWritable(thread);
    const resolution = resolveThreadEnvironmentRestore(deps, { thread });

    if (!resolution.restorable) {
      throwThreadEnvironmentRestoreRefusal(resolution.refusal, thread);
    }

    const started = requestThreadEnvironmentRestore(deps, {
      environment: resolution.target.environment,
      provider: {
        environmentProviderId: resolution.target.environmentProviderId,
        selection: resolution.target.selection,
      },
      thread,
    });

    if (started === null) {
      throw new ApiError(
        409,
        "invalid_request",
        "Thread is no longer idle, so its workspace cannot be restored",
      );
    }

    const restoringThread = requirePublicThread(deps.db, thread.id);
    deps.hub.notifyThread(
      thread.id,
      ["status-changed"],
      buildThreadStatusChangeMetadata(deps, restoringThread),
    );
    scheduleThreadProvisioningAdvance(deps, thread.id);

    return context.json(
      toThreadResponseFromThread(deps, { thread: restoringThread }),
    );
  });

  post(routes.read, (context) => {
    requirePublicThread(deps.db, context.req.param("id"));

    const thread = updateThread(deps.db, deps.hub, context.req.param("id"), {
      lastReadAt: Date.now(),
    });

    if (!thread) {
      throw new ApiError(404, "thread_not_found", "Thread not found");
    }

    return context.json(toThreadResponseFromThread(deps, { thread }));
  });

  post(routes.unread, (context) => {
    requirePublicThread(deps.db, context.req.param("id"));

    const thread = updateThread(deps.db, deps.hub, context.req.param("id"), {
      lastReadAt: null,
    });

    if (!thread) {
      throw new ApiError(404, "thread_not_found", "Thread not found");
    }

    return context.json(toThreadResponseFromThread(deps, { thread }));
  });
}

function isInboxRootThread(deps: AppDeps, threadId: string): boolean {
  const row = getInboxThread(deps.db, threadId);

  return row !== null && isInboxDomainRoot(row);
}

function refuseUnlessOwner(
  deps: AppDeps,
  context: { req: { header(name: string): string | undefined } },
  threadId: string,
  action: "archive" | "shelve" | "unshelve" | "reorder-shelf",
): void {
  const actor = requestInboxActor(context);

  if (actor.kind !== "thread") return;

  if (action === "shelve") proposeShelve(deps, threadId, Date.now());

  const message = {
    archive:
      "Only the owner can archive a chat. Verified completion is shown as Ready to archive.",
    shelve:
      'Only the owner can shelve a chat. The owner now sees "Shelve?" on its card.',
    unshelve: "Only the owner moves chats off the Shelf.",
    "reorder-shelf": "Only the owner reorders the Shelf.",
  }[action];

  throw new ApiError(403, "owner_only", message);
}

function scheduleSelfCheck(
  deps: AppDeps,
  threadId: string,
  payload: SendMessageRequest,
): { ok: true; delivery: "waiting"; waitId: string } {
  const text = payload.input
    .flatMap((part) => (part.type === "text" ? [part.text] : []))
    .join("\n")
    .trim();

  const sendAt = payload.sendAt ?? Date.now();

  const forText =
    (text.split("\n")[0] ?? "").slice(0, INBOX_FOR_TEXT_MAX) ||
    "Scheduled check";

  const { wait } = registerWait(
    deps.db,
    {
      threadId,
      key: `tell-at:${sendAt}:${createHash("sha256").update(text).digest("hex").slice(0, 12)}`,
      forText,
      chats: [],
      events: [],
      check: { what: forText, at: sendAt },
      report: null,
      readiness: "all",
      by: null,
      resume: text === "" ? null : text.slice(0, 2000),
      after: null,
    },
    { kind: "thread", threadId },
    Date.now(),
  );

  deps.hub.notifyThread(threadId, ["work-changed"]);

  return { ok: true, delivery: "waiting", waitId: wait.id };
}
