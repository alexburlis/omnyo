import { useEffect, useSyncExternalStore } from "react";
import { z } from "zod";
import { useSdk } from "@omnyo/plugin-sdk/app";
import { coalesce } from "./coalesce.ts";
import type { GlanceCard } from "./feed.ts";
import {
  cardSchema,
  mergeIndex,
  missingGlanceSchema,
  onCardChange,
  type CardPatch,
} from "./glance-changes.ts";

const indexSchema = z.object({ cards: z.array(cardSchema) });

export interface GlanceState {
  status: "loading" | "ready" | "unavailable";
  cards: ReadonlyMap<string, GlanceCard>;
}

type Sdk = ReturnType<typeof useSdk>;

const REFRESH_DELAY = 3000;

const REFRESH_INTERVAL = 60_000;

let state: GlanceState = { status: "loading", cards: new Map() };

const listeners = new Set<() => void>();

let consumers = 0;

let client: Sdk | null = null;

let inflight = false;

let absent = false;

let again = false;

let interval: ReturnType<typeof setInterval> | undefined;

const patches = new Map<string, CardPatch>();

function emit(next: GlanceState) {
  state = next;

  for (const listener of listeners) listener();
}

function refresh() {
  if (client === null || absent) return;

  if (inflight) {
    again = true;

    return;
  }

  inflight = true;
  const requestedAt = Date.now();

  client.plugins
    .callRpc({ pluginId: "glance", method: "cards.index", input: null, outputSchema: indexSchema })
    .then(
      (result) => {
        for (const [threadId, patch] of patches)
          if (patch.at < requestedAt) patches.delete(threadId);

        emit({
          status: "ready",
          cards: mergeIndex(
            new Map(result.cards.map((card) => [card.threadId, card])),
            patches,
            requestedAt,
          ),
        });
      },
      (error) => {
        absent = missingGlanceSchema.safeParse(error).success;
        emit({ status: "unavailable", cards: state.cards });
      },
    )
    .finally(() => {
      inflight = false;

      if (again) {
        again = false;
        pending.schedule();
      }
    });
}

const pending = coalesce(() => refresh(), REFRESH_DELAY);

function subscribe(listener: () => void) {
  listeners.add(listener);

  return () => {
    listeners.delete(listener);
  };
}

function snapshot() {
  return state;
}

export function useGlanceCards(): GlanceState {
  const sdk = useSdk();

  useEffect(() => {
    client = sdk;
    consumers += 1;

    if (consumers === 1) {
      refresh();
      interval = setInterval(refresh, REFRESH_INTERVAL);
    }

    const stopCards = onCardChange(window, (change) => {
      absent = false;

      if (change === null) {
        pending.schedule(0);

        return;
      }

      patches.set(change.threadId, { card: change.card, at: Date.now() });
      emit({ ...state, cards: mergeIndex(state.cards, patches, 0) });
    });

    const stopThreads = sdk.subscribe({
      event: "thread:changed",
      callback: () => pending.schedule(),
    });

    const stopConnection = sdk.subscribe({
      event: "realtime:connection",
      callback: (event) => {
        if (event.state !== "connected") return;
        absent = false;
        pending.schedule(0);
      },
    });

    return () => {
      stopCards();
      stopThreads();
      stopConnection();
      consumers -= 1;

      if (consumers === 0) {
        clearInterval(interval);
        pending.cancel();
      }
    };
  }, [sdk]);

  return useSyncExternalStore(subscribe, snapshot);
}
