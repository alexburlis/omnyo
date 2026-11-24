import { getHost, getThread, updateHost } from "@omnyo/db";
import { threadScope, type Host, type HostAvailability } from "@omnyo/domain";
import { ApiError } from "../../errors.js";
import type { LoggedPendingInteractionWorkSessionDeps } from "../../types.js";
import { listRunningThreadsWithIntendedHosts } from "../threads/dispatch-attempt.js";
import { requestQueuedMessageDispatch } from "../threads/queued-message-dispatch.js";
import { appendSystemErrorEvent } from "../threads/thread-events.js";
import { requestThreadStopForCurrentState } from "../threads/thread-lifecycle.js";
import { callHostRetryableOnlineRpc } from "./online-rpc.js";

const AWAY_TERMINATE_TIMEOUT_MS = 20_000;

type AvailabilityDeps = LoggedPendingInteractionWorkSessionDeps;

function stopAwayThread(
  deps: AvailabilityDeps,
  row: { hostId: string | null; id: string },
  hostName: string,
): void {
  const thread = getThread(deps.db, row.id);

  if (thread === null) return;

  const environment =
    thread.environmentId === null || row.hostId === null
      ? null
      : { id: thread.environmentId, hostId: row.hostId };

  if (thread.status === "active") {
    appendSystemErrorEvent(deps, {
      threadId: thread.id,
      environmentId: thread.environmentId,
      scope: threadScope(),
      code: "host_away",
      message: `${hostName} was set to Away, so this turn was stopped. New turns wait until it is Available again.`,
    });
  }

  requestThreadStopForCurrentState(deps, thread, environment);
}

export async function enforceHostAway(
  deps: AvailabilityDeps,
  hostId: string,
): Promise<void> {
  const host = getHost(deps.db, hostId);

  if (host === null || host.availability !== "away") return;

  const running = listRunningThreadsWithIntendedHosts(deps).filter(
    (row) => row.hostId === hostId,
  );

  for (const row of running) {
    try {
      stopAwayThread(deps, row, host.name);
    } catch (error) {
      deps.logger.warn(
        { error, hostId, threadId: row.id },
        "Could not stop a thread on a machine set to Away",
      );
    }
  }

  if (!deps.hub.hasDaemonForHost(hostId)) return;

  try {
    const result = await callHostRetryableOnlineRpc(deps, {
      hostId,
      timeoutMs: AWAY_TERMINATE_TIMEOUT_MS,
      command: { type: "host.agent_processes.terminate" },
    });

    deps.logger.info(
      { hostId, ...result },
      "Ended agent processes on a machine set to Away",
    );
  } catch (error) {
    deps.logger.warn(
      { error, hostId },
      "Could not end agent processes on a machine set to Away",
    );
  }
}

export function setHostAvailability(
  deps: AvailabilityDeps,
  args: { availability: HostAvailability; hostId: string },
): Host["availability"] {
  const updated = updateHost(deps.db, deps.hub, args.hostId, {
    availability: args.availability,
  });

  if (!updated) {
    throw new ApiError(404, "host_not_found", "Host not found");
  }

  deps.hub.notifyHost(args.hostId, ["host-connected"]);

  if (args.availability === "available") {
    requestQueuedMessageDispatch(deps, {
      kind: "host-available",
      hostId: args.hostId,
    });
  } else {
    void enforceHostAway(deps, args.hostId).catch((error: unknown) => {
      deps.logger.warn(
        { error, hostId: args.hostId },
        "Could not finish setting a machine to Away",
      );
    });
  }

  return updated.availability;
}
