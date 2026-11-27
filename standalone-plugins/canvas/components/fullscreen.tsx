import { useEffect, useRef, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { experimental_usePluginId } from "@omnyo/plugin-sdk/app";
import { closeFullScreen } from "./fullscreen-state";

const keepsEscape =
  ".cnv-workbench, input, textarea, select, [contenteditable]:not([contenteditable='false'])";

export function CanvasFullScreen({
  opener,
  children,
}: {
  opener: HTMLElement | null;
  children: ReactNode;
}) {
  const pluginId = experimental_usePluginId();
  const dialog = useRef<HTMLDivElement>(null);

  useEffect(() => {
    dialog.current?.focus({ preventScroll: true });

    function key(event: KeyboardEvent) {
      if (event.key !== "Escape" || event.defaultPrevented) return;

      if (event.target instanceof Element && event.target.closest(keepsEscape)) return;
      closeFullScreen();
    }

    window.addEventListener("keydown", key);

    return () => {
      window.removeEventListener("keydown", key);

      const target = opener?.isConnected
        ? opener
        : document.querySelector<HTMLElement>(".cnv-header-button");

      target?.focus({ preventScroll: true });
    };
  }, [opener]);

  return createPortal(
    <div
      ref={dialog}
      data-omnyo-plugin-root=""
      data-omnyo-plugin={pluginId}
      className="cnv-fullscreen"
      role="dialog"
      aria-modal="true"
      aria-label="Canvas"
      tabIndex={-1}
    >
      {children}
    </div>,
    document.body,
  );
}
