import { useState } from "react";
import type { Board } from "../contract";
import type { SourceState } from "../source-contract";
import { fitViewport, nodeChange, type Rect, type Viewport } from "../lib/layout";
import { BoardLayer, useBoardLayer } from "./board-layer";
import type { NodeActions, NodeWorkspace } from "./node";
import { WorldSurface, type BoardCommands, type DragPosition } from "./world";

export type { BoardCommands } from "./world";

export interface BoardCanvasProps {
  board: Board;
  baseline: number;
  workspace: NodeWorkspace;
  actions: NodeActions;
  selected: string | null;
  selectedIsland?: string | null;
  sources?: readonly SourceState[];
  sourcesLoaded?: boolean;
  onWidthChange?(id: string, width: number, trackUnit?: number): void;
  onSelect(id: string | null): void;
  onSelectIsland?(id: string | null): void;
  onMove(id: string, position: { x: number; y: number }): void;
  onIslandMove?(id: string, offset: { x: number; y: number }): void;
  onCommands(commands: BoardCommands): void;
  onCreatePrompt?(position: { x: number; y: number }): void;
  topInset?: number;
}

function initialBoardViewport(bounds: Rect, width: number, height: number): Viewport {
  const initial = fitViewport(bounds, width, height);

  return initial.zoom < 0.6 ? { x: 40 - bounds.x * 0.75, y: 40, zoom: 0.75 } : initial;
}

export function BoardCanvas({
  board,
  baseline,
  workspace,
  actions,
  selected,
  selectedIsland = null,
  sources = [],
  sourcesLoaded = false,
  onWidthChange,
  onSelect,
  onSelectIsland,
  onMove,
  onIslandMove,
  onCommands,
  onCreatePrompt,
  topInset,
}: BoardCanvasProps) {
  const [dragging, setDragging] = useState<DragPosition>(null);
  const [islandDrag, setIslandDrag] = useState<DragPosition>(null);
  const layer = useBoardLayer({ board, dragging, islandDrag });

  return (
    <WorldSurface
      layout={layer.layout}
      nodes={board.nodes.map((node) => ({
        id: node.id,
        updatedRevision: node.updatedRevision,
        change: nodeChange(node, baseline),
      }))}
      initialFit={initialBoardViewport}
      empty={
        board.nodes.length === 0 ? (
          <div className="cnv-empty">The agent will build the board here.</div>
        ) : null
      }
      showMinimap={board.nodes.length > 0}
      selectedIsland={selectedIsland}
      dragging={dragging}
      islandDrag={islandDrag}
      onNodeDrag={setDragging}
      onIslandDrag={setIslandDrag}
      onSelect={onSelect}
      onSelectIsland={onSelectIsland}
      onMove={onMove}
      onIslandMove={onIslandMove}
      onCommands={onCommands}
      onCreatePrompt={onCreatePrompt}
      topInset={topInset}
      render={(viewport, gestures) => (
        <BoardLayer
          board={board}
          baseline={baseline}
          workspace={workspace}
          actions={actions}
          selected={selected}
          selectedIsland={selectedIsland}
          sources={sources}
          sourcesLoaded={sourcesLoaded}
          onWidthChange={onWidthChange}
          onSelect={onSelect}
          onSelectIsland={onSelectIsland}
          layer={layer}
          zoom={viewport.zoom}
          onNodePointerDown={gestures.onNodePointerDown}
          onIslandPointerDown={gestures.onIslandPointerDown}
        />
      )}
    />
  );
}
