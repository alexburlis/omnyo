import { setTimeout as sleep } from "node:timers/promises";
import {
  getThread,
  listRunningThreads,
  listThreadsWithUpdateActivity,
} from "@omnyo/db";
import { threadScope, type Thread } from "@omnyo/domain";
import type { LoggedPendingInteractionWorkSessionDeps } from "../../types.js";
import { appendSystemErrorEvent } from "../threads/thread-events.js";
import { intendedThreadHostId } from "../threads/dispatch-attempt.js";
import { filterRunningThreadsByHost } from "../threads/thread-runtime-display.js";
import {
  stopThreadForAppUpdate,
  stopThreadForCurrentState,
} from "../threads/thread-lifecycle.js";

const RUNNING_WORK_POLL_MS = 250;

export interface StopRunningServerWorkArgs {
  pollMs?: number;
  targetHostName: string;
  timeoutMs: number;
}

export interface StopRunningWorkForAppUpdateArgs {
  hostId?: string;
  pollMs?: number;
  shouldContinue: () => boolean;
  timeoutMs: number;
}

type RunningThreadStopper = (
  thread: Thread,
  environment: { hostId: string; id: string } | null,
) => Promise<void>;

async function stopRunningThread(
  deps: LoggedPendingInteractionWorkSessionDeps,
  row: { hostId: string | null; id: string },
  stop: RunningThreadStopper,
): Promise<void> {
  const thread = getThread(deps.db, row.id);

  if (thread === null) {
    return;
  }

  const environment =
    thread.environmentId === null || row.hostId === null
      ? null
      : { id: thread.environmentId, hostId: row.hostId };

  await stop(thread, environment);
}

function turnCount(count: number): string {
  return count === 1 ? "1 turn" : `${count} turns`;
}

export async function stopRunningServerWork(
  deps: LoggedPendingInteractionWorkSessionDeps,
  args: StopRunningServerWorkArgs,
): Promise<void> {
  await stopAllRunningThreads(deps, args, async (thread, environment) => {
    if (thread.status === "active") {
      appendSystemErrorEvent(deps, {
        threadId: thread.id,
        environmentId: thread.environmentId,
        scope: threadScope(),
        code: "server_move",
        message: `The server is moving to ${args.targetHostName}, so this turn was stopped. Continue with a new turn after the move.`,
      });
    }

    await stopThreadForCurrentState(deps, thread, environment, {
      requireStopped: true,
    });
  });
}

export async function stopRunningWorkForAppUpdate(
  deps: LoggedPendingInteractionWorkSessionDeps,
  args: StopRunningWorkForAppUpdateArgs,
): Promise<void> {
  await stopAllRunningThreads(
    deps,
    args,
    (thread, environment) => stopThreadForAppUpdate(deps, thread, environment),
    (db) => {
      const rows = listThreadsWithUpdateActivity(db, {
        hostId: args.hostId,
        includeUnassigned: args.hostId !== undefined,
      });

      return args.hostId === undefined
        ? filterRunningThreadsByHost(deps, rows)
        : rows.filter(
            (row) =>
              (row.hostId ?? intendedThreadHostId(deps, row.id)) ===
              args.hostId,
          );
    },
  );
}

async function stopAllRunningThreads(
  deps: LoggedPendingInteractionWorkSessionDeps,
  args: { pollMs?: number; shouldContinue?: () => boolean; timeoutMs: number },
  stop: RunningThreadStopper,
  listWork = listRunningThreads,
): Promise<void> {
  const deadline = Date.now() + args.timeoutMs;
  const pollMs = args.pollMs ?? RUNNING_WORK_POLL_MS;
  const inflight = new Map<string, Promise<void>>();
  const failures: unknown[] = [];

  while (true) {
    const failure = failures[0];

    if (failure !== undefined) {
      throw failure;
    }

    const running = args.shouldContinue?.() === false ? [] : listWork(deps.db);

    if (running.length === 0 && inflight.size === 0) {
      return;
    }

    if (Date.now() >= deadline) {
      throw new Error(
        `${turnCount(Math.max(running.length, inflight.size))} did not stop. Stop them, then try again.`,
      );
    }

    for (const row of running) {
      if (inflight.has(row.id)) {
        continue;
      }

      inflight.set(
        row.id,
        stopRunningThread(deps, row, stop).then(
          () => {
            inflight.delete(row.id);
          },
          (error: unknown) => {
            inflight.delete(row.id);
            failures.push(error);
          },
        ),
      );
    }

    await Promise.race([
      sleep(Math.min(pollMs, Math.max(0, deadline - Date.now()))),
      ...inflight.values(),
    ]);
  }
}
