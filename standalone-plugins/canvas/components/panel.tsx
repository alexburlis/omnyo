import { ReturnBoard } from "./project-return";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  experimental_Icon as Icon,
  experimental_useActionHistory,
  experimental_usePluginId,
  ThreadTitle,
  experimental_useAppNavigate,
  useComposer,
  useRpc,
  useRealtime,
  type PluginComposerApi,
  type PluginThreadPanelProps,
} from "@omnyo/plugin-sdk/app";
import {
  nodeMentionItem,
  nodeMentionProvider,
  type CanvasNode,
  type CanvasRpcContract,
  type IslandGroup,
  type HistorySummaryEntry,
} from "../contract";
import { islandGroups, updateIsland } from "../lib/composition";
import { nodeChange } from "../lib/layout";
import { BoardCanvas, type BoardCommands } from "./board";
import { AddBoardToProject } from "./project-adopt";
import { canvasNavigationTarget } from "../lib/frame-document";
import { useBoard, useCanvasState, type CanvasState } from "./thread-data";
import { closeFullScreen, openFullScreen, useFullScreenBoard } from "./fullscreen-state";
import { CanvasFullScreen } from "./fullscreen";
import { addModeMention } from "./mode-mention";
import { useIsCompactViewport } from "../ui/components/ui/hooks/use-compact-viewport";
import { projectPath } from "./project-route";
import type { NodeActions, NodeWorkspace } from "./node";
import { Outline } from "./outline";
import { EditorWorkbench, type WorkbenchMode } from "./editor";
import { useWorkspaceEditor } from "./workspace-data";
import { readRenderReports } from "./render-report";
import { useRenderReporting } from "./render-reporting";
import { resizeFlow } from "../lib/resize";
import { useUndoable } from "./undo";

export function CanvasPanel({ threadId }: PluginThreadPanelProps) {
  const activeComposer = useComposer();
  const scope = activeComposer.scope;
  const composer = scope.kind === "thread" && scope.threadId === threadId ? activeComposer : null;
  const { state, movedTo, refresh } = useCanvasState(threadId, composer);
  const compact = useIsCompactViewport();
  const fullScreen = useFullScreenBoard();

  useEffect(() => {
    if (!compact && fullScreen?.threadId === threadId) closeFullScreen();
  }, [compact, fullScreen, threadId]);

  if (state === "on" && compact && fullScreen?.threadId === threadId)
    return (
      <>
        <div className="cnv-notice">
          <Icon name="GridView" className="cnv-notice-icon" aria-hidden />
          <h3>Canvas is open full screen</h3>
          <button type="button" className="cnv-button" onClick={closeFullScreen}>
            Back to side panel
          </button>
        </div>
        <CanvasFullScreen opener={fullScreen.opener}>
          <BoardView
            threadId={threadId}
            composer={fullScreen.composer}
            compact={false}
            fullScreen
          />
        </CanvasFullScreen>
      </>
    );

  if (state === "on")
    return (
      <BoardView
        key={threadId}
        threadId={threadId}
        composer={composer}
        compact={compact}
        fullScreen={false}
      />
    );

  if (state === "off" && movedTo !== null)
    return <MovedNotice chat={movedTo} onRefresh={refresh} />;

  return <Notice state={state} composer={composer} onRetry={refresh} />;
}

