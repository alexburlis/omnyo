import { useCallback, useRef, type RefObject } from "react";
import { useRpc } from "@omnyo/plugin-sdk/app";
import type { Board, CanvasRpcContract } from "../contract";
import type { RenderReport } from "../workspace-contract";
import { readRenderReports } from "./render-report";
import { useRenderReporting } from "./render-reporting";

export function useProjectRenderReport({
  root,
  boards,
  outlineVisible,
  selectedSection,
  enabled,
  onError,
}: {
  root: RefObject<HTMLDivElement | null>;
  boards: ReadonlyMap<string, Board>;
  outlineVisible: boolean;
  selectedSection: string | null;
  enabled: boolean;
  onError(): void;
}) {
  const rpc = useRpc<CanvasRpcContract>();
  const previousRenders = useRef(new Map<string, Map<string, RenderReport>>());

  const report = useCallback(
    async (nodeId?: string) => {
      const element = root.current;

      if (!element?.isConnected) {
        if (nodeId !== undefined) throw new Error("Open a section to verify its modules.");

        return;
      }

      const surface = element.querySelector<HTMLElement>(
        outlineVisible
          ? ".cnv-project-outline[data-project-section-id]"
          : ".cnv-project-world:not([hidden])",
      );

      const active = new Map<string, RenderReport[]>();

      if (surface) {
        const ids = outlineVisible
          ? [surface.dataset.projectSectionId]
          : Array.from(surface.querySelectorAll<HTMLElement>("[data-project-section-id]")).map(
              (section) => section.dataset.projectSectionId,
            );

        for (const id of new Set(ids)) {
          const board = id === undefined ? undefined : boards.get(id);

          if (id !== undefined && board)
            active.set(id, readRenderReports(surface, board, outlineVisible, id));
        }
      }

      if (
        nodeId !== undefined &&
        !active.get(selectedSection ?? "")?.some((entry) => entry.nodeId === nodeId)
      )
        throw new Error("The selected module is not rendered. Open Canvas and try Verify again.");

      const submissions: Array<() => Promise<void>> = [];

      for (const id of new Set([...active.keys(), ...previousRenders.current.keys()])) {
        const board = boards.get(id);

        if (!board) continue;
        const reports = active.get(id) ?? [];
        const present = new Set(reports.map((entry) => entry.nodeId));
        const previous = previousRenders.current.get(id) ?? new Map<string, RenderReport>();

        for (const [missing, old] of previous) {
          const node = board.nodes.find((entry) => entry.id === missing);

          if (!present.has(missing) && node)
            reports.push({
              ...old,
              nodeRevision: node.updatedRevision,
              boardRevision: board.revision,
              capturedAt: Date.now(),
              ready: false,
              text: "",
              issues: ["The module is not rendered in the active Canvas view."],
            });
        }

        const rendered = new Map(
          reports.filter((entry) => entry.ready).map((entry) => [entry.nodeId, entry]),
        );

        const next = new Map([...previous, ...rendered]);

        if (reports.length === 0) {
          previousRenders.current.delete(id);
          continue;
        }

        previousRenders.current.set(id, next);

        submissions.push(async () => {
          await rpc.call("render.report", { board: { sectionId: id }, reports });

          if (previousRenders.current.get(id) !== next) return;

          if (rendered.size === 0) previousRenders.current.delete(id);
          else previousRenders.current.set(id, rendered);
        });
      }

      const failures: unknown[] = [];

      for (let index = 0; index < submissions.length; index += 4) {
        const results = await Promise.allSettled(
          submissions.slice(index, index + 4).map((submit) => submit()),
        );

        for (const result of results)
          if (result.status === "rejected") failures.push(result.reason);
      }

      if (failures.length > 0) throw new AggregateError(failures, "Render reporting failed.");
    },
    [boards, outlineVisible, selectedSection, rpc],
  );

  useRenderReporting({ root, report, enabled, onError });

  return report;
}
