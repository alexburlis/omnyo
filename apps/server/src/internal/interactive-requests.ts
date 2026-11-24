import {
  hostDaemonInteractiveInterruptRequestSchema,
  hostDaemonInteractiveRequestSchema,
  typedRoutes,
  type HostDaemonInteractiveRequest,
  type HostDaemonInternalSchema,
} from "@omnyo/host-daemon-contract";
import { formatPendingInteractionSubjectDetailLines } from "@omnyo/core-ui";
import type { PendingInteraction } from "@omnyo/domain";
import {
  isApprovalPendingInteractionPayload,
  isPluginExtensionInteractionRequestPayload,
  isUserQuestionPendingInteractionPayload,
  parseExtensionKind,
} from "@omnyo/domain";
import { getThread, hasStoredTurnStarted } from "@omnyo/db";
import { sliceUtf16Head } from "@omnyo/text-utils";
import {
  isParentNotifiableChildThread,
  resolveQuestionOwnerThread,
  routedQuestionDeliveredReason,
} from "../services/threads/thread-parent.js";
import type { Hono } from "hono";
import type { AppDeps } from "../types.js";
import { ApiError } from "../errors.js";
import { deferAfterResponse } from "../services/lib/response-deferral.js";
import {
  requireThreadEnvironment,
  requireThreadEnvironmentAllowingDestroyed,
} from "../services/lib/entity-lookup.js";
import {
  queueChildThreadNeedsAttentionNotificationBestEffort,
  queueChildThreadQuestion,
} from "../services/threads/child-thread-notifications.js";
import { requireAuthenticatedDaemonSession } from "./session-state.js";
import { awaitRequestEventsThrough } from "../services/hosts/event-receipt-watermarks.js";

interface RequestChildThreadNeedsAttentionNotificationArgs {
  blockerSummary: string | null;
  childThreadId: string;
}

const CHILD_THREAD_BLOCKER_SUMMARY_MAX_LINES = 4;

const CHILD_THREAD_BLOCKER_SUMMARY_MAX_CHARS = 700;

const CHILD_THREAD_BLOCKER_SUMMARY_TRUNCATION_MARKER =
  "\n[... summary truncated ...]";

function pendingInteractionBlockerLabel(
  interaction: PendingInteraction,
): string {
  if (isUserQuestionPendingInteractionPayload(interaction.payload)) {
    return "user question";
  }

  if (isPluginExtensionInteractionRequestPayload(interaction.payload)) {
    return `${parseExtensionKind(interaction.payload.kind).pluginId} request`;
  }

  if (!isApprovalPendingInteractionPayload(interaction.payload)) {
    return "plugin request";
  }

  switch (interaction.payload.subject.kind) {
    case "command":
      return "command approval";
    case "file_change":
      return "file-change approval";
    case "permission_grant":
      return "permission grant";
    case "plan":
      return "plan review";
    case "tool_use":
      return "tool-use approval";
    default: {
      const exhaustiveCheck: never = interaction.payload.subject;

      return exhaustiveCheck;
    }
  }
}

function truncateChildThreadBlockerSummary(summary: string): string {
  if (summary.length <= CHILD_THREAD_BLOCKER_SUMMARY_MAX_CHARS) {
    return summary;
  }

  const retainedLength = Math.max(
    0,
    CHILD_THREAD_BLOCKER_SUMMARY_MAX_CHARS -
      CHILD_THREAD_BLOCKER_SUMMARY_TRUNCATION_MARKER.length,
  );

  return `${sliceUtf16Head(summary, retainedLength).trimEnd()}${CHILD_THREAD_BLOCKER_SUMMARY_TRUNCATION_MARKER}`;
}

function pluginFormTitleLines(interaction: PendingInteraction): string[] {
  const { payload } = interaction;

  return isApprovalPendingInteractionPayload(payload) ||
    isUserQuestionPendingInteractionPayload(payload)
    ? []
    : [payload.title];
}

export function buildChildThreadBlockerSummary(
  interaction: PendingInteraction,
): string | null {
  const detailLines = formatPendingInteractionSubjectDetailLines(interaction);

  const details = (
    detailLines.length > 0 ? detailLines : pluginFormTitleLines(interaction)
  )
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .slice(0, CHILD_THREAD_BLOCKER_SUMMARY_MAX_LINES);

  if (details.length === 0) {
    return null;
  }

  return truncateChildThreadBlockerSummary(
    [
      `Blocked on ${pendingInteractionBlockerLabel(interaction)}:`,
      ...details,
    ].join("\n"),
  );
}

function requestChildThreadNeedsAttentionNotification(
  deps: AppDeps,
  args: RequestChildThreadNeedsAttentionNotificationArgs,
): void {
  const childThread = getThread(deps.db, args.childThreadId);

  if (!childThread || !isParentNotifiableChildThread(childThread)) {
    return;
  }

  const parentThreadId = childThread.parentThreadId;

  deferAfterResponse({
    config: deps.config,
    context: {
      childThreadId: childThread.id,
      parentThreadId,
    },
    logger: deps.logger,
    name: "Child thread needs-attention notification",
    work: () =>
      queueChildThreadNeedsAttentionNotificationBestEffort(deps, {
        blockerSummary: args.blockerSummary,
        childThread,
        parentThreadId,
      }),
  });
}

