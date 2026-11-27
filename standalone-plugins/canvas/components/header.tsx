import { useEffect } from "react";
import {
  experimental_Icon as Icon,
  experimental_useAppContext,
  experimental_useAppNavigate,
  useComposers,
  type PluginThreadAction,
  type PluginThreadActionRegistration,
  type PluginThreadHeaderActionProps,
} from "@omnyo/plugin-sdk/app";
import { useIsCompactViewport } from "../ui/components/ui/hooks/use-compact-viewport";
import { panelAction } from "./thread-panel-action";
import { useCanvasState } from "./thread-data";

function useChatCanvasState(threadId: string | null) {
  const composer =
    useComposers().find(
      (entry) => entry.scope.kind === "thread" && entry.scope.threadId === threadId,
    ) ?? null;

  return useCanvasState(threadId, composer);
}

function useCompactCanvasAction() {
  const { threadId } = experimental_useAppContext();
  const compact = useIsCompactViewport();
  const activeThreadId = compact ? threadId : null;
  const { state, unseen } = useChatCanvasState(activeThreadId);

  return { activeThreadId, state, unseen };
}

export const compactCanvasAction: PluginThreadActionRegistration<
  ReturnType<typeof useCompactCanvasAction>
> = {
  id: "open-chat-canvas",
  title: "Open Canvas",
  icon: "GridView",
  group: "1_open",
  order: 39,
  useData: useCompactCanvasAction,
  item: ({ thread, data, navigate }) => {
    if (thread.id !== data.activeThreadId || (data.state !== "on" && data.state !== "pending"))
      return null;

    const action: PluginThreadAction = {
      label: "Open Canvas",
      icon: "GridView",
      run: () => {
        navigate.openThreadPanel(panelAction);
      },
    };

    if (data.unseen) action.detail = "The board has changes";

    return action;
  },
};

export function CanvasHeaderButton({ threadId, isCompactViewport }: PluginThreadHeaderActionProps) {
  const { openThreadPanel } = experimental_useAppNavigate();
  const { state, unseen } = useChatCanvasState(threadId);

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
