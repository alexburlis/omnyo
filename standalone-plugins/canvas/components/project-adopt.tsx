import { useState } from "react";
import { experimental_Icon as Icon, useRpc } from "@omnyo/plugin-sdk/app";
import type { CanvasRpcContract } from "../contract";
import { useProjectHistory } from "./project-history";

export function AddBoardToProject({
  threadId,
  onLinked,
}: {
  threadId: string;
  onLinked(link: { projectId: string; sectionId: string; title: string }): void;
}) {
  const rpc = useRpc<CanvasRpcContract>();
  const remember = useProjectHistory();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function add() {
    if (busy) return;
    setError(null);
    setBusy(true);

    try {
      const { projectId } = await rpc.call("project.boardProject", { threadId });

      const [project, boards] = await Promise.all([
        rpc.call("project.get", { projectId }),
        rpc.call("project.boards", { projectId }),
      ]);

      const title = boards.find((entry) => entry.threadId === threadId)?.title ?? "Chat board";

      const value = await rpc.call("project.adopt", {
        projectId,
        threadId,
        title,
        actor: "human",
        expectedRevision: project.revision,
      });

      await remember(value);
      const section = value.sections.find((entry) => entry.originThreadId === threadId);

      if (section) onLinked({ projectId, sectionId: section.id, title: section.title });
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "The board could not be added.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <button
        type="button"
        className="cnv-tool cnv-add-to-project"
        data-labelled
        aria-label={busy ? "Adding board to the project canvas" : "Add to project canvas"}
        aria-disabled={busy}
        aria-busy={busy}
        title="Move this board into the project canvas"
        onClick={() => void add()}
      >
        {busy ? (
          <Icon name="Loading" className="cnv-project-spin" aria-hidden />
        ) : (
          <Icon name="MoveTo" aria-hidden />
        )}
        <span className="cnv-tool-label">{busy ? "Adding…" : "Add to project"}</span>
      </button>
      {error ? (
        <span className="cnv-toolbar-error" role="alert">
          {error}
        </span>
      ) : null}
    </>
  );
}
