export interface ArchiveFailure {
  threadId: string;
  message: string;
}

export interface ArchiveSnapshot {
  hidden: ReadonlySet<string>;
  failure: string | null;
}

export function archiveFailureText(failures: readonly ArchiveFailure[]): string | null {
  if (failures.length === 0) return null;

  return `Could not archive ${failures.length === 1 ? "that chat" : `${failures.length} chats`}: ${failures
    .map((failure) => failure.message)
    .join("; ")}`;
}

export function createArchiveStore() {
  const pending = new Map<string, number>();
  const archived = new Set<string>();
  let ready: ReadonlySet<string> | null = null;
  let snapshot: ArchiveSnapshot = { hidden: new Set(), failure: null };
  const listeners = new Set<() => void>();

  const publish = (failure: string | null) => {
    snapshot = { hidden: new Set([...pending.keys(), ...archived]), failure };

    for (const listener of listeners) listener();
  };

  const settle = (threadIds: readonly string[], refused: readonly ArchiveFailure[]) => {
    const failed = new Set(refused.map((failure) => failure.threadId));

    for (const threadId of threadIds) {
      const count = (pending.get(threadId) ?? 1) - 1;

      if (count > 0) pending.set(threadId, count);
      else pending.delete(threadId);

      if (!failed.has(threadId) && (ready === null || ready.has(threadId))) archived.add(threadId);
    }
  };

  return {
    getSnapshot: () => snapshot,
    subscribe(listener: () => void) {
      listeners.add(listener);

      return () => {
        listeners.delete(listener);
      };
    },
    async archive(
      threadIds: readonly string[],
      run: () => Promise<{ failures: readonly ArchiveFailure[] }>,
    ): Promise<void> {
      for (const threadId of threadIds) pending.set(threadId, (pending.get(threadId) ?? 0) + 1);
      publish(null);

      try {
        const { failures } = await run();
        settle(threadIds, failures);
        publish(archiveFailureText(failures));
      } catch (cause) {
        const message = cause instanceof Error ? cause.message : String(cause);
        settle(
          threadIds,
          threadIds.map((threadId) => ({ threadId, message })),
        );
        publish(`Could not archive: ${message}`);
      }
    },
    release(readyIds: readonly string[]) {
      ready = new Set(readyIds);
      let changed = false;

      for (const threadId of archived) {
        if (ready.has(threadId)) continue;
        archived.delete(threadId);
        changed = true;
      }

      if (changed) publish(snapshot.failure);
    },
    dismissFailure() {
      if (snapshot.failure !== null) publish(null);
    },
  };
}
