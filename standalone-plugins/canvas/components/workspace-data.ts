import { useCallback, useEffect, useRef, useState } from "react";
import { useRealtime, useRpc } from "@omnyo/plugin-sdk/app";
import { z } from "zod";
import type { Board, HistorySummary, CanvasNode, CanvasRpcContract } from "../contract";
import { sourceRealtimeChannel, type NodeBinding, type SourceState } from "../source-contract";
import type { EditorActions, WorkbenchMode } from "./editor";
import { useUndoable } from "./undo";
import { boundSourceSignature } from "../lib/node-rendering";

const changedSource = z.object({ threadId: z.string() });

export function useWorkspaceEditor(
  threadId: string,
  board: Board | null,
  refresh: () => void,
  reference: (node: CanvasNode) => void,
  reportRender: (nodeId: string) => Promise<void>,
  workbench: WorkbenchMode | null = null,
) {
  const rpc = useRpc<CanvasRpcContract>();
  const undoable = useUndoable(threadId);
  const [sources, setSources] = useState<SourceState[]>([]);
  const [sourcesFor, setSourcesFor] = useState<string | null>(null);
  const [history, setHistory] = useState<HistorySummary | null>(null);
  const activeThread = useRef(threadId);
  activeThread.current = threadId;
  const historyRequest = useRef(0);
  const sourcesRequest = useRef(0);
  const historyLimit = useRef(20);
  const [error, setError] = useState<string | null>(null);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const historyFailure = useRef<string | null>(null);
  const [pending, setPending] = useState(0);
  const revision = board?.revision;

  const needsSources =
    board !== null &&
    (workbench === "sources" ||
      board.nodes.some(
        (node) => node.binding != null || (node.evidence?.sourceIds.length ?? 0) > 0,
      ));

  const bound = board === null ? "" : boundSourceSignature(board.nodes);
  const loadedKey = `${threadId}:${bound}`;

  const refreshSources = useCallback(() => {
    const request = ++sourcesRequest.current;

    return rpc.call("source.list", { threadId }).then(
      (value) => {
        if (activeThread.current === threadId && request === sourcesRequest.current) {
          setSources(value.sources);
          setSourcesFor(loadedKey);
        }
      },
      (reason) => {
        if (activeThread.current === threadId && request === sourcesRequest.current) {
          setSourcesFor(loadedKey);
          setError(reason instanceof Error ? reason.message : "Sources could not load");
        }
      },
    );
  }, [rpc, threadId, loadedKey]);

  const refreshHistory = useCallback(
    (limit = historyLimit.current) => {
      const request = ++historyRequest.current;
      historyLimit.current = limit;

      return rpc.call("board.historySummary", { threadId, limit, offset: 0 }).then(
        (value) => {
          if (activeThread.current !== threadId || request !== historyRequest.current) return;
          const failed = historyFailure.current;

          historyFailure.current = null;
          setHistory(value);
          setHistoryError(null);

          if (failed !== null) setError((current) => (current === failed ? null : current));
        },
        (reason) => {
          if (activeThread.current !== threadId || request !== historyRequest.current) return;
          const message = reason instanceof Error ? reason.message : "History could not load";

          historyFailure.current = message;
          setHistoryError(message);
          setError(message);
        },
      );
    },
    [rpc, threadId],
  );

  const readHistory = useCallback(
    (changeId: string) => rpc.call("board.historyDetail", { threadId, changeId }),
    [rpc, threadId],
  );

  const loadHistory = useCallback(
    () => refreshHistory(Math.min(200, historyLimit.current + 20)),
    [refreshHistory],
  );

  useEffect(() => {
    historyLimit.current = 20;
    setHistory(null);
    setSources([]);
    setSourcesFor(null);
    setError(null);
    setHistoryError(null);
    historyFailure.current = null;

    return () => {
      historyRequest.current += 1;
      sourcesRequest.current += 1;
    };
  }, [threadId]);

  useEffect(() => {
    if (revision !== undefined) refreshHistory();
  }, [revision, refreshHistory]);
  useEffect(() => {
    if (needsSources) void refreshSources();
  }, [needsSources, refreshSources]);
  useRealtime(sourceRealtimeChannel, (payload) => {
    const event = changedSource.safeParse(payload);

    if (needsSources && event.success && event.data.threadId === threadId) void refreshSources();
  });

  const run = useCallback(
    async <T>(action: () => Promise<T>, data = false) => {
      setPending((value) => value + 1);

      try {
        await action();

        if (data) refreshSources();
        else {
          refresh();
        }
      } catch (reason) {
        throw reason instanceof Error ? reason : new Error("Canvas could not save this change");
      } finally {
        setPending((value) => value - 1);
      }
    },
    [refresh, refreshSources],
  );

  const addModule = useCallback(
    async (binding: NodeBinding) => {
      const source = sources.find((entry) => entry.source.definition.id === binding.sourceId);
      await run(async () =>
        undoable(
          `Add ${source?.source.definition.title ?? binding.sourceId}`,
          await rpc.call("node.add", {
            threadId,
            nodes: [
              {
                kind: "html",
                html: "",
                title: source?.source.definition.title ?? binding.sourceId,
                width: 720,
                section: "Live data",
                binding,
              },
            ],
          }),
        ),
      );
    },
    [rpc, threadId, run, sources, undoable],
  );

  const actions: EditorActions = {
    readHistory,
    loadHistory,
    refreshHistory: () => refreshHistory(),
    inspect: (id) => rpc.call("node.inspect", { threadId, id }),
    edit: (input) =>
      run(async () =>
        undoable(input.label ?? "Edit module", await rpc.call("node.edit", { threadId, ...input })),
      ),
    verify: async (id) => {
      await reportRender(id);

      return rpc.call("node.verify", { threadId, id });
    },
    undo: (changeId) =>
      run(() =>
        rpc.call("board.undo", changeId === undefined ? { threadId } : { threadId, changeId }),
      ),
    redo: (changeId) =>
      run(() =>
        rpc.call("board.redo", changeId === undefined ? { threadId } : { threadId, changeId }),
      ),
    duplicate: (id) =>
      run(async () =>
        undoable(
          `Duplicate ${titleOf(board, id)}`,
          await rpc.call("node.duplicate", { threadId, id }),
        ),
      ),
    compose: (composition, label = "Arrange the board") =>
      run(async () =>
        undoable(
          label,
          await rpc.call("board.compose", {
            threadId,
            composition,
            expectedRevision: board?.revision,
          }),
        ),
      ),
    reference,
    pin: (node) =>
      run(async () =>
        undoable(
          `${node.pinned ? "Unpin" : "Pin"} ${node.title ?? node.id}`,
          await rpc.call("node.pin", { threadId, id: node.id, pinned: !node.pinned }),
        ),
      ),
    hide: (node) =>
      run(async () =>
        undoable(
          `Hide ${node.title ?? node.id}`,
          await rpc.call("node.archive", { threadId, id: node.id }),
        ),
      ),
    move: (id, position) =>
      run(async () =>
        undoable(
          `${position === null ? "Reset position of" : "Move"} ${titleOf(board, id)}`,
          await rpc.call("node.move", { threadId, id, position }),
        ),
      ),
    resetPosition: (node) =>
      run(async () =>
        undoable(
          `Reset position of ${node.title ?? node.id}`,
          await rpc.call("node.move", { threadId, id: node.id, position: null }),
        ),
      ),
    saveSource: (source) => run(() => rpc.call("source.put", { threadId, source }), true),
    refreshSource: (id) => run(() => rpc.call("source.refresh", { threadId, id }), true),
    pauseSource: (id, paused) =>
      run(() => rpc.call("source.pause", { threadId, id, paused }), true),
    pushDataset: (input) => run(() => rpc.call("source.push", { threadId, ...input }), true),
    addModule,
  };

  return {
    sources,
    sourcesLoaded: bound === "" || sourcesFor === loadedKey,
    history,
    historyError,
    error,
    clearError: () => setError(null),
    busy: pending > 0,
    actions,
    refreshSources,
  };
}

function titleOf(board: Board | null, id: string) {
  return board?.nodes.find((node) => node.id === id)?.title ?? id;
}
