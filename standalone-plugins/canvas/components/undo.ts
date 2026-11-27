import { useCallback } from "react";
import { experimental_useActionHistory, useRpc } from "@omnyo/plugin-sdk/app";
import type { CanvasRpcContract, MutationResult } from "../contract";

export function useUndoable(threadId: string) {
  const rpc = useRpc<CanvasRpcContract>();
  const { record } = experimental_useActionHistory();

  return useCallback(
    (label: string, result: MutationResult) => {
      const { changeId } = result;

      if (changeId === null) return;

      record({
        label,
        undo: async () => {
          await rpc.call("board.undo", { threadId, changeId });
        },
        redo: async () => {
          await rpc.call("board.redo", { threadId, changeId });
        },
      });
    },
    [record, rpc, threadId],
  );
}
