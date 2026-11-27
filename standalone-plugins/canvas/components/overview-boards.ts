import { useCallback, useEffect, useRef, useState } from "react";
import { useRealtime, useRpc } from "@omnyo/plugin-sdk/app";
import { realtimeChannel, realtimePayloadSchema, type CanvasRpcContract } from "../contract";

import type { OverviewBoard } from "./overview-layout";

export function useOverviewBoards(sectionIds: readonly string[]) {
  const rpc = useRpc<CanvasRpcContract>();
  const [boards, setBoards] = useState<ReadonlyMap<string, OverviewBoard>>(new Map());
  const requests = useRef(new Map<string, Promise<void>>());

  const load = useCallback(
    (sectionId: string) => {
      const pending = requests.current.get(sectionId);

      if (pending) return pending;

      const request = rpc
        .call("board.get", { board: { sectionId } })
        .then(({ board }) => {
          if (board === null) throw new Error("Section board is unavailable");

          return { kind: "ready", board } satisfies OverviewBoard;
        })
        .catch((): OverviewBoard => ({ kind: "error" }))
        .then((result) => {
          setBoards((current) => {
            const previous = current.get(sectionId);

            if (
              previous?.kind === "ready" &&
              result.kind === "ready" &&
              previous.board.revision === result.board.revision &&
              previous.board.seenRevision === result.board.seenRevision
            )
              return current;

            return new Map(current).set(sectionId, result);
          });
        })
        .finally(() => requests.current.delete(sectionId));

      requests.current.set(sectionId, request);

      return request;
    },
    [rpc],
  );

  useEffect(() => {
    let stopped = false;
    let cursor = 0;
    const workers = Math.min(sectionIds.length, 4);
    setBoards((current) => {
      const active = new Map(
        sectionIds.flatMap((id) => {
          const row = current.get(id);

          return row ? [[id, row] as const] : [];
        }),
      );

      return active.size === current.size ? current : active;
    });

    for (let worker = 0; worker < workers; worker += 1)
      void (async () => {
        while (!stopped && cursor < sectionIds.length) {
          const id = sectionIds[cursor++];

          if (id !== undefined) await load(id);
        }
      })();

    return () => {
      stopped = true;
    };
  }, [sectionIds, load]);

  useRealtime(realtimeChannel, (payload) => {
    const event = realtimePayloadSchema.safeParse(payload);

    if (event.success && sectionIds.includes(event.data.threadId)) void load(event.data.threadId);
  });

  return { boards, load };
}
