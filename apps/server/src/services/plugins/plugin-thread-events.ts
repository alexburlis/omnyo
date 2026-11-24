import type { EnvironmentRemoval } from "@omnyo/domain";
import type { ThreadChangeMetadata } from "@omnyo/domain";
import type { PluginThreadEventBatch } from "@omnyo/plugin-sdk/internal/host-policy";
import type { ApplyThreadLifecycleEventOutcome, HostRow } from "@omnyo/db";
import type { PendingInteraction, Thread } from "@omnyo/domain";
import type { ThreadQueuedMessage } from "@omnyo/domain";
import type { PluginThreadEventEmitter } from "./plugin-service.js";

const pendingThreadEvents = new Map<
  string,
  {
    timer: ReturnType<typeof setTimeout>;
    batch: PluginThreadEventBatch | undefined;
  }
>();

let emitter: PluginThreadEventEmitter | undefined;

export function setPluginThreadEventEmitter(
  next: PluginThreadEventEmitter | undefined,
): void {
  for (const { timer } of pendingThreadEvents.values()) clearTimeout(timer);
  pendingThreadEvents.clear();
  emitter = next;
}

export function emitPluginThreadCreated(thread: Thread): void {
  emitter?.emitThreadCreated(thread);
}

export function emitPluginThreadArchived(thread: Thread): void {
  emitter?.emitThreadArchived(thread);
}

export function emitPluginThreadUnarchived(thread: Thread): void {
  emitter?.emitThreadUnarchived(thread);
}

export function emitPluginThreadParentChanged(
  thread: Thread,
  previousParentThreadId: string | null,
): void {
  emitter?.emitThreadParentChanged(thread, previousParentThreadId);
}

export function emitPluginThreadMaintenance(
  thread: Thread,
  phase: Parameters<PluginThreadEventEmitter["emitThreadMaintenance"]>[1],
  outcome: Parameters<PluginThreadEventEmitter["emitThreadMaintenance"]>[2],
): void {
  emitter?.emitThreadMaintenance(thread, phase, outcome);
}

export function emitPluginThreadDeleted(thread: Thread): void {
  emitter?.emitThreadDeleted(thread);
}

export function emitPluginInteractionPending(
  thread: Thread,
  interaction: PendingInteraction,
): void {
  emitter?.emitInteractionPending(thread, interaction);
}

export function emitPluginMessageQueued(entry: ThreadQueuedMessage): void {
  emitter?.emitMessageQueued(entry);
}

export function emitPluginMessageDispatched(entry: ThreadQueuedMessage): void {
  emitter?.emitMessageDispatched(entry);
}

export function emitPluginMessageCancelled(entry: ThreadQueuedMessage): void {
  emitter?.emitMessageCancelled(entry);
}

export function emitPluginTurnFailed(threadId: string): void {
  emitter?.emitTurnFailed(threadId);
}

export function emitPluginThreadLifecycleOutcome(
  outcome: ApplyThreadLifecycleEventOutcome,
): void {
  if (!outcome.applied) return;

  if (outcome.thread.status === "active") {
    emitter?.emitThreadActive(outcome.thread);
  } else if (outcome.thread.status === "idle") {
    emitter?.emitThreadIdle(outcome.thread);
  } else if (outcome.thread.status === "error") {
    emitter?.emitThreadFailed(outcome.thread);
  }
}

export function emitPluginThreadEvents(
  threadId: string,
  metadata?: ThreadChangeMetadata,
): void {
  if (emitter === undefined) return;

  const range = metadata?.eventSequenceRange;

  const batch =
    metadata?.eventTypes !== undefined &&
    metadata.eventTypes.length > 0 &&
    range !== undefined &&
    range.from <= range.to
      ? { eventTypes: [...metadata.eventTypes], coveredSequence: { ...range } }
      : undefined;

  const pending = pendingThreadEvents.get(threadId);

  if (pending !== undefined) {
    pending.batch =
      pending.batch !== undefined &&
      batch !== undefined &&
      pending.batch.coveredSequence.to + 1 === batch.coveredSequence.from
        ? {
            eventTypes: [
              ...new Set([...pending.batch.eventTypes, ...batch.eventTypes]),
            ],
            coveredSequence: {
              from: pending.batch.coveredSequence.from,
              to: batch.coveredSequence.to,
            },
          }
        : undefined;

    return;
  }

  const timer = setTimeout(() => {
    const flushed = pendingThreadEvents.get(threadId);
    pendingThreadEvents.delete(threadId);
    emitter?.emitThreadEvents(threadId, flushed?.batch);
  }, 1_000);

  timer.unref?.();
  pendingThreadEvents.set(threadId, { timer, batch });
}

export function emitPluginTerminalInput(
  terminal: import("@omnyo/server-contract").TerminalSession,
): void {
  emitter?.emitTerminalInput(terminal);
}

export function emitPluginHostDeleted(host: HostRow): void {
  emitter?.emitHostDeleted(host);
}

export function emitPluginEnvironmentRemoved(
  removal: EnvironmentRemoval,
): void {
  emitter?.emitEnvironmentRemoved(removal);
}
