import { useCallback, useRef } from "react";
import { experimental_useActionHistory, useRpc } from "@omnyo/plugin-sdk/app";
import type { CanvasRpcContract } from "../contract";
import type { ProjectCanvas } from "../project-contract";

export function useProjectHistory(onChanged?: (project: ProjectCanvas) => void) {
  const rpc = useRpc<CanvasRpcContract>();
  const { record } = experimental_useActionHistory();
  const changed = useRef(onChanged);
  changed.current = onChanged;

  return useCallback(
    async (result: ProjectCanvas | readonly ProjectCanvas[]) => {
      const results = "projectId" in result ? [result] : result;

      for (const saved of results) changed.current?.(saved);
      const projects = [...new Set(results.map((saved) => saved.projectId))];

      const journals = new Map(
        await Promise.all(
          projects.map(async (projectId) => {
            const entries = await rpc
              .call("project.journal", {
                projectId,
                revisions: results
                  .filter((saved) => saved.projectId === projectId)
                  .map((saved) => saved.revision),
              })
              .catch(() => {
                throw new Error("Change saved, but Undo could not be prepared.");
              });

            return [projectId, entries] as const;
          }),
        ),
      );

      const entries = results.flatMap((saved) => {
        const entry = journals
          .get(saved.projectId)
          ?.find((item) => item.state === "applied" && item.revision === saved.revision);

        return entry ? [{ projectId: saved.projectId, entry }] : [];
      });

      const first = entries[0];

      if (!first) return;

      const replay = async (ordered: typeof entries, method: "project.undo" | "project.redo") => {
        for (const saved of ordered) {
          const current = await rpc.call("project.get", { projectId: saved.projectId });

          const next = await rpc.call(method, {
            projectId: saved.projectId,
            changeId: saved.entry.id,
            actor: "human",
            expectedRevision: current.revision,
          });

          changed.current?.(next);
        }
      };

      record({
        label: entries.length === 1 ? first.entry.label : "Reorder canvas contents",
        undo: () => replay([...entries].reverse(), "project.undo"),
        redo: () => replay(entries, "project.redo"),
      });
    },
    [rpc, record],
  );
}
