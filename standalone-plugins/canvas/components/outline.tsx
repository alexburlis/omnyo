import type { Board, CanvasNode, IslandGroup } from "../contract";
import type { SourceState } from "../source-contract";
import { nodeChange, nodeEmphases, readingGroups } from "../lib/layout";
import { NodeCard, type NodeActions, type NodeWorkspace } from "./node";

interface OutlineProps {
  board: Board;
  baseline: number;
  workspace: NodeWorkspace;
  actions: NodeActions;
  selected: string | null;
  sources?: readonly SourceState[];
  onSelect(id: string | null): void;
}

export function Outline({
  board,
  baseline,
  workspace,
  actions,
  selected,
  sources = [],
  onSelect,
}: OutlineProps) {
  if (board.nodes.length === 0)
    return (
      <div className="cnv-outline">
        <p className="cnv-muted">The agent will build the board here.</p>
      </div>
    );

  if (board.composition != null) {
    const emphases = nodeEmphases(board);

    const card = (node: CanvasNode, island?: IslandGroup) => (
      <NodeCard
        key={node.id}
        node={node}
        threadId={board.threadId}
        compact
        sources={sources}
        accent={island?.island.accent}
        island={island?.id}
        emphasis={emphases.get(node.id)}
        change={nodeChange(node, baseline)}
        selected={selected === node.id}
        workspace={workspace}
        actions={actions}
        onSelect={onSelect}
      />
    );

    return (
      <div className="cnv-outline" data-composed="true">
        {readingGroups(board).map((group, index) =>
          group.island === undefined ? (
            group.nodes.map((node) => card(node))
          ) : (
            <section
              key={group.island.id}
              className="cnv-outline-island"
              data-accent={group.island.island.accent ?? "neutral"}
              data-surface={group.island.island.surface ?? "soft"}
              aria-label={group.island.island.title}
              data-index={index}
            >
              <header className="cnv-outline-island-head">
                <span className="cnv-island-pip" aria-hidden="true" />
                <div>
                  <h3>{group.island.island.title}</h3>
                  {group.island.island.question === undefined ? null : (
                    <p>{group.island.island.question}</p>
                  )}
                </div>
              </header>
              {group.nodes.map((node) => card(node, group.island))}
            </section>
          ),
        )}
      </div>
    );
  }

  return (
    <div className="cnv-outline">
      {board.sections.map((section) => {
        const nodes = board.nodes.filter((node) => node.section === section);

        return (
          <section key={section} aria-label={section}>
            <h3 className="cnv-outline-section">
              <span>{section}</span>
              <span>{nodes.length}</span>
            </h3>
            {nodes.map((node) => (
              <NodeCard
                key={node.id}
                node={node}
                threadId={board.threadId}
                compact
                sources={sources}
                change={nodeChange(node, baseline)}
                selected={selected === node.id}
                workspace={workspace}
                actions={actions}
                onSelect={onSelect}
              />
            ))}
          </section>
        );
      })}
    </div>
  );
}
