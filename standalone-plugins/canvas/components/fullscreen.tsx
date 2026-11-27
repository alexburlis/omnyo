import { useEffect, useRef } from "react";
import { BoardView } from "./panel";
import { closeFullScreen, useFullScreenBoard } from "./fullscreen-state";
import { useIsCompactViewport } from "../ui/components/ui/hooks/use-compact-viewport";

const keepsEscape =
  ".cnv-workbench, input, textarea, select, [contenteditable]:not([contenteditable='false'])";

export function CanvasFullScreen() {
  const board = useFullScreenBoard();
  const compact = useIsCompactViewport();
  const dialog = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (board === null) return;

    if (!compact) {
      closeFullScreen();

      return;
    }

    dialog.current?.focus({ preventScroll: true });

    function key(event: KeyboardEvent) {
      if (event.key !== "Escape" || event.defaultPrevented) return;

      if (event.target instanceof Element && event.target.closest(keepsEscape)) return;
      closeFullScreen();
    }

    window.addEventListener("keydown", key);

    return () => {
      window.removeEventListener("keydown", key);

      const opener = board.opener?.isConnected
        ? board.opener
        : document.querySelector<HTMLElement>(".cnv-header-button");

      opener?.focus({ preventScroll: true });
    };
  }, [board, compact]);

  if (board === null || !compact) return null;

  return (
    <div
      ref={dialog}
      className="cnv-fullscreen"
      role="dialog"
      aria-modal="true"
      aria-label="Canvas"
      tabIndex={-1}
    >
      <BoardView
        key={board.threadId}
        threadId={board.threadId}
        composer={board.composer}
        compact={false}
        fullScreen
      />
    </div>
  );
}
