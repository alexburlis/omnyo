import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import {
  experimental_usePluginId,
  experimental_useThreadBootstrapData,
  type ExperimentalThreadBootstrapData,
  useRealtime,
  useRealtimeConnectionState,
  useRpc,
} from "@omnyo/plugin-sdk/app";
import {
  rpcContract,
  realtimeChannel,
  realtimePayloadSchema,
  type Card,
  type CardDiff,
  type CardIndexEntry,
  type CardView,
  type GlanceRpcContract,
} from "../contract";

import { captureRefreshFailure } from "./refresh-diagnostics";

interface CardState {
  view: CardView | null;
  conversationSeq: number | null;
  current: boolean;
  loading: boolean;
  diff: CardDiff | null;
  error: string | null;
}

interface CardResource {
  state: CardState;
  listeners: Map<symbol, () => void>;
  generation: number;
  pending: Promise<void> | null;
  reading: boolean;
  loaded: boolean;
  bootstrapKey: string | null;
  bootstrapUpdatedAt: number | null;
}

const retainedCards = new Map<string, CardResource>();

const indexedCards = new Map<string, CardIndexEntry>();

function indexedView(entry: CardIndexEntry): CardView {
  const card: Card = {
    status: entry.status,
    phase: entry.phase,
    headline: entry.headline,
    facts: entry.facts,
    deliverables: [],
    proof: [],
  };

  if (entry.goal !== null) card.goal = entry.goal;

  if (entry.sidebarSummary !== null) card.sidebarSummary = entry.sidebarSummary;

  if (entry.blocker !== null) card.blocker = entry.blocker;

  if (entry.next !== null) card.next = entry.next;

  return {
    threadId: entry.threadId,
    card,
    revision: entry.revision,
    updatedAt: entry.updatedAt,
    source: "tool",
    staleSince: entry.stale ? entry.updatedAt : null,
    proofs: [],
  };
}

function resourceFor(key: string): CardResource {
  const existing = retainedCards.get(key);

  if (existing) return existing;

  const indexed = indexedCards.get(key);

  const resource: CardResource = {
    state: {
      view: indexed === undefined ? null : indexedView(indexed),
      conversationSeq: null,
      current: false,
      loading: true,
      diff: null,
      error: null,
    },
    listeners: new Map(),
    generation: 0,
    pending: null,
    reading: false,
    loaded: false,
    bootstrapKey: null,
    bootstrapUpdatedAt: null,
  };

  retainedCards.set(key, resource);

  for (const [candidate, value] of retainedCards) {
    if (retainedCards.size <= 32) break;

    if (candidate !== key && value.listeners.size === 0 && value.pending === null)
      retainedCards.delete(candidate);
  }

  return resource;
}

function update(resource: CardResource, patch: Partial<CardState>) {
  resource.state = { ...resource.state, ...patch };

  for (const listener of resource.listeners.values()) listener();
}

function bootstrapAdoption(
  resource: CardResource,
  bootstrap: ExperimentalThreadBootstrapData,
  threadId: string,
) {
  const bootstrapCurrent = "current" in bootstrap && bootstrap.current === true;

  const key =
    bootstrap.status === "ready"
      ? `ready:${bootstrap.updatedAt}:${bootstrapCurrent}`
      : bootstrap.status === "error"
        ? `error:${bootstrap.updatedAt}`
        : bootstrap.status;

  if (resource.bootstrapKey === key) return null;
  const state = { ...resource.state, current: false, conversationSeq: null };

  if (bootstrap.status === "ready") {
    const result = rpcContract["card.read"].output.safeParse(bootstrap.result);

    if (!result.success || (result.data.view !== null && result.data.view.threadId !== threadId)) {
      return {
        key,
        state: {
          ...state,
          loading: false,
          error: "Glance returned an invalid card with the conversation. Retry to load it again.",
        },
        result: null,
      };
    }

    const current =
      bootstrapCurrent &&
      (resource.bootstrapUpdatedAt === null || bootstrap.updatedAt >= resource.bootstrapUpdatedAt);

    const view = current || !resource.loaded ? result.data.view : state.view;

    return {
      key,
      keep: !current && resource.reading,
      state: {
        ...state,
        view,
        current,
        loading: !current,
        error: null,
        diff: state.diff?.revision === view?.revision ? state.diff : null,
      },
      result: result.data,
    };
  }

  if (bootstrap.status === "error") {
    return {
      key,
      state: {
        ...state,
        loading: false,
        error: `Glance could not load with the conversation. ${bootstrap.message}`,
      },
      result: null,
    };
  }

  return {
    key,
    state: bootstrap.status === "pending" ? { ...state, loading: true, error: null } : state,
    result: null,
  };
}

function useReconnect(refresh: () => void) {
  const connection = useRealtimeConnectionState();
  const previous = useRef(connection);

  useEffect(() => {
    if (connection === "connected" && previous.current !== "connected") refresh();
    previous.current = connection;
  }, [connection, refresh]);
}