async function routeChildProviderQuestion(
  deps: AppDeps,
  interaction: HostDaemonInteractiveRequest["interaction"],
): Promise<string | null> {
  if (!isUserQuestionPendingInteractionPayload(interaction.payload))
    return null;
  const childThread = getThread(deps.db, interaction.threadId);

  if (
    childThread === null ||
    childThread.deletedAt !== null ||
    childThread.archivedAt !== null ||
    childThread.providerId !== interaction.providerId
  )
    return null;
  const ownerThread = resolveQuestionOwnerThread(deps, childThread);

  if (ownerThread === null) return null;

  try {
    const delivered = await queueChildThreadQuestion(deps, {
      childThread,
      parentThreadId: ownerThread.id,
      questions: interaction.payload.questions.map((question) => ({
        allowFreeText: question.allowFreeText,
        context: null,
        delegable: false,
        mode: "required",
        multiSelect: question.multiSelect,
        options: (question.options ?? []).map((option) => ({
          description: option.description ?? null,
          label: option.label,
          preview: null,
          recommended: false,
        })),
        prompt: question.prompt,
      })),
    });

    return delivered ? routedQuestionDeliveredReason(ownerThread.id) : null;
  } catch (error) {
    deps.logger.warn(
      {
        childThreadId: childThread.id,
        ownerThreadId: ownerThread.id,
        err: error,
      },
      "Failed to deliver a provider question to the chat that owns it",
    );

    return `This chat reports to ${ownerThread.id}. Delivering the question to that chat failed, so state it in your final response and end the turn; do not ask the owner.`;
  }
}

export function registerInternalInteractiveRequestRoutes(
  app: Hono,
  deps: AppDeps,
): void {
  const { post } = typedRoutes<HostDaemonInternalSchema>(app, {
    onValidationError: (msg) => new ApiError(400, "invalid_request", msg),
  });

  post(
    "/session/interactive-request",
    hostDaemonInteractiveRequestSchema,
    async (context, payload) => {
      const session = requireAuthenticatedDaemonSession({
        context,
        db: deps.db,
        sessionId: payload.sessionId,
      });

      const { environment } = requireThreadEnvironment(
        deps.db,
        payload.interaction.threadId,
      );

      if (environment.hostId !== session.hostId) {
        throw new ApiError(
          403,
          "invalid_request",
          "Thread does not belong to the session host",
        );
      }

      await awaitRequestEventsThrough(deps, {
        eventsThrough: payload.eventsThrough,
        key: { hostId: session.hostId, instanceId: session.instanceId },
        request: "interactive-request",
        threadId: payload.interaction.threadId,
      });

      if (context.req.raw.signal.aborted) {
        throw new ApiError(
          409,
          "request_cancelled",
          "The daemon cancelled the interactive request while its events were pending",
        );
      }

      const turnStarted = hasStoredTurnStarted(deps.db, {
        threadId: payload.interaction.threadId,
        turnId: payload.interaction.turnId,
      });

      if (!turnStarted) {
        deps.logger.warn(
          {
            providerId: payload.interaction.providerId,
            providerRequestId: payload.interaction.providerRequestId,
            providerThreadId: payload.interaction.providerThreadId,
            threadId: payload.interaction.threadId,
            turnId: payload.interaction.turnId,
          },
          "interactive request arrived before turn/started; asking daemon to retry",
        );
        throw new ApiError(
          503,
          "turn_start_not_ready",
          "Turn start has not been stored yet; retry interactive request registration",
          true,
        );
      }

      const routedReason = await routeChildProviderQuestion(
        deps,
        payload.interaction,
      );

      if (routedReason !== null)
        return context.json({ outcome: "rejected", reason: routedReason });

      const registered = deps.pendingInteractions.registerPendingInteraction({
        interaction: payload.interaction,
      });

      if (registered.outcome === "rejected") {
        return context.json({
          outcome: "rejected",
          reason: registered.reason,
        });
      }

      if (registered.outcome === "created") {
        requestChildThreadNeedsAttentionNotification(deps, {
          blockerSummary: buildChildThreadBlockerSummary(
            registered.interaction,
          ),
          childThreadId: registered.interaction.threadId,
        });
      }

      return context.json({
        outcome: registered.outcome,
        interactionId: registered.interaction.id,
        status: registered.interaction.status,
      });
    },
  );

  post(
    "/session/interactive-request/interrupt",
    hostDaemonInteractiveInterruptRequestSchema,
    (context, payload) => {
      const session = requireAuthenticatedDaemonSession({
        context,
        db: deps.db,
        sessionId: payload.sessionId,
      });

      const interruptibleThreadIds: string[] = [];

      for (const threadId of payload.threadIds) {
        let environmentHostId: string;

        try {
          const { environment } = requireThreadEnvironmentAllowingDestroyed(
            deps.db,
            threadId,
          );

          environmentHostId = environment.hostId;
        } catch (error) {
          if (
            error instanceof ApiError &&
            (error.status === 404 ||
              error.body.code === "thread_environment_unavailable")
          ) {
            continue;
          }

          throw error;
        }

        if (environmentHostId !== session.hostId) {
          throw new ApiError(
            403,
            "invalid_request",
            "Thread does not belong to the session host",
          );
        }

        interruptibleThreadIds.push(threadId);
      }

      const interrupted =
        deps.pendingInteractions.interruptPendingInteractionsForThreads({
          providerId: payload.providerId,
          threadIds: interruptibleThreadIds,
          reason: payload.reason,
          ...(payload.requests === undefined
            ? {}
            : { requests: payload.requests }),
        });

      return context.json({
        ok: true,
        interactionIds: interrupted.map((interaction) => interaction.id),
      });
    },
  );
}
