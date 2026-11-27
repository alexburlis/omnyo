import { useEffect, useId, useRef, useState } from "react";
import {
  experimental_Icon as Icon,
  experimental_usePluginId,
  experimental_useAppNavigate,
  useComposer,
  useRpc,
  type ComposerPlusMenuItem,
  type PluginComposerApi,
} from "@omnyo/plugin-sdk/app";
import { type CanvasRpcContract } from "../contract";
import { useIsCompactViewport } from "../ui/components/ui/hooks/use-compact-viewport";
import { useCanvasState, type CanvasState } from "./thread-data";
import { addModeMention, hasModeMention, removeModeMention } from "./mode-mention";
import { panelAction } from "./thread-panel-action";

const captions: Record<CanvasState, string> = {
  loading: "Loading…",
  failed: "Canvas could not load. Click to try again.",
  off: "The agent turns it on when a board helps",
  pending: "Starts with your next message",
  on: "On. Turning it off keeps the board.",
};

function Switch({
  state,
  error,
  onClick,
}: {
  state: CanvasState;
  error: string | null;
  onClick(): void;
}) {
  const caption = useId();
  const button = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    button.current?.focus();
  }, []);

  return (
    <div className="cnv-mode-menu">
      <button
        ref={button}
        type="button"
        role="switch"
        className="cnv-switch"
        aria-label="Canvas"
        aria-describedby={caption}
        aria-checked={state === "on" || state === "pending"}
        data-state={error === null ? state : "error"}
        disabled={state === "loading"}
        onClick={onClick}
      >
        <Icon name="GridView" className="cnv-toggle-icon" aria-hidden />
        <span className="cnv-switch-text">
          <span className="cnv-switch-label">Canvas</span>
          <span id={caption} className="cnv-switch-caption">
            {error ?? captions[state]}
          </span>
        </span>
        <span className="cnv-switch-track" aria-hidden="true">
          <span className="cnv-switch-thumb" />
        </span>
      </button>
    </div>
  );
}

function NewChatSwitch({ composer }: { composer: PluginComposerApi }) {
  const pluginId = experimental_usePluginId();
  const on = hasModeMention(composer.draft.mentions, pluginId);

  function toggle() {
    if (on) removeModeMention(composer, pluginId);
    else addModeMention(composer, pluginId);
    composer.experimental_closePopup();
  }

  return <Switch state={on ? "pending" : "off"} error={null} onClick={toggle} />;
}

function ChatSwitch({ composer, threadId }: { composer: PluginComposerApi; threadId: string }) {
  const pluginId = experimental_usePluginId();
  const rpc = useRpc<CanvasRpcContract>();
  const navigate = experimental_useAppNavigate();
  const compact = useIsCompactViewport();
  const { state, refresh, accept } = useCanvasState(threadId, composer);
  const [error, setError] = useState<string | null>(null);

  function toggle() {
    setError(null);

    if (state === "failed") {
      refresh();

      return;
    }

    if (state === "off") {
      addModeMention(composer, pluginId);
      composer.experimental_closePopup();

      if (!compact) navigate.openThreadPanel(panelAction);

      return;
    }

    if (state === "pending") {
      removeModeMention(composer, pluginId);
      composer.experimental_closePopup();

      return;
    }

    if (state !== "on") return;

    accept({ canvas: false, unseen: false, startedBy: null, movedTo: null });
    removeModeMention(composer, pluginId);
    rpc.call("mode.off", { threadId }).then(
      (mode) => {
        accept(mode);
        composer.experimental_closePopup();
      },
      () => {
        setError("Canvas could not turn off. Try again.");
        refresh();
      },
    );
  }

  return <Switch state={state} error={error} onClick={toggle} />;
}

export function CanvasModeMenu() {
  const composer = useComposer();
  const scope = composer.scope;

  if (scope.kind === "new-thread") return <NewChatSwitch composer={composer} />;

  if (scope.kind === "thread") return <ChatSwitch composer={composer} threadId={scope.threadId} />;

  return null;
}

export const modePopup = { id: "mode", label: "Canvas", component: CanvasModeMenu } as const;

export const modeMenuItem: ComposerPlusMenuItem = {
  id: "mode",
  label: "Canvas",
  icon: "GridView",
  description: "Turn Canvas on or off for this chat",
  run({ composer }) {
    if (!composer.experimental_openPopup(modePopup.id))
      throw new Error("Canvas could not open in this composer.");
  },
};
