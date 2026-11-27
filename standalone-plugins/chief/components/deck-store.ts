import { useCallback, useEffect, useSyncExternalStore } from "react";
import { useRpc } from "@omnyo/plugin-sdk/app";
import type { DeckView, rpcContract } from "../lib/contract.ts";
import { createLoadCache } from "./deck-cache.ts";
import { REFRESH_MS } from "./deck-logic.ts";
import { useChiefChanged } from "./use-chief-changed.ts";

const BOOT_PREFETCH_MS = 2_000;

const STALE_AFTER_MS = 15_000;

const deck = createLoadCache<DeckView>();

function useDeckLoad(): () => Promise<DeckView> {
  const rpc = useRpc<typeof rpcContract>();

  return useCallback(() => rpc.call("deck"), [rpc]);
}

export function useDeckPrefetch(): void {
  const load = useDeckLoad();

  useEffect(() => {
    const timer = window.setTimeout(() => {
      if (deck.get().loadedAt === null) deck.refresh(load);
    }, BOOT_PREFETCH_MS);

    return () => window.clearTimeout(timer);
  }, [load]);

  useChiefChanged(() => deck.changed(load));
}

export interface Deck {
  value: DeckView | null;
  error: string | null;
  updating: boolean;
  refresh: () => void;
}

export function useDeck(): Deck {
  const load = useDeckLoad();
  const snapshot = useSyncExternalStore(deck.subscribe, deck.get, deck.get);
  const refresh = useCallback(() => deck.refresh(load), [load]);

  useEffect(() => {
    const unwatch = deck.watch();

    refresh();

    const onVisible = () => {
      if (document.visibilityState === "visible") refresh();
    };

    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", onVisible);

    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") refresh();
    }, REFRESH_MS);

    return () => {
      unwatch();
      window.removeEventListener("focus", refresh);
      document.removeEventListener("visibilitychange", onVisible);
      window.clearInterval(timer);
    };
  }, [refresh]);

  useChiefChanged(refresh);

  return {
    value: snapshot.value,
    error: snapshot.error,
    updating:
      snapshot.loading &&
      snapshot.loadedAt !== null &&
      snapshot.loadedAt < Date.now() - STALE_AFTER_MS,
    refresh,
  };
}