function MovedNotice({ chat, onRefresh }: { chat: string; onRefresh(): void }) {
  const navigate = experimental_useAppNavigate();
  const rpc = useRpc<CanvasRpcContract>();

  const [section, setSection] = useState<{
    projectId: string;
    sectionId: string;
    title: string;
  } | null>(null);

  const [error, setError] = useState<string | null>(null);
  const inProject = chat.startsWith("sec_");
  useEffect(() => {
    if (!inProject) return;
    let live = true;
    void rpc.call("project.link", { threadId: chat }).then(
      (value) => {
        if (!live) return;
        setSection(value);

        if (value === null) setError("This section moved or is no longer available.");
      },
      (reason) => {
        if (live)
          setError(reason instanceof Error ? reason.message : "The project canvas could not load.");
      },
    );

    return () => {
      live = false;
    };
  }, [chat, inProject, rpc]);

  return (
    <div className="cnv-notice">
      <Icon name="GridView" className="cnv-notice-icon" aria-hidden />
      <h3>{inProject ? "In project canvas" : "This board moved to another chat"}</h3>
      <p className="cnv-muted">
        {inProject ? (section?.title ?? "Project canvas") : <ThreadTitle threadId={chat} />}
      </p>
      {error ? <p role="alert">{error}</p> : null}
      {error ? (
        <button type="button" className="cnv-button" onClick={onRefresh}>
          Retry
        </button>
      ) : null}
      <button
        type="button"
        className="cnv-button"
        data-variant="primary"
        disabled={inProject && section === null}
        onClick={() =>
          section
            ? navigate.toPluginPanel("p", {
                subPath: projectPath(section.projectId, { kind: "s", id: section.sectionId }),
              })
            : navigate.toThread(chat)
        }
      >
        {inProject ? "Open project canvas" : "Open that chat"}
      </button>
    </div>
  );
}

function Notice({
  state,
  composer,
  onRetry,
}: {
  state: Exclude<CanvasState, "on">;
  composer: PluginComposerApi | null;
  onRetry(): void;
}) {
  const pluginId = experimental_usePluginId();

  if (state === "loading")
    return (
      <div className="cnv-notice" aria-busy="true">
        <p className="cnv-muted">Loading board…</p>
      </div>
    );

  if (state === "failed")
    return (
      <div className="cnv-notice" role="alert">
        <p>Canvas could not load.</p>
        <button type="button" className="cnv-button" onClick={onRetry}>
          Retry
        </button>
      </div>
    );

  if (state === "pending")
    return (
      <div className="cnv-notice">
        <Icon name="GridView" className="cnv-notice-icon" aria-hidden />
        <h3>Canvas starts with your next message</h3>
        <p className="cnv-muted">Send it and the agent builds the board here.</p>
      </div>
    );

  function turnOn() {
    if (composer === null) return;
    addModeMention(composer, pluginId);
    composer.focus();
  }

  return (
    <div className="cnv-notice">
      <Icon name="GridView" className="cnv-notice-icon" aria-hidden />
      <h3>Canvas is off</h3>
      <p className="cnv-muted">
        Turn it on and the agent keeps a board of the work beside this chat.
      </p>
      <button
        type="button"
        className="cnv-button"
        data-variant="primary"
        disabled={composer === null}
        title={composer === null ? "Open this chat's composer to turn on Canvas" : undefined}
        onClick={turnOn}
      >
        Turn on Canvas
      </button>
    </div>
  );
}

function useWorkspace(threadId: string, onError: (message: string) => void): NodeWorkspace {
  const rpc = useRpc<CanvasRpcContract>();
  const [workspace, setWorkspace] = useState<NodeWorkspace>({ environmentId: null, hostId: null });

  useEffect(() => {
    let live = true;

    rpc.call("workspace.get", { threadId }).then(
      (result) => {
        if (live) setWorkspace(result);
      },
      (reason) => {
        if (live)
          onError(
            reason instanceof Error
              ? reason.message
              : "The chat workspace could not load, so file links are unavailable.",
          );
      },
    );

    return () => {
      live = false;
    };
  }, [rpc, threadId, onError]);

  return workspace;
}

