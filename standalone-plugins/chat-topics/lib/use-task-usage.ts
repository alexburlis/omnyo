import { useCallback, useEffect, useSyncExternalStore } from "react";
import { useSdk } from "@omnyo/plugin-sdk/app";
import type { PluginSidebarThread } from "@omnyo/plugin-sdk/app";
import {
  indexUsage,
  sampleUsage,
  usageSchema,
  type UsageReading,
  type UsageSnapshot,
  type UsageSample,
} from "./task-usage.ts";

export type TaskUsage =
  | { kind: "off" }
  | { kind: "loading" }
  | { kind: "failed" }
  | {
      kind: "ready";
      readings: ReadonlyMap<string, UsageReading>;
      snapshot: UsageSnapshot;
      history: ReadonlyMap<string, readonly UsageSample[]>;
      titles: ReadonlyMap<string, string>;
    };

const OFF = { kind: "off" } as const;

const listeners = new Set<() => void>();

const titles = new Map<string, string>();

let sidebarTitles = new Map<string, string>();

const requestedTitles = new Set<string>();

let state: TaskUsage = OFF;

let consumers = 0;

let owner: ReturnType<typeof useSdk> | null = null;

let timer: ReturnType<typeof setTimeout> | undefined;

let inFlight = false;

let generation = 0;

let history = new Map<string, readonly UsageSample[]>();

function allTitles() {
  return new Map([...titles, ...sidebarTitles]);
}

function notify() {
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);

  return () => {
    listeners.delete(listener);
  };
}

async function resolveTitles(sdk: ReturnType<typeof useSdk>, snapshot: UsageSnapshot, run: number) {
  const threadIds = [
    ...new Set(snapshot.hosts.flatMap((host) => host.threads.map((thread) => thread.threadId))),
  ].filter((id) => !titles.has(id) && !sidebarTitles.has(id) && !requestedTitles.has(id));

  if (threadIds.length === 0) return;

  for (const id of threadIds) requestedTitles.add(id);

  try {
    const batches: string[][] = [];

    for (let offset = 0; offset < threadIds.length; offset += 200)
      batches.push(threadIds.slice(offset, offset + 200));

    const results = await Promise.all(
      batches.map((ids) =>
        sdk.threads.list({ threadIds: ids, includeHidden: true, limit: ids.length }),
      ),
    );

    const threads = results.flat();

    if (run !== generation || consumers === 0) return;

    for (const thread of threads) if (thread.title) titles.set(thread.id, thread.title);

    if (state.kind === "ready") {
      state = { ...state, titles: allTitles() };
      notify();
    }
  } catch {
    if (run !== generation) return;

    for (const id of threadIds) requestedTitles.delete(id);
  }
}

async function refresh() {
  if (inFlight || consumers === 0 || owner === null) return;
  inFlight = true;
  const run = generation;
  const sdk = owner;

  try {
    const snapshot = await sdk.plugins.callRpc({
      pluginId: "leftover-processes",
      method: "usage",
      input: {},
      outputSchema: usageSchema,
    });

    if (run === generation && consumers > 0) {
      const at = Date.now();

      const currentIds = new Set(
        snapshot.hosts.flatMap((host) => host.threads.map((thread) => thread.threadId)),
      );

      for (const id of titles.keys()) if (!currentIds.has(id)) titles.delete(id);

      for (const id of requestedTitles) if (!currentIds.has(id)) requestedTitles.delete(id);
      history = new Map(
        snapshot.hosts.map((host) => [
          host.hostId,
          [...(history.get(host.hostId) ?? []), sampleUsage(host, at)].slice(-24),
        ]),
      );
      state = {
        kind: "ready",
        readings: indexUsage(snapshot),
        snapshot,
        history,
        titles: allTitles(),
      };
      notify();
      void resolveTitles(sdk, snapshot, run);
    }
  } catch {
    if (run === generation && consumers > 0) {
      history = new Map(
        [...history].map(([id, samples]) => [
          id,
          [...samples, { at: Date.now(), cpu: null, gpu: null, memory: null }].slice(-24),
        ]),
      );
      state = { kind: "failed" };
      notify();
    }
  } finally {
    inFlight = false;

    if (consumers > 0) timer = setTimeout(() => void refresh(), run === generation ? 5000 : 0);
  }
}

export function useTaskUsage(
  enabled: boolean,
  threads?: readonly PluginSidebarThread[],
): TaskUsage {
  const sdk = useSdk();

  const subscribeUsage = useCallback(
    (listener: () => void) => (enabled ? subscribe(listener) : () => {}),
    [enabled],
  );

  const usage = useSyncExternalStore(
    subscribeUsage,
    () => (enabled ? state : OFF),
    () => OFF,
  );

  useEffect(() => {
    if (!threads) return;

    const next = new Map(
      threads.flatMap((thread) => (thread.title ? [[thread.id, thread.title] as const] : [])),
    );

    const changed =
      next.size !== sidebarTitles.size ||
      [...next].some(([id, title]) => sidebarTitles.get(id) !== title);

    sidebarTitles = next;

    if (changed && state.kind === "ready") {
      state = { ...state, titles: allTitles() };
      notify();
    }
  }, [threads]);

  useEffect(() => {
    if (!enabled) return;
    owner = sdk;
    consumers += 1;

    if (consumers === 1) {
      generation += 1;
      state = { kind: "loading" };
      notify();
      clearTimeout(timer);
      void refresh();
    }

    return () => {
      consumers -= 1;

      if (consumers !== 0) return;
      generation += 1;
      clearTimeout(timer);
      owner = null;
      state = OFF;
      history = new Map();
      titles.clear();
      requestedTitles.clear();
      notify();
    };
  }, [enabled, sdk]);

  return enabled ? usage : OFF;
}
