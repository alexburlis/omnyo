import type { CanvasNode, FlowLeaf } from "../contract";
import type { SourceState } from "../source-contract";

export function boundSourceIds(node: CanvasNode): string[] {
  return [
    ...(node.binding ? [node.binding.sourceId, ...(node.binding.sources ?? [])] : []),
    ...(node.evidence?.sourceIds ?? []),
  ];
}

export function boundSourceSignature(nodes: readonly CanvasNode[]): string {
  return [...new Set(nodes.flatMap(boundSourceIds))].sort().join("|");
}

export function measureKey(
  node: CanvasNode,
  width: number,
  emphasis: FlowLeaf["emphasis"],
  island: string | undefined,
  sources: readonly SourceState[] | null,
): string | null {
  const bound = boundSourceIds(node);

  if (bound.length > 0 && sources === null) return null;

  const revisions = bound.map(
    (id) =>
      sources?.find((entry) => entry.source.definition.id === id)?.dataset?.revision ?? "none",
  );

  return [node.updatedRevision, Math.round(width), emphasis ?? "", island ?? "", ...revisions].join(
    ":",
  );
}

export function frameCount(node: CanvasNode, threadId: string | undefined): number {
  if (node.conversation && threadId) return 0;

  const views =
    (node.views?.overview === undefined ? 0 : 1) + (node.views?.sources === undefined ? 0 : 1);

  if (node.binding) return (node.binding.view === "html" ? 1 : 0) + views;

  return node.kind === "html" ? 1 + views : 0;
}