export function useCard(threadId: string) {
  const rpc = useRpc<GlanceRpcContract>();
  const pluginId = experimental_usePluginId();
  const bootstrap = experimental_useThreadBootstrapData(threadId, "card.read");
  const bootstrapRef = useRef(bootstrap);
  bootstrapRef.current = bootstrap;
  const resource = useMemo(() => resourceFor(`${pluginId}:${threadId}`), [pluginId, threadId]);
  const token = useRef(Symbol());

  const subscribe = useCallback(
    (listener: () => void) => {
      resource.listeners.set(token.current, listener);

      return () => {
        resource.listeners.delete(token.current);

        if (resource.listeners.size === 0) {
          resource.bootstrapKey = null;
          update(resource, { current: false });
        }
      };
    },
    [resource],
  );

  const snapshot = useCallback(() => resource.state, [resource]);
  const state = useSyncExternalStore(subscribe, snapshot);

  const load = useCallback(
    (seed?: { view: CardView | null }) => {
      const generation = ++resource.generation;
      update(resource, {
        error: null,
        current: seed !== undefined || (resource.state.current && resource.state.view !== null),
        loading: seed === undefined,
        conversationSeq: null,
      });
      const card = seed === undefined ? rpc.call("card.read", { threadId }) : Promise.resolve(seed);
      const changes = rpc.call("card.diff", { threadId });
      resource.reading = seed === undefined;

      const cardPending = card.then(
        (result) => {
          if (generation !== resource.generation) return;
          resource.pending = null;
          resource.reading = false;
          resource.loaded = true;
          update(resource, {
            view: result.view,
            current: resource.listeners.size > 0,
            loading: false,
            diff:
              resource.state.diff?.revision === result.view?.revision ? resource.state.diff : null,
          });
        },
        () => {
          if (generation !== resource.generation) return;
          resource.pending = null;
          resource.reading = false;
          update(resource, {
            current: false,
            loading: false,
            error: "Glance could not load the latest card. Retry to check for updates.",
          });
        },
      );

      const pending = Promise.allSettled([card, changes]).then(([cardResult, changeResult]) => {
        if (generation !== resource.generation) return;
        resource.pending = null;

        if (cardResult.status === "rejected") return;

        if (changeResult.status === "rejected") {
          update(resource, {
            error: "Glance loaded the card, but could not refresh its history. Try again.",
          });

          return;
        }

        const result = cardResult.value;
        const change = changeResult.value;

        if (change.revision === result.view?.revision) {
          const previous = resource.state.diff;
          update(resource, {
            conversationSeq: change.conversationSeq,
            diff:
              change.changes.length > 0 ||
              change.newReplies > 0 ||
              change.moreActivity ||
              previous === null ||
              previous.revision !== result.view?.revision
                ? change
                : previous,
          });
        }
      });

      resource.pending = cardPending;

      return pending;
    },
    [resource, rpc, threadId],
  );

  const refresh = useCallback(() => {
    if (bootstrapRef.current.status === "pending") return Promise.resolve();

    return load();
  }, [load]);

  const adoption = bootstrapAdoption(resource, bootstrap, threadId);

  useEffect(() => {
    if (resource.listeners.keys().next().value !== token.current || adoption === null) return;
    resource.bootstrapKey = adoption.key;

    if ("keep" in adoption && adoption.keep && bootstrap.status === "ready") {
      resource.bootstrapUpdatedAt = bootstrap.updatedAt;
      resource.loaded = true;

      if (!resource.state.current) update(resource, adoption.state);

      return;
    }

    if (bootstrap.status === "unavailable") {
      if (resource.pending === null) load();

      return;
    }

    resource.generation += 1;
    resource.pending = null;
    resource.reading = false;
    update(resource, adoption.state);

    if (bootstrap.status === "pending") return;

    resource.bootstrapUpdatedAt = bootstrap.updatedAt;

    if (bootstrap.status === "ready" && adoption.result !== null) {
      resource.loaded = true;
      load(adoption.state.current ? adoption.result : undefined);
    }
  }, [adoption, bootstrap, load, resource]);

  const reconcile = useCallback(() => {
    if (resource.listeners.keys().next().value === token.current) refresh();
  }, [refresh, resource]);

  useRealtime(realtimeChannel, (payload) => {
    const event = realtimePayloadSchema.safeParse(payload);

    if (event.success && event.data.threadId === threadId) reconcile();
  });
  useReconnect(reconcile);

  return { ...(adoption?.state ?? state), refresh };
}

export function useIndex() {
  const rpc = useRpc<GlanceRpcContract>();
  const pluginId = experimental_usePluginId();
  const request = useRef(0);
  const [cards, setCards] = useState<CardIndexEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const failure = useRef<ReturnType<typeof captureRefreshFailure> | null>(null);

  const refresh = useCallback(() => {
    const current = ++request.current;
    const diagnostic = failure.current?.diagnostic ?? null;
    const startedAt = performance.now();

    rpc.call("cards.index", diagnostic === null ? null : { diagnostic }).then(
      (result) => {
        if (failure.current?.diagnostic.id === diagnostic?.id) failure.current = null;

        if (current !== request.current) return;

        for (const key of indexedCards.keys())
          if (key.startsWith(`${pluginId}:`)) indexedCards.delete(key);

        for (const card of result.cards) indexedCards.set(`${pluginId}:${card.threadId}`, card);
        setCards(result.cards);
        setError(null);
      },
      (cause) => {
        failure.current ??= captureRefreshFailure(cause, startedAt);

        if (current !== request.current) return;
        setCards(null);
        setError("Glance could not refresh. Try again.");
      },
    );
  }, [pluginId, rpc]);

  useEffect(() => {
    refresh();
    window.addEventListener("online", refresh);

    return () => {
      window.removeEventListener("online", refresh);
      request.current += 1;
    };
  }, [refresh]);
  useRealtime(realtimeChannel, refresh);
  useReconnect(refresh);

  return { cards, error, refresh };
}
