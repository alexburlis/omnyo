import { useCallback, useEffect, useRef, useState } from "react";
import { useRealtime, useRpc } from "@omnyo/plugin-sdk/app";
import type { HistoryEntry, ListResult, rpcContract, WorkloadRow } from "../contract";
import { CHANGED_CHANNEL } from "../lib/names";

const HISTORY_SHOWN = 20;

type Options = { refreshOnOpen: boolean; withHistory: boolean };

export function workloadRows(list: ListResult | null): WorkloadRow[] {
  return (list?.hosts ?? []).flatMap((host) => host.threads.flatMap((thread) => thread.processes));
}

export function useLeftRunning(threadId: string | null, { refreshOnOpen, withHistory }: Options) {
  const rpc = useRpc<typeof rpcContract>();
  const [list, setList] = useState<ListResult | null>(null);
  const [history, setHistory] = useState<HistoryEntry[]>([]);
  const [error, setError] = useState<string | null>(null);
  const mounted = useRef(false);
  const generation = useRef(0);
  const pending = useRef(false);
  const queued = useRef<"read" | "refresh" | null>(null);
  const filter = useRef(threadId);

  filter.current = threadId;

  const load = useCallback(
    async (refresh: boolean): Promise<void> => {
      if (!mounted.current || document.visibilityState !== "visible") return;

      if (pending.current) {
        queued.current = refresh || queued.current === "refresh" ? "refresh" : "read";

        return;
      }

      pending.current = true;

      const started = generation.current;

      try {
        const [nextList, nextHistory] = await Promise.all([
          rpc.call(
            "list",
            filter.current === null ? { refresh } : { threadId: filter.current, refresh },
          ),
          withHistory ? rpc.call("history", { limit: HISTORY_SHOWN }) : null,
        ]);

        if (mounted.current && started === generation.current) {
          setList(nextList);
          setError(null);

          if (nextHistory !== null) setHistory(nextHistory.entries);
        }
      } catch (failure) {
        if (mounted.current && started === generation.current)
          setError(failure instanceof Error ? failure.message : "This list could not be loaded.");
      } finally {
        pending.current = false;

        const next = queued.current;

        queued.current = null;

        if (next !== null) void load(next === "refresh");
      }
    },
    [rpc, withHistory],
  );

  useEffect(() => {
    mounted.current = true;

    const onVisibilityChange = () => {
      void load(false);
    };

    document.addEventListener("visibilitychange", onVisibilityChange);

    return () => {
      mounted.current = false;
      generation.current += 1;
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [load]);

  useEffect(() => {
    generation.current += 1;
    setList(null);
    setError(null);

    void load(false).then(() => (refreshOnOpen ? load(true) : undefined));
  }, [load, refreshOnOpen, threadId]);

  useRealtime(CHANGED_CHANNEL, () => {
    void load(false);
  });

  return { rpc, list, history, error, load };
}
