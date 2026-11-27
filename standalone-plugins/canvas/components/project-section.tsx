import { memo, useEffect, useState } from "react";
import { useRealtime, useRpc } from "@omnyo/plugin-sdk/app";
import type { Board, CanvasNode, CanvasRpcContract } from "../contract";
import type { ProjectSection } from "../project-contract";
import type { Rect } from "../lib/layout";
import type { SemanticDetail } from "../lib/semantic";
import { boundSourceSignature } from "../lib/node-rendering";
import { BoardLayer, useBoardLayer } from "./board-layer";
import type { NodeWorkspace } from "./node";
import { sourceRealtimeChannel, type SourceState } from "../source-contract";
import { z } from "zod";

export type ProjectLayerModel = ReturnType<typeof useBoardLayer>;

export const ProjectSectionLayer = memo(function ProjectSectionLayer({
  section,
  board,
  inView,
  zoom,
  detail,
  showContentAtAnyZoom = false,
  selected,
  workspace,
  sources,
  onSelect,
  onSelectIsland,
  onGeometry,
  onMoveNode,
  onMoveIsland,
  onSources,
}: {
  section: ProjectSection;
  board: Board;
  inView: boolean;
  zoom: number;
  detail: SemanticDetail;
  showContentAtAnyZoom?: boolean;
  selected: string | null;
  workspace: NodeWorkspace;
  sources: readonly SourceState[];
  onSelect(sectionId: string, node: CanvasNode): void;
  onSelectIsland(sectionId: string, islandId: string): void;
  onGeometry(sectionId: string, layer: ProjectLayerModel): void;
  onSources(sectionId: string, sources: readonly SourceState[]): void;
  onMoveNode?(sectionId: string, id: string, position: { x: number; y: number }): void;
  onMoveIsland?(sectionId: string, id: string, position: { x: number; y: number }): void;
}) {
  const rpc = useRpc<CanvasRpcContract>();
  const [sectionWorkspace, setSectionWorkspace] = useState(workspace);
  const [sectionSources, setSectionSources] = useState<readonly SourceState[]>(sources);
  const bound = boundSourceSignature(board.nodes);
  const [loadedFor, setLoadedFor] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [sourceRevision, setSourceRevision] = useState(0);
  useRealtime(sourceRealtimeChannel, (payload) => {
    const event = z.object({ threadId: z.string() }).safeParse(payload);

    if (event.success && event.data.threadId === section.id)
      setSourceRevision((revision) => revision + 1);
  });
  const loaded = bound === "" || loadedFor === bound;

  useEffect(() => {
    if (loaded) onSources(section.id, sources.length > 0 ? sources : sectionSources);
  }, [section.id, sources, sectionSources, onSources, loaded]);

  useEffect(() => {
    let active = true;

    if (section.originThreadId)
      void rpc.call("workspace.get", { threadId: section.originThreadId }).then(
        (value) => {
          if (active) setSectionWorkspace(value);
        },
        (reason) => {
          if (active)
            setLoadError(
              reason instanceof Error ? reason.message : "The section workspace could not load.",
            );
        },
      );

    if (bound !== "")
      void rpc.call("source.list", { board: { sectionId: section.id } }).then(
        (value) => {
          if (active) {
            setSectionSources(value.sources);
            setLoadedFor(bound);
            setLoadError(null);
          }
        },
        (reason) => {
          if (active) {
            setLoadedFor(bound);
            setLoadError(
              reason instanceof Error ? reason.message : "Section sources could not load.",
            );
          }
        },
      );

    return () => {
      active = false;
    };
  }, [rpc, section.id, section.originThreadId, board.revision, sourceRevision, bound]);

  const tilesOnly = detail === "map";

  useEffect(() => {
    if (!inView || tilesOnly || board.revision <= board.seenRevision) return;
    void rpc
      .call("board.markSeen", { board: { sectionId: section.id }, revision: board.revision })
      .catch((reason) =>
        setLoadError(
          reason instanceof Error ? reason.message : "The section could not be marked as read.",
        ),
      );
  }, [rpc, section.id, board.revision, board.seenRevision, inView, tilesOnly]);

  const layer = useBoardLayer({ board, origin: { x: section.x, y: section.y } });

  useEffect(
    () => onGeometry(section.id, layer),
    [section.id, layer.layout, layer.ordered, layer.measured, layer.realization, onGeometry],
  );

  function drag(event: React.PointerEvent<HTMLElement>, id: string, rect: Rect, island: boolean) {
    if (event.button !== 0) return;
    event.stopPropagation();
    const start = { x: event.clientX, y: event.clientY };
    const target = event.currentTarget;
    target.setPointerCapture(event.pointerId);

    const finish = (next: PointerEvent) => {
      target.removeEventListener("pointerup", finish);

      if (next.pointerId !== event.pointerId) return;
      const x = Math.round(rect.x + (next.clientX - start.x) / zoom);
      const y = Math.round(rect.y + (next.clientY - start.y) / zoom);

      if (Math.hypot(next.clientX - start.x, next.clientY - start.y) < 4) return;

      if (island) onMoveIsland?.(section.id, id, { x, y });
      else onMoveNode?.(section.id, id, { x: x - section.x, y: y - section.y });
    };

    target.addEventListener("pointerup", finish);
  }

  if (zoom <= 0.12 && !showContentAtAnyZoom) return null;

  return (
    <>
      {loadError ? (
        <div
          className="cnv-project-section-error"
          role="alert"
          style={{ left: section.x, top: section.y }}
        >
          {loadError}
        </div>
      ) : null}
      <BoardLayer
        board={board}
        baseline={board.seenRevision}
        workspace={sectionWorkspace}
        actions={{
          choose: async () => {
            throw new Error("Open a canvas chat to choose an option.");
          },
        }}
        selected={selected}
        layer={layer}
        zoom={zoom}
        showContentAtAnyZoom={showContentAtAnyZoom}
        sources={sources.length > 0 ? sources : sectionSources}
        eager
        sourcesLoaded={loaded}
        onSelectIsland={(id) => {
          if (id !== null) onSelectIsland(section.id, id);
        }}
        onSelect={(id) => {
          const node = board.nodes.find((entry) => entry.id === id);

          if (node) onSelect(section.id, node);
        }}
        onNodePointerDown={(event, id) => {
          const rect = layer.layout.nodes.get(id);

          if (rect && onMoveNode) drag(event, id, rect, false);
        }}
        onIslandPointerDown={(event, frame) => {
          if (onMoveIsland)
            drag(
              event,
              frame.id,
              { ...frame.rect, ...(frame.island.offset ?? { x: 0, y: 0 }) },
              true,
            );
        }}
      />
    </>
  );
});
