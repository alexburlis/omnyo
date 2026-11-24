import { useEffect, useState } from "react";
import { useSdk, useRealtimeConnectionState } from "@omnyo/plugin-sdk/app";
import type { CallbackWaitView } from "./callback-waits.js";

type CallbackSnapshot = {
  waits: readonly CallbackWaitView[];
  status: "loading" | "ready" | "error";
};

export function useCallbackWaits(): CallbackSnapshot {
  const [snapshot, setSnapshot] = useState<CallbackSnapshot>({
    waits: [],
    status: "loading",
  });

  const sdk = useSdk();
  const connection = useRealtimeConnectionState();

  useEffect(() => {
    let alive = true;
    let generation = 0;

    const refresh = async () => {
      const current = ++generation;

      try {
        const result = await sdk.experimental_attention.snapshot();

        if (alive && current === generation)
          setSnapshot({ waits: result.callbacks, status: "ready" });
      } catch {
        if (alive && current === generation)
          setSnapshot({ waits: [], status: "error" });
      }
    };

    const request = () => {
      if (alive) void refresh();
    };

    request();
    const stop = sdk.subscribe({ event: "thread:changed", callback: request });

    return () => {
      alive = false;
      stop();
    };
  }, [sdk, connection]);

  return snapshot;
}
