import { useEffect, useState } from "react";
import { useRpc } from "@omnyo/plugin-sdk/app";
import type { CanvasRpcContract } from "../contract";
import type { ProjectCanvas } from "../project-contract";
import { ProjectDrawer } from "./project-drawer";
import { useProjectHistory } from "./project-history";

export function ReturnBoard({
  projectId,
  sectionId,
  onClose,
  onReturned,
}: {
  projectId: string;
  sectionId: string;
  onClose(): void;
  onReturned(): void;
}) {
  const rpc = useRpc<CanvasRpcContract>();
  const remember = useProjectHistory();
  const [project, setProject] = useState<ProjectCanvas | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let live = true;
    void rpc.call("project.get", { projectId }).then(
      (value) => {
        if (live) setProject(value);
      },
      (reason) => {
        if (live)
          setError(reason instanceof Error ? reason.message : "The section could not load.");
      },
    );

    return () => {
      live = false;
    };
  }, [rpc, projectId, attempt]);
  const section = project?.sections.find((item) => item.id === sectionId);

  const views =
    project?.views.filter(
      (view) =>
        view.regionId === sectionId &&
        !(
          view.anchorKind === "chat" &&
          project.chats.some(
            (chat) =>
              chat.threadId === view.anchorId &&
              chat.regionId === sectionId &&
              chat.threadId !== section?.originThreadId,
          )
        ),
    ) ?? [];

  return (
    <ProjectDrawer
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      label="Move board back to chat"
      className="cnv-project-form"
    >
      <strong>
        Move {section ? `“${section.title}”` : "this board"} back to its original chat?
      </strong>
      {error ? <p role="alert">{error}</p> : null}
      {!project ? (
        error ? (
          <button
            type="button"
            className="cnv-project-quiet-button"
            onClick={() => {
              setError(null);
              setAttempt((value) => value + 1);
            }}
          >
            Try again
          </button>
        ) : (
          <p aria-busy>Loading saved views…</p>
        )
      ) : (
        <>
          <p>The board and its history will move back.</p>
          {views.length ? (
            <>
              <p>These saved views will be removed:</p>
              <ul>
                {views.map((view) => (
                  <li key={view.id}>{view.title}</li>
                ))}
              </ul>
            </>
          ) : (
            <p>No saved views are anchored to this section.</p>
          )}
        </>
      )}
      <div className="cnv-project-form-actions">
        <button type="button" className="cnv-project-quiet-button" onClick={onClose}>
          Cancel
        </button>
        <button
          type="button"
          className="cnv-project-primary-button"
          disabled={!section || saving}
          onClick={() => {
            if (!project) return;
            setSaving(true);
            void rpc
              .call("project.return", { projectId, sectionId, expectedRevision: project.revision })
              .then(async (result) => {
                await remember(result);
                onReturned();
              })
              .catch((reason) => {
                setError(
                  reason instanceof Error ? reason.message : "The board could not be returned.",
                );
                setSaving(false);
              });
          }}
        >
          {saving ? "Moving…" : "Move back to chat"}
        </button>
      </div>
    </ProjectDrawer>
  );
}
