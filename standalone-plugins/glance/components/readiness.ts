import { useEffect, useRef, useSyncExternalStore } from "react";
import { z } from "zod";
import {
  experimental_useSidebarThreads,
  useRealtimeConnectionState,
  useSdk,
  type PluginSidebarThread,
} from "@omnyo/plugin-sdk/app";

export type Readiness = "loading" | "unavailable" | "absent" | "ready" | "not-ready";

export const READINESS_EVENT = "omnyo-tidy:readiness";

export const READINESS_REQUEST_EVENT = "omnyo-tidy:readiness-request";

export const READINESS_ENDED_EVENT = "omnyo-tidy:readiness-ended";

const readyIdsSchema = z.object({
  threadIds: z.array(z.string()),
  revision: z.number().int(),
  stale: z.boolean().optional(),
});

const missingSourceSchema = z.object({ status: z.literal(404) });

type ReadyIds = z.infer<typeof readyIdsSchema>;

interface ReadinessState {
  status: "loading" | "loaded" | "unavailable" | "absent";
  ids: ReadonlySet<string>;
  revision: number;
}

const initialState: ReadinessState = { status: "loading", ids: new Set(), revision: -1 };

const unavailable: ReadinessState = { status: "unavailable", ids: new Set(), revision: -1 };

const absent: ReadinessState = { status: "absent", ids: new Set(), revision: -1 };

export function createTidyReadiness(target: EventTarget, load: () => Promise<ReadyIds>) {
  let state = initialState;
  const listeners = new Set<() => void>();
  let inflight = false;
  let again = false;
  let generation = 0;
  let heard = 0;

  const emit = (next: ReadinessState) => {
    state = next;

    for (const listener of listeners) listener();
  };

  const accept = (value: ReadyIds) => {
    if (value.revision < state.revision) return;
    emit({
      status: value.stale === true ? "unavailable" : "loaded",
      ids: new Set(value.threadIds),
      revision: value.revision,
    });
  };

  const onReadiness = (event: Event) => {
    const parsed = readyIdsSchema.safeParse(event instanceof CustomEvent ? event.detail : null);

    if (!parsed.success) return;
    heard += 1;
    accept(parsed.data);
  };

  const onEnded = () => emit(unavailable);

  const requestSnapshot = () => {
    const before = heard;
    target.dispatchEvent(new Event(READINESS_REQUEST_EVENT));

    return heard > before;
  };

  const refresh = (): Promise<void> => {
    if (inflight) {
      again = true;

      return Promise.resolve();
    }

    inflight = true;
    const requested = generation;

    return Promise.resolve()
      .then(load)
      .then(
        (result) => {
          if (requested === generation) accept(readyIdsSchema.parse(result));
        },
        (error) => {
          if (requested !== generation || requestSnapshot()) return;
          emit(missingSourceSchema.safeParse(error).success ? absent : unavailable);
        },
      )
      .finally(() => {
        inflight = false;

        if (again) {
          again = false;
          void refresh();
        }
      });
  };

  return {
    getSnapshot: () => state,
    subscribe(listener: () => void) {
      listeners.add(listener);

      return () => {
        listeners.delete(listener);
      };
    },
    resync() {
      requestSnapshot();

      return refresh();
    },
    start() {
      target.addEventListener(READINESS_EVENT, onReadiness);
      target.addEventListener(READINESS_ENDED_EVENT, onEnded);

      return this.resync();
    },
    stop() {
      target.removeEventListener(READINESS_EVENT, onReadiness);
      target.removeEventListener(READINESS_ENDED_EVENT, onEnded);
      generation += 1;
      state = initialState;
    },
  };
}

type Sdk = ReturnType<typeof useSdk>;

let client: Sdk | null = null;

let consumers = 0;

let shared: ReturnType<typeof createTidyReadiness> | null = null;

function readiness() {
  shared ??= createTidyReadiness(window, () => {
    if (client === null) return Promise.reject(new Error("Glance has no SDK client"));

    return client.plugins.callRpc({
      pluginId: "tidy",
      method: "ready_ids",
      input: null,
      outputSchema: readyIdsSchema,
    });
  });

  return shared;
}

function subscribe(listener: () => void) {
  return readiness().subscribe(listener);
}

function snapshot() {
  return readiness().getSnapshot();
}

function resyncVisible() {
  if (document.visibilityState === "visible") void readiness().resync();
}

export function useReadinessSource() {
  const sdk = useSdk();
  const connection = useRealtimeConnectionState();
  const previous = useRef(connection);

  useEffect(() => {
    client = sdk;
    consumers += 1;

    if (consumers === 1) {
      document.addEventListener("visibilitychange", resyncVisible);
      void readiness().start();
    }

    return () => {
      consumers -= 1;

      if (consumers === 0) {
        document.removeEventListener("visibilitychange", resyncVisible);
        readiness().stop();
      }
    };
  }, [sdk]);

  useEffect(() => {
    if (connection === "connected" && previous.current !== "connected") void readiness().resync();
    previous.current = connection;
  }, [connection]);
}

export function hasOpenWork(thread: PluginSidebarThread | undefined) {
  return (
    thread !== undefined &&
    (thread.status !== "idle" ||
      thread.runtimeStatus !== "idle" ||
      thread.queuedWork !== "none" ||
      thread.hasPendingInteraction ||
      (thread.experimental_attention !== undefined &&
        thread.experimental_attention.kind !== "none") ||
      Object.values(thread.activity).some((count) => count > 0))
  );
}

function readinessOf(current: ReadinessState, ready: boolean): Readiness {
  if (current.status !== "loaded") return current.status;

  return ready ? "ready" : "not-ready";
}

export function useReadiness(threadId: string): Readiness {
  useReadinessSource();
  const current = useSyncExternalStore(subscribe, snapshot, snapshot);
  const { threads } = experimental_useSidebarThreads();
  const thread = threads.find((entry) => entry.id === threadId);

  return readinessOf(current, current.ids.has(threadId) && !hasOpenWork(thread));
}

export function useReadinessMap(threads: ReadonlyMap<string, PluginSidebarThread>) {
  useReadinessSource();
  const current = useSyncExternalStore(subscribe, snapshot, snapshot);

  return (threadId: string) =>
    readinessOf(current, current.ids.has(threadId) && !hasOpenWork(threads.get(threadId)));
}

export function useNotReadyAction() {
  const { threads } = experimental_useSidebarThreads();
  const ready = useReadinessMap(new Map(threads.map((thread) => [thread.id, thread])));

  return { ready, refresh: () => readiness().resync() };
}
