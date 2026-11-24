import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { MOTION_DURATION_MS } from "@/components/ui/motion";
import { usePortalScopeProps } from "@/lib/portal-scope";
import { cn } from "@/lib/utils";

export interface ContextMenuItem {
  label: string;
  onSelect: () => void;
}

export interface ContextMenuState {
  x: number;
  y: number;
  items: ContextMenuItem[];
}

const VIEWPORT_MARGIN_PX = 8;

const MENU_CLASS =
  "fixed z-50 w-auto rounded-md border bg-popover p-0.5 text-popover-foreground shadow-md outline-none data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95 data-[state=closed]:fill-mode-forwards";

const ITEM_CLASS =
  "flex w-full cursor-pointer items-center gap-1 rounded px-1.5 py-0.5 text-left text-xs text-foreground transition-colors select-none hover:bg-surface-recessed focus-visible:ring-1 focus-visible:ring-ring focus-visible:outline-none max-md:pointer-coarse:min-h-7 max-md:pointer-coarse:px-2 max-md:pointer-coarse:py-1";

export function ContextMenu({
  state,
  onClose,
}: {
  state: ContextMenuState | null;
  onClose: () => void;
}) {
  const menuRef = useRef<HTMLDivElement | null>(null);
  const [position, setPosition] = useState({ x: 0, y: 0 });
  const [rendered, setRendered] = useState(state);
  const portalScopeProps = usePortalScopeProps();

  if (state !== null && state !== rendered) setRendered(state);

  const closing = state === null && rendered !== null;

  useEffect(() => {
    if (!closing) return;

    const timer = window.setTimeout(
      () => setRendered(null),
      MOTION_DURATION_MS.fast,
    );

    return () => window.clearTimeout(timer);
  }, [closing]);

  useLayoutEffect(() => {
    if (state === null) return;
    const menu = menuRef.current;
    const width = menu?.offsetWidth ?? 0;
    const height = menu?.offsetHeight ?? 0;
    setPosition({
      x: Math.max(
        VIEWPORT_MARGIN_PX,
        Math.min(state.x, window.innerWidth - width - VIEWPORT_MARGIN_PX),
      ),
      y: Math.max(
        VIEWPORT_MARGIN_PX,
        Math.min(state.y, window.innerHeight - height - VIEWPORT_MARGIN_PX),
      ),
    });
  }, [state]);

  useEffect(() => {
    if (state === null) return;
    menuRef.current?.querySelector("button")?.focus();

    const onPointerDown = (event: PointerEvent) => {
      if (!menuRef.current?.contains(event.target as Node)) onClose();
    };

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        onClose();

        return;
      }

      if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
      event.preventDefault();
      const menu = menuRef.current;

      if (menu === null) return;
      const buttons = Array.from(menu.querySelectorAll("button"));

      if (buttons.length === 0) return;

      const index = buttons.indexOf(
        document.activeElement as HTMLButtonElement,
      );

      const delta = event.key === "ArrowDown" ? 1 : -1;
      const next = (index + delta + buttons.length) % buttons.length;
      buttons[next]?.focus();
    };

    window.addEventListener("pointerdown", onPointerDown, true);
    window.addEventListener("keydown", onKeyDown, true);
    window.addEventListener("scroll", onClose, true);
    window.addEventListener("resize", onClose);

    return () => {
      window.removeEventListener("pointerdown", onPointerDown, true);
      window.removeEventListener("keydown", onKeyDown, true);
      window.removeEventListener("scroll", onClose, true);
      window.removeEventListener("resize", onClose);
    };
  }, [state, onClose]);

  if (rendered === null) return null;

  return createPortal(
    <div
      ref={menuRef}
      {...portalScopeProps}
      role="menu"
      data-state={closing ? "closed" : "open"}
      inert={closing}
      style={{
        left: position.x,
        top: position.y,
        transformOrigin: `${rendered.x - position.x}px ${rendered.y - position.y}px`,
      }}
      className={MENU_CLASS}
    >
      {rendered.items.map((item) => (
        <button
          key={item.label}
          type="button"
          role="menuitem"
          onClick={() => {
            item.onSelect();
            onClose();
          }}
          className={cn(ITEM_CLASS, "whitespace-nowrap")}
        >
          {item.label}
        </button>
      ))}
    </div>,
    document.body,
  );
}
