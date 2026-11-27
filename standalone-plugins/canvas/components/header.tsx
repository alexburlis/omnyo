import { useEffect } from "react";
import {
  experimental_Icon as Icon,
  experimental_useAppNavigate,
  useComposers,
  type PluginThreadHeaderActionProps,
} from "@omnyo/plugin-sdk/app";
import { panelAction } from "./thread-panel-action";
import { useCanvasState } from "./thread-data";

export function CanvasHeaderButton({ threadId, isCompactViewport }: PluginThreadHeaderActionProps) {
  const { openThreadPanel } = experimental_useAppNavigate();

  const composer =
    useComposers().find(
      (entry) => entry.scope.kind === "thread" && entry.scope.threadId === threadId,
    ) ?? null;

  const { state, unseen } = useCanvasState(threadId, composer);

  useEffect(() => {
    if (state !== "on" || isCompactViewport) return;

    openThreadPanel(panelAction);
  }, [isCompactViewport, openThreadPanel, state, threadId]);

  if (state !== "on" && state !== "pending") return null;

  function open() {
    openThreadPanel(panelAction);
  }

  return (
    <button
      type="button"
      className="cnv-header-button"
      aria-label={unseen ? "Open Canvas, the board has changes" : "Open Canvas"}
      title="Open the board beside this chat"
      onClick={open}
    >
      <Icon name="GridView" className="cnv-toggle-icon" aria-hidden />
      {isCompactViewport ? null : <span>Canvas</span>}
      {unseen ? <span className="cnv-dot" aria-hidden="true" /> : null}
    </button>
  );
}
