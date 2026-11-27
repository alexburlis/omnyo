import { useCallback, useEffect, useRef, useSyncExternalStore } from "react";
import { ModelCache } from "./model-cache";
import {
  experimental_usePluginId,
  useRealtime,
  useRealtimeConnectionState,
  useRpc,
  type PluginComposerApi,
} from "@omnyo/plugin-sdk/app";
import {
  realtimeChannel,
  realtimePayloadSchema,
  type Board,
  type CanvasMode,
  type CanvasRpcContract,
} from "../contract";

import { hasModeMention } from "./mode-mention";

const modes = new ModelCache<CanvasMode>("Canvas could not load.");

const boards = new ModelCache<Board>("The board could not refresh. Try again.");

function useReconnect(refresh: () => void) {
  const connection = useRealtimeConnectionState();
  const previous = useRef(connection);

  useEffect(() => {
    if (connection === "connected" && previous.current !== "connected") refresh();
    previous.current = connection;
  }, [connection, refresh]);
}

function useThreadSignal(threadId: string, refresh: () => void) {
  useRealtime(realtimeChannel, (payload) => {
    const event = realtimePayloadSchema.safeParse(payload);

    if (event.success && event.data.threadId === threadId) refresh();
  });
  useReconnect(refresh);
}

export function useCanvasMode(threadId: string) {
  const rpc = useRpc<CanvasRpcContract>();

  const entry = useSyncExternalStore(
    useCallback((listener: () => void) => modes.subscribe(threadId, listener), [threadId]),
    () => modes.read(threadId),
  );

  const read = useCallback(async () => {
    const value = await rpc.call("mode.get", { threadId });
    const previous = modes.read(threadId).value;

    return previous !== null &&
      previous.canvas === value.canvas &&
      previous.unseen === value.unseen &&
      previous.startedBy === value.startedBy &&
      previous.movedTo === value.movedTo
      ? previous
      : value;
  }, [rpc, threadId]);

  const refresh = useCallback(() => modes.load(threadId, read, true), [read, threadId]);

  const accept = useCallback(
    (mode: CanvasMode) => {
      modes.accept(threadId, mode);

      if (!mode.canvas) boards.accept(threadId, null);
    },
    [threadId],
  );

  useEffect(() => modes.load(threadId, read), [read, threadId]);
  useEffect(() => {
    if (entry.value?.canvas === false) boards.accept(threadId, null);
  }, [entry.value, threadId]);
  useThreadSignal(threadId, refresh);

  return { mode: entry.value, failed: entry.error !== null, refresh, accept };
}

export type CanvasState = "loading" | "failed" | "off" | "pending" | "on";

function stateOf(mode: CanvasMode | null, failed: boolean, pending: boolean): CanvasState {
  if (mode?.canvas === true) return "on";

  if (pending) return "pending";

  if (mode !== null) return "off";

  return failed ? "failed" : "loading";
}

export function useCanvasState(threadId: string, composer: PluginComposerApi | null) {
  const pluginId = experimental_usePluginId();
  const { mode, failed, refresh, accept } = useCanvasMode(threadId);

  const pending = composer !== null && hasModeMention(composer.draft.mentions, pluginId);

  return {
    state: stateOf(mode, failed, pending),
    unseen: mode?.unseen === true,
    movedTo: mode?.movedTo ?? null,
    refresh,
    accept,
  };
}

export function useBoard(threadId: string) {
  const rpc = useRpc<CanvasRpcContract>();

  const entry = useSyncExternalStore(
    useCallback((listener: () => void) => boards.subscribe(threadId, listener), [threadId]),
    () => boards.read(threadId),
  );

  const read = useCallback(async () => {
    const { board } = await rpc.call("board.get", { threadId });
    const previous = boards.read(threadId).value;

    return board !== null &&
      previous !== null &&
      previous.threadId === board.threadId &&
      previous.revision === board.revision &&
      previous.seenRevision === board.seenRevision
      ? previous
      : board;
  }, [rpc, threadId]);

  const refresh = useCallback(() => boards.load(threadId, read, true), [read, threadId]);

  useEffect(
    () => boards.load(threadId, read, boards.read(threadId).value === null),
    [read, threadId],
  );
  useThreadSignal(threadId, refresh);

  return { board: entry.value, error: entry.error, refresh };
}