export function BoardView({
  threadId,
  composer,
  compact,
  fullScreen,
}: {
  threadId: string;
  composer: PluginComposerApi | null;
  compact: boolean;
  fullScreen: boolean;
}) {
  const rpc = useRpc<CanvasRpcContract>();
  const { board, error, refresh } = useBoard(threadId);
  const [actionError, setActionError] = useState<string | null>(null);
  const workspace = useWorkspace(threadId, setActionError);
  const commands = useRef<BoardCommands | null>(null);
  const pendingPrompt = useRef<string | null>(null);
  const [baseline, setBaseline] = useState<number | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [workbench, setWorkbench] = useState<WorkbenchMode | null>(null);
  const body = useRef<HTMLDivElement>(null);
  const view = useRef<HTMLDivElement>(null);
  const navigateProject = experimental_useAppNavigate();
  const [justAdded, setJustAdded] = useState(false);
  const [confirmReturn, setConfirmReturn] = useState(false);

  const [projectLink, setProjectLink] = useState<{
    projectId: string;
    sectionId: string;
    title: string;
  } | null>(null);

  const refreshProjectLink = useCallback(() => {
    void rpc
      .call("project.link", { threadId })
      .then(setProjectLink, (reason) =>
        setActionError(
          reason instanceof Error ? reason.message : "The project link could not load.",
        ),
      );
  }, [rpc, threadId]);

  useEffect(refreshProjectLink, [refreshProjectLink, board?.revision]);
  useRealtime("canvas.project.changed", refreshProjectLink);

  const [selectedIsland, setSelectedIsland] = useState<string | null>(null);

  const select = useCallback((id: string | null) => {
    setSelected(id);
    setSelectedIsland(null);

    if (id !== null) setWorkbench((current) => (current === null ? null : "inspect"));
  }, []);

  const selectIsland = useCallback((id: string | null) => {
    setSelectedIsland(id);
    setSelected(null);

    if (id !== null) setWorkbench("inspect");
  }, []);

  useEffect(() => {
    if (board !== null && baseline === null) setBaseline(board.seenRevision);
  }, [baseline, board]);

  const revision = board?.revision ?? 0;

  useEffect(() => {
    if (board === null || revision <= board.seenRevision) return;

    const timer = window.setTimeout(() => {
      if (document.visibilityState === "visible")
        rpc.call("board.markSeen", { threadId, revision }).catch(() => undefined);
    }, 2000);

    return () => window.clearTimeout(timer);
  }, [board, revision, rpc, threadId]);

  const actions = useMemo<NodeActions>(
    () => ({
      async choose(_node, option) {
        if (composer === null) throw new Error("The composer is not available");

        const draft = composer.draft;

        composer.replace({ text: option, mentions: [], attachments: [] });

        try {
          await composer.submit({ experimental_data: null });
        } finally {
          composer.replace(draft);
        }
      },
    }),
    [composer],
  );

  const selectedNode: CanvasNode | null = board?.nodes.find((node) => node.id === selected) ?? null;

  const selectedIslandGroup: IslandGroup | null =
    (board?.composition &&
      islandGroups(board.composition.root).find((island) => island.id === selectedIsland)) ||
    null;

  const counts = useMemo(() => {
    const seen = baseline ?? board?.seenRevision ?? revision;
    const changes = (board?.nodes ?? []).map((node) => nodeChange(node, seen));

    return {
      created: changes.filter((change) => change === "new").length,
      updated: changes.filter((change) => change === "updated").length,
    };
  }, [baseline, board?.nodes, board?.seenRevision, revision]);

  const setCommands = useCallback((next: BoardCommands) => {
    commands.current = next;
  }, []);

  useEffect(() => {
    const id = pendingPrompt.current;

    if (id === null || !board?.nodes.some((node) => node.id === id)) return;
    pendingPrompt.current = null;
    commands.current?.focus([`node:${id}`]);
  }, [board]);

  const reference = useCallback(
    (node: CanvasNode) => {
      if (composer === null) return;
      composer.insert(
        [
          {
            provider: nodeMentionProvider,
            id: nodeMentionItem(threadId, node.id),
            label: node.title ?? node.id,
          },
          " ",
        ],
        { at: "end" },
      );
      composer.focus();
    },
    [composer, threadId],
  );

  const reportRender = useCallback(
    async (nodeId?: string) => {
      const root = body.current;

      if (root === null || !root.isConnected || board === null)
        throw new Error("Canvas render is not available. Open Canvas and try Verify again.");
      const reports = readRenderReports(root, board, compact);

      if (nodeId !== undefined && !reports.some((report) => report.nodeId === nodeId))
        throw new Error("The selected module is not rendered. Open Canvas and try Verify again.");

      if (reports.length > 0) await rpc.call("render.report", { threadId, reports });
    },
    [board, compact, rpc, threadId],
  );

  const editor = useWorkspaceEditor(threadId, board, refresh, reference, reportRender, workbench);
  const ledger = experimental_useActionHistory();
  const undoable = useUndoable(threadId);

  const jumpToNode = useCallback(
    (id: string) => {
      const node = board?.nodes.find((node) => node.id === id);

      if (node === undefined) {
        setActionError("That canvas module is no longer available");

        return;
      }

      const root = compact
        ? body.current?.querySelector<HTMLElement>(".cnv-outline")
        : body.current;

      const before = {
        viewport: commands.current?.capture(),
        selected,
        selectedIsland,
        scrollTop: root?.scrollTop ?? 0,
        scrollLeft: root?.scrollLeft ?? 0,
      };

      const behavior = window.matchMedia("(prefers-reduced-motion: reduce)").matches
        ? "instant"
        : "smooth";

      const go = () => {
        commands.current?.focus([`node:${id}`]);
        setSelected(id);
        setSelectedIsland(null);
        body.current?.focus({ preventScroll: true });

        if (compact)
          body.current
            ?.querySelector(`[data-node-id="${CSS.escape(id)}"]`)
            ?.scrollIntoView({ behavior, block: "center" });
      };

      go();
      const after = commands.current?.capture();
      ledger.record({
        label: `Jump to ${node.title ?? id}`,
        undo: async () => {
          if (before.viewport) commands.current?.restore(before.viewport);
          setSelected(before.selected);
          setSelectedIsland(before.selectedIsland);

          if (compact) root?.scrollTo({ top: before.scrollTop, left: before.scrollLeft, behavior });
        },
        redo: async () => {
          go();

          if (after) commands.current?.restore(after);
        },
      });
    },
    [board, compact, ledger.record, selected, selectedIsland],
  );

  useEffect(() => {
    const root = body.current;

    const navigate = (event: Event) => {
      if (!(event instanceof CustomEvent)) return;
      const target = canvasNavigationTarget.safeParse(event.detail);

      if (target.success) jumpToNode(target.data);
    };

    root?.addEventListener("canvas-navigate", navigate);

    return () => root?.removeEventListener("canvas-navigate", navigate);
  }, [jumpToNode]);

  const historyActivity = useRef<Map<string, string> | null>(null);

  useEffect(() => {
    if (editor.history === null) return;
    const previous = historyActivity.current;
    historyActivity.current = new Map(
      editor.history.entries.map((entry) => [
        entry.id,
        `${entry.lastActivityAt}:${entry.lastAction}:${entry.state}`,
      ]),
    );

    if (previous === null) return;

    const previousActivityAt = Math.max(
      0,
      ...[...previous.values()].map((activity) => Number(activity.split(":")[0])),
    );

    const replayed = editor.history.entries.filter(
      (entry) =>
        entry.lastAction !== "edit" &&
        (previous.has(entry.id) || entry.lastActivityAt > previousActivityAt) &&
        previous.get(entry.id) !== `${entry.lastActivityAt}:${entry.lastAction}:${entry.state}`,
    );

    const latest = replayed.sort((left, right) => right.lastActivityAt - left.lastActivityAt)[0];

    if (latest !== undefined) focusHistory(latest);
  }, [editor.history]);

  function focusHistory(entry: HistorySummaryEntry) {
    const targets = entry.targets;
    commands.current?.focus(targets);

    if (compact) {
      const node = targets.find((target) => target.startsWith("node:"))?.slice(5);

      if (node !== undefined)
        body.current
          ?.querySelector(`[data-node-id="${CSS.escape(node)}"]`)
          ?.scrollIntoView({ behavior: "smooth", block: "center" });
    }
  }

  function focusChanges(kind: "new" | "updated") {
    if (board === null) return;
    const seen = baseline ?? board.seenRevision;

    const targets = board.nodes
      .filter((node) => nodeChange(node, seen) === kind)
      .map((node) => `node:${node.id}`);

    commands.current?.focus(targets);

    if (compact && targets[0] !== undefined)
      body.current
        ?.querySelector(`[data-node-id="${CSS.escape(targets[0].slice(5))}"]`)
        ?.scrollIntoView({ behavior: "smooth", block: "center" });
  }

  const move = useCallback(
    (id: string, position: { x: number; y: number } | null) => {
      void editor.actions
        .move(id, position)
        .catch((reason) =>
          setActionError(reason instanceof Error ? reason.message : "The move could not be saved"),
        );
    },
    [editor.actions],
  );

  useRenderReporting({
    root: body,
    report: reportRender,
    enabled: board !== null,
    onError: () => setActionError("Render verification could not report. Try Verify again."),
  });

  const moveIsland = useCallback(
    (id: string, offset: { x: number; y: number } | null) => {
      if (!board?.composition) return;

      void editor.actions
        .compose(
          updateIsland(board.composition, id, { offset }),
          `${offset === null ? "Reset position of" : "Move"} ${islandGroups(board.composition.root).find((island) => island.id === id)?.island.title ?? id}`,
        )
        .catch((reason) =>
          setActionError(
            reason instanceof Error ? reason.message : "The island move could not be saved",
          ),
        );
    },
    [board?.composition, editor.actions],
  );

  const resize = useCallback(
    (id: string, width: number, trackUnit?: number) => {
      const node = board?.nodes.find((entry) => entry.id === id);

      if (!node || !board) return;

      const currentWidth =
        body.current?.querySelector<HTMLElement>(`[data-node-id="${id}"]`)?.offsetWidth ?? width;

      const composition =
        node.width == null && board.composition
          ? resizeFlow(board.composition, id, currentWidth, width, trackUnit)
          : null;

      if (composition === null && trackUnit !== undefined && node.width == null) return;

      const save = async () => {
        if (composition) await editor.actions.compose(composition, `Resize ${node.title ?? id}`);
        else {
          const current = await editor.actions.inspect(id);
          await editor.actions.edit({
            id,
            fields: { width },
            expectedVersions: { width: current.fieldVersions.width ?? 0 },
            label: `Resize ${node.title ?? id}`,
          });
        }
      };

      void save().catch((reason) =>
        setActionError(
          reason instanceof Error ? reason.message : "The new width could not be saved",
        ),
      );
    },
    [board, editor.actions],
  );

  const createPrompt = useCallback(
    (position: { x: number; y: number }) => {
      const id = `prompt-${crypto.randomUUID().slice(0, 8)}`;
      void (async () => {
        undoable(
          "Add conversation",
          await rpc.call("node.add", {
            threadId,
            nodes: [{ id, kind: "note", title: "Conversation", width: 640, conversation: { id } }],
          }),
        );
        undoable("Place conversation", await rpc.call("node.move", { threadId, id, position }));
        pendingPrompt.current = id;
        refresh();
      })().catch((reason) =>
        setActionError(
          reason instanceof Error ? reason.message : "The conversation could not be added",
        ),
      );
    },
    [rpc, threadId, refresh, undoable],
  );

  const floating = !fullScreen && !compact;
  const toolbarElement = useRef<HTMLDivElement>(null);
  const toolButtons = useRef(new Map<WorkbenchMode, HTMLButtonElement>());

  const closeWorkbench = useCallback(() => {
    const target = workbench === null ? undefined : toolButtons.current.get(workbench);

    setWorkbench(null);
    (target ?? body.current)?.focus({ preventScroll: true });
  }, [workbench]);

  const editorError =
    workbench === "changes" && editor.error === editor.historyError ? null : editor.error;

  const [topInset, setTopInset] = useState(0);

  useLayoutEffect(() => {
    const target = toolbarElement.current;

    if (!floating || target === null) {
      setTopInset(0);

      return;
    }

    const measure = () => setTopInset(Math.ceil(target.offsetTop + target.offsetHeight + 4));

    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(target);

    return () => observer.disconnect();
  }, [floating]);

  const toolbar = (
    <div
      ref={toolbarElement}
      className="cnv-toolbar"
      data-full-screen={fullScreen}
      data-floating={floating}
      role="group"
      aria-label="Canvas tools"
    >
      <div className="cnv-toolbar-changes">
        {fullScreen ? <span className="cnv-toolbar-title">Canvas</span> : null}
        {counts.created > 0 ? (
          <button
            type="button"
            className="cnv-chip"
            data-tone="new"
            title="Show new modules"
            onClick={() => focusChanges("new")}
          >
            {counts.created} new
          </button>
        ) : null}
        {counts.updated > 0 ? (
          <button
            type="button"
            className="cnv-chip"
            data-tone="attention"
            title="Show updated modules"
            onClick={() => focusChanges("updated")}
          >
            {counts.updated} updated
          </button>
        ) : null}
        {counts.created + counts.updated > 0 ? (
          <span className="cnv-muted">since you last looked</span>
        ) : null}
      </div>
      <div className="cnv-toolbar-tools">
        {projectLink === null ? (
          <>
            <AddBoardToProject
              threadId={threadId}
              onLinked={(link) => {
                setProjectLink(link);
                setJustAdded(true);
              }}
            />
            <span className="cnv-tool-divider" aria-hidden="true" />
          </>
        ) : null}
        <button
          type="button"
          className="cnv-tool"
          aria-label="New conversation"
          title="New conversation · double-click the canvas"
          onClick={() =>
            compact ? createPrompt({ x: 40, y: 40 }) : commands.current?.createPrompt()
          }
        >
          <Icon name="MessageSquarePlus" aria-hidden />
        </button>
        <button
          type="button"
          className="cnv-tool"
          aria-label="Undo"
          title="Undo your last action"
          disabled={!ledger.canUndo}
          onClick={() =>
            void Promise.resolve(ledger.undo()).catch((reason) =>
              setActionError(reason instanceof Error ? reason.message : "Undo failed"),
            )
          }
        >
          <Icon name="ArrowTurnBackward" aria-hidden />
        </button>
        <button
          type="button"
          className="cnv-tool"
          aria-label="Redo"
          title="Redo the last action you undid"
          disabled={!ledger.canRedo}
          onClick={() =>
            void Promise.resolve(ledger.redo()).catch((reason) =>
              setActionError(reason instanceof Error ? reason.message : "Redo failed"),
            )
          }
        >
          <Icon name="ArrowTurnForward" aria-hidden />
        </button>
        <span className="cnv-tool-divider" aria-hidden="true" />
        {workbenchTools.map((tool) => (
          <button
            key={tool.mode}
            ref={(element) => {
              if (element === null) toolButtons.current.delete(tool.mode);
              else toolButtons.current.set(tool.mode, element);
            }}
            type="button"
            className="cnv-tool"
            aria-pressed={workbench === tool.mode}
            aria-label={tool.label}
            title={tool.title}
            onClick={() => setWorkbench((current) => (current === tool.mode ? null : tool.mode))}
          >
            <Icon name={tool.icon} aria-hidden />
          </button>
        ))}
        <span className="cnv-tool-divider" aria-hidden="true" />
        {compact ? null : (
          <button
            type="button"
            className="cnv-tool"
            aria-label="Jump to latest"
            title="Jump to the latest change"
            onClick={() => commands.current?.latest()}
          >
            <Icon name="Target" aria-hidden />
          </button>
        )}
        {fullScreen ? (
          <button
            type="button"
            className="cnv-tool"
            aria-keyshortcuts="Escape"
            aria-label="Exit full screen"
            title="Exit full screen (Esc)"
            onClick={closeFullScreen}
          >
            <Icon name="Minimize2" aria-hidden />
          </button>
        ) : compact ? (
          <button
            type="button"
            className="cnv-tool"
            aria-label="Full screen"
            title="Full screen"
            onClick={() => openFullScreen(threadId, composer)}
          >
            <Icon name="Maximize2" aria-hidden />
          </button>
        ) : null}
      </div>
    </div>
  );

  return (
    <div ref={view} className="cnv-view">
      {floating ? null : toolbar}
      {error === null ? null : (
        <div className="cnv-toolbar cnv-state" data-state="failed" role="alert">
          {error}
          <button type="button" className="cnv-button" onClick={refresh}>
            Retry
          </button>
        </div>
      )}
      {editorError || actionError ? (
        <div className="cnv-toolbar cnv-editor-error" role="alert">
          {editorError ?? actionError}
          <button
            type="button"
            className="cnv-button"
            onClick={() => {
              editor.clearError();
              setActionError(null);
            }}
          >
            Dismiss
          </button>
        </div>
      ) : null}
      {projectLink && confirmReturn ? (
        <ReturnBoard
          projectId={projectLink.projectId}
          sectionId={projectLink.sectionId}
          onClose={() => setConfirmReturn(false)}
          onReturned={() => {
            setConfirmReturn(false);
            setProjectLink(null);
            setJustAdded(false);
            refresh();
          }}
        />
      ) : null}
      {projectLink ? (
        <div className="cnv-toolbar cnv-project-link" role="status">
          <span>This board lives in the project canvas.</span>
          <button
            type="button"
            className="cnv-button"
            onClick={() =>
              navigateProject.toPluginPanel("p", {
                subPath: `${projectLink.projectId}/s/${projectLink.sectionId}`,
              })
            }
          >
            Open {projectLink.title}
          </button>
          {justAdded ? (
            <button type="button" className="cnv-button" onClick={() => setConfirmReturn(true)}>
              Return to chat
            </button>
          ) : null}
        </div>
      ) : null}
      <div className="cnv-workspace">
        <div
          className="cnv-body"
          tabIndex={-1}
          ref={body}
          onClickCapture={(event) => {
            const anchor = event.target instanceof Element ? event.target.closest("a[href]") : null;
            const href = anchor?.getAttribute("href");

            if (
              event.button !== 0 ||
              event.metaKey ||
              event.ctrlKey ||
              event.shiftKey ||
              event.altKey ||
              !href?.startsWith("#canvas-node-")
            )
              return;
            event.preventDefault();
            event.stopPropagation();
            const id = href.slice("#canvas-node-".length);

            jumpToNode(id);
          }}
        >
          {floating ? toolbar : null}
          {board === null ? (
            error === null ? (
              <div className="cnv-notice" aria-busy="true">
                <p className="cnv-muted">Loading board…</p>
              </div>
            ) : null
          ) : compact ? (
            <Outline
              board={board}
              baseline={baseline ?? board.seenRevision}
              workspace={workspace}
              actions={actions}
              selected={selected}
              sources={editor.sources}
              onSelect={select}
            />
          ) : (
            <BoardCanvas
              board={board}
              baseline={baseline ?? board.seenRevision}
              workspace={workspace}
              actions={actions}
              selected={selected}
              selectedIsland={selectedIsland}
              sources={editor.sources}
              sourcesLoaded={editor.sourcesLoaded}
              onSelect={select}
              onSelectIsland={selectIsland}
              onMove={move}
              onIslandMove={moveIsland}
              onWidthChange={resize}
              onCommands={setCommands}
              onCreatePrompt={createPrompt}
              topInset={topInset}
            />
          )}
        </div>
        {workbench !== null && board !== null ? (
          <EditorWorkbench
            threadId={threadId}
            mode={workbench}
            onMode={setWorkbench}
            onClose={closeWorkbench}
            board={board}
            selectedNode={selectedNode}
            selectedIsland={selectedIslandGroup}
            onSelectNode={select}
            onMoveIsland={moveIsland}
            sources={editor.sources}
            history={editor.history}
            historyError={editor.historyError}
            busy={editor.busy}
            actions={editor.actions}
          />
        ) : null}
      </div>
    </div>
  );
}

const workbenchTools: ReadonlyArray<{
  mode: WorkbenchMode;
  icon: string;
  label: string;
  title: string;
}> = [
  { mode: "inspect", icon: "SlidersHorizontal", label: "Inspect", title: "Inspect the selection" },
  { mode: "changes", icon: "Clock", label: "Changes", title: "Changes" },
  { mode: "sources", icon: "Plug02", label: "Sources", title: "Sources" },
];
