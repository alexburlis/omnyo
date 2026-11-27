import { useCallback, useEffect, useRef, useState } from "react";
import { useRpc, type ExperimentalSidebarEntryStatus } from "@omnyo/plugin-sdk/app";
import type { rpcContract } from "../lib/contract.ts";
import { ROW_POLL_MS, rowStatus, type RowLoad } from "./chief-logic.ts";
import { useDeckPrefetch } from "./deck-store.ts";
import { useChiefChanged } from "./use-chief-changed.ts";

export function useChiefRowStatus(): ExperimentalSidebarEntryStatus | null {
  const rpc = useRpc<typeof rpcContract>();
  const [load, setLoad] = useState<RowLoad | null>(null);
  const sequence = useRef(0);

  const refresh = useCallback(() => {
    sequence.current += 1;
    const current = sequence.current;

    rpc.call("status").then(
      (status) => {
        if (current === sequence.current) setLoad({ kind: "loaded", status });
      },
      () => {
        if (current === sequence.current) setLoad({ kind: "failed" });
      },
    );
  }, [rpc]);

  useEffect(() => {
    refresh();
    const timer = window.setInterval(refresh, ROW_POLL_MS);

    return () => window.clearInterval(timer);
  }, [refresh]);

  useChiefChanged(refresh);
  useDeckPrefetch();

  return load === null ? null : rowStatus(load);
}
