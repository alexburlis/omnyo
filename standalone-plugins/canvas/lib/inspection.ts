import type { CanvasNode } from "../contract";
import type { RenderReport, RenderVerification } from "../workspace-contract";

export class RenderRegistry {
  private readonly boards = new Map<string, Map<string, RenderReport>>();

  report(threadId: string, reports: readonly RenderReport[], nodes: readonly CanvasNode[]): number {
    const current = new Map(nodes.map((node) => [node.id, node]));
    const entries = this.boards.get(threadId) ?? new Map<string, RenderReport>();
    let accepted = 0;

    for (const report of reports) {
      const node = current.get(report.nodeId);

      if (
        !node ||
        node.updatedRevision !== report.nodeRevision ||
        report.capturedAt > Date.now() + 5000
      )
        continue;
      const previous = entries.get(node.id);

      if (previous && previous.capturedAt > report.capturedAt) continue;
      entries.set(node.id, report);
      accepted += 1;
    }

    for (const id of entries.keys()) if (!current.has(id)) entries.delete(id);
    this.boards.delete(threadId);
    this.boards.set(threadId, entries);

    if (this.boards.size > 100) {
      const oldest = this.boards.keys().next().value;

      if (oldest !== undefined) this.boards.delete(oldest);
    }

    return accepted;
  }

  verify(
    threadId: string,
    node: CanvasNode,
    boardRevision: number,
    sourceRevision: number | null,
  ): RenderVerification {
    const report = this.boards.get(threadId)?.get(node.id) ?? null;

    const current =
      report !== null &&
      report.nodeRevision === node.updatedRevision &&
      report.boardRevision === boardRevision &&
      report.sourceRevision === sourceRevision &&
      Date.now() - report.capturedAt < 120000;

    const issues =
      current && report
        ? [...report.issues]
        : [
            report
              ? "The connected render is stale. Open Canvas to verify the current board and source data."
              : "No connected render has reported this node. Open Canvas to verify it.",
          ];

    if (current && !report?.ready)
      issues.push("The node is still waiting for its rendered content.");

    return { report, current, issues };
  }
}
