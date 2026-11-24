import {
  getPendingInteractionByProviderRequest,
  listActiveProviderPendingInteractionsForHost,
} from "@omnyo/db";
import type {
  HostDaemonInteractiveRequestKey,
  HostDaemonOpenThreadWork,
} from "@omnyo/host-daemon-contract";
import type { LoggedPendingInteractionWorkSessionDeps } from "../../types.js";
import { NotificationBuffer } from "../lib/notification-buffer.js";
import { settleBackgroundTasksTheDaemonNoLongerRuns } from "./background-task-reconciliation.js";

const PROVIDER_NO_LONGER_WAITING_REASON =
  "The provider stopped waiting for this answer while the host was disconnected";

const DAEMON_OPEN_TASK_KEY_PREFIX = "task:";

function reportedOpenItemIds(keys: readonly string[]): Set<string> {
  return new Set(
    keys.flatMap((key) =>
      key.startsWith(DAEMON_OPEN_TASK_KEY_PREFIX)
        ? [key.slice(DAEMON_OPEN_TASK_KEY_PREFIX.length)]
        : [],
    ),
  );
}

interface ReconcileDaemonReportedOpenWorkArgs {
  hostId: string;
  openThreadWork: readonly HostDaemonOpenThreadWork[];
  undeliveredEventThreadIds: readonly string[];
}

function providerRequestKey(request: {
  providerId: string | null;
  providerRequestId: string | null;
  providerThreadId: string | null;
}): string {
  return [
    request.providerId,
    request.providerThreadId,
    request.providerRequestId,
  ].join("\0");
}

export function reconcileDaemonReportedOpenWork(
  deps: LoggedPendingInteractionWorkSessionDeps,
  args: ReconcileDaemonReportedOpenWorkArgs,
): HostDaemonInteractiveRequestKey[] {
  const unsettledThreadIds = new Set(args.undeliveredEventThreadIds);
  settleBackgroundTasksTheDaemonNoLongerRuns(deps, {
    hostId: args.hostId,
    openItemIdsByThreadId: new Map(
      args.openThreadWork.map((work) => [
        work.threadId,
        reportedOpenItemIds(work.backgroundItemIds),
      ]),
    ),
    unsettledThreadIds,
  });

  const reportedRequests = args.openThreadWork.flatMap(
    (work) => work.interactiveRequests,
  );

  const reportedKeys = new Set(reportedRequests.map(providerRequestKey));
  interruptQuestionsTheProviderNoLongerAsks(deps, {
    hostId: args.hostId,
    reportedKeys,
    unsettledThreadIds,
  });

  for (const interaction of listActiveProviderPendingInteractionsForHost(
    deps.db,
    { hostId: args.hostId },
  )) {
    if (interaction.status !== "resolving") continue;

    if (reportedKeys.has(providerRequestKey(interaction))) {
      deps.pendingInteractions.redeliverResolvingInteraction(interaction.id);
    } else if (!unsettledThreadIds.has(interaction.threadId)) {
      deps.pendingInteractions.completeResolvingInteractionWithoutAck(
        interaction.id,
      );
    }
  }

  return reportedRequests.filter((request) => {
    const interaction = getPendingInteractionByProviderRequest(
      deps.db,
      request,
    );

    return (
      interaction !== null &&
      interaction.status !== "pending" &&
      interaction.status !== "resolving"
    );
  });
}

export function redeliverSavedAnswersToUnreportingDaemon(
  deps: LoggedPendingInteractionWorkSessionDeps,
  args: { hostId: string },
): void {
  for (const interaction of listActiveProviderPendingInteractionsForHost(
    deps.db,
    { hostId: args.hostId },
  )) {
    if (interaction.status === "resolving") {
      deps.pendingInteractions.redeliverResolvingInteraction(interaction.id);
    }
  }
}

function interruptQuestionsTheProviderNoLongerAsks(
  deps: LoggedPendingInteractionWorkSessionDeps,
  args: {
    hostId: string;
    reportedKeys: ReadonlySet<string>;
    unsettledThreadIds: ReadonlySet<string>;
  },
): void {
  const abandoned = listActiveProviderPendingInteractionsForHost(deps.db, {
    hostId: args.hostId,
  }).filter(
    (interaction) =>
      interaction.status === "pending" &&
      !args.unsettledThreadIds.has(interaction.threadId) &&
      !args.reportedKeys.has(providerRequestKey(interaction)),
  );

  if (abandoned.length === 0) return;
  const notifications = new NotificationBuffer();
  deps.db.transaction(
    (tx) => {
      for (const interaction of abandoned) {
        deps.pendingInteractions.interruptPendingInteractionInTransaction(
          { db: tx, hub: notifications },
          {
            interactionId: interaction.id,
            reason: PROVIDER_NO_LONGER_WAITING_REASON,
          },
        );
      }
    },
    { behavior: "immediate" },
  );
  notifications.flushInto(deps.hub);
  deps.logger.info(
    {
      hostId: args.hostId,
      interactionIds: abandoned.map((interaction) => interaction.id),
    },
    "Interrupted questions the provider no longer waits on",
  );
}
