import type { PluginSidebarThread } from "@omnyo/plugin-sdk/app";

export interface Waiting {
  threadId: string;
  on: string;
}

export interface Readiness {
  threadIds: string[];
  waiting: Waiting[];
  revision: number;
  stale?: boolean;
}

export interface ReadinessSnapshot {
  threadIds: readonly string[];
  waiting: readonly Waiting[];
  revision: number;
  refreshFailed: boolean;
}

export function createReadinessStore() {
  let snapshot: ReadinessSnapshot = {
    threadIds: [],
    waiting: [],
    revision: -1,
    refreshFailed: false,
  };

  let request = 0;
  let requiredRevision = -1;
  const listeners = new Set<() => void>();

  const notify = () => {
    for (const listener of listeners) listener();
  };

  const accept = (value: Readiness) => {
    if (value.revision < requiredRevision || value.revision < snapshot.revision) return;
    ++request;
    snapshot = { ...value, refreshFailed: value.stale === true };
    notify();
  };

  return {
    getSnapshot: () => snapshot,
    accept,
    subscribe(listener: () => void) {
      listeners.add(listener);

      return () => {
        listeners.delete(listener);
      };
    },
    async refresh(load: () => Promise<Readiness>, revision = -1) {
      requiredRevision = Math.max(requiredRevision, revision);
      const current = ++request;

      try {
        const value = await load();

        if (
          current !== request ||
          value.revision < requiredRevision ||
          value.revision < snapshot.revision
        )
          return;
        snapshot = { ...value, refreshFailed: value.stale === true };
      } catch {
        if (current !== request) return;
        snapshot = { ...snapshot, refreshFailed: true };
      }

      notify();
    },
  };
}

export const READINESS_EVENT = "omnyo-tidy:readiness";

export const READINESS_REQUEST_EVENT = "omnyo-tidy:readiness-request";

export const READINESS_ENDED_EVENT = "omnyo-tidy:readiness-ended";

export function broadcastReadiness(
  store: ReturnType<typeof createReadinessStore>,
  target: EventTarget,
): () => void {
  const send = () => {
    const { threadIds, waiting, revision, refreshFailed } = store.getSnapshot();

    if (revision < 0) return;
    target.dispatchEvent(
      new CustomEvent(READINESS_EVENT, {
        detail: {
          revision,
          stale: refreshFailed,
          threadIds: [...threadIds],
          waiting: waiting.map((entry) => ({ ...entry })),
        },
      }),
    );
  };

  const unsubscribe = store.subscribe(send);
  target.addEventListener(READINESS_REQUEST_EVENT, send);

  return () => {
    unsubscribe();
    target.removeEventListener(READINESS_REQUEST_EVENT, send);
    target.dispatchEvent(new Event(READINESS_ENDED_EVENT));
  };
}

export function canShowReadiness(thread: PluginSidebarThread | undefined): boolean {
  return thread === undefined || thread.experimental_work?.archive.recommended === true;
}
